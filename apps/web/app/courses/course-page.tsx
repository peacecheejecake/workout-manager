'use client';

import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import { CourseWorkbench } from '@workout/modules-courses/course-workbench';
import type { ShellBasemap } from '../basemap-config';

function Courses({ basemap }: { basemap: ShellBasemap | null }) {
  const session = useAuthenticatedSession();
  // The worker is served from this origin by `copy-map-worker.mjs`, exactly as the activity
  // screens configure it. Without it the map never loads a worker: no tiles, no line.
  return (
    <CourseWorkbench
      {...session}
      basemap={basemap}
      mapWorkerUrl="/dist/maplibre/maplibre-gl-worker.mjs"
    />
  );
}

export function CoursePage({ basemap = null }: { basemap?: ShellBasemap | null }) {
  return (
    <AuthenticatedWorkspace>
      <Courses basemap={basemap} />
    </AuthenticatedWorkspace>
  );
}
