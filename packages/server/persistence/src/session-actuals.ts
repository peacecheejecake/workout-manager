import { z } from 'zod';
import { planDraftSchema, sessionDistanceBounds } from '@workout/contracts/planning';
import { dashboardActualSchema } from '@workout/contracts/dashboard';
import {
  sessionActualsQuerySchema,
  sessionActualsSchema,
  type SessionActuals,
  type SessionActualsQuery,
} from '@workout/contracts/session-actuals';
import type { Database } from './database.js';
import { selectActivity } from './activity-record.js';
import { durationKinds, emptyActual } from './dashboard-metrics.js';

export interface SessionActualsRepository {
  read(athleteId: string, input: SessionActualsQuery): Promise<SessionActuals | null>;
}
function metric(column: string, condition = 'true') {
  return `jsonb_build_object('value',sum(${column}) FILTER(WHERE ${condition}),'knownCount',count(${column}) FILTER(WHERE ${condition}),'missingCount',count(*) FILTER(WHERE ${condition} AND ${column} IS NULL))`;
}
const aggregate = `jsonb_build_object('count',count(*),'distanceMeters',${metric('distance')},'durationSeconds',jsonb_build_object(${durationKinds.map((kind) => `'${kind}',${metric('duration', `duration_kind='${kind}'`)}`).join(',')}),'sources',jsonb_build_object('fit',count(*) FILTER(WHERE kind='fit'),'fixture',count(*) FILTER(WHERE kind='fixture'),'manual',count(*) FILTER(WHERE kind='manual')),'overlayCount',count(*) FILTER(WHERE overlaid))`;
// One statement keeps immutable targets, mutable activity overlays, head and revision metadata coherent.
const sql = `WITH plan AS MATERIALIZED (SELECT id,version,draft FROM plan_snapshot WHERE athlete_id=$1 AND id=$2::uuid),
 records AS MATERIALIZED (${selectActivity}),
 linked AS (
 SELECT r.kind,r.overlay#>>'{userReport,planLink,sessionId}' AS session_id,
 (r.overlay<>'{}'::jsonb AND r.revision>1) AS overlaid,
 ((CASE WHEN r.overlay ? 'distanceMeters' THEN r.overlay ELSE r.original END)->>'distanceMeters')::numeric AS distance,
 ((CASE WHEN r.overlay ? 'durationSeconds' THEN r.overlay ELSE r.original END)->>'durationSeconds')::numeric AS duration,
 (CASE WHEN r.overlay ? 'durationSeconds' THEN r.overlay ELSE r.original END)->>'durationKind' AS duration_kind
 FROM records r JOIN plan p ON lower(r.overlay#>>'{userReport,planLink,planVersionId}')=p.id::text
 WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(p.draft->'sessions') session WHERE session->>'id'=r.overlay#>>'{userReport,planLink,sessionId}')
 ), aggregates AS (SELECT session_id,${aggregate} AS actual FROM linked GROUP BY session_id)
 SELECT (SELECT to_jsonb(p) FROM plan p) AS plan,
 (SELECT version_id::text FROM plan_head WHERE athlete_id=$1) AS current_head,
 (SELECT jsonb_build_object('count',count(*),'revisionSum',coalesce(sum(revision),0)::text) FROM activity_canonical WHERE athlete_id=$1) AS revisions,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('sessionId',session_id,'actual',actual)),'[]'::jsonb) FROM aggregates) AS aggregates`;
const rowSchema = z.object({
  plan: z
    .object({ id: z.uuid(), version: z.number().int().positive(), draft: planDraftSchema })
    .nullable(),
  current_head: z.uuid().nullable(),
  revisions: sessionActualsSchema.shape.activityDataRevision,
  aggregates: z.array(z.object({ sessionId: z.string(), actual: dashboardActualSchema })).max(1000),
});

export function createSessionActualsRepository(
  database: Database,
  { now = () => new Date() }: { now?: () => Date } = {},
): SessionActualsRepository {
  return {
    async read(athleteId, input) {
      const query = sessionActualsQuerySchema.parse(input);
      return database.tenant(athleteId, async (tx) => {
        const result = await tx.query(sql, [athleteId, query.planVersionId]);
        const row = rowSchema.parse(result.rows[0]);
        if (!row.plan) return null;
        const plan = row.plan;
        const actuals = new Map(row.aggregates.map((entry) => [entry.sessionId, entry.actual]));
        return sessionActualsSchema.parse({
          definitionVersion: 'session-actuals-v1',
          observedAt: now().toISOString(),
          planVersion: { id: plan.id, version: plan.version, title: plan.draft.title },
          currentPlanVersionId: row.current_head,
          activityDataRevision: row.revisions,
          sessions: plan.draft.sessions.map((session) => {
            const bounds = sessionDistanceBounds(session);
            return {
              sessionId: session.id,
              distanceTarget: bounds ? { minMeters: bounds.min, maxMeters: bounds.max } : null,
              actual: actuals.get(session.id) ?? emptyActual(),
            };
          }),
          coverage: 'unknown',
        });
      });
    },
  };
}
