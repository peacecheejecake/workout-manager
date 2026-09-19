import { ResourcePage } from './resource-page';

export default function Page() {
  return (
    <main className="wm-page">
      <nav aria-label="주요 화면">
        <a href="/dashboard">대시보드</a> · <a href="/coach">코치</a> · <a href="/account">계정</a>
      </nav>
      <ResourcePage />
    </main>
  );
}
