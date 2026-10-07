import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { prepareCoachingExecutionIn } from '../src/coaching-execution-preparation.js';
import type { Transaction } from '../src/database.js';

const intent = {
  threadId: randomUUID(),
  evidenceSnapshotId: randomUUID(),
  expectedConversationRevision: 1,
  settings: {
    revision: 1,
    catalogRevision: 1,
    policyVersion: 'policy:1',
    disclosureVersion: 'disclosure:1',
  },
  purpose: 'coaching',
};
const ports = {
  policy: { id: 'running-core-v2-training', version: '1' },
  registry: [],
  classifyEvidenceIn: async () => 'health',
};
const noIo: Transaction = {
  athleteId: randomUUID(),
  query: async () => {
    throw new Error('Unexpected SQL before input validation');
  },
};
it.each([
  null,
  {},
  { ...intent, athleteId: randomUUID() },
  { ...intent, affectedIds: [] },
  { ...intent, selectionDigest: 'a'.repeat(64) },
  { ...intent, permissions: { app: true } },
  { ...intent, expectedConversationRevision: 2147483647 },
  { ...intent, settings: { ...intent.settings, revision: 0 } },
  { ...intent, purpose: 'arbitrary_provider' },
])('strict user intent rejects client authority before any SQL (%#)', async (input) => {
  expect(await prepareCoachingExecutionIn(noIo, input, ports)).toEqual({
    kind: 'blocked',
    code: 'INVALID_INTENT',
    storage: 'not_persisted',
    admissionAllowed: false,
    sourceCompleteness: false,
  });
});
it.each([{}, Array.from({ length: 41 }, () => ({})), [{ text: 'x'.repeat(65536) }]])(
  'bounded registry rejects before owned source processing (%#)',
  async (registry) => {
    expect(await prepareCoachingExecutionIn(noIo, intent, { ...ports, registry })).toMatchObject({
      kind: 'blocked',
      code: 'INVALID_REGISTRY',
      admissionAllowed: false,
    });
  },
);
it('cyclic registry cannot escape the bounded unknown boundary', async () => {
  const registry: unknown[] = [];
  registry.push(registry);
  expect(await prepareCoachingExecutionIn(noIo, intent, { ...ports, registry })).toMatchObject({
    kind: 'blocked',
    code: 'INVALID_REGISTRY',
  });
});
