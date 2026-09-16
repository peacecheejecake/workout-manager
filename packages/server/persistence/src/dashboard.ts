import { z } from 'zod';
import {
  dashboardQuerySchema,
  dashboardReadModelSchema,
  dashboardDaySchema,
  shiftDashboardDate,
  type DashboardQuery,
  type DashboardReadModel,
} from '@workout/contracts/dashboard';
import { planDraftSchema } from '@workout/contracts/planning';
import { checkInSchema } from '@workout/contracts/check-ins';
import type { Database } from './database.js';
import { durationKinds, emptyActual, emptyPlanned, summarizeDays } from './dashboard-metrics.js';
export interface DashboardRepository {
  read(athleteId: string, input: DashboardQuery): Promise<DashboardReadModel>;
}
// Only fixed identifiers and enum literals are interpolated; all request values are parameters.
function metricSql(column: string, condition = 'true') {
  return `jsonb_build_object('value',sum(${column}) FILTER(WHERE ${condition}),'knownCount',count(${column}) FILTER(WHERE ${condition}),'missingCount',count(*) FILTER(WHERE ${condition} AND ${column} IS NULL))`;
}
const actualSql = `jsonb_build_object('count',count(*),'distanceMeters',${metricSql('distance')},'durationSeconds',jsonb_build_object(${durationKinds.map((kind) => `'${kind}',${metricSql('duration', `duration_kind='${kind}'`)}`).join(',')}),'sources',jsonb_build_object('fit',count(*) FILTER(WHERE kind='fit'),'fixture',count(*) FILTER(WHERE kind='fixture')),'overlayCount',count(*) FILTER(WHERE overlaid))`;
const plannedSql = `jsonb_build_object('count',count(*),'distanceMeters',${metricSql('distance')},'durationSeconds',${metricSql('duration')})`;
const sql = `WITH plan AS MATERIALIZED (
 SELECT s.id,s.version,s.draft FROM plan_head h JOIN plan_snapshot s ON s.athlete_id=h.athlete_id AND s.id=h.version_id WHERE h.athlete_id=$1
), settings AS (SELECT coalesce((SELECT draft->>'timezone' FROM plan),$2::text) AS timezone),
 canonical AS MATERIALIZED (SELECT id,revision,original,deleted FROM activity_canonical WHERE athlete_id=$1),
 effective AS MATERIALIZED (
 SELECT ((c.original->>'startedAt')::timestamptz AT TIME ZONE settings.timezone)::date AS date,
 ((CASE WHEN o.values_json ? 'distanceMeters' THEN o.values_json ELSE c.original END)->>'distanceMeters')::numeric AS distance,
 ((CASE WHEN o.values_json ? 'durationSeconds' THEN o.values_json ELSE c.original END)->>'durationSeconds')::numeric AS duration,
 (CASE WHEN o.values_json ? 'durationSeconds' THEN o.values_json ELSE c.original END)->>'durationKind' AS duration_kind,
 s.kind,o.activity_id IS NOT NULL AS overlaid FROM canonical c JOIN activity_source_head s ON s.athlete_id=$1 AND s.activity_id=c.id
 LEFT JOIN activity_overlay o ON o.athlete_id=$1 AND o.activity_id=c.id CROSS JOIN settings WHERE NOT c.deleted
), actual_daily AS (SELECT date,${actualSql} AS actual FROM effective WHERE date >= $3::date AND date < $4::date GROUP BY date),
 sessions AS MATERIALIZED (SELECT (item->>'date')::date AS date,(item->>'distanceMeters')::numeric AS distance,(item->>'durationSeconds')::numeric AS duration FROM plan CROSS JOIN LATERAL jsonb_array_elements(draft->'sessions') item),
 planned_daily AS (SELECT date,${plannedSql} AS planned FROM sessions WHERE date >= $3::date AND date < $4::date GROUP BY date),
 checkins AS MATERIALIZED (SELECT c.*,((c.values_json->>'observedAt')::timestamptz AT TIME ZONE settings.timezone)::date AS date FROM check_in c CROSS JOIN settings WHERE c.athlete_id=$1 AND NOT c.deleted),
 checkin_daily AS (SELECT date,count(*) AS count FROM checkins WHERE date >= $3::date AND date < $4::date GROUP BY date),
 dates AS (SELECT $3::date+n AS date FROM generate_series(0,($4::date-$3::date)-1) n),
 days AS (SELECT d.date::text AS date,coalesce(a.actual,$6::jsonb) AS actual,coalesce(p.planned,$7::jsonb) AS planned,coalesce(c.count,0) AS "checkInCount" FROM dates d LEFT JOIN actual_daily a USING(date) LEFT JOIN planned_daily p USING(date) LEFT JOIN checkin_daily c USING(date))
 SELECT (SELECT row_to_json(p) FROM plan p) AS plan,(SELECT timezone FROM settings) AS timezone,
 (SELECT coalesce(jsonb_agg(d ORDER BY date),'[]'::jsonb) FROM days d) AS days,
 (SELECT jsonb_build_object('count',count(*),'revisionSum',coalesce(sum(revision),0)::text) FROM canonical) AS activities,
 coalesce((SELECT revision FROM check_in_collection_head WHERE athlete_id=$1),0) AS checkin_revision,
 (SELECT count(*)::int FROM effective WHERE date IS NULL) AS unplaced,
 (SELECT jsonb_build_object('id',id,'revision',revision,'values',values_json,'localDate',local_date::text,'recordedAt',recorded_at,'updatedAt',updated_at,'source','user','method','self_report','definitionVersion','checkin-v1') FROM checkins WHERE date >= $5::date AND date < $4::date ORDER BY (values_json->>'observedAt')::timestamptz DESC,id LIMIT 1) AS latest_checkin`;
const rowSchema = z.object({
  plan: z.object({ id: z.string(), version: z.number().int(), draft: planDraftSchema }).nullable(),
  timezone: z.string(),
  days: z.array(dashboardDaySchema).max(180),
  activities: z.object({ count: z.number(), revisionSum: z.string() }),
  checkin_revision: z.number(),
  unplaced: z.number(),
  latest_checkin: checkInSchema.nullable(),
});
const compare = (a: string, b: string) => (a === b ? 0 : a < b ? -1 : 1);
export function createDashboardRepository(
  database: Database,
  { now = () => new Date() }: { now?: () => Date } = {},
): DashboardRepository {
  return {
    async read(athleteId, input) {
      const query = dashboardQuerySchema.parse(input);
      const from = shiftDashboardDate(query.anchor, 1 - query.window),
        toExclusive = shiftDashboardDate(query.anchor, 1),
        previousFrom = shiftDashboardDate(from, -query.window),
        upcomingToExclusive = shiftDashboardDate(query.anchor, 8);
      return database.tenant(athleteId, async (tx) => {
        const result = await tx.query(sql, [
          athleteId,
          query.timezone,
          previousFrom,
          toExclusive,
          from,
          JSON.stringify(emptyActual()),
          JSON.stringify(emptyPlanned()),
        ]);
        const row = rowSchema.parse(result.rows[0]);
        const sessions = [...(row.plan?.draft.sessions ?? [])].sort(
          (a, b) =>
            compare(a.date, b.date) ||
            compare(a.localStartTime ?? '', b.localStartTime ?? '') ||
            compare(a.id, b.id),
        );
        const currentDays = row.days.filter((day) => day.date >= from);
        return dashboardReadModelSchema.parse({
          definitionVersion: 'dashboard-v1',
          observedAt: now().toISOString(),
          period: {
            anchor: query.anchor,
            days: query.window,
            timezone: row.timezone,
            timezoneSource: row.plan ? 'plan' : 'query',
            from,
            toExclusive,
            previousFrom,
            upcomingToExclusive,
          },
          planVersion: row.plan ? { id: row.plan.id, version: row.plan.version } : null,
          dataRevision: { activities: row.activities, checkIns: row.checkin_revision },
          currentBlock:
            row.plan?.draft.periods.find(
              (p) =>
                p.level === 'block' &&
                p.startDate <= query.anchor &&
                p.endDateExclusive > query.anchor,
            ) ?? null,
          todaySessions: sessions.filter((s) => s.date === query.anchor),
          upcomingSessions: sessions.filter(
            (s) => s.date > query.anchor && s.date < upcomingToExclusive,
          ),
          current: summarizeDays(currentDays),
          previous: summarizeDays(row.days.filter((day) => day.date < from)),
          days: currentDays,
          unplacedActivityCount: row.unplaced,
          latestCheckIn: row.latest_checkin,
          availability: {
            coverage: 'unknown',
            comparison: 'unavailable',
            actualLoad: 'unavailable',
            providerMetrics: 'unavailable',
          },
          proposalSummary: { status: 'unavailable', reason: 'not_implemented' },
          connectionFreshness: {
            status: 'unavailable',
            reason: 'activity_sync_not_implemented',
            lastSuccessfulSyncAt: null,
          },
        });
      });
    },
  };
}
