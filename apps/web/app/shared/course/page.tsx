import type { Metadata } from 'next';
import { resolveShellBasemap } from '../../basemap-config';
import { SharedCoursePage } from './shared-course-page';

/** The background-map pointer is read per request, like the course screens. */
export const dynamic = 'force-dynamic';

/**
 * The recipient's screen of a view-only link (M2-01k-o §3 B, R-4, R7).
 *
 * Every link gets the same static page: the token is in the address fragment, which never
 * reaches this server, so nothing here can depend on it. The preview text is one generic
 * sentence with no image, the page asks not to be indexed and sends no referrer, and it
 * needs no sign-in.
 */
export const metadata: Metadata = {
  title: '공유된 코스',
  description: '보기 전용으로 공유된 코스입니다.',
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
  openGraph: { title: '공유된 코스', description: '보기 전용으로 공유된 코스입니다.' },
};

export default async function Page() {
  const basemap = await resolveShellBasemap();
  return (
    <main className="wm-page">
      <SharedCoursePage basemap={basemap} />
    </main>
  );
}
