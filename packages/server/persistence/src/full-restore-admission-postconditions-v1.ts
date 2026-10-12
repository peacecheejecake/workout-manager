import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  canonicalFullFamilyJson,
  isVerifiedFullFamilyArtifactV1,
  type VerifiedFullFamilyArtifactV1,
} from './full-restore-family-artifact-v1.js';

/**
 * Target-bound postcondition evaluator for the full-family protocol v1.
 *
 * Input facts must be observed on the target by the plain owner inside ONE
 * transaction that holds the exclusive restore-processing control lock
 * (77210,1) and later issues the atomic admission call in that same
 * transaction. This module never performs admission and never reads the
 * database: it only decides whether every required fact is present, bound to
 * the same target and equal to the authenticated artifact. A missing or
 * `not_checked` fact is a failure, never a pass. The returned command is input
 * for the (proposed, not yet migrated) SQL admission function, which must
 * re-check revision/nonce/incarnation under the same lock.
 */
export type FullRestorePostconditionFailureV1 =
  | 'ARTIFACT_NOT_VERIFIED'
  | 'INVALID_OBSERVATION'
  | 'LATEST_TAIL_NOT_WITNESSED'
  | 'TRANSACTION_BINDING_MISMATCH'
  | 'CONTROL_NOT_CLOSED'
  | 'CONTROL_TARGET_MISMATCH'
  | 'OWNER_NOT_PLAIN'
  | 'RUNTIME_ROLE_NOT_RESTRICTED'
  | 'BASELINE_RELATION_MISMATCH'
  | 'SEQUENCE_HIGH_WATER_REGRESSED'
  | 'OBJECT_VERIFICATION_INCOMPLETE'
  | 'TAIL_APPLICATION_INCOMPLETE'
  | 'SUPPRESSION_VIOLATED'
  | 'AUTHENTICATION_STATE_LIVE'
  | 'BUDGET_STATE_ALTERED';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const identifier = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const int64 = z
  .string()
  .regex(/^(?:0|-?[1-9][0-9]{0,18})$/)
  .refine((v) => BigInt(v) >= -9223372036854775808n && BigInt(v) <= 9223372036854775807n);
const revision = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((v) => BigInt(v) <= 9223372036854775807n);
const transaction = z.strictObject({
  xid: z.string().regex(/^[1-9][0-9]{0,19}$/),
  backendPid: z.number().int().min(1).max(2147483647),
});

const observationSchema = z.strictObject({
  transaction,
  exclusiveControlLockHeld: z.literal(true),
  control: z.strictObject({
    transaction,
    state: z.string(),
    localRevision: revision,
    targetNonce: uuid.nullable(),
    targetIncarnation: uuid.nullable(),
  }),
  roles: z.strictObject({
    sessionIsTableOwner: z.boolean(),
    ownerSuperuser: z.boolean(),
    ownerBypassRls: z.boolean(),
    runtimeRoleSuperuser: z.boolean(),
    runtimeRoleBypassRls: z.boolean(),
    runtimeRoleOwnsRestoredRelations: z.boolean(),
  }),
  /** Recomputed on the target after the baseline load and BEFORE tail replay. */
  baselineRelations: z.array(
    z.strictObject({
      schema: identifier,
      relation: identifier,
      rowCount: count,
      rowsSha256: hash,
    }),
  ),
  sequences: z.array(
    z.strictObject({
      schema: identifier,
      relation: identifier,
      lastValue: int64,
      isCalled: z.boolean(),
      ownerColumnMax: int64.nullable(),
    }),
  ),
  objects: z.strictObject({
    verifiedCount: count,
    verifiedBytes: count,
    manifestSha256: hash,
    missing: count,
    mismatched: count,
  }),
  tail: z.strictObject({
    appliedSegments: z.array(
      z.strictObject({
        ordinal: z.number().int().min(1),
        segmentSha256: hash,
        appliedRecords: count,
      }),
    ),
    appliedHeadSha256: hash.nullable(),
  }),
  suppression: z.strictObject({ resurrectedSuppressedRows: count, checkedRelations: count }),
  authentication: z.strictObject({ liveSessions: count, liveProviderTokens: count }),
  budget: z.strictObject({
    /** Reservation state multiset observed after the full load including tail. */
    reservationStates: z.strictObject({
      reserved: count,
      dispatching: count,
      completed: count,
      charged_unknown: count,
      released: count,
    }),
    /** The same multiset, independently derived from the authenticated source rows/tail. */
    expectedReservationStates: z.strictObject({
      reserved: count,
      dispatching: count,
      completed: count,
      charged_unknown: count,
      released: count,
    }),
    externalRedispatches: count,
  }),
});
export type FullRestorePostconditionObservationV1 = z.infer<typeof observationSchema>;

export type FullRestoreAdmissionCommandV1 = Readonly<{
  expectedRevision: string;
  targetNonce: string;
  targetIncarnation: string;
  artifactSha256: string;
  headSha256: string;
  postconditionsSha256: string;
}>;
export type FullRestorePostconditionResultV1 = Readonly<
  | {
      kind: 'full_restore_postconditions_v1';
      ready: false;
      failures: readonly FullRestorePostconditionFailureV1[];
      authority: 'none';
      admissionAllowed: false;
    }
  | {
      kind: 'full_restore_postconditions_v1';
      ready: true;
      failures: readonly [];
      /** Still requires the atomic SQL admission under the same transaction. */
      authority: 'none';
      admissionAllowed: false;
      command: FullRestoreAdmissionCommandV1;
    }
>;

const qualified = (v: { schema: string; relation: string }) => `${v.schema}.${v.relation}`;
const objectManifestSha256 = (artifact: VerifiedFullFamilyArtifactV1) =>
  createHash('sha256')
    .update('wm-full-restore-object-manifest-v1\0')
    .update(canonicalFullFamilyJson(artifact.objects))
    .digest('hex');
export function fullRestoreObjectManifestSha256V1(artifact: VerifiedFullFamilyArtifactV1): string {
  if (!isVerifiedFullFamilyArtifactV1(artifact)) throw new TypeError('ARTIFACT_NOT_VERIFIED');
  return objectManifestSha256(artifact);
}

function notReady(
  failures: readonly FullRestorePostconditionFailureV1[],
): FullRestorePostconditionResultV1 {
  return Object.freeze({
    kind: 'full_restore_postconditions_v1',
    ready: false,
    failures: Object.freeze([...new Set(failures)]),
    authority: 'none',
    admissionAllowed: false,
  });
}

export function evaluateFullRestorePostconditionsV1(
  artifact: VerifiedFullFamilyArtifactV1,
  rawObservation: unknown,
  policy: Readonly<{ budgetReservationRelation: { schema: string; relation: string } }>,
): FullRestorePostconditionResultV1 {
  if (!isVerifiedFullFamilyArtifactV1(artifact)) return notReady(['ARTIFACT_NOT_VERIFIED']);
  const parsed = observationSchema.safeParse(rawObservation);
  if (!parsed.success) return notReady(['INVALID_OBSERVATION']);
  const o = parsed.data;
  const failures: FullRestorePostconditionFailureV1[] = [];
  if (artifact.latestTail !== 'witness_matched') failures.push('LATEST_TAIL_NOT_WITNESSED');
  if (
    o.control.transaction.xid !== o.transaction.xid ||
    o.control.transaction.backendPid !== o.transaction.backendPid
  )
    failures.push('TRANSACTION_BINDING_MISMATCH');
  if (o.control.state !== 'CLOSED') failures.push('CONTROL_NOT_CLOSED');
  if (
    o.control.localRevision !== artifact.target.closedRevision ||
    o.control.targetNonce !== artifact.target.targetNonce ||
    o.control.targetIncarnation !== artifact.target.targetIncarnation
  )
    failures.push('CONTROL_TARGET_MISMATCH');
  if (!o.roles.sessionIsTableOwner || o.roles.ownerSuperuser || o.roles.ownerBypassRls)
    failures.push('OWNER_NOT_PLAIN');
  if (
    o.roles.runtimeRoleSuperuser ||
    o.roles.runtimeRoleBypassRls ||
    o.roles.runtimeRoleOwnsRestoredRelations
  )
    failures.push('RUNTIME_ROLE_NOT_RESTRICTED');

  const expected = artifact.inventory.inventory.relations;
  if (
    o.baselineRelations.length !== expected.length ||
    o.baselineRelations.some((row, index) => {
      const want = expected[index];
      return (
        !want ||
        qualified(want) !== qualified(row) ||
        want.rowCount !== row.rowCount ||
        want.rowsSha256 !== row.rowsSha256
      );
    })
  )
    failures.push('BASELINE_RELATION_MISMATCH');

  if (
    o.sequences.length !== artifact.sequences.length ||
    o.sequences.some((row, index) => {
      const source = artifact.sequences[index];
      if (!source || qualified(source) !== qualified(row) || row.isCalled !== source.isCalled)
        return true;
      const target = BigInt(row.lastValue);
      return (
        target < BigInt(source.lastValue) ||
        (row.ownerColumnMax !== null && target < BigInt(row.ownerColumnMax))
      );
    })
  )
    failures.push('SEQUENCE_HIGH_WATER_REGRESSED');

  if (
    o.objects.missing !== 0 ||
    o.objects.mismatched !== 0 ||
    o.objects.verifiedCount !== artifact.totals.objectCount ||
    o.objects.verifiedBytes !== artifact.totals.objectBytes ||
    o.objects.manifestSha256 !== objectManifestSha256(artifact)
  )
    failures.push('OBJECT_VERIFICATION_INCOMPLETE');

  const segments = artifact.tail.segments;
  if (
    o.tail.appliedSegments.length !== segments.length ||
    o.tail.appliedHeadSha256 !== artifact.tail.head.headSha256 ||
    o.tail.appliedSegments.some((applied, index) => {
      const want = segments[index];
      return (
        !want ||
        applied.ordinal !== want.ordinal ||
        applied.segmentSha256 !== want.segmentSha256 ||
        applied.appliedRecords !== want.recordCount
      );
    })
  )
    failures.push('TAIL_APPLICATION_INCOMPLETE');

  if (o.suppression.resurrectedSuppressedRows !== 0 || o.suppression.checkedRelations === 0)
    failures.push('SUPPRESSION_VIOLATED');
  if (o.authentication.liveSessions !== 0 || o.authentication.liveProviderTokens !== 0)
    failures.push('AUTHENTICATION_STATE_LIVE');

  const reservation = expected.find(
    (row) => qualified(row) === qualified(policy.budgetReservationRelation),
  );
  const states = o.budget.reservationStates,
    wanted = o.budget.expectedReservationStates;
  const total = Object.values(wanted).reduce((sum, value) => sum + value, 0);
  if (
    !reservation ||
    o.budget.externalRedispatches !== 0 ||
    canonicalFullFamilyJson(states) !== canonicalFullFamilyJson(wanted) ||
    // Ambiguous/dispatched states are retained as-is; with no tail the
    // expected multiset must also account for exactly the baseline rows.
    (segments.length === 0 && total !== reservation.rowCount)
  )
    failures.push('BUDGET_STATE_ALTERED');

  if (failures.length > 0) return notReady(failures);
  const postconditionsSha256 = createHash('sha256')
    .update('wm-full-restore-postconditions-v1\0')
    .update(canonicalFullFamilyJson({ artifactSha256: artifact.artifactSha256, observation: o }))
    .digest('hex');
  return Object.freeze({
    kind: 'full_restore_postconditions_v1',
    ready: true,
    failures: Object.freeze([]) as readonly [],
    authority: 'none',
    admissionAllowed: false,
    command: Object.freeze({
      expectedRevision: artifact.target.closedRevision,
      targetNonce: artifact.target.targetNonce,
      targetIncarnation: artifact.target.targetIncarnation,
      artifactSha256: artifact.artifactSha256,
      headSha256: artifact.tail.head.headSha256,
      postconditionsSha256,
    }),
  });
}
