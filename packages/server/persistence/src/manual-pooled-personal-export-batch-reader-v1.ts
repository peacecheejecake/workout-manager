import { z } from 'zod';
import { createBoundedPlainJsonSchema } from '@workout/contracts/bounded-plain-json';
import { trainingPlanAggregateExportSchema } from '@workout/contracts/operations';
import { raceManualPublicPreviewReferenceSchema } from '@workout/contracts/race-manual-public-preview';
import {
  raceManualPersonalApprovalHistorySchema,
  raceManualPersonalCommandResultSchema,
} from '@workout/contracts/race-manual-personal-export';
import type { Transaction } from './database.js';
import {
  RetainedPersonalExportError,
  mapRaceManualPersonalExportProjectedV2,
} from './retained-personal-export.js';
import {
  raceManualInternalPersonalExportSourceSchema,
  renderRaceManualInternalPersonalExportDecodedV2,
} from './race-manual-internal-personal-export-renderer.js';
import {
  manualSourcePersonalExportRawSchemaV1,
  nutritionDisconnectionPersonalExportRawSchemaV1,
  mapManualSourcePersonalExportDecodedV2,
} from './manual-source-personal-export.js';
import { raceManualReviewMultiOwnedRetainedPayloadV3Schema } from './race-manual-review-retained-payload-v2.js';
import { decodeRaceManualReviewPooledDatabaseEnvelopeV1 } from './race-manual-review-pooled-database-envelope-v1.js';
import { projectRaceManualDecodedPublicPreview } from './race-manual-public-preview.js';

const maximum = 8 * 1024 * 1024;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const oldChains = raceManualInternalPersonalExportSourceSchema.shape.chains.element;
const common = oldChains.options[0].omit({ bodyState: true, preparation: true, purge: true });
const wireChain = z.discriminatedUnion('bodyState', [
  common.extend({
    bodyState: z.literal('present'),
    payloadEncoding: z.enum(['legacy-retained-v2', 'pooled-database-envelope-v1']),
    payload: z.unknown(),
    purge: z.null(),
  }),
  common.extend({
    bodyState: z.literal('purged'),
    payloadEncoding: z.null(),
    payload: z.null(),
    purge: oldChains.options[1].shape.purge,
  }),
]);
const internalSchema = raceManualInternalPersonalExportSourceSchema.extend({
  schemaVersion: z.literal(2),
  chains: z.array(wireChain).max(1000),
});
const binding = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('present'),
    digestMethod: z.literal('postgres-retained-envelope-jsonb-v1'),
    digest: hash,
  }),
  z.strictObject({
    state: z.literal('purged'),
    digestMethod: z.literal('postgres-retained-envelope-jsonb-v1'),
    digest: z.null(),
  }),
]);
const metadataSchema = manualSourcePersonalExportRawSchemaV1.extend({
  schemaVersion: z.literal(2),
  chains: z
    .array(
      manualSourcePersonalExportRawSchemaV1.shape.chains.element
        .omit({ preparation: true })
        .extend({ payloadBinding: binding }),
    )
    .max(1000),
});
const publicSchema = z.strictObject({
  schemaVersion: z.literal(2),
  status: z.literal('ready'),
  sources: z
    .array(
      z.strictObject({
        candidateId: z.uuid(),
        evidenceId: z.uuid(),
        reference: raceManualPublicPreviewReferenceSchema,
        bodyState: z.enum(['present', 'purged']),
      }),
    )
    .max(1000),
  approvalHistory: z.array(raceManualPersonalApprovalHistorySchema).max(1000),
  commandResults: z.array(raceManualPersonalCommandResultSchema).max(1000),
  trainingAggregateMappings: z.array(trainingPlanAggregateExportSchema).max(1000),
});
const sourceSchema = z.strictObject({
  batchVersion: z.literal(2),
  internal: internalSchema,
  sourceMetadata: metadataSchema,
  publicMetadata: publicSchema,
});
const observedSchema = z.strictObject({
  source: sourceSchema,
  athleteId: z.string().min(1),
  payloadBindings: z
    .array(z.strictObject({ evidenceId: z.uuid(), digest: hash.nullable() }))
    .max(1000),
});
const responseSchema = z.strictObject({
  bytes: z
    .string()
    .regex(/^[1-9]\d*$/)
    .max(16),
  source: z.unknown(),
});
const capabilitySchema = z.strictObject({ installed: z.boolean(), executable: z.boolean() });
function fail(code: RetainedPersonalExportError['code']): never {
  throw new RetainedPersonalExportError(code);
}
const batchQuery = `WITH observed AS MATERIALIZED (
 SELECT public.read_manual_race_pooled_personal_export_batch_v1($1::integer) AS source
), wrapped AS MATERIALIZED (
 SELECT jsonb_build_object('source',source,'athleteId',current_setting('app.athlete_id'),'payloadBindings',coalesce((
 SELECT jsonb_agg(jsonb_build_object('evidenceId',chain->'evidenceId','digest',CASE WHEN chain->>'bodyState'='present'
 THEN encode(sha256(convert_to((chain->'payload')::text,'UTF8')),'hex') ELSE NULL END) ORDER BY ordinal)
 FROM jsonb_array_elements(source->'internal'->'chains') WITH ORDINALITY AS c(chain,ordinal)
 ),'[]'::jsonb)) AS source FROM observed
), measured AS MATERIALIZED (SELECT source,octet_length(source::text) AS bytes FROM wrapped)
SELECT bytes::text AS bytes,CASE WHEN bytes<=$1::integer THEN source ELSE NULL END AS source FROM measured`;
const nutritionQuery = `WITH observed AS MATERIALIZED (
 SELECT public.read_nutrition_disconnection_personal_export_v1($1::integer) AS source
), measured AS MATERIALIZED (SELECT source,octet_length(source::text) AS bytes FROM observed)
SELECT bytes::text AS bytes,CASE WHEN bytes<=$1::integer THEN source ELSE NULL END AS source FROM measured`;
function row(raw: unknown) {
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
  return responseSchema.parse(raw);
}
function decode(value: z.infer<typeof observedSchema>) {
  const source = value.source;
  if (
    source.internal.chains.length !== source.sourceMetadata.chains.length ||
    source.internal.chains.length !== value.payloadBindings.length
  )
    fail('CORRUPT');
  // SQL129 orders internal chains by ID; SQL132/139 source chains by
  // created_at,ID. Keep both native orders and join their exact census by ID.
  const metadataByEvidence = new Map(source.sourceMetadata.chains.map((c) => [c.evidenceId, c]));
  if (metadataByEvidence.size !== source.sourceMetadata.chains.length) fail('CORRUPT');
  const chains = source.internal.chains.map((c, index) => {
    const m = metadataByEvidence.get(c.evidenceId),
      p = value.payloadBindings[index];
    if (
      !m ||
      !p ||
      m.evidenceId !== c.evidenceId ||
      p.evidenceId !== c.evidenceId ||
      m.decisionId !== c.decisionId ||
      m.proposalId !== c.proposalId ||
      m.payloadBinding.state !== c.bodyState ||
      m.payloadBinding.digest !== p.digest
    )
      fail('CORRUPT');
    const body = z
      .discriminatedUnion('state', [
        z.strictObject({ state: z.literal('present') }),
        z.strictObject({
          state: z.literal('purged'),
          eventId: z.uuid(),
          occurredAt: z.iso.datetime({ precision: 6 }).regex(/Z$/),
        }),
      ])
      .parse(m.body);
    if (c.bodyState === 'purged') {
      if (
        body.state !== 'purged' ||
        body.eventId !== c.purge.purgeEventId ||
        body.occurredAt !== c.purge.purgedAt ||
        p.digest !== null
      )
        fail('CORRUPT');
      return {
        evidenceId: c.evidenceId,
        decisionId: c.decisionId,
        proposalId: c.proposalId,
        createdAt: c.createdAt,
        originalResult: c.originalResult,
        bodyState: 'purged' as const,
        preparation: null,
        purge: c.purge,
      };
    }
    if (body.state !== 'present' || p.digest === null) fail('CORRUPT');
    // Each logical frame retains its own frozen 4MiB/depth/source constraints.
    createBoundedPlainJsonSchema(4 * 1024 * 1024).parse(c.payload);
    const retained =
      c.payloadEncoding === 'pooled-database-envelope-v1'
        ? decodeRaceManualReviewPooledDatabaseEnvelopeV1(c.payload)
        : raceManualReviewMultiOwnedRetainedPayloadV3Schema.parse(c.payload);
    if (
      retained.state !== 'present' ||
      retained.payload.preparation.context.athleteId !== value.athleteId ||
      retained.minimalAudit.candidateDigest !== c.originalResult.candidateDigest
    )
      fail('CORRUPT');
    return {
      evidenceId: c.evidenceId,
      decisionId: c.decisionId,
      proposalId: c.proposalId,
      createdAt: c.createdAt,
      originalResult: c.originalResult,
      bodyState: 'present' as const,
      preparation: retained.payload.preparation,
      purge: null,
    };
  });
  const internal: z.infer<typeof raceManualInternalPersonalExportSourceSchema> = {
    ...source.internal,
    schemaVersion: 1,
    chains,
  };
  const index = new Map(internal.chains.map((c) => [c.evidenceId, c]));
  if (index.size !== chains.length) fail('CORRUPT');
  const candidates = new Map(internal.candidates.map((c) => [c.candidateId, c]));
  if (candidates.size !== internal.candidates.length) fail('CORRUPT');
  const seen = new Set<string>();
  const reviews = source.publicMetadata.sources.map((s) => {
    const c = candidates.get(s.candidateId),
      e = index.get(s.evidenceId);
    if (
      seen.has(s.candidateId) ||
      !c ||
      !e ||
      c.chain.evidenceId !== e.evidenceId ||
      c.chain.decisionId !== e.decisionId ||
      c.chain.proposalId !== e.proposalId ||
      c.bodyState !== s.bodyState ||
      e.bodyState !== s.bodyState ||
      s.reference.candidateId !== c.candidateId ||
      s.reference.chain.evidenceId !== e.evidenceId ||
      s.reference.chain.decisionId !== e.decisionId ||
      s.reference.chain.proposalId !== e.proposalId ||
      s.reference.chain.readonlyCandidateDigest !== e.originalResult.candidateDigest
    )
      fail('CORRUPT');
    seen.add(s.candidateId);
    let projected;
    if (c.bodyState === 'present' && e.bodyState === 'present')
      projected = projectRaceManualDecodedPublicPreview({
        reference: s.reference,
        bodyState: 'present',
        candidate: c.candidate,
        preparation: e.preparation,
      });
    else if (c.bodyState === 'purged' && e.bodyState === 'purged') {
      if (c.purge.purgedAt !== e.purge.purgedAt || c.purge.purgeEventId !== e.purge.purgeEventId)
        fail('CORRUPT');
      projected = projectRaceManualDecodedPublicPreview({
        reference: s.reference,
        bodyState: 'purged',
        candidate: null,
        preparation: null,
      });
    } else return fail('CORRUPT');
    return {
      reference: s.reference,
      createdAt: s.reference.createdAt,
      bodyState: s.bodyState,
      preview: projected.status === 'present' ? projected : null,
    };
  });
  const manual = mapRaceManualPersonalExportProjectedV2(
    {
      manualRaceReviews: reviews,
      manualRaceApprovalHistory: source.publicMetadata.approvalHistory,
      manualRaceCommandResults: source.publicMetadata.commandResults,
    },
    source.publicMetadata.trainingAggregateMappings,
  );
  const metadata: z.infer<typeof manualSourcePersonalExportRawSchemaV1> = {
    ...source.sourceMetadata,
    schemaVersion: 1,
    chains: source.sourceMetadata.chains.map((m) => {
      const { payloadBinding: discarded, ...rest } = m;
      void discarded;
      return { ...rest, preparation: index.get(m.evidenceId)?.preparation ?? null };
    }),
  };
  return { internal: renderRaceManualInternalPersonalExportDecodedV2(internal), manual, metadata };
}
/** Same-RR transport correspondence only. Retained envelope is transferred and
 * decoded once per chain; safe public/internal/source projections share it.
 * SQL hashes and current_setting are observations, never portable credentials. */
export async function readManualPooledPersonalExportBatchV1In(
  tx: Transaction,
  byteLimit = maximum,
  onMeasured?: (bytes: number) => void,
) {
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 1 || byteLimit > maximum) fail('CORRUPT');
  let remaining = byteLimit;
  const read = async (signature: string, query: string) => {
    const a = await tx.query(
      `SELECT to_regprocedure($1::text) IS NOT NULL AS installed,CASE WHEN to_regprocedure($1::text) IS NULL THEN false ELSE has_function_privilege(current_user,to_regprocedure($1::text),'EXECUTE') END AS executable`,
      [signature],
    );
    if (a.rows.length !== 1) fail('CORRUPT');
    createBoundedPlainJsonSchema(maximum).parse(a.rows[0]);
    const cap = capabilitySchema.parse(a.rows[0]);
    if (!cap.installed || !cap.executable) fail('UNSUPPORTED');
    if (remaining < 1) fail('TOO_LARGE');
    const result = await tx.query(query, [remaining]);
    if (result.rows.length !== 1) fail('CORRUPT');
    const r = row(result.rows[0]);
    if (BigInt(r.bytes) > BigInt(remaining)) fail('TOO_LARGE');
    if (r.source === null) fail('CORRUPT');
    createBoundedPlainJsonSchema(Number(r.bytes)).parse(r.source);
    remaining -= Number(r.bytes);
    onMeasured?.(Number(r.bytes));
    return r.source;
  };
  try {
    const parsed = decode(
      observedSchema.parse(
        await read('public.read_manual_race_pooled_personal_export_batch_v1(integer)', batchQuery),
      ),
    );
    const nutrition = nutritionDisconnectionPersonalExportRawSchemaV1.parse(
      await read('public.read_nutrition_disconnection_personal_export_v1(integer)', nutritionQuery),
    );
    return {
      manual: parsed.manual,
      internal: parsed.internal,
      sources: mapManualSourcePersonalExportDecodedV2(parsed.metadata, nutrition),
    };
  } catch (error) {
    if (error instanceof RetainedPersonalExportError) throw error;
    let code: unknown, message: unknown;
    try {
      if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
        const c = Object.getOwnPropertyDescriptor(error, 'code'),
          m = Object.getOwnPropertyDescriptor(error, 'message');
        if ((c && !Object.hasOwn(c, 'value')) || (m && !Object.hasOwn(m, 'value'))) fail('CORRUPT');
        code = c?.value;
        message = m?.value;
      }
    } catch {
      fail('CORRUPT');
    }
    if (typeof code === 'string' && ['42501', '42883'].includes(code)) fail('UNSUPPORTED');
    if (
      typeof message === 'string' &&
      [
        'MANUAL_SOURCE_EXPORT_TOO_LARGE',
        'MANUAL_INTERNAL_EXPORT_TOO_LARGE',
        'MANUAL_BATCH_EXPORT_TOO_LARGE',
        'PERSONAL_EXPORT_TOO_LARGE',
      ].includes(message)
    )
      fail('TOO_LARGE');
    fail('CORRUPT');
  }
}
