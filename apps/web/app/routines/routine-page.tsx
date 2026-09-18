'use client';

import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import { RoutineWorkspace, type RoutineWorkspaceProps } from '@workout/modules-routines/workspace';

function Routine({ route }: { route: RoutineWorkspaceProps['route'] }) {
  const session = useAuthenticatedSession();
  return <RoutineWorkspace {...session} route={route} />;
}

export function RoutinePage({ route }: { route: RoutineWorkspaceProps['route'] }) {
  return (
    <AuthenticatedWorkspace>
      <Routine route={route} />
    </AuthenticatedWorkspace>
  );
}
