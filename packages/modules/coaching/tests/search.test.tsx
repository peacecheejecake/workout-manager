import { describe, it, expect } from 'vitest';
import { readCoachingSearch, changeCoachingSearch } from '../src/search';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
describe('coaching URL', () => {
  it('defaults without ignoring unrelated host query', () => {
    expect(readCoachingSearch('?other=x').query).toEqual({
      thread: null,
      offset: 0,
      planVersion: null,
      scopeKind: 'session',
      targetId: null,
    });
    expect(changeCoachingSearch('?other=x&thread=old', { thread: id, offset: null })).toBe(
      `other=x&thread=${id}`,
    );
  });
  it.each([
    'thread=bad',
    'thread=' + id + '&thread=' + id,
    'offset=-1',
    'offset=10001',
    'offset=',
    'offset=1.5',
    'scopeKind=wave',
    'targetId=',
    'targetId=%00',
    'planVersion=bad',
  ])('rejects %s', (query) => {
    expect(readCoachingSearch(query).query).toBeNull();
  });
  it('preserves literal scoped IDs and canonicalizes UUID', () => {
    const q = new URLSearchParams({
      thread: id.toUpperCase(),
      targetId: '한글 / +',
      scopeKind: 'block',
    });
    expect(readCoachingSearch(q.toString()).query).toMatchObject({
      thread: id,
      targetId: '한글 / +',
      scopeKind: 'block',
    });
  });
});
