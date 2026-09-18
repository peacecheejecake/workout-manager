import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import { parseSupplementaryRoute } from '@workout/modules-supplementary/supplementary-route';
import { SupplementaryWorkspace } from '@workout/modules-supplementary/supplementary-workspace';

function Supplementary({ path }: { path: string }) {
  const session = useAuthenticatedSession();
  const route = parseSupplementaryRoute(path);
  if (!route) return <p role="alert">보강 화면 주소가 올바르지 않습니다.</p>;
  return <SupplementaryWorkspace {...session} route={route} />;
}

export function SupplementaryPage({ path }: { path: string }) {
  return (
    <AuthenticatedWorkspace>
      <Supplementary path={path} />
    </AuthenticatedWorkspace>
  );
}
