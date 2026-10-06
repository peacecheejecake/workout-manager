import { Suspense, type ReactNode } from 'react';
import { CompetitionShell } from '../competitions/competitions-page';

/** One layout lifetime spans all three canonical list sections and their alias/detail. */
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <main className="wm-page">
      <nav aria-label="주요 화면">
        <a href="/dashboard">대시보드</a> · <a href="/activities">활동</a> ·{' '}
        <a href="/courses">코스</a> · <a href="/account">계정</a>
      </nav>
      <Suspense fallback={<p role="status">대회와 기록 화면 준비 중</p>}>
        <CompetitionShell>{children}</CompetitionShell>
      </Suspense>
    </main>
  );
}
