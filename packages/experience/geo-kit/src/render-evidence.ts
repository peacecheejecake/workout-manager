/**
 * What counts as evidence that the path is actually on the map.
 *
 * A loaded style is not that evidence. MapLibre fires its style `load` without a worker,
 * so a map whose worker never started still "loads" and then draws nothing at all
 * (M2-01k F2/F3). The only honest signal is the renderer going idle — it has finished
 * drawing everything it currently has — and then finding our own features among what it
 * drew. This file turns one such observation into a verdict, and keeps three different
 * situations apart that a bare feature count would mix up:
 *
 *  - nothing to draw: an empty path is decided from the data before any renderer is asked,
 *    and it never reaches this file. Waiting for a feature there would wait forever;
 *  - part of the path is inside the viewport but the renderer drew none of it: that is a
 *    renderer that cannot draw, and it is said as such;
 *  - no part of the path is inside the viewport: the renderer cannot be judged from this
 *    frame, and "drawn" would be as false as "not drawn". It is its own state.
 *
 * Lines and points are judged separately. A course is a line; a renderer that drew only
 * the points of a path whose lines are on screen has not drawn the course.
 *
 * Pure and SDK-free, so the rule is tested without a renderer.
 */
import type { MapBounds, MapPathFeatureCollection } from './map-path';

/** The viewport the renderer reports, in the same shape as path bounds. */
export type MapViewport = Pick<MapBounds, 'west' | 'south' | 'east' | 'north'>;

export interface ExpectedGeometry {
  /** A vertex of at least one line feature lies inside the viewport. */
  readonly line: boolean;
  /** At least one point feature lies inside the viewport. */
  readonly point: boolean;
}

function longitudeInside(longitude: number, viewport: MapViewport): boolean {
  const span = viewport.east - viewport.west;
  // A viewport can be wider than the world at low zoom, and its edges can run past ±180°
  // when the map wraps. Measure the offset from the west edge around the circle.
  if (span >= 360) return true;
  const offset = (((longitude - viewport.west) % 360) + 360) % 360;
  return offset <= span;
}

function inside(position: readonly [number, number], viewport: MapViewport): boolean {
  return (
    position[1] >= viewport.south &&
    position[1] <= viewport.north &&
    longitudeInside(position[0], viewport)
  );
}

/**
 * Which kinds of our geometry the renderer must have drawn in this viewport.
 *
 * A line counts only when one of its own vertices is inside. A line can cross a viewport
 * with no vertex in it, but then whether it is drawn there depends on how the renderer
 * clips, and a verdict built on that would be a guess; such a frame is left undecided.
 * A vertex inside the viewport lies on the line, so a working renderer has drawn part of
 * that line on screen.
 */
export function expectedVisibleGeometry(
  collection: MapPathFeatureCollection,
  viewport: MapViewport,
): ExpectedGeometry {
  let line = false;
  let point = false;
  for (const feature of collection.features) {
    if (feature.geometry.type === 'Point') {
      if (!point && inside(feature.geometry.coordinates, viewport)) point = true;
    } else if (!line && feature.geometry.coordinates.some((vertex) => inside(vertex, viewport))) {
      line = true;
    }
    if (line && point) break;
  }
  return { line, point };
}

/**
 * A content key for a collection, so a caller that rebuilds the same lines on every render
 * does not re-send them (and restart the render deadline) each time.
 *
 * It was `JSON.stringify` of the whole collection: correct, but it builds a string of the
 * whole track on every render of the course editor. This walks the same numbers once and
 * folds them into two independent 32-bit hashes, with the feature and vertex counts and
 * every feature id alongside, and allocates nothing per vertex. Coordinates are folded at
 * 1e-7° (about 1 cm), finer than any stored course or track. A collision would need the
 * same ids, counts and both hashes; it would keep the previous line on the map until the
 * next change, and is accepted as vanishingly unlikely.
 */
export function collectionKey(collection: MapPathFeatureCollection): string {
  let first = 0x811c9dc5;
  let second = 0x01000193;
  let vertices = 0;
  const ids: string[] = [];
  const fold = (value: number) => {
    const scaled = Math.round(value * 1e7) | 0;
    first = Math.imul(first ^ scaled, 0x01000193);
    second = Math.imul(second + scaled, 0x5bd1e995) ^ (second >>> 15);
  };
  for (const feature of collection.features) {
    ids.push(`${feature.id}/${feature.properties.role}`);
    if (feature.geometry.type === 'Point') {
      vertices += 1;
      fold(feature.geometry.coordinates[0]);
      fold(feature.geometry.coordinates[1]);
      continue;
    }
    for (const vertex of feature.geometry.coordinates) {
      vertices += 1;
      fold(vertex[0]);
      fold(vertex[1]);
    }
    // Separates [a,b][c] from [a][b,c].
    fold(-1e3);
  }
  return `${collection.features.length}:${vertices}:${first >>> 0}:${second >>> 0}:${ids.join(',')}`;
}

/** One observation, taken when the renderer went idle. */
export interface MapRenderIdleInfo {
  /** Our path features the renderer drew in the viewport, line and point layers together. */
  readonly renderedPathFeatures: number;
  /** Drawn features on the line layer only. */
  readonly renderedLineFeatures: number;
  /** Drawn features on the point layer only. */
  readonly renderedPointFeatures: number;
  /** Features in the paths the renderer currently holds. 0: it has nothing to judge. */
  readonly pathFeatures: number;
  /** What the viewport says must have been drawn, from {@link expectedVisibleGeometry}. */
  readonly expected: ExpectedGeometry;
}

export type RenderVerdict =
  /** What is on screen includes every kind of our geometry the viewport contains. */
  | 'drawn'
  /** Our geometry is inside the viewport and the renderer drew none of at least one kind. */
  | 'not-drawn'
  /** None of our geometry is inside the viewport; this frame proves nothing either way. */
  | 'out-of-view'
  /** The renderer holds no path yet; the observation is about an empty source. */
  | 'no-evidence';

export function judgeRender(info: MapRenderIdleInfo): RenderVerdict {
  if (info.pathFeatures === 0) return 'no-evidence';
  const { line, point } = info.expected;
  if (!line && !point) return 'out-of-view';
  if (line && info.renderedLineFeatures === 0) return 'not-drawn';
  if (point && info.renderedPointFeatures === 0) return 'not-drawn';
  return 'drawn';
}
