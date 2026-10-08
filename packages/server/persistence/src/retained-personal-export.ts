import { z } from 'zod';
import { trainingPlanAggregateExportSchema } from '@workout/contracts/operations';
import {
  checkInTemplateExportDataSchema,
  type CheckInTemplateExportData,
} from '@workout/contracts/check-in-template-export';
import {
  raceManualPersonalApprovalHistorySchema,
  raceManualPersonalCommandResultSchema,
  raceManualPersonalExportDataSchema,
  type RaceManualPersonalExportData,
} from '@workout/contracts/race-manual-personal-export';
import {
  raceManualPublicPreviewSourceSchema,
  projectRaceManualPublicPreview,
  RaceManualPublicPreviewError,
} from './race-manual-public-preview.js';
import type { Transaction } from './database.js';

/** Internal retained read only. Neither JSON validation nor RPC presence grants
 * source authentication, processing, approval or operational restore authority. */
export class RetainedPersonalExportError extends Error {
  constructor(readonly code: 'UNSUPPORTED' | 'TOO_LARGE' | 'CORRUPT') {
    super(code);
  }
}
const maximum = 8 * 1024 * 1024;
function fail(code: RetainedPersonalExportError['code']): never {
  throw new RetainedPersonalExportError(code);
}
function bound(value: unknown, limit: number): void {
  let bytes = 0,
    nodes = 0;
  const ancestors = new Set<object>();
  const charge = (text: string) => {
    if (text.length > limit - bytes) fail('TOO_LARGE');
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > limit) fail('TOO_LARGE');
  };
  function visit(raw: unknown, depth: number): void {
    if (++nodes > limit) fail('TOO_LARGE');
    if (depth > 64) fail('CORRUPT');
    if (typeof raw === 'string') return charge(raw);
    if (raw === null || typeof raw === 'boolean') return;
    if (typeof raw === 'number' && Number.isFinite(raw)) return;
    if (typeof raw !== 'object' || ancestors.has(raw)) fail('CORRUPT');
    const array = Array.isArray(raw),
      proto: unknown = Object.getPrototypeOf(raw);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null)
      fail('CORRUPT');
    const keys = Reflect.ownKeys(raw);
    if (keys.length > limit) fail('TOO_LARGE');
    if (array && keys.length !== raw.length + 1) fail('CORRUPT');
    ancestors.add(raw);
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') fail('CORRUPT');
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= raw.length)) fail('CORRUPT');
      charge(key);
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('CORRUPT');
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(raw);
  }
  try {
    visit(value, 0);
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > limit) fail('TOO_LARGE');
  } catch (error) {
    if (error instanceof RetainedPersonalExportError) throw error;
    fail('CORRUPT');
  }
}
function decode<T>(schema: z.ZodType<T>, raw: unknown): T {
  bound(raw, maximum);
  try {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) fail('CORRUPT');
    return parsed.data;
  } catch (error) {
    if (error instanceof RetainedPersonalExportError) throw error;
    fail('CORRUPT');
  }
}
const templateEnvelope = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.literal('ready'),
  data: checkInTemplateExportDataSchema,
});
const manualEnvelope = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.literal('ready'),
  sources: z.array(raceManualPublicPreviewSourceSchema).max(1000),
  approvalHistory: z.array(raceManualPersonalApprovalHistorySchema).max(1000),
  commandResults: z.array(raceManualPersonalCommandResultSchema).max(1000),
  trainingAggregateMappings: z.array(trainingPlanAggregateExportSchema).max(1000),
});
export function mapCheckInTemplatePersonalExportV1(raw: unknown): CheckInTemplateExportData {
  return decode(templateEnvelope, raw).data;
}
export function mapRaceManualPersonalExportV1(raw: unknown): RaceManualPersonalExportData & {
  trainingPlanAggregates: z.infer<typeof trainingPlanAggregateExportSchema>[];
} {
  const envelope = decode(manualEnvelope, raw);
  try {
    const publicFacts = decode(raceManualPersonalExportDataSchema, {
      manualRaceReviews: envelope.sources.map((source) => {
        const projected = projectRaceManualPublicPreview(source);
        return {
          reference: source.reference,
          createdAt: source.reference.createdAt,
          bodyState: source.bodyState,
          preview: projected.status === 'present' ? projected : null,
        };
      }),
      manualRaceApprovalHistory: envelope.approvalHistory,
      manualRaceCommandResults: envelope.commandResults,
    });
    const seen = new Set<string>();
    for (const row of envelope.trainingAggregateMappings) {
      if (seen.has(row.version_id)) fail('CORRUPT');
      seen.add(row.version_id);
    }
    return { ...publicFacts, trainingPlanAggregates: envelope.trainingAggregateMappings };
  } catch (error) {
    if (error instanceof RetainedPersonalExportError) throw error;
    if (error instanceof RaceManualPublicPreviewError && error.code === 'PUBLIC_PREVIEW_LIMIT')
      fail('TOO_LARGE');
    fail('CORRUPT');
  }
}
const capability = z.strictObject({ installed: z.boolean(), executable: z.boolean() });
const response = z.strictObject({
  bytes: z
    .string()
    .regex(/^(0|[1-9]\d*)$/)
    .max(16),
  source: z.unknown(),
});
const sqlFailure = z.object({ code: z.string().optional(), message: z.string().optional() });
async function read<T>(
  tx: Transaction,
  signature:
    | 'public.read_check_in_template_personal_export_v1(integer)'
    | 'public.read_race_manual_personal_export_v1(integer)',
  call:
    | 'public.read_check_in_template_personal_export_v1($1::integer)'
    | 'public.read_race_manual_personal_export_v1($1::integer)',
  byteLimit: number,
  map: (raw: unknown) => T,
  measuredResponse?: (bytes: number) => void,
): Promise<T> {
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 1 || byteLimit > maximum) fail('CORRUPT');
  try {
    const probe = await tx.query(
      `SELECT to_regprocedure($1::text) IS NOT NULL AS installed,
      CASE WHEN to_regprocedure($1::text) IS NULL THEN false
       ELSE has_function_privilege(current_user,to_regprocedure($1::text),'EXECUTE') END AS executable`,
      [signature],
    );
    if (probe.rows.length !== 1) fail('CORRUPT');
    const supported = capability.safeParse(probe.rows[0]);
    if (!supported.success) fail('CORRUPT');
    if (!supported.data.installed || !supported.data.executable) fail('UNSUPPORTED');
    const result = await tx.query(
      `WITH observed AS MATERIALIZED (SELECT ${call} AS source),
      measured AS MATERIALIZED (SELECT source,octet_length(source::text) AS bytes FROM observed)
      SELECT bytes::text AS bytes,CASE WHEN bytes<=$1::integer THEN source ELSE NULL END AS source FROM measured`,
      [byteLimit],
    );
    if (result.rows.length !== 1) fail('CORRUPT');
    const row = response.safeParse(result.rows[0]);
    if (!row.success) fail('CORRUPT');
    if (BigInt(row.data.bytes) > BigInt(byteLimit)) fail('TOO_LARGE');
    if (row.data.source === null) fail('CORRUPT');
    // Trusted request-local accounting only, never an authority or ownership port.
    measuredResponse?.(Number(row.data.bytes));
    bound(row.data.source, byteLimit);
    return map(row.data.source);
  } catch (error) {
    if (error instanceof RetainedPersonalExportError) throw error;
    let failure;
    try {
      failure = sqlFailure.safeParse(error);
    } catch {
      fail('CORRUPT');
    }
    if (failure.success) {
      if (failure.data.message === 'PERSONAL_EXPORT_TOO_LARGE') fail('TOO_LARGE');
      if (failure.data.code === '42883' || failure.data.code === '42501') fail('UNSUPPORTED');
    }
    // Always throw for transaction rollback, including unexpected SQL/fence faults.
    // No driver message, function body, source data or credential is exposed.
    fail('CORRUPT');
  }
}
export function readCheckInTemplatePersonalExportV1In(
  tx: Transaction,
  byteLimit = maximum,
  measuredResponse?: (bytes: number) => void,
) {
  return read(
    tx,
    'public.read_check_in_template_personal_export_v1(integer)',
    'public.read_check_in_template_personal_export_v1($1::integer)',
    byteLimit,
    mapCheckInTemplatePersonalExportV1,
    measuredResponse,
  );
}
export function readRaceManualPersonalExportV1In(
  tx: Transaction,
  byteLimit = maximum,
  measuredResponse?: (bytes: number) => void,
) {
  return read(
    tx,
    'public.read_race_manual_personal_export_v1(integer)',
    'public.read_race_manual_personal_export_v1($1::integer)',
    byteLimit,
    mapRaceManualPersonalExportV1,
    measuredResponse,
  );
}
