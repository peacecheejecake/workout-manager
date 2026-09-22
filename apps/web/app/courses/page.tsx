import { resolveShellBasemap } from '../basemap-config';
import { CoursePage } from './course-page';

/**
 * The background-map deployment is read per request, not baked into a prerender: the
 * pointer changes when a new basemap is published, and a statically rendered page would
 * keep serving the descriptor that happened to exist at build time.
 */
export const dynamic = 'force-dynamic';

export default async function Page() {
  const basemap = await resolveShellBasemap();
  return (
    <main className="wm-page">
      <nav aria-label="주요 화면">
        <a href="/activities">활동</a> · <a href="/dashboard">대시보드</a> ·{' '}
        <a href="/account">계정</a>
      </nav>
      <CoursePage basemap={basemap} />
    </main>
  );
}
