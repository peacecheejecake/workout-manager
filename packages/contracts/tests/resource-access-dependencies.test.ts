import { describe, expect, it } from 'vitest';
import {
  compareEvidenceDependencies,
  compareResourceAccessDependencies,
  evidenceDependencyManifestSchema,
  resourceAccessDependencyManifestSchema,
  type CoreEvidenceDependencyManifest,
  type ResourceAccessDependencyManifest,
} from '../src/evidence-dependencies.js';
import { compareTrainingCoachingBasis } from '../src/coaching-basis.js';

const owner = 'synthetic-owner';
const resourceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const versionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const snapshotId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const threadId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const planVersionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

/**
 * A stand-in for the server digest. The comparator only compares digests; it
 * never recomputes one, because the manifest is a server-produced artifact and
 * its self-consistency is checked where it is captured. This helper only has to
 * be a stable function of the same inputs.
 */
function digest(input: {
  athleteId: string;
  aiConsentGranted: boolean;
  aiConsentRevision: number;
  entries: { resourceId: string; accessRevision: number; currentVersionId: string }[];
}) {
  const source = JSON.stringify({
    athleteId: input.athleteId,
    aiConsentGranted: input.aiConsentGranted,
    aiConsentRevision: input.aiConsentRevision,
    entries: [...input.entries]
      .sort((left, right) => (left.resourceId < right.resourceId ? -1 : 1))
      .map((entry) => [entry.resourceId, entry.accessRevision, entry.currentVersionId]),
  });
  let hash = 0x811c9dc5;
  for (const character of source) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').repeat(8);
}

function resourceAccess(
  overrides: Partial<{
    athleteId: string;
    aiConsentRevision: number;
    aiConsentGranted: boolean;
    entries: { resourceId: string; accessRevision: number; currentVersionId: string }[];
  }> = {},
): ResourceAccessDependencyManifest {
  const athleteId = overrides.athleteId ?? owner;
  const aiConsentRevision = overrides.aiConsentRevision ?? 1;
  const aiConsentGranted = overrides.aiConsentGranted ?? true;
  const entries = overrides.entries ?? [
    { resourceId, accessRevision: 3, currentVersionId: versionId },
  ];
  return resourceAccessDependencyManifestSchema.parse({
    schemaVersion: 1,
    scope: 'resource-access-v1',
    athleteId,
    capturedAt: '2026-09-20T00:00:00Z',
    aiConsentRevision,
    aiConsentGranted,
    complete: true,
    entriesDigest: digest({ athleteId, aiConsentGranted, aiConsentRevision, entries }),
    entries,
  });
}

const core: CoreEvidenceDependencyManifest = {
  schemaVersion: 2,
  scope: 'core-ledgers-v2',
  athleteId: owner,
  capturedAt: '2026-09-20T00:00:00Z',
  trainingPlan: { kind: 'exists', versionId: planVersionId },
  activities: { count: '0', revisionSum: '0' },
  checkIns: { kind: 'absent' },
  sessionCompletions: { kind: 'absent' },
  userConstraints: { kind: 'absent' },
  aiConsent: { kind: 'exists', revision: 1, granted: true },
};

describe('resource access dependencies', () => {
  it('reports a changed authorized set and a changed consent head separately', () => {
    const pinned = resourceAccess();
    expect(compareResourceAccessDependencies(pinned, pinned)).toEqual({
      status: 'fresh',
      changed: [],
    });
    // An added, removed or re-revisioned resource all change the set digest.
    expect(compareResourceAccessDependencies(pinned, resourceAccess({ entries: [] }))).toEqual({
      status: 'stale',
      changed: ['authorizedSet'],
    });
    expect(
      compareResourceAccessDependencies(
        pinned,
        resourceAccess({
          entries: [{ resourceId, accessRevision: 4, currentVersionId: versionId }],
        }),
      ),
    ).toEqual({ status: 'stale', changed: ['authorizedSet'] });
    expect(
      compareResourceAccessDependencies(
        pinned,
        resourceAccess({ aiConsentGranted: false, aiConsentRevision: 2, entries: [] }),
      ),
    ).toEqual({ status: 'stale', changed: ['aiConsent', 'authorizedSet'] });
  });

  it('never compares one tenant manifest against another', () => {
    expect(
      compareResourceAccessDependencies(resourceAccess(), resourceAccess({ athleteId: 'other' })),
    ).toEqual({ status: 'unsupported', reason: 'OWNER_MISMATCH' });
    expect(compareResourceAccessDependencies(resourceAccess(), { scope: 'other' })).toEqual({
      status: 'unsupported',
      reason: 'INVALID_OR_UNSUPPORTED_MANIFEST',
    });
  });

  it('requires both halves of the complete dependency manifest', () => {
    const manifest = evidenceDependencyManifestSchema.parse({
      schemaVersion: 1,
      scope: 'evidence-dependencies-v1',
      core,
      resourceAccess: resourceAccess(),
    });
    expect(compareEvidenceDependencies(manifest, manifest)).toEqual({
      status: 'fresh',
      changed: [],
    });
    // A missing half is unsupported, never silently treated as unchanged.
    expect(
      compareEvidenceDependencies({ ...manifest, resourceAccess: undefined }, manifest),
    ).toEqual({ status: 'unsupported', reason: 'INVALID_OR_UNSUPPORTED_MANIFEST' });
    expect(
      compareEvidenceDependencies(manifest, {
        ...manifest,
        core: { ...core, checkIns: { kind: 'exists', revision: 2 } },
        resourceAccess: resourceAccess({ entries: [] }),
      }),
    ).toEqual({
      status: 'stale',
      changed: ['core.checkIns', 'resourceAccess.authorizedSet'],
    });
    expect(
      compareEvidenceDependencies(manifest, {
        ...manifest,
        resourceAccess: resourceAccess({ athleteId: 'other' }),
      }),
    ).toEqual({ status: 'unsupported', reason: 'OWNER_MISMATCH' });
  });
});

describe('retrieval freshness on the coaching basis', () => {
  const basis = (retrieval: unknown) => ({
    schemaVersion: 1,
    scope: 'running-core-v2-training',
    athleteId: owner,
    evidenceSnapshotId: snapshotId,
    threadId,
    conversationRevision: 1,
    planVersionId,
    dependencies: core,
    policy: { id: 'running-core-v2-training', version: '1' },
    retrieval,
  });
  const observation = (retrieval: unknown) => ({
    schemaVersion: 1,
    scope: 'running-core-v2-training',
    athleteId: owner,
    evidence: {
      id: snapshotId,
      threadId,
      createdAt: '2026-09-20T00:00:00Z',
      status: 'available',
    },
    conversationRevision: 1,
    dependencies: core,
    policy: { id: 'running-core-v2-training', version: '1' },
    retrieval,
  });

  it('leaves an ungrounded run fresh when a resource is enabled later', () => {
    expect(
      compareTrainingCoachingBasis(
        basis({ kind: 'none' }),
        observation({ kind: 'resource-access-v1', query: '회복', manifest: resourceAccess() }),
      ),
    ).toEqual({ status: 'fresh', changed: [] });
  });

  it('marks a grounded run stale when the authorized set or the query changes', () => {
    const pinned = { kind: 'resource-access-v1', query: '회복', manifest: resourceAccess() };
    expect(compareTrainingCoachingBasis(basis(pinned), observation(pinned))).toEqual({
      status: 'fresh',
      changed: [],
    });
    expect(
      compareTrainingCoachingBasis(
        basis(pinned),
        observation({ ...pinned, manifest: resourceAccess({ entries: [] }) }),
      ),
    ).toEqual({ status: 'stale', changed: ['retrieval.authorizedSet'] });
    expect(
      compareTrainingCoachingBasis(basis(pinned), observation({ ...pinned, query: '강도' })),
    ).toEqual({ status: 'stale', changed: ['retrieval'] });
    expect(compareTrainingCoachingBasis(basis(pinned), observation({ kind: 'none' }))).toEqual({
      status: 'stale',
      changed: ['retrieval'],
    });
  });

  it('refuses a grounded basis whose manifest belongs to another tenant or lacks consent', () => {
    expect(
      compareTrainingCoachingBasis(
        basis({
          kind: 'resource-access-v1',
          query: '회복',
          manifest: resourceAccess({ athleteId: 'other' }),
        }),
        observation({ kind: 'none' }),
      ),
    ).toEqual({ status: 'unsupported', reason: 'INVALID_OR_UNSUPPORTED_BASIS' });
    expect(
      compareTrainingCoachingBasis(
        basis({
          kind: 'resource-access-v1',
          query: '회복',
          manifest: resourceAccess({ aiConsentGranted: false, entries: [] }),
        }),
        observation({ kind: 'none' }),
      ),
    ).toEqual({ status: 'unsupported', reason: 'INVALID_OR_UNSUPPORTED_BASIS' });
  });
});
