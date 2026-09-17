import { useId, useMemo, type CSSProperties } from 'react';
import { useStore } from 'zustand';
import { usePlannedTableViewport } from './planned-table-viewport';
import { visibleRangeIds, type PlannedTableInteractionStore } from './planned-table-interaction';
import type { DayProjection } from '@workout/contracts/core';
import {
  sessionDurationBounds,
  sessionDistanceBounds,
  type PlanDraft,
  type PlannedSession,
} from '@workout/contracts/planning';
import { sessionDurationLabel, sessionDistanceLabel } from './session-quantity-labels';
import { Button } from '@workout/ui-foundation/button';
import {
  plannedTableColumns,
  plannedTablePins,
  type PlannedTablePin,
  type PlannedTableColumn,
  type PlannedTableSort,
} from './planned-table-state';
import styles from './planning.module.css';

export interface PlannedTableSettings {
  tableSort: PlannedTableSort;
  tablePinned: PlannedTablePin[];
  onTablePinned(pins: PlannedTablePin[]): void;
  tableColumns: PlannedTableColumn[];
  onTableSort(sort: PlannedTableSort): void;
  onTableColumns(columns: PlannedTableColumn[]): void;
}
const labels = {
  block: 'Block',
  purpose: '목적',
  distance: '거리',
  duration: '시간',
  rpe: '목표 RPE',
  intensity: '강도 라벨',
  notes: '메모',
};
const sortLabels: Record<PlannedTableSort, string> = {
  date_asc: '날짜 오름차순',
  date_desc: '날짜 내림차순',
  title_asc: '제목 오름차순',
  title_desc: '제목 내림차순',
  distance_asc: '거리 오름차순',
  distance_desc: '거리 내림차순',
  duration_asc: '시간 오름차순',
  duration_desc: '시간 내림차순',
};
const lexical = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export function sortedPlannedSessions(
  source: PlanDraft,
  days: DayProjection[],
  sort: PlannedTableSort,
): PlannedSession[] {
  const visible = new Set(days.flatMap((day) => day.plannedSessionIds));
  const value = (session: PlannedSession): string | number | null => {
    if (sort.startsWith('title_')) return session.title;
    return session.date;
  };
  return source.sessions
    .filter((session) => visible.has(session.id))
    .sort((a, b) => {
      if (sort.startsWith('distance_') || sort.startsWith('duration_')) {
        const bounds = sort.startsWith('distance_') ? sessionDistanceBounds : sessionDurationBounds;
        const av = bounds(a),
          bv = bounds(b);
        if (av === null && bv !== null) return 1;
        if (bv === null && av !== null) return -1;
        const compared = av && bv ? av.min - bv.min || av.max - bv.max : 0;
        return (sort.endsWith('_desc') ? -compared : compared) || lexical(a.id, b.id);
      }
      const av = value(a),
        bv = value(b);
      if (av === null && bv !== null) return 1;
      if (bv === null && av !== null) return -1;
      const compared =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : typeof av === 'string' && typeof bv === 'string'
            ? lexical(av, bv)
            : 0;
      return (sort.endsWith('_desc') ? -compared : compared) || lexical(a.id, b.id);
    });
}
export function PlannedTable({
  source,
  days,
  selected,
  onSelect,
  tableSort,
  tableColumns,
  tablePinned,
  onTableSort,
  onTableColumns,
  onTablePinned,
  interactionStore,
}: PlannedTableSettings & {
  source: PlanDraft;
  days: DayProjection[];
  selected: string | null;
  onSelect(id: string): void;
  interactionStore: PlannedTableInteractionStore;
}) {
  const rows = useMemo(
    () => sortedPlannedSessions(source, days, tableSort),
    [source, days, tableSort],
  );
  const ids = rows.map((row) => row.id);
  const rangeIds = useStore(interactionStore, (store) => store.state.rangeIds);
  const anchorId = useStore(interactionStore, (store) => store.state.anchorId);
  const mode = useStore(interactionStore, (store) => store.state.rowMode);
  const actions = useStore(interactionStore, (store) => store.actions);
  const {
    viewport: viewportRef,
    body: bodyRef,
    width,
    margin,
    virtual,
    virtualizer,
    rendered,
    rememberScroll,
    scrollHorizontal,
    jump,
    setFocusedId,
  } = usePlannedTableViewport(rows, mode, interactionStore);
  const viewportId = useId();
  const availableColumns: PlannedTablePin[] = ['date', 'title', ...tableColumns];
  const columns = [
    ...availableColumns.filter((column) => tablePinned.includes(column)),
    ...availableColumns.filter((column) => !tablePinned.includes(column)),
  ];
  const widths: Record<PlannedTablePin, number> = {
    date: 160,
    title: 240,
    block: 160,
    purpose: 200,
    distance: 160,
    duration: 160,
    rpe: 160,
    intensity: 160,
    notes: 240,
  };
  const visiblePins = columns.filter((column) => tablePinned.includes(column));
  const pinnedWidth = visiblePins.reduce((sum, column) => sum + widths[column], 0);
  const pinsEnabled = width >= pinnedWidth + 160;
  const pinStyle = (column: PlannedTablePin): CSSProperties => {
    const index = visiblePins.indexOf(column);
    return pinsEnabled && index >= 0
      ? {
          position: 'sticky',
          left: visiblePins.slice(0, index).reduce((sum, key) => sum + widths[key], 0),
          zIndex: 1,
          background: 'var(--canvas)',
        }
      : {};
  };
  const headerLabels = { date: '날짜', title: '선택·제목', ...labels };
  function header(column: PlannedTablePin) {
    const sorts: Partial<Record<PlannedTablePin, [PlannedTableSort, PlannedTableSort]>> = {
      date: ['date_asc', 'date_desc'],
      title: ['title_asc', 'title_desc'],
      distance: ['distance_asc', 'distance_desc'],
      duration: ['duration_asc', 'duration_desc'],
    };
    const pair = sorts[column];
    return (
      <th
        key={column}
        scope="col"
        style={pinStyle(column)}
        data-pinned={pinsEnabled && visiblePins.includes(column)}
        aria-sort={
          pair
            ? tableSort === pair[0]
              ? 'ascending'
              : tableSort === pair[1]
                ? 'descending'
                : 'none'
            : undefined
        }
      >
        {pair ? (
          <Button
            variant="secondary"
            aria-label={`${column === 'title' ? '제목' : headerLabels[column]} 정렬`}
            onClick={() => onTableSort(tableSort === pair[0] ? pair[1] : pair[0])}
          >
            {headerLabels[column]}
          </Button>
        ) : (
          headerLabels[column]
        )}
      </th>
    );
  }
  function cell(session: PlannedSession, column: PlannedTablePin) {
    switch (column) {
      case 'date':
        return session.date;
      case 'title':
        return (
          <Button
            variant="secondary"
            data-planned-session={session.id}
            aria-pressed={selected === session.id}
            onClick={() => onSelect(session.id)}
          >
            계획: {session.title}
          </Button>
        );
      case 'block':
        return (
          source.periods.find((period) => period.id === session.blockId)?.title ?? 'Block 미확인'
        );
      case 'purpose':
        return session.purpose || '목적 미입력';
      case 'distance':
        return session.distanceMeters === null && !session.distanceRange
          ? '거리 미정'
          : sessionDistanceLabel(session);
      case 'duration':
        return session.durationSeconds === null && !session.durationRange
          ? '시간 미정'
          : sessionDurationLabel(session);
      case 'rpe':
        return session.targetRpe === null ? '미정' : `${session.targetRpe}`;
      case 'intensity':
        return session.intensityLabel ?? '미지정';
      case 'notes':
        return session.notes || '메모 없음';
    }
  }
  const shownRange = visibleRangeIds(rangeIds, ids);
  const cells = columns.length + 1;
  const spacer = (height: number, key: string) =>
    height > 0 ? (
      <tr key={key} aria-hidden="true">
        <td colSpan={cells} style={{ height, padding: 0, border: 0 }} />
      </tr>
    ) : null;
  const bodyRows = rendered.flatMap((item, itemIndex) => {
    const previousEnd = rendered[itemIndex - 1]?.end ?? margin;
    const session = rows[item.index];
    if (!session) return [];
    const gap = virtual ? spacer(item.start - previousEnd, `before-${session.id}`) : null;
    return [
      gap,
      <tr
        key={session.id}
        data-index={item.index}
        data-session-id={session.id}
        ref={virtual ? virtualizer.measureElement : undefined}
        aria-rowindex={item.index + 2}
        aria-selected={selected === session.id}
        data-range-selected={shownRange.includes(session.id)}
        onFocusCapture={() => setFocusedId(session.id)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocusedId(null);
        }}
      >
        <td>
          <label>
            <input
              type="checkbox"
              aria-label={`${session.title} 범위 선택`}
              checked={shownRange.includes(session.id)}
              onChange={() => actions.toggleRange(session.id)}
            />
            범위 선택
          </label>
          <Button
            variant="secondary"
            aria-label={`${session.title} 범위 시작`}
            onClick={() => actions.startRange(session.id)}
          >
            범위 시작
          </Button>
          <Button
            variant="secondary"
            aria-label={`${session.title} 범위 끝`}
            disabled={!anchorId || !ids.includes(anchorId)}
            onClick={() => actions.endRange(session.id, ids)}
          >
            범위 끝
          </Button>
        </td>
        {columns.map((column) =>
          column === 'date' ? (
            <th key={column} scope="row" style={pinStyle(column)}>
              {cell(session, column)}
            </th>
          ) : (
            <td key={column} style={pinStyle(column)}>
              {cell(session, column)}
            </td>
          ),
        )}
      </tr>,
    ];
  });
  return (
    <>
      <fieldset className={styles.tableColumns}>
        <legend>계획 표 열 표시</legend>
        {plannedTableColumns.map((column) => (
          <label key={column}>
            <input
              type="checkbox"
              checked={tableColumns.includes(column)}
              onChange={(event) =>
                onTableColumns(
                  plannedTableColumns.filter((candidate) =>
                    candidate === column ? event.target.checked : tableColumns.includes(candidate),
                  ),
                )
              }
            />
            {labels[column]} 열 표시
          </label>
        ))}
      </fieldset>
      <fieldset className={styles.tableColumns}>
        <legend>계획 표 왼쪽 열 고정</legend>
        {plannedTablePins.map((column) => (
          <label key={column}>
            <input
              type="checkbox"
              checked={tablePinned.includes(column)}
              onChange={(event) =>
                onTablePinned(
                  plannedTablePins.filter((candidate) =>
                    candidate === column ? event.target.checked : tablePinned.includes(candidate),
                  ),
                )
              }
            />
            {column === 'title' ? '제목' : headerLabels[column]} 열 고정
          </label>
        ))}
      </fieldset>
      {visiblePins.length > 0 && !pinsEnabled ? (
        <p>
          표 영역이 좁아 열 고정을 잠시 해제했습니다. 고정 요청은 유지되며 영역이 넓어지면
          복원됩니다.
        </p>
      ) : null}
      <p>현재 정렬: {sortLabels[tableSort]}. 미정 값은 정렬 방향과 관계없이 마지막에 표시합니다.</p>
      <p role="status">
        현재 조회 범위에서 {shownRange.length}개 행 선택. 범위 선택은 계획을 변경하지 않습니다.
      </p>
      {anchorId ? (
        <p>
          범위 시작: {rows.find((row) => row.id === anchorId)?.title ?? '현재 조회 범위 밖의 세션'}.
          현재 정렬 순서에서 범위 끝을 선택하세요.
        </p>
      ) : null}
      <div className={styles.toolbar}>
        <Button variant="secondary" onClick={actions.clearRange}>
          행 범위 선택 해제
        </Button>
        <Button
          variant="secondary"
          aria-pressed={mode === 'all'}
          onClick={() => actions.setRowMode('all')}
        >
          모든 행 표시
        </Button>
        <Button
          variant="secondary"
          aria-pressed={mode === 'virtual'}
          onClick={() => actions.setRowMode('virtual')}
        >
          가상 스크롤
        </Button>
        <Button
          variant="secondary"
          data-planned-table-jump="true"
          disabled={!selected || !ids.includes(selected)}
          onClick={() => {
            if (selected) jump(selected);
          }}
        >
          선택한 계획 행으로 이동
        </Button>
        <Button
          variant="secondary"
          aria-controls={viewportId}
          onClick={() => scrollHorizontal(-240)}
        >
          계획 보기 왼쪽으로 이동
        </Button>
        <Button
          variant="secondary"
          aria-controls={viewportId}
          onClick={() => scrollHorizontal(240)}
        >
          계획 보기 오른쪽으로 이동
        </Button>
      </div>
      <p>
        {rows.length}개 계획 세션 · {virtual ? '가상 스크롤 사용 중' : '모든 행 표시 중'}. 화면 읽기
        도구로 전체 행을 탐색하려면 모든 행 표시를 선택하세요.
      </p>
      <div
        role="region"
        aria-label="계획 표 스크롤 영역"
        id={viewportId}
        ref={viewportRef}
        className={styles.plannedTableViewport}
        onScroll={rememberScroll}
      >
        <table
          className={styles.plannedTable}
          aria-rowcount={rows.length + 1}
          style={{
            tableLayout: 'fixed',
            width: 240 + columns.reduce((sum, column) => sum + widths[column], 0),
          }}
        >
          <caption>계획 세션 표</caption>
          <colgroup>
            <col style={{ width: 240 }} />
            {columns.map((column) => (
              <col key={column} style={{ width: widths[column] }} />
            ))}
          </colgroup>
          <thead>
            <tr aria-rowindex={1}>
              <th scope="col">행 범위 선택</th>
              {columns.map(header)}
            </tr>
          </thead>
          <tbody ref={bodyRef}>
            {bodyRows}
            {virtual
              ? spacer(virtualizer.totalSize + margin - (rendered.at(-1)?.end ?? margin), 'after')
              : null}
          </tbody>
        </table>
      </div>
    </>
  );
}
