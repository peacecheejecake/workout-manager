import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import { parseStretchingRoute } from '@workout/modules-supplementary/stretching-route';
import { StretchingWorkspace } from '@workout/modules-supplementary/stretching-workspace';

function Stretching({ path, query }: { path: string; query: string }) {
  const session = useAuthenticatedSession();
  const parameters = new URLSearchParams(query);
  const activityId = parameters.getAll('activityId');
  const route = activityId.length > 1 ? null : parseStretchingRoute(path, activityId[0] ?? null);
  if (!route) return <p role="alert">스트레칭 화면 주소가 올바르지 않습니다.</p>;
  return <StretchingWorkspace {...session} {...route} />;
}

export function StretchingPage({ path, query }: { path: string; query: string }) {
  return (
    <AuthenticatedWorkspace>
      <Stretching path={path} query={query} />
    </AuthenticatedWorkspace>
  );
}
