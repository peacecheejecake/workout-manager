import type { ActivityLap } from '@workout/contracts/activity-details';
import { Button } from '@workout/ui-foundation/button';
import { lapOverlapsRange, lapTimeRange, type TimeRange } from './detail-projection';
import styles from './activity-workbench.module.css';

const metric = (value: number | null, unit: string) =>
  value === null ? '미확인' : `${value} ${unit}`;
const time = (value: string | null) =>
  value === null ? '시각 미확인' : new Date(value).toISOString();

/**
 * The source laps, linked to the shared selection.
 *
 * One table for the interval workbench and the route tab, so a lap is selected and a range
 * is matched against laps in exactly one way. A row is highlighted when its own
 * start + elapsed interval overlaps the selected range (endpoints included); a lap with no
 * start or no elapsed time has no interval and is never highlighted by a range. The match is
 * also written in the row, so it does not depend on colour.
 */
export function LapTable({
  caption,
  laps,
  lapIndex,
  range,
  onSelectLap,
}: {
  readonly caption: string;
  readonly laps: readonly ActivityLap[];
  readonly lapIndex: number | null;
  readonly range: TimeRange | null;
  readonly onSelectLap: (index: number, range: TimeRange | null) => void;
}) {
  return (
    <table className={styles.table}>
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th>선택·원본 순번</th>
          <th>선택 구간</th>
          <th>시작 UTC</th>
          <th>작성 UTC</th>
          <th>경과 시간</th>
          <th>타이머 시간</th>
          <th>거리</th>
          <th>평균 심박</th>
          <th>최대 심박</th>
        </tr>
      </thead>
      <tbody>
        {laps.map((lap) => {
          const inRange = range !== null && lapOverlapsRange(lap, range);
          return (
            <tr key={lap.index} data-selected={lapIndex === lap.index} data-in-range={inRange}>
              <td>
                <Button
                  variant="secondary"
                  aria-pressed={lapIndex === lap.index}
                  onClick={() => onSelectLap(lap.index, lapTimeRange(lap))}
                >
                  랩 {lap.index} 선택
                </Button>
              </td>
              <td>{inRange ? '겹침' : '—'}</td>
              <td>{time(lap.startedAt)}</td>
              <td>{time(lap.recordedAt)}</td>
              <td>{metric(lap.elapsedSeconds, '초')}</td>
              <td>{metric(lap.timerSeconds, '초')}</td>
              <td>{metric(lap.distanceMeters, 'm')}</td>
              <td>{metric(lap.averageHeartRateBpm, 'bpm')}</td>
              <td>{metric(lap.maximumHeartRateBpm, 'bpm')}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
