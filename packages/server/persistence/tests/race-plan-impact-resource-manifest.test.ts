import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { privateTextResourceVersionSchema } from '@workout/contracts/resources';
import {
  resourceReadManifestProjectionSchema,
  validateResourceReadManifest,
} from '../src/race-plan-impact-resource-manifest.js';
import { captureResourceRetainedReadFacts } from '../src/race-plan-impact-resource-read-facts.js';
import type { Transaction } from '../src/database.js';

const resourceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const versionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const nextId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const text = 'Synthetic retained 원문 0';
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
function fixture(historical = false) {
  const record = privateTextResourceVersionSchema.parse({
    schemaVersion: 1,
    id: versionId,
    resourceId,
    version: 1,
    previousVersionId: null,
    contentHash: sha(text),
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
  const state = historical ? 'historical' : 'current';
  const currentVersionId = historical ? nextId : versionId;
  return resourceReadManifestProjectionSchema.parse({
    requestedVersionIds: [versionId],
    metadata: [
      {
        requestedVersionId: versionId,
        state,
        reason: null,
        content: { resourceId, versionId, version: 1, contentHash: record.contentHash },
        current: {
          versionId: currentVersionId,
          accessRevision: 3,
          deleted: false,
          reviewedState: 'unreviewed',
          reviewedVersionId: null,
          includeForCoach: false,
          cleanupPending: false,
          aiAuthorized: false,
        },
      },
    ],
    sourceFacts: {
      requestedVersionIds: [versionId],
      facts: [
        {
          requestedVersionId: versionId,
          state,
          reason: null,
          record,
          current: {
            resourceId,
            versionId: currentVersionId,
            version: historical ? 2 : 1,
            accessRevision: 3,
            deleted: false,
          },
        },
      ],
      authority: 'none',
      freshness: 'not_checked',
    },
  });
}
function rows(c: ReturnType<typeof fixture>) {
  const row = c.metadata[0],
    fact = c.sourceFacts?.facts[0];
  if (!row?.content || !row.current || !fact?.record || !fact.current || !c.sourceFacts)
    throw Error('fixture');
  return {
    row,
    content: row.content,
    metadataHead: row.current,
    fact,
    record: fact.record,
    head: fact.current,
    source: c.sourceFacts,
  };
}
function blocked(c: unknown, reason: string, path?: string) {
  const result = validateResourceReadManifest(c);
  expect(result).toMatchObject({
    status: 'blocked',
    authority: 'none',
    freshness: 'not_checked',
    complete: false,
  });
  expect(result.blockers.some((b) => b.reason === reason && (!path || b.path === path))).toBe(true);
}
it('accepts empty retained scope without fabricating resource permission', () => {
  expect(validateResourceReadManifest({ requestedVersionIds: [], metadata: [] })).toMatchObject({
    status: 'validated_read_sources',
    authority: 'none',
    freshness: 'not_checked',
    complete: false,
    blockers: [],
  });
});
it.each([false, true])(
  'retains exact current/historical full text with AI absent and unreviewed/inclusion false historical=%s',
  (historical) => {
    const c = fixture(historical),
      before = structuredClone(c);
    expect(validateResourceReadManifest(c)).toMatchObject({
      status: 'validated_read_sources',
      authority: 'none',
      freshness: 'not_checked',
      complete: false,
      blockers: [],
    });
    expect(c).toEqual(before);
    expect(c.sourceFacts?.facts[0]?.record?.source.text).toBe(text);
  },
);
it.each([false, true])(
  'cleanup metadata retained=%s does not grant manual processing or fail retained body correspondence',
  (cleanupPending) => {
    const c = fixture(),
      { metadataHead } = rows(c);
    metadataHead.cleanupPending = cleanupPending;
    expect(validateResourceReadManifest(c)).toMatchObject({
      status: 'validated_read_sources',
      authority: 'none',
      freshness: 'not_checked',
      complete: false,
    });
    expect(metadataHead).toMatchObject({
      includeForCoach: false,
      aiAuthorized: false,
      reviewedState: 'unreviewed',
      reviewedVersionId: null,
      cleanupPending,
    });
  },
);
it('blocks metadata-only projection specifically without source port', () => {
  const c = fixture();
  delete c.sourceFacts;
  blocked(c, 'source_port_missing', 'sourceFacts');
});
it('allows repeated consumed request visits while source facts remain deduplicated', () => {
  const c = fixture();
  c.requestedVersionIds.push(versionId.toUpperCase());
  expect(validateResourceReadManifest(c).status).toBe('validated_read_sources');
});
it.each(['metadata', 'facts', 'sourceRequests'] as const)(
  'rejects duplicate %s correspondence rows',
  (part) => {
    const c = fixture(),
      { source, row, fact } = rows(c);
    if (part === 'metadata') c.metadata.push(structuredClone(row));
    if (part === 'facts') source.facts.push(structuredClone(fact));
    if (part === 'sourceRequests') source.requestedVersionIds.push(versionId.toUpperCase());
    blocked(c, 'source_identity_mismatch');
  },
);
it.each(['metadata', 'facts', 'sourceRequests'] as const)(
  'rejects missing %s exact source membership',
  (part) => {
    const c = fixture(),
      { source } = rows(c);
    if (part === 'metadata') c.metadata = [];
    if (part === 'facts') source.facts = [];
    if (part === 'sourceRequests') source.requestedVersionIds = [];
    blocked(c, 'source_unavailable');
  },
);
it('rejects unused metadata source rather than expanding the consumed roster', () => {
  const c = fixture(),
    { row } = rows(c);
  c.metadata.push({ ...structuredClone(row), requestedVersionId: nextId });
  blocked(c, 'unused_source', 'metadata');
});
it('rejects unused exact source body even when it is internally valid', () => {
  const c = fixture();
  c.requestedVersionIds = [];
  c.metadata = [];
  blocked(c, 'unused_source', 'sourceFacts');
});
it.each(['resource', 'version', 'ordinal', 'state', 'head', 'access'] as const)(
  'rejects foreign/mismatched %s tuple',
  (field) => {
    const c = fixture(),
      { content, row, metadataHead } = rows(c);
    if (field === 'resource') content.resourceId = nextId;
    if (field === 'version') content.versionId = nextId;
    if (field === 'ordinal') content.version = 2;
    if (field === 'state') row.state = 'historical';
    if (field === 'head') metadataHead.versionId = nextId;
    if (field === 'access') metadataHead.accessRevision = 4;
    blocked(c, 'source_identity_mismatch', `resource:${versionId}`);
  },
);
it('rejects mismatched stored metadata digest', () => {
  const c = fixture();
  rows(c).content.contentHash = '0'.repeat(64);
  blocked(c, 'source_digest_mismatch', `resource:${versionId}`);
});
it('recomputes sha256 of full UTF8 text rather than trusting matching copied hashes', () => {
  const c = fixture(),
    { record } = rows(c);
  record.source.text = 'x'.repeat(text.length);
  const paragraph = record.paragraphs[0];
  if (!paragraph) throw Error('fixture');
  paragraph.text = record.source.text;
  blocked(c, 'source_identity_mismatch', 'sourceFacts');
});
it('rejects paragraph corruption independently of the source text digest', () => {
  const c = fixture(),
    { record } = rows(c);
  const paragraph = record.paragraphs[0];
  if (!paragraph) throw Error('fixture');
  paragraph.locator.endOffset--;
  blocked(c, 'invalid_projection', 'projection');
});
it('rejects deleted consumed source without exposing a retained old body', () => {
  const c = fixture(),
    { fact, row, head, metadataHead } = rows(c);
  fact.state = 'deleted';
  fact.record = null;
  head.deleted = true;
  row.state = 'deleted';
  row.content = null;
  metadataHead.deleted = true;
  blocked(c, 'source_unavailable', `resource:${versionId}`);
});
it('rejects unavailable consumed source and preserves absent head/body', () => {
  const c = fixture(),
    { fact, row } = rows(c);
  fact.state = 'unavailable';
  fact.reason = 'owned_version_unavailable';
  fact.record = null;
  fact.current = null;
  row.state = 'unavailable';
  row.reason = 'owned_version_unavailable';
  row.content = null;
  row.current = null;
  blocked(c, 'source_unavailable', `resource:${versionId}`);
});
it('normalizes uppercase UUID request/body/paragraph identity without altering caller object', () => {
  const c = fixture(),
    { row, fact, record, head, content, metadataHead } = rows(c);
  c.requestedVersionIds = [versionId.toUpperCase()];
  row.requestedVersionId = versionId.toUpperCase();
  content.versionId = versionId.toUpperCase();
  content.resourceId = resourceId.toUpperCase();
  metadataHead.versionId = versionId.toUpperCase();
  if (!c.sourceFacts) throw Error('fixture');
  c.sourceFacts.requestedVersionIds = [versionId.toUpperCase()];
  fact.requestedVersionId = versionId.toUpperCase();
  record.id = versionId.toUpperCase();
  record.resourceId = resourceId.toUpperCase();
  head.resourceId = resourceId.toUpperCase();
  head.versionId = versionId.toUpperCase();
  const paragraph = record.paragraphs[0];
  if (!paragraph) throw Error('fixture');
  paragraph.locator.resourceVersionId = versionId.toUpperCase();
  const before = structuredClone(c);
  expect(validateResourceReadManifest(c).status).toBe('validated_read_sources');
  expect(c).toEqual(before);
});
it('handles opaque ID as unavailable without UUID SQL casting or zero substitutes', async () => {
  const id = 'opaque:Case/SQL-not-UUID',
    calls: string[] = [];
  const tx: Transaction = {
    athleteId: 'synthetic',
    async query(sql) {
      calls.push(sql);
      throw Error('opaque ID must not query');
    },
  };
  const sourceFacts = await captureResourceRetainedReadFacts(tx, [id], { bytes: 0n, sources: 0 });
  expect(calls).toEqual([]);
  expect(sourceFacts.facts).toEqual([
    {
      requestedVersionId: id,
      state: 'unavailable',
      reason: 'owned_version_unavailable',
      record: null,
      current: null,
    },
  ]);
  blocked(
    {
      requestedVersionIds: [id],
      metadata: [
        {
          requestedVersionId: id,
          state: 'unavailable',
          reason: 'owned_version_unavailable',
          content: null,
          current: null,
        },
      ],
      sourceFacts,
    },
    'source_unavailable',
    `resource:${id}`,
  );
});
it.each(['top', 'metadata', 'source', 'permission'] as const)(
  'rejects unknown %s fields',
  (part) => {
    const c = fixture();
    if (part === 'top') blocked({ ...c, complete: true }, 'invalid_projection');
    if (part === 'metadata')
      blocked(
        { ...c, metadata: c.metadata.map((row) => ({ ...row, ownerId: 'foreign' })) },
        'invalid_projection',
      );
    if (part === 'source')
      blocked(
        { ...c, sourceFacts: { ...c.sourceFacts, reviewer: 'invented' } },
        'invalid_projection',
      );
    if (part === 'permission')
      blocked(
        { ...c, sourceFacts: { ...c.sourceFacts, manualAuthorized: true } },
        'invalid_projection',
      );
  },
);
it('bounds total UTF8 before unknown body decoding', () =>
  blocked({ huge: '한'.repeat(1_400_000) }, 'bounds_exceeded', 'projection'));
it('counts duplicate requested visits and exact facts toward the 5000 cap', () => {
  const c = fixture();
  c.requestedVersionIds = Array.from({ length: 4999 }, () => versionId);
  expect(validateResourceReadManifest(c).status).toBe('validated_read_sources');
  c.requestedVersionIds.push(versionId);
  blocked(c, 'bounds_exceeded', 'projection');
});
it('rejects over-5000 public roster before accepting deduplication', () => {
  const c = fixture();
  c.requestedVersionIds = Array.from({ length: 5001 }, () => versionId);
  blocked(c, 'invalid_projection', 'projection');
});
