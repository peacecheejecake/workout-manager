import { privateTextResourceSchema } from '@workout/contracts/resources';
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

export function ResourcePage({ path, query }: { path: string; query: string }) {
  const candidate = path.match(/^\/resources\/([^/]+)\/?$/)?.[1];
  const parsedResource = candidate ? privateTextResourceSchema.shape.id.safeParse(candidate) : null;
  const version = new URLSearchParams(query).get('version');
  const parsedVersion = version
    ? privateTextResourceSchema.shape.currentVersionId.safeParse(version)
    : null;
  if ((candidate && !parsedResource?.success) || (version && !parsedVersion?.success)) {
    return <p role="alert">자료 주소가 올바르지 않습니다.</p>;
  }
  return (
    <AuthenticatedWorkspace>
      <Resources
        resourceId={parsedResource?.success ? parsedResource.data : null}
        versionId={parsedVersion?.success ? parsedVersion.data : null}
      />
    </AuthenticatedWorkspace>
  );
}
