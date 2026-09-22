import { useEffect, useState } from 'react';
import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import { CourseWorkbench } from '@workout/modules-courses/course-workbench';
import { loadShellBasemap, type ShellBasemap } from './basemap';

/**
 * The same course screen as the Next shell, composed for this shell. Both mount the same
 * module and therefore the same lazy map leaf; only how each obtains its background-map
 * descriptor differs.
 */
function Courses() {
  const session = useAuthenticatedSession();
  const [basemap, setBasemap] = useState<ShellBasemap | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void loadShellBasemap(controller.signal).then((resolved) => {
      if (!controller.signal.aborted) setBasemap(resolved);
    });
    return () => controller.abort();
  }, []);
  return (
    <CourseWorkbench
      {...session}
      basemap={basemap}
      mapWorkerUrl="/dist/maplibre/maplibre-gl-worker.mjs"
    />
  );
}

export function CoursePage() {
  return (
    <AuthenticatedWorkspace>
      <Courses />
    </AuthenticatedWorkspace>
  );
}
