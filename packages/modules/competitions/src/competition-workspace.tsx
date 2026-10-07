'use client';

import {
  createContext,
  use,
  type ComponentType,
  useEffect,
  useMemo,
  useRef,
  useState,
  useId,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useQueryClient,
  useQuery,
} from '@tanstack/react-query';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import type { RaceListCursor, RaceListQueryInput } from '@workout/contracts/race-queries';
import type { RaceEvent } from '@workout/contracts/races';
import type { RaceEventValues } from '@workout/contracts/race-commands';
import type { RaceCommandResult } from '@workout/contracts/race-commands';
import { ZodError } from 'zod';
import { createRaceApi, RaceRequestError, type RaceApi } from './race-api';
import { competitionRelationsSchema, type CompetitionRelations } from './competition-relations';
export type { CompetitionRelations } from './competition-relations';
import {
  eventDraft,
  eventFields,
  parseEvent,
  resultDraft,
  resultFields,
  parseResult,
  parseResultV2,
  bestDraft,
  bestFields,
  parseBest,
  type Draft,
  type Field,
} from './race-forms';
import {
  calculateRacePersonalBests,
  type RacePersonalBestPolicy,
  type RacePersonalBestExclusion,
} from './race-personal-bests';
import type {
  RaceResultCompatibleRead,
  RaceResultValuesV2,
} from '@workout/contracts/race-result-v2';
import type { CompetitionsProofApi } from './competitions-proof-api';
import { ProofSelector, selectedProofRefs, type ProofChoice } from './proof-selector';
import styles from './competitions.module.css';

export type CompetitionSection = 'events' | 'results' | 'training-bests';

export interface CompetitionWorkspaceProps {
  /** URL state belongs to the host; omitted section shows the complete workspace. */
  resultEditing?: { results: RaceApi['resultsV2']; proofs: CompetitionsProofApi };
  relations?: CompetitionRelations;
  section?: CompetitionSection;
  onSectionChange?: (section: CompetitionSection) => void;
  onRaceOpen?: (raceId: string) => void;
  athleteId: string | null;
  sessionId: string;
  transport: AuthenticatedTransport;
  /** Inject a cryptographically random command key for deterministic host tests. */
  newCommandKey?: () => string;
}
export function CompetitionWorkspace(props: CompetitionWorkspaceProps) {
  if (props.athleteId === null || props.athleteId.length === 0 || props.sessionId.length === 0)
    return <p role="status">로그인 후 대회와 기록을 관리할 수 있습니다.</p>;
  return (
    <Lifetime
      key={JSON.stringify([props.athleteId, props.sessionId])}
      {...props}
      athleteId={props.athleteId}
    />
  );
}
function Lifetime(props: CompetitionWorkspaceProps & { athleteId: string }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      }),
  );
  useEffect(
    () => () => {
      void client.cancelQueries();
      client.clear();
    },
    [client],
  );
  const api = useMemo(() => createRaceApi(props.transport), [props.transport]);
  return (
    <QueryClientProvider client={client}>
      <WorkspaceContent {...props} api={api} />
    </QueryClientProvider>
  );
}
function WorkspaceContent(props: CompetitionWorkspaceProps & { athleteId: string; api: RaceApi }) {
  const { api } = props;
  const scope = [props.athleteId, props.sessionId];
  const commandKey = props.newCommandKey ?? (() => crypto.randomUUID());
  const relations =
    props.relations === undefined ? undefined : competitionRelationsSchema.parse(props.relations);
  const eventListing = useInfiniteQuery({
    queryKey: ['competitions', ...scope, 'race-event'],
    initialPageParam: null as RaceListCursor | null,
    queryFn: ({ pageParam, signal }) => api.events.list({ limit: 50, cursor: pageParam }, signal),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const eventChoices = eventListing.data?.pages.flatMap((page) =>
    page.items.map((event) => ({ id: event.id, label: `${event.title} · ${event.localDate}` })),
  );
  return (
    <section className={styles.workspace} aria-label="대회 및 기록 관리">
      <header>
        <h1>대회와 기록</h1>
        <p>
          대회 계획, 실제 대회 결과, 훈련 기록을 따로 관리합니다. 빈 값은 미상이며 0초와 구분합니다.
        </p>
      </header>
      {props.onSectionChange ? (
        <nav aria-label="대회 및 기록 화면">
          <button
            type="button"
            aria-pressed={props.section === 'events'}
            onClick={() => props.onSectionChange?.('events')}
          >
            목표 대회
          </button>
          <button
            type="button"
            aria-pressed={props.section === 'results'}
            onClick={() => props.onSectionChange?.('results')}
          >
            실제 대회 결과
          </button>
          <button
            type="button"
            aria-pressed={props.section === 'training-bests'}
            onClick={() => props.onSectionChange?.('training-bests')}
          >
            훈련 기록
          </button>
        </nav>
      ) : null}
      <aside className={styles.notice}>
        <h2>PB 포함 기준 · 직접 입력한 대회 기록 포함</h2>
        <p>
          직접 입력한 대회 기록도 PB 인정 대상입니다. 링크나 인증 자료가 첨부되면 첨부 마크를
          표시하며, 첨부만으로 진위 확인 완료를 뜻하지 않습니다. 기기 추정 split은 자동으로 PB에
          포함하지 않습니다. 원기록은 유지합니다. 현재 목록은 저장 ID 순서이며 PB 순위가 아닙니다.
          아래에서 비교 기준을 직접 선택해 PB를 계산할 수 있습니다. Chip/Gun 및 거리별 기본 비교
          기준은 아직 확정되지 않았습니다.
        </p>
        <p>
          기존 대회 날짜는 대회 상세에서 전체 영향을 검토한 뒤 별도로 승인합니다. 날짜 외 정보
          저장은 계획을 적용하지 않습니다.
        </p>
      </aside>
      <FamilyPanel
        display={props.section === undefined || props.section === 'events' ? 'active' : 'inactive'}
        title="목표 대회"
        family="race-event"
        api={api.events}
        scope={scope}
        commandKey={commandKey}
        makeDraft={eventDraft}
        Editor={EventRecordEditor}
        onOpen={props.onRaceOpen}
        fields={(draft) => eventFields(draft, relations)}
        parse={parseEvent}
        summary={(record) => (
          <>
            <h3>{record.title}</h3>
            <p>
              {record.localDate} · {record.localStartTime ?? '출발 시간 미상'} · {record.timezone} ·{' '}
              {record.locationName ?? '장소 미상'}
            </p>
            <p>
              {record.distance.kind === 'standard'
                ? record.distance.class
                : `${record.distance.label} (${record.distance.nominalMeters ?? '미상'} m)`}{' '}
              · 우선순위 {record.priority ?? '미상'} · {record.participation}
            </p>
            <p>
              목표 {record.targetSeconds ?? '미상'} 초 · Plan{' '}
              {record.planVersionId === null
                ? '연결 없음'
                : (relations?.plans?.find((choice) => choice.id === record.planVersionId)?.label ??
                  '연결된 계획')}
            </p>
            <p>
              코스{' '}
              {record.course === null
                ? '연결 없음'
                : (relations?.courses?.find(
                    (choice) =>
                      choice.ref.courseId === record.course?.courseId &&
                      choice.ref.courseRevision === record.course.courseRevision &&
                      choice.ref.revisionId === record.course.revisionId,
                  )?.label ?? '고정 버전 코스 연결됨')}
            </p>
            {record.officialUrl ? (
              <a href={record.officialUrl} rel="noreferrer" target="_blank">
                공식 대회 안내
              </a>
            ) : null}
          </>
        )}
      />
      {props.section === 'results' && eventListing.hasNextPage ? (
        <div className={styles.notice}>
          <p>연결 대회 선택 목록을 일부 불러왔습니다. 추가 대회를 불러와 선택할 수 있습니다.</p>
          <button
            type="button"
            disabled={eventListing.isFetchingNextPage}
            onClick={() => {
              void eventListing.fetchNextPage();
            }}
          >
            연결 대회 더 불러오기
          </button>
          {eventListing.isError ? <p role="alert">{readableError(eventListing.error)}</p> : null}
        </div>
      ) : null}
      {props.resultEditing ? (
        <ResultPanel
          display={
            props.section === undefined || props.section === 'results' ? 'active' : 'inactive'
          }
          capability={props.resultEditing}
          legacy={api.results}
          scope={scope}
          commandKey={commandKey}
          relations={relations}
          eventChoices={eventChoices}
        />
      ) : (
        <FamilyPanel
          display={
            props.section === undefined || props.section === 'results' ? 'active' : 'inactive'
          }
          title="실제 대회 결과"
          family="race-result"
          api={api.results}
          scope={scope}
          commandKey={commandKey}
          makeDraft={resultDraft}
          fields={(draft) => resultFields(draft, relations, eventChoices)}
          parse={parseResult}
          summary={(record) => (
            <>
              <h3>{record.localDate} 대회 결과</h3>
              <p>
                {record.timezone} · 대회{' '}
                {record.raceEventId === null
                  ? '연결 없음'
                  : (eventChoices?.find((choice) => choice.id === record.raceEventId)?.label ??
                    '연결된 대회')}
              </p>
              <p>
                출처 {record.source.kind}
                {record.source.kind === 'official'
                  ? ` · 제출된 출처 ${record.source.authority} · ${record.source.verifiedAt === null ? '검토 시각 미상' : `검토 시각 기록 ${record.source.verifiedAt}`}`
                  : record.source.kind === 'device'
                    ? ` · ${record.source.providerLabel}`
                    : ''}
              </p>
              {record.source.kind === 'official' ? (
                <p>
                  인증 자료 첨부 · 링크. 제출된 출처와 검토 시각만으로 기록의 진위가 확인되었다고
                  판단하지 않습니다.
                </p>
              ) : null}
              {record.source.kind === 'official' ? (
                <a href={record.source.resultUrl} rel="noreferrer" target="_blank">
                  첨부 기록 링크
                </a>
              ) : null}
              <p>
                Chip {record.chipSeconds ?? '미상'} 초 · Gun {record.gunSeconds ?? '미상'} 초
              </p>
              <p>
                공식 {record.officialDistanceMeters ?? '미상'} m · 기기{' '}
                {record.deviceDistanceMeters ?? '미상'} m
              </p>
              <p>
                실제 Activity{' '}
                {record.linkedActivityId === null
                  ? '연결 없음'
                  : (relations?.activities?.find((choice) => choice.id === record.linkedActivityId)
                      ?.label ?? '연결된 실제 활동')}{' '}
                · 날씨 {record.weatherNote ?? '미상'}
              </p>
            </>
          )}
        >
          {({ records, state }) => <PersonalBestComparison records={records} state={state} />}
        </FamilyPanel>
      )}
      <FamilyPanel
        display={
          props.section === undefined || props.section === 'training-bests' ? 'active' : 'inactive'
        }
        title="훈련 기록"
        family="training-best"
        api={api.trainingBests}
        scope={scope}
        commandKey={commandKey}
        makeDraft={bestDraft}
        fields={(draft) => bestFields(draft, relations)}
        parse={parseBest}
        summary={(record) => (
          <>
            <h3>{record.observedAt} 훈련 기록</h3>
            <p>
              출처 {record.source.kind}
              {record.source.kind === 'activity'
                ? ` · ${relations?.activities?.find((choice) => record.source.kind === 'activity' && choice.id === record.source.activityId)?.label ?? '연결된 실제 활동'}`
                : ''}{' '}
              · 기준 {record.basis}
            </p>
            <p>
              {record.distanceMeters ?? '미상'} m · {record.elapsedSeconds ?? '미상'} 초
            </p>
          </>
        )}
      />
    </section>
  );
}
function readableError(error: unknown): string {
  if (error instanceof Error && error.message === 'PROOF_CONFIRMATION_REQUIRED')
    return '기존 증빙을 정확 버전으로 다시 확인하거나 명시적으로 연결 해제하세요.';
  if (error instanceof ZodError)
    return '입력 형식 또는 서버 응답이 올바르지 않습니다. 날짜, 시간대, 연결 항목과 값을 확인하세요.';
  if (error instanceof RaceRequestError) {
    switch (error.code) {
      case 'RACE_PLAN_IMPACT_REQUIRED':
        return '연결 Plan의 날짜 변경 영향 검토와 별도 승인이 필요합니다. 초안은 유지됩니다.';
      case 'RACE_CURSOR_STALE':
        return '목록이 변경되었습니다. 목록 새로고침으로 처음부터 확인하세요.';
      case 'REVISION_CONFLICT':
      case 'STALE_REVISION':
        return '다른 변경과 충돌했습니다. 초안을 유지하고 최신 목록을 확인하세요.';
      case 'IDEMPOTENCY_CONFLICT':
        return '같은 저장 키의 내용이 달라 충돌했습니다. 초안을 확인하세요.';
      case 'APP_CONSENT_REQUIRED':
        return '앱 저장·처리 동의가 필요합니다. 계정에서 동의 상태를 확인하세요. 초안은 유지됩니다.';
      default:
        return `요청을 완료하지 못했습니다 (${error.code}). 초안은 유지됩니다.`;
    }
  }
  return '연결을 확인한 뒤 다시 시도하세요. 초안은 유지됩니다.';
}
type RecordHead = { id: string; revision: number };
type Page<R> = { items: R[]; nextCursor: RaceListCursor | null };
type PanelApi<R, V> = {
  read: (id: string, signal?: AbortSignal) => Promise<R>;
  list: (query: RaceListQueryInput, signal?: AbortSignal) => Promise<Page<R>>;
  create: (
    input: { values: V; idempotencyKey: string },
    signal?: AbortSignal,
  ) => Promise<RaceCommandResult>;
  update: (
    id: string,
    input: { values: V; expectedRevision: number; idempotencyKey: string },
    signal?: AbortSignal,
  ) => Promise<RaceCommandResult>;
  delete: (
    id: string,
    input: { expectedRevision: number; idempotencyKey: string },
    signal?: AbortSignal,
  ) => Promise<RaceCommandResult>;
};
function FamilyPanel<R extends RecordHead, V>({
  display,
  title,
  family,
  api,
  scope,
  commandKey,
  makeDraft,
  fields,
  parse,
  summary,
  children,
  Editor = RecordEditor,
  onOpen,
}: {
  display: 'active' | 'inactive';
  title: string;
  family: string;
  api: PanelApi<R, V>;
  scope: string[];
  commandKey: () => string;
  makeDraft: (record?: R) => Draft;
  fields: (draft: Draft) => readonly Field[];
  parse: (draft: Draft) => V;
  summary: (record: R) => ReactNode;
  Editor?: ComponentType<RecordEditorProps<V> & { record?: R | undefined }>;
  onOpen?: ((recordId: string) => void) | undefined;
  children?: (data: {
    records: readonly R[];
    state: 'pending' | 'error' | 'partial' | 'complete';
  }) => ReactNode;
}) {
  const queryClient = useQueryClient();
  const queryKey = ['competitions', ...scope, family];
  const listing = useInfiniteQuery({
    queryKey,
    initialPageParam: null as RaceListCursor | null,
    queryFn: ({ pageParam, signal }) => api.list({ limit: 50, cursor: pageParam }, signal),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const [editor, setEditor] = useState<{ kind: 'create' } | { kind: 'edit'; record: R } | null>(
    null,
  );
  const [latestShown, setLatestShown] = useState(false);
  const review = useQuery({
    queryKey: [...queryKey, 'revision-preview', editor?.kind === 'edit' ? editor.record.id : null],
    enabled: false,
    queryFn: ({ signal }) => {
      if (editor?.kind !== 'edit') throw new Error('NO_EDIT_SELECTION');
      return api.read(editor.record.id, signal);
    },
  });
  const latest = latestShown ? review.data : undefined;
  const [status, setStatus] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<R | null>(null);
  const alive = useRef(true);
  const pendingControllers = useRef(new Set<AbortController>());
  const deleteKeys = useRef(new Map<string, string>());
  useEffect(() => {
    alive.current = true;
    const controllers = pendingControllers.current;
    const keys = deleteKeys.current;
    return () => {
      alive.current = false;
      for (const controller of controllers) controller.abort();
      controllers.clear();
      keys.clear();
    };
  }, []);
  async function loadLatest() {
    const result = await review.refetch();
    if (!alive.current) return;
    if (result.error) setStatus(readableError(result.error));
    else setLatestShown(true);
  }
  async function remove(record: R) {
    if (deleting !== null) return;
    const ref = `${record.id}:${record.revision}`;
    const key = deleteKeys.current.get(ref) ?? commandKey();
    deleteKeys.current.set(ref, key);
    const controller = new AbortController();
    pendingControllers.current.add(controller);
    setDeleting(record.id);
    setStatus('');
    try {
      await api.delete(
        record.id,
        { expectedRevision: record.revision, idempotencyKey: key },
        controller.signal,
      );
      if (!alive.current) return;
      setStatus('삭제가 서버에 반영되었습니다.');
      setDeleteTarget(null);
      if (editor?.kind === 'edit' && editor.record.id === record.id) setEditor(null);
      await queryClient.resetQueries({ queryKey });
    } catch (error) {
      if (alive.current) setStatus(readableError(error));
    } finally {
      pendingControllers.current.delete(controller);
      if (alive.current) setDeleting(null);
    }
  }
  const records = listing.data?.pages.flatMap((page) => page.items) ?? [];
  const listingState = listing.isError
    ? 'error'
    : listing.isPending || listing.isFetching
      ? 'pending'
      : listing.hasNextPage
        ? 'partial'
        : 'complete';
  return (
    <section className={styles.panel} aria-label={title} hidden={display === 'inactive'}>
      <h2>{title}</h2>
      {family === 'race-event' && !onOpen ? (
        <p role="status">
          이 화면에는 상세 이동이 제공되지 않아 기존 대회 날짜를 변경할 수 없습니다.
        </p>
      ) : null}
      {children?.({ records, state: listingState })}
      <div className={styles.actions}>
        <button
          type="button"
          onClick={() => setEditor({ kind: 'create' })}
          disabled={editor !== null}
        >
          새 {title} 등록
        </button>
        <button
          type="button"
          onClick={() => {
            void queryClient.resetQueries({ queryKey });
          }}
        >
          목록 새로고침
        </button>
      </div>
      {listing.isPending ? <p role="status">{title} 불러오는 중입니다.</p> : null}
      {listing.isError ? (
        <p role="alert">
          {records.length > 0 ? '일부 목록만 표시합니다. ' : ''}
          {readableError(listing.error)}
        </p>
      ) : null}
      {listing.isSuccess && records.length === 0 ? <p>저장한 {title}이 없습니다.</p> : null}
      <ul className={styles.list}>
        {records.map((record) => (
          <li className={styles.card} key={record.id}>
            {summary(record)}
            <p className={styles.meta}>revision {record.revision}</p>
            <div className={styles.actions}>
              {onOpen ? (
                <button
                  type="button"
                  disabled={editor !== null || deleting !== null}
                  onClick={() => onOpen(record.id)}
                >
                  대회 상세 · 날짜 변경 검토
                </button>
              ) : null}
              <button
                type="button"
                disabled={editor !== null}
                onClick={() => setEditor({ kind: 'edit', record })}
              >
                편집
              </button>
              <button type="button" onClick={() => setDeleteTarget(record)}>
                삭제
              </button>
            </div>
          </li>
        ))}
      </ul>
      {listing.hasNextPage ? (
        <button
          type="button"
          disabled={listing.isFetchingNextPage}
          onClick={() => {
            void listing.fetchNextPage();
          }}
        >
          다음 {title} 보기
        </button>
      ) : null}
      {deleteTarget ? (
        <div className={styles.notice}>
          <p>이 기록을 삭제하시겠습니까? 연결된 실제 활동이나 계획을 삭제하는 동작은 아닙니다.</p>
          <button
            type="button"
            disabled={deleting !== null}
            onClick={() => {
              void remove(deleteTarget);
            }}
          >
            삭제 확인
          </button>
          <button type="button" disabled={deleting !== null} onClick={() => setDeleteTarget(null)}>
            삭제 취소
          </button>
        </div>
      ) : null}
      <p role="status">{status}</p>
      {editor ? (
        <Editor
          record={editor.kind === 'edit' ? editor.record : undefined}
          key={editor.kind === 'edit' ? editor.record.id : 'new'}
          title={title}
          initial={makeDraft(editor.kind === 'edit' ? editor.record : undefined)}
          fields={fields}
          parse={parse}
          commandKey={commandKey}
          cancel={() => {
            setEditor(null);
            setLatestShown(false);
          }}
          commandBasis={
            editor.kind === 'edit' ? `${editor.record.id}:${editor.record.revision}` : 'create'
          }
          revisionReview={
            editor.kind === 'edit' ? (
              <div className={styles.notice}>
                <p>
                  편집 기준 revision {editor.record.revision}. 최신 값을 읽어 비교한 뒤에만 기준을
                  바꿀 수 있습니다.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    void loadLatest();
                  }}
                >
                  최신 기록 확인
                </button>
                {latest?.id === editor.record.id ? (
                  <>
                    <h4>서버의 최신 기록 · revision {latest.revision}</h4>
                    {summary(latest)}
                    <button
                      type="button"
                      onClick={() => {
                        setEditor({ kind: 'edit', record: latest });
                        setLatestShown(false);
                      }}
                    >
                      비교 완료 · 초안 유지하며 최신 revision 채택
                    </button>
                  </>
                ) : null}
              </div>
            ) : null
          }
          commit={async (values, key, signal) => {
            const result =
              editor.kind === 'create'
                ? await api.create({ values, idempotencyKey: key }, signal)
                : await api.update(
                    editor.record.id,
                    { values, expectedRevision: editor.record.revision, idempotencyKey: key },
                    signal,
                  );
            if (!alive.current) return;
            setStatus(`저장이 서버에 반영되었습니다 (revision ${result.revision}).`);
            setEditor(null);
            void queryClient.resetQueries({ queryKey });
          }}
        />
      ) : null}
    </section>
  );
}
const pbExclusions: Record<RacePersonalBestExclusion, string> = {
  device_source: '기기 추정 출처',
  outside_period: '비교 기간 밖',
  after_cutoff: '기준일 이후',
  distance_unknown: '공식 거리 미상',
  distance_not_standard: '선택한 표준 종목 거리 아님',
  time_unknown: '시간 미상',
  time_zero: '0초 기록',
};
/** Consumes the panel's existing query pages. Only comparison inputs are local;
 * server records and derived PB results are never copied into private state. */
function PersonalBestComparison({
  records,
  state,
}: {
  records: readonly RaceResultCompatibleRead[];
  state: 'pending' | 'error' | 'partial' | 'complete';
}) {
  const uid = useId();
  const [distance, setDistance] = useState('');
  const [time, setTime] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [cutoff, setCutoff] = useState('');
  const [policy, setPolicy] = useState<RacePersonalBestPolicy | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  let comparison: ReturnType<typeof calculateRacePersonalBests> | null = null;
  let resultError: string | null = null;
  if (policy !== null && state !== 'pending' && state !== 'error') {
    try {
      comparison = calculateRacePersonalBests({ records, policy });
    } catch {
      resultError =
        '기록의 형식 또는 비교 범위가 한도를 초과했습니다. 전체 PB를 계산할 수 없습니다.';
    }
  }
  function compare(event: FormEvent) {
    event.preventDefault();
    if (
      (distance !== 'standard' && distance !== 'exact') ||
      !['chip', 'gun', 'both'].includes(time) ||
      cutoff === ''
    ) {
      setInputError('거리, 시간 기준과 기준일을 직접 선택하세요.');
      return;
    }
    const timeKinds: ('chip' | 'gun')[] =
      time === 'both' ? ['chip', 'gun'] : time === 'chip' ? ['chip'] : ['gun'];
    try {
      const valid = calculateRacePersonalBests({
        records: [],
        policy: {
          distance: { kind: distance },
          timeKinds,
          period: { from: from || null, to: to || null, cutoff },
        },
      }).policy;
      setPolicy(valid);
      setInputError(null);
    } catch {
      setInputError('비교 날짜와 기간을 확인하세요.');
    }
  }
  return (
    <section aria-label="거리별 PB 비교">
      <h3>거리별 PB 비교</h3>
      <p>비교 입력은 이 화면에만 적용됩니다. 기본 정책이나 기록을 저장하지 않습니다.</p>
      <form className={styles.form} onSubmit={compare}>
        <fieldset>
          <legend>비교 기준</legend>
          <div className={styles.field}>
            <label htmlFor={`${uid}-distance`}>PB 거리 기준</label>
            <select
              id={`${uid}-distance`}
              value={distance}
              onChange={(e) => setDistance(e.target.value)}
            >
              <option value="">직접 선택</option>
              <option value="standard">표준 종목의 정확한 거리</option>
              <option value="exact">공식 거리의 정확한 m 값</option>
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor={`${uid}-time`}>PB 시간 기준</label>
            <select id={`${uid}-time`} value={time} onChange={(e) => setTime(e.target.value)}>
              <option value="">직접 선택</option>
              <option value="chip">Chip</option>
              <option value="gun">Gun</option>
              <option value="both">Chip · Gun 각각 비교</option>
            </select>
          </div>
          <div className={styles.field}>
            <label htmlFor={`${uid}-from`}>PB 기간 시작 (선택)</label>
            <input
              id={`${uid}-from`}
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor={`${uid}-to`}>PB 기간 끝 (선택)</label>
            <input
              id={`${uid}-to`}
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor={`${uid}-cutoff`}>PB 기준일</label>
            <input
              id={`${uid}-cutoff`}
              type="date"
              value={cutoff}
              onChange={(e) => setCutoff(e.target.value)}
            />
          </div>
        </fieldset>
        <button type="submit">PB 비교 적용</button>
      </form>
      {inputError ? <p role="alert">{inputError}</p> : null}
      {state === 'pending' ? (
        <p role="status">기록을 불러오는 중입니다. PB 결과는 갱신 후 표시됩니다.</p>
      ) : state === 'error' ? (
        <p role="status">
          기록을 불러오지 못해 PB 결과를 표시할 수 없습니다. 목록 새로고침으로 다시 확인하세요.
        </p>
      ) : null}
      {policy === null ? (
        <p>비교 기준을 선택하고 적용하세요.</p>
      ) : (
        <p>
          적용 기준: {policy.distance.kind === 'standard' ? '표준 종목' : '정확한 m 값'} ·{' '}
          {policy.timeKinds.map((k) => (k === 'chip' ? 'Chip' : 'Gun')).join(' · ')} ·{' '}
          {policy.period.from ?? '시작 제한 없음'} ~ {policy.period.to ?? '끝 제한 없음'} · 기준일{' '}
          {policy.period.cutoff}
        </p>
      )}
      {resultError ? <p role="alert">{resultError}</p> : null}
      {comparison ? (
        <>
          <p role="status">
            {state === 'partial'
              ? `불러온 ${records.length}개 기록 기준입니다. 다음 페이지가 있어 전체 PB 비교는 미완료입니다.`
              : `전체 ${records.length}개 기록을 비교했습니다.`}
          </p>
          <p>
            각 기록의 시간대에 따른 날짜로 비교합니다. 동률은 기록 날짜, 기록 ID 순으로 결정합니다.
            첨부 근거는 진위 확인 완료를 뜻하지 않습니다.
          </p>
          {comparison.groups.length === 0 ? (
            <p>선택한 기준의 PB 후보가 없습니다.</p>
          ) : (
            <ul aria-label="거리별 PB 결과">
              {comparison.groups.map((group) => (
                <li key={`${group.distance.meters}:${group.timeKind}`}>
                  <strong>
                    {group.distance.meters} m · {group.timeKind === 'chip' ? 'Chip' : 'Gun'} ·{' '}
                    {group.best.seconds} 초
                  </strong>
                  {' · '}
                  {group.best.record.localDate}
                  {' · '}
                  {group.best.record.source.kind === 'manual' ? '직접 입력' : '제출된 공식 출처'}
                  {group.best.evidence.linkPresent ? ' · 링크 근거 있음' : ''}
                  {group.best.evidence.availableAttachments > 0
                    ? ` · 자료 첨부 ${group.best.evidence.availableAttachments}개`
                    : ''}
                  {group.best.evidence.unavailableAttachments > 0
                    ? ` · 사용 불가 자료 ${group.best.evidence.unavailableAttachments}개`
                    : ''}
                </li>
              ))}
            </ul>
          )}
          <ul aria-label="PB 제외 사유">
            {Object.entries(pbExclusions).map(([reason, label]) => {
              const count = comparison.evaluations.filter((e) => e.exclusion === reason).length;
              return count > 0 ? (
                <li key={reason}>
                  {label}: {count}개 시간 비교
                </li>
              ) : null;
            })}
          </ul>
        </>
      ) : null}
    </section>
  );
}
type RecordEditorProps<V> = {
  title: string;
  initial: Draft;
  fields: (draft: Draft) => readonly Field[];
  parse: (draft: Draft) => V;
  commandKey: () => string;
  commandBasis: string;
  revisionReview: ReactNode;
  cancel: () => void;
  commit: (values: V, key: string, signal: AbortSignal) => Promise<void>;
  children?: ReactNode;
};
function EventRecordEditor(
  props: RecordEditorProps<RaceEventValues> & { record?: RaceEvent | undefined },
) {
  const record = props.record;
  if (!record) return <RecordEditor {...props} />;
  return (
    <RecordEditor
      {...props}
      fields={(draft) => props.fields(draft).filter((field) => field.key !== 'localDate')}
      commit={async (values, key, signal) => {
        if (values.localDate !== record.localDate)
          throw new RaceRequestError(409, 'RACE_PLAN_IMPACT_REQUIRED');
        await props.commit(values, key, signal);
      }}
    >
      <label>
        현지 날짜
        <input type="date" readOnly value={record.localDate} />
      </label>
      <p>날짜 변경은 편집을 저장하거나 취소한 뒤 대회 상세 · 날짜 변경 검토에서 진행하세요.</p>
    </RecordEditor>
  );
}
function RecordEditor<V>({
  title,
  initial,
  fields,
  parse,
  commandKey,
  commandBasis,
  revisionReview,
  cancel,
  commit,
  children,
}: RecordEditorProps<V>) {
  const [draft, setDraft] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const id = useId();
  const first = useRef<HTMLInputElement | null>(null);
  const command = useRef<{ json: string; key: string } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const composing = useRef(false);
  useEffect(() => {
    alive.current = true;
    first.current?.focus();
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || composing.current) return;
    setError('');
    try {
      const values = parse(draft);
      const json = JSON.stringify([commandBasis, values]);
      if (command.current?.json !== json) command.current = { json, key: commandKey() };
      controller.current = new AbortController();
      setPending(true);
      await commit(values, command.current.key, controller.current.signal);
    } catch (failure) {
      if (alive.current) setError(readableError(failure));
    } finally {
      if (alive.current) setPending(false);
    }
  }
  return (
    <form
      className={styles.form}
      aria-label={`${title} 편집 양식`}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
      }}
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <h3>{title} 입력</h3>
      <p>
        빈 선택값은 미상입니다. 시간은 초, 거리는 m 단위입니다. 코스는 선택한 고정 버전으로
        연결됩니다. 검토 시각은 서버만 기록하며, 시각만으로 진위 확인 완료를 뜻하지 않습니다.
      </p>
      <fieldset disabled={pending}>
        <legend>기록 값</legend>
        {revisionReview}
        {fields(draft).map((field, index) => {
          const fieldId = `${id}-${field.key}`;
          const onChange = (next: string) =>
            setDraft((prior) =>
              field.apply ? field.apply(prior, next) : { ...prior, [field.key]: next },
            );
          return (
            <div className={styles.field} key={field.key}>
              <label htmlFor={fieldId}>{field.label}</label>
              {field.options ? (
                <select
                  disabled={field.disabled}
                  id={fieldId}
                  value={draft[field.key] ?? ''}
                  onChange={(event) => onChange(event.target.value)}
                >
                  {field.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : field.type === 'textarea' ? (
                <textarea
                  id={fieldId}
                  value={draft[field.key] ?? ''}
                  onChange={(event) => onChange(event.target.value)}
                />
              ) : (
                <input
                  ref={index === 0 ? first : undefined}
                  id={fieldId}
                  type={field.type ?? 'text'}
                  step="any"
                  value={draft[field.key] ?? ''}
                  onChange={(event) => onChange(event.target.value)}
                />
              )}
              {field.description ? <p>{field.description}</p> : null}
            </div>
          );
        })}
        {children}
      </fieldset>
      {error ? <p role="alert">{error}</p> : null}
      <div className={styles.actions}>
        <button type="submit" disabled={pending}>
          {pending ? '서버 저장 중…' : '저장'}
        </button>
        <button type="button" disabled={pending} onClick={cancel}>
          편집 취소
        </button>
      </div>
    </form>
  );
}
export { RecordEditor as internalRecordEditor };

type ResultSubmission =
  | { mode: 'actual_only'; values: ReturnType<typeof parseResult> }
  | { mode: 'proofs'; values: RaceResultValuesV2 };
const ResultEditorContext = createContext<{
  proofs: CompetitionsProofApi;
  scope: readonly string[];
} | null>(null);
function ResultPanel({
  display,
  capability,
  legacy,
  scope,
  commandKey,
  relations,
  eventChoices,
}: {
  display: 'active' | 'inactive';
  capability: NonNullable<CompetitionWorkspaceProps['resultEditing']>;
  legacy: RaceApi['results'];
  scope: string[];
  commandKey: () => string;
  relations: CompetitionRelations | undefined;
  eventChoices: readonly { id: string; label: string }[] | undefined;
}) {
  const api: PanelApi<RaceResultCompatibleRead, ResultSubmission> = {
    read: (id, signal) => capability.results.read({ schemaVersion: 2, id }, signal),
    list: (query, signal) => capability.results.list({ ...query, schemaVersion: 2 }, signal),
    create: (input, signal) => {
      if (input.values.mode !== 'proofs') throw new Error('RESULT_CREATE_REQUIRES_V2');
      return capability.results.create(
        { schemaVersion: 2, values: input.values.values, idempotencyKey: input.idempotencyKey },
        signal,
      );
    },
    update: (id, input, signal) =>
      input.values.mode === 'actual_only'
        ? legacy.update(
            id,
            {
              values: input.values.values,
              expectedRevision: input.expectedRevision,
              idempotencyKey: input.idempotencyKey,
            },
            signal,
          )
        : capability.results.update(
            id,
            {
              schemaVersion: 2,
              values: input.values.values,
              expectedRevision: input.expectedRevision,
              idempotencyKey: input.idempotencyKey,
            },
            signal,
          ),
    delete: legacy.delete,
  };
  return (
    <ResultEditorContext value={{ proofs: capability.proofs, scope }}>
      <FamilyPanel
        display={display}
        title="실제 대회 결과"
        family="race-result-v2"
        api={api}
        scope={scope}
        commandKey={commandKey}
        makeDraft={resultDraft}
        fields={(draft) => resultFields(draft, relations, eventChoices)}
        parse={(draft): ResultSubmission => ({ mode: 'actual_only', values: parseResult(draft) })}
        Editor={ResultRecordEditor}
        summary={(record) => (
          <>
            <h3>{record.localDate} 대회 결과</h3>
            <p>
              {record.timezone} · 출처 {record.source.kind}
              {record.source.kind === 'official'
                ? ` · 제출된 출처 ${record.source.authority}`
                : record.source.kind === 'device'
                  ? ` · ${record.source.providerLabel}`
                  : ''}
            </p>
            <p>
              대회{' '}
              {record.raceEventId === null
                ? '연결 없음'
                : (eventChoices?.find((choice) => choice.id === record.raceEventId)?.label ??
                  '연결된 대회')}{' '}
              · 실제 Activity{' '}
              {record.linkedActivityId === null
                ? '연결 없음'
                : (relations?.activities?.find((choice) => choice.id === record.linkedActivityId)
                    ?.label ?? '연결된 실제 활동')}
            </p>
            {'schemaVersion' in record && record.source.kind === 'official' ? (
              <a href={record.source.resultUrl} target="_blank" rel="noreferrer">
                제출된 공식 기록 링크
              </a>
            ) : null}
            <p>
              Chip {record.chipSeconds ?? '미상'} 초 · Gun {record.gunSeconds ?? '미상'} 초
            </p>
            <p>
              공식 {record.officialDistanceMeters ?? '미상'} m · 기기{' '}
              {record.deviceDistanceMeters ?? '미상'} m
            </p>
            <p>날씨 {record.weatherNote ?? '미상'}</p>
            {'schemaVersion' in record ? (
              <>
                {record.proofs.link ? (
                  <a href={record.proofs.link} target="_blank" rel="noreferrer">
                    첨부 기록 링크
                  </a>
                ) : null}
                {record.proofs.attachments.length > 0 ? (
                  <p>
                    인증 자료 첨부 · 이미지/PDF {record.proofs.attachments.length}개 · 사용 불가{' '}
                    {record.proofs.attachments.filter((a) => a.status === 'unavailable').length}개
                  </p>
                ) : null}
              </>
            ) : record.source.kind === 'official' ? (
              <>
                <a href={record.source.resultUrl} target="_blank" rel="noreferrer">
                  첨부 기록 링크
                </a>
                <p>역사 검토 시각 {record.source.verifiedAt ?? '미상'}</p>
              </>
            ) : null}
            <p>첨부 자료와 제출 출처는 진위 확인 완료가 아닙니다.</p>
          </>
        )}
      >
        {({ records, state }) => <PersonalBestComparison records={records} state={state} />}
      </FamilyPanel>
    </ResultEditorContext>
  );
}
function ResultRecordEditor(
  props: RecordEditorProps<ResultSubmission> & { record?: RaceResultCompatibleRead | undefined },
) {
  const context = use(ResultEditorContext);
  if (context === null) throw new Error('RESULT_EDITOR_CAPABILITY_REQUIRED');
  return <ResultProofEditor {...props} proofs={context.proofs} scope={context.scope} />;
}
function ResultProofEditor(
  props: RecordEditorProps<ResultSubmission> & {
    record?: RaceResultCompatibleRead | undefined;
    proofs: CompetitionsProofApi;
    scope: readonly string[];
  },
) {
  const record = props.record;
  const [mode, setMode] = useState<'actual_only' | 'proofs'>(record ? 'actual_only' : 'proofs');
  const [link, setLink] = useState(
    record && 'schemaVersion' in record ? (record.proofs.link ?? '') : '',
  );
  const [choices, setChoices] = useState<readonly ProofChoice[]>(() =>
    record && 'schemaVersion' in record
      ? record.proofs.attachments.map((attachment) => ({ state: 'retained', attachment }))
      : [],
  );
  const uid = useId();
  return (
    <RecordEditor
      {...props}
      parse={(draft): ResultSubmission =>
        mode === 'actual_only'
          ? { mode, values: parseResult(draft) }
          : { mode, values: parseResultV2(draft, link, selectedProofRefs(choices)) }
      }
    >
      {record ? (
        <div className={styles.field}>
          <label htmlFor={`${uid}-mode`}>편집 범위</label>
          <select
            id={`${uid}-mode`}
            value={mode}
            onChange={(e) => setMode(e.target.value === 'proofs' ? 'proofs' : 'actual_only')}
          >
            <option value="actual_only">기록 값만 수정 · 기존 증빙 보존</option>
            <option value="proofs">증빙도 명시적으로 변경</option>
          </select>
        </div>
      ) : null}
      {mode === 'actual_only' ? (
        <p>기존 증빙 연결은 서버에서 그대로 보존합니다. 진위 검토 시각을 새로 만들지 않습니다.</p>
      ) : (
        <>
          <div className={styles.field}>
            <label htmlFor={`${uid}-link`}>증빙 HTTPS 링크 (선택)</label>
            <input
              id={`${uid}-link`}
              type="url"
              value={link}
              onChange={(e) => setLink(e.target.value)}
            />
          </div>
          <ProofSelector
            api={props.proofs}
            scope={props.scope}
            choices={choices}
            onChange={setChoices}
          />
        </>
      )}
    </RecordEditor>
  );
}
