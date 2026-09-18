'use client';

import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import {
  StretchingWorkspace,
  type StretchingWorkspaceProps,
} from '@workout/modules-supplementary/stretching-workspace';

function Stretching({
  route,
}: {
  route: Pick<StretchingWorkspaceProps, 'exerciseId' | 'activityId'>;
}) {
  const session = useAuthenticatedSession();
  return <StretchingWorkspace {...session} {...route} />;
}

export function StretchingPage({
  route,
}: {
  route: Pick<StretchingWorkspaceProps, 'exerciseId' | 'activityId'>;
}) {
  return (
    <AuthenticatedWorkspace>
      <Stretching route={route} />
    </AuthenticatedWorkspace>
  );
}
