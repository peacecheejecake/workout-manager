import { CoursePage } from './course-page';

export default function Page() {
  return (
    <main className="wm-page">
      <nav aria-label="주요 화면">
        <a href="/activities">활동</a> · <a href="/dashboard">대시보드</a> ·{' '}
        <a href="/account">계정</a>
      </nav>
      <CoursePage />
    </main>
  );
}
