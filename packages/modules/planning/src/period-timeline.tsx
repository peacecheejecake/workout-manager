import type { CSSProperties } from 'react';
import styles from './period-timeline.module.css';
type PeriodBarStyle = CSSProperties & { '--period-start': string; '--period-width': string };
export interface TimelineSegment {
  id: string;
  label: string;
  number: number;
  startFraction: number;
  endFraction: number;
  days: number;
  partial: boolean;
}

function barStyle(segment: TimelineSegment): PeriodBarStyle {
  return {
    '--period-start': `${segment.startFraction * 100}%`,
    '--period-width': `${(segment.endFraction - segment.startFraction) * 100}%`,
  };
}
export interface PeriodTimelineProps {
  segments: TimelineSegment[];
  startDate: string | null;
  endDateExclusive: string | null;
  onSelect(id: string): void;
  onPreview(id: string | null, source: 'focus' | 'hover'): void;
}
export function PeriodTimeline({
  segments,
  startDate,
  endDateExclusive,
  onSelect,
  onPreview,
}: PeriodTimelineProps) {
  return (
    <section className={styles.timeline} aria-label="기간 날짜 길이 타임라인">
      <h3>날짜 길이 타임라인</h3>
      {startDate && endDateExclusive ? (
        <p>
          {startDate}부터 {endDateExclusive} 미포함
        </p>
      ) : (
        <p>표시할 날짜 범위가 없습니다.</p>
      )}
      <p>
        막대의 시작과 길이는 날짜 범위입니다. 빈 구간은 자식 기간 미배정이며 훈련량·수행률이
        아닙니다.
      </p>
      <ol className={styles.rows}>
        {segments.map((segment) => (
          <li key={segment.id}>
            <button
              type="button"
              className={styles.row}
              aria-label={`기간 타임라인: ${segment.label}`}
              onClick={() => onSelect(segment.id)}
              onFocus={() => onPreview(segment.id, 'focus')}
              onBlur={() => onPreview(null, 'focus')}
              onMouseEnter={() => onPreview(segment.id, 'hover')}
              onMouseLeave={() => onPreview(null, 'hover')}
            >
              <span>
                {segment.number}. {segment.label} · {segment.days}일
                {segment.partial ? ' · 부분 기간' : ''}
              </span>
              <span className={styles.track} aria-hidden="true">
                <span
                  className={styles.bar}
                  data-period-bar={segment.id}
                  style={barStyle(segment)}
                />
              </span>
            </button>
          </li>
        ))}
      </ol>
      {!segments.length ? (
        <p>하위 기간이 없어 표시할 막대가 없습니다.</p>
      ) : (
        <p>짧은 막대도 행 전체 또는 동일한 기간 목록에서 선택할 수 있습니다.</p>
      )}
    </section>
  );
}
