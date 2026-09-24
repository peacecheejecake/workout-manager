import type { GalleryMediaItem, GalleryMediaList } from '@workout/contracts/gallery';

export function deduplicateById(items: readonly GalleryMediaItem[]): GalleryMediaItem[] {
  const seen = new Set<string>();
  const unique: GalleryMediaItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push(item);
  }
  return unique;
}

/**
 * Offset for the next list page, or `undefined` when the listing is complete.
 *
 * An insertion or deletion at the head shifts the window, so a page can repeat
 * identities that are already loaded. Advancing by the raw page length would
 * step past identities that were never shown, so the next offset is the number
 * of DISTINCT identities held. This recovers an overlap SMALLER than one page; a
 * whole repeated page adds no new identity and ends the listing, which a stable
 * cursor contract would fix. A page that adds nothing ends the listing rather
 * than re-reading the same window forever.
 */
export function nextGalleryOffset(
  lastPage: GalleryMediaList,
  pages: readonly GalleryMediaList[],
  lastPageParam: number,
): number | undefined {
  if (lastPage.items.length === 0) return undefined;
  const distinct = new Set(pages.flatMap((page) => page.items.map((item) => item.id))).size;
  if (distinct >= lastPage.total || distinct <= lastPageParam) return undefined;
  return distinct;
}
