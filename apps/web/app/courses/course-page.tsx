'use client';

import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import { CourseWorkbench } from '@workout/modules-courses/course-workbench';
import type { ShellBasemap } from '../basemap-config';

function Courses({ basemap }: { basemap: ShellBasemap | null }) {
  const session = useAuthenticatedSession();
  return <CourseWorkbench {...session} basemap={basemap} />;
}

export function CoursePage({ basemap = null }: { basemap?: ShellBasemap | null }) {
  return (
    <AuthenticatedWorkspace>
      <Courses basemap={basemap} />
    </AuthenticatedWorkspace>
  );
}
