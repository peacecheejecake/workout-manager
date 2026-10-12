import { useId } from 'react';
import type { GalleryAlbumV1, GalleryCourseLinkV2 } from '@workout/contracts/gallery-navigation-v2';
import type {
  GalleryMediaOrganizerDraft,
  GalleryMediaOrganizerOperation,
} from './use-gallery-media-organizer';
import styles from './gallery-albums.module.css';

export interface GalleryMediaOrganizerActions {
  changeAlbum: (albumId: string | null) => void;
  changeCourse: (courseLink: GalleryCourseLinkV2 | null) => void;
  cancel: () => void;
  save: () => void;
  confirm: () => void;
}
export interface GalleryMediaOrganizerProps {
  /** Display name of the edited item; the draft holds the frozen identity/revision. */
  label: string | null;
  draft: GalleryMediaOrganizerDraft | null;
  albums: readonly GalleryAlbumV1[];
  courses: readonly { label: string; link: GalleryCourseLinkV2 }[];
  operation: GalleryMediaOrganizerOperation;
  actions: GalleryMediaOrganizerActions | null;
}
const courseKey = (link: GalleryCourseLinkV2) =>
  `${link.courseId}:${link.courseRevision}:${link.revisionId}`;

/** Controlled assignment form. It never derives a course from location data and
 * never maps the legacy album text onto an owned album. */
export function GalleryMediaOrganizer({
  label,
  draft,
  albums,
  courses,
  operation,
  actions,
}: GalleryMediaOrganizerProps) {
  const id = useId();
  if (operation.state === 'saved' && draft === null)
    return (
      <p role="status" className={styles.albums}>
        앨범·코스 지정을 저장했습니다.
      </p>
    );
  if (draft === null || actions === null) return null;
  const locked = operation.state === 'submitting' || operation.state === 'uncertain';
  const savedAlbumMissing =
    draft.savedAlbumId !== null && !albums.some((album) => album.id === draft.savedAlbumId);
  const savedCourse = draft.savedCourseLink;
  const savedCourseListed =
    savedCourse !== null && courses.some((c) => courseKey(c.link) === courseKey(savedCourse));
  const selectedCourse = draft.courseLink === null ? '' : courseKey(draft.courseLink);
  return (
    <section className={styles.albums} aria-labelledby={`${id}-heading`}>
      <div className={styles.panel}>
        <h2 id={`${id}-heading`}>앨범·코스 지정</h2>
        <p>{label ?? '선택한 미디어'}</p>
        <p>
          원본 파일과 기존 앨범 문자열은 바뀌지 않습니다. 코스는 직접 고른 저장 리비전만 연결하며
          위치 정보로 추정하지 않습니다.
        </p>
        <label htmlFor={`${id}-album`}>지정할 앨범</label>
        <select
          id={`${id}-album`}
          value={draft.albumId ?? ''}
          disabled={locked}
          onChange={(event) => actions.changeAlbum(event.target.value || null)}
        >
          <option value="">앨범 없음</option>
          {savedAlbumMissing ? (
            <option value={draft.savedAlbumId ?? ''}>현재 앨범 유지 (목록에 없음)</option>
          ) : null}
          {albums.map((album) => (
            <option key={album.id} value={album.id}>
              {album.title}
            </option>
          ))}
        </select>
        <label htmlFor={`${id}-course`}>지정할 코스 리비전</label>
        <select
          id={`${id}-course`}
          value={selectedCourse}
          disabled={locked}
          onChange={(event) => {
            const value = event.target.value;
            if (value === '') return actions.changeCourse(null);
            if (savedCourse !== null && value === courseKey(savedCourse))
              return actions.changeCourse(savedCourse);
            const choice = courses.find((course) => courseKey(course.link) === value);
            if (choice) actions.changeCourse(choice.link);
          }}
        >
          <option value="">코스 연결 없음</option>
          {savedCourse !== null && !savedCourseListed ? (
            <option value={courseKey(savedCourse)}>
              저장된 연결 유지 · 리비전 {savedCourse.courseRevision}
            </option>
          ) : null}
          {courses.map((course) => (
            <option key={courseKey(course.link)} value={courseKey(course.link)}>
              {course.label} · 리비전 {course.link.courseRevision}
            </option>
          ))}
        </select>
        <div className={styles.actions}>
          <button
            type="button"
            onClick={actions.save}
            disabled={locked || operation.state === 'conflict'}
          >
            지정 저장
          </button>
          <button type="button" onClick={actions.cancel} disabled={locked}>
            취소
          </button>
        </div>
        {operation.state === 'submitting' ? <p role="status">저장하는 중입니다.</p> : null}
        {operation.state === 'conflict' ? (
          <p role="alert">
            이 미디어가 다른 곳에서 먼저 바뀌었습니다. 선택은 보존했지만 저장하지 않았습니다. 목록을
            다시 불러온 뒤 미디어를 다시 선택하세요.
          </p>
        ) : null}
        {operation.state === 'rejected' ? (
          <p role="alert">
            {operation.status === 404
              ? '미디어, 앨범 또는 코스를 찾을 수 없어 저장하지 않았습니다.'
              : '요청이 거절되어 저장하지 않았습니다.'}
          </p>
        ) : null}
        {operation.state === 'uncertain' ? (
          <div role="alert">
            <p>저장 결과를 확인하지 못했습니다. 같은 요청으로만 결과를 확인합니다.</p>
            <button type="button" onClick={actions.confirm}>
              같은 요청으로 결과 확인
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
