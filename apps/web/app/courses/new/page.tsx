import { resolveShellBasemap } from '../../basemap-config';
import { CoursePage } from '../course-page';

/** Read per request, like `/courses`: the background-map pointer changes on publish. */
export const dynamic = 'force-dynamic';

/** S14 `/courses/new` (M2-01r): a course started on an empty map. */
export default async function Page() {
  const basemap = await resolveShellBasemap();
  return (
    <main className="wm-page">
      <nav aria-label="주요 화면">
        <a href="/courses">코스</a> · <a href="/activities">활동</a> ·{' '}
        <a href="/dashboard">대시보드</a> · <a href="/account">계정</a>
      </nav>
      <CoursePage basemap={basemap} screen={{ kind: 'new' }} />
    </main>
  );
}
