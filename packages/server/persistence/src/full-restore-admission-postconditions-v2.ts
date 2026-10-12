import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  canonicalFullFamilyJson,
  isVerifiedFullFamilyArtifactV1,
  type VerifiedFullFamilyArtifactV1,
} from './full-restore-family-artifact-v1.js';
import { fullRestoreObjectManifestSha256V1 } from './full-restore-admission-postconditions-v1.js';
import {
  isFullRestoreRelationClassificationV2,
  restoreAdmissionCensusSha256,
  RESTORE_ADMISSION_ROSTER_SHA256,
  type FullRestoreRelationClassificationV2,
} from './full-restore-relation-classification-v2.js';

/**
 * Postcondition evaluator v2 for the SQL147 window/admit protocol (EXT-RESTOREa). The v1
 * evaluator is unchanged.
 *
 * Facts are observed by the plain owner INSIDE the census window that
 * `open_restore_processing_admission_window` opened in the current READ COMMITTED transaction
 * (every census relation is ACCESS EXCLUSIVE locked by this backend and owner-visible across all
 * tenants). The evaluator derives the authenticated expected post-tail census from the verified
 * artifact: baseline inventory row counts plus authenticated tail deltas. Tail replay deltas do
 * not exist yet (v1 tail records are opaque, only `recordsSha256`), so any artifact with tail
 * segments fails closed with TAIL_DELTA_UNAVAILABLE (user decision D6). The returned command is
 * the exact `admit_restore_processing_exact` argument set; SQL re-counts every census relation
 * against it. A ready result is still `authority: none`.
 */
export type FullRestorePostconditionFailureV2 =
  | 'ARTIFACT_NOT_VERIFIED'
  | 'CLASSIFICATION_NOT_VERIFIED'
  | 'INVALID_OBSERVATION'
  | 'INVALID_COMMAND_ID'
  | 'LATEST_TAIL_NOT_WITNESSED'
  | 'TRANSACTION_BINDING_MISMATCH'
  | 'WINDOW_BINDING_MISMATCH'
  | 'ROSTER_NOT_PINNED'
  | 'CONTROL_NOT_CLOSED'
  | 'CONTROL_TARGET_MISMATCH'
  | 'OWNER_NOT_PLAIN'
  | 'RUNTIME_ROLE_NOT_RESTRICTED'
  | 'CENSUS_INCOMPLETE'
  | 'TAIL_DELTA_UNAVAILABLE'
  | 'BASELINE_RELATION_MISMATCH'
  | 'POST_TAIL_RELATION_MISMATCH'
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
const xid = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((v) => BigInt(v) <= 9223372036854775807n);
const transaction = z.strictObject({
  xid,
  backendPid: z.number().int().min(1).max(2147483647),
});
const relationFacts = z.strictObject({
  schema: identifier,
  relation: identifier,
  rowCount: count,
  rowsSha256: hash,
});
const reservationStates = z.strictObject({
  reserved: count,
  dispatching: count,
  completed: count,
  charged_unknown: count,
  released: count,
});

const observationSchema = z.strictObject({
  transaction,
  /** The `open_restore_processing_admission_window` result of this transaction. */
  window: z.strictObject({ xid, rosterSha256: hash }),
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
  baselineRelations: z.array(relationFacts),
  /** Recomputed inside the window AFTER tail replay, in census (code-point) order. */
  postTailRelations: z.array(relationFacts),
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
  /** Exactly the roster authentication_reset relations, in code-point order. */
  authenticationReset: z.array(
    z.strictObject({ schema: identifier, relation: identifier, rowCount: count }),
  ),
  budget: z.strictObject({
    reservationStates,
    expectedReservationStates: reservationStates,
    externalRedispatches: count,
  }),
});
export type FullRestorePostconditionObservationV2 = z.infer<typeof observationSchema>;

export type FullRestoreAdmissionCensusEntryV2 = Readonly<{
  schema: string;
  relation: string;
  rowCount: number;
}>;
/** Exact `admit_restore_processing_exact` arguments (and the owner port `admit` input). */
export type FullRestoreAdmissionCommandV2 = Readonly<{
  expectedRevision: string;
  commandId: string;
  targetNonce: string;
  targetIncarnation: string;
  artifactSha256: string;
  headSha256: string;
  postconditionsSha256: string;
  census: readonly FullRestoreAdmissionCensusEntryV2[];
  censusSha256: string;
  observedXid: string;
}>;
export type FullRestorePostconditionResultV2 = Readonly<
  | {
      kind: 'full_restore_postconditions_v2';
      ready: false;
      failures: readonly FullRestorePostconditionFailureV2[];
      authority: 'none';
      admissionAllowed: false;
    }
  | {
      kind: 'full_restore_postconditions_v2';
      ready: true;
      failures: readonly [];
      /** Still requires the atomic SQL admission in the same transaction as the window. */
      authority: 'none';
      admissionAllowed: false;
      command: FullRestoreAdmissionCommandV2;
    }
>;

const qualified = (v: { schema: string; relation: string }) => `${v.schema}.${v.relation}`;
function notReady(
  failures: readonly FullRestorePostconditionFailureV2[],
): FullRestorePostconditionResultV2 {
  return Object.freeze({
    kind: 'full_restore_postconditions_v2',
    ready: false,
    failures: Object.freeze([...new Set(failures)]),
    authority: 'none',
    admissionAllowed: false,
  });
}
const sameNames = (
  a: readonly { schema: string; relation: string }[],
  b: readonly { schema: string; relation: string }[],
) => a.length === b.length && a.every((row, i) => b[i] && qualified(b[i]) === qualified(row));

/**
 * Authenticated expected post-tail census (code-point order). Null when it cannot be derived:
 * the inventory does not cover exactly the census set, or the artifact has tail segments and no
 * authenticated tail delta source exists (D6).
 */
export function deriveFullRestoreAdmissionCensusV2(
  artifact: VerifiedFullFamilyArtifactV1,
  classification: FullRestoreRelationClassificationV2,
):
  | { ok: true; census: readonly FullRestoreAdmissionCensusEntryV2[] }
  | { ok: false; failure: 'CENSUS_INCOMPLETE' | 'TAIL_DELTA_UNAVAILABLE' } {
  const inventory = artifact.inventory.inventory.relations;
  if (!sameNames(classification.census, inventory))
    return { ok: false, failure: 'CENSUS_INCOMPLETE' };
  if (artifact.tail.segments.length > 0) return { ok: false, failure: 'TAIL_DELTA_UNAVAILABLE' };
  const census: FullRestoreAdmissionCensusEntryV2[] = [];
  for (const [i, row] of classification.census.entries()) {
    const entry = inventory[i];
    if (!entry) return { ok: false, failure: 'CENSUS_INCOMPLETE' };
    census.push(
      Object.freeze({ schema: row.schema, relation: row.relation, rowCount: entry.rowCount }),
    );
  }
  return { ok: true, census: Object.freeze(census) };
}

export function evaluateFullRestorePostconditionsV2(
  artifact: VerifiedFullFamilyArtifactV1,
  classification: FullRestoreRelationClassificationV2,
  rawObservation: unknown,
  policy: Readonly<{
    commandId: string;
    budgetReservationRelation: { schema: string; relation: string };
  }>,
): FullRestorePostconditionResultV2 {
  if (!isVerifiedFullFamilyArtifactV1(artifact)) return notReady(['ARTIFACT_NOT_VERIFIED']);
  if (
    !isFullRestoreRelationClassificationV2(classification) ||
    classification.rosterSha256 !== RESTORE_ADMISSION_ROSTER_SHA256
  )
    return notReady(['CLASSIFICATION_NOT_VERIFIED']);
  if (!uuid.safeParse(policy.commandId).success) return notReady(['INVALID_COMMAND_ID']);
  const parsed = observationSchema.safeParse(rawObservation);
  if (!parsed.success) return notReady(['INVALID_OBSERVATION']);
  const o = parsed.data;
  const failures: FullRestorePostconditionFailureV2[] = [];
  if (artifact.latestTail !== 'witness_matched') failures.push('LATEST_TAIL_NOT_WITNESSED');
  if (
    o.control.transaction.xid !== o.transaction.xid ||
    o.control.transaction.backendPid !== o.transaction.backendPid
  )
    failures.push('TRANSACTION_BINDING_MISMATCH');
  if (o.window.xid !== o.transaction.xid) failures.push('WINDOW_BINDING_MISMATCH');
  if (o.window.rosterSha256 !== RESTORE_ADMISSION_ROSTER_SHA256) failures.push('ROSTER_NOT_PINNED');
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

  const derived = deriveFullRestoreAdmissionCensusV2(artifact, classification);
  if (!derived.ok) failures.push(derived.failure);

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
  // With no authenticated tail delta, post-tail content must equal the authenticated baseline.
  if (
    !derived.ok ||
    !sameNames(classification.census, o.postTailRelations) ||
    o.postTailRelations.some((row, index) => {
      const want = expected[index];
      const count = derived.census[index];
      return (
        !want || !count || row.rowCount !== count.rowCount || row.rowsSha256 !== want.rowsSha256
      );
    })
  )
    failures.push('POST_TAIL_RELATION_MISMATCH');

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
    o.objects.manifestSha256 !== fullRestoreObjectManifestSha256V1(artifact)
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
  if (
    !sameNames(classification.authenticationReset, o.authenticationReset) ||
    o.authenticationReset.some((row) => row.rowCount !== 0)
  )
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
    (segments.length === 0 && total !== reservation.rowCount)
  )
    failures.push('BUDGET_STATE_ALTERED');

  if (failures.length > 0 || !derived.ok) return notReady(failures);
  const census = derived.census;
  const censusSha256 = restoreAdmissionCensusSha256(census);
  const postconditionsSha256 = createHash('sha256')
    .update('wm-full-restore-postconditions-v2\0')
    .update(
      canonicalFullFamilyJson({
        artifactSha256: artifact.artifactSha256,
        observation: o,
        census: census.map((c) => ({ ...c })),
        censusSha256,
        rosterSha256: classification.rosterSha256,
      }),
    )
    .digest('hex');
  return Object.freeze({
    kind: 'full_restore_postconditions_v2',
    ready: true,
    failures: Object.freeze([]) as readonly [],
    authority: 'none',
    admissionAllowed: false,
    command: Object.freeze({
      expectedRevision: artifact.target.closedRevision,
      commandId: policy.commandId,
      targetNonce: artifact.target.targetNonce,
      targetIncarnation: artifact.target.targetIncarnation,
      artifactSha256: artifact.artifactSha256,
      headSha256: artifact.tail.head.headSha256,
      postconditionsSha256,
      census,
      censusSha256,
      observedXid: o.window.xid,
    }),
  });
}
