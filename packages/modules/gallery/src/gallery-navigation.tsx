import { useId, type ReactNode } from 'react';
import {
  galleryMediaNavigationQueryV2Schema,
  type GalleryAlbumV1,
  type GalleryCourseLinkV2,
  type GalleryMediaNavigationQueryV2,
} from '@workout/contracts/gallery-navigation-v2';
import type { GalleryMediaNavigationPageV3 } from '@workout/contracts/gallery-navigation-v3';
import styles from './gallery-navigation.module.css';

type Filters = GalleryMediaNavigationQueryV2['filters'];
export type GalleryNavigationFilters = Omit<Filters, 'capturedDay'> & {
  capturedDay:
    | { mode: 'all' }
    | { mode: 'unknown' }
    | { mode: 'stored_local_range'; from: string; toInclusive: string };
};
export type GalleryNavigationResult =
  | { state: 'unavailable' }
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'conflict' }
  | { state: 'ready'; page: GalleryMediaNavigationPageV3 };
export interface GalleryNavigationActions {
  changeFilters: (filters: GalleryNavigationFilters) => void;
  navigate: (query: GalleryMediaNavigationQueryV2) => void;
  reload: () => void;
  openMedia: ((mediaItemId: string) => void) | null;
}
export type GalleryCourseChoicesState =
  | { state: 'unavailable' }
  | { state: 'loading' }
  | { state: 'error'; reload: () => void }
  | { state: 'ready'; unavailableCount: number; reload: () => void };
export interface GalleryNavigationProps {
  filters: GalleryNavigationFilters;
  limit: number;
  albums: readonly GalleryAlbumV1[];
  courses: readonly { label: string; link: GalleryCourseLinkV2 }[];
  /** Omitted preserves the existing controlled choices API. */
  courseChoices?: GalleryCourseChoicesState;
  result: GalleryNavigationResult;
  /** Null means the host has no navigation API capability. */
  actions: GalleryNavigationActions | null;
}
const courseKey = (link: GalleryCourseLinkV2) =>
  `${link.courseId}:${link.courseRevision}:${link.revisionId}`;

export type GalleryNavigationControlsProps = GalleryNavigationProps;
export interface GalleryNavigationResultFrameProps extends Pick<
  GalleryNavigationProps,
  'filters' | 'limit' | 'result' | 'actions'
> {
  children: ReactNode;
}

/** Controlled filter form; applying always begins with a fresh query cursor. */
export function GalleryNavigationControls({
  filters,
  limit,
  albums,
  courses,
  courseChoices,
  result,
  actions,
}: GalleryNavigationControlsProps) {
  const id = useId();
  const query = galleryMediaNavigationQueryV2Schema.safeParse({
    filters,
    limit,
    sort: 'created_desc_id_asc',
    cursor: null,
  });
  const loading = result.state === 'loading';
  const unavailable = actions === null || result.state === 'unavailable';
  const selectedCourse = filters.courseLink === null ? '' : courseKey(filters.courseLink);
  const selectedAlbum = filters.album.mode === 'album' ? filters.album.albumId : filters.album.mode;
  function change(patch: Partial<GalleryNavigationFilters>) {
    actions?.changeFilters({ ...filters, ...patch });
  }
  return (
    <form
      className={styles.navigation}
      aria-label="갤러리 탐색 필터"
      onSubmit={(event) => {
        event.preventDefault();
        if (!unavailable && !loading && query.success) actions?.navigate(query.data);
      }}
    >
      <fieldset disabled={unavailable || loading}>
        <legend>사진·동영상 필터</legend>
        <label htmlFor={`${id}-album`}>앨범</label>
        <select
          id={`${id}-album`}
          value={selectedAlbum}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value === 'all' || value === 'unassigned') change({ album: { mode: value } });
            else {
              const album = albums.find((entry) => entry.id === value);
              if (album) change({ album: { mode: 'album', albumId: album.id } });
            }
          }}
        >
          <option value="all">모든 앨범</option>
          <option value="unassigned">앨범 미지정</option>
          {filters.album.mode === 'album' && !albums.some((a) => a.id === selectedAlbum) ? (
            <option value={selectedAlbum} disabled>
              선택한 앨범 정보 없음
            </option>
          ) : null}
          {albums.map((album) => (
            <option key={album.id} value={album.id}>
              {album.title}
            </option>
          ))}
        </select>
        <label htmlFor={`${id}-day`}>촬영일</label>
        <select
          id={`${id}-day`}
          value={filters.capturedDay.mode}
          onChange={(event) => {
            const mode = event.currentTarget.value;
            if (mode === 'all' || mode === 'unknown') change({ capturedDay: { mode } });
            else if (mode === 'stored_local_range')
              change({ capturedDay: { mode, from: '', toInclusive: '' } });
          }}
        >
          <option value="all">모든 날짜</option>
          <option value="unknown">촬영일 알 수 없음</option>
          <option value="stored_local_range">저장된 촬영일 범위</option>
        </select>
        {filters.capturedDay.mode === 'stored_local_range' ? (
          <div className={styles.range}>
            <label htmlFor={`${id}-from`}>시작 촬영일</label>
            <input
              id={`${id}-from`}
              type="date"
              value={filters.capturedDay.from}
              onChange={(event) => {
                if (filters.capturedDay.mode === 'stored_local_range')
                  change({
                    capturedDay: { ...filters.capturedDay, from: event.currentTarget.value },
                  });
              }}
            />
            <label htmlFor={`${id}-to`}>마지막 촬영일 (포함)</label>
            <input
              id={`${id}-to`}
              type="date"
              value={filters.capturedDay.toInclusive}
              onChange={(event) => {
                if (filters.capturedDay.mode === 'stored_local_range')
                  change({
                    capturedDay: {
                      ...filters.capturedDay,
                      toInclusive: event.currentTarget.value,
                    },
                  });
              }}
            />
          </div>
        ) : null}
        <p>촬영일은 저장된 현지 날짜 기준입니다. 현재 기기의 시간대로 변환하지 않습니다.</p>
        <label htmlFor={`${id}-course`}>연결된 코스 리비전</label>
        <select
          id={`${id}-course`}
          value={selectedCourse}
          disabled={courseChoices !== undefined && courseChoices.state !== 'ready'}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value === '') change({ courseLink: null });
            else {
              const choice = courses.find((course) => courseKey(course.link) === value);
              if (choice) change({ courseLink: choice.link });
            }
          }}
        >
          <option value="">모든 코스 연결</option>
          {filters.courseLink !== null &&
          !courses.some((c) => courseKey(c.link) === selectedCourse) ? (
            <option value={selectedCourse} disabled>
              선택한 코스 리비전 정보 없음
            </option>
          ) : null}
          {courses.map((course) => (
            <option key={courseKey(course.link)} value={courseKey(course.link)}>
              {course.label} · 리비전 {course.link.courseRevision}
            </option>
          ))}
        </select>
        {courseChoices !== undefined && filters.courseLink !== null ? (
          <p>선택한 저장 코스 버전 {filters.courseLink.courseRevision}</p>
        ) : null}
        {courseChoices?.state === 'unavailable' ? (
          <p role="status">이 환경에서는 코스 버전 목록 조회를 사용할 수 없습니다.</p>
        ) : courseChoices?.state === 'loading' ? (
          <p role="status">현재 코스 버전 목록을 불러오는 중입니다.</p>
        ) : courseChoices?.state === 'error' ? (
          <p role="alert">
            코스 버전 목록을 불러오지 못했습니다.{' '}
            <button type="button" onClick={courseChoices.reload}>
              코스 목록 다시 조회
            </button>
          </p>
        ) : courseChoices?.state === 'ready' ? (
          <div>
            <p>현재 조회된 소유 코스 버전만 선택할 수 있습니다. 이전 버전 전체 목록은 아닙니다.</p>
            {courses.length === 0 ? (
              <p role="status">현재 선택 가능한 코스 버전이 없습니다.</p>
            ) : null}
            {courseChoices.unavailableCount > 0 ? (
              <p>현재 목록에서 선택할 수 없는 코스 {courseChoices.unavailableCount}개</p>
            ) : null}
            <button type="button" onClick={courseChoices.reload}>
              코스 목록 다시 조회
            </button>
          </div>
        ) : null}
        <p>저장된 코스·리비전 연결만 검색합니다. 위치 정보로 연결을 추정하지 않습니다.</p>
        {!query.success ? (
          <p role="alert">
            필터를 확인하세요. 촬영일 범위는 시작일과 마지막 날짜를 올바른 순서로 입력해야 합니다.
          </p>
        ) : null}
        <button type="submit" disabled={!query.success}>
          필터 적용
        </button>
      </fieldset>
    </form>
  );
}

/** The owning workspace supplies exactly one grid for the validated current page. */
export function GalleryNavigationResultFrame({
  filters,
  limit,
  result,
  actions,
  children,
}: GalleryNavigationResultFrameProps) {
  const query = galleryMediaNavigationQueryV2Schema.safeParse({
    filters,
    limit,
    sort: 'created_desc_id_asc',
    cursor: null,
  });
  const loading = result.state === 'loading';
  const unavailable = actions === null || result.state === 'unavailable';
  const page = result.state === 'ready' ? result.page : null;
  const applied =
    query.success &&
    page !== null &&
    JSON.stringify(query.data.filters) === JSON.stringify(page.query.filters) &&
    query.data.limit === page.query.limit;
  return (
    <section className={styles.navigation} aria-label="갤러리 탐색 결과" aria-busy={loading}>
      {unavailable ? (
        <p role="status">이 환경에서는 갤러리 탐색 연결을 사용할 수 없습니다.</p>
      ) : null}
      {loading ? <p role="status">사진·동영상을 불러오는 중입니다.</p> : null}
      {result.state === 'error' || result.state === 'conflict' ? (
        <div role="alert">
          <p>
            {result.state === 'conflict'
              ? '목록이 변경되어 이 페이지를 계속 탐색할 수 없습니다. 처음부터 다시 불러오세요.'
              : '목록을 불러오지 못했습니다. 다시 시도하세요.'}
          </p>
          <button type="button" disabled={unavailable} onClick={() => actions?.reload()}>
            처음부터 다시 불러오기
          </button>
        </div>
      ) : null}
      {page !== null ? (
        <>
          <p role="status">
            이 페이지에 {page.items.length}개
            {page.hasMore ? ' · 다음 페이지 있음' : ' · 마지막 페이지'}
          </p>
          {page.items.length === 0 ? <p>조건에 맞는 사진·동영상이 없습니다.</p> : children}
          {actions !== null && actions.openMedia === null ? (
            <p>이 환경에서는 미디어 열기를 사용할 수 없습니다.</p>
          ) : null}
          {!applied ? <p>변경한 필터를 적용하면 처음 페이지부터 탐색합니다.</p> : null}
          <button
            type="button"
            disabled={unavailable || loading || !applied || page.nextCursor === null}
            onClick={() => {
              if (applied && !unavailable && !loading && page.nextCursor !== null)
                actions?.navigate({ ...page.query, cursor: page.nextCursor });
            }}
          >
            다음 페이지
          </button>
        </>
      ) : null}
    </section>
  );
}

function GalleryNavigationItems({
  result,
  albums,
  actions,
}: Pick<GalleryNavigationProps, 'result' | 'albums' | 'actions'>) {
  const page = result.state === 'ready' ? result.page : null;
  const unavailable = actions === null || result.state === 'unavailable';
  if (page === null) return null;
  return (
    <ul className={styles.items}>
      {page.items.map(({ item, capturedDay, albumMembership, courseLink, courseAvailability }) => (
        <li key={item.id}>
          <button
            type="button"
            disabled={unavailable || actions?.openMedia === null}
            onClick={() => actions?.openMedia?.(item.id)}
          >
            {item.caption ?? item.file.originalFileName}
          </button>
          <span>{capturedDay.state === 'known' ? capturedDay.localDate : '촬영일 알 수 없음'}</span>
          <span>
            {item.capturedAt === null ? '촬영 시각 알 수 없음' : '촬영 시각 저장됨'} · 촬영 시간대
            정보 없음
          </span>
          <span>
            {albumMembership === null
              ? '앨범 미지정'
              : (albums.find((a) => a.id === albumMembership.albumId)?.title ?? '앨범 정보 없음')}
          </span>
          <span>
            {courseLink === null
              ? '코스 연결 없음'
              : `저장된 코스 리비전 ${courseLink.courseRevision}`}
          </span>
          {courseAvailability?.state === 'unavailable' ? <span>사용 불가</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** Backward-compatible composition with the original default result rows. */
export function GalleryNavigation(props: GalleryNavigationProps) {
  return (
    <section
      className={styles.navigation}
      aria-label="갤러리 탐색"
      aria-busy={props.result.state === 'loading'}
    >
      <GalleryNavigationControls {...props} />
      <GalleryNavigationResultFrame
        filters={props.filters}
        limit={props.limit}
        result={props.result}
        actions={props.actions}
      >
        <GalleryNavigationItems
          result={props.result}
          albums={props.albums}
          actions={props.actions}
        />
      </GalleryNavigationResultFrame>
    </section>
  );
}
