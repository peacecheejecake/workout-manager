import { useId } from 'react';
import type { CheckIn, CheckInList } from '@workout/contracts/check-ins';
import { Button } from '@workout/ui-foundation/button';
import styles from './check-in-trend.module.css';

export interface CheckInTrendProps {
  data: CheckInList;
  from: string;
  toExclusive: string;
  offset: number;
  onSelect(id: string): void;
}

function Scatter({ records, field }: { records: CheckIn[]; field: 'fatigue' | 'discomfort' }) {
  const label = field === 'fatigue' ? '피로' : '불편감';
  const first = records[0];
  const last = records.at(-1);
  const minimum = first ? Date.parse(first.values.observedAt) : 0;
  const maximum = last ? Date.parse(last.values.observedAt) : 0;
  const known = records.filter((record) => record.values[field] !== null);
  return (
    <section aria-label={`${label} 관측 추세`}>
      <h4>{label}</h4>
      <p>
        보고 {known.length}개 · 미보고 {records.length - known.length}개
      </p>
      {known.length === 0 ? (
        <p>이 페이지에 보고된 {label} 값이 없습니다.</p>
      ) : (
        <svg
          viewBox="0 0 600 180"
          role="img"
          aria-label={`${label} 관측점 ${known.length}개 · 0~10 척도`}
          className={styles.chart}
        >
          {[0, 5, 10].map((value) => (
            <g key={value}>
              <text x="8" y={154 - value * 13}>
                {value}
              </text>
              <line x1="36" x2="584" y1={150 - value * 13} y2={150 - value * 13} />
            </g>
          ))}
          {known.map((record) => (
            <circle
              key={record.id}
              cx={
                maximum === minimum
                  ? 310
                  : 36 +
                    ((Date.parse(record.values.observedAt) - minimum) / (maximum - minimum)) * 548
              }
              cy={150 - (record.values[field] ?? 0) * 13}
              r="4"
            >
              <title>{`${record.values.observedAt} · ${label} ${record.values[field]} · 기록 ${record.id}`}</title>
            </circle>
          ))}
        </svg>
      )}
      {first && last ? (
        <p className={styles.axis}>
          관측 시각 축 (UTC): {new Date(minimum).toISOString()} ~ {new Date(maximum).toISOString()}
        </p>
      ) : null}
    </section>
  );
}

export function CheckInTrend({ data, from, toExclusive, offset, onSelect }: CheckInTrendProps) {
  const explanation = useId();
  const records = [...data.items].sort(
    (a, b) =>
      Date.parse(a.values.observedAt) - Date.parse(b.values.observedAt) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const partial = data.total > 0 && (offset > 0 || records.length < data.total);
  return (
    <section aria-label="체크인 관측 추세" className={styles.trend}>
      <h3>체크인 관측 추세</h3>
      <p>
        조회 범위: {from} ~ {toExclusive} (종료일 제외). 각 기록에 저장된 현지 날짜로 조회합니다.
      </p>
      <p>
        {partial ? '부분 조회' : '전체 조회'}: 현재 {records.length}개 / 전체 {data.total}개
      </p>
      {partial ? (
        <p>
          표시하지 않은 기록이 있습니다. 이 페이지의 미보고 수는 전체 기간의 미보고 수가 아닙니다.
        </p>
      ) : null}
      <p id={explanation}>
        가로축은 관측 시각 UTC, 세로축은 자기보고 값 0~10입니다. 선·보간·평균 없이 관측점만
        표시합니다. 미보고는 점을 그리지 않으며 0과 다릅니다. 같은 시각의 같은 값은 겹칠 수 있으므로
        원본 표에서 각 기록을 확인하세요.
      </p>
      {records.length === 0 ? (
        <p>
          {data.total === 0
            ? '이 기간에 기록한 체크인이 없습니다.'
            : '이 페이지에 표시할 기록이 없습니다.'}
        </p>
      ) : (
        <>
          <div className={styles.series}>
            <Scatter records={records} field="fatigue" />
            <Scatter records={records} field="discomfort" />
          </div>
          {/* Keyboard users need to focus this named horizontal scroll region. */}
          <div
            className={styles.scroll}
            role="region"
            aria-label="체크인 추세 원본 표 가로 스크롤"
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Named scroll region supports keyboard scrolling.
            tabIndex={0}
            aria-describedby={explanation}
          >
            <table>
              <caption>체크인 추세 원본 값 · 관측 시각 오름차순</caption>
              <thead>
                <tr>
                  <th scope="col">관측 시각 (원본)</th>
                  <th scope="col">시간대</th>
                  <th scope="col">현지 날짜</th>
                  <th scope="col">피로</th>
                  <th scope="col">불편감</th>
                  <th scope="col">수정 번호</th>
                  <th scope="col">상세</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr key={record.id}>
                    <th scope="row">
                      <time dateTime={record.values.observedAt}>{record.values.observedAt}</time>
                    </th>
                    <td>{record.values.timezone}</td>
                    <td>{record.localDate}</td>
                    <td>{record.values.fatigue ?? '미보고'}</td>
                    <td>{record.values.discomfort ?? '미보고'}</td>
                    <td>{record.revision}</td>
                    <td>
                      <Button
                        variant="secondary"
                        aria-label={`추세 기록 상세 보기 · ${record.values.observedAt} · ${record.id}`}
                        onClick={() => onSelect(record.id)}
                      >
                        기록 상세 보기
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
