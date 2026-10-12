export function galleryAdjacentIndex(index: number, length: number, direction: -1 | 1): number {
  if (!Number.isInteger(index) || !Number.isInteger(length) || index < 0 || index >= length)
    return index;
  return Math.max(0, Math.min(length - 1, index + direction));
}

/** Vertical movement remains page scrolling; an edge never wraps the loaded roster. */
export function gallerySwipeDirection(dx: number, dy: number): -1 | 1 | null {
  if (
    !Number.isFinite(dx) ||
    !Number.isFinite(dy) ||
    Math.abs(dx) < 48 ||
    Math.abs(dx) <= Math.abs(dy) * 1.5
  )
    return null;
  return dx < 0 ? 1 : -1;
}
