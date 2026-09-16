import { ImportPage } from './import-page';

export default function Page() {
  return (
    <main className="wm-page">
      <nav aria-label="주요 화면">
        <a href="/activities">활동 목록</a> · <a href="/dashboard">대시보드</a> ·{' '}
        <a href="/account">계정</a>
      </nav>
      <h1>활동 기록</h1>
      <ImportPage />
    </main>
  );
}
