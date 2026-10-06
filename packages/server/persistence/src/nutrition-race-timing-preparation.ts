import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  saveNutritionPlanV2IntentSchema,
  nutritionPlanVersionCompatibleSchema,
  type NutritionPlanVersionCompatible,
} from '@workout/contracts/nutrition-race-plan-v2';
import {
  nutritionRaceTimingRosterSchema,
  type NutritionRaceTimingRoster,
  type ItemRaceTimingBinding,
  type RaceTimingPinV1,
} from '@workout/contracts/nutrition-race-timing';
import { planDraftSchema } from '@workout/contracts/planning';
import { localInstant } from './integrated-planner.js';
import {
  captureRaceTimingPins,
  RaceTimingBindingError,
  type RaceTimingQueryPort,
} from './race-timing-bindings.js';

export class NutritionTimingPreparationError extends Error {
  constructor(
    readonly code:
      | 'NUTRITION_TIMING_INVALID_INPUT'
      | 'NUTRITION_TIMING_INVALID_SOURCE'
      | 'NUTRITION_TIMING_UNAVAILABLE'
      | 'NUTRITION_TIMING_TENANT_MISMATCH'
      | 'NUTRITION_TIMING_LIMIT',
  ) {
    super(code);
  }
}
type Block = {
  itemId: string | null;
  code:
    | 'PRIOR_HEAD_STALE'
    | 'PRIOR_UNAVAILABLE'
    | 'SESSION_REFERENCE_INVALID'
    | 'TIMING_UNRESOLVED'
    | 'PRIOR_TIMING_STALE'
    | RaceTimingBindingError['code'];
};
type Notice = { itemId: string; code: 'LEGACY_UNPINNED_PRESERVED' | 'UNRESOLVED_PRESERVED' };
type Boundary = { storage: 'not_persisted'; approvalAllowed: false; fullApproval: false };
export type NutritionTimingPreparation = Boundary &
  (
    | { status: 'blocked'; blocks: readonly Block[]; notices: readonly Notice[] }
    | { status: 'prepared'; timingRoster: NutritionRaceTimingRoster; notices: readonly Notice[] }
  );
const boundary: Boundary = {
  storage: 'not_persisted',
  approvalAllowed: false,
  fullApproval: false,
};
const uuid = z.uuid().refine((id) => id === id.toLowerCase());
const affectedSchema = z
  .array(z.string().min(1).max(128))
  .max(5000)
  .superRefine((ids, context) => {
    for (let index = 1; index < ids.length; index++)
      if ((ids[index - 1] ?? '') >= (ids[index] ?? ''))
        context.addIssue({ code: 'custom', message: 'Expected sorted unique affected IDs' });
  });
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined)
      throw new NutritionTimingPreparationError('NUTRITION_TIMING_INVALID_SOURCE');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`)
    .join(',')}}`;
}
async function query(tx: RaceTimingQueryPort, sql: string, parameters?: unknown[]) {
  try {
    return await tx.query(sql, parameters);
  } catch {
    throw new NutritionTimingPreparationError('NUTRITION_TIMING_UNAVAILABLE');
  }
}
function decode<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success || canonical(parsed.data) !== canonical(value))
    throw new NutritionTimingPreparationError('NUTRITION_TIMING_INVALID_SOURCE');
  return parsed.data;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function blocked(blocks: Block[], notices: Notice[] = []): NutritionTimingPreparation {
  return Object.freeze({
    ...boundary,
    status: 'blocked',
    blocks: Object.freeze(blocks.map((x) => Object.freeze(x))),
    notices: Object.freeze(notices.map((x) => Object.freeze(x))),
  });
}
/** Read-only preparation. Caller supplies authenticated Transaction, holds
 * global→lifecycle77206→tenant0, and owns server-side affected-item analysis.
 * That analysis is not supplied in the browser command and does not establish a
 * complete approval manifest. No commands, records, jobs or permissions written. */
export async function prepareNutritionRaceTimingIn(
  tx: RaceTimingQueryPort,
  unknownIntent: unknown,
  serverAffectedItemIds: unknown,
): Promise<NutritionTimingPreparation> {
  const input = saveNutritionPlanV2IntentSchema.safeParse(unknownIntent);
  const influence = affectedSchema.safeParse(serverAffectedItemIds);
  if (!input.success || !influence.success)
    throw new NutritionTimingPreparationError('NUTRITION_TIMING_INVALID_INPUT');
  const intent = input.data;
  const draft = intent.command.draft;
  const affected = new Set(influence.data);
  const itemIds = new Set(draft.items.map((item) => item.id));
  if ([...affected].some((id) => !itemIds.has(id)))
    throw new NutritionTimingPreparationError('NUTRITION_TIMING_INVALID_INPUT');
  const scope = await query(
    tx,
    "SELECT nullif(current_setting('app.athlete_id',true),'') AS athlete_id",
  );
  if (scope.rows.length !== 1 || scope.rows[0]?.['athlete_id'] !== tx.athleteId)
    throw new NutritionTimingPreparationError('NUTRITION_TIMING_TENANT_MISMATCH');
  let prior: NutritionPlanVersionCompatible | null = null;
  let bodyBytes = 0;
  if (intent.command.kind === 'update') {
    const headResult = await query(
      tx,
      `SELECT h.version,h.version_id,v.version_id AS exact_version_id,
      coalesce(octet_length(v.record_json::text),0)::text AS bytes
      FROM nutrition_plan_head h LEFT JOIN nutrition_plan_version v
      ON v.athlete_id=h.athlete_id AND v.plan_id=h.plan_id AND v.version_id=h.version_id AND v.version=h.version
      WHERE h.athlete_id=$1 AND h.plan_id=$2`,
      [tx.athleteId, intent.command.planId],
    );
    if (headResult.rows.length === 0) return blocked([{ itemId: null, code: 'PRIOR_UNAVAILABLE' }]);
    if (headResult.rows.length !== 1)
      throw new NutritionTimingPreparationError('NUTRITION_TIMING_INVALID_SOURCE');
    const head = decode(
      z.strictObject({
        version: z.number().int().positive(),
        version_id: uuid,
        exact_version_id: uuid.nullable(),
        bytes: z.string().regex(/^\d+$/),
      }),
      headResult.rows[0],
    );
    if (head.version_id !== intent.command.expectedHeadVersionId)
      return blocked([{ itemId: null, code: 'PRIOR_HEAD_STALE' }]);
    if (head.exact_version_id === null)
      return blocked([{ itemId: null, code: 'PRIOR_UNAVAILABLE' }]);
    bodyBytes = Number(head.bytes);
    if (bodyBytes > 512 * 1024) throw new NutritionTimingPreparationError('NUTRITION_TIMING_LIMIT');
    const found = await query(
      tx,
      'SELECT record_json FROM nutrition_plan_version WHERE athlete_id=$1 AND plan_id=$2 AND version_id=$3',
      [tx.athleteId, intent.command.planId, head.version_id],
    );
    if (found.rows.length !== 1) return blocked([{ itemId: null, code: 'PRIOR_UNAVAILABLE' }]);
    prior = decode(nutritionPlanVersionCompatibleSchema, found.rows[0]?.['record_json']);
    if (
      prior.planId !== intent.command.planId ||
      prior.versionId !== head.version_id ||
      prior.version !== head.version
    )
      throw new NutritionTimingPreparationError('NUTRITION_TIMING_INVALID_SOURCE');
  }
  const blocks: Block[] = [];
  const notices: Notice[] = [];
  const sessions = new Map<string, z.infer<typeof planDraftSchema>['sessions'][number]>();
  let training: z.infer<typeof planDraftSchema> | null = null;
  if (draft.linkedTrainingPlanVersionId !== null) {
    const sizes = await query(
      tx,
      'SELECT octet_length(draft::text)::text AS bytes FROM plan_snapshot WHERE athlete_id=$1 AND id=$2',
      [tx.athleteId, draft.linkedTrainingPlanVersionId],
    );
    if (sizes.rows.length !== 1)
      return blocked([{ itemId: null, code: 'SESSION_REFERENCE_INVALID' }]);
    const size = decode(z.strictObject({ bytes: z.string().regex(/^\d+$/) }), sizes.rows[0]);
    if (Number(size.bytes) + bodyBytes > 4 * 1024 * 1024)
      throw new NutritionTimingPreparationError('NUTRITION_TIMING_LIMIT');
    bodyBytes += Number(size.bytes);
    const plans = await query(tx, 'SELECT draft FROM plan_snapshot WHERE athlete_id=$1 AND id=$2', [
      tx.athleteId,
      draft.linkedTrainingPlanVersionId,
    ]);
    if (plans.rows.length !== 1)
      return blocked([{ itemId: null, code: 'SESSION_REFERENCE_INVALID' }]);
    training = decode(planDraftSchema, plans.rows[0]?.['draft']);
    for (const session of training.sessions) sessions.set(session.id, session);
  }
  if (intent.expectedRaceHeads.length) {
    const totals = await query(
      tx,
      `SELECT coalesce(sum(octet_length(h.values_json::text) + coalesce(octet_length(v.values_json::text),0) + 1024),0)::text AS bytes
      FROM race_event h LEFT JOIN race_event_revision v
      ON v.athlete_id=h.athlete_id AND v.entity_id=h.id AND v.revision=(SELECT expected.revision FROM unnest($2::uuid[],$3::integer[]) expected(id,revision) WHERE expected.id=h.id)
      WHERE h.athlete_id=$1 AND h.id=ANY($2::uuid[]) AND NOT h.deleted`,
      [
        tx.athleteId,
        intent.expectedRaceHeads.map((head) => head.eventId),
        intent.expectedRaceHeads.map((head) => head.revision),
      ],
    );
    if (totals.rows.length !== 1)
      throw new NutritionTimingPreparationError('NUTRITION_TIMING_INVALID_SOURCE');
    const total = decode(z.strictObject({ bytes: z.string().regex(/^\d+$/) }), totals.rows[0]);
    if (Number(total.bytes) + bodyBytes > 4 * 1024 * 1024)
      throw new NutritionTimingPreparationError('NUTRITION_TIMING_LIMIT');
  }
  let captured: readonly RaceTimingPinV1[];
  try {
    captured = await captureRaceTimingPins(tx, intent.expectedRaceHeads);
  } catch (error) {
    if (error instanceof RaceTimingBindingError)
      return blocked([{ itemId: null, code: error.code }]);
    throw error;
  }
  const currentPins = new Map(captured.map((pin) => [pin.eventId, pin]));
  const outputPins = new Map<string, RaceTimingPinV1>();
  const bindings: ItemRaceTimingBinding[] = [];
  const previousItems = new Map(prior?.items.map((item) => [item.id, item]) ?? []);
  for (const item of draft.items) {
    if (item.anchor.kind !== 'relative') continue;
    const previous = previousItems.get(item.id);
    const priorContent = previous
      ? Object.fromEntries(Object.entries(previous).filter(([key]) => key !== 'planVersionId'))
      : null;
    const unchanged =
      prior !== null &&
      prior.linkedTrainingPlanVersionId === draft.linkedTrainingPlanVersionId &&
      prior.timezone === draft.timezone &&
      canonical(prior.period) === canonical(draft.period) &&
      priorContent !== null &&
      canonical(priorContent) === canonical(item);
    const preserve = unchanged && !affected.has(item.id);
    if (item.anchor.entity === 'session') {
      const session = sessions.get(item.anchor.entityId);
      if (!session || !training) {
        blocks.push({ itemId: item.id, code: 'SESSION_REFERENCE_INVALID' });
        continue;
      }
      const unresolved =
        session.localStartTime === null ||
        localInstant(session.date, session.localStartTime, training.timezone) === null ||
        (item.anchor.point === 'end' && session.durationSeconds === null);
      if (unresolved) {
        if (preserve) notices.push({ itemId: item.id, code: 'UNRESOLVED_PRESERVED' });
        else blocks.push({ itemId: item.id, code: 'TIMING_UNRESOLVED' });
      }
      continue;
    }
    const fresh = currentPins.get(item.anchor.entityId);
    if (!fresh) throw new NutritionTimingPreparationError('NUTRITION_TIMING_INVALID_SOURCE');
    let selected = fresh;
    const priorBinding =
      prior && 'schemaVersion' in prior
        ? prior.itemRaceTimingBindings.find((x) => x.itemId === item.id)?.binding
        : undefined;
    if (preserve && (!priorBinding || priorBinding.state === 'legacy_unpinned')) {
      if (!prior) throw new NutritionTimingPreparationError('NUTRITION_TIMING_INVALID_SOURCE');
      bindings.push({
        itemId: item.id,
        binding: {
          state: 'legacy_unpinned',
          priorNutritionVersionId: prior.versionId,
          priorItemId: item.id,
          priorAnchorDigest: createHash('sha256')
            .update(
              canonical({ domain: 'nutrition-anchor-canonical-v1', anchor: previous?.anchor }),
              'utf8',
            )
            .digest('hex'),
        },
      });
      notices.push({ itemId: item.id, code: 'LEGACY_UNPINNED_PRESERVED' });
      if (item.anchor.point === 'end' || fresh.start.state === 'unknown')
        notices.push({ itemId: item.id, code: 'UNRESOLVED_PRESERVED' });
      continue;
    }
    if (preserve && priorBinding?.state === 'captured' && prior && 'schemaVersion' in prior) {
      const original = prior.raceTimingPins.find(
        (pin) =>
          pin.eventId === priorBinding.eventId && pin.eventRevision === priorBinding.eventRevision,
      );
      if (!original) throw new NutritionTimingPreparationError('NUTRITION_TIMING_INVALID_SOURCE');
      selected = original;
      if (canonical(original) !== canonical(fresh))
        blocks.push({ itemId: item.id, code: 'PRIOR_TIMING_STALE' });
    }
    const existing = outputPins.get(selected.eventId);
    if (existing && canonical(existing) !== canonical(selected)) {
      blocks.push({ itemId: item.id, code: 'PRIOR_TIMING_STALE' });
      continue;
    }
    outputPins.set(selected.eventId, selected);
    bindings.push({
      itemId: item.id,
      binding: {
        state: 'captured',
        eventId: selected.eventId,
        eventRevision: selected.eventRevision,
      },
    });
    const unresolved = item.anchor.point === 'end' || selected.start.state === 'unknown';
    if (unresolved) {
      if (preserve) notices.push({ itemId: item.id, code: 'UNRESOLVED_PRESERVED' });
      else blocks.push({ itemId: item.id, code: 'TIMING_UNRESOLVED' });
    }
  }
  if (blocks.length) return blocked(blocks, notices);
  const rosterResult = nutritionRaceTimingRosterSchema.safeParse({
    items: draft.items.map((item) => ({ itemId: item.id, anchor: item.anchor })),
    raceTimingPins: [...outputPins.values()].sort((a, b) =>
      a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0,
    ),
    itemRaceTimingBindings: bindings.sort((a, b) =>
      a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0,
    ),
  });
  if (!rosterResult.success) throw new NutritionTimingPreparationError('NUTRITION_TIMING_LIMIT');
  const timingRoster = rosterResult.data;
  freeze(timingRoster);
  Object.freeze(timingRoster.raceTimingPins);
  Object.freeze(timingRoster.itemRaceTimingBindings);
  Object.freeze(timingRoster.items);
  Object.freeze(timingRoster);
  return Object.freeze({
    ...boundary,
    status: 'prepared',
    timingRoster,
    notices: Object.freeze(notices.map((x) => Object.freeze(x))),
  });
}
