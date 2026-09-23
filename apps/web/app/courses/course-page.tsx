'use client';

import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import { CourseWorkbench } from '@workout/modules-courses/course-workbench';
import { NewCourseWorkbench } from '@workout/modules-courses/course-new';
import type { ShellBasemap } from '../basemap-config';

/**
 * Which S13/S14 screen an address asks for: the list (`/courses`), one stored course opened
 * for editing (`/courses/:id/edit`), or a new course on an empty map (`/courses/new`).
 */
export type CourseScreen =
  | { readonly kind: 'list' }
  | { readonly kind: 'edit'; readonly courseId: string }
  | { readonly kind: 'new' };

function Courses({ basemap, screen }: { basemap: ShellBasemap | null; screen: CourseScreen }) {
  const session = useAuthenticatedSession();
  // The worker is served from this origin by `copy-map-worker.mjs`, exactly as the activity
  // screens configure it. Without it the map never loads a worker: no tiles, no line.
  if (screen.kind === 'new')
    return (
      <NewCourseWorkbench
        {...session}
        basemap={basemap}
        mapWorkerUrl="/dist/maplibre/maplibre-gl-worker.mjs"
        onCreated={(courseId) =>
          window.location.assign(`/courses/${encodeURIComponent(courseId)}/edit`)
        }
      />
    );
  return (
    <CourseWorkbench
      {...session}
      basemap={basemap}
      mapWorkerUrl="/dist/maplibre/maplibre-gl-worker.mjs"
      {...(screen.kind === 'edit' ? { initialCourseId: screen.courseId } : {})}
    />
  );
}

export function CoursePage({
  basemap = null,
  screen = { kind: 'list' },
}: {
  basemap?: ShellBasemap | null;
  screen?: CourseScreen;
}) {
  return (
    <AuthenticatedWorkspace>
      <Courses basemap={basemap} screen={screen} />
    </AuthenticatedWorkspace>
  );
}
