import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Database, Transaction } from '../src/database.js';
import type * as Semantic from '../src/race-manual-review-semantic-basis-v2.js';
import type * as Delta from '../src/race-manual-pooled-parent-delta-transport-v1.js';
import type * as Full from '../src/race-manual-pooled-chain-transport-v1.js';
import { createRaceManualPooledTransportFixtureV1 } from './race-manual-pooled-test-fixtures-v1.js';
const ports = vi.hoisted(() => ({ semantic: vi.fn(), delta: vi.fn(), full: vi.fn() }));
vi.mock('../src/race-manual-review-semantic-basis-v2.js', async (original) => ({
  ...(await original<typeof Semantic>()),
  prepareRaceManualSemanticBasisV2In: ports.semantic,
}));
vi.mock('../src/race-manual-pooled-parent-delta-transport-v1.js', async (original) => ({
  ...(await original<typeof Delta>()),
  readRaceManualPooledParentDeltaTransportV1In: ports.delta,
}));
vi.mock('../src/race-manual-pooled-chain-transport-v1.js', async (original) => ({
  ...(await original<typeof Full>()),
  readRaceManualPooledChainTransportV1In: ports.full,
}));
import {
  createRaceManualPooledApprovalRepositoryV2,
  createRaceManualPooledPublicRepositoryV2,
} from '../src/race-manual-pooled-bundle-v2.js';
import { createRaceManualPooledApprovalRepositoryV1 } from '../src/race-manual-pooled-bundle-v1.js';
import { encodeRaceManualReviewPooledRetainedPayloadV1 } from '../src/race-manual-review-pooled-retained-payload-v1.js';
import { toRaceManualReviewPooledDatabaseEnvelopeV1 } from '../src/race-manual-review-pooled-database-envelope-v1.js';
function response(value: unknown) {
  return {
    rows: [{ value, bytes: String(Buffer.byteLength(JSON.stringify(value))) }],
    rowCount: 1,
  };
}
function fixture() {
  const f = createRaceManualPooledTransportFixtureV1();
  const chain = {
    evidenceId: randomUUID(),
    decisionId: randomUUID(),
    proposalId: randomUUID(),
    readonlyCandidateDigest: 'a'.repeat(64),
  };
  const input = { schemaVersion: 1, chain, intent: f.command.intent, expectedBasis: f.basis };
  const query = vi.fn<Transaction['query']>(async () => response(null));
  const tx: Transaction = { athleteId: f.basis.athleteId, query };
  const run = async <T>(athleteId: string, callback: (tx: Transaction) => Promise<T>) => {
    expect(athleteId).toBe(tx.athleteId);
    return callback(tx);
  };
  const db: Database = {
    tenant: run,
    exclusiveTenant: run,
    snapshotTenant: run,
    close: async () => undefined,
  };
  const current = {
    status: 'current_dependencies_captured',
    basis: f.basis,
    prepared: { retained: f.logical },
  };
  const result = {
    schemaVersion: 2,
    evidenceId: chain.evidenceId,
    decisionId: chain.decisionId,
    proposalId: chain.proposalId,
    candidateDigest: chain.readonlyCandidateDigest,
    createdAt: '2026-10-08T00:00:00.123456Z',
    applicable: false,
    approvalAllowed: false,
  };
  return { f, chain, input, query, tx, db, current, result };
}
beforeEach(() => vi.clearAllMocks());
it('V2 fresh capture precedes delta and supplies exactly the actual encoded retained base with shared budget', async () => {
  const f = fixture(),
    order: string[] = [];
  ports.semantic.mockImplementation(async () => {
    order.push('fresh');
    return f.current;
  });
  ports.delta.mockImplementation(async () => {
    order.push('delta');
    return { status: 'unavailable', payload: null };
  });
  await expect(
    createRaceManualPooledApprovalRepositoryV2(f.db).prepare(f.tx.athleteId, f.input),
  ).rejects.toMatchObject({ code: 'PARENT_UNAVAILABLE' });
  expect(order).toEqual(['fresh', 'delta']);
  expect(ports.delta.mock.calls[0]?.[2]).toEqual(
    toRaceManualReviewPooledDatabaseEnvelopeV1(
      encodeRaceManualReviewPooledRetainedPayloadV1(f.f.logical),
    ),
  );
  expect(ports.delta.mock.calls[0]?.[3]).toBe(ports.semantic.mock.calls[0]?.[3]);
  expect(ports.full).not.toHaveBeenCalled();
  expect(f.query).not.toHaveBeenCalled();
});
it('stale fresh capture blocks before any delta read or write', async () => {
  const f = fixture();
  ports.semantic.mockResolvedValue({ status: 'blocked' });
  expect(
    await createRaceManualPooledApprovalRepositoryV2(f.db).prepare(f.tx.athleteId, f.input),
  ).toEqual({ status: 'blocked', reason: 'current_basis_unavailable' });
  expect(ports.delta).not.toHaveBeenCalled();
  expect(f.query).not.toHaveBeenCalled();
});
it('V1 keeps parent-first full transport and never opts into delta', async () => {
  const f = fixture();
  ports.full.mockResolvedValue({ status: 'unavailable' });
  await expect(
    createRaceManualPooledApprovalRepositoryV1(f.db).prepare(f.tx.athleteId, f.input),
  ).rejects.toMatchObject({ code: 'PARENT_UNAVAILABLE' });
  expect(ports.full).toHaveBeenCalledTimes(1);
  expect(ports.semantic).not.toHaveBeenCalled();
  expect(ports.delta).not.toHaveBeenCalled();
});
it('missing delta RPC propagates without full or legacy fallback', async () => {
  const f = fixture();
  ports.semantic.mockResolvedValue(f.current);
  ports.delta.mockRejectedValue(Object.assign(new Error('missing'), { code: '42883' }));
  await expect(
    createRaceManualPooledApprovalRepositoryV2(f.db).prepare(f.tx.athleteId, f.input),
  ).rejects.toMatchObject({ code: '42883' });
  expect(ports.full).not.toHaveBeenCalled();
  expect(f.query).not.toHaveBeenCalled();
});
it('reconstructed parent tuple mismatch is rejected before downstream processing', async () => {
  const f = fixture();
  ports.semantic.mockResolvedValue(f.current);
  ports.delta.mockResolvedValue({
    status: 'read',
    result: { ...f.result, proposalId: randomUUID() },
    payload: f.f.logical,
  });
  await expect(
    createRaceManualPooledApprovalRepositoryV2(f.db).prepare(f.tx.athleteId, f.input),
  ).rejects.toMatchObject({ code: 'PARENT_UNAVAILABLE' });
  expect(f.query).not.toHaveBeenCalled();
});
it('reconstructed original full parent roots still reject content changes', async () => {
  const f = fixture();
  ports.semantic.mockResolvedValue(f.current);
  const parent = structuredClone(f.f.logical);
  if (parent.state !== 'present') throw Error('PRESENT_REQUIRED');
  parent.payload.preparation.context.event.revision++;
  ports.delta.mockResolvedValue({ status: 'read', result: f.result, payload: parent });
  await expect(
    createRaceManualPooledApprovalRepositoryV2(f.db).prepare(f.tx.athleteId, f.input),
  ).rejects.toMatchObject({ code: 'STALE_BASIS' });
  expect(f.query).not.toHaveBeenCalled();
});
it('V2 public preview uses existing strict pooled138 purged reader', async () => {
  const f = fixture(),
    reference = {
      schemaVersion: 1,
      candidateId: randomUUID(),
      applicationDigest: 'a'.repeat(64),
      chain: f.chain,
      createdAt: f.result.createdAt,
    };
  f.query.mockResolvedValue(
    response({
      readerVersion: 2,
      reference,
      bodyState: 'purged',
      candidate: null,
      payloadEncoding: null,
      payload: null,
    }),
  );
  expect(
    await createRaceManualPooledPublicRepositoryV2(f.db).readPreview(
      f.tx.athleteId,
      reference.candidateId,
    ),
  ).toMatchObject({ status: 'unavailable', reason: 'review_body_purged' });
  expect(f.query.mock.calls[0]?.[0]).toContain('read_race_manual_pooled_public_preview_source_v1');
  expect(ports.delta).not.toHaveBeenCalled();
  expect(ports.semantic).not.toHaveBeenCalled();
});
function approvalFixture() {
  const f = fixture();
  const expectation = {
    appRevision: 1,
    manualPolicy: f.f.basis.manualBasis.policy,
    restoreGeneration: f.f.basis.restoreGeneration,
    semanticDigest: 'a'.repeat(64),
    heads: {
      training: { state: 'absent' },
      nutrition: { state: 'absent' },
      recovery: { state: 'absent' },
      routine_schedule: { state: 'absent' },
    },
  };
  const candidate = {
    schemaVersion: 1,
    candidateId: randomUUID(),
    applicationDigest: 'a'.repeat(64),
    chain: f.chain,
    createdAt: f.result.createdAt,
    raceChange: {
      eventId: f.f.basis.event.id,
      expectedRevision: f.f.basis.event.revision,
      newLocalDate: f.f.command.intent.newLocalDate,
    },
    expectation,
    authority: 'server_revalidation_required',
    applicationState: 'ready_for_explicit_approval',
    scope: 'whole_affected',
    affected: [],
    writes: [],
    notices: [],
  };
  const command = {
    schemaVersion: 1,
    candidateId: candidate.candidateId,
    applicationDigest: candidate.applicationDigest,
    chain: f.chain,
    raceChange: candidate.raceChange,
    expectation,
    idempotencyKey: 'synthetic-approval-key',
    confirmed: true,
  };
  const original = {
    schemaVersion: 1,
    status: 'committed',
    candidateId: candidate.candidateId,
    approvalId: randomUUID(),
    proposalId: f.chain.proposalId,
    approvedAt: f.result.createdAt,
    race: { eventId: candidate.raceChange.eventId, revision: 2 },
    versions: [],
    occurrenceIds: [],
    notices: [],
  };
  return { ...f, candidate, command, original };
}
it('V2 approval successful receipt returns before stored/fresh/delta processing', async () => {
  const f = approvalFixture();
  f.query.mockResolvedValue(response(f.original));
  expect(
    await createRaceManualPooledApprovalRepositoryV2(f.db).approve(f.tx.athleteId, f.command),
  ).toEqual(f.original);
  expect(f.query).toHaveBeenCalledTimes(1);
  expect(f.query.mock.calls[0]?.[0]).toContain('read_race_manual_application_receipt_v1');
  expect(ports.semantic).not.toHaveBeenCalled();
  expect(ports.delta).not.toHaveBeenCalled();
});
it('V2 stored approval captures fresh before delta, shares budget and never begins on missing parent', async () => {
  const f = approvalFixture(),
    order: string[] = [];
  f.query.mockImplementation(async (sql) => {
    if (sql.includes('read_race_manual_application_receipt_v1')) {
      order.push('receipt');
      return response(null);
    }
    if (sql.includes('read_race_manual_application_v1')) {
      order.push('stored');
      return response({ candidate: f.candidate, basis: f.f.basis });
    }
    throw Error('UNEXPECTED_WRITE');
  });
  ports.semantic.mockImplementation(async () => {
    order.push('fresh');
    return f.current;
  });
  ports.delta.mockImplementation(async () => {
    order.push('delta');
    return { status: 'unavailable', payload: null };
  });
  await expect(
    createRaceManualPooledApprovalRepositoryV2(f.db).approve(f.tx.athleteId, f.command),
  ).rejects.toMatchObject({ code: 'PARENT_UNAVAILABLE' });
  expect(order).toEqual(['receipt', 'stored', 'fresh', 'delta']);
  expect(ports.semantic.mock.calls[0]?.[3]).toBe(ports.delta.mock.calls[0]?.[3]);
  expect(f.query).toHaveBeenCalledTimes(2);
  expect(ports.full).not.toHaveBeenCalled();
});
it('V2 stale stored approval rejects before fetching any parent', async () => {
  const f = approvalFixture();
  f.query.mockImplementation(async (sql) =>
    response(
      sql.includes('read_race_manual_application_receipt_v1')
        ? null
        : { candidate: f.candidate, basis: f.f.basis },
    ),
  );
  ports.semantic.mockResolvedValue({ status: 'blocked' });
  await expect(
    createRaceManualPooledApprovalRepositoryV2(f.db).approve(f.tx.athleteId, f.command),
  ).rejects.toMatchObject({ code: 'STALE_BASIS' });
  expect(ports.delta).not.toHaveBeenCalled();
  expect(ports.full).not.toHaveBeenCalled();
  expect(f.query).toHaveBeenCalledTimes(2);
});
