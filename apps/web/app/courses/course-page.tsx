'use client';

import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import { CourseWorkbench } from '@workout/modules-courses/course-workbench';

function Courses() {
  const session = useAuthenticatedSession();
  return <CourseWorkbench {...session} />;
}

export function CoursePage() {
  return (
    <AuthenticatedWorkspace>
      <Courses />
    </AuthenticatedWorkspace>
  );
}
