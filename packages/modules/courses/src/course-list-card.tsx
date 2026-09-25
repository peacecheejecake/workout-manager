'use client';

import type {
  CourseCard,
  CourseCardDistance,
  CourseCardElevation,
  CourseCardSurface,
} from '@workout/contracts/course-cards';
import { CourseThumbnail, StoredCourseThumbnail } from './course-thumbnail';
import styles from './course-list-card.module.css';

/**
 * The facts of one S13 list card (M2-01k-a; 01 §9: "S13 코스 카드에 지도 썸네일, 실제/추정 거리,
 * 고도 데이터 출처, 노면 정보의 확인 상태, 접근성 메모, 마지막 사용을 표시한다").
 *
 * Everything shown is what the server said (`GET /courses/cards`) or what the owner's own
 * preferences say (the last-used moment). Nothing is inferred here, and every fact has an
 * explicit "not known" wording rather than a blank or a zero:
 *
 * - the card read still loading or failed says so for every fact it would have carried;
 * - an estimated distance is never called actual, and a line read from a file is neither;
 * - an elevation dataset that is not deployed is "없음", never an empty profile;
 * - surface has no source in this build, so it is "확인되지 않음" — not "확인됨", not blank;
 * - a preference read that failed is "확인하지 못함", not "사용 기록 없음".
 *
 * It renders no list items and no alerts of its own: it sits inside the list row the
 * workbench already owns, so the row stays one `li` and the screen's alerts stay the
 * screen's.
 */
export type CourseCardRead =
  | { readonly status: 'pending' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly card: CourseCard | undefined };

export type CourseLastUsedRead =
  | { readonly status: 'pending' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly lastUsedAt: string | null };

export interface CourseListCardFactsProps {
  readonly courseName: string;
  readonly sessionId: string;
  readonly read: CourseCardRead;
  readonly lastUsed: CourseLastUsedRead;
}

function metres(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)}km` : `${Math.round(value)}m`;
}

/** The planned line, and what that line is: actual, estimated, or neither. */
export function courseCardDistanceText(distance: CourseCardDistance): string {
  const planned = `계획 거리 ${metres(distance.plannedLineMeters)}`;
  const trimmed = distance.privacyTrimmed ? ' · 보호 구역 제거 후' : '';
  switch (distance.basis.kind) {
    case 'recorded':
      return `${planned} · 실제 기록 구간의 거리(지도 단순화 선 기준)${trimmed}`;
    case 'engine-estimate':
      return distance.basis.engineDistanceMeters === null
        ? `${planned} · 경로 엔진 추정 선(제거 후 엔진 추정치 없음)${trimmed}`
        : `${planned} · 추정 거리(경로 엔진 ${metres(distance.basis.engineDistanceMeters)})${trimmed}`;
    case 'imported-file':
      return `${planned} · 가져온 파일의 선, 실제/추정 확인되지 않음${trimmed}`;
    case 'unknown':
      return `${planned} · 실제/추정 확인되지 않음${trimmed}`;
  }
}

/** Which dataset answered and for how much of the course, or that there is none. */
export function courseCardElevationText(elevation: CourseCardElevation): string {
  switch (elevation.status) {
    case 'not_deployed':
      return '없음 · 이 서버에 고도 데이터 미배포, 추정하지 않음';
    case 'outside_region':
      return `${elevation.dataset.attribution}, 데이터셋 ${elevation.dataset.datasetId} · 이 코스는 ${elevation.dataset.region} 범위 밖이라 값 없음`;
    case 'sampled':
      return `${elevation.dataset.attribution}, 데이터셋 ${elevation.dataset.datasetId} · 표본 ${elevation.sampledCount}곳 중 ${elevation.knownCount}곳 값 있음, 나머지는 모름`;
  }
}

/** The contract admits exactly one value today: there is no surface source in this build. */
export function courseCardSurfaceText(surface: CourseCardSurface): string {
  switch (surface.confirmation) {
    case 'unknown':
      return '확인되지 않음 · 통행 가능 여부·안전을 뜻하지 않음';
  }
}

function lastUsedText(lastUsed: CourseLastUsedRead): string {
  if (lastUsed.status === 'pending') return '마지막 사용 확인 중';
  if (lastUsed.status === 'error') return '마지막 사용 확인하지 못함';
  if (lastUsed.lastUsedAt === null) return '사용 기록 없음';
  return `마지막 사용 ${new Date(lastUsed.lastUsedAt).toLocaleDateString('ko-KR')}`;
}

export function CourseListCardFacts({
  courseName,
  sessionId,
  read,
  lastUsed,
}: CourseListCardFactsProps) {
  const card = read.status === 'ready' ? read.card : undefined;
  const available = card?.status === 'available' ? card : null;
  // One wording for every fact the card read would have carried but did not.
  const missing =
    read.status === 'pending'
      ? '확인 중'
      : read.status === 'error'
        ? '불러오지 못함'
        : card?.status === 'unavailable'
          ? '원본 기록 삭제로 없음'
          : '확인되지 않음';
  const thumbnailLabel = available
    ? `${courseName} 목록 미리보기 (수정 번호 ${available.course.headRevision})`
    : '';
  return (
    <div className={styles.card} data-testid="course-card" data-card-status={read.status}>
      <div
        className={styles.thumbnailBox}
        data-thumbnail-state={available ? available.thumbnail.state.status : 'none'}
      >
        {available === null ? (
          <span className={styles.noThumbnail} data-testid="course-card-thumbnail-missing">
            미리보기 {missing}
          </span>
        ) : available.thumbnail.state.status === 'ready' ? (
          <StoredCourseThumbnail
            courseId={available.course.courseId}
            sessionId={sessionId}
            contentHash={available.thumbnail.state.contentHash}
            coordinates={available.thumbnail.drawnVertices}
            label={thumbnailLabel}
            testId="course-card-thumbnail"
          />
        ) : (
          <CourseThumbnail
            coordinates={available.thumbnail.drawnVertices}
            label={thumbnailLabel}
            testId="course-card-thumbnail"
          />
        )}
      </div>
      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt>거리</dt>
          <dd
            data-testid="course-card-distance"
            data-basis={available ? available.distance.basis.kind : 'none'}
          >
            {available ? courseCardDistanceText(available.distance) : missing}
          </dd>
        </div>
        <div className={styles.fact}>
          <dt>고도 출처</dt>
          <dd
            data-testid="course-card-elevation"
            data-status={available ? available.elevation.status : 'none'}
          >
            {available ? courseCardElevationText(available.elevation) : missing}
          </dd>
        </div>
        <div className={styles.fact}>
          <dt>노면</dt>
          <dd
            data-testid="course-card-surface"
            data-confirmation={available ? available.surface.confirmation : 'none'}
          >
            {available ? courseCardSurfaceText(available.surface) : missing}
          </dd>
        </div>
        <div className={styles.fact}>
          <dt>사용</dt>
          <dd data-testid="course-card-last-used">{lastUsedText(lastUsed)}</dd>
        </div>
      </dl>
    </div>
  );
}
