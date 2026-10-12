import { createHash } from 'node:crypto';
import {
  createFullFamilyArtifactVerifierV1,
  fullFamilyBaselineSha256,
  fullFamilyHeadSha256,
  fullFamilySegmentSha256,
  signFullFamilyArtifactV1,
  type FullFamilyArtifactConfigurationV1,
  type VerifiedFullFamilyArtifactV1,
} from '../src/full-restore-family-artifact-v1.js';
import { fullRestoreObjectManifestSha256V1 } from '../src/full-restore-admission-postconditions-v1.js';
import type { FullRestoreRelationClassificationV2 } from '../src/full-restore-relation-classification-v2.js';

// Synthetic metadata fixture only (no health, account or provider data): the production
// 225-relation census set from the generated admission roster with caller-supplied row facts.
export const ADMISSION_FIXTURE_KEY = new Uint8Array(32).fill(5);
export const EMPTY_ROWS_SHA256 = createHash('sha256').update('[]').digest('hex');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const qualified = (v: { schema: string; relation: string }) => `${v.schema}.${v.relation}`;
export type RowFacts = Readonly<{ rowCount: number; rowsSha256: string }>;
const identity = () => ({
  profileId: 'synthetic_profile27',
  normalRegistrySha256: digest('normal'),
  namedProfileSha256: digest('named'),
  catalogSha256: digest('catalog'),
});
const relationIdentity = (schema: string, relation: string) => ({
  schema,
  relation,
  physicalCodec: 'postgres-row-jsonb-utc-v1',
  columnsSha256: digest(`${schema}.${relation}`),
  orderingKey: ['id'],
});
export const BUDGET_RESERVATION = { schema: 'public', relation: 'openai_budget_reservation' };
export function admissionRegistry(c: FullRestoreRelationClassificationV2) {
  return {
    schemaVersion: 1,
    identity: identity(),
    maxTotalRows: 10000000,
    maxTotalBytes: 1073741824,
    targetLocalRelations: c.relations
      .filter((r) => r.class === 'target_local')
      .map((r) => ({ schema: r.schema, relation: r.relation })),
    relations: c.census.map((r) => ({
      ...relationIdentity(r.schema, r.relation),
      maxRows: 1000000,
      maxBytes: 67108864,
    })),
  };
}
export function admissionConfiguration(
  c: FullRestoreRelationClassificationV2,
): FullFamilyArtifactConfigurationV1 {
  return {
    keyId: 'synthetic-admission-key',
    authenticationResetRelations: c.authenticationReset.map((r) => ({
      schema: r.schema,
      relation: r.relation,
    })),
    budgetRelations: [
      { schema: 'public', relation: 'openai_budget_journal' },
      { schema: 'public', relation: 'openai_budget_reservation' },
    ],
    sequences: [
      {
        schema: 'public',
        relation: 'openai_budget_journal_sequence_id_seq',
        owner: { schema: 'public', relation: 'openai_budget_journal' },
        column: 'sequence_id',
      },
    ],
    maxObjects: 10,
    maxObjectBytes: 1000,
  };
}
export function factsOf(
  c: FullRestoreRelationClassificationV2,
  facts: ReadonlyMap<string, RowFacts>,
): RowFacts[] {
  return c.census.map(
    (r) => facts.get(qualified(r)) ?? { rowCount: 0, rowsSha256: EMPTY_ROWS_SHA256 },
  );
}
export function signAdmissionArtifact(input: {
  classification: FullRestoreRelationClassificationV2;
  facts: ReadonlyMap<string, RowFacts>;
  target: { targetNonce: string; targetIncarnation: string; closedRevision: string };
  segments?: [string, string, number][] | undefined;
  sequence?: { lastValue: string; isCalled: boolean };
}): VerifiedFullFamilyArtifactV1 {
  const c = input.classification;
  const rows = factsOf(c, input.facts);
  const inventory = {
    schemaVersion: 1,
    identity: identity(),
    relations: c.census.map((r, i) => {
      const f = rows[i] ?? { rowCount: 0, rowsSha256: EMPTY_ROWS_SHA256 };
      return f.rowCount === 0
        ? {
            ...relationIdentity(r.schema, r.relation),
            state: 'explicit_empty',
            rowCount: 0,
            byteLength: 2,
            rowsSha256: EMPTY_ROWS_SHA256,
          }
        : {
            ...relationIdentity(r.schema, r.relation),
            state: 'present',
            rowCount: f.rowCount,
            byteLength: 2 + f.rowCount * 10,
            rowsSha256: f.rowsSha256,
          };
    }),
  };
  const source = {
    generationId: '33333333-3333-4333-8333-333333333333',
    systemIdentifier: '7412345678901234567',
    serverVersionNum: 170006,
    snapshotId: '00000003-00000002-1',
    slotName: 'wm_full_restore_slot',
    consistentLsn: '0/16B3740',
    capturedAt: '2026-10-13T00:00:00.000000Z',
  };
  const baseline = fullFamilyBaselineSha256(source, inventory);
  let previous = baseline;
  const segments = (input.segments ?? []).map(([startLsn, endLsn, recordCount], index) => {
    const partial = {
      ordinal: index + 1,
      startLsn,
      endLsn,
      recordCount,
      recordsSha256: recordCount === 0 ? EMPTY_ROWS_SHA256 : digest(`records:${index}`),
      previousSegmentSha256: previous,
    };
    const segment = { ...partial, segmentSha256: fullFamilySegmentSha256(partial) };
    previous = segment.segmentSha256;
    return segment;
  });
  const endLsn = input.segments?.at(-1)?.[1] ?? source.consistentLsn;
  const head = {
    lastOrdinal: segments.length,
    endLsn,
    headSha256: fullFamilyHeadSha256(baseline, segments, endLsn),
  };
  const configuration = admissionConfiguration(c);
  const body = {
    schemaVersion: 1,
    protocol: 'wm-full-restore-family-v1',
    keyId: configuration.keyId,
    source,
    inventory,
    objects: [],
    sequences: [
      {
        schema: 'public',
        relation: 'openai_budget_journal_sequence_id_seq',
        ...(input.sequence ?? { lastValue: '1', isCalled: false }),
      },
    ],
    tail: { segments, head },
    target: input.target,
    authentication: { sessionsRequireReauthentication: true },
  };
  const verifier = createFullFamilyArtifactVerifierV1({
    trustedRegistry: admissionRegistry(c),
    configuration,
    resolveKey: () => ADMISSION_FIXTURE_KEY,
  });
  return verifier.verify(signFullFamilyArtifactV1(body, ADMISSION_FIXTURE_KEY), {
    target: input.target,
    latestHead: head,
  });
}
export function admissionObservation(input: {
  classification: FullRestoreRelationClassificationV2;
  artifact: VerifiedFullFamilyArtifactV1;
  transaction: { xid: string; backendPid: number };
  window: { xid: string; rosterSha256: string };
  control: { state: string; localRevision: string; targetNonce: string; targetIncarnation: string };
  postTail: ReadonlyMap<string, RowFacts>;
  authenticationReset?: ReadonlyMap<string, number>;
  sequence?: { lastValue: string; isCalled: boolean; ownerColumnMax: string | null };
}) {
  const c = input.classification;
  const a = input.artifact;
  const baseline = a.inventory.inventory.relations.map((r) => ({
    schema: r.schema,
    relation: r.relation,
    rowCount: r.rowCount,
    rowsSha256: r.rowsSha256,
  }));
  const post = factsOf(c, input.postTail);
  const reservation = baseline.find((r) => qualified(r) === qualified(BUDGET_RESERVATION));
  return {
    transaction: input.transaction,
    window: input.window,
    exclusiveControlLockHeld: true,
    control: { transaction: input.transaction, ...input.control },
    roles: {
      sessionIsTableOwner: true,
      ownerSuperuser: false,
      ownerBypassRls: false,
      runtimeRoleSuperuser: false,
      runtimeRoleBypassRls: false,
      runtimeRoleOwnsRestoredRelations: false,
    },
    baselineRelations: baseline,
    postTailRelations: c.census.map((r, i) => ({
      schema: r.schema,
      relation: r.relation,
      rowCount: post[i]?.rowCount ?? 0,
      rowsSha256: post[i]?.rowsSha256 ?? EMPTY_ROWS_SHA256,
    })),
    sequences: [
      {
        schema: 'public',
        relation: 'openai_budget_journal_sequence_id_seq',
        ...(input.sequence ?? { lastValue: '1', isCalled: false, ownerColumnMax: null }),
      },
    ],
    objects: {
      verifiedCount: 0,
      verifiedBytes: 0,
      manifestSha256: fullRestoreObjectManifestSha256V1(a),
      missing: 0,
      mismatched: 0,
    },
    tail: {
      appliedSegments: a.tail.segments.map((s) => ({
        ordinal: s.ordinal,
        segmentSha256: s.segmentSha256,
        appliedRecords: s.recordCount,
      })),
      appliedHeadSha256: a.tail.head.headSha256,
    },
    suppression: { resurrectedSuppressedRows: 0, checkedRelations: 1 },
    authenticationReset: c.authenticationReset.map((r) => ({
      schema: r.schema,
      relation: r.relation,
      rowCount: input.authenticationReset?.get(qualified(r)) ?? 0,
    })),
    budget: {
      reservationStates: {
        reserved: 0,
        dispatching: 0,
        completed: reservation?.rowCount ?? 0,
        charged_unknown: 0,
        released: 0,
      },
      expectedReservationStates: {
        reserved: 0,
        dispatching: 0,
        completed: reservation?.rowCount ?? 0,
        charged_unknown: 0,
        released: 0,
      },
      externalRedispatches: 0,
    },
  };
}
