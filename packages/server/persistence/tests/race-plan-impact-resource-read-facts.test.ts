import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';

import { privateTextResourceVersionSchema } from '@workout/contracts/resources';

import type { Transaction } from '../src/database.js';
import {
  captureResourceRetainedReadFacts,
  validateResourceRetainedReadFacts,
} from '../src/race-plan-impact-resource-read-facts.js';

const resourceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const versionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const nextId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const text = 'Own retained 원문 0';
const record = privateTextResourceVersionSchema.parse({
  schemaVersion: 1,
  id: versionId,
  resourceId,
  version: 1,
  previousVersionId: null,
  contentHash: createHash('sha256').update(text).digest('hex'),
  source: { kind: 'text', text },
  paragraphs: [
    {
      locator: {
        kind: 'paragraph',
        resourceVersionId: versionId,
        index: 0,
        startOffset: 0,
        endOffset: text.length,
        offsetUnit: 'utf16_code_unit',
      },
      text,
    },
  ],
  lifecycle: { contentStatus: 'parsed', indexStatus: 'not_indexed' },
  createdAt: '2026-10-07T00:00:00.000Z',
});
const scalar = {
  resource_id: resourceId,
  version_id: versionId,
  version: 1,
  current_version_id: versionId,
  current_version: 1,
  access_revision: 1,
  deleted: false,
  source_kind: 'text',
  content_bytes: String(Buffer.byteLength(text)),
  paragraph_bytes: String(Buffer.byteLength(JSON.stringify(record.paragraphs))),
  paragraph_count: 1,
};
const body = {
  resource_id: resourceId,
  version_id: versionId,
  version: 1,
  previous_version_id: null,
  content: text,
  content_hash: record.contentHash,
  paragraphs: record.paragraphs,
  content_status: 'parsed',
  index_status: 'not_indexed',
  created_at: new Date(record.createdAt),
};
function harness(rows: Record<string, unknown>[][] = [[scalar], [body]]) {
  const calls: { sql: string; values: unknown[] | undefined }[] = [];
  const tx: Transaction = {
    athleteId: 'owner',
    async query(sql, values) {
      calls.push({ sql, values });
      const result = rows.shift();
      if (!result) throw Error('unexpected query');
      return { rows: result, rowCount: result.length };
    },
  };
  return { tx, calls, budget: { bytes: 0n, sources: 0 } };
}
function projection() {
  return {
    requestedVersionIds: [versionId],
    facts: [
      {
        requestedVersionId: versionId,
        state: 'current',
        reason: null,
        record,
        current: { resourceId, versionId, version: 1, accessRevision: 1, deleted: false },
      },
    ],
    authority: 'none',
    freshness: 'not_checked',
  };
}
it('reads exact own immutable text after scalar preflight without AI facts or permission claims', async () => {
  const h = harness(),
    result = await captureResourceRetainedReadFacts(h.tx, [versionId], h.budget);
  expect(result).toEqual(projection());
  expect(h.calls).toHaveLength(2);
  expect(h.calls[0]?.sql).toContain('octet_length');
  expect(h.calls[1]?.sql).toContain('r.access_revision=$3');
  expect(h.calls[0]?.values).toEqual(['owner', versionId]);
  expect(validateResourceRetainedReadFacts(result)).toMatchObject({
    status: 'validated_read_sources',
    authority: 'none',
    freshness: 'not_checked',
    complete: false,
  });
});
it('preserves historical original text and independent current head', async () => {
  const h = harness([
    [{ ...scalar, current_version_id: nextId, current_version: 2, access_revision: 3 }],
    [body],
  ]);
  const result = await captureResourceRetainedReadFacts(h.tx, [versionId], h.budget);
  expect(result.facts[0]).toMatchObject({
    state: 'historical',
    record,
    current: { versionId: nextId, version: 2, accessRevision: 3 },
  });
  expect(validateResourceRetainedReadFacts(result).status).toBe('validated_read_sources');
});
it('returns actual deletion tombstone without transporting retained text', async () => {
  const h = harness([
    [
      {
        ...scalar,
        deleted: true,
        content_bytes: '0',
        paragraph_bytes: '0',
        paragraph_count: 0,
        access_revision: 2,
      },
    ],
  ]);
  const result = await captureResourceRetainedReadFacts(h.tx, [versionId], h.budget);
  expect(result.facts[0]).toMatchObject({
    state: 'deleted',
    record: null,
    current: { deleted: true, accessRevision: 2 },
  });
  expect(h.calls).toHaveLength(1);
  expect(validateResourceRetainedReadFacts(result).blockers).toContainEqual({
    path: 'facts[0]',
    reason: 'source_deleted',
  });
});
it.each(['file', 'url'])('marks %s unsupported without loading body', async (source_kind) => {
  const h = harness([
    [{ ...scalar, source_kind, content_bytes: '0', paragraph_bytes: '0', paragraph_count: 0 }],
  ]);
  const result = await captureResourceRetainedReadFacts(h.tx, [versionId], h.budget);
  expect(result.facts[0]).toMatchObject({
    state: 'unavailable',
    reason: 'unsupported_source_kind',
    record: null,
  });
  expect(h.calls).toHaveLength(1);
});
it('does not invent source identity for absent or foreign version', async () => {
  const h = harness([[]]);
  const r = await captureResourceRetainedReadFacts(h.tx, [versionId], h.budget);
  expect(r.facts[0]).toMatchObject({
    reason: 'owned_version_unavailable',
    record: null,
    current: null,
  });
});
it('keeps opaque refs honest and queries only UUID refs', async () => {
  const h = harness([]);
  const r = await captureResourceRetainedReadFacts(h.tx, ['legacy-resource'], h.budget);
  expect(r.facts[0]?.current).toBeNull();
  expect(h.calls).toHaveLength(0);
});
it('normalizes UUID case but counts repeated visits before dedup', async () => {
  const h = harness();
  const r = await captureResourceRetainedReadFacts(
    h.tx,
    [versionId.toUpperCase(), versionId],
    h.budget,
  );
  expect(r.requestedVersionIds).toEqual([versionId]);
  expect(h.budget.sources).toBe(2);
  expect(h.calls).toHaveLength(2);
});
it('fails visit budget before query', async () => {
  const h = harness();
  h.budget.sources = 5000;
  await expect(captureResourceRetainedReadFacts(h.tx, [versionId], h.budget)).rejects.toThrow(
    'CONTEXT_UNAVAILABLE',
  );
  expect(h.calls).toHaveLength(0);
});
it.each([
  { bytes: -1n, sources: 0 },
  { bytes: 0n, sources: -1 },
  { bytes: 0n, sources: 0.5 },
])('rejects invalid caller budget before SQL case %#', async (budget) => {
  const h = harness();
  await expect(captureResourceRetainedReadFacts(h.tx, [versionId], budget)).rejects.toThrow(
    'INVALID_CONTEXT',
  );
  expect(h.calls).toHaveLength(0);
});
it('fails shared bytes budget after scalar but before body', async () => {
  const h = harness();
  h.budget.bytes = 4193000n;
  await expect(captureResourceRetainedReadFacts(h.tx, [versionId], h.budget)).rejects.toThrow(
    'CONTEXT_UNAVAILABLE',
  );
  expect(h.calls).toHaveLength(1);
});
it.each([
  { content_bytes: '65537' },
  { paragraph_bytes: '524289' },
  { paragraph_count: 1001 },
  { paragraph_count: 0 },
  { content_bytes: '0' },
])('rejects scalar bounds %j before body', (change) => {
  const h = harness([[{ ...scalar, ...change }]]);
  return expect(captureResourceRetainedReadFacts(h.tx, [versionId], h.budget))
    .rejects.toThrow('CONTEXT_UNAVAILABLE')
    .then(() => expect(h.calls).toHaveLength(1));
});
it('fails a current access race instead of producing a partial body', async () => {
  const h = harness([[scalar], []]);
  await expect(captureResourceRetainedReadFacts(h.tx, [versionId], h.budget)).rejects.toThrow(
    'SOURCE_UNAVAILABLE',
  );
});
it('rejects SQL crosswired version', async () => {
  const h = harness([[{ ...scalar, version_id: nextId }]]);
  await expect(captureResourceRetainedReadFacts(h.tx, [versionId], h.budget)).rejects.toThrow(
    'INVALID_CONTEXT',
  );
});
it('rejects producer text hash mismatch', async () => {
  const h = harness([[scalar], [{ ...body, content_hash: '0'.repeat(64) }]]);
  await expect(captureResourceRetainedReadFacts(h.tx, [versionId], h.budget)).rejects.toThrow(
    'INVALID_CONTEXT',
  );
});
it.each([
  (p: ReturnType<typeof projection>) => ({ ...p, extra: true }),
  (p: ReturnType<typeof projection>) => ({ ...p, facts: [] }),
  (p: ReturnType<typeof projection>) => ({
    ...p,
    requestedVersionIds: [versionId, versionId.toUpperCase()],
  }),
  (p: ReturnType<typeof projection>) => ({ ...p, facts: [...p.facts, ...p.facts] }),
  (p: ReturnType<typeof projection>) => ({
    ...p,
    facts: p.facts.map((f) => ({ ...f, record: { ...record, resourceId: nextId } })),
  }),
  (p: ReturnType<typeof projection>) => ({
    ...p,
    facts: p.facts.map((f) => ({ ...f, record: { ...record, contentHash: '0'.repeat(64) } })),
  }),
  (p: ReturnType<typeof projection>) => ({
    ...p,
    facts: p.facts.map((f) => ({ ...f, current: { ...f.current, deleted: true } })),
  }),
  (p: ReturnType<typeof projection>) => ({
    ...p,
    facts: p.facts.map((f) => ({
      ...f,
      record: { ...record, paragraphs: [{ ...record.paragraphs[0], text: 'wrong' }] },
    })),
  }),
])('rejects malformed projection %i', (change) => {
  expect(validateResourceRetainedReadFacts(change(projection())).status).toBe('blocked');
});
it('validates empty retained-read portion without whole-context completion', () => {
  expect(
    validateResourceRetainedReadFacts({ ...projection(), requestedVersionIds: [], facts: [] }),
  ).toMatchObject({ status: 'validated_read_sources', complete: false, authority: 'none' });
});
it('rejects unknown authority and oversized boundary', () => {
  expect(validateResourceRetainedReadFacts({ ...projection(), authority: 'verified' }).status).toBe(
    'blocked',
  );
  expect(validateResourceRetainedReadFacts({ blob: 'x'.repeat(4194305) }).status).toBe('blocked');
});

it('sanitizes invalid stored scalar and body decode errors', async () => {
  for (const rows of [
    [[{ ...scalar, content_bytes: 'invalid' }]],
    [[scalar], [{ ...body, content_status: 'unknown' }]],
  ]) {
    const h = harness(rows);
    await expect(captureResourceRetainedReadFacts(h.tx, [versionId], h.budget)).rejects.toThrow(
      'INVALID_CONTEXT',
    );
  }
});
