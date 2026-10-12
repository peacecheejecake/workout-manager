import { describe, expect, it, vi } from 'vitest';
import {
  galleryCourseAvailabilityV3Schema,
  galleryMediaNavigationV3Schema,
  galleryMediaNavigationPageV3Schema,
} from '../src/gallery-navigation-v3.js';
import {
  galleryMediaNavigationV2Schema,
  galleryMediaNavigationPageV2Schema,
  galleryMediaNavigationQueryV2Schema,
} from '../src/gallery-navigation-v2.js';

const id = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const third = '10000000-0000-4000-8000-000000000003';
const at = '2026-10-09T00:00:00.000002Z';
const link = { courseId: third, courseRevision: 2, revisionId: other };
function media(key = id, createdAt = at) {
  return {
    schemaVersion: 3,
    item: {
      id: key,
      mediaKind: 'image',
      visibility: 'private',
      includeForCoach: false,
      album: null,
      caption: null,
      activityId: null,
      capturedAt: null,
      capturedLocalDate: null,
      file: {
        originalFileName: '원본.png',
        mediaType: 'image/png',
        byteSize: 10,
        sha256: 'a'.repeat(64),
      },
      preview: null,
      accessRevision: 1,
      createdAt,
      updatedAt: createdAt,
    },
    albumMembership: null,
    courseLink: null,
    capturedDay: { state: 'unknown' },
    courseAvailability: null,
  };
}
function query(limit = 2) {
  return galleryMediaNavigationQueryV2Schema.parse({
    filters: {
      album: { mode: 'all' },
      mediaKind: null,
      activityId: null,
      courseLink: null,
      capturedDay: { mode: 'all' },
    },
    limit,
    sort: 'created_desc_id_asc',
    cursor: null,
  });
}
function page() {
  return {
    schemaVersion: 3,
    query: query(),
    items: [media(id), media(other)],
    hasMore: false,
    nextCursor: null,
  };
}
function cursor() {
  const { cursor: ignored, ...binding } = query();
  void ignored;
  return { cursorVersion: 1, binding, after: { createdAt: at, id: other } };
}

describe('gallery navigation V3 read facts', () => {
  it('preserves nullable original media/local date and the unassigned distinction', () => {
    const raw = media();
    expect(galleryMediaNavigationV3Schema.parse(raw)).toEqual(raw);
    expect(galleryMediaNavigationV3Schema.parse(raw).item.capturedAt).toBeNull();
  });
  it.each(['available', 'unavailable'] as const)(
    'retains the exact saved tuple while reporting %s',
    (state) => {
      const raw = {
        ...media(),
        courseLink: link,
        courseAvailability: { state },
      };
      expect(galleryMediaNavigationV3Schema.parse(raw)).toEqual(raw);
      expect(galleryCourseAvailabilityV3Schema.parse({ state })).toEqual({
        state,
      });
    },
  );
  it('requires availability exactly when a course link exists', () => {
    for (const raw of [
      { ...media(), courseLink: link },
      { ...media(), courseAvailability: { state: 'available' } },
      { ...media(), courseAvailability: { state: 'unavailable' } },
    ])
      expect(galleryMediaNavigationV3Schema.safeParse(raw).success).toBe(false);
    const { courseAvailability: omitted, ...missing } = media();
    void omitted;
    expect(galleryMediaNavigationV3Schema.safeParse(missing).success).toBe(false);
  });
  it('rejects foreign permission reasons, identity and source payload extensions', () => {
    for (const state of [
      { state: 'unavailable', reason: 'deleted' },
      { state: 'unavailable', ownerId: other },
      { state: 'available', approved: true },
      { state: 'unknown' },
    ])
      expect(
        galleryMediaNavigationV3Schema.safeParse({
          ...media(),
          courseLink: link,
          courseAvailability: state,
        }).success,
      ).toBe(false);
    expect(galleryMediaNavigationV3Schema.safeParse({ ...media(), athleteId: other }).success).toBe(
      false,
    );
  });
  it('keeps V2 strict and immutable instead of accepting new fields or versions', () => {
    const { courseAvailability: omitted, ...original } = media();
    void omitted;
    expect(
      galleryMediaNavigationV2Schema.safeParse({
        ...original,
        schemaVersion: 2,
      }).success,
    ).toBe(true);
    expect(galleryMediaNavigationV2Schema.safeParse(media()).success).toBe(false);
    expect(galleryMediaNavigationV2Schema.safeParse({ ...media(), schemaVersion: 2 }).success).toBe(
      false,
    );
    expect(galleryMediaNavigationV3Schema.safeParse({ ...media(), schemaVersion: 2 }).success).toBe(
      false,
    );
  });
  it('reuses original capture-day correspondence and exact course tuple validation', () => {
    expect(
      galleryMediaNavigationV3Schema.safeParse({
        ...media(),
        capturedDay: { state: 'known', localDate: '2026-10-09' },
      }).success,
    ).toBe(false);
    expect(
      galleryMediaNavigationV3Schema.safeParse({
        ...media(),
        courseLink: { ...link, revisionId: null },
        courseAvailability: { state: 'unavailable' },
      }).success,
    ).toBe(false);
    expect(
      galleryMediaNavigationV3Schema.safeParse(media(id, '2026-10-09T00:00:00.0000001Z')).success,
    ).toBe(false);
  });
  it('normalizes identities through V2 while preserving unavailable tuple revision', () => {
    const raw = {
      ...media(),
      courseLink: { ...link, courseId: link.courseId.toUpperCase() },
      courseAvailability: { state: 'unavailable' },
    };
    expect(galleryMediaNavigationV3Schema.parse(raw).courseLink).toEqual(link);
  });
  it('returns unavailable linked items when the exact saved-course filter matches', () => {
    const raw = page();
    const filtered = {
      ...raw,
      query: {
        ...raw.query,
        filters: { ...raw.query.filters, courseLink: link },
      },
      items: [
        {
          ...media(),
          courseLink: link,
          courseAvailability: { state: 'unavailable' },
        },
      ],
    };
    expect(galleryMediaNavigationPageV3Schema.parse(filtered)).toEqual(filtered);
    expect(
      galleryMediaNavigationPageV3Schema.safeParse({
        ...filtered,
        items: [{ ...filtered.items[0], courseLink: { ...link, courseRevision: 3 } }],
      }).success,
    ).toBe(false);
  });
  it('uses existing V2 query/fullpage/last-key continuation without availability in the binding', () => {
    const raw = { ...page(), hasMore: true, nextCursor: cursor() };
    expect(galleryMediaNavigationPageV3Schema.parse(raw)).toEqual(raw);
    expect(
      galleryMediaNavigationPageV3Schema.safeParse({
        ...raw,
        items: [media(id)],
      }).success,
    ).toBe(false);
    expect(
      galleryMediaNavigationPageV3Schema.safeParse({
        ...raw,
        nextCursor: { ...cursor(), after: { createdAt: at, id } },
      }).success,
    ).toBe(false);
    expect(
      galleryMediaNavigationPageV3Schema.safeParse({
        ...raw,
        nextCursor: { ...cursor(), binding: { ...cursor().binding, limit: 1 } },
      }).success,
    ).toBe(false);
    expect(galleryMediaNavigationPageV3Schema.safeParse({ ...raw, hasMore: false }).success).toBe(
      false,
    );
  });
  it('rejects cursor boundary/filter disagreement and preserves empty terminal pages', () => {
    const raw = page();
    expect(galleryMediaNavigationPageV3Schema.parse({ ...raw, items: [] }).items).toEqual([]);
    expect(
      galleryMediaNavigationPageV3Schema.safeParse({
        ...raw,
        query: { ...query(), cursor: cursor() },
      }).success,
    ).toBe(false);
    expect(
      galleryMediaNavigationPageV3Schema.safeParse({
        ...raw,
        query: {
          ...query(),
          cursor: {
            ...cursor(),
            binding: {
              ...cursor().binding,
              filters: { ...query().filters, mediaKind: 'video' },
            },
          },
        },
      }).success,
    ).toBe(false);
  });
  it('orders separate microseconds and same-instant ids and rejects duplicate identities', () => {
    const raw = page();
    expect(
      galleryMediaNavigationPageV3Schema.parse({
        ...raw,
        items: [media(other, at), media(id, '2026-10-09T00:00:00.000001Z')],
      }).items,
    ).toHaveLength(2);
    for (const items of [
      [media(other), media(id)],
      [media(id), media(id)],
      [media(id, '2026-10-09T00:00:00.000001Z'), media(other, at)],
    ])
      expect(galleryMediaNavigationPageV3Schema.safeParse({ ...raw, items }).success).toBe(false);
    expect(galleryMediaNavigationPageV2Schema.safeParse(raw).success).toBe(false);
  });
  it('rejects accessors before reads, nonplain prototypes, sparse arrays and cycles', () => {
    const getter = vi.fn(() => 'private');
    const raw = Object.defineProperty({ ...media() }, 'courseAvailability', {
      get: getter,
      enumerable: true,
    });
    expect(galleryMediaNavigationV3Schema.safeParse(raw).success).toBe(false);
    const nested = Object.defineProperty({ state: 'unavailable' }, 'reason', {
      get: getter,
      enumerable: true,
    });
    expect(
      galleryMediaNavigationV3Schema.safeParse({
        ...media(),
        courseLink: link,
        courseAvailability: nested,
      }).success,
    ).toBe(false);
    expect(
      galleryMediaNavigationV3Schema.safeParse(Object.assign(Object.create({}), media())).success,
    ).toBe(false);
    expect(
      galleryMediaNavigationPageV3Schema.safeParse({
        ...page(),
        items: new Array(2),
      }).success,
    ).toBe(false);
    const cycle: Record<string, unknown> = { ...media() };
    cycle['cycle'] = cycle;
    expect(galleryMediaNavigationV3Schema.safeParse(cycle).success).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });
  it('bounds the whole V3 page including availability fields, not just each media descriptor', () => {
    const items = Array.from({ length: 100 }, (_, index) => {
      const entry = media(`10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
      return {
        ...entry,
        item: { ...entry.item, caption: '한'.repeat(500) },
      };
    });
    expect(
      galleryMediaNavigationPageV3Schema.safeParse({
        ...page(),
        query: query(100),
        items,
      }).success,
    ).toBe(true);
    const inflated = {
      ...page(),
      query: query(100),
      items,
      unknownPayload: 'x'.repeat(1048577),
    };
    expect(galleryMediaNavigationPageV3Schema.safeParse(inflated).success).toBe(false);
    expect(
      galleryMediaNavigationPageV3Schema.safeParse({
        ...page(),
        items: Array.from({ length: 101 }, () => media()),
      }).success,
    ).toBe(false);
  });
});
