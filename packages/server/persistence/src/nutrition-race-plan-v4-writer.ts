import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  saveNutritionPlanV4IntentSchema,
  nutritionPlanVersionV4Schema,
  nutritionPlanVersionCompatibleV4Schema,
  type NutritionPlanVersionCompatibleV4,
} from '@workout/contracts/nutrition-race-plan-v4';
import {
  saveNutritionPlanV3IntentSchema,
  type SaveNutritionPlanV3Intent,
} from '@workout/contracts/nutrition-race-plan-v3';
import { planDraftSchema } from '@workout/contracts/planning';
import type {
  ItemRaceTimingBinding,
  RaceTimingPinV1,
} from '@workout/contracts/nutrition-race-timing';
import type { Database, Transaction } from './database.js';
import { lockAppAdmission, requireAppAdmission } from './app-admission.js';
import { validateFoodPortions, NutritionReferenceError } from './nutrition-core.js';
import { raceHeadExpectationRosterSchema } from '@workout/contracts/nutrition-race-timing';
import { captureRaceTimingPins } from './race-timing-bindings.js';
import { localInstant } from './integrated-planner.js';
import { PersistenceConflict } from './outbox.js';
import { createFrozenNutritionProjectorCompatibleV4 } from './nutrition-frozen-timing-projection.js';

export class NutritionRacePlanV4WriterError extends Error {
  constructor(
    readonly code:
      | 'NUTRITION_V4_SOURCE_INVALID'
      | 'NUTRITION_V4_LIMIT'
      | 'NUTRITION_V4_ORIGIN_REQUIRED'
      | 'NUTRITION_V4_RECONNECT_REQUIRED'
      | 'NUTRITION_V4_RECONNECT_INVALID'
      | 'NUTRITION_V4_TIMING_UNRESOLVED',
  ) {
    super(code);
  }
}
type Notice = {
  readonly itemId: string;
  readonly code: 'LEGACY_UNPINNED_PRESERVED' | 'UNRESOLVED_PRESERVED';
};
export interface NutritionRacePlanV4WriteResult {
  readonly plan: NutritionPlanVersionCompatibleV4;
  readonly notices: readonly Notice[];
}
export interface NutritionRacePlanV4Writer {
  /** Standalone explicit nutrition approval. SQL110 is the write authority;
   * prepared DTOs, caller pins and boolean origin reads never authorize writes. */
  savePlanV4(athleteId: string, unknownIntent: unknown): Promise<NutritionRacePlanV4WriteResult>;
}
const positive = z.string().regex(/^\d+$/);
const receiptRequest = z.strictObject({
  receiptVersion: z.literal(3),
  digestVersion: z.literal('postgres-jsonb-sha256-v1'),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
const receiptResult = z.strictObject({
  receiptVersion: z.literal(3),
  outcome: z.literal('committed'),
  kind: z.literal('nutrition_plan'),
  planId: z.uuid(),
  versionId: z.uuid(),
  version: z.number().int().min(1).max(2147483646),
  approvalId: z.uuid(),
});
function invalid(): never {
  throw new NutritionRacePlanV4WriterError('NUTRITION_V4_SOURCE_INVALID');
}
function bytes(value: unknown): number {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return invalid();
  }
  if (encoded === undefined) return invalid();
  return Buffer.byteLength(encoded, 'utf8');
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return invalid();
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`;
}
function decode<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success || canonical(parsed.data) !== canonical(value)) return invalid();
  return parsed.data;
}
function sameId(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}
function addSize(current: number, size: string | number) {
  const next = BigInt(current) + (typeof size === 'string' ? BigInt(size) : BigInt(size));
  if (next > 4194304n) throw new NutritionRacePlanV4WriterError('NUTRITION_V4_LIMIT');
  return Number(next);
}
function content(item: NutritionPlanVersionCompatibleV4['items'][number]) {
  const { planVersionId, ...rest } = item;
  void planVersionId;
  return rest;
}
export function deriveNutritionAffectedItemIdsV4(
  prior: NutritionPlanVersionCompatibleV4,
  intent: SaveNutritionPlanV3Intent,
): readonly string[] {
  return deriveCalculationAffected(prior, calculationInput(intent));
}
function deriveCalculationAffected(
  prior: NutritionPlanVersionCompatibleV4,
  intent: NutritionV4CalculationInput,
) {
  const draft = intent.draft;
  const old = new Map(prior.items.map((item) => [item.id, item]));
  const changedContext =
    prior.timezone !== draft.timezone ||
    prior.linkedTrainingPlanVersionId !== draft.linkedTrainingPlanVersionId ||
    canonical(prior.period) !== canonical(draft.period);
  return draft.items
    .filter((item) => {
      const previous = old.get(item.id);
      return (
        changedContext || previous === undefined || canonical(content(previous)) !== canonical(item)
      );
    })
    .map((item) => item.id)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
function frozenNotices(
  plan: NutritionPlanVersionCompatibleV4,
  training: z.infer<typeof planDraftSchema> | null,
): Notice[] {
  const projector = createFrozenNutritionProjectorCompatibleV4({
    record: plan,
    targetTimezone: plan.timezone,
    linkedTraining:
      training !== null && plan.linkedTrainingPlanVersionId !== null
        ? { versionId: plan.linkedTrainingPlanVersionId, draft: training }
        : null,
  });
  const bindings = new Map(
    'schemaVersion' in plan
      ? plan.itemRaceTimingBindings.map((entry) => [entry.itemId, entry.binding])
      : [],
  );
  const pins = new Map(
    'schemaVersion' in plan
      ? plan.raceTimingPins.map((pin) => [JSON.stringify([pin.eventId, pin.eventRevision]), pin])
      : [],
  );
  const notices: Notice[] = [];
  for (const item of plan.items) {
    if (item.anchor.kind !== 'relative') continue;
    if (item.anchor.entity === 'session') {
      // The race visibility argument is ignored by the session projector. It
      // deliberately does not invent current race source availability.
      if (
        projector.project({ itemId: item.id, raceSourceVisibility: 'unknown' }).status ===
        'unresolved'
      )
        notices.push({ itemId: item.id, code: 'UNRESOLVED_PRESERVED' });
      continue;
    }
    const binding = bindings.get(item.id);
    if (!binding || binding.state === 'legacy_unpinned') {
      notices.push(
        { itemId: item.id, code: 'LEGACY_UNPINNED_PRESERVED' },
        { itemId: item.id, code: 'UNRESOLVED_PRESERVED' },
      );
      continue;
    }
    const pin = pins.get(JSON.stringify([binding.eventId, binding.eventRevision]));
    if (!pin) return invalid();
    let unresolved = item.anchor.point === 'end' || pin.start.state === 'unknown';
    if (pin.start.state === 'known') {
      const shifted = Date.parse(pin.start.instant) + item.anchor.offsetMinutes * 60000;
      try {
        if (!z.iso.datetime({ offset: true }).safeParse(new Date(shifted).toISOString()).success)
          unresolved = true;
      } catch {
        unresolved = true;
      }
    }
    if (unresolved) notices.push({ itemId: item.id, code: 'UNRESOLVED_PRESERVED' });
  }
  return notices;
}
async function replayTraining(
  tx: Transaction,
  plan: NutritionPlanVersionCompatibleV4,
  recordBytes: string,
) {
  if (
    plan.linkedTrainingPlanVersionId === null ||
    !plan.items.some((item) => item.anchor.kind === 'relative' && item.anchor.entity === 'session')
  )
    return null;
  const size = await tx.query(
    'SELECT octet_length(draft::text)::text AS bytes FROM plan_snapshot WHERE athlete_id=$1 AND id=$2',
    [tx.athleteId, plan.linkedTrainingPlanVersionId],
  );
  if (size.rows.length === 0) return null;
  if (size.rows.length !== 1) return invalid();
  addSize(Number(recordBytes), z.strictObject({ bytes: positive }).parse(size.rows[0]).bytes);
  const snapshot = await tx.query('SELECT draft FROM plan_snapshot WHERE athlete_id=$1 AND id=$2', [
    tx.athleteId,
    plan.linkedTrainingPlanVersionId,
  ]);
  if (snapshot.rows.length !== 1) return invalid();
  return decode(planDraftSchema, snapshot.rows[0]?.['draft']);
}
async function originalReceipt(tx: Transaction, key: string, request: unknown, planId: string) {
  const result = await tx.query(
    `SELECT request,result,request=jsonb_build_object('receiptVersion',3,'digestVersion','postgres-jsonb-sha256-v1',
      'requestDigest',encode(sha256(convert_to(($3::jsonb)::text,'UTF8')),'hex')) AS matches
     FROM command_receipt WHERE athlete_id=$1 AND idempotency_key=$2`,
    [tx.athleteId, key, JSON.stringify(request)],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) return invalid();
  const row = z
    .strictObject({ request: z.unknown(), result: z.unknown(), matches: z.boolean() })
    .parse(result.rows[0]);
  if (!row.matches) throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
  decode(receiptRequest, row.request);
  const reference = decode(receiptResult, row.result);
  if (!sameId(reference.planId, planId)) return invalid();
  const records = await tx.query(
    `SELECT octet_length(record_json::text)::text AS bytes,
      CASE WHEN octet_length(record_json::text)<=524288 THEN record_json ELSE NULL END AS record_json
     FROM nutrition_plan_version WHERE athlete_id=$1 AND plan_id=$2 AND version_id=$3 AND version=$4 AND approval_id=$5`,
    [tx.athleteId, reference.planId, reference.versionId, reference.version, reference.approvalId],
  );
  if (records.rows.length !== 1) return invalid();
  const exact = z
    .strictObject({ bytes: positive, record_json: z.unknown() })
    .parse(records.rows[0]);
  if (BigInt(exact.bytes) > 524288n) throw new NutritionRacePlanV4WriterError('NUTRITION_V4_LIMIT');
  const plan = decode(nutritionPlanVersionCompatibleV4Schema, exact.record_json);
  if (
    !sameId(plan.planId, reference.planId) ||
    !sameId(plan.versionId, reference.versionId) ||
    plan.version !== reference.version ||
    !sameId(plan.approvalId, reference.approvalId)
  )
    return invalid();
  return { plan, notices: frozenNotices(plan, await replayTraining(tx, plan, exact.bytes)) };
}
/** Calculation data only. No approval/key/server-generated version is present. */
export const nutritionV4CalculationInputSchema = saveNutritionPlanV3IntentSchema.shape.command
  .omit({ kind: true, idempotencyKey: true, confirmed: true })
  .extend({
    expectedRaceHeads: saveNutritionPlanV3IntentSchema.shape.expectedRaceHeads,
    reconnectItemIds: saveNutritionPlanV3IntentSchema.shape.reconnectItemIds,
  })
  .superRefine((input, ctx) => {
    const items = new Map(input.draft.items.map((i) => [i.id, i]));
    input.reconnectItemIds.forEach((id, index) => {
      const previous = input.reconnectItemIds[index - 1],
        item = items.get(id);
      if (
        (previous !== undefined && previous >= id) ||
        !item ||
        item.anchor.kind !== 'relative' ||
        item.anchor.entity !== 'race'
      )
        ctx.addIssue({ code: 'custom', message: 'Invalid reconnect roster' });
    });
    const roster = raceHeadExpectationRosterSchema.safeParse({
      items: input.draft.items.flatMap((i) =>
        i.anchor.kind === 'disconnected' ? [] : [{ itemId: i.id, anchor: i.anchor }],
      ),
      expectedRaceHeads: input.expectedRaceHeads,
    });
    if (!roster.success)
      for (const issue of roster.error.issues)
        ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
  });
export type NutritionV4CalculationInput = z.infer<typeof nutritionV4CalculationInputSchema>;
export function assertNutritionV4PlainInput(input: unknown, limit = 524288): void {
  const active = new WeakSet<object>();
  let visits = 0,
    primitiveBytes = 0;
  const charge = (value: string) => {
    primitiveBytes += Buffer.byteLength(value, 'utf8');
    if (primitiveBytes > limit) throw new NutritionRacePlanV4WriterError('NUTRITION_V4_LIMIT');
  };
  function visit(value: unknown, depth: number): void {
    if (++visits > 500000 || depth > 64)
      throw new NutritionRacePlanV4WriterError('NUTRITION_V4_LIMIT');
    if (typeof value === 'string') {
      charge(value);
      return;
    }
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) invalid();
      return;
    }
    if (typeof value !== 'object' || active.has(value)) invalid();
    if (Array.isArray(value) && Object.getPrototypeOf(value) !== Array.prototype) invalid();
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      invalid();
    if (Reflect.ownKeys(value).some((k) => typeof k !== 'string')) invalid();
    active.add(value);
    const properties = Object.getOwnPropertyDescriptors(value);
    for (const [key, property] of Object.entries(properties)) {
      if (Array.isArray(value) && key === 'length') continue;
      charge(key);
      if (!('value' in property) || !property.enumerable) invalid();
      visit(property.value, depth + 1);
    }
    if (Array.isArray(value) && Object.keys(value).length !== value.length) invalid();
    active.delete(value);
  }
  visit(input, 0);
  if (bytes(input) > limit) throw new NutritionRacePlanV4WriterError('NUTRITION_V4_LIMIT');
}
function calculationInput(intent: SaveNutritionPlanV3Intent): NutritionV4CalculationInput {
  return {
    planId: intent.command.planId,
    expectedHeadVersionId: intent.command.expectedHeadVersionId,
    draft: intent.command.draft,
    expectedRaceHeads: intent.expectedRaceHeads,
    reconnectItemIds: intent.reconnectItemIds,
  };
}
async function priorHead(tx: Transaction, intent: NutritionV4CalculationInput) {
  const command = intent;
  const result = await tx.query(
    `SELECT h.version,h.version_id,octet_length(v.record_json::text)::text AS bytes,
      CASE WHEN octet_length(v.record_json::text)<=524288 THEN v.record_json ELSE NULL END AS record_json
     FROM nutrition_plan_head h JOIN nutrition_plan_version v ON v.athlete_id=h.athlete_id AND v.plan_id=h.plan_id
      AND v.version=h.version AND v.version_id=h.version_id
     WHERE h.athlete_id=$1 AND h.plan_id=$2 FOR UPDATE OF h`,
    [tx.athleteId, command.planId],
  );
  if (result.rows.length === 0) throw new NutritionReferenceError('PLAN_NOT_FOUND');
  if (result.rows.length !== 1) return invalid();
  const row = z
    .strictObject({
      version: z.number().int().min(1).max(2147483646),
      version_id: z.uuid(),
      bytes: positive,
      record_json: z.unknown(),
    })
    .parse(result.rows[0]);
  if (!sameId(row.version_id, command.expectedHeadVersionId))
    throw new PersistenceConflict('REVISION_CONFLICT');
  if (BigInt(row.bytes) > 524288n) throw new NutritionRacePlanV4WriterError('NUTRITION_V4_LIMIT');
  const prior = decode(nutritionPlanVersionCompatibleV4Schema, row.record_json);
  if (
    !sameId(prior.planId, command.planId) ||
    !sameId(prior.versionId, row.version_id) ||
    prior.version !== row.version
  )
    return invalid();
  if (prior.version >= 2147483646) throw new NutritionRacePlanV4WriterError('NUTRITION_V4_LIMIT');
  return { prior, size: Number(row.bytes) };
}
async function requireOrigins(
  tx: Transaction,
  prior: NutritionPlanVersionCompatibleV4,
  intent: NutritionV4CalculationInput,
) {
  const old = new Map(prior.items.map((item) => [item.id, item]));
  const reconnect = new Set(intent.reconnectItemIds),
    origins: string[] = [];
  for (const item of intent.draft.items) {
    const previous = old.get(item.id);
    if (item.anchor.kind === 'disconnected' || previous?.anchor.kind === 'disconnected') {
      if (previous?.anchor.kind !== 'disconnected')
        throw new NutritionRacePlanV4WriterError('NUTRITION_V4_ORIGIN_REQUIRED');
      origins.push(item.id);
      if (
        item.anchor.kind !== 'disconnected' &&
        (!reconnect.has(item.id) ||
          item.anchor.kind !== 'relative' ||
          item.anchor.entity !== 'race')
      )
        throw new NutritionRacePlanV4WriterError('NUTRITION_V4_RECONNECT_REQUIRED');
      if (item.anchor.kind === 'disconnected' && reconnect.has(item.id))
        throw new NutritionRacePlanV4WriterError('NUTRITION_V4_RECONNECT_INVALID');
    } else if (reconnect.has(item.id))
      throw new NutritionRacePlanV4WriterError('NUTRITION_V4_RECONNECT_INVALID');
  }
  if (origins.length === 0) return;
  origins.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const result = await tx.query(
    `SELECT item_id,public.read_nutrition_disconnection_origin($2::uuid,$3::uuid,item_id) AS authorized
    FROM unnest($4::text[]) x(item_id) WHERE $1::text=nullif(current_setting('app.athlete_id',true),'') ORDER BY item_id COLLATE "C"`,
    [tx.athleteId, prior.planId, prior.versionId, origins],
  );
  if (result.rows.length !== origins.length) return invalid();
  const expected = new Set(origins),
    seen = new Set<string>();
  for (const value of result.rows) {
    const row = z.strictObject({ item_id: z.string(), authorized: z.boolean() }).parse(value);
    if (!expected.has(row.item_id) || seen.has(row.item_id) || !row.authorized)
      throw new NutritionRacePlanV4WriterError('NUTRITION_V4_ORIGIN_REQUIRED');
    seen.add(row.item_id);
  }
}
async function preparationSources(
  tx: Transaction,
  intent: NutritionV4CalculationInput,
  initialSize: number,
) {
  const draft = intent.draft;
  let size = initialSize;
  const foods = [
    ...new Set(
      draft.items.flatMap((item) =>
        item.foods.flatMap((food) =>
          food.foodVersionId === null ? [] : [z.uuid().parse(food.foodVersionId).toLowerCase()],
        ),
      ),
    ),
  ];
  if (foods.length > 5000) throw new NutritionRacePlanV4WriterError('NUTRITION_V4_LIMIT');
  if (foods.length) {
    const totals = await tx.query(
      `SELECT count(*)::text AS count,coalesce(sum(octet_length(record_json::text)+1024),0)::text AS bytes
      FROM food_definition_version WHERE athlete_id=$1 AND version_id=ANY($2::uuid[])`,
      [tx.athleteId, foods],
    );
    if (totals.rows.length !== 1) return invalid();
    const row = z.strictObject({ count: positive, bytes: positive }).parse(totals.rows[0]);
    if (BigInt(row.count) !== BigInt(foods.length))
      throw new NutritionReferenceError('FOOD_LINK_INVALID');
    size = addSize(size, row.bytes);
  }
  await validateFoodPortions(
    tx,
    draft.items.flatMap((item) => item.foods),
  );
  let training: z.infer<typeof planDraftSchema> | null = null;
  if (draft.linkedTrainingPlanVersionId !== null) {
    const totals = await tx.query(
      'SELECT octet_length(draft::text)::text AS bytes FROM plan_snapshot WHERE athlete_id=$1 AND id=$2',
      [tx.athleteId, draft.linkedTrainingPlanVersionId],
    );
    if (totals.rows.length !== 1) throw new NutritionReferenceError('PLAN_LINK_INVALID');
    size = addSize(size, z.strictObject({ bytes: positive }).parse(totals.rows[0]).bytes);
    const found = await tx.query('SELECT draft FROM plan_snapshot WHERE athlete_id=$1 AND id=$2', [
      tx.athleteId,
      draft.linkedTrainingPlanVersionId,
    ]);
    if (found.rows.length !== 1) return invalid();
    training = decode(planDraftSchema, found.rows[0]?.['draft']);
  }
  if (intent.expectedRaceHeads.length) {
    const totals = await tx.query(
      `WITH requested AS (SELECT * FROM unnest($2::uuid[],$3::integer[]) x(id,revision))
      SELECT coalesce(sum(octet_length(h.values_json::text)+coalesce(octet_length(v.values_json::text),0)+1024),0)::text AS bytes
      FROM requested x JOIN race_event h ON h.athlete_id=$1 AND h.id=x.id AND NOT h.deleted
      LEFT JOIN race_event_revision v ON v.athlete_id=h.athlete_id AND v.entity_id=h.id AND v.revision=x.revision`,
      [
        tx.athleteId,
        intent.expectedRaceHeads.map((head) => head.eventId),
        intent.expectedRaceHeads.map((head) => head.revision),
      ],
    );
    if (totals.rows.length !== 1) return invalid();
    size = addSize(size, z.strictObject({ bytes: positive }).parse(totals.rows[0]).bytes);
  }
  return { training, size, current: await captureRaceTimingPins(tx, intent.expectedRaceHeads) };
}
function selectTiming(
  prior: NutritionPlanVersionCompatibleV4,
  intent: NutritionV4CalculationInput,
  affected: readonly string[],
  sources: Awaited<ReturnType<typeof preparationSources>>,
  mode: 'diagnostic_only' | 'approval_requires_resolved' = 'approval_requires_resolved',
) {
  const changed = new Set(affected),
    reconnect = new Set(intent.reconnectItemIds);
  const old = new Map(prior.items.map((item) => [item.id, item]));
  const oldBindings = new Map(
    'schemaVersion' in prior
      ? prior.itemRaceTimingBindings.map((binding) => [binding.itemId, binding])
      : [],
  );
  const key = (id: string, version: number) => JSON.stringify([id, version]);
  const oldPins = new Map(
    'schemaVersion' in prior
      ? prior.raceTimingPins.map((pin) => [key(pin.eventId, pin.eventRevision), pin])
      : [],
  );
  const current = new Map(sources.current.map((pin) => [pin.eventId, pin]));
  const sessions = new Map(
    sources.training?.sessions.map((session) => [session.id, session]) ?? [],
  );
  const pins = new Map<string, RaceTimingPinV1>(),
    bindings: ItemRaceTimingBinding[] = [];
  for (const item of intent.draft.items) {
    if (item.anchor.kind !== 'relative') continue;
    const preserve = !changed.has(item.id) && !reconnect.has(item.id);
    if (item.anchor.entity === 'session') {
      const session = sessions.get(item.anchor.entityId);
      if (!session || !sources.training) throw new NutritionReferenceError('SESSION_LINK_INVALID');
      if (
        session.localStartTime === null ||
        localInstant(session.date, session.localStartTime, sources.training.timezone) === null ||
        (item.anchor.point === 'end' && session.durationSeconds === null)
      ) {
        if (!preserve && mode === 'approval_requires_resolved')
          throw new NutritionRacePlanV4WriterError('NUTRITION_V4_TIMING_UNRESOLVED');
      }
      continue;
    }
    const previous = old.get(item.id),
      oldBinding = oldBindings.get(item.id);
    if (preserve && (!oldBinding || oldBinding.binding.state === 'legacy_unpinned')) {
      if (!previous) return invalid();
      bindings.push(
        oldBinding ?? {
          itemId: item.id,
          binding: {
            state: 'legacy_unpinned',
            priorNutritionVersionId: prior.versionId,
            priorItemId: item.id,
            priorAnchorDigest: createHash('sha256')
              .update(
                canonical({ domain: 'nutrition-anchor-canonical-v1', anchor: previous.anchor }),
                'utf8',
              )
              .digest('hex'),
          },
        },
      );
      const fresh = current.get(item.anchor.entityId);
      if (!fresh) return invalid();
      continue;
    }
    const selected =
      preserve && oldBinding?.binding.state === 'captured'
        ? oldPins.get(key(oldBinding.binding.eventId, oldBinding.binding.eventRevision))
        : current.get(item.anchor.entityId);
    if (!selected || selected.eventId !== item.anchor.entityId) return invalid();
    const tuple = key(selected.eventId, selected.eventRevision),
      existing = pins.get(tuple);
    if (existing && canonical(existing) !== canonical(selected)) return invalid();
    pins.set(tuple, selected);
    bindings.push(
      preserve && oldBinding
        ? oldBinding
        : {
            itemId: item.id,
            binding: {
              state: 'captured',
              eventId: selected.eventId,
              eventRevision: selected.eventRevision,
            },
          },
    );
    if (item.anchor.point === 'end' || selected.start.state === 'unknown') {
      if (!preserve && mode === 'approval_requires_resolved')
        throw new NutritionRacePlanV4WriterError('NUTRITION_V4_TIMING_UNRESOLVED');
    }
  }
  return {
    raceTimingPins: [...pins.values()].sort((a, b) =>
      a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : a.eventRevision - b.eventRevision,
    ),
    itemRaceTimingBindings: bindings.sort((a, b) =>
      a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0,
    ),
  };
}
/** Same-tx source capture and calculation. Caller must hold authenticated tenant
 * fences and current app processing admission. Returned data grants no write. */
export async function captureNutritionV4CalculationIn(
  tx: Transaction,
  unknownInput: unknown,
  mode: 'diagnostic_only' | 'approval_requires_resolved' = 'approval_requires_resolved',
) {
  assertNutritionV4PlainInput(unknownInput);
  const input = nutritionV4CalculationInputSchema.parse(unknownInput),
    { prior, size } = await priorHead(tx, input);
  const affected = deriveCalculationAffected(prior, input);
  await requireOrigins(tx, prior, input);
  const sources = await preparationSources(tx, input, addSize(bytes(input), size));
  const timing = selectTiming(prior, input, affected, sources, mode);
  return { input, prior, affected, sources, timing };
}
export interface NutritionRacePlanV4WriteOptions {
  readonly now?: () => Date;
  readonly id?: () => string;
}
function prepareWrite(unknownIntent: unknown) {
  assertNutritionV4PlainInput(unknownIntent);
  if (bytes(unknownIntent) > 524288) throw new NutritionRacePlanV4WriterError('NUTRITION_V4_LIMIT');
  const outer = saveNutritionPlanV4IntentSchema.parse(unknownIntent),
    intent = outer.intent,
    command = intent.command;
  const request = {
    operation: 'nutrition_plan_save',
    intentSchemaVersion: 4,
    ...command,
    expectedRaceHeads: intent.expectedRaceHeads,
    reconnectItemIds: intent.reconnectItemIds,
  };
  const key = `nutrition-plan:${command.idempotencyKey}`;
  return { outer, intent, command, request, key };
}
/** Same-tenant transaction seam for standalone SQL110 nutrition authority.
 * The caller owns transaction/fences and rollback. This grants no integrated
 * approval, affected-domain completeness or proposal applicability authority. */
export function saveNutritionPlanV4In(
  tx: Transaction,
  unknownIntent: unknown,
  options: NutritionRacePlanV4WriteOptions = {},
): Promise<NutritionRacePlanV4WriteResult> {
  return commitPreparedWrite(tx, prepareWrite(unknownIntent), options);
}
/** Explicit integrated race-only timing successor. Context identity is looked up
 * by SQL118 in this same transaction; callers cannot supply affected IDs/pins.
 * Standalone V4 writes retain their original preservation behavior. */
export async function saveNutritionPlanV4ForRaceApprovalIn(
  tx: Transaction,
  unknownIntent: unknown,
  applicationContextId: string,
  options: NutritionRacePlanV4WriteOptions = {},
): Promise<NutritionRacePlanV4WriteResult> {
  const prepared = prepareWrite(unknownIntent);
  const contextId = z.uuid().parse(applicationContextId).toLowerCase();
  return commitPreparedWrite(tx, prepared, options, contextId);
}
async function commitPreparedWrite(
  tx: Transaction,
  prepared: ReturnType<typeof prepareWrite>,
  { now = () => new Date(), id = randomUUID }: NutritionRacePlanV4WriteOptions,
  applicationContextId?: string,
): Promise<NutritionRacePlanV4WriteResult> {
  const { outer, intent, command, request, key } = prepared;
  await lockAppAdmission(tx);
  const replay = await originalReceipt(tx, key, request, command.planId);
  if (replay) return replay;
  await requireAppAdmission(tx);
  const calculation = calculationInput(intent);
  const { prior, size } = await priorHead(tx, calculation);
  const affected =
    applicationContextId === undefined
      ? deriveNutritionAffectedItemIdsV4(prior, intent)
      : await raceApprovalAffectedItems(tx, applicationContextId, prepared.request, prior, intent);
  await requireOrigins(tx, prior, calculation);
  const sources = await preparationSources(tx, calculation, addSize(bytes(outer), size));
  const timing = selectTiming(prior, calculation, affected, sources);
  const versionId = z.uuid().parse(id()).toLowerCase(),
    approvalId = z.uuid().parse(id()).toLowerCase();
  const saved = nutritionPlanVersionV4Schema.parse({
    ...command.draft,
    schemaVersion: 4,
    planId: prior.planId,
    versionId,
    version: prior.version + 1,
    previousVersionId: prior.versionId,
    approvalId,
    approvedAt: now().toISOString(),
    items: command.draft.items.map((item) => ({ ...item, planVersionId: versionId })),
    raceTimingPins: timing.raceTimingPins,
    itemRaceTimingBindings: timing.itemRaceTimingBindings,
  });
  addSize(sources.size, bytes(saved));
  const notices = frozenNotices(saved, sources.training);
  const changed = new Set(affected);
  if (
    notices.some((notice) => notice.code === 'UNRESOLVED_PRESERVED' && changed.has(notice.itemId))
  )
    throw new NutritionRacePlanV4WriterError('NUTRITION_V4_TIMING_UNRESOLVED');
  const committed = await tx.query(
    'SELECT public.commit_nutrition_plan_v4($1::uuid,$2::uuid,$3::jsonb,$4::jsonb) AS result',
    [prior.planId, prior.versionId, JSON.stringify(request), JSON.stringify(saved)],
  );
  if (committed.rows.length !== 1) return invalid();
  const reference = decode(receiptResult, committed.rows[0]?.['result']);
  if (
    !sameId(reference.planId, saved.planId) ||
    !sameId(reference.versionId, saved.versionId) ||
    reference.version !== saved.version ||
    !sameId(reference.approvalId, saved.approvalId)
  )
    return invalid();
  return { plan: saved, notices };
}
export function createNutritionRacePlanV4Writer(
  database: Database,
  { now = () => new Date(), id = randomUUID }: NutritionRacePlanV4WriteOptions = {},
): NutritionRacePlanV4Writer {
  return {
    savePlanV4(athleteId, unknownIntent) {
      const prepared = prepareWrite(unknownIntent);
      return database.tenant(athleteId, (tx) => commitPreparedWrite(tx, prepared, { now, id }));
    },
  };
}

async function raceApprovalAffectedItems(
  tx: Transaction,
  applicationContextId: string,
  request: unknown,
  prior: NutritionPlanVersionCompatibleV4,
  intent: SaveNutritionPlanV3Intent,
): Promise<readonly string[]> {
  const row = z
    .strictObject({ item_ids: z.array(z.string()).max(5000) })
    .parse(
      (
        await tx.query(
          'SELECT public.race_manual_nutrition_affected_items_v1($1::uuid,$2::jsonb) AS item_ids',
          [applicationContextId, JSON.stringify(request)],
        )
      ).rows[0],
    );
  const declared = new Set(intent.command.draft.items.map((item) => item.id));
  if (
    new Set(row.item_ids).size !== row.item_ids.length ||
    row.item_ids.some((id) => !declared.has(id))
  )
    return invalid();
  const preserved = z
    .strictObject({ item_ids: z.array(z.string()).max(5000) })
    .parse(
      (
        await tx.query(
          'SELECT public.race_manual_nutrition_preserved_items_v1($1::uuid,$2::jsonb) AS item_ids',
          [applicationContextId, JSON.stringify(request)],
        )
      ).rows[0],
    );
  const oldItems = new Map(prior.items.map((item) => [item.id, item]));
  if (
    new Set(preserved.item_ids).size !== preserved.item_ids.length ||
    preserved.item_ids.some((id) => {
      const anchor = oldItems.get(id)?.anchor;
      return (
        !declared.has(id) ||
        row.item_ids.includes(id) ||
        anchor?.kind !== 'relative' ||
        anchor.entity !== 'race'
      );
    })
  )
    return invalid();
  const preservedIds = new Set(preserved.item_ids);
  return [
    ...new Set([
      ...deriveNutritionAffectedItemIdsV4(prior, intent).filter((id) => !preservedIds.has(id)),
      ...row.item_ids,
    ]),
  ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
