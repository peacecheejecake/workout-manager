import { expect, it } from 'vitest';
import {
  classifyRaceManualConsumedSourceV2,
  assertRaceManualPlainV2,
  prepareRaceManualConsumedUseV2In,
  raceManualConsumedUseFactsV2Schema,
} from '../src/race-manual-review-consumed-use-v2.js';
import type { Transaction } from '../src/database.js';
for (const kind of [
  'race-event',
  'plan-snapshot',
  'food-definition-version',
  'checkin-revision',
  'intake-revision',
  'routine-run',
] as const)
  it(`classifies ${kind} as core manual requirement, never an authorization credential`, () => {
    expect(classifyRaceManualConsumedSourceV2(kind, null)).toBeNull();
  });
for (const [kind, source, reason] of [
  ['manual-activity-source', 'manual', null],
  ['activity-overlay', 'healthkit', 'healthkit_policy_adapter_unavailable'],
  ['activity-canonical-values', 'fit', 'activity_provenance_unavailable'],
  ['activity-track-descriptor', 'fixture', 'activity_provenance_unavailable'],
  ['gallery-descriptor', null, 'media_policy_adapter_unavailable'],
  ['course-revision', null, 'course_lineage_use_unavailable'],
] as const)
  it(`preserves individual provenance policy for ${kind}/${source}`, () => {
    expect(classifyRaceManualConsumedSourceV2(kind, source)).toBe(reason);
  });
it('rejects selfclaimed JSON authority and unknown permission fields', () => {
  expect(
    raceManualConsumedUseFactsV2Schema.safeParse({
      purpose: 'manual_race_date_change',
      facts: [],
      authority: 'trusted',
      permissionAuthority: 'allowed',
    }).success,
  ).toBe(false);
});
it('unknown intent accessors fail before the actual DB entry performs any query', async () => {
  let reads = 0,
    queries = 0;
  const tx: Transaction = {
    athleteId: 'Synthetic',
    async query() {
      queries++;
      throw Error('NO_QUERY');
    },
  };
  const input = {};
  Object.defineProperty(input, 'expectedEvent', {
    enumerable: true,
    get() {
      reads++;
      return {};
    },
  });
  await expect(
    prepareRaceManualConsumedUseV2In(tx, input, { bytes: 0n, sources: 0 }),
  ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
  expect(reads).toBe(0);
  expect(queries).toBe(0);
});
it('bounds malformed local input without treating JSON hashes as evidence', () => {
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  for (const value of [cyclic, { x: Infinity }, new Date(), { x: '食'.repeat(1400000) }])
    expect(() => assertRaceManualPlainV2(value)).toThrow();
});

it('FIT alone stays unattributed; actual individual Garmin lineage requires a distinct adapter', () => {
  expect(classifyRaceManualConsumedSourceV2('activity-canonical-values', 'fit')).toBe(
    'activity_provenance_unavailable',
  );
  expect(
    classifyRaceManualConsumedSourceV2('activity-canonical-values', 'fit', 'garmin-official'),
  ).toBe('garmin_policy_adapter_unavailable');
  expect(
    classifyRaceManualConsumedSourceV2(
      'activity-canonical-values',
      'manual',
      'garmin-connect-unofficial',
    ),
  ).toBe('garmin_policy_adapter_unavailable');
});

it('primitive/key UTF8 accumulation stops before caller serialization; escaped JSON remains bounded', () => {
  for (const value of [
    '食'.repeat(1400000),
    { ['x'.repeat(4194305)]: null },
    { a: 'x'.repeat(2100000), b: 'x'.repeat(2100000) },
    { a: '\n'.repeat(2100000) },
  ])
    expect(() => assertRaceManualPlainV2(value)).toThrow();
});
it('media grant and descriptor observations remain strict facts rather than permission credentials', () => {
  const observation = {
    adapterVersion: 2,
    kind: 'own_media_descriptor',
    mediaItemId: 'a0000000-0000-4000-8000-000000000001',
    accessRevision: 1,
    mediaConsent: { kind: 'media', granted: true, revision: 2 },
    descriptorDigest: 'a'.repeat(64),
    originalObjectIdentityDigest: 'b'.repeat(64),
    originalLedger: { sha256: 'c'.repeat(64), byteSize: 2, mediaType: 'image/png' },
    previewLedger: null,
    cleanup: {
      digestVersion: 'postgres-jsonb-v1',
      sourceDigest: 'd'.repeat(64),
      state: 'absent',
      refs: [{ digest: 'e'.repeat(64), reason: null, state: 'absent' }],
    },
  };
  const uses = {
    purpose: 'manual_race_date_change',
    facts: [
      {
        identity: {
          kind: 'gallery-descriptor',
          sourceId: observation.mediaItemId,
          accessRevision: 1,
        },
        use: 'core_manual',
        reason: null,
        sourceAuthentication: 'unverified',
        sourcePurpose: observation,
        resourceAccess: null,
      },
    ],
    authority: 'none',
    permissionAuthority: 'none',
    storage: 'not_persisted',
    freshness: 'not_checked',
    admissionAllowed: false,
    approvalAllowed: false,
  };
  expect(raceManualConsumedUseFactsV2Schema.safeParse(uses).success).toBe(true);
  expect(
    raceManualConsumedUseFactsV2Schema.safeParse({
      ...uses,
      facts: [{ ...uses.facts[0], sourcePurpose: { ...observation, verified: true } }],
    }).success,
  ).toBe(false);
  // Pure classification still cannot call the DB authorizer or manufacture a grant.
  expect(classifyRaceManualConsumedSourceV2('gallery-descriptor', null)).toBe(
    'media_policy_adapter_unavailable',
  );
});

it('Garmin retained metadata read is separate from pending consumed purpose/storage integration', () => {
  expect(
    classifyRaceManualConsumedSourceV2(
      'activity-canonical-values',
      'fit',
      'garmin-connect-unofficial',
    ),
  ).toBe('garmin_policy_adapter_unavailable');
  expect(classifyRaceManualConsumedSourceV2('activity-overlay', 'fit', 'garmin-official')).toBe(
    'garmin_policy_adapter_unavailable',
  );
});
