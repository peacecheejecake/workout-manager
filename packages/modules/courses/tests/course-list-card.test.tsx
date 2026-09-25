import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { courseCardSchema, type CourseCard } from '@workout/contracts/course-cards';

import {
  CourseListCardFacts,
  courseCardDistanceText,
  courseCardElevationText,
  type CourseCardRead,
  type CourseLastUsedRead,
} from '../src/course-list-card';

/**
 * One S13 list card (M2-01k-a), rendered from a card the contract accepts.
 *
 * Each fact has a "not known" wording and these tests pin it: estimated is never called
 * actual, a missing elevation dataset is "없음", surface is never shown as confirmed, and a
 * failed read is not the same thing as "never used".
 */
const courseId = '11111111-1111-4111-8111-111111111111';
const createdAt = '2026-03-01T00:00:00.000Z';
const dataset = {
  kind: 'elevation' as const,
  datasetId: 'beef0123cafe',
  datasetVersion: 1 as const,
  region: 'Seoul',
  sourceExtractSha256: 'a'.repeat(64),
  licence: 'ODbL-1.0',
  licenceUrl: 'https://www.openstreetmap.org/copyright',
  attribution: '© OpenStreetMap contributors',
  updateCadence: '월 1회',
  builtAt: createdAt,
  featureCount: 1,
  bbox: [126.734, 37.413, 127.269, 37.715] as [number, number, number, number],
};

function card(overrides: Partial<Extract<CourseCard, { status: 'available' }>> = {}): CourseCard {
  return courseCardSchema.parse({
    status: 'available',
    course: {
      status: 'available',
      courseId,
      name: '한강 한 바퀴',
      visibility: 'private',
      headRevision: 3,
      revisionId: '55555555-5555-4555-8555-555555555555',
      createdAt,
      updatedAt: createdAt,
    },
    distance: { plannedLineMeters: 1830.5, basis: { kind: 'recorded' }, privacyTrimmed: false },
    thumbnail: {
      state: { status: 'none' },
      drawnVertices: [
        [126.9779, 37.5665],
        [126.9799, 37.5671],
      ],
    },
    elevation: {
      status: 'sampled',
      dataset,
      sampledCount: 2,
      knownCount: 1,
      maxSourceDistanceMeters: 150,
    },
    surface: { confirmation: 'unknown' },
    ...overrides,
  });
}

function show(
  read: CourseCardRead,
  lastUsed: CourseLastUsedRead = { status: 'ready', lastUsedAt: null },
) {
  render(
    <CourseListCardFacts
      courseName="한강 한 바퀴"
      sessionId="session-1"
      read={read}
      lastUsed={lastUsed}
    />,
  );
}

describe('course list card', () => {
  it('shows the picture, the actual distance, the elevation source, the surface and use', () => {
    show(
      { status: 'ready', card: card() },
      { status: 'ready', lastUsedAt: '2026-09-20T03:00:00Z' },
    );
    const thumbnail = screen.getByTestId('course-card-thumbnail');
    expect(thumbnail).toHaveAttribute('data-source', 'drawn');
    expect(thumbnail).toHaveAccessibleName('한강 한 바퀴 목록 미리보기 (수정 번호 3)');
    expect(screen.getByTestId('course-card-distance')).toHaveTextContent(
      '계획 거리 1.83km · 실제 기록 구간의 거리(지도 단순화 선 기준)',
    );
    expect(screen.getByTestId('course-card-elevation')).toHaveTextContent(
      '© OpenStreetMap contributors, 데이터셋 beef0123cafe · 표본 2곳 중 1곳 값 있음, 나머지는 모름',
    );
    expect(screen.getByTestId('course-card-surface')).toHaveTextContent('확인되지 않음');
    expect(screen.getByTestId('course-card-last-used')).toHaveTextContent(
      `마지막 사용 ${new Date('2026-09-20T03:00:00Z').toLocaleDateString('ko-KR')}`,
    );
  });

  it('calls an engine line an estimate and never actual', () => {
    const text = courseCardDistanceText({
      plannedLineMeters: 1830.5,
      basis: { kind: 'engine-estimate', engineDistanceMeters: 1912.4, graphBuildId: null },
      privacyTrimmed: false,
    });
    expect(text).toBe('계획 거리 1.83km · 추정 거리(경로 엔진 1.91km)');
    expect(text).not.toContain('실제');
    expect(
      courseCardDistanceText({
        plannedLineMeters: 640,
        basis: { kind: 'imported-file', sourceKind: 'gpx-rte' },
        privacyTrimmed: true,
      }),
    ).toBe('계획 거리 640m · 가져온 파일의 선, 실제/추정 확인되지 않음 · 보호 구역 제거 후');
  });

  it('says 없음 when no elevation dataset is deployed, and names the region when outside it', () => {
    show({ status: 'ready', card: card({ elevation: { status: 'not_deployed' } }) });
    const elevation = screen.getByTestId('course-card-elevation');
    expect(elevation).toHaveAttribute('data-status', 'not_deployed');
    expect(elevation.textContent?.startsWith('없음')).toBe(true);
    expect(elevation).not.toHaveTextContent('데이터셋');
    expect(courseCardElevationText({ status: 'outside_region', dataset })).toContain(
      'Seoul 범위 밖',
    );
  });

  it('keeps every fact unknown while the card read is loading or failed', () => {
    show({ status: 'error' }, { status: 'error' });
    for (const id of ['course-card-distance', 'course-card-elevation', 'course-card-surface'])
      expect(screen.getByTestId(id)).toHaveTextContent('불러오지 못함');
    expect(screen.getByTestId('course-card-thumbnail-missing')).toHaveTextContent('불러오지 못함');
    // A failed preference read is not "never used".
    expect(screen.getByTestId('course-card-last-used')).toHaveTextContent(
      '마지막 사용 확인하지 못함',
    );
    expect(screen.queryByText(/사용 기록 없음/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says so for a course the server did not card, rather than showing zeros', () => {
    show({ status: 'ready', card: undefined }, { status: 'pending' });
    expect(screen.getByTestId('course-card-distance')).toHaveTextContent('확인되지 않음');
    expect(screen.getByTestId('course-card-distance')).not.toHaveTextContent(/\d/);
    expect(screen.getByTestId('course-card-last-used')).toHaveTextContent('마지막 사용 확인 중');
  });
});
