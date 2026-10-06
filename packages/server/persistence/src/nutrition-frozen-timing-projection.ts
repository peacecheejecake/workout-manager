import { z } from 'zod';
import { nutritionPlanVersionCompatibleSchema } from '@workout/contracts/nutrition-race-plan-v2';
import { planDraftSchema } from '@workout/contracts/planning';
import { idSchema, timeZoneSchema, localDateSchema } from '@workout/contracts/primitives';
import {
  integratedNutritionItemSchema,
  unresolvedNutritionItemSchema,
  type UnresolvedNutritionItem,
} from '@workout/contracts/integrated-planner';
import { projectNutritionItem, localInstant } from './integrated-planner.js';

const inputSchema = z.strictObject({
  record: nutritionPlanVersionCompatibleSchema,
  itemId: idSchema.max(128),
  targetTimezone: timeZoneSchema,
  linkedTraining: z.strictObject({ versionId: z.uuid(), draft: planDraftSchema }).nullable(),
  // This is a caller-owned visibility fact, not a permission or deletion policy.
  // The function has no ability to authenticate a source or establish this fact.
  raceSourceVisibility: z.enum(['available', 'unknown', 'unavailable']),
});
const projectedSchema = z.strictObject({
  date: localDateSchema,
  value: integratedNutritionItemSchema,
});
type Detail =
  | 'legacy_unpinned'
  | 'source_visibility_unknown'
  | 'source_unavailable'
  | 'race_end_unknown'
  | 'start_unknown'
  | 'ambiguous_local_time'
  | 'offset_out_of_range'
  | 'existing_projection_unresolved';
type Boundary = { storage: 'not_persisted'; approvalAllowed: false };
export type FrozenNutritionProjection = Boundary &
  (
    | { status: 'projected'; projection: z.infer<typeof projectedSchema> }
    | { status: 'unresolved'; item: UnresolvedNutritionItem; detail: Detail }
  );
export class FrozenNutritionProjectionError extends Error {
  readonly code = 'NUTRITION_FROZEN_TIMING_INVALID_INPUT';
  constructor() {
    super('NUTRITION_FROZEN_TIMING_INVALID_INPUT');
  }
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Pure calculation only. Exact linked historical training and visibility facts
 * must be established by the caller. No mutable race input, query, storage,
 * approval or source-availability authority is exposed. Ordinary historical
 * readers/three writers are not integrated by this preparation port. */
export function projectFrozenNutritionTiming(unknownInput: unknown): FrozenNutritionProjection {
  const parsed = inputSchema.safeParse(unknownInput);
  if (!parsed.success) throw new FrozenNutritionProjectionError();
  const input = parsed.data,
    record = input.record;
  const item = record.items.find((entry) => entry.id === input.itemId);
  if (!item) throw new FrozenNutritionProjectionError();
  if (
    input.linkedTraining !== null &&
    input.linkedTraining.versionId !== record.linkedTrainingPlanVersionId
  )
    throw new FrozenNutritionProjectionError();
  const unresolved = (
    detail: Detail,
    reason: UnresolvedNutritionItem['reason'] = 'missing_anchor',
  ): FrozenNutritionProjection =>
    freeze({
      storage: 'not_persisted',
      approvalAllowed: false,
      status: 'unresolved',
      item: unresolvedNutritionItemSchema.parse({
        id: item.id,
        planVersionId: item.planVersionId,
        title: item.title,
        category: item.category,
        source: item.source,
        reason,
      }),
      detail,
    });
  if (item.anchor.kind !== 'relative' || item.anchor.entity === 'session') {
    const linked = new Map<string, z.infer<typeof planDraftSchema>>();
    if (input.linkedTraining)
      linked.set(input.linkedTraining.versionId, input.linkedTraining.draft);
    const result = projectNutritionItem(item, record, linked, input.targetTimezone);
    if ('reason' in result)
      return freeze({
        storage: 'not_persisted',
        approvalAllowed: false,
        status: 'unresolved',
        item: result,
        detail: 'existing_projection_unresolved',
      });
    return freeze({
      storage: 'not_persisted',
      approvalAllowed: false,
      status: 'projected',
      projection: projectedSchema.parse(result),
    });
  }
  if (!('schemaVersion' in record)) return unresolved('legacy_unpinned');
  const binding = record.itemRaceTimingBindings.find((entry) => entry.itemId === item.id)?.binding;
  if (!binding || binding.state === 'legacy_unpinned') return unresolved('legacy_unpinned');
  if (input.raceSourceVisibility === 'unknown') return unresolved('source_visibility_unknown');
  if (input.raceSourceVisibility === 'unavailable') return unresolved('source_unavailable');
  const pin = record.raceTimingPins.find(
    (entry) => entry.eventId === binding.eventId && entry.eventRevision === binding.eventRevision,
  );
  if (!pin) throw new FrozenNutritionProjectionError();
  if (item.anchor.point === 'end') return unresolved('race_end_unknown');
  if (pin.start.state === 'unknown')
    return unresolved(
      'start_unknown',
      pin.start.reason === 'ambiguous_local_time' ? 'ambiguous_local_time' : 'missing_session_time',
    );
  if (pin.localStartTime === null) return unresolved('start_unknown');
  const unique = localInstant(pin.localDate, pin.localStartTime, pin.timezone);
  const saved = Date.parse(pin.start.instant);
  if (unique === null || unique !== saved)
    return unresolved('ambiguous_local_time', 'ambiguous_local_time');
  const instant = saved + item.anchor.offsetMinutes * 60_000;
  if (!Number.isFinite(instant) || Math.abs(instant) > 8_640_000_000_000_000)
    return unresolved('offset_out_of_range', 'offset_out_of_range');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: input.targetTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const part = (name: string) => parts.find((entry) => entry.type === name)?.value;
  const projection = projectedSchema.safeParse({
    date: `${part('year')?.padStart(4, '0')}-${part('month')}-${part('day')}`,
    value: {
      id: item.id,
      planVersionId: item.planVersionId,
      title: item.title,
      category: item.category,
      source: item.source,
      localTime: `${part('hour')}:${part('minute')}:${part('second')}`,
    },
  });
  if (!projection.success) return unresolved('offset_out_of_range', 'offset_out_of_range');
  return freeze({
    storage: 'not_persisted',
    approvalAllowed: false,
    status: 'projected',
    projection: projection.data,
  });
}
