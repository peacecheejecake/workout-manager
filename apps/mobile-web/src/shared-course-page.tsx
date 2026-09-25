import { SharedCourseView } from '@workout/modules-courses/course-shared-view';
import { loadShellBasemap } from './basemap';

/**
 * The recipient's screen of a view-only link (M2-01k-o), composed for this shell. No
 * authenticated workspace: the recipient needs no account. The background-map descriptor
 * is learnt only after "코스 보기", like everything else on this screen.
 */
export function SharedCoursePage() {
  return (
    <SharedCourseView
      loadBasemap={(signal) => loadShellBasemap(signal)}
      mapWorkerUrl="/dist/maplibre/maplibre-gl-worker.mjs"
    />
  );
}
