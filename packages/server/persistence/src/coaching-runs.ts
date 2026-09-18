import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  coachingRunCreateCommandV1Schema,
  coachingRunListQuerySchema,
  coachingRunListSchema,
  coachingRunModelSourceSchema,
  coachingRunV1Schema,
  type CoachingRunCreateCommandV1,
  type CoachingRunList,
  type CoachingRunListQuery,
  type CoachingRunModelSource,
  type CoachingRunV1,
} from '@workout/contracts/coaching-runs';
import {
  buildTrainingCoachingBasis,
  compareTrainingCoachingBasis,
  trainingCoachingPolicySchema,
} from '@workout/contracts/coaching-basis';
import { coreEvidenceSnapshotSchema } from '@workout/contracts/evidence-snapshots';
import { coreEvidenceDependencyManifestV2Schema } from '@workout/contracts/evidence-dependencies';
import type { Database, Transaction } from './database.js';
import { enqueue, PersistenceConflict } from './outbox.js';

export class CoachingRunError extends Error {
  constructor(
    readonly code:
      | 'THREAD_NOT_FOUND'
      | 'EVIDENCE_UNAVAILABLE'
      | 'UNSUPPORTED_EVIDENCE_VERSION'
      | 'CONVERSATION_REVISION_CONFLICT'
      | 'STALE_BASIS'
      | 'AI_CONSENT_REQUIRED'
      | 'RUN_NOT_CANCELLABLE',
  ) {
    super(code);
  }
}

export interface CoachingRunRepository {
  create(
    athleteId: string,
    threadId: string,
    command: CoachingRunCreateCommandV1,
  ): Promise<CoachingRunV1>;
  read(athleteId: string, id: string): Promise<CoachingRunV1 | null>;
  list(
    athleteId: string,
    threadId: string,
    query?: Partial<CoachingRunListQuery>,
  ): Promise<CoachingRunList | null>;
  cancel(athleteId: string, id: string): Promise<CoachingRunV1 | null>;
}

export interface CoachingRunRepositoryOptions {
  policy: z.input<typeof trainingCoachingPolicySchema>;
  source: CoachingRunModelSource;
}

const uuid = z.uuid().refine((value) => value === value.toLowerCase());
const record = z.record(z.string(), z.unknown());
const iso = (value: unknown) => z.coerce.date().parse(value).toISOString();

function decode(value: unknown): CoachingRunV1 {
  const row = record.parse(value);
  return coachingRunV1Schema.parse({
    schemaVersion: 1,
    id: row['id'],
    threadId: row['thread_id'],
    evidenceSnapshotId: row['evidence_snapshot_id'],
    conversationRevision: row['conversation_revision'],
    policy: row['policy'],
    source: row['source'],
    status: row['status'],
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
  });
}

async function read(tx: Transaction, id: string): Promise<CoachingRunV1 | null> {
  const result = await tx.query('SELECT * FROM coaching_run WHERE athlete_id=$1 AND id=$2', [
    tx.athleteId,
    id,
  ]);
  return result.rows[0] ? decode(result.rows[0]) : null;
}

/** A single SQL statement observes evidence, conversation, consent, and all core-v2 heads. */
const preflightSql = `SELECT t.revision AS conversation_revision,
 e.id AS evidence_id,e.created_at AS evidence_created_at,e.purged_reason,e.body,
 jsonb_build_object('schemaVersion',2,'scope','core-ledgers-v2','athleteId',$1::text,
 'capturedAt',to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'trainingPlan',COALESCE((SELECT jsonb_build_object('kind','exists','versionId',version_id) FROM plan_head WHERE athlete_id=$1),'{"kind":"absent"}'::jsonb),
 'activities',(SELECT jsonb_build_object('count',count(*)::text,'revisionSum',coalesce(sum(revision),0)::text) FROM activity_canonical WHERE athlete_id=$1),
 'checkIns',COALESCE((SELECT jsonb_build_object('kind','exists','revision',revision) FROM check_in_collection_head WHERE athlete_id=$1),'{"kind":"absent"}'::jsonb),
 'sessionCompletions',COALESCE((SELECT jsonb_build_object('kind','exists','revision',revision) FROM session_completion_collection_head WHERE athlete_id=$1),'{"kind":"absent"}'::jsonb),
 'userConstraints',COALESCE((SELECT jsonb_build_object('kind','exists','revision',revision) FROM coaching_constraint_head WHERE athlete_id=$1),'{"kind":"absent"}'::jsonb),
 'aiConsent',COALESCE((SELECT jsonb_build_object('kind','exists','revision',revision,'granted',granted) FROM consent WHERE athlete_id=$1 AND kind='ai'),'{"kind":"absent"}'::jsonb)) AS dependencies
 FROM coaching_thread t LEFT JOIN core_evidence_snapshot e
 ON e.athlete_id=t.athlete_id AND e.thread_id=t.id AND e.id=$3
 WHERE t.athlete_id=$1 AND t.id=$2`;

export function createCoachingRunRepository(
  database: Database,
  options: CoachingRunRepositoryOptions,
): CoachingRunRepository {
  const policy = trainingCoachingPolicySchema.parse(options.policy);
  const source = coachingRunModelSourceSchema.parse(options.source);
  return {
    read: (athleteId, id) => database.tenant(athleteId, (tx) => read(tx, uuid.parse(id))),
    list(athleteId, threadId, input = {}) {
      const id = uuid.parse(threadId);
      const query = coachingRunListQuerySchema.parse(input);
      return database.tenant(athleteId, async (tx) => {
        const result = await tx.query(
          `SELECT (SELECT count(*)::integer FROM coaching_run WHERE athlete_id=$1 AND thread_id=$2) AS total,
           COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY created_at DESC,id) FROM
            (SELECT * FROM coaching_run WHERE athlete_id=$1 AND thread_id=$2
             ORDER BY created_at DESC,id LIMIT $3 OFFSET $4) r),'[]'::jsonb) AS items
           FROM coaching_thread WHERE athlete_id=$1 AND id=$2`,
          [athleteId, id, query.limit, query.offset],
        );
        if (!result.rows[0]) return null;
        return coachingRunListSchema.parse({
          total: result.rows[0]['total'],
          items: z.array(record).parse(result.rows[0]['items']).map(decode),
        });
      });
    },
    create(athleteId, threadId, input) {
      const id = uuid.parse(threadId);
      const command = coachingRunCreateCommandV1Schema.parse(input);
      const key = `coaching:run:${createHash('sha256').update(command.idempotencyKey).digest('hex')}`;
      const request = {
        threadId: id,
        evidenceSnapshotId: command.evidenceSnapshotId,
        expectedConversationRevision: command.expectedConversationRevision,
      };
      return database.tenant(athleteId, async (tx) => {
        // Same order as evidence capture and thread writes; source/consent deletion takes lock 0.
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athleteId]);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,77209))', [athleteId]);
        const receipt = await tx.query(
          'SELECT request=$3::jsonb AS matches,result FROM command_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
          [athleteId, key, JSON.stringify(request)],
        );
        if (receipt.rows[0]) {
          if (receipt.rows[0]['matches'] !== true)
            throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
          const prior = z.strictObject({ runId: uuid }).parse(receipt.rows[0]['result']);
          const run = await read(tx, prior.runId);
          if (!run) throw new Error('COACHING_RUN_RECEIPT_MISSING_RUN');
          return run;
        }
        const result = await tx.query(preflightSql, [athleteId, id, command.evidenceSnapshotId]);
        const current = result.rows[0];
        if (!current) throw new CoachingRunError('THREAD_NOT_FOUND');
        if (current['conversation_revision'] !== command.expectedConversationRevision)
          throw new CoachingRunError('CONVERSATION_REVISION_CONFLICT');
        if (!current['evidence_id'] || current['body'] === null)
          throw new CoachingRunError('EVIDENCE_UNAVAILABLE');
        const snapshot = coreEvidenceSnapshotSchema.safeParse({
          id: current['evidence_id'],
          threadId: id,
          createdAt: iso(current['evidence_created_at']),
          status: 'available',
          body: current['body'],
        });
        if (!snapshot.success) throw new CoachingRunError('UNSUPPORTED_EVIDENCE_VERSION');
        const built = buildTrainingCoachingBasis({ athleteId, snapshot: snapshot.data, policy });
        if (!built.ok) {
          if (built.reason === 'AI_CONSENT_REQUIRED')
            throw new CoachingRunError('AI_CONSENT_REQUIRED');
          if (built.reason === 'PINNED_PLAN_NOT_CURRENT') throw new CoachingRunError('STALE_BASIS');
          throw new CoachingRunError('UNSUPPORTED_EVIDENCE_VERSION');
        }
        const dependencies = coreEvidenceDependencyManifestV2Schema.parse(current['dependencies']);
        if (dependencies.aiConsent.kind !== 'exists' || !dependencies.aiConsent.granted)
          throw new CoachingRunError('AI_CONSENT_REQUIRED');
        const compared = compareTrainingCoachingBasis(built.basis, {
          schemaVersion: 1,
          scope: 'running-core-v2-training',
          athleteId,
          evidence: {
            id: snapshot.data.id,
            threadId: id,
            createdAt: snapshot.data.createdAt,
            status: 'available',
          },
          conversationRevision: current['conversation_revision'],
          dependencies,
          policy,
          retrieval: { kind: 'none' },
        });
        if (compared.status !== 'fresh') throw new CoachingRunError('STALE_BASIS');
        const inserted = await tx.query(
          `INSERT INTO coaching_run(athlete_id,id,thread_id,evidence_snapshot_id,conversation_revision,policy,source,basis)
           VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb) RETURNING *`,
          [
            athleteId,
            randomUUID(),
            id,
            command.evidenceSnapshotId,
            command.expectedConversationRevision,
            JSON.stringify(policy),
            JSON.stringify(source),
            JSON.stringify(built.basis),
          ],
        );
        const run = decode(inserted.rows[0]);
        await enqueue(tx, {
          id: randomUUID(),
          idempotencyKey: key,
          topic: 'coaching.run_queued',
          payload: { runId: run.id },
        });
        await tx.query(
          'INSERT INTO command_receipt(athlete_id,idempotency_key,request,result) VALUES($1,$2,$3::jsonb,$4::jsonb)',
          [athleteId, key, JSON.stringify(request), JSON.stringify({ runId: run.id })],
        );
        return run;
      });
    },
    cancel(athleteId, id) {
      const runId = uuid.parse(id);
      return database.tenant(athleteId, async (tx) => {
        const locked = await tx.query(
          'SELECT * FROM coaching_run WHERE athlete_id=$1 AND id=$2 FOR UPDATE',
          [athleteId, runId],
        );
        const selected = locked.rows[0] ? decode(locked.rows[0]) : null;
        if (!selected) return null;
        if (selected.status.kind === 'cancelled') return selected;
        if (!['queued', 'running', 'analysis_ready'].includes(selected.status.kind))
          throw new CoachingRunError('RUN_NOT_CANCELLABLE');
        const updated = await tx.query(
          `UPDATE coaching_run SET status='{"kind":"cancelled","reason":"user_requested"}'::jsonb,
           updated_at=clock_timestamp() WHERE athlete_id=$1 AND id=$2
           AND status->>'kind' IN ('queued','running','analysis_ready') RETURNING *`,
          [athleteId, runId],
        );
        if (!updated.rows[0]) {
          const latest = await read(tx, runId);
          if (latest?.status.kind === 'cancelled') return latest;
          throw new CoachingRunError('RUN_NOT_CANCELLABLE');
        }
        const run = decode(updated.rows[0]);
        await enqueue(tx, {
          id: randomUUID(),
          idempotencyKey: `coaching:run:cancel:${runId}`,
          topic: 'coaching.run_cancelled',
          payload: { runId },
        });
        return run;
      });
    },
  };
}
