import { z } from 'zod';

import { activityOverlaySchema, activityValuesSchema } from '@workout/contracts/activity';
import {
  integratedPlannerQuerySchema,
  integratedPlannerReadSchema,
  type IntegratedActivity,
  type IntegratedIntake,
  type IntegratedNutritionItem,
  type IntegratedPlannerQuery,
  type IntegratedPlannerRead,
  type IntegratedPlannerSummary,
  type UnresolvedNutritionItem,
} from '@workout/contracts/integrated-planner';
import {
  activeIntakeEntrySchema,
  nutritionPlanVersionSchema,
} from '@workout/contracts/nutrition-core';
import { planDraftSchema, sumTargetQuantities } from '@workout/contracts/planning';
import { timeZoneSchema } from '@workout/contracts/primitives';
import type { Database } from './database.js';
import { activityInstantSql } from './activity-calendar.js';

export interface IntegratedPlannerRepository {
  read(athleteId: string, query: IntegratedPlannerQuery): Promise<IntegratedPlannerRead>;
}

/** A response is complete or it fails; silently truncating actuals would corrupt totals. */
export class IntegratedPlannerLimitError extends Error {
  readonly code = 'PLANNER_RESULT_TOO_LARGE';
  constructor() {
    super('PLANNER_RESULT_TOO_LARGE');
  }
}

const maximumRows = 3000;
const maximumNutritionPlans = 20;
const activityTime = activityInstantSql(
  "(CASE WHEN o.values_json ? 'startedAt' THEN o.values_json ELSE c.original END)->>'startedAt'",
);
// One statement gives every domain the same PostgreSQL MVCC snapshot. Set logs are
// represented only by the detail flag on their canonical Activity, never a second actual.
const sql = `WITH current_plan AS MATERIALIZED (
  SELECT s.id,s.draft FROM plan_head h JOIN plan_snapshot s
    ON s.athlete_id=h.athlete_id AND s.id=h.version_id WHERE h.athlete_id=$1
), settings AS (SELECT coalesce((SELECT draft->>'timezone' FROM current_plan),$4::text) AS timezone
), nutrition AS MATERIALIZED (
  SELECT v.record_json FROM nutrition_plan_head h JOIN nutrition_plan_version v
    ON v.athlete_id=h.athlete_id AND v.version_id=h.version_id
  WHERE h.athlete_id=$1 AND v.period_from<$3::date AND v.period_to>=$2::date
  ORDER BY h.plan_id LIMIT ${maximumNutritionPlans + 1}
), linked_plans AS MATERIALIZED (
  SELECT s.id,s.draft FROM plan_snapshot s WHERE s.athlete_id=$1
    AND s.id IN (SELECT (record_json->>'linkedTrainingPlanVersionId')::uuid FROM nutrition
      WHERE record_json->>'linkedTrainingPlanVersionId' IS NOT NULL)
), activities AS MATERIALIZED (
  SELECT c.id,c.original,coalesce(o.values_json,'{}'::jsonb) AS overlay,
    (${activityTime} AT TIME ZONE settings.timezone)::date AS local_date,
    EXISTS(SELECT 1 FROM supplementary_execution e
      WHERE e.athlete_id=c.athlete_id AND e.activity_id=c.id) AS has_supplementary_detail
  FROM activity_canonical c JOIN activity_source_head s
    ON s.athlete_id=c.athlete_id AND s.activity_id=c.id
  LEFT JOIN activity_overlay o ON o.athlete_id=c.athlete_id AND o.activity_id=c.id
  CROSS JOIN settings
  WHERE c.athlete_id=$1 AND NOT c.deleted
), visible_activities AS (
  SELECT * FROM activities WHERE local_date >= $2::date AND local_date < $3::date
  ORDER BY local_date,id LIMIT ${maximumRows + 1}
), intakes AS MATERIALIZED (
  SELECT (r.occurred_at AT TIME ZONE settings.timezone)::date AS local_date,r.record_json
  FROM intake_entry e JOIN intake_entry_revision r
    ON r.athlete_id=e.athlete_id AND r.intake_id=e.id AND r.revision=e.current_revision
  CROSS JOIN settings
  WHERE e.athlete_id=$1 AND e.status='active' AND r.status='active'
    AND (r.occurred_at AT TIME ZONE settings.timezone)::date >= $2::date
    AND (r.occurred_at AT TIME ZONE settings.timezone)::date < $3::date
  ORDER BY r.occurred_at,e.id LIMIT ${maximumRows + 1}
)
SELECT
  (SELECT jsonb_build_object('id',id,'draft',draft) FROM current_plan) AS plan,
  (SELECT timezone FROM settings) AS timezone,
  (SELECT coalesce(jsonb_agg(record_json ORDER BY record_json->>'planId'),'[]'::jsonb) FROM nutrition) AS nutrition,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'original',original,'overlay',overlay,
    'date',local_date::text,'hasDetail',has_supplementary_detail) ORDER BY local_date,id),'[]'::jsonb)
    FROM visible_activities) AS activities,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('date',local_date::text,'record',record_json)
    ORDER BY local_date,record_json->>'occurredAt',record_json->>'intakeId'),'[]'::jsonb)
    FROM intakes) AS intakes,
  (SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'draft',draft) ORDER BY id),'[]'::jsonb)
    FROM linked_plans) AS linked_plans,
  (SELECT count(*)::int FROM activities WHERE local_date IS NULL) AS unplaced_count`;

const planRow = z.strictObject({ id: z.uuid(), draft: planDraftSchema });
const rowSchema = z.object({
  plan: planRow.nullable(),
  timezone: timeZoneSchema,
  nutrition: z.array(nutritionPlanVersionSchema),
  activities: z.array(
    z.strictObject({
      id: z.uuid(),
      original: activityValuesSchema,
      overlay: activityOverlaySchema,
      date: z.iso.date(),
      hasDetail: z.boolean(),
    }),
  ),
  intakes: z.array(z.strictObject({ date: z.iso.date(), record: activeIntakeEntrySchema })),
  linked_plans: z.array(planRow),
  unplaced_count: z.number().int().nonnegative(),
});

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const metric = (values: readonly (number | null)[]) => {
  const known = values.filter((value): value is number => value !== null);
  return {
    value: known.length ? sumTargetQuantities(known) : null,
    knownCount: known.length,
    missingCount: values.length - known.length,
  };
};
function summary(
  plannedSessions: { sport: string }[],
  nutritionItems: IntegratedNutritionItem[],
  activities: IntegratedActivity[],
  intakes: IntegratedIntake[],
): IntegratedPlannerSummary {
  const nutrient = (key: keyof IntegratedIntake['nutrientTotal']) =>
    metric(intakes.map((intake) => intake.nutrientTotal[key].value));
  const duration = (kind: IntegratedActivity['durationKind']) =>
    metric(
      activities
        .filter((activity) => activity.durationKind === kind)
        .map((activity) => activity.durationSeconds),
    );
  return {
    training: {
      plannedSessionCount: plannedSessions.length,
      actualActivityCount: activities.length,
      supplementaryActivityCount: activities.filter((activity) => activity.hasSupplementaryDetail)
        .length,
      distanceMeters: metric(activities.map((activity) => activity.distanceMeters)),
      durationSeconds: {
        timer: duration('timer'),
        elapsed: duration('elapsed'),
        moving: duration('moving'),
        unknown: duration('unknown'),
      },
    },
    nutrition: {
      plannedItemCount: nutritionItems.length,
      intakeCount: intakes.length,
      nutrients: {
        energyKcal: nutrient('energy'),
        carbohydrateGrams: nutrient('carbohydrate'),
        proteinGrams: nutrient('protein'),
        fatGrams: nutrient('fat'),
        fluidMl: nutrient('fluid'),
        sodiumMg: nutrient('sodium'),
      },
      intakeCoverage: 'unknown',
    },
  };
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string) {
  let format = formatterCache.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timezone, format);
  }
  return format;
}
function localParts(instant: number, timezone: string) {
  const parts = Object.fromEntries(
    formatter(timezone)
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts['year']?.padStart(4, '0')}-${parts['month']}-${parts['day']}`,
    time: `${parts['hour']}:${parts['minute']}:${parts['second']}`,
  };
}
/** Reject nonexistent/ambiguous wall times instead of silently picking a DST offset. */
function localInstant(date: string, time: string, timezone: string): number | null {
  const target = Date.parse(`${date}T${time.length === 5 ? `${time}:00` : time}Z`);
  if (!Number.isFinite(target)) return null;
  const offsets = new Set<number>();
  for (const sample of [target - 86_400_000, target, target + 86_400_000]) {
    const local = localParts(sample, timezone);
    offsets.add(Date.parse(`${local.date}T${local.time}Z`) - sample);
  }
  const matching = [...offsets]
    .map((offset) => target - offset)
    .filter((candidate) => {
      const local = localParts(candidate, timezone);
      return local.date === date && local.time === (time.length === 5 ? `${time}:00` : time);
    });
  return matching.length === 1 ? (matching[0] ?? null) : null;
}

function projectNutritionItem(
  item: z.infer<typeof nutritionPlanVersionSchema>['items'][number],
  plan: z.infer<typeof nutritionPlanVersionSchema>,
  linked: Map<string, z.infer<typeof planDraftSchema>>,
  timezone: string,
): { date: string; value: IntegratedNutritionItem } | UnresolvedNutritionItem {
  const base = {
    id: item.id,
    planVersionId: item.planVersionId,
    title: item.title,
    category: item.category,
    source: item.source,
  };
  const unresolved = (reason: UnresolvedNutritionItem['reason']) => ({ ...base, reason });
  if (item.anchor.kind === 'absolute') {
    if (item.anchor.timezone === timezone)
      return { date: item.anchor.date, value: { ...base, localTime: item.anchor.localTime } };
    if (item.anchor.localTime === null) return unresolved('timezone_mismatch');
    const instant = localInstant(item.anchor.date, item.anchor.localTime, item.anchor.timezone);
    if (instant === null) return unresolved('ambiguous_local_time');
    const local = localParts(instant, timezone);
    return { date: local.date, value: { ...base, localTime: local.time } };
  }
  if (item.anchor.entity !== 'session' || plan.linkedTrainingPlanVersionId === null)
    return unresolved('missing_anchor');
  const anchor = item.anchor;
  const session = linked
    .get(plan.linkedTrainingPlanVersionId)
    ?.sessions.find((candidate) => candidate.id === anchor.entityId);
  const training = linked.get(plan.linkedTrainingPlanVersionId);
  if (!session || !training) return unresolved('missing_anchor');
  if (session.localStartTime === null) return unresolved('missing_session_time');
  const start = localInstant(session.date, session.localStartTime, training.timezone);
  if (start === null) return unresolved('ambiguous_local_time');
  if (anchor.point === 'end' && session.durationSeconds === null)
    return unresolved('missing_session_duration');
  const anchored =
    start +
    (anchor.point === 'end' ? (session.durationSeconds ?? 0) * 1000 : 0) +
    anchor.offsetMinutes * 60_000;
  if (!Number.isFinite(anchored) || Math.abs(anchored) > 8_640_000_000_000_000)
    return unresolved('offset_out_of_range');
  const local = localParts(anchored, timezone);
  return { date: local.date, value: { ...base, localTime: local.time } };
}

export function createIntegratedPlannerRepository(database: Database): IntegratedPlannerRepository {
  return {
    async read(athleteId, input) {
      const query = integratedPlannerQuerySchema.parse(input);
      return database.tenant(athleteId, async (tx) => {
        const row = rowSchema.parse(
          (await tx.query(sql, [athleteId, query.from, query.toExclusive, query.timezone])).rows[0],
        );
        if (
          row.nutrition.length > maximumNutritionPlans ||
          row.activities.length > maximumRows ||
          row.intakes.length > maximumRows ||
          row.nutrition.reduce((total, plan) => total + plan.items.length, 0) > maximumRows
        )
          throw new IntegratedPlannerLimitError();

        const linked = new Map(row.linked_plans.map((plan) => [plan.id, plan.draft]));
        const days = new Map<
          string,
          {
            plannedSessions: z.infer<typeof planDraftSchema>['sessions'];
            nutritionItems: IntegratedNutritionItem[];
            activities: IntegratedActivity[];
            intakes: IntegratedIntake[];
          }
        >();
        for (
          let value = Date.parse(`${query.from}T00:00:00Z`);
          value < Date.parse(`${query.toExclusive}T00:00:00Z`);
          value += 86_400_000
        ) {
          days.set(new Date(value).toISOString().slice(0, 10), {
            plannedSessions: [],
            nutritionItems: [],
            activities: [],
            intakes: [],
          });
        }
        for (const session of row.plan?.draft.sessions ?? [])
          days.get(session.date)?.plannedSessions.push(session);
        const unresolvedNutritionItems: UnresolvedNutritionItem[] = [];
        for (const plan of row.nutrition)
          for (const item of plan.items) {
            const projection = projectNutritionItem(item, plan, linked, row.timezone);
            if ('reason' in projection) unresolvedNutritionItems.push(projection);
            else days.get(projection.date)?.nutritionItems.push(projection.value);
          }
        for (const record of row.activities) {
          const original = record.original;
          const overlay = record.overlay;
          const startedAt =
            overlay.startedAt === undefined ? original.startedAt : overlay.startedAt;
          if (startedAt === null) continue;
          days.get(record.date)?.activities.push({
            activityId: record.id,
            kind: overlay.kind ?? original.kind,
            title: overlay.title === undefined ? original.title : overlay.title,
            startedAt,
            distanceMeters:
              overlay.distanceMeters === undefined
                ? original.distanceMeters
                : overlay.distanceMeters,
            durationSeconds:
              overlay.durationSeconds === undefined
                ? original.durationSeconds
                : overlay.durationSeconds,
            durationKind:
              overlay.durationKind === undefined ? original.durationKind : overlay.durationKind,
            hasSupplementaryDetail: record.hasDetail,
          });
        }
        for (const item of row.intakes)
          days.get(item.date)?.intakes.push({
            intakeId: item.record.intakeId,
            revision: item.record.revision,
            occurredAt: item.record.occurredAt,
            nutrientTotal: item.record.nutrientTotal,
          });
        const projectedDays = [...days].map(([date, data]) => {
          data.plannedSessions.sort(
            (a, b) =>
              compare(a.localStartTime ?? '', b.localStartTime ?? '') || compare(a.id, b.id),
          );
          data.nutritionItems.sort(
            (a, b) =>
              compare(a.localTime ?? '', b.localTime ?? '') ||
              compare(a.planVersionId, b.planVersionId) ||
              compare(a.id, b.id),
          );
          data.activities.sort(
            (a, b) =>
              Date.parse(a.startedAt) - Date.parse(b.startedAt) ||
              compare(a.activityId, b.activityId),
          );
          data.intakes.sort(
            (a, b) =>
              Date.parse(a.occurredAt) - Date.parse(b.occurredAt) ||
              compare(a.intakeId, b.intakeId),
          );
          return {
            date,
            ...data,
            summary: summary(
              data.plannedSessions,
              data.nutritionItems,
              data.activities,
              data.intakes,
            ),
          };
        });
        unresolvedNutritionItems.sort(
          (a, b) => compare(a.planVersionId, b.planVersionId) || compare(a.id, b.id),
        );
        return integratedPlannerReadSchema.parse({
          schemaVersion: 1,
          from: query.from,
          toExclusive: query.toExclusive,
          timezone: row.timezone,
          trainingPlanVersionId: row.plan?.id ?? null,
          nutritionPlanVersionIds: row.nutrition.map((plan) => plan.versionId),
          days: projectedDays,
          unresolvedNutritionItems,
          unplacedActivityCount: row.unplaced_count,
          summary: summary(
            projectedDays.flatMap((day) => day.plannedSessions),
            projectedDays.flatMap((day) => day.nutritionItems),
            projectedDays.flatMap((day) => day.activities),
            projectedDays.flatMap((day) => day.intakes),
          ),
        });
      });
    },
  };
}
