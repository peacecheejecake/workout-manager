import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { getLayoutMode, getContainerMode } from '@workout/ui-foundation/responsive';
import type { DayProjection } from '@workout/contracts/core';
import type { PlanDraft } from '@workout/contracts/planning';
import { Button } from '@workout/ui-foundation/button';
import styles from './planning.module.css';
import { PlannedTable, type PlannedTableSettings, type PlannedTableReports } from './planned-table';
import {
  createPlannedTableInteractionStore,
  type PlannedTableInteractionStore,
} from './planned-table-interaction';
import { SessionDragProvider, DraggableSession, DayDropTarget } from './session-drag';
import {
  plannedSessionChanges,
  type PlannedSessionChange,
  type PlannedSessionChangeContext,
} from './planned-session-change';
import { PlannedSessionChangeBadge } from './planned-session-change-badge';
interface SessionMoveSettings {
  onMove?: ((id: string, date: string, blockId: string) => void) | undefined;
  dateLockedIds?: readonly string[];
}
function SessionView({
  source,
  days,
  view,
  selected,
  onSelect,
  readScroll,
  saveScroll,
  interactionStore,
  onMove,
  dateLockedIds = [],
  sessionChanges,
  ...tableSettings
}: PlannedTableSettings &
  PlannedTableReports &
  SessionMoveSettings & {
    source: PlanDraft;
    days: DayProjection[];
    view: 'agenda' | 'calendar' | 'table';
    selected: string | null;
    onSelect(id: string): void;
    readScroll(view: SingleView): number;
    saveScroll(view: SingleView, left: number): void;
    interactionStore: PlannedTableInteractionStore;
    sessionChanges: ReadonlyMap<string, PlannedSessionChange>;
  }) {
  const scroll = useRef<HTMLDivElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    if (scroll.current) scroll.current.scrollLeft = readScroll(view);
  }, [readScroll, view]);
  const button = (sessionId: string) => {
    const session = source.sessions.find((value) => value.id === sessionId);
    return session ? (
      <DraggableSession
        sessionId={session.id}
        title={session.title}
        disabled={!onMove || session.locks.date || dateLockedIds.includes(session.id)}
      >
        <Button
          variant="secondary"
          data-planned-session={sessionId}
          aria-pressed={selected === sessionId}
          onClick={() => onSelect(sessionId)}
        >
          계획: {session.title}
        </Button>
        <PlannedSessionChangeBadge change={sessionChanges.get(session.id) ?? 'saved'} />
      </DraggableSession>
    ) : null;
  };
  if (view === 'table') {
    return (
      <>
        <PlannedTable
          source={source}
          days={days}
          selected={selected}
          onSelect={onSelect}
          interactionStore={interactionStore}
          sessionChanges={sessionChanges}
          {...tableSettings}
        />
        {days.every((day) => day.plannedSessionIds.length === 0) ? (
          <p>조회 범위에 계획 세션이 없습니다. 실제 휴식 여부는 미확인입니다.</p>
        ) : null}
      </>
    );
  }
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
      <div
        id={id}
        ref={scroll}
        className={styles.plannedScroll}
        onScroll={(event) => {
          saveScroll(view, event.currentTarget.scrollLeft);
        }}
      >
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
              <DayDropTarget date={day.date} blockId={day.blockId}>
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
              </DayDropTarget>
            </li>
          ))}
        </ol>
      </div>
    </>
  );
}

type SingleView = 'agenda' | 'calendar' | 'table';
type RequestedView = SingleView | 'auto' | 'split';
interface PlannedSessionViewsProps
  extends PlannedTableSettings, PlannedTableReports, SessionMoveSettings {
  source: PlanDraft;
  days: DayProjection[];
  view: RequestedView;
  changeContext?: PlannedSessionChangeContext;
  selected: string | null;
  onSelect(id: string): void;
}

export function PlannedSessionViews({
  view,
  changeContext = { kind: 'saved' },
  ...props
}: PlannedSessionViewsProps) {
  const sessionChanges = plannedSessionChanges(props.source, changeContext);
  const [interactionStore] = useState(createPlannedTableInteractionStore);
  const scrollPositions = useRef<Record<SingleView, number>>({ agenda: 0, calendar: 0, table: 0 });
  const readScroll = useCallback((view: SingleView) => scrollPositions.current[view], []);
  const saveScroll = useCallback((view: SingleView, left: number) => {
    scrollPositions.current[view] = left;
  }, []);
  const container = useRef<HTMLDivElement>(null);
  const fallbackLauncher = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const [size, setSize] = useState({ viewport: 0, container: 0 });
  const [fallback, setFallback] = useState<SingleView | null>(null);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const update = (width: number) => {
      if (!Number.isFinite(width) || width < 0) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && element.contains(active)) {
        pendingFocus.current = active.dataset.plannedSession ?? '';
      } else {
        pendingFocus.current = null;
      }
      setSize({ viewport: window.innerWidth, container: width });
    };
    const resize = () => update(element.getBoundingClientRect().width);
    resize();
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver((entries) => {
            const entry = entries[0];
            if (entry) update(entry.contentRect.width);
          });
    observer?.observe(element);
    window.addEventListener('resize', resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, []);
  const mode = getLayoutMode(size.viewport);
  const containerMode = getContainerMode(size.container);
  const canSplit = containerMode === 'workspace';
  const compactDefault = mode === 'mobile' || containerMode === 'compact' ? 'agenda' : 'calendar';
  const resolved: SingleView | 'split' =
    view === 'auto'
      ? canSplit && mode === 'desktop'
        ? 'split'
        : compactDefault
      : view === 'split'
        ? canSplit
          ? 'split'
          : (fallback ?? compactDefault)
        : view;
  useLayoutEffect(() => {
    const previous = pendingFocus.current;
    pendingFocus.current = null;
    if (previous === null || document.activeElement !== document.body) return;
    const equivalent = [
      ...(container.current?.querySelectorAll<HTMLButtonElement>('[data-planned-session]') ?? []),
    ].find((button) => button.dataset.plannedSession === previous);
    (equivalent ?? fallbackLauncher.current)?.focus();
  }, [resolved]);
  const views: SingleView[] = resolved === 'split' ? ['calendar', 'table'] : [resolved];
  return (
    <div ref={container} className={styles.plannedViews}>
      <p>
        현재 표시:{' '}
        {resolved === 'split'
          ? '달력·표 함께'
          : resolved === 'calendar'
            ? '달력'
            : resolved === 'table'
              ? '표'
              : 'agenda'}
      </p>
      {changeContext.kind === 'draft' ? (
        <p>
          세션 표시는 편집 시작 시 저장본의 세션 내용과 계획 시간대를 비교합니다. 계획 제목·기간
          변경과 삭제는 변경 미리보기에서 확인할 수 있습니다.
        </p>
      ) : null}
      <div className={styles.toolbar}>
        <Button
          ref={fallbackLauncher}
          variant="secondary"
          onClick={() => {
            const selected = container.current?.querySelector<HTMLButtonElement>(
              '[data-planned-session][aria-pressed="true"]',
            );
            const tableJump = container.current?.querySelector<HTMLButtonElement>(
              '[data-planned-table-jump]:not(:disabled)',
            );
            if (selected) selected.focus();
            else if (tableJump) tableJump.click();
            else
              container.current
                ?.querySelector<HTMLButtonElement>('[data-planned-session]')
                ?.focus();
          }}
        >
          계획 세션으로 이동
        </Button>
        {view === 'split' && !canSplit ? (
          <>
            <p>
              함께 보기 요청을 유지합니다. 현재 계획 영역이 좁아 한 가지 보기로 표시합니다. 한 열
              보기를 선택하면 계획 영역을 넓힐 수 있습니다.
            </p>
            {(['agenda', 'calendar', 'table'] as const).map((single) => (
              <Button
                key={single}
                variant="secondary"
                aria-pressed={resolved === single}
                onClick={() => setFallback(single)}
              >
                좁은 화면 {single === 'agenda' ? 'agenda' : single === 'calendar' ? '달력' : '표'}{' '}
                보기
              </Button>
            ))}
          </>
        ) : null}
      </div>
      <SessionDragProvider onMove={props.onMove}>
        <div className={styles.plannedPanes} data-split={resolved === 'split'}>
          {views.map((single) => (
            <section
              key={single}
              aria-label={
                single === 'calendar'
                  ? '계획 달력 패널'
                  : single === 'table'
                    ? '계획 표 패널'
                    : '계획 agenda 패널'
              }
            >
              <SessionView
                {...props}
                view={single}
                readScroll={readScroll}
                saveScroll={saveScroll}
                interactionStore={interactionStore}
                sessionChanges={sessionChanges}
              />
            </section>
          ))}
        </div>
      </SessionDragProvider>
    </div>
  );
}
