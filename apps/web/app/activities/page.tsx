import { resolveShellBasemap } from '../basemap-config';
import { ActivitiesPage } from './activities-page';

/**
 * The background-map deployment is read per request, not baked into a prerender: the
 * deployment pointer changes when a new basemap is published, and a statically rendered
 * page would keep serving the descriptor that happened to exist at build time.
 */
export const dynamic = 'force-dynamic';

export default async function Page() {
  // Read on the server and passed down as serializable data: the client module never
  // reads an environment variable and never learns where the deployment lives on disk.
  const basemap = await resolveShellBasemap();
  return (
    <main className="wm-page">
      <nav aria-label="주요 화면">
        <a href="/dashboard">대시보드</a> · <a href="/account">계정</a> ·{' '}
        <a href="/planner">훈련 계획</a> · <a href="/wellbeing">체크인</a> ·{' '}
        <a href="/activities/track-preview">기록 파일 미리보기</a> · <a href="/courses">코스</a>
      </nav>
      <h1>활동 목록</h1>
      <ActivitiesPage basemap={basemap} />
    </main>
  );
}
