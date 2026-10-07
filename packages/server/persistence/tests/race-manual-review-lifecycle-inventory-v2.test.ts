import { expect, it } from 'vitest';
import {
  planRaceManualReviewLifecycleParentsV2,
  validateRaceManualReviewLifecycleTargetMembershipV2,
} from '../src/race-manual-review-lifecycle-inventory-v2.js';
const id = 'abcdefab-1234-4123-8123-abcdefabcdef',
  version = 'bbbbbbbb-1234-4123-8123-abcdefabcdef';
const refs = [
  { kind: 'race-event', sourceId: id, revision: 1 },
  { kind: 'plan-snapshot', sourceId: id, version: 2 },
  ...[
    'nutrition-plan-version',
    'routine-schedule-version',
    'routine-blueprint-version',
    'food-definition-version',
    'recovery-strategy-version',
    'recovery-method-version',
    'workout-template-version',
    'supplementary-exercise-version',
    'resource-text-version',
  ].map((kind) => ({ kind, sourceId: id, versionId: version })),
  { kind: 'routine-occurrence', sourceId: id },
  { kind: 'routine-run', sourceId: id, revision: 0 },
  { kind: 'session-completion', sourceId: 'session "opaque', planVersionId: version, revision: 2 },
  { kind: 'supplementary-session-copy', sourceId: version, sessionId: 'opaque-session' },
  {
    kind: 'manual-activity-source',
    sourceId: id,
    sourceRecordId: 'opaque-source',
    sourceRevision: 1,
  },
  { kind: 'activity-overlay', sourceId: id, revision: 1 },
  { kind: 'activity-canonical-values', sourceId: id, revision: 1 },
  { kind: 'intake-revision', sourceId: '섭취\\"opaque', revisionId: version },
  { kind: 'checkin-revision', sourceId: id, revision: 2 },
  {
    kind: 'checklist-confirmation',
    sourceId: 'check',
    revisionId: version,
    runId: id,
    stepId: 'step',
  },
  { kind: 'course-revision', sourceId: id, revisionId: version, revision: 2 },
  { kind: 'activity-track-descriptor', sourceId: id, trackId: version, revision: 1 },
  { kind: 'race-timing-pin-fragment', sourceId: id, revision: 1 },
  { kind: 'course-head-descriptor', sourceId: id, revision: 2 },
  { kind: 'gallery-descriptor', sourceId: id, accessRevision: 0 },
  { kind: 'routine-timer', sourceId: id, stepId: 'timer', revision: 0 },
];
it('plans all27 finite identities without implying DB presence or event authority', () => {
  const out = planRaceManualReviewLifecycleParentsV2(refs);
  expect(out).toHaveLength(27);
  expect(new Set(out.map((r) => r.identity.kind)).size).toBe(27);
  for (const r of out)
    expect(r).toMatchObject({
      originalEventAuthentication: 'unverified_original_event',
      authority: 'none',
      freshness: 'not_checked',
      storage: 'not_persisted',
      approvalAllowed: false,
      appWithdrawal: 'retained_read_allowed',
      catalogWithdrawal: 'not_source_deletion',
      correction: 'not_source_deletion',
    });
});
it('keeps numeric completion revision within the immutable plan namespace', () => {
  expect(
    planRaceManualReviewLifecycleParentsV2([
      { kind: 'session-completion', sourceId: '同じ', planVersionId: version, revision: 4 },
    ]),
  ).toMatchObject([
    {
      edge: {
        family: 'session-completion',
        sourceId: '同じ',
        versionKey: JSON.stringify([version, 4]),
      },
    },
  ]);
});
it('does not invent an intake UUID before actual origin binding', () => {
  expect(
    planRaceManualReviewLifecycleParentsV2([
      { kind: 'intake-revision', sourceId: 'opaque "섭취', revisionId: version },
    ]),
  ).toMatchObject([{ edge: { family: 'intake', sourceId: 'opaque "섭취', versionKey: version } }]);
});
it('keeps multiple same-event revisions distinct', () => {
  expect(
    planRaceManualReviewLifecycleParentsV2([
      { kind: 'race-timing-pin-fragment', sourceId: id, revision: 1 },
      { kind: 'race-timing-pin-fragment', sourceId: id, revision: 2 },
    ]).map((r) => r.edge.versionKey),
  ).toEqual(['1', '2']);
});
it('normalizes only UUID namespaces and rejects aliases', () => {
  expect(() =>
    planRaceManualReviewLifecycleParentsV2([
      { kind: 'race-event', sourceId: id, revision: 1 },
      { kind: 'race-event', sourceId: id.toUpperCase(), revision: 1 },
    ]),
  ).toThrow();
});
it('rejects forged identity authority/unknown namespace/malformed tuple', () => {
  for (const raw of [
    [{ kind: 'race-event', sourceId: id, revision: 1, confirmed: true }],
    [{ kind: 'not-known', sourceId: id }],
    [{ kind: 'checkin-revision', sourceId: id, revision: version }],
  ])
    expect(() => planRaceManualReviewLifecycleParentsV2(raw)).toThrow();
});
it('rejects5001 visits before deduplication', () => {
  expect(() =>
    planRaceManualReviewLifecycleParentsV2(
      Array.from({ length: 5001 }, () => ({
        kind: 'intake-revision',
        sourceId: 'opaque',
        revisionId: version,
      })),
    ),
  ).toThrow();
});
it('preserves the supplied records and semantic opaque keys', () => {
  const before = JSON.stringify(refs);
  planRaceManualReviewLifecycleParentsV2(refs);
  expect(JSON.stringify(refs)).toBe(before);
});

it('rejects decoded UTF8 budget before accepting large opaque identities', () => {
  expect(() =>
    planRaceManualReviewLifecycleParentsV2([
      { kind: 'intake-revision', sourceId: '한'.repeat(1500000), revisionId: version },
    ]),
  ).toThrow();
});
it('rejects nonplain/accessor/sparse identity input without executing it', () => {
  let called = false;
  const raw = { kind: 'race-event', sourceId: id, revision: 1 };
  Object.defineProperty(raw, 'sourceId', {
    enumerable: true,
    get() {
      called = true;
      return id;
    },
  });
  expect(() => planRaceManualReviewLifecycleParentsV2([raw])).toThrow();
  expect(called).toBe(false);
  expect(() => planRaceManualReviewLifecycleParentsV2(Array(1))).toThrow();
});

it('compares exact target version and SQL115 key membership, not only equal counts', () => {
  const ref = { kind: 'workout-template-version', sourceId: id, versionId: version };
  const spec = {
    schemaVersion: 2,
    kind: 'supplementary',
    routineVersionId: version,
    blocks: [
      {
        id: 'block',
        mode: 'single',
        rounds: 1,
        restBetweenRoundsSeconds: null,
        sets: [
          {
            id: 'set',
            exerciseVersionId: id,
            side: 'unspecified',
            count: null,
            durationSeconds: {
              min: 30,
              max: 30,
              unit: 's',
              basis: 'user_confirmed',
              evidenceIds: [],
            },
            externalResistance: { kind: 'no_added_load' },
            restAfterSeconds: 0,
            tempo: null,
            effort: null,
          },
        ],
      },
    ],
  };
  const source = [{ kind: 'supplementary-exercise-version', sourceId: version, versionId: id }];
  const edge = {
    family: 'supplementary-exercise',
    sourceId: version,
    versionKey: id,
    role: 'target',
    membershipKey: [version, 'set'],
  };
  expect(validateRaceManualReviewLifecycleTargetMembershipV2(ref, spec, [edge], source)).toBe(true);
  expect(
    validateRaceManualReviewLifecycleTargetMembershipV2(
      ref,
      spec,
      [{ ...edge, membershipKey: [version, 'same-count-other-target'] }],
      source,
    ),
  ).toBe(false);
  expect(
    validateRaceManualReviewLifecycleTargetMembershipV2(
      ref,
      spec,
      [{ ...edge, versionKey: version }],
      source,
    ),
  ).toBe(false);
  expect(
    validateRaceManualReviewLifecycleTargetMembershipV2(
      { ...ref, kind: 'supplementary-session-copy', sourceId: version, sessionId: 'session' },
      { ...spec, routineVersionId: null },
      [{ ...edge, membershipKey: [version, 'session', 'set'] }],
      source,
    ),
  ).toBe(false); // versionId extra is rejected
  expect(
    validateRaceManualReviewLifecycleTargetMembershipV2(
      { kind: 'supplementary-session-copy', sourceId: version, sessionId: 'session' },
      { ...spec, routineVersionId: null },
      [{ ...edge, membershipKey: [version, 'session', 'set'] }],
      source,
    ),
  ).toBe(true);
});

it('multi-race lifecycle parent enumeration preserves both exact own dependencies without inventing PRIMARY authority', () => {
  const extra = {
    kind: 'race-event',
    sourceId: 'cccccccc-1234-4123-8123-abcdefabcdef',
    revision: 2,
  };
  const first = { kind: 'race-event', sourceId: id, revision: 1 };
  const parents = planRaceManualReviewLifecycleParentsV2([first, extra]);
  expect(parents.map((p) => p.identity)).toEqual([first, extra]);
  expect(parents).toHaveLength(2);
  expect(parents[0]?.edge).not.toEqual(parents[1]?.edge);
  expect(parents[0]).toMatchObject({
    authority: 'none',
    originalEventAuthentication: 'unverified_original_event',
  });
});
