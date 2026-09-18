import { RecoveryPage } from './recovery-page';

export default function Page() {
  return (
    <main className="wm-page">
      <nav aria-label="주요 화면">
        <a href="/dashboard">대시보드</a> · <a href="/wellbeing">체크인</a> ·{' '}
        <a href="/nutrition">영양</a> · <a href="/account">계정</a>
      </nav>
      <RecoveryPage />
    </main>
  );
}
