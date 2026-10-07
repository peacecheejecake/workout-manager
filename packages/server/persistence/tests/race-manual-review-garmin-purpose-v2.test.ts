import { expect, it } from 'vitest';
import {
  captureRaceManualGarminPurposeV2In,
  captureRaceManualGarminActivitySourceV2In,
  raceManualGarminPurposeObservationV2Schema,
} from '../src/race-manual-review-garmin-purpose-v2.js';
import { impactDependencyDigest as digest } from '../src/race-plan-impact-dependencies.js';
import type { Transaction } from '../src/database.js';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sample = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export function fixture() {
  const original = {
    title: null,
    kind: 'running',
    startedAt: '2026-10-06T00:00:00Z',
    durationSeconds: 0,
    durationKind: 'unknown',
    timezone: null,
    distanceMeters: null,
  };
  const meta = {
    id,
    revision: 1,
    deleted: false,
    kind: 'fit',
    source_id: sample,
    source_revision: 1,
    content_hash: 'a'.repeat(64),
    revision_hash: 'a'.repeat(64),
    suppressed: false,
    overlay_revision: null,
    garmin_activity_id: '12345',
    provider: 'garmin-connect-unofficial',
    official: false,
    outcome: 'imported',
    collected_at: new Date('2026-10-07T00:00:00Z'),
    bytes: '2048',
  };
  const body = { original, overlay: null, source_record: original };
  const replies: Record<string, unknown>[][] = [[meta], [body]];
  const calls: string[] = [];
  const tx: Transaction = {
    athleteId: 'synthetic-owner',
    async query(sql) {
      calls.push(sql);
      const rows = replies.shift();
      if (!rows) throw Error('UNEXPECTED_QUERY');
      return { rows, rowCount: rows.length };
    },
  };
  const request = {
    activityId: id,
    canonicalRevision: 1,
    source: { kind: 'fit', sourceId: sample, revision: 1, contentHash: 'a'.repeat(64) },
    expectedOriginalDigest: digest(original),
    expectedOverlayDigest: null,
    expectedOverlayRevision: null,
  };
  return { tx, meta, body, replies, calls, request, budget: { bytes: 0n, sources: 0 } };
}
it('actual current collection metadata is separate from canonical DTO digest and authentication', async () => {
  const f = fixture(),
    r = await captureRaceManualGarminActivitySourceV2In(f.tx, f.request, f.budget);
  expect(r).toMatchObject({
    status: 'observed_garmin_current_source',
    authority: 'none',
    sourceAuthentication: 'unverified',
    freshness: 'not_checked',
    observation: {
      collection: { provider: 'garmin-connect-unofficial', official: false },
      originalDigest: digest(f.body.original),
    },
  });
  expect(f.calls[0]).toContain('LIMIT 2');
  expect(f.calls.join(' ')).not.toMatch(/encrypted|garmin_connection|garmin_unofficial_connection/);
  expect(f.calls[1]).toContain('FOR SHARE OF c,h,v,l,g');
  expect(JSON.stringify(r)).not.toContain('startedAt');
});
it.each(['ledger', 'official', 'deleted', 'suppressed', 'hash', 'tuple', 'overlay'] as const)(
  'actual %s rejection before body',
  async (kind) => {
    const f = fixture();
    let reason = 'garmin_provenance_unavailable';
    switch (kind) {
      case 'ledger':
        f.replies[0] = [{ ...f.meta, garmin_activity_id: null }];
        break;
      case 'official':
        f.meta.official = true;
        break;
      case 'deleted':
        f.meta.deleted = true;
        reason = 'garmin_source_deleted';
        break;
      case 'suppressed':
        f.meta.outcome = 'suppressed';
        reason = 'garmin_source_deleted';
        break;
      case 'hash':
        f.meta.revision_hash = 'b'.repeat(64);
        break;
      case 'tuple':
        f.request.canonicalRevision = 2;
        reason = 'garmin_source_tuple_mismatch';
        break;
      case 'overlay':
        f.replies[0] = [{ ...f.meta, overlay_revision: 2 }];
        reason = 'garmin_source_tuple_mismatch';
        break;
    }
    expect(
      await captureRaceManualGarminActivitySourceV2In(f.tx, f.request, f.budget),
    ).toMatchObject({
      status: 'blocked',
      reason,
      observation: null,
    });
    expect(f.calls).toHaveLength(1);
  },
);
it('foreign/absent source and body mismatch failclosed', async () => {
  const f = fixture();
  f.replies[0] = [];
  expect(await captureRaceManualGarminActivitySourceV2In(f.tx, f.request, f.budget)).toMatchObject({
    reason: 'garmin_source_unavailable',
  });
  const g = fixture();
  g.body.source_record = { ...g.body.original, durationSeconds: 1 };
  expect(await captureRaceManualGarminActivitySourceV2In(g.tx, g.request, g.budget)).toMatchObject({
    reason: 'garmin_source_tuple_mismatch',
  });
});
it('getter/huge/unknown input never grants purpose or reads DB', async () => {
  for (const input of [{ permission: true }, '食'.repeat(1400000)]) {
    const f = fixture();
    try {
      await captureRaceManualGarminActivitySourceV2In(f.tx, input, f.budget);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
    expect(f.calls).toHaveLength(0);
  }
  const f = fixture();
  let reads = 0;
  const input = {};
  Object.defineProperty(input, 'activityId', {
    enumerable: true,
    get() {
      reads++;
      return id;
    },
  });
  await expect(captureRaceManualGarminActivitySourceV2In(f.tx, input, f.budget)).rejects.toThrow();
  expect(reads).toBe(0);
});
it('response reservation precedes body and strict witness cannot carry authentication', async () => {
  const f = fixture();
  f.budget.bytes = 4194304n;
  await expect(
    captureRaceManualGarminActivitySourceV2In(f.tx, f.request, f.budget),
  ).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
  const g = fixture(),
    r = await captureRaceManualGarminActivitySourceV2In(g.tx, g.request, g.budget);
  expect(
    raceManualGarminPurposeObservationV2Schema.safeParse({ ...r.observation, verified: true })
      .success,
  ).toBe(false);
});
it('opaque FIT source identity preserves case and rejects historical revision without current re-pin', async () => {
  const f = fixture();
  f.meta.source_id = 'Source-食-A';
  f.request.source.sourceId = 'Source-食-A';
  expect(await captureRaceManualGarminActivitySourceV2In(f.tx, f.request, f.budget)).toMatchObject({
    status: 'observed_garmin_current_source',
    observation: { source: { sourceId: 'Source-食-A' } },
  });
  const g = fixture();
  g.request.source.revision = 2;
  expect(await captureRaceManualGarminActivitySourceV2In(g.tx, g.request, g.budget)).toMatchObject({
    reason: 'garmin_source_tuple_mismatch',
  });
  expect(g.calls).toHaveLength(1);
});
it('ambiguous multiple heads and exhausted meta-to-body budget never materialize body', async () => {
  const f = fixture();
  f.replies[0] = [f.meta, { ...f.meta }];
  expect(await captureRaceManualGarminActivitySourceV2In(f.tx, f.request, f.budget)).toMatchObject({
    reason: 'garmin_provenance_unavailable',
  });
  expect(f.calls).toHaveLength(1);
  const g = fixture();
  g.meta.bytes = '4194304';
  await expect(
    captureRaceManualGarminActivitySourceV2In(g.tx, g.request, g.budget),
  ).rejects.toThrow();
  expect(g.calls).toHaveLength(1);
});

it('already stored core use consumes actual app admission while collection permission remains unrecorded', async () => {
  const f = fixture();
  f.replies.unshift([], [{ kind: 'app', granted: true, revision: 3 }]);
  expect(await captureRaceManualGarminPurposeV2In(f.tx, f.request, f.budget)).toMatchObject({
    status: 'observed_saved_activity_core_use',
    observation: {
      kind: 'own_garmin_current_core_activity',
      collectionPermission: 'not_captured',
      appAdmission: { kind: 'app', granted: true, revision: 3 },
    },
    admissionAllowed: false,
    approvalAllowed: false,
    authority: 'none',
  });
  expect(f.calls[0]).toContain('pg_advisory_xact_lock');
  expect(f.calls[1]).toContain("kind='app'");
  expect(f.calls.join(' ')).not.toMatch(/kind='provider'|kind='ai'/);
});
it.each([{ rows: [] }, { rows: [{ kind: 'app', granted: false, revision: 2 }] }])(
  'absent/withdrawn actual app blocks core processing before source response',
  async ({ rows }) => {
    const f = fixture();
    f.replies.unshift([], rows);
    expect(await captureRaceManualGarminPurposeV2In(f.tx, f.request, f.budget)).toMatchObject({
      status: 'blocked',
      reason: 'garmin_core_app_processing_required',
      observation: null,
    });
    expect(f.calls).toHaveLength(2);
  },
);
it('caller app boolean, bodyless invalid tuple and exhausted app budget read DB0', async () => {
  for (const input of [
    { permission: true },
    { ...fixture().request, appAdmission: { granted: true } },
  ]) {
    const f = fixture();
    expect(await captureRaceManualGarminPurposeV2In(f.tx, input, f.budget)).toMatchObject({
      status: 'blocked',
      reason: 'garmin_source_tuple_mismatch',
    });
    expect(f.calls).toHaveLength(0);
  }
  const f = fixture();
  f.budget.bytes = 4194304n;
  await expect(captureRaceManualGarminPurposeV2In(f.tx, f.request, f.budget)).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});
it('unexpected app SQL failure propagates and cannot fall back to stored metadata', async () => {
  const f = fixture();
  const tx: Transaction = {
    athleteId: f.tx.athleteId,
    async query() {
      throw Error('SYNTHETIC_DB_DENIED');
    },
  };
  await expect(captureRaceManualGarminPurposeV2In(tx, f.request, f.budget)).rejects.toThrow(
    'SYNTHETIC_DB_DENIED',
  );
  expect(f.calls).toHaveLength(0);
});
