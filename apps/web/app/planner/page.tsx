import { PlannerPage } from './planner-page';
export default function Page() {
  return (
    <main className="wm-page">
      <nav aria-label="상담">
        <a href="/coach">상담 기록</a>
      </nav>
      <PlannerPage />
    </main>
  );
}
