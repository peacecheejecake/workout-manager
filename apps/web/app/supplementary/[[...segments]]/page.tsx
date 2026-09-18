import { notFound } from 'next/navigation';
import { parseSupplementaryRoute } from '@workout/modules-supplementary/supplementary-route';
import { SupplementaryPage } from '../supplementary-page';

export default async function Page({ params }: { params: Promise<{ segments?: string[] }> }) {
  const { segments = [] } = await params;
  const path = `/supplementary${segments.length ? `/${segments.map(encodeURIComponent).join('/')}` : ''}`;
  const route = parseSupplementaryRoute(path);
  if (!route) notFound();
  return (
    <main className="wm-page">
      <nav aria-label="주요 화면">
        <a href="/dashboard">대시보드</a> · <a href="/planner">훈련 계획</a> ·{' '}
        <a href="/activities">활동</a> · <a href="/nutrition">영양</a> · <a href="/account">계정</a>
      </nav>
      <SupplementaryPage route={route} />
    </main>
  );
}
