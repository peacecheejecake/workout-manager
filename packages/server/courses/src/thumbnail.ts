import { createHash } from 'node:crypto';

import {
  coursePositionSchema,
  courseThumbnailLimits,
  courseThumbnailMediaType,
  courseThumbnailPath,
  courseThumbnailRendererId,
  courseThumbnailRendererVersion,
  courseThumbnailStrokeColor,
  type CoursePosition,
} from '@workout/contracts/courses';

/**
 * The renderer behind the STORED course thumbnail (M2-01l, plan section 5).
 *
 * Pure: coordinates in, bytes out, no I/O and no clock. The worker owns when this runs and
 * the database owns whether the result may be published; this file only decides what the
 * picture is.
 *
 * Two properties are load-bearing and both are tested.
 *
 * **Deterministic.** The same coordinates always produce the same bytes, so the content
 * hash identifies the picture and a republish of an identical revision is a no-op rather
 * than a second object. Nothing time-, locale- or environment-dependent is written: the
 * markup carries no timestamp, no course name and no identifier.
 *
 * **Free of user text.** The document is one `path` whose `d` is built from finite numbers
 * that already passed `coursePositionSchema`. No name, filename, waypoint label or error
 * message is interpolated, so there is no string in it that a user could have authored —
 * which is what makes serving it as `image/svg+xml` safe even before the download route
 * adds its own headers.
 */
export type CourseThumbnailRenderRefusal = 'line_too_short_to_draw';

export class CourseThumbnailRenderError extends Error {
  constructor(readonly code: CourseThumbnailRenderRefusal) {
    super(code);
    this.name = 'CourseThumbnailRenderError';
  }
}

export interface RenderedCourseThumbnail {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly byteSize: number;
  readonly mediaType: typeof courseThumbnailMediaType;
  readonly viewport: number;
  readonly vertexCount: number;
  readonly rendererId: typeof courseThumbnailRendererId;
  readonly rendererVersion: typeof courseThumbnailRendererVersion;
}

/**
 * Draw one course line.
 *
 * Refuses rather than invents when the line cannot be drawn. A course with fewer than two
 * vertices is a point, and a picture of a point would be a shape nobody recorded; that is
 * a permanent answer, not a failure, and the caller records it as such so the state the
 * owner sees says "cannot be made" and not "still coming".
 */
export function renderCourseThumbnail(
  coordinates: readonly CoursePosition[],
): RenderedCourseThumbnail {
  // Re-validated here, at the boundary, rather than trusted from the caller.
  //
  // The path is arithmetic on these numbers, and arithmetic on a non-finite one produces
  // `NaN` — which is not an injection and not a refusal but something worse for this node:
  // `d="MNaN NaN"` is a *valid* SVG document that draws nothing, and it would be hashed,
  // sized and published as `ready`. A picture that silently shows no line is exactly the
  // confusion the six-state read model exists to prevent, so the renderer refuses the input
  // instead of producing a believable empty answer.
  for (const position of coordinates) coursePositionSchema.parse(position);
  const drawn = courseThumbnailPath(coordinates);
  if (drawn === null) throw new CourseThumbnailRenderError('line_too_short_to_draw');
  const { viewport } = courseThumbnailLimits;
  // `role="img"` and the absent title are deliberate: the accessible name belongs to the
  // element that embeds this picture, which knows which course it is. Naming it here would
  // mean writing the owner's course name into a stored object.
  const document =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewport} ${viewport}" ` +
    `width="${viewport}" height="${viewport}" role="img" aria-hidden="true" ` +
    `data-renderer="${courseThumbnailRendererId}">` +
    `<path d="${drawn.path}" fill="none" stroke="${courseThumbnailStrokeColor}" ` +
    `stroke-width="2" ` +
    `stroke-linejoin="round" stroke-linecap="round"/>` +
    `</svg>\n`;
  const bytes = new TextEncoder().encode(document);
  if (bytes.byteLength > courseThumbnailLimits.maxBytes)
    // Unreachable with the vertex budget above; kept because the ceiling is what the
    // database CHECK enforces and a renderer change must fail here, not there.
    throw new Error('COURSE_THUMBNAIL_TOO_LARGE');
  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteSize: bytes.byteLength,
    mediaType: courseThumbnailMediaType,
    viewport,
    vertexCount: drawn.vertexCount,
    rendererId: courseThumbnailRendererId,
    rendererVersion: courseThumbnailRendererVersion,
  };
}
