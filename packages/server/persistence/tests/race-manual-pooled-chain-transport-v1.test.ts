import { expect, it, vi } from 'vitest';
import type { Transaction } from '../src/database.js';
import { createRaceManualPooledTransportFixtureV1 } from './race-manual-pooled-test-fixtures-v1.js';
import { encodeRaceManualReviewPooledRetainedPayloadV1 } from '../src/race-manual-review-pooled-retained-payload-v1.js';
import {
  toRaceManualReviewPooledDatabaseEnvelopeV1,
  raceManualReviewPooledDatabaseEnvelopeV1Schema,
} from '../src/race-manual-review-pooled-database-envelope-v1.js';
import { impactDependencyDigest } from '../src/race-plan-impact-dependencies.js';
import {
  storeRaceManualPooledChainTransportV1In as store,
  readRaceManualPooledChainTransportV1In as read,
  ackRaceManualPooledChainTransportV1In as ack,
  parseRaceManualPooledChainReadTransportV1 as parse,
} from '../src/race-manual-pooled-chain-transport-v1.js';
const f = createRaceManualPooledTransportFixtureV1();
const result = {
  schemaVersion: 2,
  evidenceId: '00000000-0000-4000-8000-000000000010',
  decisionId: '00000000-0000-4000-8000-000000000011',
  proposalId: '00000000-0000-4000-8000-000000000012',
  candidateDigest: f.logical.minimalAudit.candidateDigest,
  createdAt: '2026-10-08T00:00:00.123456Z',
  applicable: false,
  approvalAllowed: false,
};
const wire = toRaceManualReviewPooledDatabaseEnvelopeV1(
  encodeRaceManualReviewPooledRetainedPayloadV1(f.logical),
);
const present = (
  payload: unknown = wire,
  payloadEncoding: unknown = 'pooled-database-envelope-v1',
) => ({
  readerVersion: 1,
  schemaVersion: 2,
  result,
  payloadEncoding,
  payload,
  purgedAt: null,
  purgedEventId: null,
});
const purged = {
  ...present(null, null),
  purgedAt: '2026-10-08T00:00:01.654321Z',
  purgedEventId: '00000000-0000-4000-8000-000000000020',
};
function mock(values: unknown[]) {
  const calls: { sql: string; values: unknown[] | undefined }[] = [];
  const tx: Transaction = {
    athleteId: f.logical.minimalAudit.athleteId,
    query: async (sql, args) => {
      calls.push({ sql, values: args });
      const value = values.shift();
      return {
        rows: [{ bytes: String(Buffer.byteLength(JSON.stringify(value), 'utf8') + 40), value }],
        rowCount: 1,
      };
    },
  };
  return { tx, calls };
}
it('strict pooled and legacy readers preserve logical body, source array order and no-authority', () => {
  const pooled = parse(present());
  expect(pooled.payload).toEqual(f.logical);
  expect(parse(present(f.logical, 'legacy-retained-v2')).payload).toEqual(f.logical);
  expect(pooled).toMatchObject({
    authority: 'none',
    freshness: 'not_checked',
    approvalAllowed: false,
    planApplied: false,
  });
  const source = structuredClone(present());
  const decoded = parse(source);
  source.result.candidateDigest = 'f'.repeat(64);
  expect(decoded.result.candidateDigest).toBe(result.candidateDigest);
});
it('purged explicit unknown encoding never infers legacy or reconstructs deleted body', () => {
  expect(parse(purged)).toMatchObject({
    payload: null,
    payloadEncoding: null,
    bodyState: 'purged',
  });
  for (const raw of [
    { ...purged, payloadEncoding: 'legacy-retained-v2' },
    { ...purged, purgedAt: null },
    { ...present(), payloadEncoding: null },
    { ...present(), payloadEncoding: 'future' },
    { ...present(), readerVersion: 2 },
    { ...present(), extra: true },
  ])
    expect(() => parse(raw)).toThrow();
});
it('unknown boundary rejects accessor, giant/deep bodies and copied metadata tamper', () => {
  let calls = 0;
  const getter = Object.defineProperty({}, 'payload', {
    enumerable: true,
    get() {
      calls++;
      throw Error('PRIVATE');
    },
  });
  expect(() => parse(getter)).toThrow();
  expect(calls).toBe(0);
  expect(() => parse({ ...purged, extra: 'x'.repeat(4194305) })).toThrow();
  let deep: unknown = null;
  for (let i = 0; i < 65; i++) deep = { child: deep };
  expect(() => parse({ ...purged, extra: deep })).toThrow();
  const changed = structuredClone(wire);
  changed.payload.preparation.logicalDigest = 'f'.repeat(64);
  expect(() => parse(present(changed))).toThrow();
  expect(() => parse(present({ ...wire, payload: null }))).toThrow();
});
it('read MATERIALIZED single RPC uses measured shared budget and exact requested parent identity', async () => {
  const m = mock([present()]);
  const budget = { bytes: 100n, sources: 0 };
  const before = budget.bytes;
  const value = await read(m.tx, result.evidenceId, budget);
  expect(value.status).toBe('read');
  expect(budget.bytes).toBeGreaterThan(before);
  expect(m.calls).toHaveLength(1);
  expect(m.calls[0]?.sql).toContain('AS MATERIALIZED');
  expect(m.calls[0]?.values?.[1]).toBe((4194304n - before).toString());
  const wrong = mock([{ ...present(), result: { ...result, evidenceId: result.proposalId } }]);
  await expect(read(wrong.tx, result.evidenceId, { bytes: 0n, sources: 0 })).rejects.toThrow();
});
it('reported 0/null/under-count and query gate overflow cannot debit a successful body', async () => {
  for (const bytes of ['0', null, '1']) {
    const tx: Transaction = {
      athleteId: f.logical.minimalAudit.athleteId,
      query: async () => ({ rows: [{ bytes, value: purged }], rowCount: 1 }),
    };
    const budget = { bytes: 0n, sources: 0 };
    await expect(read(tx, result.evidenceId, budget)).rejects.toThrow();
    expect(budget.bytes).toBe(0n);
  }
  const tx: Transaction = {
    athleteId: f.logical.minimalAudit.athleteId,
    query: async () => ({ rows: [{ bytes: '10', value: null }], rowCount: 1 }),
  };
  await expect(read(tx, result.evidenceId, { bytes: 4194300n, sources: 0 })).rejects.toMatchObject({
    code: 'CONTEXT_UNAVAILABLE',
  });
});
it('invalid caller budget rejects before DB and missing parent remains unavailable', async () => {
  const m = mock([null]);
  for (const budget of [
    { bytes: -1n, sources: 0 },
    { bytes: 0n, sources: NaN },
  ])
    await expect(read(m.tx, result.evidenceId, budget)).rejects.toThrow();
  expect(m.calls).toHaveLength(0);
  expect(await read(m.tx, result.evidenceId, { bytes: 0n, sources: 0 })).toMatchObject({
    status: 'unavailable',
    authority: 'none',
  });
});
it('store receipt-first replays original minimal result without encoding or generating IDs', async () => {
  const m = mock([result]);
  let ids = 0;
  const value = await store(m.tx, f.command, null, null, null, { bytes: 0n, sources: 0 }, () => {
    ids++;
    throw Error('NO_IDS');
  });
  expect(value.status).toBe('replayed');
  expect(value.result).toEqual(result);
  expect(ids).toBe(0);
  expect(m.calls).toHaveLength(1);
});
it('fresh store sends frozen encoded envelope and strict original request/basis/lifecycle only', async () => {
  const m = mock([null, result]);
  const ids = [result.evidenceId, result.decisionId, result.proposalId];
  const logical = structuredClone(f.logical);
  const stored = await store(
    m.tx,
    f.command,
    logical,
    f.basis,
    f.lifecycle,
    { bytes: 0n, sources: 0 },
    () => {
      const id = ids.shift();
      if (!id) throw Error('IDS_EXHAUSTED');
      return id;
    },
  );
  expect(stored).toMatchObject({ status: 'stored', result, approvalAllowed: false });
  expect(m.calls).toHaveLength(2);
  expect(m.calls[1]?.sql).toContain('public.store_manual_race_pooled_chain_v1');
  const body = m.calls[1]?.values?.[5];
  if (typeof body !== 'string') throw Error('BODY');
  expect(raceManualReviewPooledDatabaseEnvelopeV1Schema.parse(JSON.parse(body))).toEqual(wire);
});
const pgHash = 'a'.repeat(64);
const acknowledgement = {
  ackVersion: 2,
  payloadEncoding: 'pooled-database-envelope-v1',
  result,
  bodyState: 'present',
  payloadDigestMethod: 'postgres-jsonb-v1',
  payloadSqlDigest: pgHash,
  correspondence: 'same_tx_stored_parent',
};
const ackResponse = {
  ack: acknowledgement,
  expectedPayloadSqlDigest: pgHash,
  context: {
    xid: '123',
    role: 'synthetic_app',
    athleteId: f.logical.minimalAudit.athleteId,
    isolation: 'repeatable read',
  },
};
it('ACK compares PostgreSQL encoding digest separately from Node logical digest', async () => {
  expect(impactDependencyDigest(wire)).not.toBe(pgHash);
  const m = mock([ackResponse]);
  const value = await ack(m.tx, result, f.logical, { bytes: 0n, sources: 0 });
  expect(value).toMatchObject({
    payloadSqlDigest: pgHash,
    authority: 'none',
    approvalAllowed: false,
  });
  expect(m.calls[0]?.sql).toContain("sha256(convert_to($5::jsonb::text,'UTF8'))");
  expect(m.calls).toHaveLength(1);
});
it('ACK bad encoding, digest namespace, result tuple, context or extra claims reject', async () => {
  for (const raw of [
    { ...ackResponse, expectedPayloadSqlDigest: impactDependencyDigest(wire) },
    { ...ackResponse, ack: { ...acknowledgement, payloadEncoding: 'legacy-retained-v2' } },
    { ...ackResponse, ack: { ...acknowledgement, ackVersion: 1 } },
    {
      ...ackResponse,
      ack: { ...acknowledgement, result: { ...result, decisionId: result.proposalId } },
    },
    { ...ackResponse, context: { ...ackResponse.context, isolation: 'read committed' } },
    { ...ackResponse, context: { ...ackResponse.context, athleteId: 'foreign' } },
    { ...ackResponse, ack: { ...acknowledgement, admissionAllowed: true } },
  ]) {
    const m = mock([raw]);
    await expect(ack(m.tx, result, f.logical, { bytes: 0n, sources: 0 })).rejects.toThrow();
  }
});
it('fresh inputs are snapshotted before receipt I/O and caller mutation cannot repin stored body', async () => {
  const logical = structuredClone(f.logical);
  const calls: unknown[][] = [];
  let number = 0;
  const ids = [result.evidenceId, result.decisionId, result.proposalId];
  const tx: Transaction = {
    athleteId: f.logical.minimalAudit.athleteId,
    query: async (_sql, values) => {
      calls.push(values ?? []);
      number++;
      if (number === 1) {
        logical.minimalAudit.athleteId = 'foreign';
        return { rows: [{ bytes: '4', value: null }], rowCount: 1 };
      }
      return { rows: [{ bytes: '600', value: result }], rowCount: 1 };
    },
  };
  await store(tx, f.command, logical, f.basis, f.lifecycle, { bytes: 0n, sources: 0 }, () => {
    const id = ids.shift();
    if (!id) throw Error('ID');
    return id;
  });
  const serialized = calls[1]?.[5];
  if (typeof serialized !== 'string') throw Error('WIRE');
  expect(raceManualReviewPooledDatabaseEnvelopeV1Schema.parse(JSON.parse(serialized))).toEqual(
    wire,
  );
  expect(logical.minimalAudit.athleteId).toBe('foreign');
});
it('concurrent result with different minted IDs is accepted only after exact original receipt correspondence', async () => {
  const original = { ...result, evidenceId: '00000000-0000-4000-8000-000000000030' };
  const m = mock([null, original, original]);
  const ids = [result.evidenceId, result.decisionId, result.proposalId];
  const replay = await store(
    m.tx,
    f.command,
    f.logical,
    f.basis,
    f.lifecycle,
    { bytes: 0n, sources: 0 },
    () => {
      const id = ids.shift();
      if (!id) throw Error('ID');
      return id;
    },
  );
  expect(replay.status).toBe('replayed');
  expect(m.calls).toHaveLength(3);
  const bad = mock([null, original, { ...original, createdAt: '2026-10-08T00:00:02Z' }]);
  const minted = [result.evidenceId, result.decisionId, result.proposalId];
  await expect(
    store(bad.tx, f.command, f.logical, f.basis, f.lifecycle, { bytes: 0n, sources: 0 }, () => {
      const id = minted.shift();
      if (!id) throw Error('ID');
      return id;
    }),
  ).rejects.toThrow();
});

it('public-first fresh module initialization preserves strict reader and ACK result schemas', async () => {
  vi.resetModules();
  try {
    const publicEntry = await import('../src/race-manual-public.js');
    expect(publicEntry.createRaceManualPooledPublicRepositoryForBundle).toBeTypeOf('function');
    const transport = await import('../src/race-manual-pooled-chain-transport-v1.js');
    expect(transport.parseRaceManualPooledChainReadTransportV1(purged).result).toEqual(result);
    const m = mock([ackResponse]);
    expect(
      await transport.ackRaceManualPooledChainTransportV1In(m.tx, result, f.logical, {
        bytes: 0n,
        sources: 0,
      }),
    ).toMatchObject({ result, authority: 'none', approvalAllowed: false });
    expect(m.calls).toHaveLength(1);
    for (const changed of [
      { ...result, schemaVersion: 3 },
      { ...result, evidenceId: null },
      { ...result, extra: true },
      { ...result, applicable: true },
    ]) {
      expect(() =>
        transport.parseRaceManualPooledChainReadTransportV1({ ...purged, result: changed }),
      ).toThrow();
      const bad = mock([{ ...ackResponse, ack: { ...acknowledgement, result: changed } }]);
      await expect(
        transport.ackRaceManualPooledChainTransportV1In(bad.tx, result, f.logical, {
          bytes: 0n,
          sources: 0,
        }),
      ).rejects.toThrow();
    }
  } finally {
    vi.resetModules();
  }
});
