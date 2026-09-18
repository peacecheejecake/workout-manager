import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import { parseRoutineRoute } from '@workout/modules-routines/route';
import { RoutineWorkspace } from '@workout/modules-routines/workspace';

function Routine({ path }: { path: string }) {
  const session = useAuthenticatedSession();
  const route = parseRoutineRoute(path);
  if (!route) return <p role="alert">루틴 화면 주소가 올바르지 않습니다.</p>;
  return <RoutineWorkspace {...session} route={route} />;
}

export function RoutinePage({ path }: { path: string }) {
  return (
    <AuthenticatedWorkspace>
      <Routine path={path} />
    </AuthenticatedWorkspace>
  );
}
