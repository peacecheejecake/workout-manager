'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import type { CourseElevationResult } from '@workout/contracts/geo-data';
import { Button } from '@workout/ui-foundation/button';

import type { ComputedDraftRoute } from './course-draft';
import type { CourseExtrasApi } from './course-extras-api';
import styles from './course-route-elevation.module.css';

/**
 * S14 "고도/거리 확인" before saving (M2-01k-b).
 *
 * The order S14 names is search → points → foot routing → elevation/distance check → save.
 * The distance half is the engine's own estimate, which the review summary already shows.
 * This is the elevation half, for a line that is **not saved yet**: a route preview on an
 * empty map or a stored proposal under review. It asks our own elevation dataset about that
 * exact line and shows what it answered, and until it has answered the review cannot be
 * finished — the save stays unreachable while the check is still out.
 *
 * Three rules, because the dataset is sparse by nature:
 *
 * 1. **A gap is not a zero.** A sample with no elevation fact is drawn as a marked gap and
 *    listed as "모름". It is never plotted at 0 m, never joined to its neighbours by a line
 *    and never filled in between two known samples.
 * 2. **No dataset is a state, not a flat line.** Without a deployed dataset the check says
 *    so in words and draws nothing: an empty chart would read as "flat".
 * 3. **The answer belongs to one line.** It is keyed to the proposal and draft it was asked
 *    for, and a profile whose vertex count is not the line's is refused rather than shown.
 */
export type RouteElevationSource = Pick<CourseExtrasApi, 'elevationProfile'>;

type Settled =
  | { readonly status: 'answered'; readonly result: CourseElevationResult }
  | { readonly status: 'failed'; readonly reason: 'request' | 'mismatch' };

export type RouteElevationState = { readonly status: 'pending' } | Settled;

export interface RouteElevationCheck {
  /** `null` when there is no route to check. */
  readonly state: RouteElevationState | null;
  /**
   * True once the check for the route on screen has an answer to show, whatever it is.
   *
   * Deliberately including a failure and a refused (mismatched) answer: the gate is that the
   * owner has **seen** the elevation state of this line before saving, not that the data is
   * good. A broken or undeployed elevation endpoint must not block saving a course forever;
   * instead the screen says the elevation is unknown, never flat or zero. A retry puts the
   * check back to pending, and the save is shut again until the retry has answered.
   */
  readonly settled: boolean;
  readonly retry: () => void;
}

/**
 * Ask about the route on screen, once per proposal, draft and attempt.
 *
 * Nothing is written into state while a request is out: "pending" is derived from the
 * absence of an answer for the current key, so a late answer for an earlier line — or for
 * an attempt the owner already retried — can never stand in for the current one.
 */
export function useRouteElevationCheck(
  source: RouteElevationSource,
  route: ComputedDraftRoute | null,
): RouteElevationCheck {
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<{ readonly key: string; readonly settled: Settled } | null>(
    null,
  );
  const key = route === null ? null : `${route.proposalId}:${route.draftRevision}:${attempt}`;
  const coordinates = route?.coordinates ?? null;

  useEffect(() => {
    if (key === null || coordinates === null) return;
    const controller = new AbortController();
    source
      .elevationProfile(
        {
          geometry: {
            type: 'LineString',
            coordinates: coordinates.map((position) => [position[0], position[1]]),
          },
        },
        controller.signal,
      )
      .then(
        (result) => {
          if (controller.signal.aborted) return;
          // A profile of some other line is not this line's profile.
          if (result.outcome === 'profile' && result.vertexCount !== coordinates.length)
            setAnswer({ key, settled: { status: 'failed', reason: 'mismatch' } });
          else setAnswer({ key, settled: { status: 'answered', result } });
        },
        () => {
          if (controller.signal.aborted) return;
          setAnswer({ key, settled: { status: 'failed', reason: 'request' } });
        },
      );
    return () => controller.abort();
  }, [source, key, coordinates]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  if (key === null) return { state: null, settled: false, retry };
  const current = answer !== null && answer.key === key ? answer.settled : null;
  return {
    state: current ?? { status: 'pending' },
    settled: current !== null,
    retry,
  };
}

type Profile = Extract<CourseElevationResult, { outcome: 'profile' }>;

function datasetNote(dataset: Profile['dataset']): string {
  return `${dataset.attribution} · 데이터 ${dataset.datasetId} · 갱신 주기 ${dataset.updateCadence}`;
}

/** The elevation half of the check, as the review shows it. */
export function RouteElevationProfile({ check }: { readonly check: RouteElevationCheck }) {
  const state = check.state;
  if (state === null) return null;
  const outcome =
    state.status === 'answered'
      ? state.result.outcome
      : state.status === 'failed'
        ? 'failed'
        : 'pending';
  return (
    <section
      className={styles.check}
      aria-label="고도 확인"
      data-testid="route-elevation"
      data-outcome={outcome}
    >
      <h5 className={styles.heading}>고도 확인</h5>
      {state.status === 'pending' ? (
        <p role="status">
          고도를 확인하는 중입니다. 확인이 끝나야 검토를 마치고 저장할 수 있습니다.
        </p>
      ) : null}
      {state.status === 'failed' ? (
        <>
          <p role="alert">
            {state.reason === 'mismatch'
              ? '받은 고도가 검토 중인 경로의 것이 아니어서 쓰지 않았습니다.'
              : '고도를 확인하지 못했습니다.'}{' '}
            이 경로의 고도는 <strong>모름</strong>이며, 평지나 0m가 아닙니다.
          </p>
          <Button variant="secondary" onClick={check.retry}>
            고도 다시 확인
          </Button>
        </>
      ) : null}
      {state.status === 'answered' && state.result.outcome === 'no_dataset' ? (
        <p data-testid="route-elevation-unavailable">
          이 서버에는 고도 데이터가 배포되어 있지 않습니다. 이 경로의 고도는{' '}
          <strong>확인되지 않음</strong>이며, 평지나 0m로 보지 않고 추정하지도 않습니다.
        </p>
      ) : null}
      {state.status === 'answered' && state.result.outcome === 'outside_region' ? (
        <p data-testid="route-elevation-unavailable">
          이 경로는 고도 데이터 범위({state.result.dataset.region}) 밖입니다. 고도는{' '}
          <strong>확인되지 않음</strong>이며, 평지나 0m로 보지 않습니다.
        </p>
      ) : null}
      {state.status === 'answered' && state.result.outcome === 'profile' ? (
        <ProfileView profile={state.result} />
      ) : null}
    </section>
  );
}

interface Gap {
  /** Profile index of the known sample before the gap, or `null` at the start. */
  readonly before: number | null;
  /** Profile index of the known sample after the gap, or `null` at the end. */
  readonly after: number | null;
  readonly samples: number;
}

/**
 * Runs of known samples and the gaps between them. Two known samples are joined only when
 * they are neighbours in the profile; anything with an unknown sample between them is a gap.
 */
export interface KnownSample {
  /** Index into the profile's points. */
  readonly index: number;
  readonly elevationMeters: number;
}

export function elevationRuns(points: Profile['points']): {
  readonly runs: readonly (readonly KnownSample[])[];
  readonly gaps: readonly Gap[];
} {
  const runs: KnownSample[][] = [];
  const gaps: Gap[] = [];
  let run: KnownSample[] | null = null;
  let gapStart: number | null = null;
  let lastKnown: number | null = null;
  points.forEach((point, index) => {
    if (point.elevationMeters === null) {
      if (run !== null) {
        runs.push(run);
        run = null;
      }
      if (gapStart === null) gapStart = index;
      return;
    }
    if (gapStart !== null) {
      gaps.push({ before: lastKnown, after: index, samples: index - gapStart });
      gapStart = null;
    }
    if (run === null) run = [];
    run.push({ index, elevationMeters: point.elevationMeters });
    lastKnown = index;
  });
  if (run !== null) runs.push(run);
  if (gapStart !== null)
    gaps.push({ before: lastKnown, after: null, samples: points.length - gapStart });
  return { runs, gaps };
}

const WIDTH = 320;
const HEIGHT = 120;
const PAD_X = 8;
const PAD_Y = 14;

function ProfileView({ profile }: { readonly profile: Profile }) {
  // A fragment reference must be a plain name; React's generated ids may carry punctuation.
  const hatchId = `route-elevation-gap-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  const points = profile.points;
  const known = points.flatMap((point) =>
    point.elevationMeters === null ? [] : [point.elevationMeters],
  );
  const unknown = points.length - known.length;
  const { runs, gaps } = elevationRuns(points);
  const lowest = known.length > 0 ? Math.min(...known) : null;
  const highest = known.length > 0 ? Math.max(...known) : null;
  const span = profile.vertexCount > 1 ? profile.vertexCount - 1 : 1;
  const x = (index: number) => {
    const point = points[index];
    return PAD_X + ((point?.vertexIndex ?? 0) / span) * (WIDTH - 2 * PAD_X);
  };
  const y = (value: number) => {
    if (lowest === null || highest === null || highest === lowest) return HEIGHT / 2;
    return PAD_Y + ((highest - value) / (highest - lowest)) * (HEIGHT - 2 * PAD_Y);
  };
  // The range of the KNOWN samples only, said as such: it is not the line's lowest or highest.
  const range =
    lowest === null || highest === null ? '' : `, 값 있는 표본의 최저 ${lowest}m·최고 ${highest}m`;
  const summary = `고도 표본 ${points.length}곳 중 값 있음 ${known.length}곳, 모름 ${unknown}곳(모름 구간 ${gaps.length}개)${range}`;
  return (
    <>
      <dl className={styles.summary}>
        <dt>값이 있는 표본</dt>
        <dd data-testid="route-elevation-known">
          {profile.knownCount} / {points.length}
        </dd>
        <dt>고도 모름 표본</dt>
        <dd data-testid="route-elevation-unknown">{unknown}</dd>
        <dt>고도 모름 구간</dt>
        <dd data-testid="route-elevation-gaps">{gaps.length}</dd>
        <dt>경로 정점</dt>
        <dd>{profile.vertexCount}</dd>
      </dl>
      <svg
        className={styles.chart}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={summary}
        data-testid="route-elevation-chart"
      >
        <defs>
          <pattern
            id={hatchId}
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <line x1="0" y1="0" x2="0" y2="6" className={styles.hatch} />
          </pattern>
        </defs>
        {gaps.map((gap, index) => {
          const from = gap.before === null ? 0 : x(gap.before);
          const to = gap.after === null ? WIDTH : x(gap.after);
          return (
            <rect
              key={`gap-${index}`}
              data-testid="route-elevation-gap"
              x={from}
              y={0}
              width={Math.max(to - from, 2)}
              height={HEIGHT}
              className={styles.gap}
              fill={`url(#${hatchId})`}
            >
              <title>{`고도 모름: 표본 ${gap.samples}곳`}</title>
            </rect>
          );
        })}
        {runs
          .filter((run) => run.length > 1)
          .map((run) => (
            <polyline
              key={`run-${run[0]?.index ?? 0}`}
              data-testid="route-elevation-run"
              className={styles.line}
              points={run
                .map((sample) => `${x(sample.index)},${y(sample.elevationMeters)}`)
                .join(' ')}
            />
          ))}
        {points.map((point, index) =>
          point.elevationMeters === null ? null : (
            <circle
              key={`point-${point.vertexIndex}`}
              data-testid="route-elevation-point"
              data-elevation={point.elevationMeters}
              className={styles.point}
              cx={x(index)}
              cy={y(point.elevationMeters)}
              r={3}
            />
          ),
        )}
        {highest !== null && lowest !== null ? (
          <>
            <text x={PAD_X} y={PAD_Y - 3} className={styles.axis}>
              {`${Math.round(highest)}m`}
            </text>
            {highest !== lowest ? (
              <text x={PAD_X} y={HEIGHT - 2} className={styles.axis}>
                {`${Math.round(lowest)}m`}
              </text>
            ) : null}
          </>
        ) : null}
      </svg>
      {known.length === 0 ? (
        <p role="status">
          이 경로의 표본 어디에도 고도 값이 없습니다. 고도는 <strong>모름</strong>이며 평지가
          아닙니다.
        </p>
      ) : null}
      <p className={styles.note}>
        빗금 구간은 {Math.round(profile.maxSourceDistanceMeters)}m 안에 고도 값이 없는 곳입니다.
        0m가 아니라 <strong>모름</strong>이며, 사이를 잇거나 채우지 않고 누적 상승도 계산하지
        않습니다. {datasetNote(profile.dataset)}.
      </p>
      <details className={styles.samples}>
        <summary>표본별 고도 ({points.length}곳)</summary>
        <ol aria-label="고도 표본">
          {points.map((point) => (
            <li
              key={point.vertexIndex}
              data-testid="route-elevation-sample"
              data-known={point.elevationMeters === null ? 'false' : 'true'}
            >
              정점 {point.vertexIndex + 1}:{' '}
              {point.elevationMeters === null
                ? `모름 (${Math.round(profile.maxSourceDistanceMeters)}m 안에 값 없음)`
                : `${point.elevationMeters}m (가장 가까운 값까지 ${Math.round(point.sourceDistanceMeters ?? 0)}m)`}
            </li>
          ))}
        </ol>
      </details>
    </>
  );
}
