'use client';
import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import { ImportWorkspace } from '@workout/modules-activities/import-workspace';
function Imports() {
  const session = useAuthenticatedSession();
  return <ImportWorkspace {...session} />;
}
export function ImportPage() {
  return (
    <AuthenticatedWorkspace>
      <Imports />
    </AuthenticatedWorkspace>
  );
}
