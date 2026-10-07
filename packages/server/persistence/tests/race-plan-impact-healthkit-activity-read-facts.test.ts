import { expect, it } from 'vitest';
import { manualActivityReadProjectionInputSchema } from '../src/race-plan-impact-manual-activity-read-facts.js';
import {
  projectHealthKitActivityReadFacts,
  validateHealthKitActivityReadFacts,
} from '../src/race-plan-impact-healthkit-activity-read-facts.js';
import { impactDependencyDigest as digest } from '../src/race-plan-impact-dependencies.js';
const id = 'abcdefab-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function fixture() {
  const requested = { kind: 'activity', id, revisionId: '1', detailId: null, allocationId: null };
  const original = {
    title: 'Synthetic local import',
    kind: 'unknown',
    startedAt: '2026-10-07T00:00:00Z',
    durationSeconds: 0,
    durationKind: 'unknown',
    timezone: 'UTC',
    distanceMeters: null,
  };
  const overlay = {};
  const current = { id, revision: 1, deleted: false };
  const c = manualActivityReadProjectionInputSchema.parse({
    athleteId: 'synthetic-own',
    refs: [requested],
    actualFacts: [
      {
        requested,
        state: 'current',
        reason: null,
        current,
        content: { original, overlay, detail: null },
      },
    ],
    activityRosters: [
      {
        ...current,
        originalDigest: digest(original),
        overlayDigest: digest(overlay),
        source: {
          state: 'present',
          kind: 'healthkit',
          sourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          sourceRevision: 1,
          contentHash: 'c'.repeat(64),
        },
      },
    ],
    activityMetadata: [
      {
        ...current,
        overlay: { state: 'present', revision: 1 },
        source: {
          state: 'present',
          kind: 'healthkit',
          sourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          revision: 1,
          contentHash: 'c'.repeat(64),
          suppressed: false,
          revisionRecord: { state: 'present' },
        },
      },
    ],
  });
  return {
    ...c,
    healthkitSources: [
      {
        activityId: id,
        reason: null,
        observation: {
          adapterVersion: 2,
          kind: 'own_healthkit_activity',
          activityId: id,
          canonicalRevision: 1,
          source: {
            kind: 'healthkit',
            sourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            revision: 1,
            contentHash: 'c'.repeat(64),
          },
          originalDigest: digest(original),
          overlayDigest: digest(overlay),
          overlayRevision: 1,
          healthkitConsent: { kind: 'healthkit', granted: true, revision: 1 },
          sample: {
            id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            state: 'active',
            payloadDigest: 'c'.repeat(64),
          },
          claim: { epoch: id, consentRevision: 1 },
          lineage: 'created_activity',
          deregistration: { state: 'absent' },
        },
      },
    ],
  };
}

it('exact HK current metadata preserves original zero/null and remains unverified', () => {
  const c = fixture(),
    before = JSON.stringify(c),
    r = projectHealthKitActivityReadFacts(c);
  expect(r.status).toBe('projected_retained_healthkit_read_facts');
  if (r.status === 'blocked') throw Error(r.reason);
  expect(validateHealthKitActivityReadFacts(r.facts, c)).toMatchObject({
    status: 'validated_retained_healthkit_read_facts',
    authority: 'none',
    sourceAuthentication: 'unverified',
    freshness: 'not_checked',
  });
  expect(JSON.stringify(c)).toBe(before);
  expect(JSON.stringify(r)).not.toContain('startedAt');
});
it.each(['missing', 'extra', 'duplicate', 'source', 'body', 'epoch', 'detail', 'unknown'] as const)(
  '%s cannot manufacture current source correspondence',
  (part) => {
    const c = fixture();
    let input: unknown = c;
    const source = c.healthkitSources[0];
    if (!source) throw Error('FIXTURE_SOURCE_MISSING');
    switch (part) {
      case 'missing':
        c.healthkitSources = [];
        break;
      case 'extra':
        c.healthkitSources.push({
          ...source,
          activityId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        });
        break;
      case 'duplicate':
        c.healthkitSources.push(source);
        break;
      case 'source':
        source.observation.source.contentHash = 'd'.repeat(64);
        break;
      case 'body':
        source.observation.originalDigest = 'd'.repeat(64);
        break;
      case 'epoch':
        source.observation.claim.consentRevision = 2;
        break;
      case 'detail':
        input = { ...c, refs: [{ ...c.refs[0], detailId: id }] };
        break;
      case 'unknown':
        input = { ...c, permission: true };
    }
    const r = projectHealthKitActivityReadFacts(input);
    if (r.status !== 'blocked')
      expect(validateHealthKitActivityReadFacts(r.facts, input).status).toBe('blocked');
  },
);
it('caller witness mutation, visits-before-dedup, accessor remain finite blocked', () => {
  const c = fixture(),
    r = projectHealthKitActivityReadFacts(c);
  if (r.status === 'blocked') throw Error(r.reason);
  expect(validateHealthKitActivityReadFacts({ ...r.facts, athleteId: 'foreign' }, c).status).toBe(
    'blocked',
  );
  expect(
    projectHealthKitActivityReadFacts({ ...c, refs: Array.from({ length: 5000 }, () => c.refs[0]) })
      .status,
  ).toBe('blocked');
  let reads = 0;
  const x = {};
  Object.defineProperty(x, 'refs', {
    enumerable: true,
    get() {
      reads++;
      return [];
    },
  });
  expect(projectHealthKitActivityReadFacts(x).status).toBe('blocked');
  expect(reads).toBe(0);
});
