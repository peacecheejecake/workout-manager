'use client';

import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import { ResourceWorkspace } from '@workout/modules-resources/resource-workspace';

function Resources({
  resourceId,
  versionId,
}: {
  resourceId: string | null;
  versionId: string | null;
}) {
  const session = useAuthenticatedSession();
  return <ResourceWorkspace {...session} resourceId={resourceId} versionId={versionId} />;
}

export function ResourcePage({
  resourceId = null,
  versionId = null,
}: {
  resourceId?: string | null;
  versionId?: string | null;
}) {
  return (
    <AuthenticatedWorkspace>
      <Resources resourceId={resourceId} versionId={versionId} />
    </AuthenticatedWorkspace>
  );
}
