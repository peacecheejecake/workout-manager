import { z } from 'zod';
import { aiModelPurposeV1Schema, aiSelectionV1Schema } from './ai-settings.js';
import { coachingRunStatusSchema } from './coaching-runs.js';
import { instantSchema } from './primitives.js';
import { hasUnsafeCharacter } from './tracks.js';

// M2-05a versioned AI execution command/receipt and immutable job view.
// A stored job is a frozen selection only: it never grants consent, provider
// dispatch, budget reservation, restore admission or plan approval.

const uuid = z.uuid().refine((value) => value === value.toLowerCase());
const int4Revision = z.number().int().min(1).max(2_147_483_647);
const conversationRevision = z.number().int().min(1).max(2_147_483_646);
const definitionVersion = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const idempotencyKey = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value === value.trim() && !hasUnsafeCharacter(value));

/** The explicit immutable settings revision the user asked to run with. Never the
 * moving head: a later preference never replaces it. */
export const aiExecutionSettingsReferenceV1Schema = z.strictObject({
  revision: int4Revision,
  catalogRevision: int4Revision,
  policyVersion: definitionVersion,
  disclosureVersion: definitionVersion,
});

/** Thread comes from the route; policy, registry and classification come from
 * trusted server configuration, never from the browser. Retrieval is not part of
 * command v1 (no resource excerpt is pinned by a v1 job). */
export const aiExecutionRunCommandV1Schema = z.strictObject({
  commandVersion: z.literal(1),
  evidenceSnapshotId: uuid,
  expectedConversationRevision: conversationRevision,
  purpose: aiModelPurposeV1Schema,
  settings: aiExecutionSettingsReferenceV1Schema,
  idempotencyKey,
});

/** Stored in command_receipt.result; SQL checks the exact shape at commit. */
export const aiExecutionRunReceiptV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  commandVersion: z.literal(1),
  jobId: uuid,
  runId: uuid,
  selectionDigest: digest,
});

/** Durable outbox payload of topic `coaching.execution_job_queued`. A consumer
 * must still re-validate everything (M2-05b) before any outbound request. */
export const aiExecutionJobQueuedPayloadV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  jobId: uuid,
  runId: uuid,
});
export const aiExecutionJobQueuedTopic = 'coaching.execution_job_queued' as const;

/** Append-only terminal disposition. `restore_cancelled`: restored from another
 * restore generation; never resumed, a new explicit command is required. */
export const aiExecutionJobDispositionV1Schema = z.strictObject({
  kind: z.literal('restore_cancelled'),
  decidedAt: instantSchema,
});

export const aiExecutionBindingV1Schema = z.strictObject({
  adapterBindingVersion: definitionVersion,
  vendorModelRef: definitionVersion,
  priceModelRef: definitionVersion,
  priceVersion: definitionVersion,
  tokenizerVersion: definitionVersion,
});

/** Public read projection. `dispatchAuthority` is always `none`: storage is not admission. */
export const aiExecutionJobV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  jobId: uuid,
  runId: uuid,
  threadId: uuid,
  evidenceSnapshotId: uuid,
  commandVersion: z.literal(1),
  purpose: aiModelPurposeV1Schema,
  payloadClassification: z.enum(['health', 'synthetic_only']),
  selection: aiSelectionV1Schema,
  settingsRevision: int4Revision,
  catalogRevision: int4Revision,
  policyVersion: definitionVersion,
  disclosureVersion: definitionVersion,
  recipient: z.strictObject({
    recipientId: definitionVersion,
    disclosureVersion: definitionVersion,
  }),
  binding: aiExecutionBindingV1Schema,
  selectionDigest: digest,
  createdAt: instantSchema,
  runStatus: coachingRunStatusSchema,
  disposition: aiExecutionJobDispositionV1Schema.nullable(),
  dispatchAuthority: z.literal('none'),
});

/** Personal export item: frozen selection facts only; no internal receipt key,
 * request digest, consent digest or target-local restore generation. */
export const aiExecutionJobExportItemV1Schema = z.strictObject({
  jobId: uuid,
  runId: uuid,
  threadId: uuid,
  evidenceSnapshotId: uuid,
  commandVersion: z.literal(1),
  purpose: aiModelPurposeV1Schema,
  payloadClassification: z.enum(['health', 'synthetic_only']),
  selection: aiSelectionV1Schema,
  settingsRevision: int4Revision,
  catalogRevision: int4Revision,
  policyVersion: definitionVersion,
  disclosureVersion: definitionVersion,
  recipient: z.strictObject({
    recipientId: definitionVersion,
    disclosureVersion: definitionVersion,
  }),
  binding: aiExecutionBindingV1Schema,
  consentRevisions: z.strictObject({ app: int4Revision, ai: int4Revision }),
  selectionDigest: digest,
  createdAt: instantSchema,
  disposition: aiExecutionJobDispositionV1Schema.nullable(),
});
export const aiExecutionJobExportV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal('ai_execution_jobs'),
    items: z.array(aiExecutionJobExportItemV1Schema).max(100_000),
  })
  .superRefine((value, context) => {
    const ids = value.items.map((item) => item.jobId);
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: 'custom', message: 'Duplicate job', path: ['items'] });
  });

export type AiExecutionRunCommandV1 = z.infer<typeof aiExecutionRunCommandV1Schema>;
export type AiExecutionRunReceiptV1 = z.infer<typeof aiExecutionRunReceiptV1Schema>;
export type AiExecutionJobV1 = z.infer<typeof aiExecutionJobV1Schema>;
export type AiExecutionJobExportV1 = z.infer<typeof aiExecutionJobExportV1Schema>;
export type AiExecutionJobDispositionV1 = z.infer<typeof aiExecutionJobDispositionV1Schema>;
export type AiExecutionJobQueuedPayloadV1 = z.infer<typeof aiExecutionJobQueuedPayloadV1Schema>;
