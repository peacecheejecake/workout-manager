import { expect, it } from 'vitest';
import { manualActivityReadProjectionInputSchema } from '../src/race-plan-impact-manual-activity-read-facts.js';
import {
  projectGarminActivityReadFacts,
  validateGarminActivityReadFacts,
} from '../src/race-plan-impact-garmin-activity-read-facts.js';
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
          kind: 'fit',
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
          kind: 'fit',
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
    garminSources: [
      {
        activityId: id,
        reason: null,
        observation: {
          adapterVersion: 2,
          kind: 'owned_garmin_current_source',
          activityId: id,
          canonicalRevision: 1,
          source: {
            kind: 'fit',
            sourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            revision: 1,
            contentHash: 'c'.repeat(64),
          },
          originalDigest: digest(original),
          overlayDigest: digest(overlay),
          overlayRevision: 1,
          collectionPermission: 'not_captured',
          collection: {
            garminActivityId: '12345',
            provider: 'garmin-connect-unofficial',
            official: false,
            outcome: 'imported',
            collectedAt: '2026-10-07T00:00:00Z',
          },
        },
      },
    ],
  };
}

it('exact Garmin current metadata preserves original zero/null and remains unverified', () => {
  const c = fixture(),
    before = JSON.stringify(c),
    r = projectGarminActivityReadFacts(c);
  expect(r.status).toBe('projected_retained_garmin_read_facts');
  if (r.status === 'blocked') throw Error(r.reason);
  expect(validateGarminActivityReadFacts(r.facts, c)).toMatchObject({
    status: 'validated_retained_garmin_read_facts',
    authority: 'none',
    sourceAuthentication: 'unverified',
    freshness: 'not_checked',
  });
  expect(JSON.stringify(c)).toBe(before);
  expect(JSON.stringify(r)).not.toContain('startedAt');
});
it.each([
  'missing',
  'extra',
  'duplicate',
  'source',
  'body',
  'provider',
  'detail',
  'unknown',
] as const)('%s cannot manufacture current source correspondence', (part) => {
  const c = fixture();
  let input: unknown = c;
  const source = c.garminSources[0];
  if (!source) throw Error('FIXTURE_SOURCE_MISSING');
  switch (part) {
    case 'missing':
      c.garminSources = [];
      break;
    case 'extra':
      c.garminSources.push({
        ...source,
        activityId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      });
      break;
    case 'duplicate':
      c.garminSources.push(source);
      break;
    case 'source':
      source.observation.source.contentHash = 'd'.repeat(64);
      break;
    case 'body':
      source.observation.originalDigest = 'd'.repeat(64);
      break;
    case 'provider':
      source.observation.collection.official = true;
      break;
    case 'detail':
      input = { ...c, refs: [{ ...c.refs[0], detailId: id }] };
      break;
    case 'unknown':
      input = { ...c, permission: true };
  }
  const r = projectGarminActivityReadFacts(input);
  if (r.status !== 'blocked')
    expect(validateGarminActivityReadFacts(r.facts, input).status).toBe('blocked');
});
it('caller witness mutation, visits-before-dedup, accessor remain finite blocked', () => {
  const c = fixture(),
    r = projectGarminActivityReadFacts(c);
  if (r.status === 'blocked') throw Error(r.reason);
  expect(validateGarminActivityReadFacts({ ...r.facts, athleteId: 'foreign' }, c).status).toBe(
    'blocked',
  );
  expect(
    projectGarminActivityReadFacts({ ...c, refs: Array.from({ length: 5000 }, () => c.refs[0]) })
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
  expect(projectGarminActivityReadFacts(x).status).toBe('blocked');
  expect(reads).toBe(0);
});
it('opaque source IDs retain case/Unicode and uppercase Activity aliases normalize without historical fallback', () => {
  const c = fixture(),
    s = c.garminSources[0],
    roster = c.activityRosters[0],
    metadata = c.activityMetadata[0];
  if (!s || roster?.source.state !== 'present' || metadata?.source.state !== 'present')
    throw Error('FIXTURE_MISSING');
  const opaque = 'Collected-食-A';
  s.observation.source.sourceId = opaque;
  roster.source.sourceId = opaque;
  metadata.source.sourceId = opaque;
  c.refs = c.refs.map((r) => ({ ...r, id: r.id.toUpperCase() }));
  const r = projectGarminActivityReadFacts(c);
  expect(r.status).toBe('projected_retained_garmin_read_facts');
  if (r.status === 'blocked') throw Error(r.reason);
  expect(r.facts.facts[0]?.source?.source.sourceId).toBe(opaque);
  s.observation.source.sourceId = 'collected-食-a';
  expect(projectGarminActivityReadFacts(c).status).toBe('blocked');
  const h = fixture();
  h.refs = h.refs.map((r) => ({ ...r, revisionId: '2' }));
  expect(projectGarminActivityReadFacts(h).status).toBe('blocked');
});
it('metadata extra/duplicate, source body resurrection, oversized primitive stay blocked', () => {
  const c = fixture(),
    m = c.activityMetadata[0];
  if (!m) throw Error('FIXTURE_MISSING');
  expect(projectGarminActivityReadFacts({ ...c, activityMetadata: [m, m] }).status).toBe('blocked');
  expect(
    projectGarminActivityReadFacts({
      ...c,
      activityMetadata: [m, { ...m, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }],
    }).status,
  ).toBe('blocked');
  const d = fixture();
  const a = d.actualFacts[0];
  if (!a?.current) throw Error('FIXTURE_MISSING');
  a.state = 'deleted';
  a.current.deleted = true;
  expect(projectGarminActivityReadFacts(d).status).toBe('blocked');
  expect(projectGarminActivityReadFacts('食'.repeat(1400000))).toMatchObject({
    status: 'blocked',
    reason: 'bounds_exceeded',
  });
});
