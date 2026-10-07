import { expect, it } from 'vitest';
import type { Transaction } from '../src/database.js';
import { captureRaceManualBasis } from '../src/race-plan-impact-manual-basis.js';
import {
  requireCurrentRaceManualReviewBindingV2In as requireBinding,
  raceManualReviewCurrentBindingCaptureV2Schema,
  raceManualReviewCurrentBindingV2Schema,
} from '../src/race-manual-review-current-binding-v2.js';
const athlete = 'Synthetic-食',
  eventId = 'a0000000-0000-4000-8000-000000000001',
  generation = 'b0000000-0000-4000-8000-000000000001';
async function fixture() {
  const state = { absent: false, granted: true, revision: 4, generation };
  const queries: string[] = [];
  const tx: Transaction = {
    athleteId: athlete,
    async query(sql) {
      queries.push(sql);
      if (sql.includes('current_restore_generation'))
        return { rows: [{ generation_id: state.generation }], rowCount: 1 };
      if (sql.includes('FROM consent'))
        return {
          rows: state.absent
            ? []
            : [
                sql.includes('SELECT kind')
                  ? { kind: 'app', granted: state.granted, revision: state.revision }
                  : { granted: state.granted, revision: state.revision },
              ],
          rowCount: state.absent ? 0 : 1,
        };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
      throw Error('UNEXPECTED_QUERY');
    },
  };
  const manualBasis = await captureRaceManualBasis(tx);
  const capture = raceManualReviewCurrentBindingCaptureV2Schema.parse({
    athleteId: athlete,
    restoreGeneration: generation,
    manualBasis,
    readSetDigest: '1'.repeat(64),
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
  });
  const scope = {
    purpose: manualBasis.purpose,
    athleteId: athlete,
    restoreGeneration: generation,
    expectedEvent: { id: eventId, revision: 1 },
    expectedPolicy: manualBasis.policy,
    expectedAppRevision: 4,
    expectedReadSetDigest: capture.readSetDigest,
  };
  queries.length = 0;
  return { state, queries, tx, capture, scope };
}
it('checks actual current app/fixed policy/generation without querying AI/provider/media or granting authority', async () => {
  const f = await fixture();
  const original = structuredClone(f.capture);
  const result = await requireBinding(f.tx, f.capture, f.scope);
  expect(raceManualReviewCurrentBindingV2Schema.parse(result)).toEqual(result);
  expect(result).toMatchObject({
    status: 'current_manual_basis_checked',
    appRevision: 4,
    permissionAuthority: 'none',
    authority: 'none',
    freshness: 'not_checked',
    storage: 'not_persisted',
    admissionAllowed: false,
    approvalAllowed: false,
  });
  expect(f.capture).toEqual(original);
  expect(f.queries.some((sql) => sql.includes('pg_advisory_xact_lock'))).toBe(true);
  expect(f.queries.some((sql) => sql.includes('current_restore_generation'))).toBe(true);
  expect(
    f.queries.every(
      (sql) => !sql.includes("kind='ai'") && !sql.includes('provider') && !sql.includes('media'),
    ),
  ).toBe(true);
});
for (const kind of ['absent', 'withdrawn', 'reallowed'] as const)
  it(`blocks current app ${kind} despite old allowed captured basis`, async () => {
    const f = await fixture();
    if (kind === 'absent') f.state.absent = true;
    else if (kind === 'withdrawn') f.state.granted = false;
    else f.state.revision += 2;
    await expect(requireBinding(f.tx, f.capture, f.scope)).rejects.toMatchObject(
      kind === 'reallowed'
        ? { message: 'STALE_RACE_MANUAL_BASIS' }
        : { code: 'APP_CONSENT_REQUIRED' },
    );
  });
it('rejects old fixed-policy digest even when capture and scope agree', async () => {
  const f = await fixture();
  f.capture.manualBasis.policy = { ...f.capture.manualBasis.policy, digest: '0'.repeat(64) };
  f.scope.expectedPolicy = f.capture.manualBasis.policy;
  await expect(requireBinding(f.tx, f.capture, f.scope)).rejects.toThrow(
    'STALE_RACE_MANUAL_POLICY',
  );
  expect(f.queries).toEqual([]);
});
it('checks current restore generation rather than trusting matching claimed tuple', async () => {
  const f = await fixture();
  f.state.generation = '30000000-0000-4000-8000-000000000001';
  await expect(requireBinding(f.tx, f.capture, f.scope)).rejects.toMatchObject({
    code: 'STALE_RESTORE_GENERATION',
  });
});
for (const field of [
  'tenant',
  'event',
  'revision',
  'digest',
  'appRevision',
  'generation',
  'policy',
] as const)
  it(`rejects mismatched ${field} scope before database reads`, async () => {
    const f = await fixture();
    if (field === 'tenant') f.scope.athleteId = 'Foreign-食';
    if (field === 'event') f.scope.expectedEvent.id = '30000000-0000-4000-8000-000000000001';
    if (field === 'revision') f.scope.expectedEvent.revision = 2;
    if (field === 'digest') f.scope.expectedReadSetDigest = '2'.repeat(64);
    if (field === 'appRevision') f.scope.expectedAppRevision = 5;
    if (field === 'generation') f.scope.restoreGeneration = '30000000-0000-4000-8000-000000000001';
    if (field === 'policy')
      f.scope.expectedPolicy = { ...f.scope.expectedPolicy, digest: '2'.repeat(64) };
    await expect(requireBinding(f.tx, f.capture, f.scope)).rejects.toMatchObject({
      code: 'MANUAL_SCOPE_MISMATCH',
    });
    expect(f.queries).toEqual([]);
  });
it('rejects foreign capture and preserves opaque athlete case', async () => {
  const f = await fixture();
  f.capture.athleteId = 'synthetic-食';
  await expect(requireBinding(f.tx, f.capture, f.scope)).rejects.toMatchObject({
    code: 'MANUAL_SCOPE_MISMATCH',
  });
});
it('blocks absent/withdrawn captured app basis and malformed/extra selfclaimed permission', async () => {
  const f = await fixture();
  await expect(
    requireBinding(
      f.tx,
      { ...f.capture, manualBasis: { ...f.capture.manualBasis, app: { state: 'absent' } } },
      f.scope,
    ),
  ).rejects.toMatchObject({ code: 'MANUAL_BASIS_UNAVAILABLE' });
  await expect(
    requireBinding(
      f.tx,
      {
        ...f.capture,
        manualBasis: {
          ...f.capture.manualBasis,
          app: { state: 'present', granted: false, revision: 4 },
        },
      },
      f.scope,
    ),
  ).rejects.toMatchObject({ code: 'MANUAL_BASIS_UNAVAILABLE' });
  await expect(
    requireBinding(f.tx, { ...f.capture, authorized: true }, f.scope),
  ).rejects.toMatchObject({ code: 'INVALID_MANUAL_BINDING' });
  await expect(
    requireBinding(f.tx, f.capture, { ...f.scope, purpose: 'coaching' }),
  ).rejects.toMatchObject({ code: 'INVALID_MANUAL_BINDING' });
  expect(f.queries).toEqual([]);
});
it('normalizes UUID aliases while preserving public opaque IDs', async () => {
  const f = await fixture();
  f.scope.expectedEvent.id = f.scope.expectedEvent.id.toUpperCase();
  f.scope.restoreGeneration = f.scope.restoreGeneration.toUpperCase();
  expect((await requireBinding(f.tx, f.capture, f.scope)).status).toBe(
    'current_manual_basis_checked',
  );
});
it('propagates actual database failure without converting it to checked permission', async () => {
  const f = await fixture();
  const failure = Error('SYNTHETIC_DB_ABORT');
  await expect(
    requireBinding(
      {
        ...f.tx,
        query: async () => {
          throw failure;
        },
      },
      f.capture,
      f.scope,
    ),
  ).rejects.toBe(failure);
});

it('rejects accessors without executing them or issuing database queries', async () => {
  const f = await fixture();
  let reads = 0;
  const capture = { ...f.capture };
  Object.defineProperty(capture, 'event', {
    enumerable: true,
    get() {
      reads++;
      return f.capture.event;
    },
  });
  await expect(requireBinding(f.tx, capture, f.scope)).rejects.toMatchObject({
    code: 'INVALID_MANUAL_BINDING',
  });
  const scope = { ...f.scope };
  Object.defineProperty(scope, 'purpose', {
    enumerable: true,
    get() {
      reads++;
      return f.scope.purpose;
    },
  });
  await expect(requireBinding(f.tx, f.capture, scope)).rejects.toMatchObject({
    code: 'INVALID_MANUAL_BINDING',
  });
  expect(reads).toBe(0);
  expect(f.queries).toEqual([]);
});
it('bounds plain unknown JSON before schema decoding and database access', async () => {
  const f = await fixture();
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  let deep: unknown = null;
  for (let i = 0; i < 66; i++) deep = { child: deep };
  const sparse = [0, 1];
  delete sparse[0];
  for (const invalid of [
    cycle,
    deep,
    new Date(),
    sparse,
    { x: Infinity },
    { x: () => 1 },
    { x: '食'.repeat(1400000) },
  ]) {
    await expect(requireBinding(f.tx, invalid, f.scope)).rejects.toMatchObject({
      code: 'INVALID_MANUAL_BINDING',
    });
  }
  expect(f.queries).toEqual([]);
});
