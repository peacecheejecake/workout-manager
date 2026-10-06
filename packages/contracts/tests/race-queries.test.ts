import { describe, expect, it } from 'vitest';
import {
  raceCollectionStampSchema,
  raceListQuerySchema,
  trainingBestListPageSchema,
} from '../src/race-queries.js';

const id = '11111111-1111-4111-8111-111111111111';
const collection = { revision: 2147483647, privacyGeneration: '9007199254740993' };
const item = {
  kind: 'training-best',
  id,
  revision: 1,
  observedAt: '2026-10-06T00:00:00Z',
  source: { kind: 'manual' },
  basis: 'user-entered',
  distanceMeters: null,
  elapsedSeconds: 0,
};
const page = {
  schemaVersion: 1,
  kind: 'training-best',
  sort: 'id-asc',
  collection,
  items: [item],
  nextCursor: { kind: 'training-best', collection, afterId: id },
};

describe('race list protocol', () => {
  it('keeps large privacy generations exact without floating point conversion', () => {
    expect(raceCollectionStampSchema.parse(collection)).toEqual(collection);
    for (const privacyGeneration of ['01', '-1', '1.0', '1e2', ' 1', ''])
      expect(
        raceCollectionStampSchema.safeParse({ ...collection, privacyGeneration }).success,
      ).toBe(false);
  });
  it('bounds requests and excludes caller ownership', () => {
    expect(raceListQuerySchema.parse({})).toEqual({ limit: 50, cursor: null });
    for (const input of [{ limit: 0 }, { limit: 101 }, { athleteId: id }])
      expect(raceListQuerySchema.safeParse(input).success).toBe(false);
  });
  it('binds the next position to kind, privacy generation and final item', () => {
    expect(trainingBestListPageSchema.parse(page).items[0]).toMatchObject({
      distanceMeters: null,
      elapsedSeconds: 0,
    });
    for (const nextCursor of [
      { ...page.nextCursor, kind: 'race-result' },
      { ...page.nextCursor, collection: { ...collection, privacyGeneration: '0' } },
      { ...page.nextCursor, afterId: '22222222-2222-4222-8222-222222222222' },
    ])
      expect(trainingBestListPageSchema.safeParse({ ...page, nextCursor }).success).toBe(false);
  });
  it('distinguishes an absent collection from an empty retained head', () => {
    for (const value of [null, collection])
      expect(
        trainingBestListPageSchema.safeParse({
          ...page,
          collection: value,
          items: [],
          nextCursor: null,
        }).success,
      ).toBe(true);
    expect(trainingBestListPageSchema.safeParse({ ...page, collection: null }).success).toBe(false);
  });
  it('rejects duplicate and descending storage IDs', () => {
    const second = { ...item, id: '22222222-2222-4222-8222-222222222222' };
    for (const items of [
      [item, item],
      [second, item],
    ])
      expect(
        trainingBestListPageSchema.safeParse({ ...page, items, nextCursor: null }).success,
      ).toBe(false);
  });
});
