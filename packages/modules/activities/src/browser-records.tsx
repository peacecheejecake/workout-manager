import { useId, useRef } from 'react';
import type { Activity } from '@workout/contracts/activity';
import { Button } from '@workout/ui-foundation/button';
import styles from './activity-browser.module.css';

export const kindLabels = {
  running: '달리기',
  cycling: '자전거',
  walking: '걷기',
  strength: '근력',
  other: '기타',
  unknown: '종목 미확인',
};
export const sourceLabels = { fit: 'FIT', fixture: '테스트 자료', manual: '수동 기록' };
const durationLabels = {
  timer: '타이머 시간',
  elapsed: '경과 시간',
  moving: '이동 시간',
  unknown: '정의 미확인 시간',
};
function distance(value: number | null) {
  return value === null ? '거리 미확인' : `${value}m`;
}
function duration(value: Activity['effective']) {
  return `${value.durationSeconds === null ? '시간 미확인' : `${value.durationSeconds}초`} · ${durationLabels[value.durationKind]} (${value.durationKind})`;
}
export function BrowserRecords({
  items,
  view,
  selected,
  onSelect,
}: {
  items: Activity[];
  view: 'cards' | 'table';
  selected: string | null;
  onSelect(id: string): void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const id = useId();
  const select = (item: Activity) => (
    <Button
      variant="secondary"
      aria-pressed={selected === item.id}
      onClick={() => onSelect(item.id)}
    >
      {item.effective.title ?? '제목 미확인'}
    </Button>
  );
  if (view === 'cards')
    return (
      <ul className={styles.cards}>
        {items.map((item) => (
          <li key={item.id}>
            <article>
              {select(item)}
              <p>
                {kindLabels[item.effective.kind]} · {item.effective.startedAt ?? '시작 시각 미확인'}{' '}
                · {item.effective.timezone ?? '시간대 미확인'}
              </p>
              <p>
                {distance(item.effective.distanceMeters)} · {duration(item.effective)}
              </p>
              <p>
                출처 {sourceLabels[item.source.kind]} · 기록 수정 {item.revision}
              </p>
            </article>
          </li>
        ))}
      </ul>
    );
  return (
    <>
      <div className={styles.actions}>
        <Button
          variant="secondary"
          aria-controls={id}
          onClick={() => scroll.current?.scrollBy({ left: -240, behavior: 'auto' })}
        >
          활동 표 왼쪽으로 이동
        </Button>
        <Button
          variant="secondary"
          aria-controls={id}
          onClick={() => scroll.current?.scrollBy({ left: 240, behavior: 'auto' })}
        >
          활동 표 오른쪽으로 이동
        </Button>
      </div>
      <div
        id={id}
        ref={scroll}
        className={styles.table}
        role="region"
        aria-label="활동 표 가로 탐색"
      >
        <table>
          <caption>조회 조건에 맞는 활동</caption>
          <thead>
            <tr>
              {['활동', '종목', '시작 시각·시간대', '거리', '시간·정의', '출처·수정'].map(
                (label) => (
                  <th key={label} scope="col">
                    {label}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <th scope="row">{select(item)}</th>
                <td>{kindLabels[item.effective.kind]}</td>
                <td>
                  {item.effective.startedAt ?? '시작 시각 미확인'} ·{' '}
                  {item.effective.timezone ?? '시간대 미확인'}
                </td>
                <td>{distance(item.effective.distanceMeters)}</td>
                <td>{duration(item.effective)}</td>
                <td>
                  {sourceLabels[item.source.kind]} · {item.revision}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
function Values({ label, values }: { label: string; values: Activity['effective'] }) {
  return (
    <section aria-label={label}>
      <h3>{label}</h3>
      <dl>
        <dt>제목</dt>
        <dd>{values.title ?? '제목 미확인'}</dd>
        <dt>종목</dt>
        <dd>{kindLabels[values.kind]}</dd>
        <dt>시작 시각</dt>
        <dd>{values.startedAt ?? '미확인'}</dd>
        <dt>시간대</dt>
        <dd>{values.timezone ?? '미확인'}</dd>
        <dt>거리</dt>
        <dd>{distance(values.distanceMeters)}</dd>
        <dt>시간</dt>
        <dd>{duration(values)}</dd>
      </dl>
    </section>
  );
}
export function BrowserDetail({ activity }: { activity: Activity }) {
  return (
    <>
      <p>
        출처 {sourceLabels[activity.source.kind]} · 원본 수정 {activity.source.revision} · 기록 수정{' '}
        {activity.revision}
      </p>
      <p>출처 식별자: {activity.source.sourceId}</p>
      <p>원본 내용 해시: {activity.source.contentHash}</p>
      <div className={styles.values}>
        <Values label="원본 기록" values={activity.original} />
        <Values label="정정 반영 기록" values={activity.effective} />
      </div>
      <p>정정 사유: {activity.overlay.reason ?? '기록된 정정 사유 없음'}</p>
      <section aria-label="활동 자기보고">
        <h3>활동 자기보고</h3>
        {activity.userReport ? (
          <>
            <p>
              활동 전체의 체감 강도 (RPE): {activity.userReport.sessionRpe ?? '보고하지 않음'} / 10
            </p>
            <p>RPE 보고 시각: {activity.userReport.rpeReportedAt ?? '보고하지 않음'}</p>
            <p>메모: {activity.userReport.note ?? '보고하지 않음'}</p>
            <p>
              {activity.userReport.planLink
                ? `계획 연결: 버전 ${activity.userReport.planLink.planVersionId} · 세션 ${activity.userReport.planLink.sessionId}`
                : '연결한 계획 세션 없음'}
            </p>
            <p>사용자 자기보고 · {activity.userReport.definitionVersion}</p>
          </>
        ) : (
          <p>저장된 자기보고가 없습니다. 미보고를 RPE 0으로 해석하지 않습니다.</p>
        )}
      </section>
      <p>정정은 원본을 덮어쓰지 않습니다. 이 화면은 조회 전용입니다.</p>
    </>
  );
}
