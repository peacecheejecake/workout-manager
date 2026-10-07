import { expect, it } from 'vitest';
import {
  compareRaceManualSemanticBasisV2,
  projectRaceManualPurposeUsesV2,
  raceManualSemanticBasisV2Schema,
  createRaceManualSemanticBasisV2Service,
  prepareRaceManualSemanticBasisV2In,
} from '../src/race-manual-review-semantic-basis-v2.js';
import type { Database, Transaction } from '../src/database.js';
const eventId = 'a0000000-0000-4000-8000-000000000001';
function basis() {
  return raceManualSemanticBasisV2Schema.parse({
    basisVersion: 2,
    athleteId: 'Synthetic-食',
    restoreGeneration: 'b0000000-0000-4000-8000-000000000001',
    intent: {
      expectedEvent: { id: eventId, revision: 1 },
      newLocalDate: '2026-10-08',
      selection: { kind: 'keep_plan' },
    },
    manualBasis: {
      purpose: 'manual_race_date_change',
      app: { state: 'present', granted: true, revision: 1 },
      policy: { id: 'manual-race-date-impact', version: 1, digest: 'a'.repeat(64) },
    },
    event: {
      id: eventId,
      revision: 1,
      title: 'Synthetic',
      localDate: '2026-10-06',
      localStartTime: null,
      timezone: 'Asia/Seoul',
      locationName: null,
      distance: { kind: 'standard', class: '10k' },
      priority: null,
      participation: 'registered',
      officialUrl: null,
      course: null,
      targetSeconds: 0,
      planVersionId: null,
    },
    collectorSelection: { kind: 'keep_plan' },
    heads: {
      nutrition: { state: 'absent' },
      recovery: { state: 'absent' },
      routine: { state: 'absent' },
    },
    currentTraining: null,
    core: {
      schemaVersion: 2,
      scope: 'core-ledgers-v2',
      athleteId: 'Synthetic-食',
      trainingPlan: { kind: 'absent' },
      checkIns: { kind: 'absent' },
      sessionCompletions: { kind: 'absent' },
      userConstraints: { kind: 'absent' },
    },
    activities: [],
    eventCollection: null,
    dependencyHeads: [
      'intake_revision',
      'activity_revision',
      'execution_revision',
      'set_revision',
      'routine_run_revision',
      'routine_occurrence_revision',
      'recovery_action_revision',
    ].map((kind) => ({ kind, state: 'absent' })),
    copiedSources: [],
    consumedUses: {
      purposeProjectionVersion: 2,
      purpose: 'manual_race_date_change',
      facts: [],
      authority: 'none',
      permissionAuthority: 'none',
      storage: 'not_persisted',
      freshness: 'not_checked',
      admissionAllowed: false,
      approvalAllowed: false,
    },
  });
}
it('equal diagnostic expectations retain none authority/storage/apply', () => {
  expect(compareRaceManualSemanticBasisV2(basis(), basis())).toMatchObject({
    status: 'matched_dependencies',
    authority: 'none',
    approvalAllowed: false,
    storage: 'not_persisted',
  });
});
for (const field of ['app', 'generation', 'event', 'intent', 'head', 'roster'] as const)
  it(`detects relevant ${field} differences`, () => {
    const before = basis(),
      after = basis();
    if (field === 'app') after.manualBasis.app = { state: 'present', granted: true, revision: 3 };
    if (field === 'generation') after.restoreGeneration = 'c0000000-0000-4000-8000-000000000001';
    if (field === 'event') after.event.revision = 2;
    if (field === 'intent') after.intent.newLocalDate = '2026-10-09';
    if (field === 'head') after.core.trainingPlan = { kind: 'exists', versionId: eventId };
    if (field === 'roster')
      after.copiedSources = [
        {
          identity: { kind: 'checkin-revision', sourceId: eventId, revision: 1 },
          dtoDigest: 'b'.repeat(64),
        },
      ];
    expect(compareRaceManualSemanticBasisV2(before, after)).toMatchObject({
      status: 'blocked',
      reason: 'semantic_basis_changed',
    });
  });
it('strict expectation does not accept unused consent metadata or claimed authority', () => {
  for (const value of [
    { ...basis(), aiConsent: { granted: true } },
    { ...basis(), providerConsent: { granted: true } },
    { ...basis(), authority: 'trusted' },
  ])
    expect(compareRaceManualSemanticBasisV2(value, basis())).toMatchObject({
      status: 'blocked',
      reason: 'invalid_semantic_basis',
    });
});
it('same count/sum activity replacement cannot compare equal', () => {
  const a = basis(),
    b = basis();
  const row = {
    id: eventId,
    revision: 1,
    deleted: false,
    overlay: { state: 'absent' as const, revision: null },
    source: { state: 'absent' as const },
  };
  a.activities = [row];
  b.activities = [{ ...row, id: 'c0000000-0000-4000-8000-000000000001' }];
  expect(compareRaceManualSemanticBasisV2(a, b).status).toBe('blocked');
});
it('invalid/accessor expectation rejects before actual database queries', async () => {
  let reads = 0,
    queries = 0;
  const expected = {};
  Object.defineProperty(expected, 'basisVersion', {
    enumerable: true,
    get() {
      reads++;
      return 2;
    },
  });
  const tx: Transaction = {
    athleteId: 'Synthetic',
    async query() {
      queries++;
      throw Error('NO_QUERY');
    },
  };
  await expect(
    prepareRaceManualSemanticBasisV2In(tx, basis().intent, expected, { bytes: 0n, sources: 0 }),
  ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
  expect(reads).toBe(0);
  expect(queries).toBe(0);
});
it('actual service requires fenced snapshot with no RC fallback', async () => {
  let rc = 0;
  const db: Database = {
    tenant: async () => {
      rc++;
      throw Error('NO_RC');
    },
    exclusiveTenant: async () => {
      throw Error('NO_EXCLUSIVE');
    },
    close: async () => {},
  };
  await expect(
    createRaceManualSemanticBasisV2Service(db).prepare('Synthetic', basis().intent),
  ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE' });
  expect(rc).toBe(0);
});

it('public service validates malformed expectations before opening any database transaction', async () => {
  let opened = 0;
  const db: Database = {
    tenant: async () => {
      throw Error('NO_RC');
    },
    exclusiveTenant: async () => {
      throw Error('NO_EXCLUSIVE');
    },
    snapshotTenant: async () => {
      opened++;
      throw Error('NO_DB');
    },
    close: async () => {},
  };
  await expect(
    createRaceManualSemanticBasisV2Service(db).prepare('Synthetic', basis().intent, {
      ...basis(),
      permissionAuthority: 'allowed',
    }),
  ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
  expect(opened).toBe(0);
});

it('manual purpose excludes AI access revision/cleanup drift and retains raw deletion', () => {
  const observed = {
    purpose: 'manual_race_date_change',
    facts: [
      {
        identity: { kind: 'resource-text-version', sourceId: eventId, versionId: eventId },
        use: 'own_retained_text',
        reason: null,
        sourceAuthentication: 'unverified',
        resourceAccess: { accessRevision: 1, deleted: false, cleanupPending: false },
      },
    ],
    authority: 'none',
    permissionAuthority: 'none',
    storage: 'not_persisted',
    freshness: 'not_checked',
    admissionAllowed: false,
    approvalAllowed: false,
  };
  const before = projectRaceManualPurposeUsesV2(observed);
  const fact = observed.facts[0];
  if (!fact) throw Error('FIXTURE_FACT_MISSING');
  fact.resourceAccess.accessRevision = 4;
  fact.resourceAccess.cleanupPending = true;
  expect(projectRaceManualPurposeUsesV2(observed)).toEqual(before);
  fact.resourceAccess.deleted = true;
  expect(projectRaceManualPurposeUsesV2(observed)).not.toEqual(before);
  expect(
    raceManualSemanticBasisV2Schema.safeParse({ ...basis(), consumedUses: observed }).success,
  ).toBe(false);
});

it('raw resource version/body correspondence remains a relevant semantic dependency', () => {
  const original = basis(),
    changed = basis();
  const identity = {
    kind: 'resource-text-version' as const,
    sourceId: eventId,
    versionId: eventId,
  };
  original.copiedSources = [{ identity, dtoDigest: 'a'.repeat(64) }];
  changed.copiedSources = [{ identity, dtoDigest: 'b'.repeat(64) }];
  expect(compareRaceManualSemanticBasisV2(original, changed)).toMatchObject({
    status: 'blocked',
    reason: 'semantic_basis_changed',
  });
});
