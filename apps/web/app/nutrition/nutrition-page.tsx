'use client';

import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import {
  NutritionWorkspace,
  type NutritionRoute,
} from '@workout/modules-nutrition/nutrition-workspace';

function Nutrition({ route }: { route: NutritionRoute }) {
  const session = useAuthenticatedSession();
  return <NutritionWorkspace {...session} route={route} />;
}

export function NutritionPage({ route }: { route: NutritionRoute }) {
  return (
    <AuthenticatedWorkspace>
      <Nutrition route={route} />
    </AuthenticatedWorkspace>
  );
}
