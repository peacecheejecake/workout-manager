'use client';

import { SharedCourseView } from '@workout/modules-courses/course-shared-view';
import type { ShellBasemap } from '../../basemap-config';

/**
 * No authenticated workspace here: the recipient needs no account, and this screen reads
 * no session. The map worker is the same same-origin file the course screens use, and it
 * is loaded only after "코스 보기".
 */
export function SharedCoursePage({ basemap }: { basemap: ShellBasemap | null }) {
  return (
    <SharedCourseView basemap={basemap} mapWorkerUrl="/dist/maplibre/maplibre-gl-worker.mjs" />
  );
}
