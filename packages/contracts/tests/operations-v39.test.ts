import { expect, it, vi } from 'vitest';
import { accountExportSchema, parseAccountExportV38 } from '@workout/contracts/operations';
import { fixture } from './operations-v39-fixtures.js';
import { parseAccountExportV39, parseAccountExportIncludingV39 } from '../src/operations.js';
const media = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  album = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  course = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  revisionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  at = '2026-10-10T00:00:00.000001Z';
function v39() {
  const base = fixture();
  return {
    ...base,
    schemaVersion: 39,
    data: {
      ...base.data,
      galleryMediaItems: [{ id: media }],
      galleryAlbums: [
        {
          schemaVersion: 1,
          id: album,
          title: '합성',
          revision: 1,
          createdAt: at,
          updatedAt: at,
        },
      ],
      galleryAlbumMemberships: [{ mediaItemId: media, albumId: album }],
      galleryCourseAssociations: [
        {
          mediaItemId: media,
          courseLink: { courseId: course, courseRevision: 7, revisionId },
          courseAvailability: { state: 'unavailable' },
        },
      ],
      galleryAlbumDeletions: [],
    },
  };
}
it('preserves all V38 units/auth/source correspondence and exact unavailable tuple in canonical V39', () => {
  const value = v39(),
    parsed = parseAccountExportV39(value);
  expect(accountExportSchema.parse(value)).toEqual(parsed);
  expect(parsed.data.sourceAuthentication).toBe('not_authenticated');
  expect(parsed.data.originalEventAuthentication).toBe('not_authenticated');
  expect(parsed.data.manualSourceChains).toEqual(value.data.manualSourceChains);
  expect(parsed.data.galleryCourseAssociations).toEqual(value.data.galleryCourseAssociations);
});
it('retains historical V38 without manufacturing new collections', () => {
  const value = fixture();
  expect(parseAccountExportIncludingV39(value)).toEqual(parseAccountExportV38(value));
  expect(parseAccountExportIncludingV39(value).data).not.toHaveProperty('galleryAlbums');
  expect(() => parseAccountExportV39(value)).toThrow();
});
it('rejects absent new collections rather than filling capability failure with empty values', () => {
  const value = v39();
  for (const key of [
    'galleryAlbums',
    'galleryAlbumMemberships',
    'galleryCourseAssociations',
    'galleryAlbumDeletions',
  ]) {
    const data = Object.fromEntries(Object.entries(value.data).filter(([field]) => field !== key));
    expect(() => parseAccountExportV39({ ...value, data })).toThrow();
  }
});
it('retains inherited V38 source authentication restrictions', () => {
  const value = v39();
  expect(() =>
    parseAccountExportV39({
      ...value,
      data: { ...value.data, sourceAuthentication: 'authenticated' },
    }),
  ).toThrow();
  expect(() =>
    parseAccountExportV39({
      ...value,
      data: { ...value.data, manualSavedSourceParents: [] },
    }),
  ).toThrow();
});
it('rejects duplicate orphan and live-tombstone contradictory gallery data', () => {
  const value = v39();
  expect(() =>
    parseAccountExportV39({
      ...value,
      data: {
        ...value.data,
        galleryAlbumMemberships: [
          ...value.data.galleryAlbumMemberships,
          ...value.data.galleryAlbumMemberships,
        ],
      },
    }),
  ).toThrow();
  expect(() =>
    parseAccountExportV39({
      ...value,
      data: { ...value.data, galleryMediaItems: [] },
    }),
  ).toThrow();
  expect(() =>
    parseAccountExportV39({
      ...value,
      data: {
        ...value.data,
        galleryAlbumDeletions: [{ albumId: album, deletedRevision: 2, deletedAt: at }],
      },
    }),
  ).toThrow();
});
it('requires course availability to match own exact exported course revision without replacing saved tuple', () => {
  const value = v39();
  expect(() =>
    parseAccountExportV39({
      ...value,
      data: {
        ...value.data,
        galleryCourseAssociations: [
          {
            ...value.data.galleryCourseAssociations[0],
            courseAvailability: { state: 'available' },
          },
        ],
      },
    }),
  ).toThrow();
  const linked = {
    ...value,
    data: {
      ...value.data,
      courses: [{ course_id: course, status: 'available' }],
      courseRevisions: [{ course_id: course, course_revision: 7, revision_id: revisionId }],
      galleryCourseAssociations: [
        {
          ...value.data.galleryCourseAssociations[0],
          courseAvailability: { state: 'available' },
        },
      ],
    },
  };
  expect(parseAccountExportV39(linked).data.galleryCourseAssociations[0]?.courseLink).toEqual({
    courseId: course,
    courseRevision: 7,
    revisionId,
  });
});
it('bounds and preguards unknown ingress without getter invocation', () => {
  const get = vi.fn();
  const raw = { ...v39() };
  Object.defineProperty(raw, 'schemaVersion', { get, enumerable: true });
  expect(() => parseAccountExportIncludingV39(raw)).toThrow();
  expect(get).not.toHaveBeenCalled();
  expect(() => parseAccountExportV39({ ...v39(), unexpected: 'x'.repeat(8388609) })).toThrow();
});
it('rejects receipt/storage/owner leakage and version coercion', () => {
  const value = v39();
  expect(() =>
    parseAccountExportV39({
      ...value,
      data: { ...value.data, galleryReceipts: [] },
    }),
  ).toThrow();
  expect(() => parseAccountExportV39({ ...value, schemaVersion: '39' })).toThrow();
});
it('keeps actual historical v2 through v38 parser results and preserves v1 rejection without new defaults', async () => {
  const { accountExportSchema } = await import('@workout/contracts/operations');
  const versions: number[] = [];
  for (const option of accountExportSchema.options.filter(
    (option) => option.shape.schemaVersion.value !== 39,
  )) {
    const version = option.shape.schemaVersion.value;
    versions.push(version);
    const data: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(option.shape.data.shape)) {
      if (field.safeParse([]).success) data[key] = [];
      else if (key === 'sourceAuthentication' || key === 'originalEventAuthentication')
        data[key] = 'not_authenticated';
      else if (key === 'sourceProvenanceCoverage')
        data[key] =
          version === 38 ? 'saved_safe_dependency_facts' : 'not_exported_policy_unresolved';
      else throw Error('unhandled synthetic historical fixture field');
    }
    const artifact = option.parse({
      schemaVersion: version,
      athleteId: 'synthetic',
      exportedAt: at,
      data,
    });
    expect(parseAccountExportIncludingV39(artifact)).toEqual(artifact);
    expect(parseAccountExportIncludingV39(artifact).data).not.toHaveProperty('galleryAlbums');
  }
  expect(() =>
    parseAccountExportIncludingV39({
      schemaVersion: 1,
      athleteId: 'synthetic',
      exportedAt: at,
      data: {},
    }),
  ).toThrow();
  expect(versions).toEqual(Array.from({ length: 37 }, (_, index) => index + 2));
});
