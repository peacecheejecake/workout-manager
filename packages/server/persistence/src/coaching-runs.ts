import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  coachingRunCreateCommandV1Schema,
  coachingRunOutputV1Schema,
  coachingRunListQuerySchema,
  coachingRunListSchema,
  coachingRunModelSourceSchema,
  coachingRunV1Schema,
  type CoachingRunCreateCommandV1Input,
  type CoachingRunOutputV1,
  type CoachingRunList,
  type CoachingRunListQuery,
  type CoachingRunModelSource,
  type CoachingRunV1,
} from '@workout/contracts/coaching-runs';
import {
  buildTrainingCoachingBasis,
  compareTrainingCoachingBasis,
  trainingCoachingBasisV1Schema,
  trainingCoachingPolicySchema,
} from '@workout/contracts/coaching-basis';
import type { CoachingRetrievalBasis } from '@workout/contracts/resource-retrieval';
import { coreEvidenceSnapshotSchema } from '@workout/contracts/evidence-snapshots';
import type { CoreEvidenceBodyV2 } from '@workout/contracts/evidence-snapshots';
import { coreEvidenceDependencyManifestV2Schema } from '@workout/contracts/evidence-dependencies';
import type {
  CoachingGrounding,
  CoachingJobLease,
  CoachingRunWorkerStore,
} from '@workout/server-coaching/runner';
import { captureResourceCoachUseManifest } from './resource-access.js';
import {
  prepareRunGrounding,
  recordRunCitations,
  ResourceRetrievalError,
  writeRunGrounding,
} from './resource-retrieval.js';
import type { Database, Transaction } from './database.js';
import { claimTopic, complete, enqueue, PersistenceConflict } from './outbox.js';

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
    command: CoachingRunCreateCommandV1Input,
  ): Promise<CoachingRunV1>;
  read(athleteId: string, id: string): Promise<CoachingRunV1 | null>;
  readOutput(athleteId: string, id: string): Promise<CoachingRunOutputV1 | null>;
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
const storedFixtureOutputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  content: z.json(),
});
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

/**
 * The retrieval half of the dependency manifest, observed now. A run that
 * pinned no retrieval has no resource dependency, so enabling a resource later
 * does not invalidate it; a run that did pin one is compared against the whole
 * current authorized set.
 */
async function observeRetrieval(
  tx: Transaction,
  storedBasis: unknown,
): Promise<CoachingRetrievalBasis> {
  const parsed = trainingCoachingBasisV1Schema.safeParse(storedBasis);
  if (!parsed.success || parsed.data.retrieval.kind === 'none') return { kind: 'none' };
  return {
    kind: 'resource-access-v1',
    query: parsed.data.retrieval.query,
    manifest: await captureResourceCoachUseManifest(tx),
  };
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

async function currentWorkerEvidence(
  tx: Transaction,
  run: Record<string, unknown>,
  policy: z.infer<typeof trainingCoachingPolicySchema>,
  source: CoachingRunModelSource,
): Promise<CoreEvidenceBodyV2 | null> {
  const stored = decode(run);
  if (
    stored.policy.id !== policy.id ||
    stored.policy.version !== policy.version ||
    stored.source.kind !== 'deterministic_fixture' ||
    source.kind !== 'deterministic_fixture' ||
    stored.source.fixtureId !== source.fixtureId
  )
    return null;
  const observed = await tx.query(preflightSql, [
    tx.athleteId,
    stored.threadId,
    stored.evidenceSnapshotId,
  ]);
  const row = observed.rows[0];
  if (!row || row['evidence_id'] !== stored.evidenceSnapshotId || row['body'] === null) return null;
  const snapshot = coreEvidenceSnapshotSchema.safeParse({
    id: row['evidence_id'],
    threadId: stored.threadId,
    createdAt: iso(row['evidence_created_at']),
    status: 'available',
    body: row['body'],
  });
  if (
    !snapshot.success ||
    snapshot.data.status !== 'available' ||
    snapshot.data.body.schemaVersion !== 2
  )
    return null;
  const dependencies = coreEvidenceDependencyManifestV2Schema.safeParse(row['dependencies']);
  if (
    !dependencies.success ||
    dependencies.data.aiConsent.kind !== 'exists' ||
    !dependencies.data.aiConsent.granted
  )
    return null;
  const compared = compareTrainingCoachingBasis(run['basis'], {
    schemaVersion: 1,
    scope: 'running-core-v2-training',
    athleteId: tx.athleteId,
    evidence: {
      id: stored.evidenceSnapshotId,
      threadId: stored.threadId,
      createdAt: snapshot.data.createdAt,
      status: 'available',
    },
    conversationRevision: row['conversation_revision'],
    dependencies: dependencies.data,
    policy,
    retrieval: await observeRetrieval(tx, run['basis']),
  });
  if (compared.status !== 'fresh') return null;
  return snapshot.data.body;
}

/**
 * The pinned excerpts, re-authorized now. The stored copy is never handed to an
 * adapter on its own: a resource blocked since the pin simply has no row here.
 *
 * This read commits with the rest of `prepare`, so authorization is as of the
 * start of the adapter call. A revocation during the call cannot recall what
 * was already handed over; `finish` re-validates every citation against the
 * live gate before storing anything, so a revocation still prevents the answer
 * from being persisted with resolvable sources.
 */
async function readWorkerGrounding(
  tx: Transaction,
  runId: string,
): Promise<CoachingGrounding | null> {
  const grounding = (
    await tx.query(
      'SELECT grounding_id,query_text FROM resource_grounding WHERE athlete_id=$1 AND run_id=$2',
      [tx.athleteId, runId],
    )
  ).rows[0];
  if (!grounding) return null;
  const rows = await tx.query(
    `SELECT e.ordinal,e.passage_id,e.resource_id,e.version_id,r.title,p.heading_path,p.content
     FROM resource_grounding_excerpt e
     JOIN resource_passage p ON p.athlete_id=e.athlete_id AND p.passage_id=e.passage_id
     JOIN resource r ON r.athlete_id=p.athlete_id AND r.id=p.resource_id
     WHERE e.athlete_id=$1 AND e.grounding_id=$2 AND r.deleted_at IS NULL
       AND r.current_version_id=p.version_id AND public.resource_coach_use_authorized(r.id)
     ORDER BY e.ordinal`,
    [tx.athleteId, grounding['grounding_id']],
  );
  const parsed = z
    .array(
      z.object({
        ordinal: z.number().int().min(0).max(19),
        passage_id: uuid,
        resource_id: uuid,
        version_id: uuid,
        title: z.string().min(1).max(200),
        heading_path: z.array(z.string().min(1).max(200)).max(8),
        content: z.string().min(1),
      }),
    )
    .parse(rows.rows);
  return {
    query: z.string().min(1).max(500).parse(grounding['query_text']),
    excerpts: parsed.map((row) => ({
      ordinal: row.ordinal,
      passageId: row.passage_id,
      resourceId: row.resource_id,
      versionId: row.version_id,
      title: row.title,
      headingPath: row.heading_path,
      text: row.content,
    })),
  };
}

async function lockWorkerLease(tx: Transaction, lease: CoachingJobLease): Promise<boolean> {
  const found = await tx.query(
    `SELECT payload,attempts FROM outbox WHERE athlete_id=$1 AND id=$2 AND topic='coaching.run_queued'
      AND lease_token=$3 AND lease_until>clock_timestamp() AND completed_at IS NULL FOR UPDATE`,
    [tx.athleteId, lease.eventId, lease.leaseToken],
  );
  if (!found.rows[0]) return false;
  const payload = z.strictObject({ runId: uuid }).parse(found.rows[0]['payload']);
  return payload.runId === lease.runId && found.rows[0]['attempts'] === lease.attempts;
}

async function acknowledgeWorkerLease(tx: Transaction, lease: CoachingJobLease): Promise<void> {
  if (!(await complete(tx, lease.eventId, lease.leaseToken)))
    throw new Error('COACHING_WORKER_LEASE_LOST');
}

async function changeWorkerStatus(
  tx: Transaction,
  runId: string,
  status: CoachingRunV1['status'],
): Promise<void> {
  const result = await tx.query(
    'UPDATE coaching_run SET status=$3::jsonb,updated_at=clock_timestamp() WHERE athlete_id=$1 AND id=$2',
    [tx.athleteId, runId, JSON.stringify(status)],
  );
  if (result.rowCount !== 1) throw new Error('COACHING_WORKER_RUN_MISSING');
}

export function createCoachingRunRepository(
  database: Database,
  options: CoachingRunRepositoryOptions,
): CoachingRunRepository {
  const policy = trainingCoachingPolicySchema.parse(options.policy);
  const source = coachingRunModelSourceSchema.parse(options.source);
  return {
    read: (athleteId, id) => database.tenant(athleteId, (tx) => read(tx, uuid.parse(id))),
    readOutput(athleteId, id) {
      const runId = uuid.parse(id);
      return database.tenant(athleteId, async (tx) => {
        // Serialize against redaction, then compare every current dependency and policy head.
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athleteId]);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,77209))', [athleteId]);
        const result = await tx.query(
          `SELECT r.*,o.id AS output_id,o.body AS output_body
           FROM coaching_run r
           JOIN coaching_analysis_output o ON o.athlete_id=r.athlete_id AND o.run_id=r.id
           WHERE r.athlete_id=$1 AND r.id=$2
            AND r.status->>'kind'='analysis_ready'
            AND r.status->>'outputId'=o.id::text
            AND r.source->>'kind'='deterministic_fixture'
            AND r.source->>'fixtureId'='synthetic-v1'
            AND o.body IS NOT NULL AND o.purged_reason IS NULL`,
          [athleteId, runId],
        );
        const row = result.rows[0];
        if (!row) return null;
        const body = storedFixtureOutputSchema.safeParse(row['output_body']);
        if (!body.success || !(await currentWorkerEvidence(tx, row, policy, source))) return null;
        return coachingRunOutputV1Schema.parse({
          schemaVersion: 1,
          runId,
          outputId: row['output_id'],
          source: { kind: 'deterministic_fixture', fixtureId: 'synthetic-v1' },
          trust: 'untrusted_fixture',
          validation: 'unvalidated',
          content: body.data.content,
        });
      });
    },
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
        retrieval: command.retrieval,
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
        // Retrieval runs before the basis is built so the pinned manifest and
        // the stored excerpts come from the same observation. It reads only
        // resources the query-time gate authorizes and calls no provider.
        const prepared =
          command.retrieval.kind === 'resource-access-v1'
            ? await prepareRunGrounding(tx, command.retrieval.query)
            : null;
        const retrieval: CoachingRetrievalBasis = prepared
          ? {
              kind: 'resource-access-v1',
              query: prepared.query,
              manifest: prepared.manifest,
            }
          : { kind: 'none' };
        const built = buildTrainingCoachingBasis({
          athleteId,
          snapshot: snapshot.data,
          policy,
          retrieval,
        });
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
          // The pin was captured in this same transaction, so it is by
          // construction the current observation; later reads recapture it.
          policy,
          retrieval,
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
        if (prepared) await writeRunGrounding(tx, run.id, prepared);
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

/** Fixture-only execution port; the caller explicitly supplies the tenant to dispatch. */
export function createCoachingRunWorkerStore(
  database: Database,
  options: CoachingRunRepositoryOptions & {
    leaseSeconds?: number;
    currentPolicy?: () => z.input<typeof trainingCoachingPolicySchema>;
  },
): CoachingRunWorkerStore {
  trainingCoachingPolicySchema.parse(options.policy);
  const currentPolicy = () =>
    trainingCoachingPolicySchema.parse(options.currentPolicy?.() ?? options.policy);
  const source = coachingRunModelSourceSchema.parse(options.source);
  if (source.kind !== 'deterministic_fixture' || source.fixtureId !== 'synthetic-v1')
    throw new Error('COACHING_PROVIDER_NOT_CONFIGURED');
  const leaseSeconds = z
    .number()
    .int()
    .min(1)
    .max(300)
    .parse(options.leaseSeconds ?? 120);
  return {
    claim(athleteId) {
      return database.tenant(athleteId, async (tx) => {
        const leaseToken = randomUUID();
        const event = await claimTopic(tx, 'coaching.run_queued', leaseToken, leaseSeconds);
        if (!event) return null;
        const payload = z.strictObject({ runId: uuid }).parse(event.payload);
        return {
          athleteId,
          eventId: event.id,
          runId: payload.runId,
          leaseToken,
          attempts: event.attempts,
        };
      });
    },
    prepare(lease) {
      return database.tenant(lease.athleteId, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [tx.athleteId]);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,77209))', [tx.athleteId]);
        if (!(await lockWorkerLease(tx, lease))) return { kind: 'skipped' };
        const selected = await tx.query(
          'SELECT * FROM coaching_run WHERE athlete_id=$1 AND id=$2 FOR UPDATE',
          [tx.athleteId, lease.runId],
        );
        const row = selected.rows[0];
        if (!row) {
          await acknowledgeWorkerLease(tx, lease);
          return { kind: 'skipped' };
        }
        const run = decode(row);
        if (run.status.kind !== 'queued' && run.status.kind !== 'running') {
          await acknowledgeWorkerLease(tx, lease);
          return { kind: 'skipped' };
        }
        if (run.status.kind === 'running' && run.status.stage === 'validating_candidates') {
          await acknowledgeWorkerLease(tx, lease);
          return { kind: 'skipped' };
        }
        const evidence = await currentWorkerEvidence(tx, row, currentPolicy(), source);
        if (!evidence) {
          await changeWorkerStatus(tx, lease.runId, { kind: 'cancelled', reason: 'stale_basis' });
          await acknowledgeWorkerLease(tx, lease);
          return { kind: 'skipped' };
        }
        // Five attempts are allowed; the sixth claim is terminal without calling the adapter.
        if (lease.attempts > 5) {
          await changeWorkerStatus(tx, lease.runId, {
            kind: 'unable_to_evaluate',
            code: 'internal_error',
            reason: 'Evaluation could not be completed',
          });
          await acknowledgeWorkerLease(tx, lease);
          return { kind: 'skipped' };
        }
        if (run.status.kind === 'queued')
          await changeWorkerStatus(tx, lease.runId, {
            kind: 'running',
            stage: 'preparing_evidence',
          });
        if (run.status.kind === 'queued' || run.status.stage === 'preparing_evidence')
          await changeWorkerStatus(tx, lease.runId, { kind: 'running', stage: 'evaluating' });
        // Excerpts are re-read through the query-time gate here, not taken from
        // the pinned copy, so a withdrawal between run creation and evaluation
        // removes them from what the adapter ever sees.
        const grounding = await readWorkerGrounding(tx, lease.runId);
        return { kind: 'ready', evidence, grounding };
      });
    },
    finish(lease, outcome) {
      return database.tenant(lease.athleteId, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [tx.athleteId]);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,77209))', [tx.athleteId]);
        // Lease/CAS ownership is checked and locked before any output or status write.
        if (!(await lockWorkerLease(tx, lease))) return 'skipped';
        const selected = await tx.query(
          'SELECT * FROM coaching_run WHERE athlete_id=$1 AND id=$2 FOR UPDATE',
          [tx.athleteId, lease.runId],
        );
        const row = selected.rows[0];
        if (!row) {
          await acknowledgeWorkerLease(tx, lease);
          return 'skipped';
        }
        const run = decode(row);
        if (run.status.kind !== 'running' || run.status.stage !== 'evaluating') {
          await acknowledgeWorkerLease(tx, lease);
          return 'skipped';
        }
        if (!(await currentWorkerEvidence(tx, row, currentPolicy(), source))) {
          await changeWorkerStatus(tx, lease.runId, { kind: 'cancelled', reason: 'stale_basis' });
          await acknowledgeWorkerLease(tx, lease);
          return 'skipped';
        }
        if (outcome.kind === 'analysis') {
          // Citations are validated against the pinned grounding and the live
          // gate before anything is written. An ungrounded, out-of-range or no
          // longer authorized citation makes the whole output unusable rather
          // than storing an answer whose sources cannot be resolved.
          try {
            await recordRunCitations(tx, lease.runId, outcome.citations);
          } catch (error) {
            if (!(error instanceof ResourceRetrievalError)) throw error;
            await changeWorkerStatus(tx, lease.runId, {
              kind: 'unable_to_evaluate',
              code: 'invalid_output',
              reason: 'Model output could not be used',
            });
            await acknowledgeWorkerLease(tx, lease);
            return 'stored';
          }
          const outputId = randomUUID();
          const body = JSON.stringify({ schemaVersion: 1, content: outcome.content });
          const inserted =
            Buffer.byteLength(body) <= 1_000_000
              ? await tx.query(
                  `INSERT INTO coaching_analysis_output(athlete_id,id,run_id,body)
                   SELECT $1,$2,$3,$4::jsonb
                   WHERE octet_length(($4::jsonb)::text)<=1048576`,
                  [tx.athleteId, outputId, lease.runId, body],
                )
              : null;
          await changeWorkerStatus(
            tx,
            lease.runId,
            inserted?.rowCount === 1
              ? { kind: 'analysis_ready', outputId }
              : {
                  kind: 'unable_to_evaluate',
                  code: 'invalid_output',
                  reason: 'Model output could not be used',
                },
          );
        } else if (outcome.kind === 'needs_question') {
          await changeWorkerStatus(tx, lease.runId, outcome);
        } else {
          await changeWorkerStatus(tx, lease.runId, outcome);
        }
        // Failure to acknowledge rolls back both output and status in this transaction.
        await acknowledgeWorkerLease(tx, lease);
        return 'stored';
      });
    },
  };
}
