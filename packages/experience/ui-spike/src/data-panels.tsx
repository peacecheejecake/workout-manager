'use client';

import { useEffect, useId, useRef, useState } from 'react';
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
import { useEditor, useEditorState, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import * as echarts from 'echarts/core';
import { BarChart } from 'echarts/charts';
import { DataZoomComponent, GridComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { Button } from '@workout/ui-foundation/button';
import { TextAreaField, TextField } from '@workout/ui-foundation/text-field';
import { AdaptiveWorkspace } from '@workout/ui-foundation/adaptive-workspace';
import styles from './data-panels.module.css';

echarts.use([BarChart, GridComponent, DataZoomComponent, SVGRenderer]);
interface FixtureRow {
  id: string;
  title: string;
  distanceKm: number | null;
}
const fixtureRows: FixtureRow[] = [
  { id: 'fixture-a', title: '가상 러닝 A', distanceKm: 5 },
  { id: 'fixture-b', title: '가상 미확인 B', distanceKm: null },
  { id: 'fixture-c', title: '가상 0km C', distanceKm: 0 },
  { id: 'fixture-d', title: '가상 러닝 D', distanceKm: 8 },
];
const largeFixtureRows: FixtureRow[] = Array.from({ length: 1000 }, (_, index) => ({
  id: `large-${index}`,
  title: `가상 대량 ${String(index + 1).padStart(4, '0')}`,
  distanceKm: index % 17 === 0 ? null : index % 11 === 0 ? 0 : (index % 100) / 10,
}));
const features = tableFeatures({
  columnFilteringFeature,
  globalFilteringFeature,
  rowSortingFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
  filterFns: { includesString: filterFn_includesString },
  sortFns: { text: sortFn_text, basic: sortFn_basic },
});
const columnHelper = createColumnHelper<typeof features, FixtureRow>();
const columns = columnHelper.columns([
  columnHelper.accessor('title', { header: '활동명', sortFn: 'text', enableGlobalFilter: true }),
  columnHelper.accessor((row) => row.distanceKm ?? undefined, {
    id: 'distanceKm',
    header: '거리 (km)',
    sortFn: 'basic',
    sortUndefined: 'last',
    enableGlobalFilter: false,
  }),
]);

function FixtureChart({
  rows,
  selectedId,
  onSelect,
}: {
  rows: FixtureRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const descriptionId = useId();
  const [zoom, setZoom] = useState({ start: 0, end: 100 });
  const element = useRef<HTMLDivElement>(null);
  const instance = useRef<echarts.EChartsType | null>(null);
  useEffect(() => {
    const container = element.current;
    if (!container) return;
    let chart: echarts.EChartsType;
    try {
      chart = echarts.init(container, undefined, { renderer: 'svg' });
    } catch {
      container.textContent = '차트를 표시할 수 없습니다. 아래 표를 이용하세요.';
      return;
    }
    instance.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(container);
    return () => {
      observer.disconnect();
      instance.current = null;
      chart.dispose();
    };
  }, []);
  useEffect(() => {
    const chart = instance.current;
    if (!chart) return;
    const tokens = element.current ? getComputedStyle(element.current) : null;
    const ink = tokens?.getPropertyValue('--ink').trim() || '#182131';
    const accent = tokens?.getPropertyValue('--accent').trim() || '#6256b8';
    chart.setOption(
      {
        animation: false,
        grid: { left: 48, right: 16, top: 24, bottom: 64 },
        xAxis: {
          type: 'category',
          data: rows.map((row) => row.title),
          axisLabel: { color: ink, interval: 'auto', rotate: 20 },
        },
        yAxis: {
          type: 'value',
          name: 'km',
          min: 0,
          axisLabel: { color: ink },
          nameTextStyle: { color: ink },
        },
        dataZoom: [
          {
            type: 'inside',
            start: zoom.start,
            end: zoom.end,
            zoomOnMouseWheel: false,
            moveOnMouseMove: false,
          },
        ],
        series: [
          {
            type: 'bar',
            data: rows.map((row) => ({
              value: row.distanceKm,
              itemStyle: {
                color: accent,
                borderColor: ink,
                borderWidth: row.id === selectedId ? 3 : 0,
              },
            })),
          },
        ],
      },
      { notMerge: true },
    );
    const select = (event: unknown) => {
      if (
        typeof event !== 'object' ||
        event === null ||
        !('dataIndex' in event) ||
        typeof event.dataIndex !== 'number'
      )
        return;
      const row = rows[event.dataIndex];
      if (row) onSelect(row.id);
    };
    chart.on('click', select);
    return () => {
      chart.off('click', select);
    };
  }, [rows, selectedId, onSelect, zoom]);
  return (
    <div>
      <p id={descriptionId}>
        합성 거리 예시입니다. 미확인 값은 막대를 만들지 않고, 0km는 0으로 유지합니다. 아래 표에서
        동일한 값을 읽고 선택할 수 있습니다.
      </p>
      <div className={styles.toolbar}>
        <Button variant="secondary" onClick={() => setZoom({ start: 0, end: 20 })}>
          차트 확대
        </Button>
        <Button variant="secondary" onClick={() => setZoom({ start: 0, end: 100 })}>
          차트 전체 보기
        </Button>
        {zoom.end - zoom.start === 20 ? (
          <label>
            차트 구간 시작 (%)
            <input
              type="range"
              min="0"
              max="80"
              value={zoom.start}
              onChange={(event) => {
                const start = Number(event.target.value);
                setZoom({ start, end: start + 20 });
              }}
            />
          </label>
        ) : null}
      </div>
      <div
        ref={element}
        className={styles.chart}
        role="img"
        aria-label="가상 거리 차트"
        aria-describedby={descriptionId}
      />
    </div>
  );
}

function FixtureData() {
  const titleId = useId();
  const [fixtureSize, setFixtureSize] = useState<'small' | 'large'>('small');
  const data = fixtureSize === 'small' ? fixtureRows : largeFixtureRows;
  const [sorting, setSorting] = useState<SortingState>([]);
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const table = useTable({
    features,
    columns,
    data,
    getRowId: (row) => row.id,
    state: { sorting, globalFilter: filter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setFilter,
    globalFilterFn: 'includesString',
    enableSortingRemoval: false,
  });
  const rows = table.getRowModel().rows;
  const visibleRows = rows.map((row) => row.original);
  const selected = data.find((row) => row.id === selectedId);
  return (
    <section aria-labelledby={titleId}>
      <h2 id={titleId}>차트·표 연결 실험</h2>
      <div className={styles.toolbar}>
        <Button
          variant="secondary"
          aria-pressed={fixtureSize === 'small'}
          onClick={() => {
            setFixtureSize('small');
            setSelectedId(null);
            setFilter('');
          }}
        >
          기본 4행
        </Button>
        <Button
          variant="secondary"
          aria-pressed={fixtureSize === 'large'}
          onClick={() => {
            setFixtureSize('large');
            setSelectedId(null);
            setFilter('');
          }}
        >
          대량 1000행
        </Button>
      </div>
      <TextField
        label="활동 검색"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      <p role="status">
        표시 {rows.length}개 · 선택 {selected?.title ?? '없음'}
      </p>
      <FixtureChart rows={visibleRows} selectedId={selectedId} onSelect={setSelectedId} />
      <div className={styles.tableScroll} role="region" aria-label="가상 활동 표 스크롤">
        <table aria-label="가상 활동 표">
          <caption>개발용 합성 데이터 · 실제 운동 기록이 아닙니다.</caption>
          <thead>
            <tr>
              {table.getHeaderGroups()[0]?.headers.map((header) => (
                <th
                  key={header.id}
                  scope="col"
                  aria-sort={
                    header.column.getIsSorted() === 'asc'
                      ? 'ascending'
                      : header.column.getIsSorted() === 'desc'
                        ? 'descending'
                        : 'none'
                  }
                >
                  <Button variant="secondary" onClick={() => header.column.toggleSorting()}>
                    {header.column.id === 'title' ? '활동명 정렬' : '거리 정렬'}
                  </Button>
                </th>
              ))}
              <th scope="col">선택</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} data-selected={selectedId === row.id}>
                <th scope="row">{row.original.title}</th>
                <td>
                  {row.original.distanceKm === null ? '미확인' : `${row.original.distanceKm} km`}
                </td>
                <td>
                  <Button
                    variant="secondary"
                    aria-pressed={selectedId === row.id}
                    onClick={() => setSelectedId(row.id)}
                  >
                    {row.original.title} 선택
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 ? <p>검색 결과가 없습니다.</p> : null}
    </section>
  );
}

function DraftEditor() {
  const titleId = useId();
  const [serialized, setSerialized] = useState<string | null>(null);
  const editor = useEditor({
    extensions: [StarterKit.configure({ link: false })],
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '개발용 메모 초안' }] }],
    },
    immediatelyRender: false,
    editorProps: {
      attributes: { role: 'textbox', 'aria-label': '개발 메모 편집기', 'aria-multiline': 'true' },
    },
    onUpdate: () => setSerialized(null),
  });
  const boldActive = useEditorState({
    editor,
    selector: ({ editor: current }) => current?.isActive('bold') ?? false,
  });
  return (
    <section aria-labelledby={titleId}>
      <h2 id={titleId}>메모 편집기 실험</h2>
      <p>
        이 초안은 현재 화면 메모리에만 있습니다. 화면을 나가면 지워지며 서버에 저장하지 않습니다.
      </p>
      <div className={styles.toolbar}>
        <Button
          variant="secondary"
          disabled={!editor}
          aria-pressed={boldActive ?? false}
          onClick={() => editor?.chain().focus().toggleBold().run()}
        >
          굵게 전환
        </Button>
        <Button
          variant="secondary"
          disabled={!editor}
          onClick={() => editor?.chain().focus().undo().run()}
        >
          편집 실행 취소
        </Button>
      </div>
      <div className={styles.editor}>
        <EditorContent editor={editor} />
      </div>
      <Button
        disabled={!editor}
        onClick={() => {
          if (editor) setSerialized(JSON.stringify(editor.getJSON(), null, 2));
        }}
      >
        JSON 초안 확인
      </Button>
      {serialized !== null ? (
        <TextAreaField label="편집기 JSON 초안" value={serialized} readOnly rows={8} />
      ) : null}
    </section>
  );
}

/** Development fixture only; no providers, health data, approval, or persistence. */
export function DataPanels() {
  return (
    <div className={styles.root}>
      <p>개발용 UI 호환성 실험입니다. 차트와 표의 모든 데이터는 가상입니다.</p>
      <AdaptiveWorkspace>
        <FixtureData />
        <DraftEditor />
      </AdaptiveWorkspace>
    </div>
  );
}
