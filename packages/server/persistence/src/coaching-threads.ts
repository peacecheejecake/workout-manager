import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { planDraftSchema } from '@workout/contracts/planning';
import {
  coachingThreadSchema,
  coachingUserMessageSchema,
  coachingThreadListSchema,
  coachingThreadListQuerySchema,
  coachingMessagesQuerySchema,
  coachingMessagesSchema,
  coachingThreadCreateSchema,
  coachingMessageAppendSchema,
  coachingMessageResultSchema,
  type CoachingThread,
  type CoachingThreadList,
  type CoachingThreadListQuery,
  type CoachingMessages,
  type CoachingMessagesQuery,
  type CoachingThreadCreate,
  type CoachingMessageAppend,
  type CoachingMessageResult,
} from '@workout/contracts/coaching-threads';
import type { Database, Transaction } from './database.js';
import { enqueue, PersistenceConflict } from './outbox.js';

export class CoachingThreadError extends Error {
  constructor(
    readonly code:
      | 'THREAD_NOT_FOUND'
      | 'PLAN_VERSION_NOT_FOUND'
      | 'SCOPE_NOT_FOUND'
      | 'CONVERSATION_REVISION_CONFLICT'
      | 'CONVERSATION_LIMIT',
  ) {
    super(code);
  }
}
export interface CoachingThreadRepository {
  list(athleteId: string, input?: Partial<CoachingThreadListQuery>): Promise<CoachingThreadList>;
  read(athleteId: string, id: string): Promise<CoachingThread | null>;
  create(athleteId: string, input: CoachingThreadCreate): Promise<CoachingMessageResult>;
  append(
    athleteId: string,
    id: string,
    input: CoachingMessageAppend,
  ): Promise<CoachingMessageResult>;
  messages(
    athleteId: string,
    id: string,
    input?: Partial<CoachingMessagesQuery>,
  ): Promise<CoachingMessages | null>;
}
const uuid = z.uuid().transform((value) => value.toLowerCase());
const rowSchema = z.record(z.string(), z.unknown());
const iso = (value: unknown) => z.coerce.date().parse(value).toISOString();
function thread(value: unknown): CoachingThread {
  const row = rowSchema.parse(value);
  return coachingThreadSchema.parse({
    id: row['id'],
    planVersionId: row['plan_version_id'],
    title: row['title'],
    scope: row['scope'],
    revision: row['revision'],
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
  });
}
function message(value: unknown) {
  const row = rowSchema.parse(value);
  return coachingUserMessageSchema.parse({
    id: row['id'],
    threadId: row['thread_id'],
    revision: row['revision'],
    role: 'user',
    content: row['content'],
    createdAt: iso(row['created_at']),
  });
}
async function replay(tx: Transaction, key: string, request: unknown) {
  const result = await tx.query(
    'SELECT request=$3::jsonb AS matches,result FROM command_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
    [tx.athleteId, key, JSON.stringify(request)],
  );
  if (!result.rows[0]) return null;
  if (result.rows[0]['matches'] !== true) throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
  return coachingMessageResultSchema.parse(result.rows[0]['result']);
}
async function finish(
  tx: Transaction,
  key: string,
  request: unknown,
  current: CoachingThread,
  content: string,
  topic: string,
) {
  const inserted = await tx.query(
    'INSERT INTO coaching_message(athlete_id,id,thread_id,revision,content) VALUES($1,$2,$3,$4,$5) RETURNING *',
    [tx.athleteId, randomUUID(), current.id, current.revision, content],
  );
  const result = coachingMessageResultSchema.parse({
    thread: current,
    message: message(inserted.rows[0]),
  });
  await enqueue(tx, {
    id: randomUUID(),
    idempotencyKey: key,
    topic,
    payload: {
      threadId: current.id,
      messageId: result.message.id,
      revision: current.revision,
      planVersionId: current.planVersionId,
    },
  });
  await tx.query(
    'INSERT INTO command_receipt(athlete_id,idempotency_key,request,result) VALUES($1,$2,$3::jsonb,$4::jsonb)',
    [tx.athleteId, key, JSON.stringify(request), JSON.stringify(result)],
  );
  return result;
}
export function createCoachingThreadRepository(database: Database): CoachingThreadRepository {
  return {
    list(athleteId, input = {}) {
      const query = coachingThreadListQuerySchema.parse(input);
      return database.tenant(athleteId, async (tx) => {
        const result = await tx.query(
          `SELECT (SELECT count(*)::integer FROM coaching_thread WHERE athlete_id=$1) AS total,
          COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY created_at DESC,id) FROM (SELECT * FROM coaching_thread WHERE athlete_id=$1 ORDER BY created_at DESC,id LIMIT $2 OFFSET $3) page),'[]'::jsonb) AS items`,
          [athleteId, query.limit, query.offset],
        );
        return coachingThreadListSchema.parse({
          total: result.rows[0]?.['total'],
          items: z.array(z.unknown()).parse(result.rows[0]?.['items']).map(thread),
        });
      });
    },
    read(athleteId, id) {
      const parsedId = uuid.parse(id);
      return database.tenant(athleteId, async (tx) => {
        const result = await tx.query(
          'SELECT * FROM coaching_thread WHERE athlete_id=$1 AND id=$2',
          [athleteId, parsedId],
        );
        return result.rows[0] ? thread(result.rows[0]) : null;
      });
    },
    messages(athleteId, id, input = {}) {
      const parsedId = uuid.parse(id),
        query = coachingMessagesQuerySchema.parse(input);
      return database.tenant(athleteId, async (tx) => {
        const result = await tx.query(
          `SELECT to_jsonb(t) AS thread,
          COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY revision) FROM (SELECT * FROM coaching_message WHERE athlete_id=$1 AND thread_id=$2 AND revision>$3 ORDER BY revision LIMIT $4) page),'[]'::jsonb) AS messages
          FROM coaching_thread t WHERE t.athlete_id=$1 AND t.id=$2`,
          [athleteId, parsedId, query.afterRevision, query.limit + 1],
        );
        if (!result.rows[0]) return null;
        const rows = z.array(z.unknown()).parse(result.rows[0]['messages']);
        return coachingMessagesSchema.parse({
          thread: thread(result.rows[0]['thread']),
          messages: rows.slice(0, query.limit).map(message),
          hasMore: rows.length > query.limit,
        });
      });
    },
    create(athleteId, input) {
      const command = coachingThreadCreateSchema.parse(input),
        key = `coaching:create:${createHash('sha256').update(command.idempotencyKey).digest('hex')}`;
      const { idempotencyKey: _key, ...request } = command;
      return database.tenant(athleteId, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athleteId]);
        const prior = await replay(tx, key, request);
        if (prior) return prior;
        const plans = await tx.query(
          'SELECT draft FROM plan_snapshot WHERE athlete_id=$1 AND id=$2',
          [athleteId, command.planVersionId],
        );
        if (!plans.rows[0]) throw new CoachingThreadError('PLAN_VERSION_NOT_FOUND');
        const draft = planDraftSchema.parse(plans.rows[0]['draft']);
        const valid =
          command.scope.kind === 'session'
            ? draft.sessions.some((s) => s.id === command.scope.targetId)
            : draft.periods.some(
                (p) => p.id === command.scope.targetId && p.level === command.scope.kind,
              );
        if (!valid) throw new CoachingThreadError('SCOPE_NOT_FOUND');
        const inserted = await tx.query(
          'INSERT INTO coaching_thread(athlete_id,id,plan_version_id,title,scope,revision) VALUES($1,$2,$3,$4,$5::jsonb,1) RETURNING *',
          [
            athleteId,
            randomUUID(),
            command.planVersionId,
            command.title,
            JSON.stringify(command.scope),
          ],
        );
        return finish(
          tx,
          key,
          request,
          thread(inserted.rows[0]),
          command.message,
          'coaching.thread_created',
        );
      });
    },
    append(athleteId, id, input) {
      const parsedId = uuid.parse(id),
        command = coachingMessageAppendSchema.parse(input),
        key = `coaching:append:${createHash('sha256').update(command.idempotencyKey).digest('hex')}`;
      const { idempotencyKey: _key, ...body } = command;
      const request = { threadId: parsedId, ...body };
      return database.tenant(athleteId, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athleteId]);
        const prior = await replay(tx, key, request);
        if (prior) return prior;
        const selected = await tx.query(
          'SELECT * FROM coaching_thread WHERE athlete_id=$1 AND id=$2',
          [athleteId, parsedId],
        );
        if (!selected.rows[0]) throw new CoachingThreadError('THREAD_NOT_FOUND');
        const current = thread(selected.rows[0]);
        if (current.revision !== command.expectedRevision)
          throw new CoachingThreadError('CONVERSATION_REVISION_CONFLICT');
        if (current.revision >= 2147483646) throw new CoachingThreadError('CONVERSATION_LIMIT');
        const updated = await tx.query(
          'UPDATE coaching_thread SET revision=revision+1,updated_at=clock_timestamp() WHERE athlete_id=$1 AND id=$2 RETURNING *',
          [athleteId, parsedId],
        );
        return finish(
          tx,
          key,
          request,
          thread(updated.rows[0]),
          command.message,
          'coaching.message_appended',
        );
      });
    },
  };
}
