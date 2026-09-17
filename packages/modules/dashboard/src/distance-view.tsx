import { useId, useRef } from 'react';
import { Button } from '@workout/ui-foundation/button';
import type { DashboardDay } from '@workout/contracts/dashboard';
import type { DashboardLinks } from './dashboard-workspace';
import styles from './dashboard.module.css';
import { metricText, plannedMetricText } from './format';

function plannedBounds(day: DashboardDay) {
  const target = day.planned.targets?.distanceMeters;
  return target === undefined
    ? { min: day.planned.distanceMeters.value, max: day.planned.distanceMeters.value }
    : { min: target.min, max: target.max };
}

export function DistanceView({ days, links }: { days: DashboardDay[]; links: DashboardLinks }) {
  const titleId = useId();
  const graphId = useId();
  const tableId = useId();
  const graph = useRef<HTMLDivElement>(null);
  const table = useRef<HTMLDivElement>(null);
  const descriptionId = useId();
  const max = Math.max(
    1,
    ...days.flatMap((day) => [plannedBounds(day).max ?? 0, day.actual.distanceMeters.value ?? 0]),
  );
  const width = Math.max(360, days.length * 44 + 40);
  return (
    <section aria-label="날짜별 기록">
      <h2>날짜별 계획·실제 거리</h2>
      <p>
        계획 단일값은 진한색 사각형, 범위는 하한·상한을 잇는 선과 경계점, 실제는 청록색 원으로
        표시합니다. 중간값은 추정하지 않습니다. 미보고는 점을 그리지 않으며 알려진 0m는 기준선에
        표시합니다.
      </p>
      <div className={styles.actions}>
        <Button
          variant="secondary"
          aria-controls={graphId}
          onClick={() => graph.current?.scrollBy({ left: -240, behavior: 'auto' })}
        >
          그래프 왼쪽으로 이동
        </Button>
        <Button
          variant="secondary"
          aria-controls={graphId}
          onClick={() => graph.current?.scrollBy({ left: 240, behavior: 'auto' })}
        >
          그래프 오른쪽으로 이동
        </Button>
      </div>
      <div
        id={graphId}
        ref={graph}
        className={styles.graph}
        role="region"
        aria-label="거리 그래프 가로 탐색"
      >
        <svg
          role="img"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          viewBox={`0 0 ${width} 230`}
          width={width}
          height={230}
        >
          <title id={titleId}>날짜별 계획·실제 거리</title>
          <desc id={descriptionId}>
            세로축 단위 미터. 아래 표와 같은 날짜별 거리입니다. 보고하지 않은 값은 연결하거나 0으로
            채우지 않습니다.
          </desc>
          <line x1={30} y1={185} x2={width - 10} y2={185} className={styles.axis} />
          <text x={4} y={14} className={styles.axisText}>
            {max}m
          </text>
          <text x={4} y={187} className={styles.axisText}>
            0
          </text>
          {days.map((day, index) => {
            const x = 45 + index * ((width - 60) / days.length);
            const bounds = plannedBounds(day);
            return (
              <g key={day.date}>
                <title>
                  {day.date}: 계획{' '}
                  {plannedMetricText(
                    day.planned.distanceMeters,
                    day.planned.targets?.distanceMeters,
                    'm',
                  )}
                  , 실제 {metricText(day.actual.distanceMeters, 'm')}
                </title>
                {bounds.min !== null && bounds.max !== null ? (
                  bounds.min === bounds.max ? (
                    <rect
                      className={styles.planned}
                      x={x - 7}
                      y={181 - (bounds.min / max) * 155}
                      width={8}
                      height={8}
                      data-date={day.date}
                      data-series="planned"
                      data-value={bounds.min}
                    />
                  ) : (
                    <g
                      data-date={day.date}
                      data-series="planned-range"
                      data-min={bounds.min}
                      data-max={bounds.max}
                    >
                      <line
                        className={styles.plannedRange}
                        x1={x - 3}
                        x2={x - 3}
                        y1={185 - (bounds.min / max) * 155}
                        y2={185 - (bounds.max / max) * 155}
                      />
                      {[bounds.min, bounds.max].map((value) => (
                        <rect
                          key={value}
                          className={styles.planned}
                          x={x - 7}
                          y={181 - (value / max) * 155}
                          width={8}
                          height={8}
                          data-value={value}
                        />
                      ))}
                    </g>
                  )
                ) : null}
                {day.actual.distanceMeters.value !== null ? (
                  <circle
                    className={styles.actual}
                    cx={x + 7}
                    cy={185 - (day.actual.distanceMeters.value / max) * 155}
                    r={4}
                    data-date={day.date}
                    data-series="actual"
                    data-value={day.actual.distanceMeters.value}
                  />
                ) : null}
                <text x={x} y={211} textAnchor="middle" className={styles.axisText}>
                  {day.date.slice(5)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className={styles.actions}>
        <Button
          variant="secondary"
          aria-controls={tableId}
          onClick={() => table.current?.scrollBy({ left: -240, behavior: 'auto' })}
        >
          표 왼쪽으로 이동
        </Button>
        <Button
          variant="secondary"
          aria-controls={tableId}
          onClick={() => table.current?.scrollBy({ left: 240, behavior: 'auto' })}
        >
          표 오른쪽으로 이동
        </Button>
      </div>
      <div
        id={tableId}
        ref={table}
        className={styles.table}
        role="region"
        aria-label="날짜별 기록 표 가로 탐색"
      >
        <table>
          <caption>날짜별 거리와 보고 현황</caption>
          <thead>
            <tr>
              <th scope="col">현지 날짜</th>
              <th scope="col">계획 거리</th>
              <th scope="col">실제 거리</th>
              <th scope="col">계획 / 실제 개수</th>
              <th scope="col">체크인 개수</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <tr key={day.date}>
                <th scope="row">
                  <a href={links.planDay(day.date)}>{day.date} 계획</a>
                </th>
                <td>
                  {plannedMetricText(
                    day.planned.distanceMeters,
                    day.planned.targets?.distanceMeters,
                    'm',
                  )}
                </td>
                <td>{metricText(day.actual.distanceMeters, 'm')}</td>
                <td>
                  {day.planned.count} / {day.actual.count}
                </td>
                <td>{day.checkInCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        체크인 개수는 대시보드 시간대로 묶었습니다. 개별 체크인의 저장된 현지 날짜와 다를 수
        있습니다. <a href={links.wellbeing}>체크인 기록 보기</a>
      </p>
    </section>
  );
}
