import { notFound } from 'next/navigation';
import { parseNutritionSegments } from '@workout/modules-nutrition/nutrition-route';
import { NutritionPage } from '../nutrition-page';

export default async function Page({ params }: { params: Promise<{ segments?: string[] }> }) {
  const { segments = [] } = await params;
  const route = parseNutritionSegments(segments);
  if (!route) notFound();
  return (
    <main className="wm-page">
      <nav aria-label="주요 화면">
        <a href="/dashboard">대시보드</a> · <a href="/planner">훈련 계획</a> ·{' '}
        <a href="/activities">활동</a> · <a href="/account">계정</a>
      </nav>
      <NutritionPage route={route} />
    </main>
  );
}
