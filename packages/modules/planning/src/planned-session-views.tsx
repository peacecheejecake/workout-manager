import { useId, useRef } from 'react';
import type { DayProjection } from '@workout/contracts/core';
import type { PlanDraft } from '@workout/contracts/planning';
import { Button } from '@workout/ui-foundation/button';
import styles from './planning.module.css';
export function PlannedSessionViews({
  source,
  days,
  view,
  selected,
  onSelect,
}: {
  source: PlanDraft;
  days: DayProjection[];
  view: 'agenda' | 'calendar' | 'table';
  selected: string | null;
  onSelect(id: string): void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const id = useId();
  const button = (sessionId: string) => {
    const session = source.sessions.find((value) => value.id === sessionId);
    return session ? (
      <Button
        variant="secondary"
        aria-pressed={selected === sessionId}
        onClick={() => onSelect(sessionId)}
      >
        계획: {session.title}
      </Button>
    ) : null;
  };
  return (
    <>
      <div className={styles.toolbar}>
        {view !== 'agenda' ? (
          <>
            <Button
              variant="secondary"
              aria-controls={id}
              onClick={() => scroll.current?.scrollBy({ left: -240, behavior: 'auto' })}
            >
              계획 보기 왼쪽으로 이동
            </Button>
            <Button
              variant="secondary"
              aria-controls={id}
              onClick={() => scroll.current?.scrollBy({ left: 240, behavior: 'auto' })}
            >
              계획 보기 오른쪽으로 이동
            </Button>
          </>
        ) : null}
      </div>
      <div id={id} ref={scroll} className={styles.plannedScroll}>
        {view === 'table' ? (
          <table className={styles.plannedTable}>
            <caption>계획 세션 표</caption>
            <thead>
              <tr>
                {['날짜', '선택·제목', 'Block', '목적', '거리·시간', '강도·메모'].map((label) => (
                  <th key={label} scope="col">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {days.flatMap((day) =>
                day.plannedSessionIds.map((sessionId) => {
                  const session = source.sessions.find((value) => value.id === sessionId);
                  return session ? (
                    <tr key={session.id} aria-selected={selected === session.id}>
                      <th scope="row">{session.date}</th>
                      <td>{button(session.id)}</td>
                      <td>
                        {source.periods.find((period) => period.id === session.blockId)?.title ??
                          'Block 미확인'}
                      </td>
                      <td>{session.purpose || '목적 미입력'}</td>
                      <td>
                        {session.distanceMeters === null
                          ? '거리 미정'
                          : `${session.distanceMeters}m`}{' '}
                        ·{' '}
                        {session.durationSeconds === null
                          ? '시간 미정'
                          : `${session.durationSeconds}초`}
                      </td>
                      <td>
                        목표 RPE {session.targetRpe ?? '미정'} · {session.notes || '메모 없음'}
                      </td>
                    </tr>
                  ) : null;
                }),
              )}
            </tbody>
          </table>
        ) : (
          <ol
            className={view === 'calendar' ? styles.plannedCalendar : styles.agenda}
            aria-label={view === 'calendar' ? '계획 날짜 달력' : '계획 날짜 agenda'}
          >
            {days.map((day, index) => (
              <li
                key={day.date}
                style={
                  view === 'calendar' && index === 0
                    ? {
                        gridColumnStart:
                          ((new Date(`${day.date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1,
                      }
                    : undefined
                }
              >
                <time dateTime={day.date}>{day.date}</time> ·{' '}
                {day.blockId ? 'Block 배정' : 'Block 미배정'}
                <ul>
                  {day.plannedSessionIds.map((sessionId) => (
                    <li key={sessionId}>{button(sessionId)}</li>
                  ))}
                </ul>
                {day.plannedSessionIds.length === 0 ? (
                  <span>계획 세션 없음 · 실제 휴식 여부 미확인</span>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>
      {days.every((day) => day.plannedSessionIds.length === 0) && view === 'table' ? (
        <p>조회 범위에 계획 세션이 없습니다. 실제 휴식 여부는 미확인입니다.</p>
      ) : null}
    </>
  );
}
