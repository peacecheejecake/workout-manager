import { notFound } from 'next/navigation';
import { parseRoutineRoute } from '@workout/modules-routines/route';
import { RoutinePage } from '../../routines/routine-page';

export default async function Page({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const route = parseRoutineRoute(`/routine-runs/${encodeURIComponent(runId)}`);
  if (!route) notFound();
  return (
    <main className="wm-page">
      <nav aria-label="주요 화면">
        <a href="/routines">루틴</a> · <a href="/planner">훈련 계획</a> ·{' '}
        <a href="/account">계정</a>
      </nav>
      <RoutinePage route={route} />
    </main>
  );
}
