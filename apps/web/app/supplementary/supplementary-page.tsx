'use client';

import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import {
  SupplementaryWorkspace,
  type SupplementaryWorkspaceProps,
} from '@workout/modules-supplementary/supplementary-workspace';

function Supplementary({ route }: { route: SupplementaryWorkspaceProps['route'] }) {
  const session = useAuthenticatedSession();
  return <SupplementaryWorkspace {...session} route={route} />;
}

export function SupplementaryPage({ route }: { route: SupplementaryWorkspaceProps['route'] }) {
  return (
    <AuthenticatedWorkspace>
      <Supplementary route={route} />
    </AuthenticatedWorkspace>
  );
}
