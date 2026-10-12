import { useId } from 'react';
import {
  galleryMediaNavigationV2Schema,
  type GalleryCourseLinkV2,
  type GalleryMediaNavigationV2,
} from '@workout/contracts/gallery-navigation-v2';
import {
  galleryMediaNavigationV3Schema,
  type GalleryMediaNavigationV3,
} from '@workout/contracts/gallery-navigation-v3';
import styles from './gallery-course-link.module.css';
export interface GalleryCourseLinkProps {
  /** Supplied read DTO; legacy V2 cannot establish course availability. */
  navigation: GalleryMediaNavigationV2 | GalleryMediaNavigationV3;
  /** Host navigation capability; the destination still enforces current access. */
  onOpen: ((link: GalleryCourseLinkV2) => void) | null;
}
/** Retains the saved tuple. Availability never selects a new course revision. */
export function GalleryCourseLink({ navigation, onOpen }: GalleryCourseLinkProps) {
  const id = useId();
  const current = galleryMediaNavigationV3Schema.safeParse(navigation);
  const legacy = current.success ? null : galleryMediaNavigationV2Schema.safeParse(navigation);
  const saved = current.success ? current.data : legacy?.success ? legacy.data : null;
  const link = saved?.courseLink ?? null;
  const availability = current.success ? current.data.courseAvailability : null;
  const canOpen = link !== null && availability?.state === 'available' && onOpen !== null;
  const label =
    saved === null
      ? '코스 연결 정보를 확인할 수 없음'
      : link === null
        ? '연결된 코스 없음'
        : availability?.state === 'unavailable'
          ? '사용 불가'
          : availability?.state === 'available'
            ? '사용 가능'
            : '사용 가능 여부 알 수 없음';
  return (
    <section className={styles.link} aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>저장된 코스 연결</h3>
      <p id={`${id}-status`}>{label}</p>
      {link !== null ? (
        <>
          <dl>
            <div>
              <dt>저장된 코스 버전</dt>
              <dd>{link.courseRevision}</dd>
            </div>
          </dl>
          {availability?.state === 'unavailable' ? (
            <p>저장된 연결은 보존됩니다. 코스를 열 수 없습니다.</p>
          ) : null}
          {availability?.state === 'available' && onOpen === null ? (
            <p>현재 화면에서 코스 열기 기능을 사용할 수 없습니다.</p>
          ) : null}
          <button
            type="button"
            disabled={!canOpen}
            aria-describedby={`${id}-status`}
            onClick={() => {
              if (canOpen) onOpen?.({ ...link });
            }}
          >
            저장된 코스 버전 {link.courseRevision} 열기
          </button>
        </>
      ) : null}
    </section>
  );
}
