import { expect, it, vi } from 'vitest';
import { readGalleryAccountExportV39In } from '../src/gallery-account-export-v39.js';
import type { Transaction } from '../src/database.js';
it('uses same transaction for four owner-bound queries and shared debit once per collection', async () => {
  const query = vi.fn<Transaction['query']>(async () => ({
      rows: [],
      rowCount: 0,
    })),
    debit = vi.fn();
  const result = await readGalleryAccountExportV39In(
    { athleteId: 'synthetic', query },
    () => 8388608,
    debit,
  );
  expect(Object.keys(result)).toEqual([
    'galleryAlbums',
    'galleryAlbumMemberships',
    'galleryCourseAssociations',
    'galleryAlbumDeletions',
  ]);
  expect(query).toHaveBeenCalledTimes(4);
  expect(debit).toHaveBeenCalledTimes(4);
  for (const [sql, params] of query.mock.calls) {
    expect(params).toEqual(['synthetic']);
    expect(sql).toContain('LIMIT 1001');
    expect(sql).not.toContain('request_digest');
  }
});
it('fails missing SQL capability without fallback or fabricated new arrays', async () => {
  const query = vi.fn<Transaction['query']>(async () => {
      throw Error('unavailable');
    }),
    debit = vi.fn();
  await expect(
    readGalleryAccountExportV39In({ athleteId: 'synthetic', query }, () => 8388608, debit),
  ).rejects.toThrow();
  expect(query).toHaveBeenCalledTimes(1);
  expect(debit).not.toHaveBeenCalled();
});
it('fails exhausted shared budget before SQL and row cap before returning partial data', async () => {
  const query = vi.fn<Transaction['query']>(async () => ({
    rows: Array.from({ length: 1001 }, () => ({ entry: {} })),
    rowCount: 1001,
  }));
  await expect(
    readGalleryAccountExportV39In(
      { athleteId: 'synthetic', query },
      () => 0,
      () => {},
    ),
  ).rejects.toMatchObject({ code: 'TOO_LARGE' });
  expect(query).not.toHaveBeenCalled();
  await expect(
    readGalleryAccountExportV39In(
      { athleteId: 'synthetic', query },
      () => 8388608,
      () => {},
    ),
  ).rejects.toMatchObject({ code: 'TOO_LARGE' });
});
it('preguards accessor rows without invoking getters', async () => {
  const get = vi.fn(),
    row = {};
  Object.defineProperty(row, 'entry', { get, enumerable: true });
  await expect(
    readGalleryAccountExportV39In(
      {
        athleteId: 'synthetic',
        query: async () => ({ rows: [row], rowCount: 1 }),
      },
      () => 8388608,
      () => {},
    ),
  ).rejects.toThrow();
  expect(get).not.toHaveBeenCalled();
});
