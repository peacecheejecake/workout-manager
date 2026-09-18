'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { ZodError } from 'zod';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import type {
  RoutineBlueprintRead,
  RoutineBlueprintSaveCommand,
  RoutineRunStartCommand,
  RoutineRunStepCommand,
  RoutineSchedulePreview,
  RoutineScheduleApproveCommand,
  RoutineRunRead,
} from '@workout/contracts/routine-commands';
import type {
  ActualRef,
  RoutineBlueprintStep,
  RoutineBlueprintVersion,
} from '@workout/contracts/routines';
import { Button } from '@workout/ui-foundation/button';
import { createRoutineApi, RoutineRequestError, type RoutineApi } from './routine-api';
import type { RoutineRoute } from './routine-route';
import styles from './routine.module.css';

type Scope = readonly ['users', string, 'sessions', string, 'routines'];
type DraftState = {
  routineId: string | null;
  priorVersionId: string | null;
  title: string;
  intent: string;
  tags: string;
  steps: RoutineBlueprintStep[];
  editing: boolean;
  begin: (prior: RoutineBlueprintRead | null) => void;
  clone: (prior: RoutineBlueprintRead) => void;
  update: (change: Partial<Pick<DraftState, 'title' | 'intent' | 'tags' | 'steps'>>) => void;
  close: () => void;
};
const newStep = (): RoutineBlueprintStep => ({
  id: crypto.randomUUID(),
  title: '',
  content: { kind: 'checklist', prompt: '확인할 항목' },
  timing: { kind: 'ordered', afterStepId: null },
  required: true,
  choiceGroupId: null,
});
function createDraftStore() {
  return createStore<DraftState>((set) => ({
    routineId: null,
    priorVersionId: null,
    title: '',
    intent: '',
    tags: '',
    steps: [],
    editing: false,
    begin: (prior) =>
      set({
        routineId: prior?.blueprint.routineId ?? null,
        priorVersionId: prior?.blueprint.versionId ?? null,
        title: prior?.blueprint.title ?? '',
        intent: prior?.blueprint.intent ?? '',
        tags: prior?.blueprint.tags.join(', ') ?? '',
        steps: prior?.blueprint.steps ?? [],
        editing: true,
      }),
    clone: (prior) =>
      set({
        routineId: null,
        priorVersionId: null,
        title: `${prior.blueprint.title} 복사본`,
        intent: prior.blueprint.intent,
        tags: prior.blueprint.tags.join(', '),
        steps: prior.blueprint.steps.map((step) => ({
          ...step,
          id: crypto.randomUUID(),
          timing: { kind: 'ordered', afterStepId: null },
        })),
        editing: true,
      }),
    update: (change) => set(change),
    close: () => set({ editing: false }),
  }));
}
type DraftStore = ReturnType<typeof createDraftStore>;
type RunUpdateOutcome = { kind: 'saved' } | { kind: 'failed'; error: unknown };
function definitiveCommandFailure(error: unknown) {
  return (
    error instanceof RoutineRequestError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![408, 425, 429].includes(error.status)
  );
}
export interface RoutineWorkspaceProps {
  athleteId: string;
  sessionId: string;
  transport: AuthenticatedTransport;
  route: RoutineRoute;
}

export function RoutineWorkspace(props: RoutineWorkspaceProps) {
  return <Lifetime key={`${props.athleteId}:${props.sessionId}`} {...props} />;
}
function Lifetime(props: RoutineWorkspaceProps) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      }),
  );
  const [draft] = useState(createDraftStore);
  useEffect(() => () => client.clear(), [client]);
  return (
    <QueryClientProvider client={client}>
      <Workspace {...props} draft={draft} />
    </QueryClientProvider>
  );
}
function Workspace({
  athleteId,
  sessionId,
  transport,
  route,
  draft,
}: RoutineWorkspaceProps & {
  draft: DraftStore;
}) {
  const api = useMemo(() => createRoutineApi(transport), [transport]);
  const scope: Scope = ['users', athleteId, 'sessions', sessionId, 'routines'];
  return (
    <section className={styles.workspace} aria-label="범용 루틴 작업 공간">
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>수동 조합 · 확인 후 배치</p>
          <h1>내 루틴</h1>
          <p>
            루틴은 계획과 실제 기록을 연결합니다. 저장만으로 일정이나 운동 실적이 생기지 않습니다.
          </p>
        </div>
        <nav aria-label="루틴 화면" className={styles.nav}>
          <a href="/routines">라이브러리</a>
          <a href="/supplementary">보강 운동 템플릿</a>
          <a href="/planner">계획</a>
        </nav>
      </header>
      {route.kind === 'run' ? (
        <RunWorkspace api={api} scope={scope} runId={route.runId} />
      ) : route.kind === 'schedule' ? (
        <ScheduleWorkspace api={api} scope={scope} routineId={route.routineId} />
      ) : (
        <BlueprintWorkspace
          api={api}
          scope={scope}
          routineId={route.kind === 'detail' ? route.routineId : null}
          initialEdit={route.kind === 'detail' && route.edit === true}
          draft={draft}
        />
      )}
    </section>
  );
}

function BlueprintWorkspace({
  api,
  scope,
  routineId,
  initialEdit,
  draft,
}: {
  api: RoutineApi;
  scope: Scope;
  routineId: string | null;
  initialEdit: boolean;
  draft: DraftStore;
}) {
  const client = useQueryClient();
  const [search, setSearch] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [startUncertain, setStartUncertain] = useState(false);
  const pendingStart = useRef<RoutineRunStartCommand | null>(null);
  const list = useQuery({
    queryKey: [...scope, 'library', search],
    queryFn: ({ signal }) => api.listBlueprints(search, signal),
  });
  const detail = useQuery({
    queryKey: [...scope, 'blueprint', routineId],
    enabled: routineId !== null,
    queryFn: ({ signal }) => {
      if (routineId === null) throw new Error('ROUTINE_ID_REQUIRED');
      return api.readBlueprint(routineId, signal);
    },
  });
  const editing = useStore(draft, (state) => state.editing);
  const begin = useStore(draft, (state) => state.begin);
  const clone = useStore(draft, (state) => state.clone);
  function clearPendingStart() {
    pendingStart.current = null;
    setStartUncertain(false);
  }
  const initialized = useRef(false);
  useEffect(() => {
    if (!initialEdit || !detail.data || initialized.current) return;
    initialized.current = true;
    begin(detail.data);
  }, [initialEdit, detail.data, begin]);
  async function libraryAction(
    record: RoutineBlueprintRead,
    action: 'favorite' | 'unfavorite' | 'archive' | 'restore',
  ) {
    setBusy(true);
    setMessage('');
    try {
      await api.changeLibrary({
        routineId: record.blueprint.routineId,
        action,
        expectedVersionId: record.blueprint.versionId,
        idempotencyKey: crypto.randomUUID(),
        confirmed: true,
      });
      await client.invalidateQueries({ queryKey: [...scope] });
      setMessage('라이브러리 상태를 변경했습니다. 이미 승인된 일정과 기록은 유지됩니다.');
    } catch (error) {
      setMessage(displayError(error));
    } finally {
      setBusy(false);
    }
  }
  async function start(record: RoutineBlueprintRead) {
    setBusy(true);
    setMessage('');
    const startCommand = pendingStart.current ?? {
      runId: crypto.randomUUID(),
      blueprintVersionId: record.blueprint.versionId,
      occurrenceId: null,
      idempotencyKey: crypto.randomUUID(),
      confirmed: true as const,
    };
    pendingStart.current = startCommand;
    let startedRunId: string | null = null;
    try {
      const result = await api.startRun(startCommand);
      startedRunId = result.run.id;
      clearPendingStart();
    } catch (error) {
      if (definitiveCommandFailure(error)) clearPendingStart();
      else setStartUncertain(true);
      setMessage(
        definitiveCommandFailure(error)
          ? displayError(error)
          : '실행 시작 결과가 불확실합니다. 같은 명령으로 다시 시도하세요.',
      );
    } finally {
      setBusy(false);
    }
    if (startedRunId) window.location.assign(`/routine-runs/${startedRunId}`);
  }
  return (
    <div className={styles.columns}>
      <section className={styles.card} aria-labelledby="routine-list-title">
        <div className={styles.head}>
          <h2 id="routine-list-title">루틴 라이브러리</h2>
          <Button
            variant="secondary"
            onClick={() => {
              clearPendingStart();
              begin(null);
            }}
            disabled={busy}
          >
            새 루틴
          </Button>
        </div>
        <label className={styles.field}>
          제목 검색
          <input value={search} onChange={(event) => setSearch(event.target.value)} type="search" />
        </label>
        {list.isPending ? (
          <p>루틴을 불러오는 중입니다.</p>
        ) : list.isError ? (
          <p role="alert">목록을 불러오지 못했습니다.</p>
        ) : list.data.items.length === 0 ? (
          <p>저장된 루틴이 없습니다.</p>
        ) : (
          <ul className={styles.list}>
            {list.data.items.map((record) => (
              <li key={record.blueprint.routineId}>
                <a href={`/routines/${record.blueprint.routineId}`}>{record.blueprint.title}</a>
                <span>
                  {' '}
                  · 버전 {record.version} · {record.visibility === 'archived' ? '보관됨' : '활성'}
                </span>
                <div className={styles.actions}>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      void libraryAction(record, record.favorite ? 'unfavorite' : 'favorite')
                    }
                  >
                    {record.favorite ? '즐겨찾기 해제' : '즐겨찾기'}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      void libraryAction(
                        record,
                        record.visibility === 'archived' ? 'restore' : 'archive',
                      )
                    }
                  >
                    {record.visibility === 'archived' ? '복원' : '보관'}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {list.data?.hasMore ? <p>처음 100개만 표시합니다. 검색어를 좁혀 주세요.</p> : null}
      </section>
      <section className={styles.card} aria-labelledby="routine-detail-title">
        <h2 id="routine-detail-title">{routineId ? '루틴 상세' : '루틴 편집'}</h2>
        {routineId && detail.isPending ? <p>상세를 불러오는 중입니다.</p> : null}
        {routineId && detail.isError ? <p role="alert">루틴을 찾을 수 없습니다.</p> : null}
        {detail.data && !editing ? (
          <div className={styles.stack}>
            <p>{detail.data.blueprint.intent || '목적 설명 없음'}</p>
            <p>
              단계 {detail.data.blueprint.steps.length}개 · 예상{' '}
              {detail.data.blueprint.estimatedDurationSeconds ?? '미정'}초
            </p>
            <ol className={styles.list}>
              {detail.data.blueprint.steps.map((step) => (
                <li key={step.id}>
                  {step.title} <small>({contentLabel(step.content.kind)})</small>
                </li>
              ))}
            </ol>
            <div className={styles.actions}>
              <Button
                onClick={() => {
                  clearPendingStart();
                  begin(detail.data);
                }}
              >
                새 버전 편집
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  clearPendingStart();
                  clone(detail.data);
                }}
              >
                복제해서 편집
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  clearPendingStart();
                  begin(null);
                }}
              >
                새 루틴 만들기
              </Button>
              <a href={`/routines/${detail.data.blueprint.routineId}/schedule`}>일정 미리보기</a>
              <Button
                disabled={busy || detail.data.visibility !== 'active'}
                onClick={() => void start(detail.data)}
              >
                {startUncertain ? '같은 실행 시작 재시도' : '계획 없이 실행'}
              </Button>
            </div>
          </div>
        ) : null}
        {editing ? (
          <BlueprintEditor api={api} scope={scope} store={draft} onMessage={setMessage} />
        ) : null}
        {!routineId && !editing ? <p>새 루틴을 만들거나 왼쪽 목록에서 선택하세요.</p> : null}
        <p role="status" aria-live="polite">
          {message}
        </p>
      </section>
    </div>
  );
}
function contentLabel(kind: RoutineBlueprintStep['content']['kind']) {
  return kind === 'workout_template'
    ? '운동'
    : kind === 'nutrition_template'
      ? '영양'
      : kind === 'recovery_method'
        ? '회복'
        : kind === 'checkin_template'
          ? '체크인'
          : '확인';
}
function BlueprintEditor({
  api,
  scope,
  store,
  onMessage,
}: {
  api: RoutineApi;
  scope: Scope;
  store: DraftStore;
  onMessage: (message: string) => void;
}) {
  const client = useQueryClient();
  const state = useStore(store);
  const pending = useRef<RoutineBlueprintSaveCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  function editStep(index: number, change: Partial<RoutineBlueprintStep>) {
    state.update({
      steps: state.steps.map((item, i) => (i === index ? { ...item, ...change } : item)),
    });
    pending.current = null;
    setUncertain(false);
  }
  function moveStep(index: number, by: number) {
    const target = index + by;
    if (target < 0 || target >= state.steps.length) return;
    const next = [...state.steps];
    const left = next[index];
    const right = next[target];
    if (!left || !right) return;
    next[index] = right;
    next[target] = left;
    state.update({ steps: next });
    pending.current = null;
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const routineId = state.routineId ?? crypto.randomUUID();
      const blueprint: RoutineBlueprintVersion = {
        schemaVersion: 4,
        routineId,
        versionId: crypto.randomUUID(),
        title: state.title.trim(),
        intent: state.intent.trim(),
        status: 'published',
        tags: [
          ...new Set(
            state.tags
              .split(',')
              .map((item) => item.trim())
              .filter(Boolean),
          ),
        ],
        steps: state.steps.map((step, index) => ({
          ...step,
          timing: { kind: 'ordered', afterStepId: state.steps[index - 1]?.id ?? null },
        })),
        choiceGroups: [],
        estimatedDurationSeconds: null,
        createdAt: new Date().toISOString(),
      };
      const command = pending.current ?? {
        blueprint,
        expectedVersionId: state.priorVersionId,
        idempotencyKey: crypto.randomUUID(),
        confirmed: true as const,
      };
      pending.current = command;
      const saved = await api.saveBlueprint(command);
      pending.current = null;
      setUncertain(false);
      state.close();
      onMessage(`루틴 버전 ${saved.version}을 저장했습니다. 일정 적용은 별도 확인이 필요합니다.`);
      await client.invalidateQueries({ queryKey: [...scope] });
    } catch (cause) {
      if (
        cause instanceof ZodError ||
        (cause instanceof RoutineRequestError && cause.status < 500)
      ) {
        pending.current = null;
        setUncertain(false);
        setError(displayError(cause));
      } else {
        setUncertain(true);
        setError('저장 결과가 불확실합니다. 값을 바꾸지 말고 같은 요청을 다시 시도하세요.');
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className={styles.form} onSubmit={(event) => void save(event)}>
      <label className={styles.field}>
        제목
        <input
          required
          maxLength={200}
          value={state.title}
          disabled={busy || uncertain}
          onChange={(event) => state.update({ title: event.target.value })}
        />
      </label>
      <label className={styles.field}>
        목적
        <textarea
          value={state.intent}
          disabled={busy || uncertain}
          onChange={(event) => state.update({ intent: event.target.value })}
        />
      </label>
      <label className={styles.field}>
        태그 (쉼표로 구분)
        <input
          value={state.tags}
          disabled={busy || uncertain}
          onChange={(event) => state.update({ tags: event.target.value })}
        />
      </label>
      <h3>단계</h3>
      <ol className={styles.steps}>
        {state.steps.map((step, index) => (
          <li key={step.id} className={styles.step}>
            <label className={styles.field}>
              단계 제목
              <input
                required
                value={step.title}
                disabled={busy || uncertain}
                onChange={(event) => editStep(index, { title: event.target.value })}
              />
            </label>
            <label className={styles.field}>
              종류
              <select
                value={step.content.kind}
                disabled={busy || uncertain}
                onChange={(event) => {
                  const kind = event.target.value;
                  const content =
                    kind === 'workout_template' || kind === 'nutrition_template'
                      ? ({
                          kind,
                          ref: { id: '', versionId: '' },
                        } as RoutineBlueprintStep['content'])
                      : ({ kind: 'checklist', prompt: step.title || '확인할 항목' } as const);
                  editStep(index, { content });
                }}
              >
                <option value="checklist">확인</option>
                <option value="workout_template">기존 운동 템플릿</option>
                <option value="nutrition_template">기존 영양 계획</option>
              </select>
            </label>
            {step.content.kind === 'checklist' ? (
              <label className={styles.field}>
                확인 문구
                <input
                  value={step.content.prompt}
                  disabled={busy || uncertain}
                  onChange={(event) =>
                    editStep(index, { content: { kind: 'checklist', prompt: event.target.value } })
                  }
                />
              </label>
            ) : (
              <div className={styles.columns}>
                <label className={styles.field}>
                  기존 항목 ID
                  <input
                    value={step.content.ref.id}
                    disabled={busy || uncertain}
                    onChange={(event) => {
                      if (step.content.kind === 'checklist') return;
                      editStep(index, {
                        content: {
                          ...step.content,
                          ref: { ...step.content.ref, id: event.target.value },
                        },
                      });
                    }}
                  />
                </label>
                <label className={styles.field}>
                  고정 버전 ID
                  <input
                    value={step.content.ref.versionId}
                    disabled={busy || uncertain}
                    onChange={(event) => {
                      if (step.content.kind === 'checklist') return;
                      editStep(index, {
                        content: {
                          ...step.content,
                          ref: { ...step.content.ref, versionId: event.target.value },
                        },
                      });
                    }}
                  />
                </label>
              </div>
            )}
            <div className={styles.actions}>
              <Button
                variant="secondary"
                disabled={busy || uncertain || index === 0}
                onClick={() => moveStep(index, -1)}
              >
                위로
              </Button>
              <Button
                variant="secondary"
                disabled={busy || uncertain || index === state.steps.length - 1}
                onClick={() => moveStep(index, 1)}
              >
                아래로
              </Button>
              <Button
                variant="danger"
                disabled={busy || uncertain}
                onClick={() =>
                  state.update({ steps: state.steps.filter((item) => item.id !== step.id) })
                }
              >
                삭제
              </Button>
            </div>
          </li>
        ))}
      </ol>
      <div className={styles.actions}>
        <Button
          variant="secondary"
          disabled={busy || uncertain || state.steps.length >= 30}
          onClick={() => state.update({ steps: [...state.steps, newStep()] })}
        >
          단계 추가
        </Button>
        <Button type="submit" disabled={busy || (!uncertain && state.steps.length === 0)}>
          {uncertain ? '같은 저장 재시도' : '루틴 버전 저장'}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => state.close()}>
          닫기
        </Button>
      </div>
      <p role="alert">{error}</p>
    </form>
  );
}

function ScheduleWorkspace({
  api,
  scope,
  routineId,
}: {
  api: RoutineApi;
  scope: Scope;
  routineId: string;
}) {
  const client = useQueryClient();
  const blueprint = useQuery({
    queryKey: [...scope, 'blueprint', routineId],
    queryFn: ({ signal }) => api.readBlueprint(routineId, signal),
  });
  const schedules = useQuery({
    queryKey: [...scope, 'schedules'],
    queryFn: ({ signal }) => api.listSchedules(signal),
  });
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [preview, setPreview] = useState<RoutineSchedulePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [approvalUncertain, setApprovalUncertain] = useState(false);
  const pendingApproval = useRef<RoutineScheduleApproveCommand | null>(null);
  const [scheduledStartUncertain, setScheduledStartUncertain] = useState(false);
  const [pendingScheduledOccurrenceId, setPendingScheduledOccurrenceId] = useState<string | null>(
    null,
  );
  const pendingScheduledStart = useRef<RoutineRunStartCommand | null>(null);
  function changeScheduleDraft(change: () => void) {
    change();
    setPreview(null);
    pendingApproval.current = null;
    setApprovalUncertain(false);
  }
  async function makePreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!blueprint.data || busy || approvalUncertain) return;
    setBusy(true);
    setMessage('');
    setPreview(null);
    try {
      const end = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      const result = await api.previewSchedule({
        schedule: {
          schemaVersion: 4,
          id: crypto.randomUUID(),
          versionId: crypto.randomUUID(),
          blueprint: { id: routineId, versionId: blueprint.data.blueprint.versionId },
          window: { startDate: date, endDateExclusive: end, timezone, maxOccurrences: 1 },
          rule: { kind: 'dates', dates: [date], localTime: time || null },
          state: 'draft',
        },
        sourcePlanVersionId: null,
      });
      setPreview(result);
    } catch (error) {
      setMessage(displayError(error));
    } finally {
      setBusy(false);
    }
  }
  async function approve() {
    if (!preview || busy) return;
    setBusy(true);
    setMessage('');
    const approvalCommand = pendingApproval.current ?? {
      schedule: preview.schedule,
      sourcePlanVersionId: preview.sourcePlanVersionId,
      previewDigest: preview.previewDigest,
      idempotencyKey: crypto.randomUUID(),
      confirmed: true as const,
    };
    pendingApproval.current = approvalCommand;
    let approvedCount: number | null = null;
    try {
      const result = await api.approveSchedule(approvalCommand);
      approvedCount = result.occurrences.length;
      pendingApproval.current = null;
      setApprovalUncertain(false);
      setMessage(`일정 발생분 ${approvedCount}개를 승인했습니다. 실제 수행은 별도로 기록합니다.`);
      setPreview(null);
    } catch (error) {
      if (definitiveCommandFailure(error)) {
        pendingApproval.current = null;
        setApprovalUncertain(false);
        setPreview(null);
        setMessage(displayError(error));
      } else {
        setApprovalUncertain(true);
        setMessage('일정 승인 결과가 불확실합니다. 같은 명령으로 다시 시도하세요.');
      }
    } finally {
      setBusy(false);
    }
    if (approvedCount !== null)
      void client.invalidateQueries({ queryKey: [...scope, 'schedules'] });
  }
  async function startScheduled(versionId: string, occurrenceId: string) {
    if (
      pendingScheduledStart.current &&
      pendingScheduledStart.current.occurrenceId !== occurrenceId
    )
      return;
    setBusy(true);
    setMessage('');
    const startCommand = pendingScheduledStart.current ?? {
      runId: crypto.randomUUID(),
      blueprintVersionId: versionId,
      occurrenceId,
      idempotencyKey: crypto.randomUUID(),
      confirmed: true as const,
    };
    pendingScheduledStart.current = startCommand;
    setPendingScheduledOccurrenceId(occurrenceId);
    let startedRunId: string | null = null;
    try {
      const result = await api.startRun(startCommand);
      startedRunId = result.run.id;
      pendingScheduledStart.current = null;
      setPendingScheduledOccurrenceId(null);
      setScheduledStartUncertain(false);
    } catch (error) {
      if (definitiveCommandFailure(error)) {
        pendingScheduledStart.current = null;
        setPendingScheduledOccurrenceId(null);
        setScheduledStartUncertain(false);
        setMessage(displayError(error));
      } else {
        setScheduledStartUncertain(true);
        setMessage('발생분 실행 시작 결과가 불확실합니다. 같은 명령으로 다시 시도하세요.');
      }
    } finally {
      setBusy(false);
    }
    if (startedRunId) window.location.assign(`/routine-runs/${startedRunId}`);
  }
  return (
    <section className={styles.card} aria-labelledby="schedule-title">
      <h2 id="schedule-title">루틴 일정 미리보기</h2>
      {blueprint.isPending ? (
        <p>루틴을 불러오는 중입니다.</p>
      ) : blueprint.isError ? (
        <p role="alert">루틴을 찾을 수 없습니다.</p>
      ) : (
        <p>
          {blueprint.data.blueprint.title} · 고정 버전 {blueprint.data.version}
        </p>
      )}
      <p>
        이 화면의 승인은 루틴 발생분만 배치합니다. 운동·영양·회복 계획의 신규 변경은 별도 통합
        제안과 승인이 필요합니다.
      </p>
      <form className={styles.form} onSubmit={(event) => void makePreview(event)}>
        <label className={styles.field}>
          현지 날짜{' '}
          <input
            required
            type="date"
            value={date}
            onChange={(event) => {
              changeScheduleDraft(() => setDate(event.target.value));
            }}
          />
        </label>
        <label className={styles.field}>
          현지 시각 (선택){' '}
          <input
            type="time"
            value={time}
            onChange={(event) => {
              changeScheduleDraft(() => setTime(event.target.value));
            }}
          />
        </label>
        <label className={styles.field}>
          시간대{' '}
          <input
            required
            value={timezone}
            onChange={(event) => {
              changeScheduleDraft(() => setTimezone(event.target.value));
            }}
          />
        </label>
        <Button type="submit" disabled={busy || !blueprint.data || approvalUncertain}>
          영향 미리보기
        </Button>
      </form>
      {preview ? (
        <div className={styles.stack}>
          <h3>승인 전 확인</h3>
          <p>
            발생분 {preview.occurrences.length}개, 확인 사항 {preview.conflicts.length}개
          </p>
          <ul className={styles.list}>
            {preview.occurrences.map((item) => (
              <li key={item.id}>
                {item.anchorKey}: {item.scheduledAt ?? '시각 미해결'}
              </li>
            ))}
          </ul>
          {preview.conflicts.length ? (
            <ul className={styles.list}>
              {preview.conflicts.map((item, index) => (
                <li key={`${item.anchorKey}:${index}`}>{item.description}</li>
              ))}
            </ul>
          ) : null}
          <Button disabled={busy} onClick={() => void approve()}>
            {approvalUncertain ? '같은 일정 승인 재시도' : '표시된 루틴 발생분 승인'}
          </Button>
        </div>
      ) : null}
      <h3>승인된 발생분</h3>
      {schedules.isPending ? (
        <p>일정을 불러오는 중입니다.</p>
      ) : schedules.isError ? (
        <p role="alert">일정을 불러오지 못했습니다.</p>
      ) : (
        <ul className={styles.list}>
          {schedules.data.items
            .filter((item) => item.schedule.blueprint.id === routineId)
            .flatMap((item) => item.occurrences.map((occurrence) => ({ item, occurrence })))
            .map(({ item, occurrence }) => (
              <li key={occurrence.id}>
                {occurrence.scheduledAt ?? '시각 미해결'} · {item.schedule.state}
                <Button
                  variant="secondary"
                  disabled={
                    busy ||
                    item.schedule.state !== 'active' ||
                    (scheduledStartUncertain && pendingScheduledOccurrenceId !== occurrence.id)
                  }
                  onClick={() => void startScheduled(occurrence.blueprint.versionId, occurrence.id)}
                >
                  {scheduledStartUncertain && pendingScheduledOccurrenceId === occurrence.id
                    ? '같은 발생분 실행 시작 재시도'
                    : '이 발생분 실행'}
                </Button>
              </li>
            ))}
        </ul>
      )}
      <p role="status" aria-live="polite">
        {message}
      </p>
    </section>
  );
}

function RunWorkspace({ api, scope, runId }: { api: RoutineApi; scope: Scope; runId: string }) {
  const client = useQueryClient();
  const run = useQuery({
    queryKey: [...scope, 'run', runId],
    queryFn: ({ signal }) => api.readRun(runId, signal),
  });
  const blueprint = useQuery({
    queryKey: [...scope, 'blueprint-version', run.data?.run.blueprint.versionId],
    enabled: Boolean(run.data),
    queryFn: ({ signal }) => {
      if (!run.data) throw new Error('RUN_REQUIRED');
      return api.readBlueprintVersion(run.data.run.blueprint.versionId, signal);
    },
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function update(operation: () => Promise<RoutineRunRead>): Promise<RunUpdateOutcome> {
    setBusy(true);
    setMessage('');
    try {
      const result = await operation();
      client.setQueryData([...scope, 'run', runId], result);
      setMessage('변경사항을 저장했습니다. 실제 기록 연결은 각 원장을 다시 확인합니다.');
      return { kind: 'saved' };
    } catch (error) {
      setMessage(displayError(error));
      return { kind: 'failed', error };
    } finally {
      setBusy(false);
    }
  }
  if (run.isPending || blueprint.isPending) return <p>실행 기록을 불러오는 중입니다.</p>;
  if (run.isError || blueprint.isError || !run.data || !blueprint.data)
    return <p role="alert">실행 기록을 찾을 수 없습니다.</p>;
  const current = run.data.run;
  const activeSteps = blueprint.data.steps.filter(
    (step) =>
      step.choiceGroupId === null || current.selectedChoices[step.choiceGroupId] === step.id,
  );
  const required = activeSteps.filter((step) => step.required).length;
  const performed = activeSteps.filter((step) =>
    current.progress.some((item) => item.stepId === step.id && item.state === 'performed'),
  ).length;
  const unconfirmed = activeSteps.filter(
    (step) =>
      !current.progress.some(
        (item) =>
          item.stepId === step.id &&
          ['performed', 'partial', 'confirmed_skipped', 'stopped', 'not_applicable'].includes(
            item.state,
          ),
      ),
  ).length;
  return (
    <section className={styles.card} aria-labelledby="run-title">
      <h2 id="run-title">{blueprint.data.title} 실행</h2>
      <p>
        고정 버전 {current.blueprint.versionId} · {current.state} · 필수 {required}개 · 수행{' '}
        {performed}개 · 미확인 {unconfirmed}개
      </p>
      <p>
        선택하지 않은 대안은 분모에서 제외합니다. 실행률은 신체 회복이나 건강 상태를 뜻하지
        않습니다.
      </p>
      <div className={styles.actions}>
        {current.state === 'in_progress' ? (
          <>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void update(() =>
                  api.changeRun({
                    runId,
                    action: 'pause',
                    expectedRevision: current.revision,
                    idempotencyKey: crypto.randomUUID(),
                    confirmed: true,
                  }),
                )
              }
            >
              일시정지
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void update(() =>
                  api.changeRun({
                    runId,
                    action: 'end',
                    expectedRevision: current.revision,
                    idempotencyKey: crypto.randomUUID(),
                    confirmed: true,
                  }),
                )
              }
            >
              종료
            </Button>
          </>
        ) : null}
        {current.state === 'paused' ? (
          <Button
            disabled={busy}
            onClick={() =>
              void update(() =>
                api.changeRun({
                  runId,
                  action: 'resume',
                  expectedRevision: current.revision,
                  idempotencyKey: crypto.randomUUID(),
                  confirmed: true,
                }),
              )
            }
          >
            재개
          </Button>
        ) : null}
        {current.state === 'paused' || current.state === 'in_progress' ? (
          <Button
            variant="danger"
            disabled={busy}
            onClick={() =>
              void update(() =>
                api.changeRun({
                  runId,
                  action: 'stop',
                  expectedRevision: current.revision,
                  idempotencyKey: crypto.randomUUID(),
                  confirmed: true,
                }),
              )
            }
          >
            중단
          </Button>
        ) : null}
      </div>
      {blueprint.data.choiceGroups.map((group) => (
        <fieldset key={group.id} className={styles.group}>
          <legend>대안 하나 선택</legend>
          {group.stepIds.map((id) => {
            const step = blueprint.data.steps.find((item) => item.id === id);
            return step ? (
              <Button
                key={id}
                variant="secondary"
                disabled={busy || current.state !== 'in_progress'}
                aria-pressed={current.selectedChoices[group.id] === id}
                onClick={() =>
                  void update(() =>
                    api.chooseStep({
                      runId,
                      groupId: group.id,
                      stepId: id,
                      expectedRevision: current.revision,
                      idempotencyKey: crypto.randomUUID(),
                      confirmed: true,
                    }),
                  )
                }
              >
                {step.title}
              </Button>
            ) : null;
          })}
        </fieldset>
      ))}
      <ol className={styles.steps}>
        {blueprint.data.steps.map((step) => {
          const selected =
            step.choiceGroupId === null || current.selectedChoices[step.choiceGroupId] === step.id;
          const status =
            current.progress.find((item) => item.stepId === step.id)?.state ?? 'pending';
          return (
            <li key={step.id} className={styles.step}>
              <h3>{step.title}</h3>
              <p>
                {contentLabel(step.content.kind)} · {step.required ? '필수' : '선택'} ·{' '}
                {selected ? status : '대안 미선택'}
              </p>
              {selected && current.state === 'in_progress' ? (
                <StepControls
                  api={api}
                  scope={scope}
                  run={run.data}
                  step={step}
                  busy={busy}
                  update={update}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
      <p role="status" aria-live="polite">
        {message}
      </p>
    </section>
  );
}

function StepControls({
  api,
  scope,
  run,
  step,
  busy,
  update,
}: {
  api: RoutineApi;
  scope: Scope;
  run: RoutineRunRead;
  step: RoutineBlueprintStep;
  busy: boolean;
  update: (operation: () => Promise<RoutineRunRead>) => Promise<RunUpdateOutcome>;
}) {
  const client = useQueryClient();
  const [actualId, setActualId] = useState('');
  const [revisionId, setRevisionId] = useState('');
  const [reason, setReason] = useState('');
  const [duration, setDuration] = useState('60');
  const [now, setNow] = useState(Date.now);
  const [timerMessage, setTimerMessage] = useState('');
  const [recordUncertain, setRecordUncertain] = useState(false);
  const [recordMessage, setRecordMessage] = useState('');
  const pendingRecord = useRef<RoutineRunStepCommand | null>(null);
  const timer = run.timers.find((item) => item.stepId === step.id);
  useEffect(() => {
    if (timer?.state !== 'running') return;
    const tick = () => setNow(Date.now());
    const id = window.setInterval(tick, 1000);
    window.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('visibilitychange', tick);
    };
  }, [timer?.state]);
  const elapsed = timer
    ? Math.max(
        0,
        ((timer.state === 'paused' && timer.pausedAt ? Date.parse(timer.pausedAt) : now) -
          Date.parse(timer.startedAt) -
          timer.pausedMilliseconds) /
          1000,
      )
    : 0;
  const remaining = timer ? Math.max(0, Math.ceil(timer.durationSeconds - elapsed)) : 0;
  async function timerAction(action: 'start' | 'pause' | 'resume' | 'clear') {
    setTimerMessage('');
    try {
      await api.commandTimer({
        runId: run.run.id,
        stepId: step.id,
        action,
        durationSeconds: action === 'start' ? Number(duration) : null,
        expectedRevision: timer?.revision ?? null,
        idempotencyKey: crypto.randomUUID(),
      });
      await client.invalidateQueries({ queryKey: [...scope, 'run', run.run.id] });
    } catch (error) {
      setTimerMessage(displayError(error));
    }
  }
  function clearPendingRecord() {
    pendingRecord.current = null;
    setRecordUncertain(false);
  }
  async function submitRecord(command: RoutineRunStepCommand) {
    const outcome = await update(() => api.recordStep(command));
    if (outcome.kind === 'saved' || definitiveCommandFailure(outcome.error)) {
      clearPendingRecord();
      setRecordMessage('');
    } else {
      setRecordUncertain(true);
      setRecordMessage('단계 기록 결과가 불확실합니다. 같은 명령으로 다시 시도하세요.');
    }
  }
  function retryRecord() {
    const command = pendingRecord.current;
    if (command) void submitRecord(command);
  }
  function record(state: 'performed' | 'partial' | 'confirmed_skipped' | 'stopped') {
    if (pendingRecord.current) return;
    const actualRefs: ActualRef[] = [];
    if ((state === 'performed' || state === 'partial') && step.content.kind !== 'checklist') {
      const kind = step.content.kind === 'workout_template' ? 'activity' : 'intake';
      if (kind === 'activity')
        actualRefs.push({ kind, id: actualId, revisionId, detailId: null, allocationId: null });
      else actualRefs.push({ kind, id: actualId, revisionId });
    }
    const command: RoutineRunStepCommand = {
      runId: run.run.id,
      stepId: step.id,
      state,
      actualRefs,
      occurredAt:
        (state === 'performed' || state === 'partial') && step.content.kind === 'checklist'
          ? new Date().toISOString()
          : null,
      reason: reason.trim() || null,
      expectedRevision: run.run.revision,
      idempotencyKey: crypto.randomUUID(),
      confirmed: true,
    };
    pendingRecord.current = command;
    void submitRecord(command);
  }
  return (
    <div className={styles.stack}>
      {step.content.kind !== 'checklist' ? (
        <div className={styles.columns}>
          <label className={styles.field}>
            기존 실제 기록 ID
            <input
              value={actualId}
              disabled={busy || recordUncertain}
              onChange={(event) => {
                clearPendingRecord();
                setActualId(event.target.value);
              }}
            />
          </label>
          <label className={styles.field}>
            현재 revision ID (운동은 숫자)
            <input
              value={revisionId}
              disabled={busy || recordUncertain}
              onChange={(event) => {
                clearPendingRecord();
                setRevisionId(event.target.value);
              }}
            />
          </label>
        </div>
      ) : null}
      <label className={styles.field}>
        부분·중단 이유 (선택)
        <input
          value={reason}
          disabled={busy || recordUncertain}
          onChange={(event) => {
            clearPendingRecord();
            setReason(event.target.value);
          }}
        />
      </label>
      <div className={styles.actions}>
        <Button
          disabled={
            busy ||
            recordUncertain ||
            (step.content.kind !== 'checklist' && (!actualId || !revisionId))
          }
          onClick={() => record('performed')}
        >
          수행 확인
        </Button>
        <Button
          variant="secondary"
          disabled={
            busy ||
            recordUncertain ||
            (step.content.kind !== 'checklist' && (!actualId || !revisionId))
          }
          onClick={() => record('partial')}
        >
          부분 수행
        </Button>
        <Button
          variant="secondary"
          disabled={busy || recordUncertain}
          onClick={() => record('confirmed_skipped')}
        >
          건너뜀 확인
        </Button>
        <Button
          variant="danger"
          disabled={busy || recordUncertain}
          onClick={() => record('stopped')}
        >
          이 단계 중단
        </Button>
        {recordUncertain ? (
          <Button variant="secondary" disabled={busy} onClick={retryRecord}>
            같은 단계 기록 재시도
          </Button>
        ) : null}
      </div>
      <p role="status" aria-live="polite">
        {recordMessage}
      </p>
      <div className={styles.timer}>
        <label className={styles.field}>
          보조 타이머 (초)
          <input
            type="number"
            min="1"
            max="86400"
            value={duration}
            onChange={(event) => setDuration(event.target.value)}
            disabled={Boolean(timer && timer.state !== 'cleared')}
          />
        </label>
        <p>
          남은 시간 {timer ? `${remaining}초` : '설정 전'} · 종료해도 실제 수행은 자동 기록되지
          않습니다.
        </p>
        <div className={styles.actions}>
          {!timer || timer.state === 'cleared' ? (
            <Button variant="secondary" onClick={() => void timerAction('start')}>
              시작
            </Button>
          ) : null}
          {timer?.state === 'running' ? (
            <Button variant="secondary" onClick={() => void timerAction('pause')}>
              일시정지
            </Button>
          ) : null}
          {timer?.state === 'paused' ? (
            <Button variant="secondary" onClick={() => void timerAction('resume')}>
              재개
            </Button>
          ) : null}
          {timer && timer.state !== 'cleared' ? (
            <Button variant="secondary" onClick={() => void timerAction('clear')}>
              타이머 정리
            </Button>
          ) : null}
        </div>
        <p role="alert">{timerMessage}</p>
      </div>
    </div>
  );
}

function displayError(error: unknown) {
  if (error instanceof RoutineRequestError) {
    if (error.status === 409)
      return '다른 기기에서 변경됐습니다. 새로고침 후 최신 상태를 확인하세요.';
    if (error.status === 404) return '연결 대상이 없거나 현재 계정에서 볼 수 없습니다.';
    return `요청을 확인해 주세요 (${error.code}).`;
  }
  if (error instanceof ZodError) return '입력 형식과 고정 버전 ID를 확인해 주세요.';
  return '연결 상태를 확인하고 다시 시도하세요.';
}
