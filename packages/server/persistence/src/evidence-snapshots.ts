import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  coreEvidenceBodySchema,
  coreEvidenceCaptureSchema,
  coreEvidenceSnapshotSchema,
  coreEvidenceSnapshotListSchema,
  coreEvidenceSnapshotListQuerySchema,
  type CoreEvidenceSnapshot,
  type CoreEvidenceCapture,
  type CoreEvidenceSnapshotList,
  type CoreEvidenceSnapshotListQuery,
} from '@workout/contracts/evidence-snapshots';
import {
  coachingThreadSchema,
  coachingUserMessageSchema,
} from '@workout/contracts/coaching-threads';
import { checkInSchema } from '@workout/contracts/check-ins';
import { planSnapshotSchema } from '@workout/contracts/planning';
import { decodeActivity, selectActivity } from './activity-record.js';
import { activityInstantSql } from './activity-calendar.js';
import type { Database, Transaction } from './database.js';
import { enqueue, PersistenceConflict } from './outbox.js';
export class CoreEvidenceSnapshotError extends Error {
  constructor(
    readonly code: 'THREAD_NOT_FOUND' | 'CONVERSATION_REVISION_CONFLICT' | 'EVIDENCE_TOO_LARGE',
  ) {
    super(code);
  }
}
export interface CoreEvidenceSnapshotRepository {
  capture(
    athleteId: string,
    threadId: string,
    input: CoreEvidenceCapture,
  ): Promise<CoreEvidenceSnapshot>;
  read(athleteId: string, id: string): Promise<CoreEvidenceSnapshot | null>;
  list(
    athleteId: string,
    threadId: string,
    input?: Partial<CoreEvidenceSnapshotListQuery>,
  ): Promise<CoreEvidenceSnapshotList | null>;
}
const uuid = z.uuid().transform((value) => value.toLowerCase()),
  row = z.record(z.string(), z.unknown()),
  rows = z.array(row);
const iso = (value: unknown) => z.coerce.date().parse(value).toISOString();
function metadata(value: Record<string, unknown>) {
  return {
    id: value['id'],
    threadId: value['thread_id'],
    createdAt: iso(value['created_at']),
    ...(value['purged_reason'] === null
      ? { status: 'available' }
      : { status: 'purged', reason: value['purged_reason'] }),
  };
}
function decode(value: Record<string, unknown>) {
  return coreEvidenceSnapshotSchema.parse({
    ...metadata(value),
    ...(value['body'] === null ? {} : { body: value['body'] }),
  });
}
async function read(tx: Transaction, id: string) {
  const result = await tx.query(
    'SELECT * FROM core_evidence_snapshot WHERE athlete_id=$1 AND id=$2',
    [tx.athleteId, id],
  );
  return result.rows[0] ? decode(result.rows[0]) : null;
}
const instant = activityInstantSql(
  "CASE WHEN overlay ? 'startedAt' THEN overlay->>'startedAt' ELSE original->>'startedAt' END",
);
const checkInstant = activityInstantSql("values_json->>'observedAt'");
// Date comparison uses PostgreSQL calendar dates; output maps 1 BC back to ISO year 0000.
const localDate = (expression: string) =>
  `(lpad((CASE WHEN extract(year FROM ${expression})<0 THEN extract(year FROM ${expression})+1 ELSE extract(year FROM ${expression}) END)::integer::text,4,'0')||to_char(${expression},'-MM-DD'))`;
const captureSql = `WITH pinned AS (
 SELECT t.*,p.version AS plan_version,p.created_at AS plan_created,p.draft FROM coaching_thread t JOIN plan_snapshot p ON p.athlete_id=t.athlete_id AND p.id=t.plan_version_id WHERE t.athlete_id=$1 AND t.id=$2
), bounds AS (SELECT (${activityInstantSql("$3 || 'T00:00:00Z'")} AT TIME ZONE 'UTC')::date AS start,(${activityInstantSql("$4 || 'T00:00:00Z'")} AT TIME ZONE 'UTC')::date AS finish),
 activity_rows AS (${selectActivity}),
 projected AS (SELECT *,(${instant} AT TIME ZONE $5)::date AS local_date FROM activity_rows),
 selected_activities AS (SELECT * FROM projected,bounds WHERE local_date IS NULL OR (local_date>=bounds.start AND local_date<bounds.finish) ORDER BY id LIMIT 501),
 projected_checkins AS (SELECT *,(${checkInstant} AT TIME ZONE $5)::date AS projected_date FROM check_in WHERE athlete_id=$1 AND NOT deleted),
 selected_checkins AS (SELECT * FROM projected_checkins,bounds WHERE projected_date>=bounds.start AND projected_date<bounds.finish ORDER BY id LIMIT 101)
 SELECT to_jsonb(pinned) AS pinned,
 to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS captured_at,
 COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY revision) FROM (SELECT * FROM coaching_message WHERE athlete_id=$1 AND thread_id=$2 ORDER BY revision LIMIT 101)m),'[]'::jsonb) AS messages,
 COALESCE((SELECT jsonb_agg(to_jsonb(a)||jsonb_build_object('projected',CASE WHEN a.local_date IS NULL THEN NULL ELSE ${localDate('a.local_date')} END) ORDER BY id) FROM selected_activities a),'[]'::jsonb) AS activities,
 COALESCE((SELECT jsonb_agg(to_jsonb(c)||jsonb_build_object('projected',${localDate('c.projected_date')},'local_date',${localDate('c.local_date')}) ORDER BY id) FROM selected_checkins c),'[]'::jsonb) AS checkins,
 COALESCE((SELECT jsonb_agg(record_json ORDER BY session_id) FROM (SELECT record_json,session_id FROM session_completion WHERE athlete_id=$1 AND session_id IN (SELECT value->>'id' FROM jsonb_array_elements(pinned.draft->'sessions')) ORDER BY session_id LIMIT 1001)c),'[]'::jsonb) AS completions,
 jsonb_build_object('schemaVersion',1,'scope','core-ledgers-v1','athleteId',$1::text,'capturedAt',to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'trainingPlan',COALESCE((SELECT jsonb_build_object('kind','exists','versionId',version_id) FROM plan_head WHERE athlete_id=$1),'{"kind":"absent"}'::jsonb),
 'activities',(SELECT jsonb_build_object('count',count(*)::text,'revisionSum',coalesce(sum(revision),0)::text) FROM activity_canonical WHERE athlete_id=$1),
 'checkIns',COALESCE((SELECT jsonb_build_object('kind','exists','revision',revision) FROM check_in_collection_head WHERE athlete_id=$1),'{"kind":"absent"}'::jsonb),
 'sessionCompletions',COALESCE((SELECT jsonb_build_object('kind','exists','revision',revision) FROM session_completion_collection_head WHERE athlete_id=$1),'{"kind":"absent"}'::jsonb),
 'aiConsent',COALESCE((SELECT jsonb_build_object('kind','exists','revision',revision,'granted',granted) FROM consent WHERE athlete_id=$1 AND kind='ai'),'{"kind":"absent"}'::jsonb)) AS dependencies
 FROM pinned`;
export function createCoreEvidenceSnapshotRepository(
  database: Database,
): CoreEvidenceSnapshotRepository {
  return {
    read: (athleteId, id) => database.tenant(athleteId, (tx) => read(tx, uuid.parse(id))),
    list(athleteId, threadId, input = {}) {
      const id = uuid.parse(threadId),
        query = coreEvidenceSnapshotListQuerySchema.parse(input);
      return database.tenant(athleteId, async (tx) => {
        const result = await tx.query(
          `SELECT (SELECT count(*)::integer FROM core_evidence_snapshot WHERE athlete_id=$1 AND thread_id=$2) AS total,COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY created_at DESC,id) FROM (SELECT id,thread_id,created_at,purged_reason FROM core_evidence_snapshot WHERE athlete_id=$1 AND thread_id=$2 ORDER BY created_at DESC,id LIMIT $3 OFFSET $4)s),'[]'::jsonb) AS items FROM coaching_thread WHERE athlete_id=$1 AND id=$2`,
          [athleteId, id, query.limit, query.offset],
        );
        if (!result.rows[0]) return null;
        return coreEvidenceSnapshotListSchema.parse({
          total: result.rows[0]['total'],
          items: rows.parse(result.rows[0]['items']).map(metadata),
        });
      });
    },
    capture(athleteId, threadId, input) {
      const id = uuid.parse(threadId),
        command = coreEvidenceCaptureSchema.parse(input),
        key = `evidence:capture:${createHash('sha256').update(command.idempotencyKey).digest('hex')}`;
      const request = {
        threadId: id,
        window: command.window,
        expectedConversationRevision: command.expectedConversationRevision,
      };
      return database.tenant(athleteId, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athleteId]);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,77209))', [athleteId]);
        const receipt = await tx.query(
          'SELECT request=$3::jsonb AS matches,result FROM command_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
          [athleteId, key, JSON.stringify(request)],
        );
        if (receipt.rows[0]) {
          if (receipt.rows[0]['matches'] !== true)
            throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
          const stored = z.strictObject({ snapshotId: uuid }).parse(receipt.rows[0]['result']);
          const snapshot = await read(tx, stored.snapshotId);
          if (!snapshot) throw new Error('EVIDENCE_RECEIPT_MISSING_SNAPSHOT');
          return snapshot;
        }
        const result = await tx.query(captureSql, [
          athleteId,
          id,
          command.window.from,
          command.window.toExclusive,
          command.window.timezone,
        ]);
        if (!result.rows[0]) throw new CoreEvidenceSnapshotError('THREAD_NOT_FOUND');
        const captured = result.rows[0],
          pinned = row.parse(captured['pinned']);
        if (pinned['revision'] !== command.expectedConversationRevision)
          throw new CoreEvidenceSnapshotError('CONVERSATION_REVISION_CONFLICT');
        const messages = rows.parse(captured['messages']),
          activities = rows.parse(captured['activities']),
          checkins = rows.parse(captured['checkins']),
          completions = z.array(z.unknown()).parse(captured['completions']);
        if (
          messages.length > 100 ||
          activities.length > 500 ||
          checkins.length > 100 ||
          completions.length > 1000
        )
          throw new CoreEvidenceSnapshotError('EVIDENCE_TOO_LARGE');
        const body = coreEvidenceBodySchema.parse({
          schemaVersion: 1,
          scope: 'running-core-v1',
          window: command.window,
          thread: coachingThreadSchema.parse({
            id: pinned['id'],
            planVersionId: pinned['plan_version_id'],
            title: pinned['title'],
            scope: pinned['scope'],
            revision: pinned['revision'],
            createdAt: iso(pinned['created_at']),
            updatedAt: iso(pinned['updated_at']),
          }),
          plan: planSnapshotSchema.parse({
            id: pinned['plan_version_id'],
            version: pinned['plan_version'],
            createdAt: iso(pinned['plan_created']),
            draft: pinned['draft'],
          }),
          messages: messages.map((m) =>
            coachingUserMessageSchema.parse({
              id: m['id'],
              threadId: m['thread_id'],
              revision: m['revision'],
              role: 'user',
              content: m['content'],
              createdAt: iso(m['created_at']),
            }),
          ),
          dependencies: captured['dependencies'],
          activities: activities.map((a) => ({
            localDate: a['projected'],
            record: decodeActivity(a),
          })),
          checkIns: checkins.map((c) => ({
            localDate: c['projected'],
            record: checkInSchema.parse({
              id: c['id'],
              revision: c['revision'],
              values: c['values_json'],
              localDate: c['local_date'],
              recordedAt: iso(c['recorded_at']),
              updatedAt: iso(c['updated_at']),
              source: 'user',
              method: 'self_report',
              definitionVersion: 'checkin-v1',
            }),
          })),
          sessionCompletions: completions,
        });
        const serialized = JSON.stringify(body);
        if (Buffer.byteLength(serialized) > 2 * 1024 * 1024)
          throw new CoreEvidenceSnapshotError('EVIDENCE_TOO_LARGE');
        const snapshot = coreEvidenceSnapshotSchema.parse({
          id: randomUUID(),
          threadId: id,
          createdAt: captured['captured_at'],
          status: 'available',
          body,
        });
        await tx.query(
          'INSERT INTO core_evidence_snapshot(athlete_id,id,thread_id,created_at,body) VALUES($1,$2,$3,$4,$5::jsonb)',
          [athleteId, snapshot.id, id, snapshot.createdAt, serialized],
        );
        await enqueue(tx, {
          id: randomUUID(),
          idempotencyKey: key,
          topic: 'evidence.captured',
          payload: { snapshotId: snapshot.id, threadId: id },
        });
        await tx.query(
          'INSERT INTO command_receipt(athlete_id,idempotency_key,request,result) VALUES($1,$2,$3::jsonb,$4::jsonb)',
          [athleteId, key, JSON.stringify(request), JSON.stringify({ snapshotId: snapshot.id })],
        );
        return snapshot;
      });
    },
  };
}
