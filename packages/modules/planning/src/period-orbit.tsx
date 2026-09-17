import styles from './period-explorer.module.css';
export interface OrbitSegment {
  id: string;
  label: string;
  number: number;
  startFraction: number;
  endFraction: number;
  days: number;
}
function point(fraction: number, radius = 112) {
  const angle = fraction * Math.PI * 2 - Math.PI / 2;
  return { x: 160 + radius * Math.cos(angle), y: 160 + radius * Math.sin(angle) };
}
function arc(start: number, end: number) {
  const a = point(start),
    b = point(end),
    span = end - start;
  if (span >= 1) {
    const mid = point(start + 0.5);
    return `M ${a.x} ${a.y} A 112 112 0 1 1 ${mid.x} ${mid.y} A 112 112 0 1 1 ${a.x} ${a.y}`;
  }
  return `M ${a.x} ${a.y} A 112 112 0 ${span > 0.5 ? 1 : 0} 1 ${b.x} ${b.y}`;
}
export interface PeriodOrbitProps {
  segments: OrbitSegment[];
  centerLabel: string;
  onSelect(id: string): void;
  onPreview(id: string | null, source: 'focus' | 'hover'): void;
}
export function PeriodOrbit({ segments, centerLabel, onSelect, onPreview }: PeriodOrbitProps) {
  return (
    <svg
      viewBox="0 0 320 320"
      className={styles.orbit}
      aria-label="기간 날짜 길이 원형 탐색"
      role="group"
    >
      <circle cx="160" cy="160" r="112" className={styles.track} />
      <text x="160" y="155" className={styles.center} aria-label={centerLabel}>
        <title>{centerLabel}</title>
        {centerLabel.length > 12 ? `${centerLabel.slice(0, 12)}…` : centerLabel}
      </text>
      <text x="160" y="180" className={styles.center}>
        번호는 아래 목록과 연결
      </text>
      {segments.map((segment) => {
        const tiny = segment.endFraction - segment.startFraction < 0.035;
        const center = point((segment.startFraction + segment.endFraction) / 2, tiny ? 147 : 112);
        return (
          <g
            key={segment.id}
            role="button"
            tabIndex={0}
            className={styles.sectorButton}
            aria-label={`기간 원형: ${segment.label}`}
            onClick={() => onSelect(segment.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(segment.id);
              }
            }}
            onMouseEnter={() => onPreview(segment.id, 'hover')}
            onMouseLeave={() => onPreview(null, 'hover')}
            onFocus={() => onPreview(segment.id, 'focus')}
            onBlur={() => onPreview(null, 'focus')}
          >
            <path d={arc(segment.startFraction, segment.endFraction)} className={styles.sector} />
            {
              <text x={center.x} y={center.y} className={tiny ? styles.tinyNumber : styles.number}>
                {segment.number}
              </text>
            }
            <title>
              {segment.number}. {segment.label} · {segment.days}일
            </title>
          </g>
        );
      })}
    </svg>
  );
}
