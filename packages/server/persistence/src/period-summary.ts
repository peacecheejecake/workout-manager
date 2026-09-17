import { z } from 'zod';
import {
  periodSummaryQuerySchema,
  periodSummarySchema,
  type PeriodSummary,
  type PeriodSummaryQuery,
} from '@workout/contracts/period-summary';
import { dashboardActualSchema } from '@workout/contracts/dashboard';
import { planDraftSchema } from '@workout/contracts/planning';
import type { Database } from './database.js';
import { activityInstantSql } from './activity-calendar.js';
import { durationKinds } from './dashboard-metrics.js';
export interface PeriodSummaryRepository {
  read(athleteId: string, input: PeriodSummaryQuery): Promise<PeriodSummary | null>;
}
const metricSql = (column: string, condition = 'true') =>
  `jsonb_build_object('value',sum(${column}) FILTER(WHERE ${condition}),'knownCount',count(${column}) FILTER(WHERE ${condition}),'missingCount',count(*) FILTER(WHERE ${condition} AND ${column} IS NULL))`;
const aggregate = `jsonb_build_object('count',count(*),'distanceMeters',${metricSql('distance')},'durationSeconds',jsonb_build_object(${durationKinds.map((kind) => `'${kind}',${metricSql('duration', `duration_kind='${kind}'`)}`).join(',')}),'sources',jsonb_build_object('fit',count(*) FILTER(WHERE kind='fit'),'fixture',count(*) FILTER(WHERE kind='fixture'),'manual',count(*) FILTER(WHERE kind='manual')),'overlayCount',count(*) FILTER(WHERE overlaid))`;
// All interpolated fragments are fixed SQL; identifiers and periods from requests stay parameters.
const sql = `WITH plan AS MATERIALIZED (SELECT id,version,draft FROM plan_snapshot WHERE athlete_id=$1 AND id=$2),
 period AS MATERIALIZED (SELECT value AS item FROM plan CROSS JOIN LATERAL jsonb_array_elements(draft->'periods') WHERE value->>'id'=$3),
 canonical AS MATERIALIZED (SELECT id,revision,original,deleted FROM activity_canonical WHERE athlete_id=$1),
 effective AS MATERIALIZED (
 SELECT (${activityInstantSql("(CASE WHEN o.values_json ? 'startedAt' THEN o.values_json ELSE c.original END)->>'startedAt'")} AT TIME ZONE (p.item->>'timezone'))::date AS date,
 ((CASE WHEN o.values_json ? 'distanceMeters' THEN o.values_json ELSE c.original END)->>'distanceMeters')::numeric AS distance,
 ((CASE WHEN o.values_json ? 'durationSeconds' THEN o.values_json ELSE c.original END)->>'durationSeconds')::numeric AS duration,
 (CASE WHEN o.values_json ? 'durationSeconds' THEN o.values_json ELSE c.original END)->>'durationKind' AS duration_kind,
 s.kind,(o.activity_id IS NOT NULL AND c.revision>1) AS overlaid FROM canonical c
 JOIN activity_source_head s ON s.athlete_id=$1 AND s.activity_id=c.id LEFT JOIN activity_overlay o ON o.athlete_id=$1 AND o.activity_id=c.id CROSS JOIN period p WHERE NOT c.deleted
 ) SELECT (SELECT row_to_json(p) FROM plan p) AS plan,
 (SELECT version_id::text FROM plan_head WHERE athlete_id=$1) AS current_head,
 (SELECT ${aggregate} FROM effective WHERE date >= (SELECT CASE WHEN item->>'startDate' LIKE '0000-%' THEN NULL ELSE (item->>'startDate')::date END FROM period) AND date < (SELECT CASE WHEN item->>'endDateExclusive' LIKE '0000-%' THEN NULL ELSE (item->>'endDateExclusive')::date END FROM period)) AS actual,
 (SELECT jsonb_build_object('count',count(*),'revisionSum',coalesce(sum(revision),0)::text) FROM canonical) AS revisions,
 (SELECT count(*)::int FROM effective WHERE date IS NULL) AS unplaced,
 EXISTS(SELECT 1 FROM period WHERE item->>'startDate' LIKE '0000-%' OR item->>'endDateExclusive' LIKE '0000-%') AS unsupported`;
const rowSchema = z.object({
  plan: z.object({ id: z.uuid(), version: z.number().int(), draft: planDraftSchema }).nullable(),
  current_head: z.uuid().nullable(),
  actual: dashboardActualSchema,
  revisions: z.object({ count: z.number(), revisionSum: z.string() }),
  unplaced: z.number(),
  unsupported: z.boolean(),
});
const metric = (values: (number | null)[]) => {
  const known = values.filter((value): value is number => value !== null);
  return {
    value: known.length ? known.reduce((sum, value) => sum + value, 0) : null,
    knownCount: known.length,
    missingCount: values.length - known.length,
  };
};
export function createPeriodSummaryRepository(
  database: Database,
  { now = () => new Date() }: { now?: () => Date } = {},
): PeriodSummaryRepository {
  return {
    async read(athleteId, input) {
      const query = periodSummaryQuerySchema.parse(input);
      return database.tenant(athleteId, async (tx) => {
        const row = rowSchema.parse(
          (await tx.query(sql, [athleteId, query.planVersionId, query.periodId])).rows[0],
        );
        if (!row.plan) return null;
        const period = row.plan.draft.periods.find((item) => item.id === query.periodId);
        if (!period) return null;
        const descendants = new Set([period.id]);
        for (let depth = 0; depth < 3; depth++)
          for (const child of row.plan.draft.periods)
            if (child.parentId !== null && descendants.has(child.parentId))
              descendants.add(child.id);
        const sessions = row.plan.draft.sessions.filter((session) =>
          descendants.has(session.blockId),
        );
        const keySessions = sessions
          .filter((session) => session.priority === 'high')
          .sort((a, b) =>
            a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
          );
        return periodSummarySchema.parse({
          definitionVersion: 'period-summary-v1',
          observedAt: now().toISOString(),
          planVersion: { id: row.plan.id, version: row.plan.version, title: row.plan.draft.title },
          currentPlanVersionId: row.current_head,
          period,
          planned: {
            count: sessions.length,
            distanceMeters: metric(sessions.map((session) => session.distanceMeters)),
            durationSeconds: metric(sessions.map((session) => session.durationSeconds)),
          },
          keySessions,
          actual: row.unsupported
            ? { status: 'unavailable', reason: 'unsupported_calendar' }
            : { status: 'available', totals: row.actual },
          dataRevision: { activities: row.revisions },
          unplacedActivityCount: row.unplaced,
          coverage: 'unknown',
        });
      });
    },
  };
}
