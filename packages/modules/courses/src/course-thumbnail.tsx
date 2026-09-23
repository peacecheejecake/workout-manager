'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  courseThumbnailLimits,
  courseThumbnailPath,
  courseThumbnailStrokeColor,
  type CoursePosition,
} from '@workout/contracts/courses';

import styles from './courses.module.css';

/**
 * A small picture of a course line (plan section 5's S13 thumbnail).
 *
 * This is the **drawn** thumbnail. M2-01j introduced it as the whole feature; M2-01l added
 * a **stored** one beside it, and this component is now what the screen falls back to
 * whenever there is no stored picture yet — queued, impossible to draw, or failing and
 * retrying. It costs nothing to fall back to, because the screen already holds the head
 * revision's coordinates.
 *
 * Both pictures come from `courseThumbnailPath` in the contracts package, which is the one
 * definition of this projection. The stored SVG and this one therefore cannot disagree
 * about the shape of a line.
 *
 * Because it draws the head, a privacy-trimmed course shows the **trimmed** line: the
 * picture cannot disagree with the response and the GPX about where the owner has been.
 *
 * It is decoration for a sighted reader, so it carries a label and the real facts stay in
 * the list beside it; a reader who cannot see it loses nothing.
 */
export const THUMBNAIL_VERTEX_BUDGET = courseThumbnailLimits.vertexBudget;

export interface CourseThumbnailProps {
  readonly coordinates: readonly CoursePosition[];
  readonly label: string;
}

export function CourseThumbnail({ coordinates, label }: CourseThumbnailProps) {
  const drawn = useMemo(() => courseThumbnailPath(coordinates), [coordinates]);

  if (drawn === null) return null;
  return (
    <svg
      className={styles.thumbnail}
      viewBox={`0 0 ${courseThumbnailLimits.viewport} ${courseThumbnailLimits.viewport}`}
      role="img"
      aria-label={label}
      data-testid="course-thumbnail"
      data-source="drawn"
      data-vertices={drawn.vertexCount}
    >
      <path
        d={drawn.path}
        fill="none"
        stroke={courseThumbnailStrokeColor}
        strokeWidth={2}
        strokeLinejoin="round"
        // The stored document sets this too. Left at the SVG default the drawn line ends a
        // device pixel short of the stored one, which is the swap becoming visible again.
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Where the owner's authenticated thumbnail download lives. Same origin, no object key. */
export function courseThumbnailDownloadPath(courseId: string): string {
  return `/bff/v1/courses/${encodeURIComponent(courseId)}/thumbnail`;
}

export interface StoredCourseThumbnailProps extends CourseThumbnailProps {
  readonly courseId: string;
  readonly sessionId: string;
  /** Identity of the stored picture. A different revision's picture is a different fetch. */
  readonly contentHash: string;
}

/**
 * The STORED thumbnail, with the drawn one underneath it (M2-01l).
 *
 * The bytes are private, so they are not an `img src` pointing at the API: a plain image
 * request cannot carry the session header the API requires for a cookie session. The read
 * is an authenticated fetch and the bytes become an object URL, embedded through `img` so
 * the SVG is rendered as an image and never as a document.
 *
 * **The object URL cannot outlive what owns it.** It is created inside one effect run and
 * revoked by that run's own cleanup, which also aborts the request and clears the state.
 * So a course change, a revision change, a session change or an unmount all take the
 * previous picture with them; there is no path by which a late reply installs bytes under
 * a course the screen has moved away from, because the run that asked for them is already
 * torn down.
 *
 * Until the fetch lands — and for good if it never does — this renders the drawn picture.
 * Falling back costs nothing: the screen already holds the head revision's coordinates.
 */
export function StoredCourseThumbnail({
  courseId,
  sessionId,
  contentHash,
  coordinates,
  label,
}: StoredCourseThumbnailProps) {
  // The bytes are stored WITH the identity of the picture they are, not beside it. A
  // rendered frame therefore cannot show a picture that belongs to a different revision:
  // the state is only believed while its hash is the hash being asked for. Clearing in the
  // effect cleanup is not enough — cleanup runs after paint, so a revision change would
  // display the previous revision's picture for one frame, and after a privacy trim that
  // frame is the untrimmed line.
  const [stored, setStored] = useState<{ hash: string; url: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    let created: string | null = null;
    void (async () => {
      try {
        const response = await fetch(courseThumbnailDownloadPath(courseId), {
          method: 'GET',
          headers: { 'x-workout-session-id': sessionId },
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          signal: controller.signal,
        });
        if (!response.ok) return;
        const blob = await response.blob();
        if (!live) return;
        created = URL.createObjectURL(blob);
        setStored({ hash: contentHash, url: created });
      } catch {
        // A missing or unreadable stored picture is not an error the owner has to see:
        // the drawn one says the same thing about the same line.
      }
    })();
    return () => {
      live = false;
      controller.abort();
      setStored(null);
      if (created !== null) URL.revokeObjectURL(created);
    };
  }, [courseId, sessionId, contentHash]);

  if (stored === null || stored.hash !== contentHash)
    return <CourseThumbnail coordinates={coordinates} label={label} />;
  return (
    <img
      className={styles.thumbnail}
      src={stored.url}
      alt={label}
      data-testid="course-thumbnail"
      data-source="stored"
    />
  );
}
