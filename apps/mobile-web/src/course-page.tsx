import { useEffect, useState } from 'react';
import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import { CourseWorkbench } from '@workout/modules-courses/course-workbench';
import { NewCourseWorkbench } from '@workout/modules-courses/course-new';
import { loadShellBasemap, type ShellBasemap } from './basemap';

/**
 * Which S13/S14 screen an address asks for: the list (`/courses`), one stored course opened
 * for editing (`/courses/:id/edit`), or a new course on an empty map (`/courses/new`).
 */
export type CourseScreen =
  | { readonly kind: 'list' }
  | { readonly kind: 'edit'; readonly courseId: string }
  | { readonly kind: 'new' };

/**
 * The same course screens as the Next shell, composed for this shell. Both mount the same
 * module and therefore the same lazy map leaf; only how each obtains its background-map
 * descriptor differs.
 */
function Courses({ screen }: { screen: CourseScreen }) {
  const session = useAuthenticatedSession();
  const [basemap, setBasemap] = useState<ShellBasemap | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void loadShellBasemap(controller.signal).then((resolved) => {
      if (!controller.signal.aborted) setBasemap(resolved);
    });
    return () => controller.abort();
  }, []);
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

export function CoursePage({ screen = { kind: 'list' } }: { screen?: CourseScreen }) {
  return (
    <AuthenticatedWorkspace>
      <Courses screen={screen} />
    </AuthenticatedWorkspace>
  );
}
