import { z } from 'zod';
import { activityContextSchema, type ActivityContext } from '@workout/contracts/activity-context';
import { dashboardActualSchema } from '@workout/contracts/dashboard';
import { planDraftSchema } from '@workout/contracts/planning';
import type { Database } from './database.js';
import { selectActivity, decodeActivity } from './activity-record.js';
import { durationKinds } from './dashboard-metrics.js';
export interface ActivityContextRepository {
  read(athleteId: string, id: string): Promise<ActivityContext | null>;
}
function metric(column: string, condition = 'true') {
  return `jsonb_build_object('value',sum(${column}) FILTER(WHERE ${condition}),'knownCount',count(${column}) FILTER(WHERE ${condition}),'missingCount',count(*) FILTER(WHERE ${condition} AND ${column} IS NULL))`;
}
const aggregate = `jsonb_build_object('count',count(*),'distanceMeters',${metric('distance')},'durationSeconds',jsonb_build_object(${durationKinds.map((kind) => `'${kind}',${metric('duration', `duration_kind='${kind}'`)}`).join(',')}),'sources',jsonb_build_object('fit',count(*) FILTER(WHERE kind='fit'),'fixture',count(*) FILTER(WHERE kind='fixture'),'manual',count(*) FILTER(WHERE kind='manual')),'overlayCount',count(*) FILTER(WHERE overlaid))`;
const sql = `WITH records AS MATERIALIZED (${selectActivity}),target AS MATERIALIZED (SELECT * FROM records WHERE id=$2::uuid),
 plan AS MATERIALIZED (SELECT s.id,s.version,s.draft FROM target t JOIN plan_snapshot s ON s.athlete_id=$1 AND s.id::text=lower(t.overlay#>>'{userReport,planLink,planVersionId}')),
 linked_session AS (SELECT value AS session FROM plan CROSS JOIN LATERAL jsonb_array_elements(draft->'sessions') WHERE value->>'id'=(SELECT overlay#>>'{userReport,planLink,sessionId}' FROM target)),
 block AS MATERIALIZED (SELECT value AS block FROM plan CROSS JOIN LATERAL jsonb_array_elements(draft->'periods') WHERE value->>'id'=(SELECT session->>'blockId' FROM linked_session) AND value->>'level'='block'),
 effective AS MATERIALIZED (
 SELECT r.id,r.kind,(r.overlay<>'{}'::jsonb AND r.revision>1) AS overlaid,
 (CASE WHEN ((CASE WHEN r.overlay ? 'startedAt' THEN r.overlay ELSE r.original END)->>'startedAt') LIKE '0000-%' THEN NULL ELSE (((CASE WHEN r.overlay ? 'startedAt' THEN r.overlay ELSE r.original END)->>'startedAt')::timestamptz AT TIME ZONE (b.block->>'timezone'))::date END) AS date,
 ((CASE WHEN r.overlay ? 'distanceMeters' THEN r.overlay ELSE r.original END)->>'distanceMeters')::numeric AS distance,
 ((CASE WHEN r.overlay ? 'durationSeconds' THEN r.overlay ELSE r.original END)->>'durationSeconds')::numeric AS duration,
 (CASE WHEN r.overlay ? 'durationSeconds' THEN r.overlay ELSE r.original END)->>'durationKind' AS duration_kind
 FROM records r CROSS JOIN block b
 ) SELECT (SELECT to_jsonb(t) FROM target t) AS activity,(SELECT to_jsonb(p) FROM plan p) AS plan,
 (SELECT version_id::text FROM plan_head WHERE athlete_id=$1) AS current_head,
 (SELECT jsonb_build_object('count',count(*),'revisionSum',coalesce(sum(revision),0)::text) FROM activity_canonical WHERE athlete_id=$1) AS revisions,
 (SELECT date::text FROM effective WHERE id=$2::uuid) AS actual_date,
 (SELECT ${aggregate} FROM effective WHERE date >= (SELECT CASE WHEN block->>'startDate' LIKE '0000-%' THEN NULL ELSE (block->>'startDate')::date END FROM block) AND date < (SELECT CASE WHEN block->>'endDateExclusive' LIKE '0000-%' THEN NULL ELSE (block->>'endDateExclusive')::date END FROM block)) AS actual,
 EXISTS(SELECT 1 FROM block WHERE block->>'startDate' LIKE '0000-%' OR block->>'endDateExclusive' LIKE '0000-%') OR EXISTS(SELECT 1 FROM records r WHERE ((CASE WHEN r.overlay ? 'startedAt' THEN r.overlay ELSE r.original END)->>'startedAt') LIKE '0000-%') OR EXISTS(SELECT 1 FROM effective WHERE date < DATE '0001-01-01' OR date > DATE '9999-12-31') AS unsupported_calendar`;
const rowSchema = z.object({
  activity: z.record(z.string(), z.unknown()).nullable(),
  plan: z
    .object({ id: z.uuid(), version: z.number().int().positive(), draft: z.unknown() })
    .nullable(),
  current_head: z.uuid().nullable(),
  revisions: z.object({ count: z.number(), revisionSum: z.string() }),
  actual_date: z.string().nullable(),
  actual: dashboardActualSchema,
  unsupported_calendar: z.boolean(),
});
export function createActivityContextRepository(
  database: Database,
  { now = () => new Date() }: { now?: () => Date } = {},
): ActivityContextRepository {
  return {
    async read(athleteId, id) {
      z.uuid().parse(id);
      return database.tenant(athleteId, async (tx) => {
        const result = await tx.query(sql, [athleteId, id]);
        const row = rowSchema.parse(result.rows[0]);
        if (!row.activity) return null;
        const activity = decodeActivity(row.activity),
          link = activity.userReport?.planLink;
        let planContext: ActivityContext['planContext'] = link
          ? { status: 'unavailable', reason: 'linked_plan_unavailable' }
          : { status: 'unlinked' };
        const draft = planDraftSchema.safeParse(row.plan?.draft);
        if (link && row.plan && draft.success) {
          const session = draft.data.sessions.find((s) => s.id === link.sessionId),
            block = draft.data.periods.find(
              (p) => p.id === session?.blockId && p.level === 'block',
            );
          if (session && block && row.unsupported_calendar) {
            planContext = { status: 'unavailable', reason: 'unsupported_calendar' };
          } else if (session && block) {
            const actual = activity.effective.distanceMeters,
              planned = session.distanceMeters;
            planContext = {
              status: 'linked',
              planVersion: { id: row.plan.id, version: row.plan.version, title: draft.data.title },
              currentPlanVersionId: row.current_head,
              session,
              block,
              actualLocalDate: row.actual_date,
              blockMembership:
                row.actual_date === null
                  ? 'unknown_time'
                  : row.actual_date >= block.startDate && row.actual_date < block.endDateExclusive
                    ? 'included'
                    : 'outside',
              blockActual: row.actual,
              distanceComparison: {
                actual,
                planned,
                ...(session.distanceRange == null
                  ? {}
                  : {
                      plannedRange: session.distanceRange,
                      rangePosition:
                        actual === null
                          ? 'unknown'
                          : actual < session.distanceRange.minMeters
                            ? 'below'
                            : actual > session.distanceRange.maxMeters
                              ? 'above'
                              : 'within',
                    }),
                delta: actual !== null && planned !== null ? actual - planned : null,
                status:
                  session.distanceRange != null
                    ? actual === null
                      ? 'range_missing_actual'
                      : 'range_available'
                    : actual === null
                      ? planned === null
                        ? 'missing_both'
                        : 'missing_actual'
                      : planned === null
                        ? 'missing_plan'
                        : 'available',
              },
              durationComparison: {
                actual: activity.effective.durationSeconds,
                actualKind: activity.effective.durationKind,
                planned: session.durationSeconds,
                ...(session.durationRange == null ? {} : { plannedRange: session.durationRange }),
                delta: null,
                status: 'not_comparable',
                reason: 'planned_duration_definition_missing',
              },
              coverage: 'unknown',
            };
          }
        }
        return activityContextSchema.parse({
          definitionVersion: 'activity-context-v1',
          observedAt: now().toISOString(),
          activity,
          activityDataRevision: row.revisions,
          planContext,
        });
      });
    },
  };
}
