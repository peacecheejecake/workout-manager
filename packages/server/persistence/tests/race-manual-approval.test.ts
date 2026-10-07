import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createRaceManualApprovalRepository,
  RaceManualApprovalError,
} from '../src/race-manual-approval.js';
import type { Database } from '../src/database.js';

const command = () => ({
  schemaVersion: 1,
  confirmed: true,
  idempotencyKey: randomUUID(),
  candidateId: randomUUID(),
  applicationDigest: 'a'.repeat(64),
  chain: {
    evidenceId: randomUUID(),
    decisionId: randomUUID(),
    proposalId: randomUUID(),
    readonlyCandidateDigest: 'b'.repeat(64),
  },
  raceChange: { eventId: randomUUID(), expectedRevision: 1, newLocalDate: '2026-10-10' },
  expectation: {
    appRevision: 1,
    manualPolicy: { id: 'manual-race-date-impact', version: 1, digest: 'd'.repeat(64) },
    restoreGeneration: randomUUID(),
    semanticDigest: 'c'.repeat(64),
    heads: {
      training: { state: 'absent' },
      nutrition: { state: 'absent' },
      recovery: { state: 'absent' },
      routine_schedule: { state: 'absent' },
    },
  },
});
function database() {
  const tenant = vi.fn(),
    snapshotTenant = vi.fn();
  const db: Database = { tenant, snapshotTenant, exclusiveTenant: vi.fn(), close: vi.fn() };
  return { db, tenant, snapshotTenant };
}
describe('manual atomic approval boundary', () => {
  it('rejects client recipes and legacy readonly candidate transport before entering a transaction', () => {
    const f = database(),
      repo = createRaceManualApprovalRepository(f.db);
    expect(() => repo.approve(randomUUID(), { ...command(), writes: [] })).toThrow();
    expect(() =>
      repo.approve(randomUUID(), { ...command(), schemaVersion: 2, apply: false }),
    ).toThrow();
    expect(f.snapshotTenant).not.toHaveBeenCalled();
    expect(f.tenant).not.toHaveBeenCalled();
  });
  it('rejects accessors before executing them or entering a transaction', () => {
    const f = database(),
      get = vi.fn(() => 1);
    const input = Object.defineProperty(command(), 'schemaVersion', { enumerable: true, get });
    expect(() => createRaceManualApprovalRepository(f.db).approve(randomUUID(), input)).toThrow();
    expect(get).not.toHaveBeenCalled();
    expect(f.snapshotTenant).not.toHaveBeenCalled();
  });
  it('requires the fenced snapshot port and never falls back to read committed tenant writes', () => {
    const f = database();
    const db: Database = { tenant: f.tenant, exclusiveTenant: vi.fn(), close: vi.fn() };
    expect(() => createRaceManualApprovalRepository(db).approve(randomUUID(), command())).toThrow(
      RaceManualApprovalError,
    );
    expect(f.tenant).not.toHaveBeenCalled();
  });
  it('rejects oversized primitive input before opening a transaction', () => {
    const f = database();
    expect(() =>
      createRaceManualApprovalRepository(f.db).prepare(randomUUID(), 'x'.repeat(4194305)),
    ).toThrow();
    expect(f.snapshotTenant).not.toHaveBeenCalled();
  });
});
