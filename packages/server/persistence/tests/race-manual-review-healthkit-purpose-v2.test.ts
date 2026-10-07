import { expect, it } from 'vitest';
import {
  captureRaceManualHealthKitPurposeV2In,
  raceManualHealthKitPurposeObservationV2Schema,
} from '../src/race-manual-review-healthkit-purpose-v2.js';
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
    kind: 'healthkit',
    source_id: sample,
    source_revision: 1,
    content_hash: 'a'.repeat(64),
    revision_hash: 'a'.repeat(64),
    suppressed: false,
    overlay_revision: null,
    consent_granted: true,
    consent_revision: 1,
    sample_state: 'active',
    payload_digest: 'a'.repeat(64),
    lineage_state: 'created_activity',
    claim_epoch: id,
    claim_consent_revision: 1,
    deregistration_pending: false,
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
    source: { kind: 'healthkit', sourceId: sample, revision: 1, contentHash: 'a'.repeat(64) },
    expectedOriginalDigest: digest(original),
    expectedOverlayDigest: null,
    expectedOverlayRevision: null,
  };
  return { tx, meta, body, replies, calls, request, budget: { bytes: 0n, sources: 0 } };
}
it('actual claim and raw sample digest are separate from canonical DTO digest', async () => {
  const f = fixture(),
    r = await captureRaceManualHealthKitPurposeV2In(f.tx, f.request, f.budget);
  expect(r).toMatchObject({
    status: 'observed_healthkit_use',
    sourceAuthentication: 'unverified',
    authority: 'none',
    freshness: 'not_checked',
    observation: {
      sample: { payloadDigest: 'a'.repeat(64) },
      originalDigest: digest(f.body.original),
    },
  });
  expect(f.calls[0]).toContain('d.claim_epoch=q.claim_epoch');
  expect(f.calls.join(' ')).not.toContain('healthkit_workout_binding');
  expect(JSON.stringify(r)).not.toContain('startedAt');
});
it.each(['consent', 'claim', 'epoch', 'pending', 'lineage', 'deleted', 'hash', 'tuple'] as const)(
  'actual %s rejection before body',
  async (kind) => {
    const f = fixture();
    let reason = '';
    switch (kind) {
      case 'consent':
        f.meta.consent_granted = false;
        reason = 'healthkit_consent_required';
        break;
      case 'claim':
        f.replies[0] = [{ ...f.meta, claim_epoch: null }];
        reason = 'healthkit_claim_unavailable';
        break;
      case 'epoch':
        f.meta.claim_consent_revision = 2;
        reason = 'healthkit_claim_epoch_stale';
        break;
      case 'pending':
        f.meta.deregistration_pending = true;
        reason = 'healthkit_deregistration_pending';
        break;
      case 'lineage':
        f.meta.lineage_state = 'linked_existing';
        reason = 'healthkit_provenance_unavailable';
        break;
      case 'deleted':
        f.meta.deleted = true;
        reason = 'healthkit_source_deleted';
        break;
      case 'hash':
        f.meta.payload_digest = 'b'.repeat(64);
        reason = 'healthkit_provenance_unavailable';
        break;
      case 'tuple':
        f.request.canonicalRevision = 2;
        reason = 'healthkit_source_tuple_mismatch';
    }
    expect(await captureRaceManualHealthKitPurposeV2In(f.tx, f.request, f.budget)).toMatchObject({
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
  expect(await captureRaceManualHealthKitPurposeV2In(f.tx, f.request, f.budget)).toMatchObject({
    reason: 'healthkit_source_unavailable',
  });
  const g = fixture();
  g.body.source_record = { ...g.body.original, durationSeconds: 1 };
  expect(await captureRaceManualHealthKitPurposeV2In(g.tx, g.request, g.budget)).toMatchObject({
    reason: 'healthkit_source_tuple_mismatch',
  });
});
it('getter/huge/unknown input never grants purpose or reads DB', async () => {
  for (const input of [{ permission: true }, '食'.repeat(1400000)]) {
    const f = fixture();
    try {
      await captureRaceManualHealthKitPurposeV2In(f.tx, input, f.budget);
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
  await expect(captureRaceManualHealthKitPurposeV2In(f.tx, input, f.budget)).rejects.toThrow();
  expect(reads).toBe(0);
});
it('response reservation precedes body and strict witness cannot carry authentication', async () => {
  const f = fixture();
  f.budget.bytes = 4194304n;
  await expect(captureRaceManualHealthKitPurposeV2In(f.tx, f.request, f.budget)).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
  const g = fixture(),
    r = await captureRaceManualHealthKitPurposeV2In(g.tx, g.request, g.budget);
  expect(
    raceManualHealthKitPurposeObservationV2Schema.safeParse({ ...r.observation, verified: true })
      .success,
  ).toBe(false);
});
