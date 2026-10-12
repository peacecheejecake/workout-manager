import { describe, expect, it } from 'vitest';
import {
  aiExecutionJobExportV1Schema,
  aiExecutionJobQueuedPayloadV1Schema,
  aiExecutionJobV1Schema,
  aiExecutionRunCommandV1Schema,
  aiExecutionRunReceiptV1Schema,
} from '../src/ai-execution-jobs.js';

const uuid = (c: string) =>
  `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;
const command = {
  commandVersion: 1,
  evidenceSnapshotId: uuid('a'),
  expectedConversationRevision: 1,
  purpose: 'coaching',
  settings: { revision: 1, catalogRevision: 1, policyVersion: 'p:1', disclosureVersion: 'd:1' },
  idempotencyKey: 'key',
};
const item = {
  jobId: uuid('b'),
  runId: uuid('c'),
  threadId: uuid('d'),
  evidenceSnapshotId: uuid('a'),
  commandVersion: 1,
  purpose: 'coaching',
  payloadClassification: 'health',
  selection: { providerId: 'openai', modelId: 'gpt-6.1-sol' },
  settingsRevision: 1,
  catalogRevision: 1,
  policyVersion: 'p:1',
  disclosureVersion: 'd:1',
  recipient: { recipientId: 'openai', disclosureVersion: 'd:1' },
  binding: {
    adapterBindingVersion: 'a:1',
    vendorModelRef: 'v:1',
    priceModelRef: 'gpt-6.1-sol',
    priceVersion: 'p:1',
    tokenizerVersion: 't:1',
  },
  consentRevisions: { app: 1, ai: 1 },
  selectionDigest: 'e'.repeat(64),
  createdAt: '2026-10-13T00:00:00.000Z',
  disposition: null,
};

describe('AI execution job contracts', () => {
  it('accepts only the versioned explicit command without browser-forged facts', () => {
    expect(aiExecutionRunCommandV1Schema.parse(command)).toEqual(command);
    for (const forged of [
      { ...command, commandVersion: 2 },
      { ...command, selection: { providerId: 'openai', modelId: 'gpt-6-luna' } },
      { ...command, permissions: { app: true } },
      { ...command, selectionDigest: 'e'.repeat(64) },
      { ...command, retrieval: { kind: 'none' } },
      { ...command, settings: { ...command.settings, revision: 0 } },
      { ...command, idempotencyKey: ' padded' },
      { ...command, evidenceSnapshotId: uuid('a').toUpperCase() },
    ])
      expect(aiExecutionRunCommandV1Schema.safeParse(forged).success).toBe(false);
  });
  it('pins receipt, outbox payload and job view versions with no dispatch authority', () => {
    const receipt = {
      schemaVersion: 1,
      commandVersion: 1,
      jobId: uuid('b'),
      runId: uuid('c'),
      selectionDigest: 'e'.repeat(64),
    };
    expect(aiExecutionRunReceiptV1Schema.parse(receipt)).toEqual(receipt);
    expect(aiExecutionRunReceiptV1Schema.safeParse({ ...receipt, status: 'queued' }).success).toBe(
      false,
    );
    expect(
      aiExecutionJobQueuedPayloadV1Schema.safeParse({
        schemaVersion: 1,
        jobId: uuid('b'),
        runId: uuid('c'),
      }).success,
    ).toBe(true);
    const { consentRevisions: _unused, ...view } = item;
    const job = {
      schemaVersion: 1,
      ...view,
      runStatus: { kind: 'queued' },
      dispatchAuthority: 'none',
    };
    expect(aiExecutionJobV1Schema.safeParse(job).success).toBe(true);
    expect(
      aiExecutionJobV1Schema.safeParse({ ...job, dispatchAuthority: 'admitted' }).success,
    ).toBe(false);
    const cancelled = {
      ...job,
      runStatus: { kind: 'cancelled', reason: 'stale_basis' },
      disposition: { kind: 'restore_cancelled', decidedAt: '2026-10-13T01:00:00.000Z' },
    };
    expect(aiExecutionJobV1Schema.safeParse(cancelled).success).toBe(true);
    for (const disposition of [
      { kind: 'cancelled', decidedAt: '2026-10-13T01:00:00.000Z' },
      { kind: 'restore_cancelled' },
      undefined,
    ])
      expect(aiExecutionJobV1Schema.safeParse({ ...job, disposition }).success).toBe(false);
  });
  it('export rejects duplicate jobs and internal identifiers', () => {
    const exported = { schemaVersion: 1, kind: 'ai_execution_jobs', items: [item] };
    expect(aiExecutionJobExportV1Schema.parse(exported)).toEqual(exported);
    expect(
      aiExecutionJobExportV1Schema.safeParse({ ...exported, items: [item, item] }).success,
    ).toBe(false);
    expect(
      aiExecutionJobExportV1Schema.safeParse({
        ...exported,
        items: [{ ...item, receiptKey: 'ai-execution:run:v1:x' }],
      }).success,
    ).toBe(false);
  });
});
