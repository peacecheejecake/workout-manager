import { createHash, randomUUID } from 'node:crypto';
import {
  sessionCompletionSchema,
  sessionCompletionCommandSchema,
  sessionCompletionListSchema,
  sessionCompletionReadSchema,
  sessionCompletionResultSchema,
  sessionCompletionPathSchema,
  type SessionCompletionCommand,
  type SessionCompletionList,
  type SessionCompletionRead,
  type SessionCompletionResult,
} from '@workout/contracts/session-completion';
import { planDraftSchema } from '@workout/contracts/planning';
import type { Database } from './database.js';
import { enqueue, PersistenceConflict } from './outbox.js';
export class SessionCompletionError extends Error {
  constructor(
    readonly code:
      | 'SESSION_COMPLETION_NOT_FOUND'
      | 'PLAN_REVISION_CONFLICT'
      | 'COMPLETION_REVISION_CONFLICT'
      | 'COMPLETION_STATE_CONFLICT'
      | 'PLAN_COMPLETED_SESSION',
  ) {
    super(code);
  }
}
export interface SessionCompletionRepository {
  list(athleteId: string): Promise<SessionCompletionList>;
  read(athleteId: string, sessionId: string): Promise<SessionCompletionRead | null>;
  write(
    athleteId: string,
    sessionId: string,
    input: SessionCompletionCommand,
  ): Promise<SessionCompletionResult>;
}
const headSql =
  'SELECT p.id,p.draft FROM plan_head h JOIN plan_snapshot p ON p.athlete_id=h.athlete_id AND p.id=h.version_id WHERE h.athlete_id=$1';
export function createSessionCompletionRepository(
  database: Database,
  { now = () => new Date() }: { now?: () => Date } = {},
): SessionCompletionRepository {
  return {
    list(athleteId) {
      return database.tenant(athleteId, async (tx) => {
        const result = await tx.query(
          `WITH head AS (${headSql}) SELECT (SELECT id::text FROM head) AS "currentPlanVersionId",coalesce((SELECT revision FROM session_completion_collection_head WHERE athlete_id=$1),0) AS "collectionRevision",coalesce((SELECT jsonb_agg(c.record_json ORDER BY c.session_id) FROM session_completion c WHERE c.athlete_id=$1 AND EXISTS(SELECT 1 FROM head,jsonb_array_elements(draft->'sessions') s WHERE s->>'id'=c.session_id)),'[]'::jsonb) AS items`,
          [athleteId],
        );
        return sessionCompletionListSchema.parse(result.rows[0]);
      });
    },
    read(athleteId, sessionId) {
      sessionCompletionPathSchema.parse({ sessionId });
      return database.tenant(athleteId, async (tx) => {
        const result = await tx.query(
          `WITH head AS (${headSql}) SELECT EXISTS(SELECT 1 FROM head,jsonb_array_elements(draft->'sessions') s WHERE s->>'id'=$2) AS present,(SELECT id::text FROM head) AS "currentPlanVersionId",$2::text AS "sessionId",(SELECT record_json FROM session_completion WHERE athlete_id=$1 AND session_id=$2) AS report,coalesce((SELECT jsonb_agg(r.record_json ORDER BY r.revision DESC) FROM(SELECT revision,record_json FROM session_completion_revision WHERE athlete_id=$1 AND session_id=$2 ORDER BY revision DESC LIMIT 100)r),'[]'::jsonb) AS history,(SELECT count(*)::int FROM session_completion_revision WHERE athlete_id=$1 AND session_id=$2) AS "totalHistory"`,
          [athleteId, sessionId],
        );
        const row = result.rows[0];
        if (!row || row['present'] !== true) return null;
        const { present: _, ...value } = row;
        return sessionCompletionReadSchema.parse(value);
      });
    },
    write(athleteId, sessionId, input) {
      sessionCompletionPathSchema.parse({ sessionId });
      const command = sessionCompletionCommandSchema.parse(input);
      const hash = createHash('sha256')
        .update(JSON.stringify({ sessionId, command }))
        .digest('hex');
      return database.tenant(athleteId, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [athleteId]);
        const receipt = (
          await tx.query(
            'SELECT request_hash,result FROM session_completion_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
            [athleteId, command.idempotencyKey],
          )
        ).rows[0];
        if (receipt) {
          if (receipt['request_hash'] !== hash)
            throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
          return sessionCompletionResultSchema.parse(receipt['result']);
        }
        const head = (await tx.query(headSql, [athleteId])).rows[0];
        if (!head) throw new SessionCompletionError('SESSION_COMPLETION_NOT_FOUND');
        const draft = planDraftSchema.parse(head['draft']);
        const session = draft.sessions.find((item) => item.id === sessionId);
        if (!session) throw new SessionCompletionError('SESSION_COMPLETION_NOT_FOUND');
        if (head['id'] !== command.expectedPlanVersionId)
          throw new SessionCompletionError('PLAN_REVISION_CONFLICT');
        const existing = (
          await tx.query(
            'SELECT record_json FROM session_completion WHERE athlete_id=$1 AND session_id=$2',
            [athleteId, sessionId],
          )
        ).rows[0];
        const previous = existing ? sessionCompletionSchema.parse(existing['record_json']) : null;
        if ((previous?.revision ?? null) !== command.expectedRevision)
          throw new SessionCompletionError('COMPLETION_REVISION_CONFLICT');
        if (
          command.action === 'complete'
            ? previous?.status === 'completed'
            : previous?.status !== 'completed'
        )
          throw new SessionCompletionError('COMPLETION_STATE_CONFLICT');
        const report = sessionCompletionSchema.parse({
          sessionId,
          revision: (previous?.revision ?? 0) + 1,
          planVersionId: head['id'],
          schedule: {
            blockId: session.blockId,
            date: session.date,
            localStartTime: session.localStartTime,
            timezone: draft.timezone,
          },
          status: command.action === 'complete' ? 'completed' : 'retracted',
          reportedAt: now().toISOString(),
          reason: command.reason,
          source: 'user',
          method: 'self_report',
          definitionVersion: 'session-completion-v1',
        });
        await tx.query(
          'INSERT INTO session_completion(athlete_id,session_id,revision,record_json) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(athlete_id,session_id) DO UPDATE SET revision=EXCLUDED.revision,record_json=EXCLUDED.record_json',
          [athleteId, sessionId, report.revision, JSON.stringify(report)],
        );
        await tx.query(
          'INSERT INTO session_completion_revision(athlete_id,session_id,revision,record_json) VALUES($1,$2,$3,$4::jsonb)',
          [athleteId, sessionId, report.revision, JSON.stringify(report)],
        );
        const collection = (
          await tx.query(
            'INSERT INTO session_completion_collection_head(athlete_id,revision) VALUES($1,1) ON CONFLICT(athlete_id) DO UPDATE SET revision=session_completion_collection_head.revision+1 RETURNING revision',
            [athleteId],
          )
        ).rows[0];
        const result = sessionCompletionResultSchema.parse({
          report,
          collectionRevision: collection?.['revision'],
        });
        await enqueue(tx, {
          id: randomUUID(),
          idempotencyKey: `session-completion:${createHash('sha256').update(sessionId).digest('hex')}:${report.revision}`,
          topic: 'session.completion_changed',
          payload: {
            sessionId,
            revision: report.revision,
            collectionRevision: result.collectionRevision,
          },
        });
        await tx.query(
          'INSERT INTO session_completion_receipt(athlete_id,idempotency_key,request_hash,result) VALUES($1,$2,$3,$4::jsonb)',
          [athleteId, command.idempotencyKey, hash, JSON.stringify(result)],
        );
        return result;
      });
    },
  };
}
