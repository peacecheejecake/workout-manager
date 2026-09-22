import {
  Component,
  lazy,
  Suspense,
  useId,
  useRef,
  useState,
  type ReactNode,
  type ComponentProps,
} from 'react';
import { useStore } from 'zustand';
import type { Activity, ActivityDetailsRead } from '@workout/contracts/activity';
import type { ActivityDetails } from '@workout/contracts/activity-details';
import { Button } from '@workout/ui-foundation/button';
import { createDetailSelectionStore, type DetailSelectionStore } from './detail-selection';
import { useSharedDetailSelectionStore } from './detail-selection-provider';
import {
  detailsMatchActivity,
  lapTimeRange,
  lapOverlapsRange,
  recordInRange,
  recordTime,
  type TimeRange,
} from './detail-projection';
import type { DetailChart } from './detail-chart';
import styles from './activity-workbench.module.css';

const loadChart = () =>
  import('./detail-chart').then((module) => ({ default: module.DetailChart }));

const metric = (value: number | null, unit: string) =>
  value === null ? '미확인' : `${value} ${unit}`;
const time = (value: string | null) =>
  value === null ? '시각 미확인' : new Date(value).toISOString();

export function ActivityWorkbench({
  activity,
  read,
  panel,
}: {
  activity: Activity;
  read: ActivityDetailsRead;
  panel?: 'intervals' | 'source' | 'inactive';
}) {
  if (!detailsMatchActivity(activity, read))
    return panel === 'inactive' ? null : (
      <p role="alert">활동과 원본 상세의 버전이 다릅니다. 최신 상세를 다시 조회하세요.</p>
    );
  if (!read.details)
    return panel === 'inactive' ? null : (
      <p>저장된 원본 관측 상세가 없습니다. 요약 기록은 위에서 확인할 수 있습니다.</p>
    );
  const identity = JSON.stringify([
    activity.id,
    activity.revision,
    read.source.kind,
    read.source.sourceId,
    read.source.revision,
    read.source.contentHash,
  ]);
  return (
    <Workbench key={identity} details={read.details} read={read} {...(panel ? { panel } : {})} />
  );
}

function Workbench({
  details,
  read,
  panel,
}: {
  details: ActivityDetails;
  read: ActivityDetailsRead;
  panel?: 'intervals' | 'source' | 'inactive';
}) {
  // The shared store when an owner mounted one — the stored-track map reads the same
  // selection — and an own store otherwise, so this screen still works standalone.
  const shared = useSharedDetailSelectionStore();
  const [fallback] = useState(createDetailSelectionStore);
  const store = shared ?? fallback;
  const [view, setView] = useState<'overview' | 'laps' | 'source'>('overview');
  const visibleView = panel === 'intervals' && view === 'source' ? 'overview' : view;
  const [chartPage, setChartPage] = useState(0);
  const [recordPage, setRecordPage] = useState(0);
  const [lapPage, setLapPage] = useState(0);
  const recordIndex = useStore(store, (state) => state.recordIndex);
  const lapIndex = useStore(store, (state) => state.lapIndex);
  const range = useStore(store, (state) => state.range);
  const selectRecord = useStore(store, (state) => state.selectRecord);
  const selectLap = useStore(store, (state) => state.selectLap);
  const selectedRecord = details.records.find((record) => record.index === recordIndex);
  const selectedLap = details.laps.find((lap) => lap.index === lapIndex);
  const selectedPosition = details.records.findIndex((record) => record.index === recordIndex);
  const chartRecords = details.records.slice(chartPage * 500, (chartPage + 1) * 500);
  const selectionId = useId();
  function stepRecord(offset: number) {
    const position = selectedPosition < 0 ? 0 : selectedPosition + offset;
    const record = details.records[position];
    if (!record) return;
    selectRecord(record.index, recordTime(record));
    setRecordPage(Math.floor(position / 20));
    setChartPage(Math.floor(position / 500));
  }
  if (panel === 'inactive') return null;
  if (panel === 'source') return <SourceDetails details={details} read={read} />;
  return (
    <section className={styles.workspace} aria-label="원본 관측 워크벤치">
      <h3>원본 관측 워크벤치</h3>
      <p>
        원본 상세 관측입니다. 요약 정정값으로 관측을 바꾸거나 속도·페이스를 추정하지 않습니다. 모든
        시각은 UTC이며, 0과 미확인을 구분합니다.
      </p>
      <nav className={styles.actions} aria-label="원본 상세 보기">
        {(
          [
            ['overview', '관측 개요'],
            ['laps', '랩'],
            ['source', '상세 출처'],
          ] as const
        )
          .filter(([id]) => panel === undefined || id !== 'source')
          .map(([id, label]) => (
            <Button
              key={id}
              variant="secondary"
              aria-pressed={visibleView === id}
              onClick={() => setView(id)}
            >
              {label}
            </Button>
          ))}
      </nav>
      <section id={selectionId} className={styles.summary} aria-label="관측 선택 요약">
        <h4>관측 선택 요약</h4>
        {selectedRecord ? (
          <p>
            선택한 관측 {selectedRecord.index} · {time(selectedRecord.timestamp)} · 거리{' '}
            {metric(selectedRecord.distanceMeters, 'm')} · 심박{' '}
            {metric(selectedRecord.heartRateBpm, 'bpm')}
          </p>
        ) : null}
        {selectedLap ? (
          <p>
            선택한 랩 {selectedLap.index} · 시작 {time(selectedLap.startedAt)} · 경과 시간{' '}
            {metric(selectedLap.elapsedSeconds, '초')} · 타이머 시간{' '}
            {metric(selectedLap.timerSeconds, '초')}
          </p>
        ) : null}
        {range ? (
          <p>
            선택 구간 UTC: {new Date(range.start).toISOString()} –{' '}
            {new Date(range.end).toISOString()} (양끝 포함)
          </p>
        ) : selectedLap ? (
          <p>시작 시각 또는 경과 시간이 없어 랩 구간을 표시할 수 없습니다.</p>
        ) : (
          <p>선택 구간 없음</p>
        )}
        <div className={styles.actions}>
          <Button
            variant="secondary"
            disabled={!details.records.length || selectedPosition === 0}
            onClick={() => stepRecord(-1)}
          >
            이전 관측 선택
          </Button>
          <Button
            variant="secondary"
            disabled={!details.records.length || selectedPosition === details.records.length - 1}
            onClick={() => stepRecord(1)}
          >
            다음 관측 선택
          </Button>
          {selectedPosition >= 0 ? (
            <Button
              variant="secondary"
              onClick={() => {
                setView('overview');
                setRecordPage(Math.floor(selectedPosition / 20));
                setChartPage(Math.floor(selectedPosition / 500));
              }}
            >
              선택한 관측 페이지로 이동
            </Button>
          ) : null}
        </div>
      </section>
      <RangeControls store={store} />
      {visibleView === 'overview' ? (
        <section aria-label="관측 개요">
          <h4>거리·심박 관측</h4>
          <p>
            시각 또는 측정값이 없거나 시각이 중복·역행하면 선을 끊습니다. 선은 관측 연결이며 누락
            구간의 값을 보간하지 않습니다.
          </p>
          <p>
            차트 원본 순번 범위:{' '}
            {chartRecords.length
              ? `${chartRecords[0]?.index}–${chartRecords.at(-1)?.index}`
              : '없음'}{' '}
            · 전체 {details.records.length}개 중 {chartRecords.length}개 표시 (페이지당 최대 500개)
          </p>
          <Pagination
            label="차트"
            page={chartPage}
            total={details.records.length}
            size={500}
            onPage={setChartPage}
          />
          <Charts
            records={chartRecords}
            selected={recordIndex}
            range={range}
            onSelect={selectRecord}
          />
          <Pagination
            label="관측 표"
            page={recordPage}
            total={details.records.length}
            size={20}
            onPage={setRecordPage}
          />
          <Scrollable label="관측 표">
            <table className={styles.table}>
              <caption>원본 관측 표</caption>
              <thead>
                <tr>
                  <th>선택·원본 순번</th>
                  <th>관측 시각 UTC</th>
                  <th>거리 (m)</th>
                  <th>심박 (bpm)</th>
                </tr>
              </thead>
              <tbody>
                {details.records.slice(recordPage * 20, (recordPage + 1) * 20).map((record) => (
                  <tr
                    key={record.index}
                    data-selected={recordIndex === record.index}
                    data-in-range={range !== null && recordInRange(record, range)}
                  >
                    <td>
                      <Button
                        variant="secondary"
                        aria-pressed={recordIndex === record.index}
                        onClick={() => selectRecord(record.index, recordTime(record))}
                      >
                        관측 {record.index} 선택
                      </Button>
                    </td>
                    <td>{time(record.timestamp)}</td>
                    <td>{metric(record.distanceMeters, 'm')}</td>
                    <td>{metric(record.heartRateBpm, 'bpm')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scrollable>
          {!details.records.length ? <p>저장된 개별 관측이 없습니다.</p> : null}
        </section>
      ) : visibleView === 'laps' ? (
        <section aria-label="원본 랩">
          <h4>원본 랩</h4>
          <p>
            랩 구간은 시작 시각 + 경과 시간입니다. 작성 시각은 구간의 끝이 아니며 타이머 시간과도
            구분합니다.
          </p>
          <Pagination
            label="랩 표"
            page={lapPage}
            total={details.laps.length}
            size={20}
            onPage={setLapPage}
          />
          <Scrollable label="랩 표">
            <table className={styles.table}>
              <caption>원본 랩 표</caption>
              <thead>
                <tr>
                  <th>선택·원본 순번</th>
                  <th>시작 UTC</th>
                  <th>작성 UTC</th>
                  <th>경과 시간</th>
                  <th>타이머 시간</th>
                  <th>거리</th>
                  <th>평균 심박</th>
                  <th>최대 심박</th>
                </tr>
              </thead>
              <tbody>
                {details.laps.slice(lapPage * 20, (lapPage + 1) * 20).map((lap) => (
                  <tr
                    key={lap.index}
                    data-selected={lapIndex === lap.index}
                    data-in-range={range !== null && lapOverlapsRange(lap, range)}
                  >
                    <td>
                      <Button
                        variant="secondary"
                        aria-pressed={lapIndex === lap.index}
                        onClick={() => selectLap(lap.index, lapTimeRange(lap))}
                      >
                        랩 {lap.index} 선택
                      </Button>
                    </td>
                    <td>{time(lap.startedAt)}</td>
                    <td>{time(lap.recordedAt)}</td>
                    <td>{metric(lap.elapsedSeconds, '초')}</td>
                    <td>{metric(lap.timerSeconds, '초')}</td>
                    <td>{metric(lap.distanceMeters, 'm')}</td>
                    <td>{metric(lap.averageHeartRateBpm, 'bpm')}</td>
                    <td>{metric(lap.maximumHeartRateBpm, 'bpm')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scrollable>
          {!details.laps.length ? <p>저장된 랩이 없습니다.</p> : null}
        </section>
      ) : (
        <SourceDetails details={details} read={read} />
      )}
    </section>
  );
}

function SourceDetails({ details, read }: { details: ActivityDetails; read: ActivityDetailsRead }) {
  return (
    <section aria-label="상세 출처">
      <h4>상세 출처</h4>
      <dl>
        <dt>원본 종류</dt>
        <dd>{read.source.kind}</dd>
        <dt>원본 식별자</dt>
        <dd>{read.source.sourceId}</dd>
        <dt>원본 수정 번호</dt>
        <dd>{read.source.revision}</dd>
        <dt>원본 해시</dt>
        <dd>{read.source.contentHash}</dd>
        <dt>상세 스키마</dt>
        <dd>{details.schemaVersion}</dd>
        <dt>스트림 순번 / 세션 전체 순번 (0부터)</dt>
        <dd>
          {details.streamIndex} / {details.sessionIndex}
        </dd>
        <dt>세션 시작 UTC</dt>
        <dd>{time(details.startedAt)}</dd>
        <dt>세션 작성 UTC</dt>
        <dd>{time(details.recordedAt)}</dd>
        <dt>세션 경과 시간</dt>
        <dd>{metric(details.elapsedSeconds, '초')}</dd>
      </dl>
      <p>
        개별 관측·랩의 순번은 각 원본 스트림 안의 순서입니다. 작성 시각으로 운동 구간을 추정하지
        않습니다.
      </p>
    </section>
  );
}

function Pagination({
  label,
  page,
  total,
  size,
  onPage,
}: {
  label: string;
  page: number;
  total: number;
  size: number;
  onPage(page: number): void;
}) {
  const count = Math.max(1, Math.ceil(total / size));
  return (
    <div className={styles.actions}>
      <span>
        {label} {page + 1} / {count}페이지 · 전체 {total}개
      </span>
      <Button variant="secondary" disabled={page === 0} onClick={() => onPage(page - 1)}>
        {label} 이전 페이지
      </Button>
      <Button variant="secondary" disabled={page + 1 >= count} onClick={() => onPage(page + 1)}>
        {label} 다음 페이지
      </Button>
    </div>
  );
}
function Scrollable({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  return (
    <>
      <div className={styles.actions}>
        <Button
          variant="secondary"
          aria-controls={id}
          onClick={() => ref.current?.scrollBy({ left: -240, behavior: 'auto' })}
        >
          {label} 왼쪽 스크롤
        </Button>
        <Button
          variant="secondary"
          aria-controls={id}
          onClick={() => ref.current?.scrollBy({ left: 240, behavior: 'auto' })}
        >
          {label} 오른쪽 스크롤
        </Button>
      </div>
      <div
        id={id}
        ref={ref}
        className={styles.scroll}
        role="region"
        aria-label={`${label} 스크롤 영역`}
      >
        {children}
      </div>
    </>
  );
}
function RangeControls({ store }: { store: DetailSelectionStore }) {
  const start = useStore(store, (state) => state.rangeStart);
  const end = useStore(store, (state) => state.rangeEnd);
  const error = useStore(store, (state) => state.rangeError);
  const setStart = useStore(store, (state) => state.setRangeStart);
  const setEnd = useStore(store, (state) => state.setRangeEnd);
  const setError = useStore(store, (state) => state.setRangeError);
  const selectRange = useStore(store, (state) => state.selectRange),
    clear = useStore(store, (state) => state.clear);
  function apply() {
    const parsed: TimeRange = { start: Date.parse(`${start}Z`), end: Date.parse(`${end}Z`) };
    if (
      !start ||
      !end ||
      !Number.isFinite(parsed.start) ||
      !Number.isFinite(parsed.end) ||
      parsed.start > parsed.end
    ) {
      setError(true);
      return;
    }
    setError(false);
    selectRange(parsed);
  }
  return (
    <section aria-label="관측 구간 선택">
      <h4>관측 구간 선택</h4>
      <p>입력 시각은 기기 시간대가 아닌 UTC입니다. 선택은 원본을 수정하지 않습니다.</p>
      <div className={styles.fields}>
        <label>
          구간 시작 (UTC)
          <input
            type="datetime-local"
            step="0.001"
            value={start}
            onChange={(event) => setStart(event.target.value)}
          />
        </label>
        <label>
          구간 끝 (UTC)
          <input
            type="datetime-local"
            step="0.001"
            value={end}
            onChange={(event) => setEnd(event.target.value)}
          />
        </label>
      </div>
      <div className={styles.actions}>
        <Button variant="secondary" onClick={apply}>
          구간 적용
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            clear();
            setStart('');
            setEnd('');
            setError(false);
          }}
        >
          선택 해제
        </Button>
      </div>
      {error ? (
        <p role="alert">
          유효한 UTC 시작·끝 시각을 입력하세요. 끝 시각은 시작 시각 이후 또는 같은 시각이어야
          합니다.
        </p>
      ) : null}
    </section>
  );
}
function Charts(props: Omit<ComponentProps<typeof DetailChart>, 'metric'>) {
  const [chart, setChart] = useState(() => ({ Component: lazy(loadChart), attempt: 0 }));
  return (
    <ChartBoundary
      key={chart.attempt}
      onRetry={() =>
        setChart((previous) => ({ Component: lazy(loadChart), attempt: previous.attempt + 1 }))
      }
    >
      <Suspense
        fallback={<p role="status">관측 차트 불러오는 중… 표로 모든 값을 확인할 수 있습니다.</p>}
      >
        <chart.Component {...props} metric="distanceMeters" />
        <chart.Component {...props} metric="heartRateBpm" />
      </Suspense>
    </ChartBoundary>
  );
}
class ChartBoundary extends Component<
  { children: ReactNode; onRetry(): void },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <div role="alert">
        <p>차트를 불러오지 못했습니다. 관측 표에서 값을 확인하고 선택할 수 있습니다.</p>
        <Button variant="secondary" onClick={this.props.onRetry}>
          차트 다시 불러오기
        </Button>
      </div>
    ) : (
      this.props.children
    );
  }
}
