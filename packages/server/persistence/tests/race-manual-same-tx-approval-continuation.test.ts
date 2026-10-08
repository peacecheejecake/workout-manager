import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { raceManualApprovalCommandSchema } from '@workout/contracts/race-manual-approval';
import type { Transaction } from '../src/database.js';
import { raceManualSemanticBasisV2Schema } from '../src/race-manual-review-semantic-basis-v2.js';
import {
  createRaceManualSameTxApprovalContinuation,
  assertRaceManualSameTxApprovalContinuation,
  raceManualStoredApprovalReadSchema,
} from '../src/race-manual-same-tx-approval-continuation.js';
import { approveRaceManualApplicationFromStoredCaptureIn } from '../src/race-manual-approval.js';
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

function response(value: unknown) {
  return {
    rows: [{ bytes: String(Buffer.byteLength(JSON.stringify(value))), value }],
    rowCount: 1,
  };
}
function fixture() {
  const b = basis();
  const candidate = {
    schemaVersion: 1,
    candidateId: randomUUID(),
    applicationDigest: 'a'.repeat(64),
    chain: {
      evidenceId: randomUUID(),
      decisionId: randomUUID(),
      proposalId: randomUUID(),
      readonlyCandidateDigest: 'b'.repeat(64),
    },
    createdAt: '2026-10-08T00:00:00.123456Z',
    raceChange: { eventId, expectedRevision: 1, newLocalDate: '2026-10-08' },
    expectation: {
      restoreGeneration: b.restoreGeneration,
      appRevision: 1,
      manualPolicy: b.manualBasis.policy,
      semanticDigest: 'c'.repeat(64),
      heads: {
        training: { state: 'absent' },
        nutrition: { state: 'absent' },
        recovery: { state: 'absent' },
        routine_schedule: { state: 'absent' },
      },
    },
    authority: 'server_revalidation_required',
    applicationState: 'ready_for_explicit_approval',
    scope: 'whole_affected',
    affected: [],
    writes: [],
    notices: [],
  };
  const stored = {
    reference: {
      schemaVersion: 1,
      candidateId: candidate.candidateId,
      applicationDigest: candidate.applicationDigest,
      chain: candidate.chain,
      createdAt: candidate.createdAt,
    },
    bodyState: 'present',
    candidate,
    basis: b,
    lifecycle: {
      inventoryVersion: 2,
      status: 'dependency_correspondence',
      athleteId: b.athleteId,
      facts: [],
      coverage: null,
      retainedState: 'present',
      retainedReason: null,
      originalEventAuthentication: 'unverified_original_event',
      sourceAuthentication: 'unverified',
      authority: 'none',
      freshness: 'not_checked',
      storage: 'not_persisted',
      admissionAllowed: false,
      approvalAllowed: false,
      appWithdrawal: 'retained_read_allowed',
      catalogWithdrawal: 'not_source_deletion',
      correction: 'not_source_deletion',
    },
  };
  const parsedStored = raceManualStoredApprovalReadSchema.parse(stored);
  if (parsedStored.bodyState !== 'present') throw Error('Fixture is not present');
  const command = raceManualApprovalCommandSchema.parse({
    schemaVersion: 1,
    idempotencyKey: 'synthetic_approve',
    confirmed: true,
    candidateId: candidate.candidateId,
    applicationDigest: candidate.applicationDigest,
    chain: candidate.chain,
    raceChange: candidate.raceChange,
    expectation: candidate.expectation,
  });
  const a = {
    xid: '42',
    role: 'synthetic_runtime',
    sessionRole: 'synthetic_runtime',
    athleteId: b.athleteId,
    isolation: 'repeatable read',
    readOnly: false,
  };
  const query = vi.fn<Transaction['query']>(async (sql) =>
    response(sql.includes('read_race_manual_public_candidate_v1') ? parsedStored : a),
  );
  const tx = { athleteId: b.athleteId, query };
  return {
    stored: parsedStored,
    command,
    a,
    tx,
    query,
    budget: { bytes: 0n, sources: 0 },
    factory: createRaceManualSameTxApprovalContinuation(),
  };
}
async function captured(f: ReturnType<typeof fixture>) {
  const value = await f.factory.capture(f.tx, f.command.candidateId, f.budget);
  if (!value || value.bodyState !== 'present') throw Error('Fixture capture unavailable');
  return value;
}
describe('actual-reader continuation plumbing; mocked rows are not SQL ownership evidence', () => {
  it('reads protected SQL122 once, charges actual bytes, clones stored content, consumes once and preserves US6', async () => {
    const f = fixture(),
      value = await captured(f),
      before = f.budget.bytes;
    value.candidate.createdAt = '2026-10-09T00:00:00Z';
    expect(
      await f.factory.consume(f.tx, value.handle, f.command, f.budget, async (copy) => {
        expect(copy.candidate.createdAt).toBe(f.stored.candidate.createdAt);
        copy.basis.event.title = 'Changed local copy';
        return 7;
      }),
    ).toBe(7);
    expect(f.stored.basis.event.title).toBe('Synthetic');
    expect(f.budget.bytes).toBeGreaterThan(before);
    await expect(
      f.factory.consume(f.tx, value.handle, f.command, f.budget, async () => 0),
    ).rejects.toThrow('SAME_TX_APPROVAL_CONTINUATION_INVALID');
    expect(
      f.query.mock.calls.filter(([s]) => s.includes('read_race_manual_public_candidate_v1')),
    ).toHaveLength(1);
    expect(f.query.mock.calls.some(([s]) => s.includes('read_race_manual_application_v1'))).toBe(
      false,
    );
  });
  it('rejects arbitrary DTO factory input before protected body read', async () => {
    const f = fixture();
    await expect(f.factory.capture(f.tx, f.stored, f.budget)).rejects.toThrow();
    expect(f.query).not.toHaveBeenCalled();
  });
  it('rejects copied handles, foreign factories and transaction objects', async () => {
    const f = fixture(),
      v = await captured(f),
      cb = vi.fn(async () => 0);
    for (const handle of [{ ...v.handle }, f.stored])
      await expect(f.factory.consume(f.tx, handle, f.command, f.budget, cb)).rejects.toThrow();
    await expect(
      createRaceManualSameTxApprovalContinuation().consume(f.tx, v.handle, f.command, f.budget, cb),
    ).rejects.toThrow();
    await expect(
      f.factory.consume({ ...f.tx }, v.handle, f.command, f.budget, cb),
    ).rejects.toThrow();
    expect(cb).not.toHaveBeenCalled();
  });
  it('rejects unregistered facade before any approval query', async () => {
    const f = fixture(),
      facade = { capture: vi.fn(), consume: vi.fn(), invalidate: vi.fn() };
    expect(() => assertRaceManualSameTxApprovalContinuation(facade)).toThrow();
    await expect(
      approveRaceManualApplicationFromStoredCaptureIn(f.tx, f.command, facade, {}, f.budget),
    ).rejects.toThrow();
    expect(f.query).not.toHaveBeenCalled();
  });
  for (const field of ['xid', 'role', 'sessionRole', 'athleteId', 'isolation', 'readOnly'] as const)
    it(`rejects changed actual ${field} anchor`, async () => {
      const f = fixture(),
        v = await captured(f),
        cb = vi.fn(async () => 0);
      f.query.mockImplementation(async () =>
        response({ ...f.a, [field]: field === 'readOnly' ? true : 'changed' }),
      );
      await expect(f.factory.consume(f.tx, v.handle, f.command, f.budget, cb)).rejects.toThrow();
      expect(cb).not.toHaveBeenCalled();
    });
  it('rejects changed command identity or tuple and invalidates', async () => {
    const f = fixture(),
      v = await captured(f),
      cb = vi.fn(async () => 0);
    await expect(
      f.factory.consume(
        f.tx,
        v.handle,
        { ...f.command, applicationDigest: 'd'.repeat(64) },
        f.budget,
        cb,
      ),
    ).rejects.toThrow();
    await expect(f.factory.consume(f.tx, v.handle, f.command, f.budget, cb)).rejects.toThrow();
    expect(cb).not.toHaveBeenCalled();
  });
  it('claims phase before await so concurrent consumption cannot duplicate', async () => {
    const f = fixture(),
      v = await captured(f);
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = f.factory.consume(f.tx, v.handle, f.command, f.budget, async () => {
      await gate;
      return 1;
    });
    await expect(
      f.factory.consume(f.tx, v.handle, f.command, f.budget, async () => 2),
    ).rejects.toThrow();
    release();
    expect(await first).toBe(1);
  });
  it('invalidates on callback failure and explicit cancellation', async () => {
    const f = fixture(),
      v = await captured(f);
    await expect(
      f.factory.consume(f.tx, v.handle, f.command, f.budget, async () => {
        throw Error('synthetic failure');
      }),
    ).rejects.toThrow('synthetic failure');
    await expect(
      f.factory.consume(f.tx, v.handle, f.command, f.budget, async () => 0),
    ).rejects.toThrow();
    const g = fixture(),
      w = await captured(g);
    g.factory.invalidate(w.handle);
    await expect(
      g.factory.consume(g.tx, w.handle, g.command, g.budget, async () => 0),
    ).rejects.toThrow();
  });
  it('rechecks actual anchor after async callback and rejects transaction drift', async () => {
    const f = fixture(),
      v = await captured(f);
    await expect(
      f.factory.consume(f.tx, v.handle, f.command, f.budget, async () => {
        f.a.xid = '43';
        return 0;
      }),
    ).rejects.toThrow();
  });
  it('does not mint handles for absent or purged body', async () => {
    const f = fixture();
    f.query.mockImplementation(async (sql) =>
      response(sql.includes('read_race_manual_public_candidate_v1') ? null : f.a),
    );
    expect(await f.factory.capture(f.tx, f.command.candidateId, f.budget)).toBeNull();
    f.query.mockImplementation(async (sql) =>
      response(
        sql.includes('read_race_manual_public_candidate_v1')
          ? {
              reference: f.stored.reference,
              bodyState: 'purged',
              candidate: null,
              basis: null,
              lifecycle: null,
            }
          : f.a,
      ),
    );
    expect(await f.factory.capture(f.tx, f.command.candidateId, f.budget)).toEqual({
      reference: f.stored.reference,
      bodyState: 'purged',
    });
  });
  it('rejects underreported response and oversized scalar without body', async () => {
    const f = fixture();
    f.query.mockResolvedValue({ rows: [{ bytes: '1', value: f.a }], rowCount: 1 });
    await expect(f.factory.capture(f.tx, f.command.candidateId, f.budget)).rejects.toThrow();
    f.query.mockResolvedValue({ rows: [{ bytes: '4194305', value: null }], rowCount: 1 });
    await expect(f.factory.capture(f.tx, f.command.candidateId, f.budget)).rejects.toMatchObject({
      bound: 'decoded_bytes',
    });
  });
  it('internal replay returns original before handle consumption and invalidates', async () => {
    const f = fixture(),
      v = await captured(f);
    const result = {
      schemaVersion: 1,
      status: 'committed',
      candidateId: f.command.candidateId,
      approvalId: randomUUID(),
      proposalId: f.command.chain.proposalId,
      approvedAt: '2026-10-08T00:00:00Z',
      race: { eventId, revision: 2 },
      versions: [],
      occurrenceIds: [],
      notices: [],
    };
    f.query.mockImplementation(async (sql) => {
      expect(sql).toContain('read_race_manual_application_receipt_v1');
      return response(result);
    });
    expect(
      await approveRaceManualApplicationFromStoredCaptureIn(
        f.tx,
        f.command,
        f.factory,
        v.handle,
        f.budget,
      ),
    ).toEqual(result);
    await expect(
      f.factory.consume(f.tx, v.handle, f.command, f.budget, async () => 0),
    ).rejects.toThrow();
  });
  it('rejects ordered expectation membership substitution without minting source truth', async () => {
    const f = fixture();
    const members = [randomUUID(), randomUUID()].map((aggregateId) => ({
      aggregateId,
      head: { kind: 'exists' as const, versionId: randomUUID(), version: 1 },
    }));
    f.stored.candidate.expectation.heads.nutrition = { state: 'present', members };
    f.command.expectation.heads.nutrition = { state: 'present', members: structuredClone(members) };
    const v = await captured(f),
      callback = vi.fn(async () => 0);
    const changed = structuredClone(f.command);
    if (changed.expectation.heads.nutrition.state !== 'present') throw Error('Fixture head absent');
    changed.expectation.heads.nutrition.members.reverse();
    await expect(f.factory.consume(f.tx, v.handle, changed, f.budget, callback)).rejects.toThrow();
    expect(callback).not.toHaveBeenCalled();
  });
  it('rejects foreign source scope, forged reference and unknown stored fields', async () => {
    for (const kind of ['basis_scope', 'lifecycle_scope', 'reference_tuple', 'extra'] as const) {
      const f = fixture(),
        body = structuredClone(f.stored);
      if (kind === 'basis_scope') body.basis.athleteId = 'foreign';
      if (kind === 'lifecycle_scope') body.lifecycle.athleteId = 'foreign';
      if (kind === 'reference_tuple') body.reference.chain.proposalId = randomUUID();
      const raw = kind === 'extra' ? { ...body, authority: true } : body;
      f.query.mockImplementation(async (sql) =>
        response(sql.includes('read_race_manual_public_candidate_v1') ? raw : f.a),
      );
      await expect(f.factory.capture(f.tx, f.command.candidateId, f.budget)).rejects.toThrow();
    }
  });
  it('driver body getters are rejected without execution', async () => {
    const f = fixture(),
      getter = vi.fn(() => f.stored.candidate);
    const body = Object.defineProperty({ ...f.stored }, 'candidate', {
      enumerable: true,
      get: getter,
    });
    f.query.mockImplementation(async (sql) =>
      response(sql.includes('read_race_manual_public_candidate_v1') ? null : f.a),
    );
    f.query
      .mockResolvedValueOnce(response(f.a))
      .mockResolvedValueOnce({ rows: [{ bytes: '1000', value: body }], rowCount: 1 });
    await expect(f.factory.capture(f.tx, f.command.candidateId, f.budget)).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});
