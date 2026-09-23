import { notFound } from 'next/navigation';
import { availableCourseHeadSchema } from '@workout/contracts/courses';
import { resolveShellBasemap } from '../../../basemap-config';
import { CoursePage } from '../../course-page';

/** Read per request, like `/courses`: the background-map pointer changes on publish. */
export const dynamic = 'force-dynamic';

/**
 * S14 `/courses/:id/edit` (M2-01r). An address that is not a course id at all is a 404 here;
 * whether a well-formed id is the caller's course is the API's answer, shown on the screen.
 */
export default async function Page({ params }: { params: Promise<{ courseId: string }> }) {
  const courseId = availableCourseHeadSchema.shape.courseId.safeParse((await params).courseId);
  if (!courseId.success) notFound();
  const basemap = await resolveShellBasemap();
  return (
    <main className="wm-page">
      <nav aria-label="주요 화면">
        <a href="/courses">코스</a> · <a href="/activities">활동</a> ·{' '}
        <a href="/dashboard">대시보드</a> · <a href="/account">계정</a>
      </nav>
      <CoursePage basemap={basemap} screen={{ kind: 'edit', courseId: courseId.data }} />
    </main>
  );
}
