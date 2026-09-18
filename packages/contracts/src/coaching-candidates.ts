import { z } from 'zod';
import { trainingCoachingBasisV1Schema } from './coaching-basis.js';
import {
  periodDraftSchema,
  planDraftSchema,
  plannedSessionSchema,
  planSnapshotSchema,
} from './planning.js';
import { instantSchema, localDateSchema } from './primitives.js';

const uuid = z.uuid().refine((value) => value === value.toLowerCase());
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !value.includes('\0'));
const uniqueIds = z
  .array(uuid)
  .max(20)
  .refine((ids) => new Set(ids).size === ids.length);

/** Describes a proposed change. It is neither a clinical conclusion nor approval authority. */
export const trainingCandidateStrategyV1Schema = z.strictObject({
  summary: text(500),
  preservedIntent: text(1000),
  rationale: text(2000),
  unconfirmedInformation: z.array(text(500)).max(20),
  revisitWhen: text(1000),
});

export const trainingCandidateIssueV1Schema = z.strictObject({
  code: z.enum([
    'NO_CHANGE',
    'PLAN_VERSION_MISMATCH',
    'PLAN_TIMEZONE_CHANGED',
    'SESSION_LOCKED',
    'COMPLETED_SESSION_CHANGED',
    'PAST_SESSION_CHANGED',
    'PAST_PERIOD_CHANGED',
    'CONSTRAINT_UNAVAILABLE',
    'CONSTRAINT_TIME_EXCEEDED',
    'CONSTRAINT_TIME_UNCERTAIN',
    'TARGET_UNKNOWN',
    'PREEXISTING_CONSTRAINT_CONFLICT',
  ]),
  subject: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('plan') }),
    z.strictObject({ kind: z.literal('session'), id: z.string().min(1).max(200) }),
    z.strictObject({ kind: z.literal('date'), date: localDateSchema }),
  ]),
});

/** `checked` only means these bounded structural checks ran; it does not authorize a write. */
export const trainingCandidateValidationV1Schema = z
  .strictObject({
    definitionVersion: z.literal('training-candidate-validation-v1'),
    status: z.enum(['checked', 'uncertain', 'invalid']),
    // A bounded 1000-session plan may surface several independent issues per session.
    errors: z.array(trainingCandidateIssueV1Schema).max(10000),
    warnings: z.array(trainingCandidateIssueV1Schema).max(10000),
    unknowns: z.array(trainingCandidateIssueV1Schema).max(10000),
  })
  .refine(
    (value) =>
      value.status ===
      (value.errors.length > 0 ? 'invalid' : value.unknowns.length > 0 ? 'uncertain' : 'checked'),
    'Validation status must agree with issues',
  );

export const trainingCandidateSessionChangeV1Schema = z
  .strictObject({
    id: z.string().min(1).max(200),
    kind: z.enum(['added', 'removed', 'modified']),
    before: plannedSessionSchema.nullable(),
    after: plannedSessionSchema.nullable(),
  })
  .refine(
    (change) =>
      (change.before === null || change.before.id === change.id) &&
      (change.after === null || change.after.id === change.id) &&
      (change.kind === 'added'
        ? change.before === null && change.after !== null
        : change.kind === 'removed'
          ? change.before !== null && change.after === null
          : change.before !== null && change.after !== null),
    'Session change must match its kind and identity',
  );

export const trainingCandidatePeriodChangeV1Schema = z
  .strictObject({
    id: z.string().min(1).max(200),
    kind: z.enum(['added', 'removed', 'modified']),
    before: periodDraftSchema.nullable(),
    after: periodDraftSchema.nullable(),
  })
  .refine(
    (change) =>
      (change.before === null || change.before.id === change.id) &&
      (change.after === null || change.after.id === change.id) &&
      (change.kind === 'added'
        ? change.before === null && change.after !== null
        : change.kind === 'removed'
          ? change.before !== null && change.after === null
          : change.before !== null && change.after !== null),
    'Period change must match its kind and identity',
  );

const targetSummary = (unit: 's' | 'm') =>
  z
    .strictObject({
      unit: z.literal(unit),
      knownMin: z.number().finite().nonnegative(),
      knownMax: z.number().finite().nonnegative(),
      unknownSessionIds: z.array(z.string().min(1).max(200)).max(1000),
    })
    .refine((value) => value.knownMin <= value.knownMax);
const delta = (unit: 's' | 'm') =>
  z
    .strictObject({
      unit: z.literal(unit),
      min: z.number().finite(),
      max: z.number().finite(),
    })
    .refine((value) => value.min <= value.max);
const impact = (unit: 's' | 'm') =>
  z
    .strictObject({
      before: targetSummary(unit),
      after: targetSummary(unit),
      delta: delta(unit).nullable(),
    })
    .refine(
      (value) =>
        (value.delta === null) ===
        (value.before.unknownSessionIds.length > 0 || value.after.unknownSessionIds.length > 0),
      'Incomplete target totals cannot have a total delta',
    );

export const trainingCandidateDiffV1Schema = z.strictObject({
  definitionVersion: z.literal('training-candidate-diff-v1'),
  title: z.strictObject({ before: z.string(), after: z.string() }).nullable(),
  periodChanges: z.array(trainingCandidatePeriodChangeV1Schema).max(200),
  sessionChanges: z.array(trainingCandidateSessionChangeV1Schema).max(2000),
  duration: impact('s'),
  distance: impact('m'),
});

/** Unsealed deterministic projection. A server persistence step must bind IDs and digest. */
export const trainingCandidateDraftV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    scope: z.literal('running-core-v2-training'),
    basis: trainingCoachingBasisV1Schema,
    before: planSnapshotSchema,
    proposed: planDraftSchema,
    /** Server-local calendar date in the plan timezone used by validation. */
    asOfLocalDate: localDateSchema,
    strategy: trainingCandidateStrategyV1Schema,
    diff: trainingCandidateDiffV1Schema,
    validation: trainingCandidateValidationV1Schema,
  })
  .refine((value) => value.before.id === value.basis.planVersionId, {
    message: 'Candidate must use the pinned plan version',
    path: ['before'],
  });

const digest = z.string().regex(/^[0-9a-f]{64}$/);
export const trainingCandidateV1Schema = trainingCandidateDraftV1Schema.safeExtend({
  id: uuid,
  proposalId: uuid,
  decisionId: uuid,
  runId: uuid,
  createdAt: instantSchema,
  digest,
});

export const trainingDecisionV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: z.literal('running-core-v2-training'),
  id: uuid,
  runId: uuid,
  basis: trainingCoachingBasisV1Schema,
  strategy: trainingCandidateStrategyV1Schema,
  createdAt: instantSchema,
});

export const trainingProposalV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: z.literal('running-core-v2-training'),
  id: uuid,
  runId: uuid,
  decisionId: uuid,
  candidateIds: uniqueIds.min(1),
  createdAt: instantSchema,
});

export const trainingCandidateBundleV1Schema = z
  .strictObject({
    decision: trainingDecisionV1Schema,
    proposal: trainingProposalV1Schema,
    candidate: trainingCandidateV1Schema,
  })
  .refine(
    ({ decision, proposal, candidate }) =>
      proposal.decisionId === decision.id &&
      candidate.decisionId === decision.id &&
      candidate.proposalId === proposal.id &&
      candidate.runId === decision.runId &&
      proposal.runId === decision.runId &&
      proposal.candidateIds.includes(candidate.id),
    'Candidate bundle must bind one decision, proposal and candidate',
  );

export type TrainingCandidateStrategyV1 = z.infer<typeof trainingCandidateStrategyV1Schema>;
export type TrainingCandidateIssueV1 = z.infer<typeof trainingCandidateIssueV1Schema>;
export type TrainingCandidateValidationV1 = z.infer<typeof trainingCandidateValidationV1Schema>;
export type TrainingCandidateDiffV1 = z.infer<typeof trainingCandidateDiffV1Schema>;
export type TrainingCandidateDraftV1 = z.infer<typeof trainingCandidateDraftV1Schema>;
export type TrainingCandidateV1 = z.infer<typeof trainingCandidateV1Schema>;
export type TrainingDecisionV1 = z.infer<typeof trainingDecisionV1Schema>;
export type TrainingProposalV1 = z.infer<typeof trainingProposalV1Schema>;
export type TrainingCandidateBundleV1 = z.infer<typeof trainingCandidateBundleV1Schema>;
