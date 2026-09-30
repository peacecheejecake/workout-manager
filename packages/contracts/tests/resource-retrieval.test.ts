import { describe, expect, it } from 'vitest';
import { resourceRetrievalResultSchema } from '../src/resource-retrieval.js';

const result = {
  schemaVersion: 2,
  scope: 'resource-retrieval-v2',
  query: '회복',
  checkedAt: '2026-09-20T00:00:00Z',
  authorizationDigest: 'a'.repeat(64),
  cache: 'miss',
  authorizedResourceCount: 6,
  excerpts: [],
};

describe('resource retrieval coverage contract', () => {
  it('requires explicit complete or in-progress coverage of the authorized set', () => {
    expect(
      resourceRetrievalResultSchema.parse({
        ...result,
        indexing: { status: 'in_progress', indexedResourceCount: 5, pendingResourceCount: 1 },
      }).indexing.status,
    ).toBe('in_progress');
    expect(
      resourceRetrievalResultSchema.parse({
        ...result,
        indexing: { status: 'complete', indexedResourceCount: 6, pendingResourceCount: 0 },
      }).indexing.status,
    ).toBe('complete');
    for (const indexing of [
      undefined,
      { status: 'complete', indexedResourceCount: 5, pendingResourceCount: 1 },
      { status: 'complete', indexedResourceCount: 5, pendingResourceCount: 0 },
      { status: 'in_progress', indexedResourceCount: 6, pendingResourceCount: 0 },
      { status: 'error', indexedResourceCount: 0, pendingResourceCount: 6 },
    ])
      expect(resourceRetrievalResultSchema.safeParse({ ...result, indexing }).success).toBe(false);
    expect(
      resourceRetrievalResultSchema.safeParse({
        ...result,
        schemaVersion: 1,
        scope: 'resource-retrieval-v1',
        indexing: { status: 'complete', indexedResourceCount: 6, pendingResourceCount: 0 },
      }).success,
    ).toBe(false);
  });
});
