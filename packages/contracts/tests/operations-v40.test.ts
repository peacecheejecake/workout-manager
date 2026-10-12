import { expect, it, vi } from 'vitest';
import { accountExportSchema, parseAccountExportV39 } from '@workout/contracts/operations';
import { fixture } from './operations-v39-fixtures.js';
import {
  parseAccountExportIncludingV39,
  parseAccountExportIncludingV40,
  parseAccountExportV40,
} from '../src/operations.js';

// Synthetic only. V40 = V39 + the ai-execution-jobs export v1 section.
const media = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  album = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  run = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  thread = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  evidence = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  job = 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  at = '2026-10-10T00:00:00.000001Z';
function v39() {
  const base = fixture();
  return {
    ...base,
    schemaVersion: 39 as const,
    data: {
      ...base.data,
      galleryMediaItems: [{ id: media }],
      galleryAlbums: [
        { schemaVersion: 1, id: album, title: '합성', revision: 1, createdAt: at, updatedAt: at },
      ],
      galleryAlbumMemberships: [{ mediaItemId: media, albumId: album }],
      galleryCourseAssociations: [],
      galleryAlbumDeletions: [],
    },
  };
}
function item(overrides: Record<string, unknown> = {}) {
  return {
    jobId: job,
    runId: run,
    threadId: thread,
    evidenceSnapshotId: evidence,
    commandVersion: 1,
    purpose: 'coaching',
    payloadClassification: 'health',
    selection: { providerId: 'openai', modelId: 'synthetic-model' },
    settingsRevision: 1,
    catalogRevision: 1,
    policyVersion: 'synthetic-policy:1',
    disclosureVersion: 'synthetic-disclosure:1',
    recipient: { recipientId: 'openai', disclosureVersion: 'synthetic-disclosure:1' },
    binding: {
      adapterBindingVersion: 'synthetic:adapter:1',
      vendorModelRef: 'synthetic:model',
      priceModelRef: 'synthetic-model',
      priceVersion: 'synthetic:price:1',
      tokenizerVersion: 'synthetic:tokenizer:1',
    },
    consentRevisions: { app: 1, ai: 1 },
    selectionDigest: 'a'.repeat(64),
    createdAt: at,
    disposition: null,
    ...overrides,
  };
}
function v40(items: unknown[] = [item()]) {
  const base = v39();
  return {
    ...base,
    schemaVersion: 40 as const,
    data: {
      ...base.data,
      coachingRuns: [
        { id: run, thread_id: thread, evidence_snapshot_id: evidence, status: { kind: 'queued' } },
      ],
      aiSettingsHeads: [{ revision: 1 }],
      aiSettingsRevisions: [
        {
          revision: 1,
          updated_at: at,
          catalog_revision: 1,
          policy_version: 'synthetic-policy:1',
          disclosure_version: 'synthetic-disclosure:1',
          default_provider_id: 'openai',
          default_model_id: 'synthetic-model',
          comparison_kind: 'off',
          comparison_provider_id: null,
          comparison_model_id: null,
        },
      ],
      aiExecutionJobs: { schemaVersion: 1, kind: 'ai_execution_jobs', items },
    },
  };
}

it('V40 carries the exact AI execution job section and every inherited V39 collection', () => {
  const value = v40();
  const parsed = parseAccountExportV40(value);
  expect(parsed.data.aiExecutionJobs).toEqual(value.data.aiExecutionJobs);
  expect(parsed.data.galleryAlbumMemberships).toEqual(value.data.galleryAlbumMemberships);
  expect(parsed.data.sourceAuthentication).toBe('not_authenticated');
  expect(parseAccountExportIncludingV40(value)).toEqual(parsed);
});
it('carries the append-only restore_cancelled disposition', () => {
  const value = v40([item({ disposition: { kind: 'restore_cancelled', decidedAt: at } })]);
  expect(parseAccountExportV40(value).data.aiExecutionJobs.items[0]?.disposition).toEqual({
    kind: 'restore_cancelled',
    decidedAt: at,
  });
  expect(() =>
    parseAccountExportV40(v40([item({ disposition: { kind: 'resumed', decidedAt: at } })])),
  ).toThrow();
});
it('rejects an absent section instead of manufacturing an empty one', () => {
  const value = v40();
  const data = Object.fromEntries(
    Object.entries(value.data).filter(([key]) => key !== 'aiExecutionJobs'),
  );
  expect(() => parseAccountExportV40({ ...value, data })).toThrow();
  expect(() => parseAccountExportV40({ ...value, schemaVersion: 39 })).toThrow();
  expect(() => parseAccountExportV40({ ...value, schemaVersion: '40' })).toThrow();
});
it('rejects internal receipt/digest/generation leakage and duplicate jobs', () => {
  for (const extra of [
    { receiptKey: `ai-execution:run:v1:${'a'.repeat(64)}` },
    { requestDigest: 'b'.repeat(64) },
    { restoreGenerationId: run },
    { dispatchAuthority: 'none' },
  ])
    expect(() => parseAccountExportV40(v40([item(extra)]))).toThrow();
  expect(() => parseAccountExportV40(v40([item(), item()]))).toThrow();
});
it('requires same-snapshot run, thread, evidence and settings revision correspondence', () => {
  expect(() => parseAccountExportV40(v40([item({ runId: album })]))).toThrow();
  expect(() => parseAccountExportV40(v40([item({ threadId: album })]))).toThrow();
  expect(() => parseAccountExportV40(v40([item({ evidenceSnapshotId: album })]))).toThrow();
  expect(() => parseAccountExportV40(v40([item({ settingsRevision: 2 })]))).toThrow();
  const empty = v40([]);
  expect(parseAccountExportV40(empty).data.aiExecutionJobs.items).toEqual([]);
});
it('keeps the inherited V39 gallery correspondence refinement', () => {
  const value = v40();
  expect(() =>
    parseAccountExportV40({ ...value, data: { ...value.data, galleryMediaItems: [] } }),
  ).toThrow();
});
it('excludes gallery renditions: no rendition collection is admitted', () => {
  const value = v40();
  for (const key of ['galleryRenditions', 'galleryRenditionJobs'])
    expect(() => parseAccountExportV40({ ...value, data: { ...value.data, [key]: [] } })).toThrow();
});
it('keeps historical V39 unchanged and never upgrades it', () => {
  const value = v39();
  expect(parseAccountExportIncludingV40(value)).toEqual(parseAccountExportV39(value));
  expect(parseAccountExportIncludingV40(value).data).not.toHaveProperty('aiExecutionJobs');
  expect(parseAccountExportIncludingV39(value)).toEqual(parseAccountExportV39(value));
  expect(() => parseAccountExportV40(value)).toThrow();
  const historical = fixture();
  expect(parseAccountExportIncludingV40(historical)).toEqual(accountExportSchema.parse(historical));
});
it('bounds and preguards unknown ingress without getter invocation', () => {
  const get = vi.fn();
  const raw = { ...v40() };
  Object.defineProperty(raw, 'schemaVersion', { get, enumerable: true });
  expect(() => parseAccountExportIncludingV40(raw)).toThrow();
  expect(get).not.toHaveBeenCalled();
  expect(() => parseAccountExportV40({ ...v40(), unexpected: 'x'.repeat(8388609) })).toThrow();
});
