import { useRef, useState } from 'react';
import {
  columnFilteringFeature,
  createColumnHelper,
  createFilteredRowModel,
  createSortedRowModel,
  filterFn_includesString,
  globalFilteringFeature,
  rowSortingFeature,
  sortFn_basic,
  sortFn_text,
  tableFeatures,
  useTable,
  type SortingState,
} from '@tanstack/react-table';
import { useTableViewport, type TableViewportState } from '@workout/table-kit/table-viewport';
import styles from './table-virtualization-panel.module.css';

interface FixtureRow {
  readonly id: string;
  readonly title: string;
  readonly distanceKm: number | null;
  readonly memo: string;
}
const roster: FixtureRow[] = Array.from({ length: 10000 }, (_, index) =>
  Object.freeze({
    id: `fixture-${String(index).padStart(5, '0')}`,
    title: `가상 행 ${String(index).padStart(5, '0')}`,
    distanceKm: index % 17 === 0 ? null : index % 11 === 1 ? 0 : (index % 100) / 10,
    memo:
      index % 3 === 0
        ? '한글 긴 메모 · 실제 운동이나 승인 기록이 아닙니다. '.repeat(8)
        : '짧은 합성 메모',
  }),
);
Object.freeze(roster);
const features = tableFeatures({
  columnFilteringFeature,
  globalFilteringFeature,
  rowSortingFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
  filterFns: { includesString: filterFn_includesString },
  sortFns: { basic: sortFn_basic, text: sortFn_text },
});
const helper = createColumnHelper<typeof features, FixtureRow>();
const columns = helper.columns([
  helper.accessor('id', { sortFn: 'text', enableGlobalFilter: false }),
  helper.accessor('title', { sortFn: 'text', enableGlobalFilter: true }),
  helper.accessor((row) => row.distanceKm ?? undefined, {
    id: 'distanceKm',
    sortFn: 'basic',
    sortUndefined: 'last',
    enableGlobalFilter: false,
  }),
]);
const getRowId = (row: FixtureRow) => row.id;
const getTableRowId = (row: { id: string }) => row.id;

/** Independent immutable 10k fixture. All server/provider totals remain unknown. */
export function TableVirtualizationPanel() {
  const [mode, setMode] = useState<'virtual' | 'all'>('virtual');
  const [sorting, setSorting] = useState<SortingState>([{ id: 'id', desc: false }]);
  const [filter, setFilter] = useState('');
  const [targetNumber, setTargetNumber] = useState('9999');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusedRowId, setFocusedRowId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [scrollState, setScrollState] = useState<TableViewportState>({
    scrollAnchor: null,
    scrollLeft: 0,
  });
  const filterInput = useRef<HTMLInputElement>(null);
  const table = useTable({
    features,
    columns,
    data: roster,
    getRowId,
    state: { sorting, globalFilter: filter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setFilter,
    globalFilterFn: 'includesString',
    enableSortingRemoval: false,
  });
  const rows = table.getRowModel().rows;
  const targetId = /^(?:0|[1-9]\d{0,3})$/.test(targetNumber)
    ? `fixture-${targetNumber.padStart(5, '0')}`
    : null;
  const targetAvailable = targetId !== null && rows.some((row) => row.id === targetId);
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
  } = useTableViewport({
    rows,
    mode,
    getRowId: getTableRowId,
    focusedRowId,
    onFocusedRowChange: setFocusedRowId,
    readState: () => scrollState,
    onScrollLeftChange: (scrollLeft) => setScrollState((value) => ({ ...value, scrollLeft })),
    onScrollAnchorChange: (scrollAnchor) => setScrollState((value) => ({ ...value, scrollAnchor })),
    getFocusTarget: (element, id) =>
      [...element.querySelectorAll<HTMLElement>('[data-row-select]')].find(
        (button) => button.dataset.rowSelect === id,
      ) ?? null,
  });
  function sortBy(id: 'id' | 'distanceKm') {
    const descending = sorting[0]?.id === id && sorting[0].desc === false;
    setSorting(
      id === 'id'
        ? [{ id, desc: descending }]
        : [
            { id, desc: descending },
            { id: 'id', desc: false },
          ],
    );
  }
  function showDifferentRow(id: string) {
    // Move to an explicit visible control before removing the focused row from the logical view.
    filterInput.current?.focus();
    setFocusedRowId(null);
    setFilter(id === roster[0]?.id ? '가상 행 00001' : '가상 행 00000');
  }
  function spacer(height: number, key: string) {
    return height > 0 ? (
      <tr key={key} aria-hidden="true">
        <td colSpan={4} style={{ height, padding: 0, border: 0 }} />
      </tr>
    ) : null;
  }
  const bodyRows = rendered.flatMap((item, itemIndex) => {
    const row = rows[item.index];
    if (!row) return [];
    const data = row.original;
    const expanded = expandedIds.has(row.id);
    return [
      virtual
        ? spacer(item.start - (rendered[itemIndex - 1]?.end ?? margin), `before-${row.id}`)
        : null,
      <tr
        key={row.id}
        data-index={item.index}
        data-fixture-id={row.id}
        ref={virtual ? virtualizer.measureElement : undefined}
        aria-rowindex={item.index + 2}
        aria-selected={selectedId === row.id}
        onFocusCapture={() => setFocusedRowId(row.id)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocusedRowId(null);
        }}
      >
        <th
          scope="row"
          tabIndex={mode === 'all' ? -1 : undefined}
          data-row-select={mode === 'all' ? row.id : undefined}
        >
          {data.title}
        </th>
        <td>{data.distanceKm === null ? '미확인' : `${data.distanceKm} km`}</td>
        {mode === 'all' ? (
          <>
            <td>
              {data.memo}
              {expanded ? <p>{'높이 측정용 추가 한글 설명입니다. '.repeat(10)}</p> : null}
            </td>
            <td>
              {selectedId === row.id ? '현재 선택됨' : '선택되지 않음'} · {row.id}
            </td>
          </>
        ) : (
          <>
            <td>
              <p>{expanded || data.memo.length < 50 ? data.memo : '긴 한글 메모 · 펼쳐서 읽기'}</p>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() =>
                  setExpandedIds((value) => {
                    const next = new Set(value);
                    if (expanded) next.delete(row.id);
                    else next.add(row.id);
                    return next;
                  })
                }
              >
                {data.title} 메모 {expanded ? '접기' : '펼치기'}
              </button>
              {expanded ? <p>{'높이 측정용 추가 한글 설명입니다. '.repeat(10)}</p> : null}
            </td>
            <td>
              <button
                type="button"
                data-row-select={row.id}
                aria-pressed={selectedId === row.id}
                onClick={() => setSelectedId(row.id)}
              >
                {data.title} 선택
              </button>
              <button type="button" onClick={() => showDifferentRow(row.id)}>
                {data.title} 대신 다른 행만 보기
              </button>
            </td>
          </>
        )}
      </tr>,
    ];
  });
  return (
    <section className={styles.panel} aria-label="표 가상화 검증">
      <h2>독립 10,000행 표 가상화</h2>
      <p>
        모든 행은 불변 합성 입력입니다. 서버 전체 수량은 알 수 없으며 저장·승인·외부 요청이
        없습니다.
      </p>
      <div className={styles.controls}>
        <label>
          합성 행 검색
          <input
            ref={filterInput}
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
          />
        </label>
        <label>
          합성 대상 번호 (0~9999)
          <input
            type="number"
            min="0"
            max="9999"
            step="1"
            value={targetNumber}
            onChange={(event) => setTargetNumber(event.currentTarget.value)}
          />
        </label>
        <button
          type="button"
          disabled={!targetAvailable}
          onClick={() => {
            if (targetId !== null) jump(targetId);
          }}
        >
          입력한 합성 행으로 이동
        </button>
        <button
          type="button"
          disabled={!targetAvailable}
          onClick={() => {
            if (targetId !== null) {
              setSelectedId(targetId);
              jump(targetId);
            }
          }}
        >
          입력한 합성 행 선택
        </button>
        <button type="button" aria-pressed={mode === 'virtual'} onClick={() => setMode('virtual')}>
          가상 행 보기
        </button>
        <button type="button" aria-pressed={mode === 'all'} onClick={() => setMode('all')}>
          전체 행 읽기
        </button>
        <button
          type="button"
          disabled={!rows.some((row) => row.id === 'fixture-09999')}
          onClick={() => jump('fixture-09999')}
        >
          9999번 합성 행으로 이동
        </button>
        <button
          type="button"
          disabled={rows.length === 0}
          onClick={() => {
            const first = rows[0];
            if (first) jump(first.id);
          }}
        >
          첫 논리 행으로 이동
        </button>
        <button type="button" onClick={() => scrollHorizontal(-240)}>
          표 왼쪽으로 이동
        </button>
        <button type="button" onClick={() => scrollHorizontal(240)}>
          표 오른쪽으로 이동
        </button>
      </div>
      {targetId === null ? (
        <p role="alert">대상 번호는 0부터 9999까지의 정수로 입력하세요.</p>
      ) : null}
      <p role="status" aria-label="합성 표 상태">
        적재 {roster.length}행 · 필터 결과 {rows.length}행 · 서버 전체 알 수 없음 · 선택{' '}
        {selectedId ?? '없음'}
        {selectedId !== null && !rows.some((row) => row.id === selectedId)
          ? ' · 선택 행은 현재 필터 밖'
          : ''}
      </p>
      {mode === 'all' ? (
        <p>
          전체 행 읽기는 모든 메모와 선택 상태를 표시합니다. 행 선택·이동은 위 대상 번호 controls를
          사용하고 메모 펼치기·행별 필터 동작은 가상 행 보기에서 계속할 수 있습니다.
        </p>
      ) : null}
      <p aria-label="표 스크롤 기준">기준 행 {scrollState.scrollAnchor?.id ?? '없음'}</p>
      <div
        ref={viewportRef}
        className={styles.viewport}
        role="region"
        aria-label="합성 표 스크롤"
        onScroll={rememberScroll}
        data-viewport-width={width}
        data-virtual-total-height={virtual ? virtualizer.totalSize : undefined}
      >
        <table
          className={styles.table}
          aria-label="독립 합성 10000행 표"
          aria-rowcount={rows.length + 1}
        >
          <caption>
            독립 개발 fixture · 현재 필터의 논리 행 전체, 가상 모드는 화면 근처 행과 focus 행만
            DOM에 표시
          </caption>
          <thead>
            <tr aria-rowindex={1}>
              <th
                scope="col"
                aria-sort={
                  sorting[0]?.id === 'id' ? (sorting[0].desc ? 'descending' : 'ascending') : 'none'
                }
              >
                <button type="button" onClick={() => sortBy('id')}>
                  합성 ID 정렬
                </button>
              </th>
              <th
                scope="col"
                aria-sort={
                  sorting[0]?.id === 'distanceKm'
                    ? sorting[0].desc
                      ? 'descending'
                      : 'ascending'
                    : 'none'
                }
              >
                <button type="button" onClick={() => sortBy('distanceKm')}>
                  합성 거리 정렬
                </button>
              </th>
              <th scope="col">한글 메모</th>
              <th scope="col">명시 선택·필터 대안</th>
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
      {rows.length === 0 ? (
        <p>검색 결과가 없습니다. 적재된 10,000행이 삭제된 것은 아닙니다.</p>
      ) : null}
    </section>
  );
}
