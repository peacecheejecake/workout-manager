import type { DayProjection } from '@workout/contracts/core';
import type { PlanDraft, PlannedSession } from '@workout/contracts/planning';
import { Button } from '@workout/ui-foundation/button';
import {
  plannedTableColumns,
  type PlannedTableColumn,
  type PlannedTableSort,
} from './planned-table-state';
import styles from './planning.module.css';

export interface PlannedTableSettings {
  tableSort: PlannedTableSort;
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
    if (sort.startsWith('distance_')) return session.distanceMeters;
    if (sort.startsWith('duration_')) return session.durationSeconds;
    return session.date;
  };
  return source.sessions
    .filter((session) => visible.has(session.id))
    .sort((a, b) => {
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
  onTableSort,
  onTableColumns,
}: PlannedTableSettings & {
  source: PlanDraft;
  days: DayProjection[];
  selected: string | null;
  onSelect(id: string): void;
}) {
  function sortHeader(label: string, ascending: PlannedTableSort, descending: PlannedTableSort) {
    return (
      <th
        scope="col"
        aria-sort={
          tableSort === ascending ? 'ascending' : tableSort === descending ? 'descending' : 'none'
        }
      >
        <Button
          variant="secondary"
          aria-label={`${label === '선택·제목' ? '제목' : label} 정렬`}
          onClick={() => onTableSort(tableSort === ascending ? descending : ascending)}
        >
          {label}
        </Button>
      </th>
    );
  }
  function cell(session: PlannedSession, column: PlannedTableColumn) {
    switch (column) {
      case 'block':
        return (
          source.periods.find((period) => period.id === session.blockId)?.title ?? 'Block 미확인'
        );
      case 'purpose':
        return session.purpose || '목적 미입력';
      case 'distance':
        return session.distanceMeters === null ? '거리 미정' : `${session.distanceMeters}m`;
      case 'duration':
        return session.durationSeconds === null ? '시간 미정' : `${session.durationSeconds}초`;
      case 'rpe':
        return session.targetRpe === null ? '미정' : `${session.targetRpe}`;
      case 'notes':
        return session.notes || '메모 없음';
    }
  }
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
      <p>현재 정렬: {sortLabels[tableSort]}. 미정 값은 정렬 방향과 관계없이 마지막에 표시합니다.</p>
      <table className={styles.plannedTable}>
        <caption>계획 세션 표</caption>
        <thead>
          <tr>
            {sortHeader('날짜', 'date_asc', 'date_desc')}
            {sortHeader('선택·제목', 'title_asc', 'title_desc')}
            {tableColumns.map((column) =>
              column === 'distance' ? (
                <th
                  key={column}
                  scope="col"
                  aria-sort={
                    tableSort === 'distance_asc'
                      ? 'ascending'
                      : tableSort === 'distance_desc'
                        ? 'descending'
                        : 'none'
                  }
                >
                  <Button
                    variant="secondary"
                    aria-label="거리 정렬"
                    onClick={() =>
                      onTableSort(tableSort === 'distance_asc' ? 'distance_desc' : 'distance_asc')
                    }
                  >
                    거리
                  </Button>
                </th>
              ) : column === 'duration' ? (
                <th
                  key={column}
                  scope="col"
                  aria-sort={
                    tableSort === 'duration_asc'
                      ? 'ascending'
                      : tableSort === 'duration_desc'
                        ? 'descending'
                        : 'none'
                  }
                >
                  <Button
                    variant="secondary"
                    aria-label="시간 정렬"
                    onClick={() =>
                      onTableSort(tableSort === 'duration_asc' ? 'duration_desc' : 'duration_asc')
                    }
                  >
                    시간
                  </Button>
                </th>
              ) : (
                <th key={column} scope="col">
                  {labels[column]}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {sortedPlannedSessions(source, days, tableSort).map((session) => (
            <tr key={session.id} aria-selected={selected === session.id}>
              <th scope="row">{session.date}</th>
              <td>
                <Button
                  variant="secondary"
                  data-planned-session={session.id}
                  aria-pressed={selected === session.id}
                  onClick={() => onSelect(session.id)}
                >
                  계획: {session.title}
                </Button>
              </td>
              {tableColumns.map((column) => (
                <td key={column}>{cell(session, column)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
