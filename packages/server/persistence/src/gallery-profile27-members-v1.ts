import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  galleryNavigationMemberV1,
  galleryRestoreSuppressionMemberV1,
} from './gallery-navigation-pins-v1.js';
import { galleryRenditionMemberV1 } from './gallery-rendition-pins-v1.js';

/**
 * The gallery members of profile27, in install order: 143, then 144, then 145 (145 references
 * SQL143 objects; 144 references none). Source reading only: installing, ledgering and
 * granting belong to the profile27 current-runtime installer and grants.
 */
export const galleryProfile27MembersV1 = Object.freeze([
  galleryNavigationMemberV1,
  galleryRenditionMemberV1,
  galleryRestoreSuppressionMemberV1,
] as const);
export type GalleryProfile27MemberV1 = (typeof galleryProfile27MembersV1)[number];

export class GallerySourceMismatchError extends Error {
  constructor(readonly sourceDdlId: number) {
    super('GALLERY_SOURCE_MISMATCH');
    this.name = 'GallerySourceMismatchError';
  }
}
/** Reads one member's migration text and refuses any byte drift from its pinned SHA-256. */
export async function readGalleryMemberSourceV1(member: GalleryProfile27MemberV1): Promise<string> {
  if (!galleryProfile27MembersV1.includes(member))
    throw new GallerySourceMismatchError(member.sourceDdlId);
  const text = await readFile(new URL(`../migrations/${member.filename}`, import.meta.url), 'utf8');
  if (createHash('sha256').update(text).digest('hex') !== member.sha256)
    throw new GallerySourceMismatchError(member.sourceDdlId);
  return text;
}
