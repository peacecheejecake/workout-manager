import { z } from 'zod';
import { createBoundedPlainJsonSchema } from '@workout/contracts/bounded-plain-json';
import type { Transaction } from './database.js';
import { RetainedPersonalExportError } from './retained-personal-export.js';
import {
  raceManualInternalPersonalExportSourceSchema,
  renderRaceManualInternalPersonalExport,
} from './race-manual-internal-personal-export-renderer.js';
import {
  manualSourcePersonalExportRawSchemaV1,
  nutritionDisconnectionPersonalExportRawSchemaV1,
  mapManualSourcePersonalExportV1,
} from './manual-source-personal-export.js';

const maximum = 8 * 1024 * 1024;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const binding = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('present'),
    digestMethod: z.literal('postgres-jsonb-v1'),
    digest: hash,
  }),
  z.strictObject({
    state: z.literal('purged'),
    digestMethod: z.literal('postgres-jsonb-v1'),
    digest: z.null(),
  }),
]);
const metadata = manualSourcePersonalExportRawSchemaV1.extend({
  chains: z
    .array(
      manualSourcePersonalExportRawSchemaV1.shape.chains.element
        .omit({ preparation: true })
        .extend({ preparationBinding: binding }),
    )
    .max(1000),
});
const batch = z.strictObject({
  schemaVersion: z.literal(1),
  internal: raceManualInternalPersonalExportSourceSchema,
  sourceMetadata: metadata,
});
const proof = z.strictObject({ evidenceId: z.uuid(), digest: hash.nullable() });
const observedBatch = z.strictObject({
  source: batch,
  preparationBindings: z.array(proof).max(1000),
});
const capability = z.strictObject({ installed: z.boolean(), executable: z.boolean() });
const response = z.strictObject({
  bytes: z
    .string()
    .regex(/^[1-9]\d*$/)
    .max(16),
  source: z.unknown(),
});
function fail(code: RetainedPersonalExportError['code']): never {
  throw new RetainedPersonalExportError(code);
}
const batchQuery = `WITH observed AS MATERIALIZED (
 SELECT public.read_manual_race_retained_source_batch_v1($1::integer) AS source
), wrapped AS MATERIALIZED (
 SELECT jsonb_build_object('source',source,'preparationBindings',coalesce((
 SELECT jsonb_agg(jsonb_build_object('evidenceId',chain->'evidenceId','digest',CASE WHEN chain->>'bodyState'='present'
 THEN encode(sha256(convert_to((chain->'preparation')::text,'UTF8')),'hex') ELSE NULL END) ORDER BY ordinal)
 FROM jsonb_array_elements(source->'internal'->'chains') WITH ORDINALITY AS c(chain,ordinal)
 ),'[]'::jsonb)) AS source FROM observed
), measured AS MATERIALIZED (SELECT source,octet_length(source::text) AS bytes FROM wrapped)
SELECT bytes::text AS bytes,CASE WHEN bytes<=$1::integer THEN source ELSE NULL END AS source FROM measured`;
const nutritionQuery = `WITH observed AS MATERIALIZED (
 SELECT public.read_nutrition_disconnection_personal_export_v1($1::integer) AS source
), measured AS MATERIALIZED (SELECT source,octet_length(source::text) AS bytes FROM observed)
SELECT bytes::text AS bytes,CASE WHEN bytes<=$1::integer THEN source ELSE NULL END AS source FROM measured`;
// Before Zod accesses a driver's row, reject accessor/exotic/unknown descriptors.
function driverRow(raw: unknown) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail('CORRUPT');
  const proto: unknown = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) fail('CORRUPT');
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (
    Reflect.ownKeys(raw).length !== 2 ||
    !Object.hasOwn(descriptors, 'bytes') ||
    !Object.hasOwn(descriptors, 'source')
  )
    fail('CORRUPT');
  for (const d of Object.values(descriptors))
    if (!d.enumerable || !Object.hasOwn(d, 'value')) fail('CORRUPT');
  return response.parse(raw);
}
function hydrate(value: z.infer<typeof observedBatch>) {
  const internal = value.source.internal;
  const rows = value.source.sourceMetadata.chains;
  if (
    rows.length !== internal.chains.length ||
    value.preparationBindings.length !== internal.chains.length
  )
    fail('CORRUPT');
  const chains = new Map(internal.chains.map((c) => [c.evidenceId, c]));
  if (chains.size !== internal.chains.length) fail('CORRUPT');
  const visited = new Set<string>();
  const expected = new Map<string, string | null>();
  for (const [index, p] of value.preparationBindings.entries()) {
    if (p.evidenceId !== internal.chains[index]?.evidenceId || expected.has(p.evidenceId))
      fail('CORRUPT');
    expected.set(p.evidenceId, p.digest);
  }
  return {
    ...value.source.sourceMetadata,
    chains: rows.map((row, index) => {
      const c = chains.get(row.evidenceId);
      if (row.evidenceId !== internal.chains[index]?.evidenceId) fail('CORRUPT');
      if (
        !c ||
        visited.has(row.evidenceId) ||
        c.decisionId !== row.decisionId ||
        c.proposalId !== row.proposalId ||
        row.preparationBinding.state !== c.bodyState ||
        row.preparationBinding.digest !== expected.get(c.evidenceId)
      )
        fail('CORRUPT');
      visited.add(row.evidenceId);
      const body = z
        .discriminatedUnion('state', [
          z.strictObject({ state: z.literal('present') }),
          z.strictObject({
            state: z.literal('purged'),
            eventId: z.uuid(),
            occurredAt: z.iso.datetime({ precision: 6 }).regex(/Z$/),
          }),
        ])
        .parse(row.body);
      if (body.state !== c.bodyState) fail('CORRUPT');
      if (
        body.state === 'purged' &&
        (c.bodyState !== 'purged' ||
          body.eventId !== c.purge.purgeEventId ||
          body.occurredAt !== c.purge.purgedAt)
      )
        fail('CORRUPT');
      const { preparationBinding: _binding, ...rest } = row;
      return { ...rest, preparation: c.preparation };
    }),
  };
}
/** One same-transaction selected immutable preparation copy. The SQL JSONB
 * digest checks correspondence only; it is neither a JS DTO digest nor source
 * authentication. No external cache/body/expected hash is accepted. */
export async function readManualRetainedSourceExportBatchV1In(
  tx: Transaction,
  byteLimit = maximum,
  onMeasured?: (bytes: number) => void,
) {
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 1 || byteLimit > maximum) fail('CORRUPT');
  let remaining = byteLimit;
  const read = async (signature: string, query: string) => {
    const available = await tx.query(
      `SELECT to_regprocedure($1::text) IS NOT NULL AS installed,CASE WHEN to_regprocedure($1::text) IS NULL THEN false ELSE has_function_privilege(current_user,to_regprocedure($1::text),'EXECUTE') END AS executable`,
      [signature],
    );
    if (available.rows.length !== 1) fail('CORRUPT');
    createBoundedPlainJsonSchema(maximum).parse(available.rows[0]);
    const support = capability.parse(available.rows[0]);
    if (!support.installed || !support.executable) fail('UNSUPPORTED');
    if (remaining < 1) fail('TOO_LARGE');
    const result = await tx.query(query, [remaining]);
    if (result.rows.length !== 1) fail('CORRUPT');
    const row = driverRow(result.rows[0]);
    if (BigInt(row.bytes) > BigInt(remaining)) fail('TOO_LARGE');
    if (row.source === null) fail('CORRUPT');
    createBoundedPlainJsonSchema(Number(row.bytes)).parse(row.source);
    remaining -= Number(row.bytes);
    onMeasured?.(Number(row.bytes));
    return row.source;
  };
  try {
    const decoded = observedBatch.parse(
      await read('public.read_manual_race_retained_source_batch_v1(integer)', batchQuery),
    );
    const rawManual = hydrate(decoded);
    const internal = renderRaceManualInternalPersonalExport(decoded.source.internal);
    const nutrition = nutritionDisconnectionPersonalExportRawSchemaV1.parse(
      await read('public.read_nutrition_disconnection_personal_export_v1(integer)', nutritionQuery),
    );
    const sources = mapManualSourcePersonalExportV1(rawManual, nutrition);
    return { internal, sources };
  } catch (error) {
    if (error instanceof RetainedPersonalExportError) throw error;
    const sql = z
      .object({ message: z.string().optional(), code: z.string().optional() })
      .safeParse(error);
    if (sql.success && ['42501', '42883'].includes(sql.data.code ?? '')) fail('UNSUPPORTED');
    if (
      sql.success &&
      [
        'MANUAL_SOURCE_EXPORT_TOO_LARGE',
        'MANUAL_INTERNAL_EXPORT_TOO_LARGE',
        'MANUAL_BATCH_EXPORT_TOO_LARGE',
      ].includes(sql.data.message ?? '')
    )
      fail('TOO_LARGE');
    fail('CORRUPT');
  }
}
