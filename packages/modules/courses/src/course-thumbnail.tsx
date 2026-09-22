'use client';

import { useMemo } from 'react';
import type { CoursePosition } from '@workout/contracts/courses';

import styles from './courses.module.css';

/**
 * A small picture of a course line (M2-01j, plan section 5's S13 thumbnail).
 *
 * It is **drawn, not stored**. The plan calls a thumbnail "private derived location data"
 * that must follow the course's permission, deletion and export policy; the cheapest way
 * to satisfy every one of those rules is to keep no derived artefact at all. This renders
 * the head revision the owner is already looking at, in their own browser, from
 * coordinates the screen already holds. There is no object, no key, no cache entry and
 * nothing extra for a deletion or an export to reach.
 *
 * Because it draws the head, a privacy-trimmed course shows the **trimmed** line: the
 * picture cannot disagree with the response and the GPX about where the owner has been.
 *
 * It is decoration for a sighted reader, so it carries a label and the real facts stay in
 * the list beside it; a reader who cannot see it loses nothing.
 */
export const THUMBNAIL_VERTEX_BUDGET = 400;

export interface CourseThumbnailProps {
  readonly coordinates: readonly CoursePosition[];
  readonly label: string;
}

/** Evenly spaced sample of a long line. A course may carry 20,000 vertices. */
function sample(coordinates: readonly CoursePosition[]): readonly CoursePosition[] {
  if (coordinates.length <= THUMBNAIL_VERTEX_BUDGET) return coordinates;
  const step = (coordinates.length - 1) / (THUMBNAIL_VERTEX_BUDGET - 1);
  const sampled: CoursePosition[] = [];
  for (let index = 0; index < THUMBNAIL_VERTEX_BUDGET; index += 1) {
    const position = coordinates[Math.round(index * step)];
    if (position !== undefined) sampled.push(position);
  }
  return sampled;
}

export function CourseThumbnail({ coordinates, label }: CourseThumbnailProps) {
  const path = useMemo(() => {
    if (coordinates.length < 2) return null;
    const points = sample(coordinates);
    const longitudes = points.map((position) => position[0]);
    const latitudes = points.map((position) => position[1]);
    const west = Math.min(...longitudes);
    const east = Math.max(...longitudes);
    const south = Math.min(...latitudes);
    const north = Math.max(...latitudes);
    // A degree of longitude is shorter than a degree of latitude everywhere but the
    // equator, so drawing both at the same scale stretches the picture sideways — about
    // 27% at Seoul's latitude, which is enough to turn a there-and-back into a shape the
    // owner does not recognise. One cosine at the middle latitude of this course is all it
    // takes for the picture to have the proportions of the real route.
    const shrinkX = Math.cos((((north + south) / 2) * Math.PI) / 180);
    // A course can be a straight north-south line, so neither span may divide by zero.
    const spanX = (east - west) * shrinkX || 1e-6;
    const spanY = north - south || 1e-6;
    const scale = Math.min(96 / spanX, 96 / spanY);
    const offsetX = (100 - spanX * scale) / 2;
    const offsetY = (100 - spanY * scale) / 2;
    return points
      .map((position, index) => {
        const x = offsetX + (position[0] - west) * shrinkX * scale;
        // SVG y grows downward; north belongs at the top.
        const y = offsetY + (north - position[1]) * scale;
        return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
      })
      .join(' ');
  }, [coordinates]);

  if (path === null) return null;
  return (
    <svg
      className={styles.thumbnail}
      viewBox="0 0 100 100"
      role="img"
      aria-label={label}
      data-testid="course-thumbnail"
      data-vertices={Math.min(coordinates.length, THUMBNAIL_VERTEX_BUDGET)}
    >
      <path d={path} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
    </svg>
  );
}
