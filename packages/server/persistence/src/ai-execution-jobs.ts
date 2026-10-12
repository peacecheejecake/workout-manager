// M2-05a immutable AI execution-selection job store (migration 148).
// Storage only: a job never grants consent, provider dispatch, budget, restore
// admission or plan approval. M2-05b/c re-validate before any outbound request.
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  aiExecutionJobExportV1Schema,
  aiExecutionJobQueuedTopic,
  aiExecutionJobV1Schema,
  aiExecutionRunCommandV1Schema,
  aiExecutionRunReceiptV1Schema,
  type AiExecutionJobExportV1,
  type AiExecutionJobV1,
} from '@workout/contracts/ai-execution-jobs';
import { aiExecutionCatalogV1Schema } from '@workout/contracts/ai-settings';
import { coachingRunStatusSchema } from '@workout/contracts/coaching-runs';
import { trainingCoachingPolicySchema } from '@workout/contracts/coaching-basis';
import {
  digestExecutionCatalog,
  type FrozenExecutionSelection,
} from '@workout/server-coaching/coaching-execution-selection';
import {
  prepareCoachingExecutionIn,
  type CoachingExecutionPreparationBlockedCode,
} from './coaching-execution-preparation.js';
import { CoachingRunError, prepareOwnedCoachingEvidenceIn } from './coaching-runs.js';
import type { Database, Transaction } from './database.js';
import { enqueue } from './outbox.js';

export type AiExecutionJobErrorCode =
  CoachingExecutionPreparationBlockedCode | 'IDEMPOTENCY_CONFLICT' | 'RESTORE_PROCESSING_CLOSED';
export class AiExecutionJobError extends Error {
  constructor(readonly code: AiExecutionJobErrorCode) {
    super(code);
    this.name = 'AiExecutionJobError';
  }
}

export interface AiExecutionJobRepository {
  create(athleteId: string, threadId: string, command: unknown): Promise<AiExecutionJobV1>;
  read(athleteId: string, jobId: string): Promise<AiExecutionJobV1 | null>;
}
export interface AiExecutionJobRepositoryOptions {
  /** Trusted server configuration only. */
  readonly policy: unknown;
  /** Trusted local adapter registry; empty means no job can be frozen. */
  readonly registry: unknown;
  /** Classifies owned evidence. Conservative default: everything is `health`,
   * so a synthetic-comparison job is refused unless a trusted classifier says
   * the payload is synthetic-only. */
  readonly classifyEvidenceIn?: (transaction: Transaction, evidence: unknown) => Promise<unknown>;
}

const uuid = z.uuid().refine((value) => value === value.toLowerCase());
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/** Same canonical encoding as the execution-selection helper (sorted keys). */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`;
}
/** Recomputes execution-selection-v1's digest over an exact frozen draft. */
export function digestFrozenExecutionDraft(draft: FrozenExecutionSelection['draft']): string {
  return sha256(canonical({ definitionVersion: 'execution-selection-v1', draft }));
}

const version = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const revision = z.number().int().min(1).max(2_147_483_647);
const rowSchema = z.strictObject({
  job_id: uuid,
  run_id: uuid,
  thread_id: uuid,
  evidence_snapshot_id: uuid,
  command_version: z.literal(1),
  selection_version: z.literal(1),
  purpose: z.enum(['coaching', 'synthetic_comparison']),
  payload_classification: z.enum(['health', 'synthetic_only']),
  settings_revision: revision,
  catalog_revision: revision,
  catalog_digest: hex,
  policy_version: version,
  disclosure_version: version,
  recipient_id: version,
  recipient_disclosure_version: version,
  provider_id: z.string(),
  model_id: z.string(),
  adapter_binding_version: version,
  vendor_model_ref: version,
  price_model_ref: version,
  price_version: version,
  tokenizer_version: version,
  app_consent_revision: revision,
  app_consent_digest: hex,
  ai_consent_revision: revision,
  ai_consent_digest: hex,
  selection_digest: hex,
  created_at: z.date(),
  run_status: z.unknown(),
  catalog_definition: z.unknown(),
});
const jobColumns = `j.job_id,j.run_id,j.thread_id,j.evidence_snapshot_id,j.command_version,j.selection_version,
 j.purpose,j.payload_classification,j.settings_revision,j.catalog_revision,j.catalog_digest,j.policy_version,
 j.disclosure_version,j.recipient_id,j.recipient_disclosure_version,j.provider_id,j.model_id,
 j.adapter_binding_version,j.vendor_model_ref,j.price_model_ref,j.price_version,j.tokenizer_version,
 j.app_consent_revision,j.app_consent_digest,j.ai_consent_revision,j.ai_consent_digest,j.selection_digest,
 j.created_at,r.status AS run_status,d.definition AS catalog_definition`;
const jobFrom = `FROM public.ai_execution_job j
 JOIN public.coaching_run r ON r.athlete_id=j.athlete_id AND r.id=j.run_id
 JOIN public.ai_settings_catalog_definition d ON d.catalog_revision=j.catalog_revision`;

export class AiExecutionJobIntegrityError extends Error {
  constructor() {
    super('AI_EXECUTION_JOB_INTEGRITY');
    this.name = 'AiExecutionJobIntegrityError';
  }
}

export interface StoredAiExecutionJob {
  readonly job: AiExecutionJobV1;
  /** Reconstructed exact frozen selection; inspect with live facts before use. */
  readonly frozen: FrozenExecutionSelection;
  readonly consentRevisions: { readonly app: number; readonly ai: number };
}

/** Decode and re-verify a stored row. A digest or catalog mismatch fails closed. */
function decodeStored(value: unknown): StoredAiExecutionJob {
  const parsed = rowSchema.safeParse(value);
  if (!parsed.success) throw new AiExecutionJobIntegrityError();
  const row = parsed.data;
  const catalog = aiExecutionCatalogV1Schema.safeParse(row.catalog_definition);
  if (!catalog.success || digestExecutionCatalog(catalog.data) !== row.catalog_digest)
    throw new AiExecutionJobIntegrityError();
  const draft = {
    schemaVersion: 1 as const,
    settingsRevision: row.settings_revision,
    catalogRevision: row.catalog_revision,
    catalogDigest: row.catalog_digest,
    policyVersion: row.policy_version,
    disclosureVersion: row.disclosure_version,
    recipientId: row.recipient_id,
    recipientDisclosureVersion: row.recipient_disclosure_version,
    payloadClassification: row.payload_classification,
    permissions: {
      app: { revision: row.app_consent_revision, digest: row.app_consent_digest, enabled: true },
      ai: { revision: row.ai_consent_revision, digest: row.ai_consent_digest, enabled: true },
    },
    binding: {
      selection: { providerId: row.provider_id, modelId: row.model_id },
      purpose: row.purpose,
      adapterBindingVersion: row.adapter_binding_version,
      vendorModelRef: row.vendor_model_ref,
      priceModelRef: row.price_model_ref,
      priceVersion: row.price_version,
      tokenizerVersion: row.tokenizer_version,
    },
  };
  if (digestFrozenExecutionDraft(draft) !== row.selection_digest)
    throw new AiExecutionJobIntegrityError();
  const status = coachingRunStatusSchema.safeParse(row.run_status);
  if (!status.success) throw new AiExecutionJobIntegrityError();
  const job = aiExecutionJobV1Schema.safeParse({
    schemaVersion: 1,
    jobId: row.job_id,
    runId: row.run_id,
    threadId: row.thread_id,
    evidenceSnapshotId: row.evidence_snapshot_id,
    commandVersion: 1,
    purpose: row.purpose,
    payloadClassification: row.payload_classification,
    selection: { providerId: row.provider_id, modelId: row.model_id },
    settingsRevision: row.settings_revision,
    catalogRevision: row.catalog_revision,
    policyVersion: row.policy_version,
    disclosureVersion: row.disclosure_version,
    recipient: {
      recipientId: row.recipient_id,
      disclosureVersion: row.recipient_disclosure_version,
    },
    binding: {
      adapterBindingVersion: row.adapter_binding_version,
      vendorModelRef: row.vendor_model_ref,
      priceModelRef: row.price_model_ref,
      priceVersion: row.price_version,
      tokenizerVersion: row.tokenizer_version,
    },
    selectionDigest: row.selection_digest,
    createdAt: row.created_at.toISOString(),
    runStatus: status.data,
    dispatchAuthority: 'none',
  });
  if (!job.success) throw new AiExecutionJobIntegrityError();
  return {
    job: job.data,
    frozen: { draft, selectionDigest: row.selection_digest },
    consentRevisions: { app: row.app_consent_revision, ai: row.ai_consent_revision },
  };
}

/** Caller owns the authenticated tenant transaction. Read-only; no admission. */
export async function readAiExecutionJobIn(
  transaction: Transaction,
  jobId: string,
): Promise<StoredAiExecutionJob | null> {
  const id = uuid.parse(jobId);
  const result = await transaction.query(
    `SELECT ${jobColumns} ${jobFrom} WHERE j.athlete_id=$1 AND j.job_id=$2`,
    [transaction.athleteId, id],
  );
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw new AiExecutionJobIntegrityError();
  return decodeStored(result.rows[0]);
}

/** Personal export section. Caller owns the (snapshot) tenant transaction and
 * locks. Deterministic order: creation time, then job id. */
export async function exportAiExecutionJobsIn(
  transaction: Transaction,
): Promise<AiExecutionJobExportV1> {
  const result = await transaction.query(
    `SELECT ${jobColumns} ${jobFrom} WHERE j.athlete_id=$1 ORDER BY j.created_at,j.job_id`,
    [transaction.athleteId],
  );
  return aiExecutionJobExportV1Schema.parse({
    schemaVersion: 1,
    kind: 'ai_execution_jobs',
    items: result.rows.map((row) => {
      const { job, consentRevisions } = decodeStored(row);
      return {
        jobId: job.jobId,
        runId: job.runId,
        threadId: job.threadId,
        evidenceSnapshotId: job.evidenceSnapshotId,
        commandVersion: job.commandVersion,
        purpose: job.purpose,
        payloadClassification: job.payloadClassification,
        selection: job.selection,
        settingsRevision: job.settingsRevision,
        catalogRevision: job.catalogRevision,
        policyVersion: job.policyVersion,
        disclosureVersion: job.disclosureVersion,
        recipient: job.recipient,
        binding: job.binding,
        consentRevisions,
        selectionDigest: job.selectionDigest,
        createdAt: job.createdAt,
      };
    }),
  });
}

const closedFailure = z.object({
  code: z.literal('P0001'),
  message: z.enum(['RESTORE_PROCESSING_CLOSED', 'RESTORE_PROCESSING_CONTROL_MISSING']),
});
/** Same predicate as the SQL guard: CLOSED control, no pending restore target and the
 * current restore generation. Authoring permission only; never dispatch admission. */
async function requireAuthoringTarget(transaction: Transaction): Promise<void> {
  try {
    const result = await transaction.query(
      `SELECT c->>'state'='CLOSED' AND c->'targetNonce'='null'::jsonb AND c->'targetIncarnation'='null'::jsonb
        AND c->>'generationId'=public.current_restore_generation()::text AS open_for_authoring
       FROM public.read_restore_processing_admission() c`,
    );
    if (result.rows[0]?.['open_for_authoring'] !== true)
      throw new AiExecutionJobError('RESTORE_PROCESSING_CLOSED');
  } catch (error) {
    if (closedFailure.safeParse(error).success)
      throw new AiExecutionJobError('RESTORE_PROCESSING_CLOSED');
    throw error;
  }
}

export function createAiExecutionJobRepository(
  database: Database,
  options: AiExecutionJobRepositoryOptions,
): AiExecutionJobRepository {
  const policy = trainingCoachingPolicySchema.parse(options.policy);
  const classifyEvidenceIn = options.classifyEvidenceIn ?? (async () => 'health');
  return {
    read: (athleteId, jobId) =>
      database.tenant(athleteId, async (transaction) => {
        const stored = await readAiExecutionJobIn(transaction, jobId);
        return stored?.job ?? null;
      }),
    create(athleteId, threadId, input) {
      const thread = uuid.parse(threadId);
      const command = aiExecutionRunCommandV1Schema.parse(input);
      const { idempotencyKey, ...body } = command;
      const receiptKey = `ai-execution:run:v1:${sha256(idempotencyKey)}`;
      const request = {
        version: 1,
        sha256: sha256(canonical({ action: 'ai-execution:run', threadId: thread, ...body })),
      };
      return database.tenant(athleteId, async (transaction) => {
        // Global→lifecycle are held by Database.tenant; tenant0 then coaching77209.
        await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          athleteId,
        ]);
        await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1,77209))', [
          athleteId,
        ]);
        const prior = await transaction.query(
          `SELECT request=$3::jsonb AS matches,result FROM public.command_receipt
           WHERE athlete_id=$1 AND idempotency_key=$2`,
          [athleteId, receiptKey, JSON.stringify(request)],
        );
        if (prior.rows.length > 0) {
          const previous = z
            .strictObject({ matches: z.boolean(), result: z.unknown() })
            .parse(prior.rows[0]);
          if (!previous.matches) throw new AiExecutionJobError('IDEMPOTENCY_CONFLICT');
          const receipt = aiExecutionRunReceiptV1Schema.parse(previous.result);
          const stored = await readAiExecutionJobIn(transaction, receipt.jobId);
          if (
            !stored ||
            stored.job.runId !== receipt.runId ||
            stored.job.selectionDigest !== receipt.selectionDigest
          )
            throw new AiExecutionJobIntegrityError();
          // Exact replay precedes restore/consent/catalog gates and writes nothing.
          return stored.job;
        }
        await requireAuthoringTarget(transaction);
        const prepared = await prepareCoachingExecutionIn(
          transaction,
          {
            threadId: thread,
            evidenceSnapshotId: command.evidenceSnapshotId,
            expectedConversationRevision: command.expectedConversationRevision,
            settings: command.settings,
            purpose: command.purpose,
          },
          { policy, registry: options.registry, classifyEvidenceIn },
        );
        if (prepared.kind === 'blocked') throw new AiExecutionJobError(prepared.code);
        const { draft, selectionDigest } = prepared.frozen;
        if (digestFrozenExecutionDraft(draft) !== selectionDigest)
          throw new AiExecutionJobIntegrityError();
        let basis: unknown;
        try {
          // Same transaction and locks as the preparation above: no retrieval, no writes.
          ({ basis } = await prepareOwnedCoachingEvidenceIn(
            transaction,
            thread,
            {
              schemaVersion: 1,
              evidenceSnapshotId: command.evidenceSnapshotId,
              expectedConversationRevision: command.expectedConversationRevision,
              retrieval: { kind: 'none' },
            },
            policy,
          ));
        } catch (error) {
          if (error instanceof CoachingRunError) throw new AiExecutionJobError(error.code);
          throw error;
        }
        const runId = randomUUID();
        const jobId = randomUUID();
        const selection = draft.binding.selection;
        // Not inside a savepoint: the SQL guard requires the run's xmin to be this
        // top-level transaction, so no historical run can be adopted.
        await transaction.query(
          `INSERT INTO public.coaching_run(athlete_id,id,thread_id,evidence_snapshot_id,conversation_revision,policy,source,basis)
           VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb)`,
          [
            athleteId,
            runId,
            thread,
            command.evidenceSnapshotId,
            command.expectedConversationRevision,
            JSON.stringify(policy),
            JSON.stringify({
              kind: 'provider',
              providerId: selection.providerId,
              modelId: selection.modelId,
            }),
            JSON.stringify(basis),
          ],
        );
        await transaction.query(
          `INSERT INTO public.ai_execution_job(athlete_id,job_id,run_id,thread_id,evidence_snapshot_id,
            command_version,selection_version,purpose,payload_classification,settings_revision,catalog_revision,
            catalog_digest,policy_version,disclosure_version,recipient_id,recipient_disclosure_version,
            provider_id,model_id,adapter_binding_version,vendor_model_ref,price_model_ref,price_version,
            tokenizer_version,app_consent_revision,app_consent_digest,ai_consent_revision,ai_consent_digest,
            selection_digest,restore_generation_id,receipt_key,request_digest)
           VALUES($1,$2,$3,$4,$5,1,1,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,
            $26,public.current_restore_generation(),$27,$28)`,
          [
            athleteId,
            jobId,
            runId,
            thread,
            command.evidenceSnapshotId,
            draft.binding.purpose,
            draft.payloadClassification,
            draft.settingsRevision,
            draft.catalogRevision,
            draft.catalogDigest,
            draft.policyVersion,
            draft.disclosureVersion,
            draft.recipientId,
            draft.recipientDisclosureVersion,
            selection.providerId,
            selection.modelId,
            draft.binding.adapterBindingVersion,
            draft.binding.vendorModelRef,
            draft.binding.priceModelRef,
            draft.binding.priceVersion,
            draft.binding.tokenizerVersion,
            draft.permissions.app.revision,
            draft.permissions.app.digest,
            draft.permissions.ai.revision,
            draft.permissions.ai.digest,
            selectionDigest,
            receiptKey,
            request.sha256,
          ],
        );
        await enqueue(transaction, {
          id: randomUUID(),
          idempotencyKey: receiptKey,
          topic: aiExecutionJobQueuedTopic,
          payload: { schemaVersion: 1, jobId, runId },
        });
        const receipt = aiExecutionRunReceiptV1Schema.parse({
          schemaVersion: 1,
          commandVersion: 1,
          jobId,
          runId,
          selectionDigest,
        });
        await transaction.query(
          `INSERT INTO public.command_receipt(athlete_id,idempotency_key,request,result)
           VALUES($1,$2,$3::jsonb,$4::jsonb)`,
          [athleteId, receiptKey, JSON.stringify(request), JSON.stringify(receipt)],
        );
        const stored = await readAiExecutionJobIn(transaction, jobId);
        if (!stored) throw new AiExecutionJobIntegrityError();
        // Database.tenant resolves only after COMMIT, including the deferred
        // receipt/outbox atomicity check. No provider, budget or lease work here.
        return stored.job;
      });
    },
  };
}
