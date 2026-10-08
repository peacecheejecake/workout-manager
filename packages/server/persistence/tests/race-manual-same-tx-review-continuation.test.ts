function response(value: unknown) {
  return {
    rows: [{ bytes: String(Buffer.byteLength(JSON.stringify(value))), value }],
    rowCount: 1,
  };
}
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SemanticModule from '../src/race-manual-review-semantic-basis-v2.js';
import type * as LifecycleModule from '../src/race-manual-review-lifecycle-inventory-v2.js';
import type { Transaction } from '../src/database.js';
const ports = vi.hoisted(() => ({ semantic: vi.fn(), lifecycle: vi.fn() }));
vi.mock('../src/race-manual-review-semantic-basis-v2.js', async (original) => ({
  ...(await original<typeof SemanticModule>()),
  prepareRaceManualSemanticBasisV2In: ports.semantic,
}));
vi.mock('../src/race-manual-review-lifecycle-inventory-v2.js', async (original) => ({
  ...(await original<typeof LifecycleModule>()),
  captureRaceManualReviewCompatibleLifecycleInventoryIn: ports.lifecycle,
}));
import {
  captureRaceManualSameTxReviewContinuationIn as capture,
  storeRaceManualSameTxReviewContinuationIn as store,
  prepareRaceManualSameTxReviewApplicationIn as prepare,
  hasRaceManualSameTxReviewCapabilityIn as capability,
  invalidateRaceManualSameTxReviewContinuation as invalidate,
} from '../src/race-manual-same-tx-review-continuation.js';
const hash = 'a'.repeat(64);
function fixture() {
  const athleteId = randomUUID();
  const intent = {
    expectedEvent: { id: randomUUID(), revision: 1 },
    newLocalDate: '2026-10-09',
    selection: { kind: 'keep_plan' as const },
  };
  // Mocked actual capture isolates continuation plumbing; it is no DB ownership proof.
  const current = {
    status: 'current_dependencies_captured',
    basis: { athleteId },
    prepared: {
      retained: {
        payload: { preparation: { candidate: { status: 'assembled_readonly', digest: hash } } },
      },
    },
  };
  const lifecycle = { status: 'dependency_correspondence', athleteId };
  ports.semantic.mockResolvedValue(current);
  ports.lifecycle.mockResolvedValue(lifecycle);
  const result = {
    schemaVersion: 2 as const,
    evidenceId: randomUUID(),
    decisionId: randomUUID(),
    proposalId: randomUUID(),
    candidateDigest: hash,
    createdAt: '2026-10-08T00:00:00Z',
    applicable: false as const,
    approvalAllowed: false as const,
  };
  const chain = {
    evidenceId: result.evidenceId,
    decisionId: result.decisionId,
    proposalId: result.proposalId,
    readonlyCandidateDigest: hash,
  };
  let xid = '10';
  let ack: unknown = {
    ackVersion: 1,
    result,
    bodyState: 'present',
    payloadDigestMethod: 'postgres-jsonb-v1',
    payloadSqlDigest: 'b'.repeat(64),
    correspondence: 'same_tx_stored_parent',
  };
  let bytes: string | undefined;
  let executable = true;
  let installed = true;
  const query = vi.fn<Transaction['query']>(async (sql) => {
    if (sql.includes('to_regprocedure')) return response({ installed, executable });
    if (sql.includes('ack_manual_race_same_tx_parent'))
      return {
        rows: [{ bytes: bytes ?? String(Buffer.byteLength(JSON.stringify(ack))), value: ack }],
        rowCount: 1,
      };
    return response({
      xid,
      role: 'runtime',
      athleteId,
      isolation: 'repeatable read',
      readOnly: false,
    });
  });
  const tx: Transaction = { athleteId, query };
  const budget = { bytes: 0n, sources: 0 };
  return {
    tx,
    budget,
    intent,
    current,
    lifecycle,
    result,
    chain,
    query,
    setXid: (v: string) => {
      xid = v;
    },
    setAck: (v: unknown) => {
      ack = v;
    },
    setBytes: (v: string) => {
      bytes = v;
    },
    setCapability: (i: boolean, e: boolean) => {
      installed = i;
      executable = e;
    },
  };
}
async function captured(f: ReturnType<typeof fixture>) {
  const r = await capture(f.tx, f.intent, f.budget);
  if (r.status !== 'captured') throw Error('fixture capture failed');
  return r;
}
beforeEach(() => vi.clearAllMocks());
describe('private same-tx actual-capture continuation (mock plumbing only)', () => {
  it('uses one actual capture, actual store and SQL ACK before one application preparation', async () => {
    const f = fixture(),
      c = await captured(f);
    const persist = vi.fn(async () => f.result),
      application = vi.fn(async () => ({ status: 'prepared' }));
    await store(f.tx, c.handle, f.intent, c.basis, f.budget, persist);
    expect(persist).toHaveBeenCalledWith(f.current, f.lifecycle);
    await expect(
      prepare(f.tx, c.handle, f.intent, c.basis, f.chain, f.budget, application),
    ).resolves.toEqual({ status: 'prepared' });
    expect(ports.semantic).toHaveBeenCalledTimes(1);
    expect(ports.lifecycle).toHaveBeenCalledTimes(1);
    expect(
      f.query.mock.calls.filter(([sql]) => sql.includes('ack_manual_race_same_tx_parent')),
    ).toHaveLength(1);
    await expect(
      prepare(f.tx, c.handle, f.intent, c.basis, f.chain, f.budget, application),
    ).rejects.toThrow('SAME_TX_REVIEW_CONTINUATION_INVALID');
    expect(application).toHaveBeenCalledTimes(1);
  });
  it.each(['copy', 'json', 'new_tx', 'order', 'intent', 'basis', 'current', 'xid', 'invalidate'])(
    'rejects %s without a store',
    async (mode) => {
      const f = fixture(),
        c = await captured(f);
      let h: unknown = c.handle;
      let tx = f.tx;
      let intent = f.intent;
      let basis: unknown = c.basis;
      if (mode === 'copy') h = { ...c.handle };
      if (mode === 'json') h = JSON.parse(JSON.stringify(c.handle));
      if (mode === 'new_tx') tx = { ...f.tx };
      if (mode === 'intent') intent = { ...f.intent, newLocalDate: '2026-10-10' };
      if (mode === 'basis') basis = { athleteId: randomUUID() };
      if (mode === 'current')
        f.current.prepared.retained.payload.preparation.candidate.digest = 'c'.repeat(64);
      if (mode === 'xid') f.setXid('11');
      if (mode === 'invalidate') invalidate(h);
      const persist = vi.fn(async () => f.result);
      await expect(
        mode === 'order'
          ? prepare(tx, h, intent, basis, f.chain, f.budget, persist)
          : store(tx, h, intent, basis, f.budget, persist),
      ).rejects.toThrow('SAME_TX_REVIEW_CONTINUATION_INVALID');
      expect(persist).not.toHaveBeenCalled();
    },
  );
  it.each(['wrong_result', 'wrong_digest_method', 'extra', 'underreported', 'zero', 'sql_error'])(
    'rejects ACK %s and invalidates the handle',
    async (mode) => {
      const f = fixture(),
        c = await captured(f);
      if (mode === 'wrong_result')
        f.setAck({
          ackVersion: 1,
          result: { ...f.result, proposalId: randomUUID() },
          bodyState: 'present',
          payloadDigestMethod: 'postgres-jsonb-v1',
          payloadSqlDigest: hash,
          correspondence: 'same_tx_stored_parent',
        });
      if (mode === 'wrong_digest_method')
        f.setAck({
          ackVersion: 1,
          result: f.result,
          bodyState: 'present',
          payloadDigestMethod: 'node-json-v1',
          payloadSqlDigest: hash,
          correspondence: 'same_tx_stored_parent',
        });
      if (mode === 'extra')
        f.setAck({
          ackVersion: 1,
          result: f.result,
          bodyState: 'present',
          payloadDigestMethod: 'postgres-jsonb-v1',
          payloadSqlDigest: hash,
          correspondence: 'same_tx_stored_parent',
          authority: true,
        });
      if (mode === 'underreported') f.setBytes('1');
      if (mode === 'zero') f.setBytes('0');
      if (mode === 'sql_error')
        f.query.mockImplementation(async (sql) => {
          if (sql.includes('ack_manual')) throw Error('actual SQL failure');
          return response({
            xid: '10',
            role: 'runtime',
            athleteId: f.tx.athleteId,
            isolation: 'repeatable read',
            readOnly: false,
          });
        });
      await expect(
        store(f.tx, c.handle, f.intent, c.basis, f.budget, async () => f.result),
      ).rejects.toThrow();
      await expect(
        store(f.tx, c.handle, f.intent, c.basis, f.budget, async () => f.result),
      ).rejects.toThrow('SAME_TX_REVIEW_CONTINUATION_INVALID');
    },
  );
  it('debits actual measured ACK before application and keeps finite reservations', async () => {
    const f = fixture(),
      c = await captured(f);
    const before = f.budget.bytes;
    await store(f.tx, c.handle, f.intent, c.basis, f.budget, async () => f.result);
    expect(f.budget.bytes - before).toBeGreaterThan(0n);
    expect(f.budget.sources).toBe(3);
  });
  it('does not fall back after a malformed capability or query error', async () => {
    const f = fixture();
    f.setCapability(false, false);
    await expect(capability(f.tx, f.budget)).resolves.toBe(false);
    f.setCapability(false, true);
    await expect(capability(f.tx, f.budget)).rejects.toThrow();
    f.query.mockRejectedValueOnce(Error('query failed'));
    await expect(capability(f.tx, f.budget)).rejects.toThrow('query failed');
  });
  it('blocked actual preparation cannot mint a handle', async () => {
    const f = fixture();
    ports.semantic.mockResolvedValueOnce({ status: 'blocked' });
    await expect(capture(f.tx, f.intent, f.budget)).resolves.toEqual({
      status: 'blocked',
      stage: 'semantic',
    });
    expect(ports.lifecycle).not.toHaveBeenCalled();
  });
  it('store rollback and application failure invalidate one-use continuation', async () => {
    const f = fixture(),
      c = await captured(f);
    await expect(
      store(f.tx, c.handle, f.intent, c.basis, f.budget, async () => {
        throw Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    await expect(
      store(f.tx, c.handle, f.intent, c.basis, f.budget, async () => f.result),
    ).rejects.toThrow();
    const g = fixture(),
      d = await captured(g);
    await store(g.tx, d.handle, g.intent, d.basis, g.budget, async () => g.result);
    await expect(
      prepare(g.tx, d.handle, g.intent, d.basis, g.chain, g.budget, async () => {
        throw Error('application aborted');
      }),
    ).rejects.toThrow('application aborted');
    await expect(
      prepare(g.tx, d.handle, g.intent, d.basis, g.chain, g.budget, async () => null),
    ).rejects.toThrow();
  });
  it('claims the store phase before awaiting the backend so concurrent calls cannot both persist', async () => {
    const f = fixture(),
      c = await captured(f);
    const persist = vi.fn(async () => f.result);
    const outcomes = await Promise.allSettled([
      store(f.tx, c.handle, f.intent, c.basis, f.budget, persist),
      store(f.tx, c.handle, f.intent, c.basis, f.budget, persist),
    ]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(persist).toHaveBeenCalledTimes(1);
  });
  it.each(['huge', 'getter'])(
    'rejects %s retained ingress after the async store, before ACK serialization',
    async (mode) => {
      const f = fixture(),
        c = await captured(f);
      const getter = vi.fn(() => 'forbidden');
      await expect(
        store(f.tx, c.handle, f.intent, c.basis, f.budget, async () => {
          if (mode === 'huge')
            Object.assign(f.current.prepared.retained, { large: 'x'.repeat(4194305) });
          else
            Object.defineProperty(f.current.prepared.retained, 'extra', {
              enumerable: true,
              get: getter,
            });
          return f.result;
        }),
      ).rejects.toThrow();
      expect(getter).not.toHaveBeenCalled();
      expect(
        f.query.mock.calls.some(([sql]) => sql.includes('ack_manual_race_same_tx_parent')),
      ).toBe(false);
    },
  );
  it('debits capability actual scalar bytes and rejects underreported scalar envelopes', async () => {
    const f = fixture();
    await capability(f.tx, f.budget);
    expect(f.budget.bytes).toBe(
      BigInt(Buffer.byteLength(JSON.stringify({ installed: true, executable: true }))),
    );
    f.query.mockResolvedValueOnce({
      rows: [{ bytes: '1', value: { installed: true, executable: true } }],
      rowCount: 1,
    });
    await expect(capability(f.tx, f.budget)).rejects.toThrow();
  });
});
