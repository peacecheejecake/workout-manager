import { notFound } from 'next/navigation';
import { parseStretchingRoute } from '@workout/modules-supplementary/stretching-route';
import { StretchingPage } from '../stretching-page';

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ segments?: string[] }>;
  searchParams: Promise<{ activityId?: string | string[] }>;
}) {
  const { segments = [] } = await params;
  const { activityId } = await searchParams;
  const path = `/stretching${segments.length ? `/${segments.map(encodeURIComponent).join('/')}` : ''}`;
  const route = parseStretchingRoute(path, typeof activityId === 'string' ? activityId : null);
  if (!route || Array.isArray(activityId)) notFound();
  return (
    <main className="wm-page">
      <nav aria-label="주요 화면">
        <a href="/dashboard">대시보드</a> · <a href="/planner">훈련 계획</a> ·{' '}
        <a href="/activities">활동</a> · <a href="/supplementary">보강 운동</a> ·{' '}
        <a href="/account">계정</a>
      </nav>
      <StretchingPage route={route} />
    </main>
  );
}
