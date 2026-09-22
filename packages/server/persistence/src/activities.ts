import { activityInstantSql } from './activity-calendar.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  activitySchema,
  activityDetailsReadSchema,
  type ActivityDetailsRead,
  activityValuesSchema,
  manualActivityCreateSchema,
  manualActivityResultSchema,
  activityReportSchema,
  type ManualActivityCreate,
  type ManualActivityResult,
  type ActivityReportValues,
  type ActivityReport,
  activityOverlaySchema,
  activityOverlayWriteSchema,
  activityDeleteSchema,
  activityListQuerySchema,
  activityImportResultSchema,
  importActivitySchema,
  type Activity,
  type ActivityImport,
  type ActivityImportResult,
  type ActivityList,
  type ActivityListQuery,
  type ActivitySummary,
  type ActivityOverlayWrite,
} from '@workout/contracts/activity';
import { activityDetailsSchema } from '@workout/contracts/activity-details';
import { selectActivity, decodeActivity } from './activity-record.js';
import type { Database, Transaction } from './database.js';
import { enqueue, PersistenceConflict } from './outbox.js';

export class ActivityNotFound extends Error {
  constructor() {
    super('ACTIVITY_NOT_FOUND');
  }
}
export class ActivityValidationError extends Error {
  constructor(readonly code: 'STARTED_AT_IN_FUTURE' | 'PLAN_LINK_INVALID') {
    super(code);
  }
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const lock = (tx: Transaction) =>
  tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [tx.athleteId]);
async function detail(tx: Transaction, id: string) {
  const rows = await tx.query(`${selectActivity} AND c.id=$2`, [tx.athleteId, id]);
  return rows.rows[0] ? decodeActivity(rows.rows[0]) : null;
}
async function event(tx: Transaction, id: string, revision: number, action: string) {
  await enqueue(tx, {
    id: randomUUID(),
    idempotencyKey: `activity:${id}:${revision}`,
    topic: 'activity.changed',
    payload: { activityId: id, revision, action },
  });
}
export interface ActivityRepository {
  createManualActivity(
    athleteId: string,
    input: ManualActivityCreate,
  ): Promise<ManualActivityResult>;
  importActivity(athleteId: string, input: ActivityImport): Promise<ActivityImportResult>;
  listActivities(athleteId: string, input?: Partial<ActivityListQuery>): Promise<ActivityList>;
  getActivityDetails(athleteId: string, id: string): Promise<ActivityDetailsRead | null>;
  getActivity(athleteId: string, id: string): Promise<Activity | null>;
  updateOverlay(athleteId: string, id: string, input: ActivityOverlayWrite): Promise<Activity>;
  deleteActivity(
    athleteId: string,
    id: string,
    input: { expectedRevision: number; expectedCourseImpact?: string | undefined },
  ): Promise<void>;
  summary(athleteId: string): Promise<ActivitySummary>;
}
async function validatePlanLink(tx: Transaction, report: ActivityReportValues) {
  if (!report.planLink) return;
  const result = await tx.query(
    "SELECT 1 FROM plan_snapshot WHERE athlete_id=$1 AND id=$2 AND EXISTS(SELECT 1 FROM jsonb_array_elements(draft->'sessions') s WHERE s->>'id'=$3)",
    [tx.athleteId, report.planLink.planVersionId, report.planLink.sessionId],
  );
  if (!result.rowCount) throw new ActivityValidationError('PLAN_LINK_INVALID');
}
function reportValue(
  values: ActivityReportValues,
  previous: ActivityReport | null | undefined,
  now: Date,
): ActivityReport {
  return activityReportSchema.parse({
    ...values,
    definitionVersion: 'activity-report-v1',
    source: 'user',
    method: 'self_report',
    rpeReportedAt:
      values.sessionRpe === null
        ? null
        : previous?.sessionRpe === values.sessionRpe
          ? previous.rpeReportedAt
          : now.toISOString(),
  });
}
export function createActivityRepository(
  database: Database,
  { now = () => new Date() }: { now?: () => Date } = {},
): ActivityRepository {
  const validateStartedAt = (value: string | null) => {
    if (value !== null && Date.parse(value) > now().getTime() + 300000)
      throw new ActivityValidationError('STARTED_AT_IN_FUTURE');
  };
  return {
    async createManualActivity(athleteId, input) {
      const command = manualActivityCreateSchema.parse(input),
        requestHash = digest(command),
        receiptKey = `activity-manual:${command.idempotencyKey}`;
      return database.tenant(athleteId, async (tx) => {
        await lock(tx);
        const receipt = await tx.query(
          'SELECT request,result FROM command_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
          [athleteId, receiptKey],
        );
        if (receipt.rows[0]) {
          if (z.object({ hash: z.string() }).parse(receipt.rows[0]['request']).hash !== requestHash)
            throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
          return manualActivityResultSchema.parse(receipt.rows[0]['result']);
        }
        validateStartedAt(command.activity.startedAt);
        await validatePlanLink(tx, command.report);
        const id = randomUUID(),
          sourceId = randomUUID(),
          original = JSON.stringify(command.activity),
          contentHash = digest(command.activity);
        const overlay = activityOverlaySchema.parse({
          userReport: reportValue(command.report, null, now()),
        });
        await tx.query(
          'INSERT INTO activity_canonical(athlete_id,id,revision,original) VALUES($1,$2,1,$3::jsonb)',
          [athleteId, id, original],
        );
        await tx.query(
          "INSERT INTO activity_source_head(athlete_id,kind,source_id,source_revision,content_hash,activity_id) VALUES($1,'manual',$2,1,$3,$4)",
          [athleteId, sourceId, contentHash, id],
        );
        await tx.query(
          "INSERT INTO activity_source_revision(athlete_id,kind,source_id,source_revision,content_hash,normalized_raw) VALUES($1,'manual',$2,1,$3,$4::jsonb)",
          [athleteId, sourceId, contentHash, original],
        );
        await tx.query(
          'INSERT INTO activity_overlay(athlete_id,activity_id,values_json) VALUES($1,$2,$3::jsonb)',
          [athleteId, id, JSON.stringify(overlay)],
        );
        await tx.query(
          'INSERT INTO activity_overlay_revision(athlete_id,activity_id,revision,values_json) VALUES($1,$2,1,$3::jsonb)',
          [athleteId, id, JSON.stringify(overlay)],
        );
        await event(tx, id, 1, 'manual');
        const result = { activityId: id, revision: 1 };
        await tx.query(
          'INSERT INTO command_receipt(athlete_id,idempotency_key,request,result) VALUES($1,$2,$3::jsonb,$4::jsonb)',
          [athleteId, receiptKey, JSON.stringify({ hash: requestHash }), JSON.stringify(result)],
        );
        return result;
      });
    },
    importActivity(athleteId, input) {
      const command = importActivitySchema.parse(input);
      const hash = digest(command);
      return database.tenant(athleteId, async (tx) => {
        await lock(tx);
        const previous = await tx.query(
          'SELECT request_hash,result FROM activity_import_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
          [athleteId, command.idempotencyKey],
        );
        if (previous.rows[0]) {
          if (previous.rows[0]['request_hash'] !== hash)
            throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
          return activityImportResultSchema.parse(previous.rows[0]['result']);
        }
        const source = command.source;
        const head = await tx.query(
          `SELECT s.activity_id,s.source_revision,c.revision,c.deleted,EXISTS(SELECT 1 FROM activity_suppression d WHERE d.athlete_id=s.athlete_id AND d.kind=s.kind AND d.source_id=s.source_id) AS suppressed FROM activity_source_head s JOIN activity_canonical c ON c.athlete_id=s.athlete_id AND c.id=s.activity_id WHERE s.athlete_id=$1 AND s.kind=$2 AND s.source_id=$3`,
          [athleteId, source.kind, source.sourceId],
        );
        const existing = head.rows[0];
        const id = existing ? z.uuid().parse(existing['activity_id']) : randomUUID();
        let revision = existing ? z.number().int().positive().parse(existing['revision']) : 1;
        let outcome: ActivityImportResult['outcome'] = 'imported';
        if (existing?.['suppressed'] === true || existing?.['deleted'] === true)
          outcome = 'suppressed';
        else {
          const raw = await tx.query(
            'SELECT content_hash,normalized_raw,details_json FROM activity_source_revision WHERE athlete_id=$1 AND kind=$2 AND source_id=$3 AND source_revision=$4',
            [athleteId, source.kind, source.sourceId, source.revision],
          );
          if (raw.rows[0]) {
            if (
              raw.rows[0]['content_hash'] !== source.contentHash ||
              digest(activityValuesSchema.parse(raw.rows[0]['normalized_raw'])) !==
                digest(command.activity) ||
              digest(
                raw.rows[0]['details_json'] === null
                  ? null
                  : activityDetailsSchema.parse(raw.rows[0]['details_json']),
              ) !== digest(command.details ?? null)
            )
              throw new PersistenceConflict('REVISION_CONFLICT');
            outcome = 'unchanged';
          } else {
            const headRevision = existing ? z.number().int().parse(existing['source_revision']) : 0;
            if (!existing) {
              await tx.query(
                'INSERT INTO activity_canonical(athlete_id,id,revision,original) VALUES($1,$2,1,$3::jsonb)',
                [athleteId, id, JSON.stringify(command.activity)],
              );
              await tx.query(
                'INSERT INTO activity_source_head(athlete_id,kind,source_id,source_revision,content_hash,activity_id) VALUES($1,$2,$3,$4,$5,$6)',
                [athleteId, source.kind, source.sourceId, source.revision, source.contentHash, id],
              );
            }
            await tx.query(
              'INSERT INTO activity_source_revision(athlete_id,kind,source_id,source_revision,content_hash,normalized_raw,details_json) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)',
              [
                athleteId,
                source.kind,
                source.sourceId,
                source.revision,
                source.contentHash,
                JSON.stringify(command.activity),
                command.details === undefined ? null : JSON.stringify(command.details),
              ],
            );
            if (source.revision < headRevision) outcome = 'stale';
            else if (existing) {
              revision += 1;
              await tx.query(
                'UPDATE activity_canonical SET original=$3::jsonb,revision=$4 WHERE athlete_id=$1 AND id=$2',
                [athleteId, id, JSON.stringify(command.activity), revision],
              );
              await tx.query(
                'UPDATE activity_source_head SET source_revision=$4,content_hash=$5 WHERE athlete_id=$1 AND kind=$2 AND source_id=$3',
                [athleteId, source.kind, source.sourceId, source.revision, source.contentHash],
              );
            }
            if (outcome === 'imported') await event(tx, id, revision, 'imported');
          }
        }
        const result = { outcome, activityId: id, revision };
        await tx.query(
          'INSERT INTO activity_import_receipt(athlete_id,idempotency_key,request_hash,result) VALUES($1,$2,$3,$4::jsonb)',
          [athleteId, command.idempotencyKey, hash, JSON.stringify(result)],
        );
        return result;
      });
    },
    getActivityDetails(athleteId, id) {
      z.uuid().parse(id);
      return database.tenant(athleteId, async (tx) => {
        const result = await tx.query(
          `SELECT c.id AS "activityId",c.revision AS "activityRevision",
            jsonb_build_object('kind',s.kind,'sourceId',s.source_id,'revision',s.source_revision,'contentHash',s.content_hash) AS source,
            r.details_json AS details
           FROM activity_canonical c
           JOIN activity_source_head s ON s.athlete_id=c.athlete_id AND s.activity_id=c.id
           JOIN activity_source_revision r ON r.athlete_id=s.athlete_id AND r.kind=s.kind AND r.source_id=s.source_id AND r.source_revision=s.source_revision
           WHERE c.athlete_id=$1 AND c.id=$2 AND NOT c.deleted`,
          [athleteId, id],
        );
        return result.rows[0] ? activityDetailsReadSchema.parse(result.rows[0]) : null;
      });
    },
    listActivities(athleteId, input = {}) {
      const query = activityListQuerySchema.parse(input);
      return database.tenant(athleteId, async (tx) => {
        // Sort expressions are a fixed allowlist; request values remain SQL parameters.
        const orders = {
          id_asc: 'id ASC',
          started_desc: 'started_at DESC NULLS LAST,id ASC',
          started_asc: 'started_at ASC NULLS LAST,id ASC',
          distance_desc: 'effective_distance DESC NULLS LAST,id ASC',
          distance_asc: 'effective_distance ASC NULLS LAST,id ASC',
          title_asc: 'lower(effective_title) COLLATE "C" ASC NULLS LAST,id ASC',
        } as const;
        const order = orders[query.sort ?? 'id_asc'];
        // A single snapshot supplies the filtered total and bounded page, even past the last row.
        // strpos is literal substring matching: percent, underscore and backslash are not wildcards.
        const result = await tx.query(
          `WITH effective AS (
            SELECT base.*,${activityInstantSql("(CASE WHEN overlay ? 'startedAt' THEN overlay ELSE original END)->>'startedAt'")} AS started_at,
              (CASE WHEN overlay ? 'kind' THEN overlay ELSE original END)->>'kind' AS effective_kind,
              (CASE WHEN overlay ? 'title' THEN overlay ELSE original END)->>'title' AS effective_title,
              ((CASE WHEN overlay ? 'distanceMeters' THEN overlay ELSE original END)->>'distanceMeters')::numeric AS effective_distance,
              ((CASE WHEN overlay ? 'durationSeconds' THEN overlay ELSE original END)->>'durationSeconds')::numeric AS effective_duration
            FROM (${selectActivity}) base
          ), filtered AS MATERIALIZED (
            SELECT * FROM effective WHERE
              ($4::date IS NULL OR ((started_at AT TIME ZONE $6::text)::date >= $4::date AND (started_at AT TIME ZONE $6::text)::date < $5::date))
              AND ($7::text IS NULL OR effective_kind=$7)
              AND ($8::text IS NULL OR kind=$8)
              AND ($9::text IS NULL OR strpos(lower(effective_title),lower($9::text))>0)
              AND ($10::text IS NULL OR (
                lower(overlay#>>'{userReport,planLink,planVersionId}')=lower($10::text)
                AND EXISTS (
                  SELECT 1 FROM plan_snapshot p WHERE p.athlete_id=$1 AND p.id::text=lower($10::text)
                    AND EXISTS (SELECT 1 FROM jsonb_array_elements(p.draft->'periods') block WHERE block->>'id'=$11::text AND block->>'level'='block')
                    AND EXISTS (SELECT 1 FROM jsonb_array_elements(p.draft->'sessions') session WHERE session->>'id'=effective.overlay#>>'{userReport,planLink,sessionId}' AND session->>'blockId'=$11::text)
                )
              ))
              AND ($12::text IS NULL OR CASE $12::text
                WHEN 'missing_distance' THEN effective_distance IS NULL
                WHEN 'missing_duration' THEN effective_duration IS NULL
                WHEN 'missing_start' THEN started_at IS NULL
                WHEN 'corrected' THEN NULLIF(btrim(overlay->>'reason'),'') IS NOT NULL
                ELSE false END)
              AND ($13::text IS NULL OR coalesce(overlay->'tags','[]'::jsonb) ? $13::text)
          ), page AS (
            SELECT *,row_number() OVER (ORDER BY ${order}) AS ordinal FROM filtered ORDER BY ${order} LIMIT $2 OFFSET $3
          ) SELECT (SELECT count(*)::int FROM filtered) AS total,
            coalesce((SELECT jsonb_agg(page ORDER BY ordinal) FROM page),'[]'::jsonb) AS items`,
          [
            athleteId,
            query.limit,
            query.offset,
            query.from ?? null,
            query.toExclusive ?? null,
            query.timezone ?? null,
            query.kind ?? null,
            query.source ?? null,
            query.search ?? null,
            query.linkedPlanVersionId ?? null,
            query.linkedBlockId ?? null,
            query.quality ?? null,
            query.tag ?? null,
          ],
        );
        const row = z
          .object({ total: z.number().int(), items: z.array(z.record(z.string(), z.unknown())) })
          .parse(result.rows[0]);
        return { total: row.total, items: row.items.map(decodeActivity) };
      });
    },
    getActivity(athleteId, id) {
      z.uuid().parse(id);
      return database.tenant(athleteId, (tx) => detail(tx, id));
    },
    updateOverlay(athleteId, id, input) {
      z.uuid().parse(id);
      const command = activityOverlayWriteSchema.parse(input);
      const receiptKey = `activity-overlay:${command.idempotencyKey}`;
      const requestHash = digest({ id, ...command });
      return database.tenant(athleteId, async (tx) => {
        await lock(tx);
        const receipt = await tx.query(
          'SELECT request,result FROM command_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
          [athleteId, receiptKey],
        );
        if (receipt.rows[0]) {
          if (z.object({ hash: z.string() }).parse(receipt.rows[0]['request']).hash !== requestHash)
            throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
          return activitySchema.parse(receipt.rows[0]['result']);
        }
        const current = await detail(tx, id);
        if (!current) throw new ActivityNotFound();
        if (current.revision !== command.expectedRevision)
          throw new PersistenceConflict('REVISION_CONFLICT');
        if (command.startedAt !== undefined) validateStartedAt(command.startedAt);
        if (command.report !== undefined) await validatePlanLink(tx, command.report);
        const values = activityOverlaySchema.parse({
          ...(command.kind === undefined ? {} : { kind: command.kind }),
          ...(command.startedAt === undefined
            ? {}
            : { startedAt: command.startedAt, timezone: command.timezone }),
          ...(command.report === undefined
            ? {}
            : { userReport: reportValue(command.report, current.userReport, now()) }),
          reason: command.reason,
          ...(command.tags === undefined ? {} : { tags: command.tags }),
          ...(command.title === undefined ? {} : { title: command.title }),
          ...(command.distanceMeters === undefined
            ? {}
            : { distanceMeters: command.distanceMeters }),
          ...(command.durationSeconds === undefined
            ? {}
            : { durationSeconds: command.durationSeconds, durationKind: command.durationKind }),
        });
        await tx.query(
          'INSERT INTO activity_overlay(athlete_id,activity_id,values_json) VALUES($1,$2,$3::jsonb) ON CONFLICT(athlete_id,activity_id) DO UPDATE SET values_json=activity_overlay.values_json || EXCLUDED.values_json',
          [athleteId, id, JSON.stringify(values)],
        );
        await tx.query(
          'INSERT INTO activity_overlay_revision(athlete_id,activity_id,revision,values_json) VALUES($1,$2,$3,$4::jsonb)',
          [athleteId, id, current.revision + 1, JSON.stringify(values)],
        );
        await tx.query(
          'UPDATE activity_canonical SET revision=revision+1 WHERE athlete_id=$1 AND id=$2',
          [athleteId, id],
        );
        await event(tx, id, current.revision + 1, 'overlay');
        const result = await detail(tx, id);
        if (!result) throw new ActivityNotFound();
        await tx.query(
          'INSERT INTO command_receipt(athlete_id,idempotency_key,request,result) VALUES($1,$2,$3::jsonb,$4::jsonb)',
          [athleteId, receiptKey, JSON.stringify({ hash: requestHash }), JSON.stringify(result)],
        );
        return result;
      });
    },
    deleteActivity(athleteId, id, input) {
      z.uuid().parse(id);
      const command = activityDeleteSchema.parse(input);
      return database.tenant(athleteId, async (tx) => {
        await lock(tx);
        const rows = await tx.query(
          'SELECT revision,deleted FROM activity_canonical WHERE athlete_id=$1 AND id=$2',
          [athleteId, id],
        );
        const row = rows.rows[0];
        if (!row) throw new ActivityNotFound();
        if (row['deleted'] === true) return;
        const revision = z.number().int().parse(row['revision']);
        if (revision !== command.expectedRevision)
          throw new PersistenceConflict('REVISION_CONFLICT');
        // The list of courses this deletion reclaims is re-validated here, inside the same
        // transaction that writes the tombstone, because the Activity revision above does
        // not move when a course is cut from this activity. Only commands that carried a
        // confirmed list are checked; a caller that never showed one is unaffected.
        if (command.expectedCourseImpact !== undefined) {
          const impact = await tx.query(
            'SELECT public.activity_course_impact_digest($1) AS digest',
            [id],
          );
          if (z.string().parse(impact.rows[0]?.['digest']) !== command.expectedCourseImpact)
            throw new PersistenceConflict('COURSE_IMPACT_CHANGED');
        }
        await tx.query(
          'INSERT INTO activity_suppression(athlete_id,kind,source_id) SELECT athlete_id,kind,source_id FROM activity_source_head WHERE athlete_id=$1 AND activity_id=$2 ON CONFLICT DO NOTHING',
          [athleteId, id],
        );
        await tx.query(
          'UPDATE activity_canonical SET deleted=true,revision=revision+1 WHERE athlete_id=$1 AND id=$2',
          [athleteId, id],
        );
        await event(tx, id, revision + 1, 'deleted');
      });
    },
    summary(athleteId) {
      return database.tenant(athleteId, async (tx) => {
        const result = await tx.query(
          `WITH activities AS (SELECT c.original || coalesce(o.values_json,'{}'::jsonb) AS effective FROM activity_canonical c LEFT JOIN activity_overlay o ON o.athlete_id=c.athlete_id AND o.activity_id=c.id WHERE c.athlete_id=$1 AND NOT c.deleted)
          SELECT count(*)::int AS count,sum((effective->>'distanceMeters')::numeric)::double precision AS distance,count(effective->>'distanceMeters')::int AS distance_count,
          (SELECT coalesce(jsonb_agg(d),'[]'::jsonb) FROM (SELECT effective->>'durationKind' AS kind,sum((effective->>'durationSeconds')::numeric)::double precision AS value,count(effective->>'durationSeconds')::int AS known_count FROM activities GROUP BY effective->>'durationKind') d) AS durations FROM activities`,
          [athleteId],
        );
        const row = z
          .object({
            count: z.number(),
            distance: z.number().nullable(),
            distance_count: z.number(),
            durations: z.array(
              z.object({
                kind: z.enum(['timer', 'elapsed', 'moving', 'unknown']),
                value: z.number().nullable(),
                known_count: z.number(),
              }),
            ),
          })
          .parse(result.rows[0]);
        const byKind: ActivitySummary['durationSeconds']['byKind'] = {
          timer: { value: null, knownCount: 0 },
          elapsed: { value: null, knownCount: 0 },
          moving: { value: null, knownCount: 0 },
          unknown: { value: null, knownCount: 0 },
        };
        for (const group of row.durations)
          byKind[group.kind] = { value: group.value, knownCount: group.known_count };
        const known = row.durations.filter((group) => group.known_count > 0);
        return {
          count: row.count,
          distanceMeters: { value: row.distance, knownCount: row.distance_count },
          durationSeconds: {
            value: known.length === 1 ? (known[0]?.value ?? null) : null,
            knownCount: known.reduce((total, group) => total + group.known_count, 0),
            byKind,
          },
        };
      });
    },
  };
}
