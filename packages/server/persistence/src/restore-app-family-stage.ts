import { z } from 'zod';
import {
  appFamilyRowsSha256,
  stageVerifiedAppFamilyArtifact,
  type AppFamilyIdentity,
  type AppFamilyRow,
  type AppFamilyStagePort,
  type SqlFamilyInventory,
  type VerifiedAppFamilyArtifact,
} from './restore-app-family-artifact.js';

// Owner transaction only. Database.tenant takes lifecycle locks too early for
// this path. The caller owns BEGIN/COMMIT/ROLLBACK and authenticated tail replay.
export interface AppFamilyOwnerQueryPort {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
const uuid = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const mappedRow = z.strictObject({
  row_sha256: hash,
  tuple_sha256: hash,
  row_matches: z.literal(true),
  binding_matches: z.literal(true),
  bytes: z.number().int().positive().max(4198400),
});
const xid = z.strictObject({ xid: z.string().regex(/^[1-9][0-9]*$/) });
function rejected(): never {
  throw new Error('APP_FAMILY_STAGE_REJECTED');
}
function sameIdentity(actual: AppFamilyIdentity, expected: AppFamilyIdentity) {
  const pinned = z.record(z.string(), z.json()).parse(expected);
  if (Object.keys(pinned).length !== Object.keys(actual).length) rejected();
  for (const [name, value] of Object.entries(actual)) if (pinned[name] !== value) rejected();
}
async function assertOwnerTransaction(client: AppFamilyOwnerQueryPort) {
  await client.query('SELECT wm_app_load.owner_check()');
  // Two xid observations reject autocommit before any descriptor/live writes.
  // This deliberately assigns an xid to a caller's explicit transaction.
  const first = xid.parse((await client.query('SELECT txid_current()::text AS xid')).rows[0]);
  const second = xid.parse((await client.query('SELECT txid_current()::text AS xid')).rows[0]);
  if (first.xid !== second.xid) throw new Error('APP_FAMILY_OWNER_TRANSACTION_REQUIRED');
}
async function assertTarget(client: AppFamilyOwnerQueryPort, identity: AppFamilyIdentity) {
  // Global exclusive is acquired before target/lifecycle/tenant locks.
  const global = await client.query(
    `SELECT public.assert_restore_processing_closed($1::bigint,$2::uuid,$3::uuid) AS control,
       public.current_restore_generation()::text AS generation`,
    [identity.controlRevision, identity.targetNonce, identity.targetIncarnation],
  );
  const state = z
    .object({
      control: z.object({
        state: z.literal('CLOSED'),
        localRevision: z.literal(identity.controlRevision),
        generationId: uuid,
        targetNonce: z.literal(identity.targetNonce),
        targetIncarnation: z.literal(identity.targetIncarnation),
        admissionAllowed: z.literal(false),
      }),
      generation: uuid,
    })
    .parse(global.rows[0]);
  if (state.control.generationId !== state.generation) rejected();
  const target = await client.query(
    'SELECT nonce::text,schema_hash,state,state_version FROM wm_app_load.target WHERE singleton FOR UPDATE',
  );
  z.strictObject({
    nonce: z.literal(identity.targetNonce),
    schema_hash: z.literal(identity.schemaHash),
    state: z.literal('CLOSED'),
    state_version: z.literal(identity.expectedStateVersion),
  }).parse(target.rows[0]);
  const scope = await client.query(
    `SELECT nullif(current_setting('app.athlete_id',true),'') AS tenant,
      EXISTS(SELECT 1 FROM identity_private.account WHERE athlete_id=$1::uuid) AS account_exists,
      EXISTS(SELECT 1 FROM public.tenant_erasure WHERE athlete_id=$1::text) AS erased`,
    [identity.ownerId],
  );
  const owner = z
    .strictObject({
      tenant: z.string().nullable(),
      account_exists: z.literal(true),
      erased: z.literal(false),
    })
    .parse(scope.rows[0]);
  if (owner.tenant !== null && owner.tenant !== identity.ownerId) rejected();
  await client.query("SELECT set_config('app.athlete_id',$1,true)", [identity.ownerId]);
}
const mappingSql = `WITH normalized AS (
 SELECT wm_app_load.typed_row($1,$2::jsonb) AS typed,
 CASE WHEN $3::jsonb IS NULL THEN NULL
 WHEN $1='core_evidence_snapshot' THEN to_jsonb(jsonb_populate_record(NULL::public.evidence_app_admission_binding,$3::jsonb))
 WHEN $1='coaching_run' THEN to_jsonb(jsonb_populate_record(NULL::public.run_app_admission_binding,$3::jsonb))
 WHEN $1='coaching_candidate' THEN to_jsonb(jsonb_populate_record(NULL::public.candidate_app_admission_binding,$3::jsonb))
 WHEN $1='integrated_candidate_v4' THEN to_jsonb(jsonb_populate_record(NULL::public.integrated_candidate_app_admission_binding,$3::jsonb))
 ELSE NULL END AS binding)
 SELECT wm_app_load.hash_json(typed) AS row_sha256,
 wm_app_load.hash_json(jsonb_build_object('relation',$1::text,'row',typed,'binding',binding,'absence',$4::boolean,'witness',$5::jsonb)) AS tuple_sha256,
 typed IS NOT DISTINCT FROM $2::jsonb AS row_matches,
 binding IS NOT DISTINCT FROM $3::jsonb AS binding_matches,
 (octet_length(typed::text)+coalesce(octet_length(binding::text),0)+coalesce(octet_length(($5::jsonb)::text),0))::int AS bytes
 FROM normalized`;
async function computeInventory(
  client: AppFamilyOwnerQueryPort,
  identity: AppFamilyIdentity,
  rows: readonly AppFamilyRow[],
): Promise<SqlFamilyInventory> {
  await assertOwnerTransaction(client);
  await assertTarget(client, identity);
  const canonicalRowsSha256 = appFamilyRowsSha256(rows);
  if (canonicalRowsSha256 !== identity.rowsSha256 || rows.length !== identity.count) rejected();
  let totalBytes = 0;
  const mappings: SqlFamilyInventory['rows'] = [];
  for (const row of rows) {
    const result = await client.query(mappingSql, [
      row.relation,
      JSON.stringify(row.row),
      row.binding === null ? null : JSON.stringify(row.binding),
      row.absence,
      row.witness === null ? null : JSON.stringify(row.witness),
    ]);
    const mapped = mappedRow.parse(result.rows[0]);
    totalBytes += mapped.bytes;
    if (totalBytes > 16777216) rejected();
    mappings.push({
      ordinal: row.ordinal,
      rowSha256: mapped.row_sha256,
      tupleSha256: mapped.tuple_sha256,
    });
  }
  const inventory = await client.query('SELECT wm_app_load.hash_json($1::jsonb) AS sha256', [
    JSON.stringify(mappings.map((row) => ({ ordinal: row.ordinal, digest: row.tupleSha256 }))),
  ]);
  const sqlInventorySha256 = z.strictObject({ sha256: hash }).parse(inventory.rows[0]).sha256;
  return { canonicalRowsSha256, count: rows.length, sqlInventorySha256, rows: mappings };
}
/** Same caller transaction; no processing authority or commit is produced. */
export async function stageVerifiedAppFamilyArtifactIn(
  client: AppFamilyOwnerQueryPort,
  handle: VerifiedAppFamilyArtifact,
  expected: AppFamilyIdentity,
  runId: string,
): Promise<{ admissionAllowed: false }> {
  const run = uuid.parse(runId);
  let prepared: SqlFamilyInventory | undefined;
  const port: AppFamilyStagePort = {
    async computeSqlInventory({ identity, rows }) {
      sameIdentity(identity, expected);
      prepared = await computeInventory(client, identity, rows);
      return prepared;
    },
    async stageVerifiedFamily({ identity, rows, sqlInventory }) {
      sameIdentity(identity, expected);
      if (!prepared || JSON.stringify(sqlInventory) !== JSON.stringify(prepared)) rejected();
      await assertOwnerTransaction(client);
      await assertTarget(client, identity);
      await client.query(
        'SELECT wm_app_load.begin_stage($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::bigint,$11::uuid)',
        [
          run,
          identity.proofHash,
          identity.purpose,
          identity.targetNonce,
          identity.schemaHash,
          identity.expectedStateVersion,
          identity.ownerId,
          identity.count,
          sqlInventory.sqlInventorySha256,
          identity.controlRevision,
          identity.targetIncarnation,
        ],
      );
      for (const row of rows) {
        const mapped = sqlInventory.rows[row.ordinal - 1];
        if (!mapped || mapped.ordinal !== row.ordinal) rejected();
        await client.query(
          'SELECT wm_app_load.stage_family($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,$8::jsonb)',
          [
            run,
            row.ordinal,
            row.relation,
            JSON.stringify(row.row),
            mapped.rowSha256,
            row.binding === null ? null : JSON.stringify(row.binding),
            row.absence,
            row.witness === null ? null : JSON.stringify(row.witness),
          ],
        );
      }
      await client.query('SELECT wm_app_load.seal_family($1)', [run]);
      await client.query('SELECT wm_app_load.load_family($1)', [run]);
      await client.query('SELECT wm_app_load.finish_family($1)', [run]);
    },
  };
  await stageVerifiedAppFamilyArtifact(port, handle);
  return { admissionAllowed: false };
}
