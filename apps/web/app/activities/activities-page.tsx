'use client';
import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import { ImportWorkspace } from '@workout/modules-activities/import-workspace';
function Activities() {
  const session = useAuthenticatedSession();
  return <ImportWorkspace {...session} />;
}
export function ActivitiesPage() {
  return (
    <AuthenticatedWorkspace>
      <Activities />
    </AuthenticatedWorkspace>
  );
}
