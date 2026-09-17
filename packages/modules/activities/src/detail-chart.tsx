import type { ActivityRecord } from '@workout/contracts/activity-details';
import { chartSegments, recordInRange, type TimeRange } from './detail-projection';
import styles from './activity-workbench.module.css';

export function DetailChart({
  records,
  metric,
  selected,
  range,
  onSelect,
}: {
  records: ActivityRecord[];
  metric: 'distanceMeters' | 'heartRateBpm';
  selected: number | null;
  range: TimeRange | null;
  onSelect(index: number, time: number): void;
}) {
  const segments = chartSegments(records, metric);
  const points = segments.flat();
  const label = metric === 'distanceMeters' ? '원본 거리 (m)' : '원본 심박 (bpm)';
  if (!points.length) return <p>{label}: 표시할 시각·측정값이 없습니다.</p>;
  const times = points.map((point) => point.time);
  const values = points.map((point) => point.value);
  const minTime = Math.min(...times),
    maxTime = Math.max(...times);
  const maxValue = Math.max(1, ...values);
  const x = (time: number) => 35 + ((time - minTime) / (maxTime - minTime || 1)) * 630;
  const y = (value: number) => 155 - (value / maxValue) * 125;
  return (
    <figure className={styles.figure}>
      <figcaption>
        {label} · 가로축 관측 시각 UTC · 세로축 {metric === 'distanceMeters' ? 'm' : 'bpm'}
      </figcaption>
      <svg viewBox="0 0 700 190" role="img" aria-label={`${label} 차트`}>
        <text x="2" y="25">
          {maxValue}
        </text>
        <text x="5" y="160">
          0
        </text>
        {segments.map((segment, index) => (
          <polyline
            key={index}
            fill="none"
            className={styles.line}
            points={segment.map((point) => `${x(point.time)},${y(point.value)}`).join(' ')}
          />
        ))}
        {points.map((point) => (
          <circle
            key={point.index}
            cx={x(point.time)}
            cy={y(point.value)}
            r={selected === point.index ? 6 : 3}
            className={styles.point}
            data-selected={selected === point.index}
            data-in-range={
              range !== null &&
              recordInRange(
                {
                  index: point.index,
                  timestamp: new Date(point.time).toISOString(),
                  distanceMeters: null,
                  heartRateBpm: null,
                },
                range,
              )
            }
            role="button"
            tabIndex={-1}
            aria-label={`차트 관측 ${point.index} 선택`}
            onClick={() => onSelect(point.index, point.time)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(point.index, point.time);
              }
            }}
          >
            <title>
              관측 {point.index} · {new Date(point.time).toISOString()} · {point.value}
            </title>
          </circle>
        ))}
        <text x="35" y="185">
          {new Date(minTime).toISOString()}
        </text>
      </svg>
      <p>
        종료 시각 {new Date(maxTime).toISOString()}. 정확한 값과 키보드 선택은 관측 표·선택 버튼을
        사용하세요.
      </p>
    </figure>
  );
}
