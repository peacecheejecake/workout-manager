import { z } from 'zod';
import {
  compareCoreEvidenceDependencies,
  compareResourceAccessDependencies,
  coreEvidenceDependencyManifestV2Schema,
  type CoreEvidenceDependencyField,
  type ResourceAccessDependencyField,
} from './evidence-dependencies.js';
import { coachingRetrievalBasisSchema, type CoachingRetrievalBasis } from './resource-retrieval.js';
import {
  coreEvidenceSnapshotMetadataSchema,
  coreEvidenceSnapshotSchema,
} from './evidence-snapshots.js';
import { idSchema } from './primitives.js';

const uuid = z.uuid().refine((value) => value === value.toLowerCase());
const athleteId = coreEvidenceDependencyManifestV2Schema.shape.athleteId;
const revision = z.number().int().min(1).max(2147483646);

/** Server-owned policy identity. A client-provided value does not establish policy authority. */
export const trainingCoachingPolicySchema = z.strictObject({
  id: idSchema.max(200),
  version: idSchema.max(200),
});

/** Narrow read basis for the running-core-v2, training-only path. Not approval authority. */
export const trainingCoachingBasisV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    scope: z.literal('running-core-v2-training'),
    athleteId,
    evidenceSnapshotId: uuid,
    threadId: uuid,
    conversationRevision: revision,
    planVersionId: uuid,
    dependencies: coreEvidenceDependencyManifestV2Schema,
    policy: trainingCoachingPolicySchema,
    retrieval: coachingRetrievalBasisSchema,
  })
  .superRefine((value, context) => {
    if (value.dependencies.athleteId !== value.athleteId)
      context.addIssue({ code: 'custom', message: 'Dependency owner mismatch' });
    if (value.retrieval.kind === 'resource-access-v1') {
      // Retrieval is only ever pinned for the same tenant, and only while AI
      // consent is granted; a withdrawn consent authorizes no excerpt at all.
      if (value.retrieval.manifest.athleteId !== value.athleteId)
        context.addIssue({ code: 'custom', message: 'Retrieval owner mismatch' });
      if (!value.retrieval.manifest.aiConsentGranted)
        context.addIssue({ code: 'custom', message: 'Granted AI consent is required' });
    }
    if (
      value.dependencies.trainingPlan.kind !== 'exists' ||
      value.dependencies.trainingPlan.versionId !== value.planVersionId
    )
      context.addIssue({ code: 'custom', message: 'Current plan head must match pinned plan' });
    if (value.dependencies.aiConsent.kind !== 'exists' || !value.dependencies.aiConsent.granted)
      context.addIssue({ code: 'custom', message: 'Granted AI consent is required' });
  });

/** A fresh observation is still only a read comparison; approval must recheck in its write transaction. */
export const trainingCoachingBasisObservationV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    scope: z.literal('running-core-v2-training'),
    athleteId,
    evidence: coreEvidenceSnapshotMetadataSchema,
    conversationRevision: revision,
    dependencies: coreEvidenceDependencyManifestV2Schema,
    policy: trainingCoachingPolicySchema,
    retrieval: coachingRetrievalBasisSchema,
  })
  .superRefine((value, context) => {
    if (value.dependencies.athleteId !== value.athleteId)
      context.addIssue({ code: 'custom', message: 'Dependency owner mismatch' });
  });

export type TrainingCoachingBasisV1 = z.infer<typeof trainingCoachingBasisV1Schema>;
export type TrainingCoachingBasisObservationV1 = z.infer<
  typeof trainingCoachingBasisObservationV1Schema
>;
export type TrainingCoachingBasisBuildResult =
  | { ok: true; basis: TrainingCoachingBasisV1 }
  | {
      ok: false;
      reason:
        | 'INVALID_INPUT'
        | 'EVIDENCE_UNAVAILABLE'
        | 'UNSUPPORTED_EVIDENCE_VERSION'
        | 'OWNER_MISMATCH'
        | 'PINNED_PLAN_NOT_CURRENT'
        | 'AI_CONSENT_REQUIRED';
    };

const buildInputSchema = z.strictObject({
  athleteId,
  snapshot: coreEvidenceSnapshotSchema,
  policy: trainingCoachingPolicySchema,
  /** Omitted for a run that reads no resource at all. */
  retrieval: coachingRetrievalBasisSchema.default({ kind: 'none' }),
});

/** Derives a candidate read basis; it does not send data to a model or permit plan writes. */
export function buildTrainingCoachingBasis(input: unknown): TrainingCoachingBasisBuildResult {
  const result = buildInputSchema.safeParse(input);
  if (!result.success) return { ok: false, reason: 'INVALID_INPUT' };
  const { athleteId: owner, snapshot, policy } = result.data;
  if (snapshot.status !== 'available') return { ok: false, reason: 'EVIDENCE_UNAVAILABLE' };
  if (snapshot.body.schemaVersion !== 2)
    return { ok: false, reason: 'UNSUPPORTED_EVIDENCE_VERSION' };
  const { body } = snapshot;
  if (body.dependencies.athleteId !== owner) return { ok: false, reason: 'OWNER_MISMATCH' };
  if (
    body.dependencies.trainingPlan.kind !== 'exists' ||
    body.dependencies.trainingPlan.versionId !== body.plan.id
  )
    return { ok: false, reason: 'PINNED_PLAN_NOT_CURRENT' };
  if (body.dependencies.aiConsent.kind !== 'exists' || !body.dependencies.aiConsent.granted)
    return { ok: false, reason: 'AI_CONSENT_REQUIRED' };
  const basis = trainingCoachingBasisV1Schema.safeParse({
    schemaVersion: 1,
    scope: 'running-core-v2-training',
    athleteId: owner,
    evidenceSnapshotId: snapshot.id,
    threadId: snapshot.threadId,
    conversationRevision: body.thread.revision,
    planVersionId: body.plan.id,
    dependencies: body.dependencies,
    policy,
    retrieval: result.data.retrieval,
  });
  return basis.success ? { ok: true, basis: basis.data } : { ok: false, reason: 'INVALID_INPUT' };
}

export type TrainingCoachingBasisChange =
  | 'evidence'
  | 'conversation'
  | 'policy'
  | 'retrieval'
  | `dependencies.${CoreEvidenceDependencyField}`
  | `retrieval.${ResourceAccessDependencyField}`;
export type TrainingCoachingBasisComparison =
  | { status: 'fresh'; changed: [] }
  | { status: 'stale'; changed: TrainingCoachingBasisChange[] }
  | {
      status: 'unsupported';
      reason: 'INVALID_OR_UNSUPPORTED_BASIS' | 'OWNER_MISMATCH' | 'EVIDENCE_IDENTITY_MISMATCH';
    };

/** Read-only freshness signal. Callers must revalidate authorization and all dependencies in a write transaction. */
export function compareTrainingCoachingBasis(
  expected: unknown,
  current: unknown,
): TrainingCoachingBasisComparison {
  const before = trainingCoachingBasisV1Schema.safeParse(expected);
  const after = trainingCoachingBasisObservationV1Schema.safeParse(current);
  if (!before.success || !after.success)
    return { status: 'unsupported', reason: 'INVALID_OR_UNSUPPORTED_BASIS' };
  const basis = before.data;
  const observed = after.data;
  if (basis.athleteId !== observed.athleteId)
    return { status: 'unsupported', reason: 'OWNER_MISMATCH' };
  if (
    basis.evidenceSnapshotId !== observed.evidence.id ||
    basis.threadId !== observed.evidence.threadId
  )
    return { status: 'unsupported', reason: 'EVIDENCE_IDENTITY_MISMATCH' };
  const dependencies = compareCoreEvidenceDependencies(basis.dependencies, observed.dependencies);
  if (dependencies.status === 'unsupported')
    return { status: 'unsupported', reason: 'INVALID_OR_UNSUPPORTED_BASIS' };
  const changed: TrainingCoachingBasisChange[] = [];
  if (observed.evidence.status !== 'available') changed.push('evidence');
  if (basis.conversationRevision !== observed.conversationRevision) changed.push('conversation');
  if (basis.policy.id !== observed.policy.id || basis.policy.version !== observed.policy.version)
    changed.push('policy');
  if (dependencies.status === 'stale')
    changed.push(...dependencies.changed.map((field) => `dependencies.${field}` as const));
  changed.push(...compareRetrieval(basis.retrieval, observed.retrieval));
  return changed.length ? { status: 'stale', changed } : { status: 'fresh', changed: [] };
}

/**
 * A basis that pinned no retrieval has no resource dependency, so a resource
 * enabled afterwards does not make it stale. A basis that did pin retrieval is
 * stale unless the same query still resolves against the same complete
 * authorized set.
 */
function compareRetrieval(
  pinned: CoachingRetrievalBasis,
  observed: CoachingRetrievalBasis,
): TrainingCoachingBasisChange[] {
  if (pinned.kind === 'none') return [];
  if (observed.kind !== 'resource-access-v1' || observed.query !== pinned.query)
    return ['retrieval'];
  const comparison = compareResourceAccessDependencies(pinned.manifest, observed.manifest);
  if (comparison.status === 'unsupported') return ['retrieval'];
  return comparison.changed.map((field) => `retrieval.${field}` as const);
}
