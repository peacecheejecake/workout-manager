import { notFound } from 'next/navigation';
import { parseRoutineRoute } from '@workout/modules-routines/route';
import { RoutinePage } from '../routine-page';

export default async function Page({ params }: { params: Promise<{ segments?: string[] }> }) {
  const { segments = [] } = await params;
  const path = `/routines${segments.length ? `/${segments.map(encodeURIComponent).join('/')}` : ''}`;
  const route = parseRoutineRoute(path);
  if (!route) notFound();
  return (
    <main className="wm-page">
      <nav aria-label="주요 화면">
        <a href="/dashboard">대시보드</a> · <a href="/planner">훈련 계획</a> ·{' '}
        <a href="/supplementary">보강 운동</a> · <a href="/account">계정</a>
      </nav>
      <RoutinePage route={route} />
    </main>
  );
}
