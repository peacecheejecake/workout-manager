import { describe, expect, it } from 'vitest';
import {
  compareCoreEvidenceDependencies,
  coreEvidenceDependencyManifestSchema,
  type CoreEvidenceDependencyManifest,
} from '../src/evidence-dependencies.js';
const base: CoreEvidenceDependencyManifest = {
  schemaVersion: 1,
  scope: 'core-ledgers-v1',
  athleteId: 'synthetic-owner',
  capturedAt: '2026-09-18T00:00:00Z',
  trainingPlan: { kind: 'absent' },
  activities: { count: '0', revisionSum: '0' },
  checkIns: { kind: 'absent' },
  sessionCompletions: { kind: 'absent' },
  aiConsent: { kind: 'absent' },
};
const versionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
describe('core evidence dependencies', () => {
  it('preserves absent heads without manufacturing zero revisions', () => {
    expect(coreEvidenceDependencyManifestSchema.parse(base)).toEqual(base);
    expect(compareCoreEvidenceDependencies(base, base)).toEqual({ status: 'fresh', changed: [] });
    expect(
      coreEvidenceDependencyManifestSchema.safeParse({
        ...base,
        checkIns: { kind: 'exists', revision: 0 },
      }).success,
    ).toBe(false);
  });
  it.each(['trainingPlan', 'activities', 'checkIns', 'sessionCompletions', 'aiConsent'] as const)(
    'detects %s independently',
    (field) => {
      const changes = {
        trainingPlan: { kind: 'exists', versionId },
        activities: { count: '1', revisionSum: '1' },
        checkIns: { kind: 'exists', revision: 1 },
        sessionCompletions: { kind: 'exists', revision: 1 },
        aiConsent: { kind: 'exists', revision: 1, granted: false },
      };
      expect(compareCoreEvidenceDependencies(base, { ...base, [field]: changes[field] })).toEqual({
        status: 'stale',
        changed: [field],
      });
    },
  );
  it('detects revisions, consent withdrawal, and head disappearance in deterministic order', () => {
    const old = {
      ...base,
      trainingPlan: { kind: 'exists', versionId },
      activities: { count: '1', revisionSum: '1' },
      checkIns: { kind: 'exists', revision: 1 },
      sessionCompletions: { kind: 'exists', revision: 1 },
      aiConsent: { kind: 'exists', revision: 1, granted: true },
    };
    const next = {
      ...base,
      activities: { count: '1', revisionSum: '2' },
      checkIns: { kind: 'exists', revision: 2 },
      sessionCompletions: { kind: 'exists', revision: 2 },
      aiConsent: { kind: 'exists', revision: 1, granted: false },
    };
    expect(compareCoreEvidenceDependencies(old, next)).toEqual({
      status: 'stale',
      changed: ['trainingPlan', 'activities', 'checkIns', 'sessionCompletions', 'aiConsent'],
    });
  });
  it('does not infer age policy from timestamps or staleness from object key order', () => {
    expect(
      compareCoreEvidenceDependencies(base, {
        ...base,
        capturedAt: '2020-01-01T00:00:00Z',
        activities: { revisionSum: '0', count: '0' },
      }),
    ).toEqual({ status: 'fresh', changed: [] });
  });
  it.each(['00', '01', '-1', '+1', '1.0', '1e2', ' 1', '1 ', '9'.repeat(41), 'NaN'])(
    'rejects noncanonical or oversized count %s without throwing',
    (count) => {
      expect(
        compareCoreEvidenceDependencies(base, { ...base, activities: { count, revisionSum: '0' } }),
      ).toEqual({ status: 'unsupported', reason: 'INVALID_OR_UNSUPPORTED_MANIFEST' });
    },
  );
  it('validates decimal sums exactly beyond safe JavaScript integers', () => {
    const count = '9999999999999999999999999999999999999999';
    expect(
      coreEvidenceDependencyManifestSchema.safeParse({
        ...base,
        activities: { count, revisionSum: count },
      }).success,
    ).toBe(true);
    for (const activities of [
      { count: '0', revisionSum: '1' },
      { count: '2', revisionSum: '1' },
      { count: 0, revisionSum: '0' },
      { count: '1', revisionSum: '1.1' },
    ])
      expect(coreEvidenceDependencyManifestSchema.safeParse({ ...base, activities }).success).toBe(
        false,
      );
  });
  it('rejects missing, extra, unsupported, invalid owner/time/head fields', () => {
    const { checkIns: _head, ...missing } = base;
    expect(_head).toEqual({ kind: 'absent' });
    for (const input of [
      missing,
      { ...base, extra: true },
      { ...base, schemaVersion: 2 },
      { ...base, scope: 'all' },
      { ...base, athleteId: ' owner' },
      { ...base, athleteId: '' },
      { ...base, capturedAt: 'today' },
      { ...base, trainingPlan: { kind: 'absent', versionId } },
      { ...base, trainingPlan: { kind: 'exists', versionId: 'invalid' } },
      { ...base, aiConsent: { kind: 'exists', revision: 2147483648, granted: true } },
      { ...base, checkIns: { kind: 'exists', revision: 1.5 } },
    ])
      expect(compareCoreEvidenceDependencies(input, base)).toEqual({
        status: 'unsupported',
        reason: 'INVALID_OR_UNSUPPORTED_MANIFEST',
      });
  });
  it('returns no dependency values when ownership differs', () => {
    expect(
      compareCoreEvidenceDependencies(base, {
        ...base,
        athleteId: 'other-owner',
        activities: { count: '2', revisionSum: '4' },
      }),
    ).toEqual({ status: 'unsupported', reason: 'OWNER_MISMATCH' });
  });
  it('rejects noncanonical UUID case without modifying wire values', () => {
    const expected = {
      ...base,
      trainingPlan: { kind: 'exists', versionId: versionId.toUpperCase() },
    };
    const snapshot = structuredClone(expected);
    expect(
      compareCoreEvidenceDependencies(expected, {
        ...base,
        trainingPlan: { kind: 'exists', versionId },
      }),
    ).toEqual({ status: 'unsupported', reason: 'INVALID_OR_UNSUPPORTED_MANIFEST' });
    expect(expected).toEqual(snapshot);
  });
});
