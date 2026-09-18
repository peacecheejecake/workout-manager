import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import { parseNutritionSegments } from '@workout/modules-nutrition/nutrition-route';
import { NutritionWorkspace } from '@workout/modules-nutrition/nutrition-workspace';

function Nutrition({ path }: { path: string }) {
  const session = useAuthenticatedSession();
  let segments: string[];
  try {
    segments = path
      .replace(/^\/nutrition\/?/, '')
      .split('/')
      .filter(Boolean)
      .map(decodeURIComponent);
  } catch {
    return <p role="alert">영양 화면 주소가 올바르지 않습니다.</p>;
  }
  const route = parseNutritionSegments(segments);
  if (!route) return <p role="alert">영양 화면 주소가 올바르지 않습니다.</p>;
  return <NutritionWorkspace {...session} route={route} />;
}

export function NutritionPage({ path }: { path: string }) {
  return (
    <AuthenticatedWorkspace>
      <Nutrition path={path} />
    </AuthenticatedWorkspace>
  );
}
