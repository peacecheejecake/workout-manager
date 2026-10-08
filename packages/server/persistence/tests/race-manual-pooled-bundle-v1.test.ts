import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Database, Transaction } from '../src/database.js';
import type * as Semantic from '../src/race-manual-review-semantic-basis-v2.js';
import type * as Lifecycle from '../src/race-manual-review-lifecycle-inventory-v2.js';
import type * as Transport from '../src/race-manual-pooled-chain-transport-v1.js';
const ports = vi.hoisted(() => ({ semantic: vi.fn(), lifecycle: vi.fn(), ack: vi.fn() }));
vi.mock('../src/race-manual-review-semantic-basis-v2.js', async (original) => ({
  ...(await original<typeof Semantic>()),
  prepareRaceManualSemanticBasisV2In: ports.semantic,
}));
vi.mock('../src/race-manual-review-lifecycle-inventory-v2.js', async (original) => ({
  ...(await original<typeof Lifecycle>()),
  captureRaceManualReviewCompatibleLifecycleInventoryIn: ports.lifecycle,
}));
vi.mock('../src/race-manual-pooled-chain-transport-v1.js', async (original) => ({
  ...(await original<typeof Transport>()),
  ackRaceManualPooledChainTransportV1In: ports.ack,
}));
import {
  createRaceManualPooledPublicRepositoryV1,
  createRaceManualPooledApprovalRepositoryV1,
} from '../src/race-manual-pooled-bundle-v1.js';
import {
  createRaceManualPublicRepository,
  readRaceManualPooledPublicPreviewIn,
} from '../src/race-manual-public.js';
import {
  captureRaceManualSameTxReviewContinuationIn as capture,
  storeRaceManualPooledSameTxReviewContinuationIn as store,
  prepareRaceManualSameTxReviewApplicationIn as prepare,
  invalidateRaceManualSameTxReviewContinuation as invalidate,
} from '../src/race-manual-same-tx-review-continuation.js';
const hash = 'a'.repeat(64);
function reference() {
  return {
    schemaVersion: 1,
    candidateId: randomUUID(),
    applicationDigest: hash,
    chain: {
      evidenceId: randomUUID(),
      decisionId: randomUUID(),
      proposalId: randomUUID(),
      readonlyCandidateDigest: hash,
    },
    createdAt: '2026-10-08T00:00:00Z',
  };
}
function response(value: unknown) {
  return {
    rows: [{ value, bytes: String(Buffer.byteLength(JSON.stringify(value))) }],
    rowCount: 1,
  };
}
function database(query: Transaction['query']): Database {
  const run = async <T>(athleteId: string, apply: (tx: Transaction) => Promise<T>) =>
    apply({ athleteId, query });
  return { tenant: run, exclusiveTenant: run, snapshotTenant: run, close: async () => undefined };
}
function continuationFixture() {
  const athleteId = randomUUID(),
    intent = {
      expectedEvent: { id: randomUUID(), revision: 1 },
      newLocalDate: '2026-10-09',
      selection: { kind: 'keep_plan' },
    };
  // Mock capture plumbing only; no database source/permission evidence.
  const current = {
    status: 'current_dependencies_captured',
    basis: { athleteId },
    prepared: {
      retained: {
        payload: { preparation: { candidate: { status: 'assembled_readonly', digest: hash } } },
      },
    },
  };
  ports.semantic.mockResolvedValue(current);
  ports.lifecycle.mockResolvedValue({ status: 'dependency_correspondence', athleteId });
  let xid = '10';
  const query = vi.fn<Transaction['query']>(async () =>
    response({ xid, role: 'runtime', athleteId, isolation: 'repeatable read', readOnly: false }),
  );
  const tx: Transaction = { athleteId, query };
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
  return {
    tx,
    intent,
    current,
    result,
    budget: { bytes: 0n, sources: 0 },
    changeXid: () => {
      xid = '11';
    },
  };
}
beforeEach(() => vi.clearAllMocks());
it('named public factory selects only SQL138 preview while legacy uses its unchanged reader', async () => {
  const ref = reference(),
    wire = {
      readerVersion: 2,
      reference: ref,
      bodyState: 'purged',
      candidate: null,
      payloadEncoding: null,
      payload: null,
    };
  const query = vi.fn<Transaction['query']>(async () => response(wire));
  const db = database(query);
  expect(
    await createRaceManualPooledPublicRepositoryV1(db).readPreview('synthetic', ref.candidateId),
  ).toMatchObject({ status: 'unavailable', reason: 'review_body_purged' });
  expect(query.mock.calls[0]?.[0]).toContain(
    'public.read_race_manual_pooled_public_preview_source_v1',
  );
  query.mockImplementation(async () =>
    response({ reference: ref, bodyState: 'purged', candidate: null, preparation: null }),
  );
  await createRaceManualPublicRepository(db).readPreview('synthetic', ref.candidateId);
  expect(query.mock.calls[1]?.[0]).toContain('public.read_race_manual_public_preview_source_v1');
});
it('unknown encoding and absent SQL never silently fall back to legacy', async () => {
  const ref = reference();
  const query = vi.fn<Transaction['query']>(async () =>
    response({
      readerVersion: 2,
      reference: ref,
      bodyState: 'purged',
      candidate: null,
      payloadEncoding: 'future',
      payload: null,
    }),
  );
  const repo = createRaceManualPooledPublicRepositoryV1(database(query));
  await expect(repo.readPreview('synthetic', ref.candidateId)).rejects.toThrow();
  expect(query).toHaveBeenCalledTimes(1);
  query.mockRejectedValue(Object.assign(new Error('undefined RPC'), { code: '42883' }));
  await expect(repo.readPreview('synthetic', ref.candidateId)).rejects.toMatchObject({
    code: '42883',
  });
  expect(query).toHaveBeenCalledTimes(2);
});
it('named factories require actual snapshot port, not RC substitution', async () => {
  const db = database(vi.fn());
  delete db.snapshotTenant;
  await expect(
    createRaceManualPooledPublicRepositoryV1(db).readPreview('synthetic', randomUUID()),
  ).rejects.toThrow();
  // Validating an invalid command also creates no transaction/permission.
  expect(() => createRaceManualPooledApprovalRepositoryV1(db).approve('synthetic', {})).toThrow();
});
it('pooled ACK uses the fixed v2 port, then consumes the actual capture once', async () => {
  const f = continuationFixture(),
    handle = await capture(f.tx, f.intent, f.budget);
  if (handle.status !== 'captured') throw Error('CAPTURE_REQUIRED');
  ports.ack.mockResolvedValue({ ackVersion: 2 });
  await store(f.tx, handle.handle, f.intent, f.current.basis, f.budget, async () => f.result);
  expect(ports.ack).toHaveBeenCalledWith(f.tx, f.result, f.current.prepared.retained, f.budget);
  const chain = {
    evidenceId: f.result.evidenceId,
    decisionId: f.result.decisionId,
    proposalId: f.result.proposalId,
    readonlyCandidateDigest: hash,
  };
  expect(
    await prepare(
      f.tx,
      handle.handle,
      f.intent,
      f.current.basis,
      chain,
      f.budget,
      async () => 'prepared',
    ),
  ).toBe('prepared');
  await expect(
    prepare(f.tx, handle.handle, f.intent, f.current.basis, chain, f.budget, async () => 'twice'),
  ).rejects.toThrow();
});
it('copied handle, changed backend xid, ACK failure and mutation never continue', async () => {
  for (const failure of ['copy', 'xid', 'ack', 'mutation', 'invalidate']) {
    const f = continuationFixture(),
      captured = await capture(f.tx, f.intent, f.budget);
    if (captured.status !== 'captured') throw Error('CAPTURE_REQUIRED');
    ports.ack.mockResolvedValue({ ackVersion: 2 });
    let handle = captured.handle;
    if (failure === 'copy') handle = { ...handle };
    if (failure === 'xid') f.changeXid();
    if (failure === 'invalidate') invalidate(handle);
    if (failure === 'ack') ports.ack.mockRejectedValue(new Error('ACK_FAILED'));
    if (failure === 'mutation')
      ports.ack.mockImplementation(async () => {
        f.current.prepared.retained.payload.preparation.candidate.digest = 'b'.repeat(64);
      });
    await expect(
      store(f.tx, handle, f.intent, f.current.basis, f.budget, async () => f.result),
    ).rejects.toThrow();
    if (failure === 'copy') {
      // A foreign object cannot invalidate the genuine factory-owned handle.
      expect(
        await store(
          f.tx,
          captured.handle,
          f.intent,
          f.current.basis,
          f.budget,
          async () => f.result,
        ),
      ).toEqual(f.result);
      invalidate(captured.handle);
    } else {
      await expect(
        store(f.tx, captured.handle, f.intent, f.current.basis, f.budget, async () => f.result),
      ).rejects.toThrow();
    }
  }
});
it('both protocols reject response underreport, zero/null bytes and value accessors without fallback', async () => {
  const ref = reference();
  for (const pooled of [false, true]) {
    const body = pooled
      ? {
          readerVersion: 2,
          reference: ref,
          bodyState: 'purged',
          candidate: null,
          payloadEncoding: null,
          payload: null,
        }
      : { reference: ref, bodyState: 'purged', candidate: null, preparation: null };
    for (const bytes of ['1', '0', null]) {
      const query = vi.fn<Transaction['query']>(async () => ({
        rows: [{ value: body, bytes }],
        rowCount: 1,
      }));
      const repo = pooled
        ? createRaceManualPooledPublicRepositoryV1(database(query))
        : createRaceManualPublicRepository(database(query));
      await expect(repo.readPreview('synthetic', ref.candidateId)).rejects.toThrow();
      expect(query).toHaveBeenCalledTimes(1);
    }
    let getterCalls = 0;
    const row = Object.defineProperty({ bytes: '100' }, 'value', {
      enumerable: true,
      get() {
        getterCalls++;
        return body;
      },
    });
    const query = vi.fn<Transaction['query']>(async () => ({ rows: [row], rowCount: 1 }));
    const repo = pooled
      ? createRaceManualPooledPublicRepositoryV1(database(query))
      : createRaceManualPublicRepository(database(query));
    await expect(repo.readPreview('synthetic', ref.candidateId)).rejects.toThrow();
    expect(getterCalls).toBe(0);
    const hidden = Object.defineProperty([], '0', {
      value: { value: body, bytes: String(Buffer.byteLength(JSON.stringify(body))) },
      enumerable: false,
    });
    query.mockImplementation(async () => ({ rows: hidden, rowCount: 1 }));
    await expect(repo.readPreview('synthetic', ref.candidateId)).rejects.toThrow();
  }
});
it('approval original receipt stays first and underreport never reaches fresh preparation', async () => {
  const input = {
    schemaVersion: 1,
    confirmed: true,
    idempotencyKey: randomUUID(),
    candidateId: randomUUID(),
    applicationDigest: hash,
    chain: {
      evidenceId: randomUUID(),
      decisionId: randomUUID(),
      proposalId: randomUUID(),
      readonlyCandidateDigest: hash,
    },
    raceChange: { eventId: randomUUID(), expectedRevision: 1, newLocalDate: '2026-10-10' },
    expectation: {
      appRevision: 1,
      manualPolicy: { id: 'manual-race-date-impact', version: 1, digest: hash },
      restoreGeneration: randomUUID(),
      semanticDigest: hash,
      heads: {
        training: { state: 'absent' },
        nutrition: { state: 'absent' },
        recovery: { state: 'absent' },
        routine_schedule: { state: 'absent' },
      },
    },
  };
  const original = {
    schemaVersion: 1,
    status: 'committed',
    candidateId: input.candidateId,
    approvalId: randomUUID(),
    proposalId: input.chain.proposalId,
    approvedAt: '2026-10-08T00:00:00Z',
    race: { eventId: input.raceChange.eventId, revision: 2 },
    versions: [],
    occurrenceIds: [],
    notices: [],
  };
  const query = vi.fn<Transaction['query']>(async () => response(original));
  expect(
    await createRaceManualPooledApprovalRepositoryV1(database(query)).approve('synthetic', input),
  ).toEqual(original);
  expect(query.mock.calls[0]?.[0]).toContain('read_race_manual_application_receipt_v1');
  expect(query.mock.calls[0]?.[0]).toContain(
    "octet_length(coalesce(to_jsonb(value)::text,'null'))",
  );
  expect(query).toHaveBeenCalledTimes(1);
  expect(ports.semantic).not.toHaveBeenCalled();
  query.mockImplementation(async () => ({ rows: [{ value: original, bytes: '1' }], rowCount: 1 }));
  await expect(
    createRaceManualPooledApprovalRepositoryV1(database(query)).approve('synthetic', input),
  ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
  expect(query).toHaveBeenCalledTimes(2);
  expect(ports.semantic).not.toHaveBeenCalled();
});
it('UUID and text scalars reserve JSON quote bytes before downstream DTO validation', async () => {
  // No database claim: PostgreSQL scalar JSONB measurement is checked separately
  // by Root PG. These mocked replies isolate the strict driver boundary.
  for (const value of [randomUUID(), 'a'.repeat(64), 'quote"\\\n𐀀']) {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    expect(bytes).toBeGreaterThan(Buffer.byteLength(value));
    const query = vi.fn<Transaction['query']>(async () => response(value));
    const repo = createRaceManualPooledPublicRepositoryV1(database(query));
    // Valid JSON scalar reaches the downstream object DTO rejection, rather
    // than the response underreport guard. A scalar is not a preview DTO.
    await expect(repo.readPreview('synthetic', randomUUID())).rejects.toMatchObject({
      code: 'PUBLIC_PREVIEW_INVALID_CONTEXT',
    });
    expect(query.mock.calls[0]?.[0]).toContain(
      "octet_length(COALESCE(to_jsonb(value)::text,'null'))",
    );
    const exactBudget = { bytes: 4194304n - BigInt(bytes), sources: 0 };
    await expect(
      readRaceManualPooledPublicPreviewIn(
        { athleteId: 'synthetic', query },
        randomUUID(),
        exactBudget,
      ),
    ).rejects.toMatchObject({ code: 'PUBLIC_PREVIEW_INVALID_CONTEXT' });
    expect(exactBudget.bytes).toBe(4194304n);
    const insufficient = { bytes: 4194304n - BigInt(bytes - 1), sources: 0 };
    const before = insufficient.bytes;
    await expect(
      readRaceManualPooledPublicPreviewIn(
        { athleteId: 'synthetic', query },
        randomUUID(),
        insufficient,
      ),
    ).rejects.toMatchObject({ code: 'PUBLIC_RESPONSE_LIMIT' });
    expect(insufficient.bytes).toBe(before);

    query.mockImplementation(async () => ({
      rows: [{ value, bytes: String(bytes - 1) }],
      rowCount: 1,
    }));
    await expect(repo.readPreview('synthetic', randomUUID())).rejects.toMatchObject({
      code: 'PUBLIC_INVALID_RESPONSE',
    });
  }
});
