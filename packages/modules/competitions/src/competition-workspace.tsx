'use client';

import { useEffect, useMemo, useRef, useState, useId, type FormEvent, type ReactNode } from 'react';
import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useQueryClient,
  useQuery,
} from '@tanstack/react-query';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import type { RaceListCursor, RaceListQueryInput } from '@workout/contracts/race-queries';
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
  bestDraft,
  bestFields,
  parseBest,
  type Draft,
  type Field,
} from './race-forms';
import styles from './competitions.module.css';

export type CompetitionSection = 'events' | 'results' | 'training-bests';

export interface CompetitionWorkspaceProps {
  /** URL state belongs to the host; omitted section shows the complete workspace. */
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
          최고 기록 계산과 비교는 아직 제공되지 않습니다. Chip/Gun 및 거리별 비교 기준은 아직
          확정되지 않았습니다.
        </p>
        <p>
          대회 날짜 변경의 연결 Plan 영향 미리보기와 별도 승인은 아직 제공되지 않습니다. 저장은
          Plan을 적용하지 않습니다.
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
        fields={(draft) => eventFields(draft, relations)}
        parse={parseEvent}
        summary={(record) => (
          <>
            <h3>{record.title}</h3>
            {props.onRaceOpen ? (
              <button type="button" onClick={() => props.onRaceOpen?.(record.id)}>
                대회 상세 보기
              </button>
            ) : null}
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
      <FamilyPanel
        display={props.section === undefined || props.section === 'results' ? 'active' : 'inactive'}
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
      />
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
  return (
    <section className={styles.panel} aria-label={title} hidden={display === 'inactive'}>
      <h2>{title}</h2>
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
        <RecordEditor
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
}: {
  title: string;
  initial: Draft;
  fields: (draft: Draft) => readonly Field[];
  parse: (draft: Draft) => V;
  commandKey: () => string;
  commandBasis: string;
  revisionReview: ReactNode;
  cancel: () => void;
  commit: (values: V, key: string, signal: AbortSignal) => Promise<void>;
}) {
  const [draft, setDraft] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const id = useId();
  const first = useRef<HTMLInputElement | null>(null);
  const command = useRef<{ json: string; key: string } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);
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
    if (pending) return;
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
