// Export35 retained facts only: structural validity grants no restore or approval authority.
import { z } from 'zod';
import { nutritionPlanVersionCompatibleV4Schema } from './nutrition-race-plan-v4.js';
import { raceResultCompatibleStorageLifecycleSchema } from './race-result-v2.js';

const uuid = z.uuid();
const nutritionRevision = z.number().int().min(1).max(2147483646);
const raceRevision = z.number().int().min(1).max(2147483647);
const instant = z.iso.datetime({ offset: true });
const date = z.iso.date();
const identity = (value: string) => value.toLowerCase();
function preciseInstant(value: string): string | null {
  const match = /^(.*:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match?.[1] || !match[3]) return null;
  const seconds = Date.parse(match[1] + match[3]);
  return Number.isSafeInteger(seconds) ? `${seconds}:${(match[2] ?? '').replace(/0+$/, '')}` : null;
}
function sameInstant(left: string, right: string) {
  const value = preciseInstant(left);
  return value !== null && value === preciseInstant(right);
}
function issue(context: z.RefinementCtx, message: string) {
  context.addIssue({ code: 'custom', message });
}
function boundedJson<T>(schema: z.ZodType<T>, maximum: number) {
  return z
    .unknown()
    .superRefine((value, context) => {
      const json = z.json().safeParse(value);
      if (!json.success) {
        issue(context, 'Export record must be JSON');
        return;
      }
      if (new TextEncoder().encode(JSON.stringify(json.data)).byteLength > maximum)
        issue(context, 'Export record byte limit exceeded');
    })
    .pipe(schema);
}
function instantOrder(left: string, right: string): number | null {
  const a = preciseInstant(left),
    b = preciseInstant(right);
  if (a === null || b === null) return null;
  const [secondsA, fractionA = ''] = a.split(':'),
    [secondsB, fractionB = ''] = b.split(':');
  const seconds = Number(secondsA) - Number(secondsB);
  if (seconds !== 0) return Math.sign(seconds);
  const width = Math.max(fractionA.length, fractionB.length);
  const x = fractionA.padEnd(width, '0'),
    y = fractionB.padEnd(width, '0');
  return x === y ? 0 : x < y ? -1 : 1;
}
type Json = z.infer<ReturnType<typeof z.json>>;
function canonicalJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
const nutritionVersion = z
  .strictObject({
    plan_id: uuid,
    version_id: uuid,
    version: nutritionRevision,
    previous_version_id: uuid.nullable(),
    period_from: date,
    period_to: date,
    linked_training_plan_version_id: uuid.nullable(),
    approval_id: uuid,
    approved_at: instant,
    record_json: boundedJson(nutritionPlanVersionCompatibleV4Schema, 512 * 1024),
  })
  .superRefine((row, context) => {
    const body = row.record_json;
    const sameNullable = (a: string | null, b: string | null) =>
      a === null || b === null ? a === b : identity(a) === identity(b);
    if (
      identity(row.plan_id) !== identity(body.planId) ||
      identity(row.version_id) !== identity(body.versionId) ||
      row.version !== body.version ||
      !sameNullable(row.previous_version_id, body.previousVersionId) ||
      row.period_from !== body.period.from ||
      row.period_to !== body.period.toInclusive ||
      !sameNullable(row.linked_training_plan_version_id, body.linkedTrainingPlanVersionId) ||
      identity(row.approval_id) !== identity(body.approvalId) ||
      !sameInstant(row.approved_at, body.approvedAt)
    )
      issue(context, 'Nutrition stored tuple mismatch');
  });
const nutritionHead = z.strictObject({
  plan_id: uuid,
  version: nutritionRevision,
  version_id: uuid,
});
const nutritionHistory = z.strictObject({
  plan_id: uuid,
  version_id: uuid,
  approval_id: uuid,
  action: z.enum(['user_approved', 'candidate_approved']),
  created_at: instant,
});
const rawRaceValues = boundedJson(z.record(z.string(), z.json()), 16 * 1024);
function validateRaceBody(
  id: string,
  revision: number,
  values: z.infer<typeof rawRaceValues>,
  context: z.RefinementCtx,
) {
  if (
    ['id', 'revision', 'athleteId', 'ownerId', 'athlete_id', 'owner_id'].some(
      (key) => key in values,
    ) ||
    !raceResultCompatibleStorageLifecycleSchema.safeParse({ ...values, id, revision }).success
  )
    issue(context, 'Race values must match the exact relational identity and storage codec');
}
const raceHead = z
  .strictObject({
    id: uuid,
    revision: raceRevision,
    values_json: rawRaceValues.nullable(),
    deleted: z.boolean(),
    recorded_at: instant,
    updated_at: instant,
  })
  .superRefine((row, context) => {
    if (row.deleted !== (row.values_json === null)) issue(context, 'Race deletion/body mismatch');
    if ((instantOrder(row.updated_at, row.recorded_at) ?? -1) < 0)
      issue(context, 'Race head timestamp order');
    if (row.values_json !== null) validateRaceBody(row.id, row.revision, row.values_json, context);
  });
const raceHistory = z
  .strictObject({
    entity_id: uuid,
    revision: raceRevision,
    values_json: rawRaceValues,
    created_at: instant,
  })
  .superRefine((row, context) => {
    validateRaceBody(row.entity_id, row.revision, row.values_json, context);
  });
export const raceNutritionExportFields35 = {
  nutritionPlanVersions: z.array(nutritionVersion).max(1000),
  nutritionPlanHeads: z.array(nutritionHead).max(1000),
  nutritionPlanHistory: z.array(nutritionHistory).max(1000),
  raceResults: z.array(raceHead).max(1000),
  raceResultRevisions: z.array(raceHistory).max(1000),
};
const rows = z.strictObject(raceNutritionExportFields35);
export type RaceNutritionExportData35 = z.infer<typeof rows>;
export function validateRaceNutritionExportTuples35(
  data: RaceNutritionExportData35,
  context: z.RefinementCtx,
) {
  const requireFact = (fact: boolean, message: string) => {
    if (!fact) issue(context, message);
  };
  const unique = (keys: string[]) =>
    requireFact(new Set(keys).size === keys.length, 'Duplicate export identity');
  const tuple = (id: string, revision: number) => JSON.stringify([identity(id), revision]);
  unique(data.nutritionPlanVersions.map((row) => identity(row.version_id)));
  unique(data.nutritionPlanVersions.map((row) => identity(row.approval_id)));
  unique(data.nutritionPlanVersions.map((row) => tuple(row.plan_id, row.version)));
  unique(data.nutritionPlanHeads.map((row) => identity(row.plan_id)));
  unique(data.nutritionPlanHistory.map((row) => identity(row.version_id)));
  unique(data.nutritionPlanHistory.map((row) => identity(row.approval_id)));
  unique(data.raceResults.map((row) => identity(row.id)));
  unique(data.raceResultRevisions.map((row) => tuple(row.entity_id, row.revision)));
  const versions = new Map(
    data.nutritionPlanVersions.map((row) => [identity(row.version_id), row]),
  );
  const heads = new Map(data.nutritionPlanHeads.map((row) => [identity(row.plan_id), row]));
  const history = new Map(data.nutritionPlanHistory.map((row) => [identity(row.version_id), row]));
  for (const row of data.nutritionPlanVersions) {
    const head = heads.get(identity(row.plan_id));
    const approval = history.get(identity(row.version_id));
    requireFact(
      head !== undefined && head.version >= row.version,
      'Missing/current nutrition head mismatch',
    );
    requireFact(
      approval !== undefined &&
        identity(approval.plan_id) === identity(row.plan_id) &&
        identity(approval.approval_id) === identity(row.approval_id),
      'Missing exact nutrition history approval',
    );
    if (row.previous_version_id !== null) {
      const previous = versions.get(identity(row.previous_version_id));
      requireFact(
        previous !== undefined &&
          identity(previous.plan_id) === identity(row.plan_id) &&
          previous.version === row.version - 1,
        'Nutrition predecessor tuple mismatch',
      );
    }
  }
  for (const head of data.nutritionPlanHeads) {
    const version = versions.get(identity(head.version_id));
    requireFact(
      version !== undefined &&
        identity(version.plan_id) === identity(head.plan_id) &&
        version.version === head.version,
      'Nutrition head tuple mismatch',
    );
  }
  for (const row of data.nutritionPlanHistory) {
    const version = versions.get(identity(row.version_id));
    requireFact(
      version !== undefined &&
        identity(version.plan_id) === identity(row.plan_id) &&
        identity(version.approval_id) === identity(row.approval_id),
      'Nutrition history tuple mismatch',
    );
  }
  const raceHeads = new Map(data.raceResults.map((row) => [identity(row.id), row]));
  const raceHistory = new Map(
    data.raceResultRevisions.map((row) => [tuple(row.entity_id, row.revision), row]),
  );
  for (const head of data.raceResults) {
    // Terminal source unlink can legitimately remove its same-version history
    // without creating a fabricated replacement (098/099 saturation behavior).
    if (!head.deleted && head.revision < 2147483647) {
      const current = raceHistory.get(tuple(head.id, head.revision));
      requireFact(
        current !== undefined &&
          head.values_json !== null &&
          canonicalJson(current.values_json) === canonicalJson(head.values_json),
        'Race current history/body mismatch',
      );
    }
  }
  for (const row of data.raceResultRevisions) {
    const head = raceHeads.get(identity(row.entity_id));
    requireFact(
      head !== undefined && row.revision <= head.revision,
      'Race historical identity mismatch',
    );
    requireFact(head?.deleted === false, 'Deleted race head cannot retain private history');
  }
}
export const raceNutritionExportData35 = rows.superRefine(validateRaceNutritionExportTuples35);
