import { z } from 'zod';
import { galleryMediaNavigationQueryV2Schema } from '@workout/contracts/gallery-navigation-v2';
import {
  galleryMediaNavigationV3Schema,
  galleryMediaNavigationPageV3Schema,
  type GalleryMediaNavigationV3,
  type GalleryMediaNavigationPageV3,
} from '@workout/contracts/gallery-navigation-v3';
import {
  GalleryNavigationRowsError,
  mapGalleryNavigationRow,
  mapGalleryNavigationRowsPage,
} from './gallery-navigation-rows.js';

function invalid(): never {
  throw new GalleryNavigationRowsError();
}
function checked<T>(read: () => T): T {
  try {
    return read();
  } catch {
    return invalid();
  }
}
/** SQL producer supplies nullable boolean, not a reason or a live-course owner join. */
function projection(raw: unknown) {
  if (typeof raw !== 'object' || raw === null || Object.getPrototypeOf(raw) !== Object.prototype)
    return invalid();
  const keys = Reflect.ownKeys(raw);
  if (keys.length > 41 || !keys.includes('course_available')) return invalid();
  const base: Record<string, unknown> = {};
  let available: unknown;
  for (const key of keys) {
    if (typeof key !== 'string') return invalid();
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return invalid();
    if (key === 'course_available') available = descriptor.value;
    else Object.defineProperty(base, key, { value: descriptor.value, enumerable: true });
  }
  return { base, available: z.boolean().nullable().parse(available) };
}
function mapped(owner: unknown, row: ReturnType<typeof projection>): GalleryMediaNavigationV3 {
  // course_athlete_id is the saved association owner. Never supply the nullable
  // owner of a currently accessible course join: deletion must not erase the tuple.
  const original = mapGalleryNavigationRow(owner, row.base);
  if ((original.courseLink === null) !== (row.available === null)) return invalid();
  return galleryMediaNavigationV3Schema.parse({
    ...original,
    schemaVersion: 3,
    courseAvailability:
      row.available === null ? null : { state: row.available ? 'available' : 'unavailable' },
  });
}
/** Validates supplied facts only; cannot establish SQL ACL, authority or current head. */
export function mapGalleryNavigationV3Row(owner: unknown, raw: unknown): GalleryMediaNavigationV3 {
  return checked(() => mapped(owner, projection(raw)));
}
function rows(raw: unknown, limit: number): unknown[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) return invalid();
  const length = Object.getOwnPropertyDescriptor(raw, 'length');
  if (
    !length ||
    !('value' in length) ||
    !Number.isInteger(length.value) ||
    length.value > limit + 1
  )
    return invalid();
  if (Reflect.ownKeys(raw).length !== length.value + 1) return invalid();
  const values: unknown[] = [];
  for (let index = 0; index < length.value; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return invalid();
    values.push(descriptor.value);
  }
  return values;
}
/** Validates the entire limit+1 projection, including unavailable lookahead rows. */
export function mapGalleryNavigationV3RowsPage(
  owner: unknown,
  rawQuery: unknown,
  rawRows: unknown,
): GalleryMediaNavigationPageV3 {
  return checked(() => {
    const query = galleryMediaNavigationQueryV2Schema.parse(rawQuery);
    const projected = rows(rawRows, query.limit).map(projection);
    const items = projected.map((row) => mapped(owner, row));
    // Existing mapper owns exact filter/keyset/duplicate/last-key/lookahead checks.
    const original = mapGalleryNavigationRowsPage(
      owner,
      query,
      projected.map((row) => row.base),
    );
    return galleryMediaNavigationPageV3Schema.parse({
      ...original,
      schemaVersion: 3,
      items: items.slice(0, query.limit),
    });
  });
}
