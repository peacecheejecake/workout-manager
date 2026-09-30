import { createHmac } from 'node:crypto';

const KINDS = Object.freeze([
  'tenant_erased',
  'course_deleted',
  'activity_deleted',
  'resource_deleted',
  'gallery_media_deleted',
  'healthkit_consent_transition',
  'ai_consent_transition',
  'check_in_deleted',
  'resource_share_revoked',
  'course_share_revoked',
  'intake_entry_deleted',
  'recovery_action_deleted',
]);
const TABLES = Object.freeze([
  'identity_private.account',
  'public.restore_suppression_event',
  'public.tenant_erasure',
  'public.consent',
  'public.coaching_constraint_head',
  'public.coaching_constraint',
  'public.course_share_area_budget',
]);
const SNAPSHOT = /^[0-9]+:[0-9]+:(?:[0-9]+(?:,[0-9]+)*)?$/;
const LSN = /^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/i;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const SYSTEM_IDENTIFIER = /^[1-9][0-9]{0,19}$/;

function fail() {
  throw new Error('SNAPSHOT_COVERAGE_UNVERIFIED');
}
function rows(result) {
  if (!result || !Array.isArray(result.rows)) fail();
  return result.rows;
}
function one(result) {
  const found = rows(result);
  if (found.length !== 1) fail();
  return found[0];
}
function count(value) {
  if (!/^(0|[1-9][0-9]*)$/.test(String(value)) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER))
    fail();
  return Number(value);
}
function id(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200) fail();
  return value;
}

/**
 * Read-only, in-memory coverage inventory. The caller owns the already imported
 * exported-snapshot transaction and must roll it back after this call. This
 * inventory is not a backup anchor, replay ledger, owner-completeness proof,
 * or permission to restore. expectedOwners is an independently obtained roster.
 * expectedSnapshotId is the caller-provided transaction-view identifier; it
 * cannot prove that snapshotName came from the replication slot.
 */
export async function buildSnapshotCoverage({
  client,
  snapshot,
  expectedSnapshotId,
  expectedOwners,
  hmacKey,
}) {
  if (
    !client ||
    typeof client.query !== 'function' ||
    !snapshot ||
    typeof snapshot.snapshotName !== 'string' ||
    !/^[0-9A-F]{8}-[0-9A-F]{8}-[1-9][0-9]*$/i.test(snapshot.snapshotName) ||
    !LSN.test(snapshot.consistentPointLsn) ||
    !IDENTIFIER.test(snapshot.replicationSlot) ||
    !SYSTEM_IDENTIFIER.test(snapshot.postgresSystemIdentifier) ||
    typeof expectedSnapshotId !== 'string' ||
    !SNAPSHOT.test(expectedSnapshotId) ||
    !Array.isArray(expectedOwners) ||
    !Buffer.isBuffer(hmacKey) ||
    hmacKey.length !== 32
  )
    fail();
  const expected = expectedOwners.map(id);
  if (new Set(expected).size !== expected.length) fail();
  const state = one(
    await client.query(`SELECT current_user AS current_role, session_user AS session_role,
    current_setting('transaction_isolation') AS isolation,
    current_setting('transaction_read_only') AS read_only,
    txid_current_snapshot()::text AS snapshot_id`),
  );
  if (
    state.current_role !== state.session_role ||
    state.isolation !== 'repeatable read' ||
    state.read_only !== 'on' ||
    state.snapshot_id !== expectedSnapshotId
  )
    fail();
  const role = one(
    await client.query(
      `SELECT rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=current_user`,
    ),
  );
  if (role.rolsuper !== false || role.rolbypassrls !== false) fail();
  const ownership = rows(
    await client.query(
      `SELECT n.nspname||'.'||c.relname AS table_name,
      pg_catalog.pg_get_userbyid(c.relowner) AS owner_name
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname||'.'||c.relname = ANY($1::text[]) AND c.relkind='r'`,
      [TABLES],
    ),
  );
  if (
    ownership.length !== TABLES.length ||
    new Set(ownership.map((row) => row.table_name)).size !== TABLES.length ||
    ownership.some(
      (row) => !TABLES.includes(row.table_name) || row.owner_name !== state.current_role,
    )
  )
    fail();

  // This all-owner event query is possible only under the migration-owner-only
  // RLS policy. The explicit roster comparison rejects a silent owner omission.
  // tenant_erasure has tenant FORCE RLS, so a global scan would silently hide
  // other owners. An independent roster must include any pre-event erasures.
  const discovered = rows(
    await client.query(`SELECT athlete_id::text AS athlete_id FROM identity_private.account
    UNION SELECT athlete_id FROM public.restore_suppression_event`),
  ).map((row) => id(row.athlete_id));
  if (
    new Set(discovered).size !== discovered.length ||
    discovered.length !== expected.length ||
    discovered.some((owner) => !expected.includes(owner))
  )
    fail();

  const owners = [];
  for (const owner of [...expected].sort()) {
    const scope = one(
      await client.query(`SELECT pg_catalog.set_config('app.athlete_id',$1,true) AS scoped`, [
        owner,
      ]),
    );
    if (scope.scoped !== owner) fail();
    const eventRows = rows(
      await client.query(
        `SELECT kind, record_version, count(*)::text AS total
      FROM public.restore_suppression_event WHERE athlete_id=$1 GROUP BY kind,record_version`,
        [owner],
      ),
    );
    const events = Object.fromEntries(KINDS.map((kind) => [kind, 0]));
    const seenKinds = new Set();
    for (const row of eventRows) {
      const allowedVersion = [
        'intake_entry_deleted',
        'recovery_action_deleted',
        'resource_share_revoked',
        'course_share_revoked',
      ].includes(row.kind)
        ? row.record_version === 1 || row.record_version === 2
        : row.record_version === 1;
      if (
        !KINDS.includes(row.kind) ||
        !allowedVersion ||
        seenKinds.has(`${row.kind}:${row.record_version}`)
      )
        fail();
      seenKinds.add(`${row.kind}:${row.record_version}`);
      events[row.kind] += count(row.total);
    }
    const consentRows = rows(
      await client.query(
        `SELECT kind, granted, revision FROM public.consent
      WHERE athlete_id=$1 AND kind IN ('ai','healthkit')`,
        [owner],
      ),
    );
    const consent = { ai: { state: 'absent' }, healthkit: { state: 'absent' } };
    for (const row of consentRows) {
      if (
        !Object.hasOwn(consent, row.kind) ||
        consent[row.kind].state !== 'absent' ||
        typeof row.granted !== 'boolean' ||
        !Number.isSafeInteger(row.revision) ||
        row.revision < 1
      )
        fail();
      consent[row.kind] = { state: 'present', granted: row.granted, revision: row.revision };
    }
    const erased = one(
      await client.query(
        `SELECT count(*)::text AS total FROM public.tenant_erasure WHERE athlete_id=$1`,
        [owner],
      ),
    );
    const headRows = rows(
      await client.query(
        `SELECT revision FROM public.coaching_constraint_head WHERE athlete_id=$1`,
        [owner],
      ),
    );
    if (headRows.length > 1) fail();
    const head =
      headRows.length === 0
        ? { state: 'absent' }
        : { state: 'present', revision: headRows[0].revision };
    if (head.state === 'present' && (!Number.isSafeInteger(head.revision) || head.revision < 1))
      fail();
    const constraints = one(
      await client.query(
        `SELECT count(*)::text AS total,
      count(*) FILTER (WHERE deleted)::text AS tombstones
      FROM public.coaching_constraint WHERE athlete_id=$1`,
        [owner],
      ),
    );
    const budget = one(
      await client.query(
        `SELECT count(*)::text AS total,
      coalesce(sum(links_cut),0)::text AS links_cut
      FROM public.course_share_area_budget WHERE athlete_id=$1`,
        [owner],
      ),
    );
    const erasureCount = count(erased.total);
    if (erasureCount > 1 || erasureCount !== events.tenant_erased) fail();
    const constraintTotal = count(constraints.total),
      tombstones = count(constraints.tombstones);
    if (tombstones > constraintTotal || (head.state === 'absent' && constraintTotal !== 0)) fail();
    owners.push({
      ownerTag: createHmac('sha256', hmacKey).update(owner).digest('hex'),
      events,
      consent,
      erasure: erasureCount === 1 ? 'present' : 'absent',
      coaching: { head, total: constraintTotal, tombstones },
      courseShareAreaBudget: { rows: count(budget.total), linksCut: count(budget.links_cut) },
    });
  }
  return {
    schemaVersion: 1,
    snapshot: {
      snapshotName: snapshot.snapshotName,
      snapshotId: expectedSnapshotId,
      consistentPointLsn: snapshot.consistentPointLsn,
      postgresSystemIdentifier: snapshot.postgresSystemIdentifier,
      replicationSlot: snapshot.replicationSlot,
    },
    owners,
    complete: false,
    gaps: [
      'SNAPSHOT_BINDING_NOT_INDEPENDENTLY_VERIFIED',
      'OWNER_ROSTER_NOT_INDEPENDENTLY_PROVEN',
      'PRE_EVENT_ERASURE_OWNER_NOT_DISCOVERABLE',
      'PRE_EVENT_HISTORY_NOT_RECONSTRUCTIBLE',
      'HEALTHKIT_RAW_ONLY_DELETION_NOT_COVERED',
      'SHARE_EPOCH_OUTSIDE_DATABASE',
      'POST_SNAPSHOT_TAIL_NOT_WITNESSED',
      'DOMAIN_HEADS_NOT_FULLY_CAPTURED',
    ],
  };
}
