import { z } from 'zod';
import { coachingRetrievalRequestSchema } from './resource-retrieval.js';
import { trainingCoachingPolicySchema } from './coaching-basis.js';
import { trainingCandidateStrategyV1Schema } from './coaching-candidates.js';
import { instantSchema } from './primitives.js';

const uuid = z.uuid().refine((value) => value === value.toLowerCase());
const revision = z.number().int().min(1).max(2147483646);
const boundedText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim() === value && !value.includes('\0') && value.length > 0);

/** The thread ID comes from the route and the policy/source come from trusted server configuration. */
export const coachingRunCreateCommandV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  evidenceSnapshotId: uuid,
  expectedConversationRevision: revision,
  /**
   * Whether this run may read reviewed resources. Omitted means no retrieval at
   * all; the server, not the client, decides which resources are authorized.
   */
  retrieval: coachingRetrievalRequestSchema.default({ kind: 'none' }),
  idempotencyKey: boundedText(200),
});

export const coachingRunModelSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('deterministic_fixture'), fixtureId: boundedText(200) }),
  z.strictObject({
    kind: z.literal('provider'),
    providerId: boundedText(200),
    modelId: boundedText(200),
  }),
]);

/** Progress is a user-facing stage, never a model reasoning trace or validated decision. */
export const coachingRunStatusSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('queued') }),
  z.strictObject({
    kind: z.literal('running'),
    stage: z.enum(['preparing_evidence', 'evaluating', 'validating_candidates']),
  }),
  // A stored model output is not a validated Decision and cannot be approved.
  z.strictObject({ kind: z.literal('analysis_ready'), outputId: uuid }),
  z.strictObject({ kind: z.literal('needs_question'), question: boundedText(2000) }),
  z.strictObject({ kind: z.literal('validated_final'), decisionId: uuid }),
  z.strictObject({
    kind: z.literal('unable_to_evaluate'),
    code: z.enum([
      'provider_unavailable',
      'provider_rejected',
      'invalid_output',
      'stale_basis',
      'budget_exceeded',
      'internal_error',
    ]),
    reason: boundedText(500),
  }),
  z.strictObject({
    kind: z.literal('cancelled'),
    reason: z.enum(['user_requested', 'consent_withdrawn', 'source_deleted', 'stale_basis']),
  }),
]);

/** Status is authoritative only when persisted by the server. Provisional text is never a final decision. */
export const coachingRunV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: uuid,
    threadId: uuid,
    evidenceSnapshotId: uuid,
    conversationRevision: revision,
    policy: trainingCoachingPolicySchema,
    source: coachingRunModelSourceSchema,
    createdAt: instantSchema,
    updatedAt: instantSchema,
    status: coachingRunStatusSchema,
  })
  .refine((value) => Date.parse(value.updatedAt) >= Date.parse(value.createdAt), {
    message: 'Update time cannot precede creation',
    path: ['updatedAt'],
  });

const page = (max: number) => z.coerce.number().int().min(0).max(max);
export const coachingRunListQuerySchema = z.strictObject({
  limit: page(100).min(1).default(20),
  offset: page(10000).default(0),
});
export const coachingRunListSchema = z
  .strictObject({
    items: z.array(coachingRunV1Schema).max(100),
    total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .refine((value) => value.total >= value.items.length, 'Invalid total');

/** A bounded instruction from the nonproduction fixture, never an approvable plan or actual. */
export const coachingFixtureCandidateContentV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: z.literal('running-core-v2-training'),
  intent: z.strictObject({
    kind: z.literal('set_session_duration_seconds'),
    sessionId: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => value === value.trim() && !value.includes('\0')),
    durationSeconds: z.number().finite().min(0).max(604800),
  }),
  strategy: trainingCandidateStrategyV1Schema,
  summary: z.literal('Synthetic fixture duration proposal; not validated or approved.'),
});

/** Fixture analysis is untrusted material, not a candidate, Decision, or approvable plan. */
export const coachingRunOutputV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: uuid,
  outputId: uuid,
  source: z.strictObject({
    kind: z.literal('deterministic_fixture'),
    fixtureId: z.literal('synthetic-v1'),
  }),
  trust: z.literal('untrusted_fixture'),
  validation: z.literal('unvalidated'),
  content: z.json(),
});

export type CoachingRunCreateCommandV1 = z.infer<typeof coachingRunCreateCommandV1Schema>;
/** Accepted shape: `retrieval` may be omitted and defaults to no retrieval. */
export type CoachingRunCreateCommandV1Input = z.input<typeof coachingRunCreateCommandV1Schema>;
export type CoachingRunModelSource = z.infer<typeof coachingRunModelSourceSchema>;
export type CoachingRunStatus = z.infer<typeof coachingRunStatusSchema>;
export type CoachingRunV1 = z.infer<typeof coachingRunV1Schema>;
export type CoachingRunListQuery = z.infer<typeof coachingRunListQuerySchema>;
export type CoachingRunList = z.infer<typeof coachingRunListSchema>;
export type CoachingRunOutputV1 = z.infer<typeof coachingRunOutputV1Schema>;
export type CoachingFixtureCandidateContentV1 = z.infer<
  typeof coachingFixtureCandidateContentV1Schema
>;

/** A question or failure finishes this evidence-bound attempt; answering/retrying creates a new run. */
export function canTransitionCoachingRunStatus(from: unknown, to: unknown): boolean {
  const previous = coachingRunStatusSchema.safeParse(from);
  const next = coachingRunStatusSchema.safeParse(to);
  if (!previous.success || !next.success) return false;
  switch (previous.data.kind) {
    case 'queued':
      if (next.data.kind === 'running') return next.data.stage === 'preparing_evidence';
      return ['unable_to_evaluate', 'cancelled'].includes(next.data.kind);
    case 'running':
      if (next.data.kind === 'running')
        return previous.data.stage === 'preparing_evidence' && next.data.stage === 'evaluating';
      if (next.data.kind === 'analysis_ready') return previous.data.stage === 'evaluating';
      if (next.data.kind === 'validated_final')
        return previous.data.stage === 'validating_candidates';
      return ['needs_question', 'unable_to_evaluate', 'cancelled'].includes(next.data.kind);
    case 'analysis_ready':
      if (next.data.kind === 'running') return next.data.stage === 'validating_candidates';
      return ['unable_to_evaluate', 'cancelled'].includes(next.data.kind);
    case 'needs_question':
    case 'validated_final':
    case 'unable_to_evaluate':
    case 'cancelled':
      return false;
  }
}
