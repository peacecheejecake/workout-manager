import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  coachingConstraintSchema,
  coachingConstraintListSchema,
  coachingConstraintCreateSchema,
  coachingConstraintUpdateSchema,
  coachingConstraintDeleteSchema,
  coachingConstraintCommandResultSchema,
  type CoachingConstraintList,
  type CoachingConstraintCreate,
  type CoachingConstraintUpdate,
  type CoachingConstraintDelete,
  type CoachingConstraintCommandResult,
} from '@workout/contracts/coaching-constraints';
import type { Database } from './database.js';
import { enqueue, PersistenceConflict } from './outbox.js';
export class CoachingConstraintError extends Error {
  constructor(
    readonly code:
      | 'COACHING_CONSTRAINT_NOT_FOUND'
      | 'COACHING_CONSTRAINT_REVISION_CONFLICT'
      | 'COACHING_CONSTRAINT_LIMIT',
  ) {
    super(code);
  }
}
export interface CoachingConstraintRepository {
  list(athleteId: string): Promise<CoachingConstraintList>;
  create(
    athleteId: string,
    input: CoachingConstraintCreate,
  ): Promise<CoachingConstraintCommandResult>;
  update(
    athleteId: string,
    id: string,
    input: CoachingConstraintUpdate,
  ): Promise<CoachingConstraintCommandResult>;
  remove(
    athleteId: string,
    id: string,
    input: CoachingConstraintDelete,
  ): Promise<CoachingConstraintCommandResult>;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const storedRow = z.record(z.string(), z.unknown());
const maxRevision = 2147483646;
export function createCoachingConstraintRepository(
  database: Database,
): CoachingConstraintRepository {
  async function write(
    athleteId: string,
    id: string | null,
    action: 'create' | 'update' | 'remove',
    command: CoachingConstraintCreate | CoachingConstraintUpdate | CoachingConstraintDelete,
  ) {
    const { idempotencyKey, ...body } = command;
    const key = `coaching:constraint:${action}:${hash(idempotencyKey)}`;
    const request = { requestHash: hash(JSON.stringify({ action, id, ...body })) };
    return database.tenant(athleteId, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athleteId]);
      const receipt = await tx.query(
        'SELECT request=$3::jsonb AS matches,result FROM command_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
        [athleteId, key, JSON.stringify(request)],
      );
      if (receipt.rows[0]) {
        if (receipt.rows[0]['matches'] !== true)
          throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
        return coachingConstraintCommandResultSchema.parse(receipt.rows[0]['result']);
      }
      let previousRevision = 0;
      if (id !== null) {
        const item = await tx.query(
          'SELECT revision FROM coaching_constraint WHERE athlete_id=$1 AND id=$2 AND NOT deleted',
          [athleteId, id],
        );
        if (!item.rows[0]) throw new CoachingConstraintError('COACHING_CONSTRAINT_NOT_FOUND');
        previousRevision = z.number().int().positive().parse(item.rows[0]['revision']);
        if (!('expectedRevision' in command) || previousRevision !== command.expectedRevision)
          throw new CoachingConstraintError('COACHING_CONSTRAINT_REVISION_CONFLICT');
      }
      const selected = await tx.query(
        'SELECT revision FROM coaching_constraint_head WHERE athlete_id=$1',
        [athleteId],
      );
      const head = selected.rows[0]
        ? z.number().int().positive().parse(selected.rows[0]['revision'])
        : null;
      if (head !== command.expectedHeadRevision)
        throw new CoachingConstraintError('COACHING_CONSTRAINT_REVISION_CONFLICT');
      if ((head ?? 0) >= maxRevision || previousRevision >= maxRevision)
        throw new CoachingConstraintError('COACHING_CONSTRAINT_LIMIT');
      if (action === 'create') {
        const count = await tx.query(
          'SELECT count(*)::integer AS count FROM coaching_constraint WHERE athlete_id=$1 AND NOT deleted',
          [athleteId],
        );
        if (z.number().parse(count.rows[0]?.['count']) >= 50)
          throw new CoachingConstraintError('COACHING_CONSTRAINT_LIMIT');
      }
      const timestamp = await tx.query('SELECT clock_timestamp() AS now');
      const now = z.date().parse(timestamp.rows[0]?.['now']);
      const result = coachingConstraintCommandResultSchema.parse({
        id: id ?? randomUUID(),
        revision: previousRevision + 1,
        headRevision: (head ?? 0) + 1,
        deleted: action === 'remove',
      });
      await tx.query(
        'INSERT INTO coaching_constraint_head(athlete_id,revision,updated_at) VALUES($1,$2,$3) ON CONFLICT(athlete_id) DO UPDATE SET revision=EXCLUDED.revision,updated_at=EXCLUDED.updated_at',
        [athleteId, result.headRevision, now],
      );
      if (action === 'create') {
        await tx.query(
          'INSERT INTO coaching_constraint(athlete_id,id,revision,text,confirmed_at,updated_at) VALUES($1,$2,1,$3,$4,$4)',
          [athleteId, result.id, 'text' in command ? command.text : null, now],
        );
      } else {
        await tx.query(
          'UPDATE coaching_constraint SET revision=$3,text=$4,deleted=$5,confirmed_at=CASE WHEN $5 THEN confirmed_at ELSE $6 END,updated_at=$6 WHERE athlete_id=$1 AND id=$2',
          [
            athleteId,
            result.id,
            result.revision,
            'text' in command ? command.text : null,
            result.deleted,
            now,
          ],
        );
      }
      await enqueue(tx, {
        id: randomUUID(),
        idempotencyKey: key,
        topic: 'coaching.constraint_changed',
        payload: result,
      });
      await tx.query(
        'INSERT INTO command_receipt(athlete_id,idempotency_key,request,result) VALUES($1,$2,$3::jsonb,$4::jsonb)',
        [athleteId, key, JSON.stringify(request), JSON.stringify(result)],
      );
      return result;
    });
  }
  return {
    list(athleteId) {
      return database.tenant(athleteId, async (tx) => {
        const result = await tx.query(
          `SELECT (SELECT revision FROM coaching_constraint_head WHERE athlete_id=$1) AS head,
   COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM (SELECT id,revision,text,confirmed_at,updated_at FROM coaching_constraint WHERE athlete_id=$1 AND NOT deleted ORDER BY id LIMIT 51)c),'[]'::jsonb) AS items`,
          [athleteId],
        );
        const items = z.array(storedRow).parse(result.rows[0]?.['items']);
        if (items.length > 50) throw new CoachingConstraintError('COACHING_CONSTRAINT_LIMIT');
        return coachingConstraintListSchema.parse({
          headRevision: result.rows[0]?.['head'],
          items: items.map((item) => ({
            id: item['id'],
            revision: item['revision'],
            text: item['text'],
            confirmedAt: z.coerce.date().parse(item['confirmed_at']).toISOString(),
            updatedAt: z.coerce.date().parse(item['updated_at']).toISOString(),
          })),
        });
      });
    },
    create: (athleteId, input) =>
      write(athleteId, null, 'create', coachingConstraintCreateSchema.parse(input)),
    update: (athleteId, id, input) =>
      write(
        athleteId,
        coachingConstraintSchema.shape.id.parse(id),
        'update',
        coachingConstraintUpdateSchema.parse(input),
      ),
    remove: (athleteId, id, input) =>
      write(
        athleteId,
        coachingConstraintSchema.shape.id.parse(id),
        'remove',
        coachingConstraintDeleteSchema.parse(input),
      ),
  };
}
