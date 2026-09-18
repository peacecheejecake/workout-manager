import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useStore } from 'zustand';
import { ZodError } from 'zod';
import type {
  ExecutionCreateCommand,
  ExecutionStatusCommand,
  ExerciseVersionRead,
  RestTimerCommand,
  SetLogCreateCommand,
  SetLogCorrectCommand,
  SetLogDeleteCommand,
  SetLogRead,
} from '@workout/contracts/supplementary-core';
import { Button } from '@workout/ui-foundation/button';
import { SupplementaryRequestError, type SupplementaryApi } from './supplementary-api';
import { setValuesFromInputs, timerRemainingSeconds } from './supplementary-model';
import { createRunnerStore, type SetDraft } from './runner-store';
import type { SupplementaryScope } from './supplementary-workspace';
import styles from './supplementary.module.css';

export function ExecutionWorkspace({
  api,
  scope,
  executionId,
}: {
  api: SupplementaryApi;
  scope: SupplementaryScope;
  executionId: string | null;
}) {
  const client = useQueryClient();
  const executions = useQuery({
    queryKey: [...scope, 'executions'],
    queryFn: ({ signal }) => api.listExecutions(signal),
  });
  const current = useQuery({
    queryKey: [...scope, 'execution', executionId],
    queryFn: ({ signal }) => {
      if (executionId === null) throw new Error('EXECUTION_ID_REQUIRED');
      return api.readExecution(executionId, signal);
    },
    enabled: executionId !== null,
  });
  const exercises = useQuery({
    queryKey: [...scope, 'exercises'],
    queryFn: ({ signal }) => api.listExercises(signal),
  });
  const [mode, setMode] = useState<'manual' | 'match'>('manual');
  const [activityId, setActivityId] = useState('');
  const [title, setTitle] = useState('보강 운동');
  const [startedAt, setStartedAt] = useState('');
  const [duration, setDuration] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [startUncertain, markStartUncertain] = useState(false);
  const pending = useRef<ExecutionCreateCommand | null>(null);
  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const command: ExecutionCreateCommand = pending.current ?? {
        schemaVersion: 2,
        executionId: crypto.randomUUID(),
        plannedSession: null,
        activity:
          mode === 'match'
            ? { kind: 'match_existing', activityId }
            : {
                kind: 'create_manual',
                values: {
                  title: title.trim(),
                  kind: 'strength',
                  startedAt: new Date(startedAt).toISOString(),
                  durationSeconds: duration.trim() === '' ? null : Number(duration),
                  durationKind: duration.trim() === '' ? 'unknown' : 'elapsed',
                  timezone,
                  distanceMeters: null,
                },
                report: { sessionRpe: null, note: null, planLink: null },
              },
        idempotencyKey: crypto.randomUUID(),
        confirmed: true,
      };
      pending.current = command;
      const saved = await api.createExecution(command);
      pending.current = null;
      markStartUncertain(false);
      await client.invalidateQueries({ queryKey: [...scope, 'executions'] });
      window.location.assign(
        `/supplementary/sessions/${encodeURIComponent(saved.executionId)}/perform`,
      );
    } catch (error) {
      if (
        error instanceof ZodError ||
        (error instanceof SupplementaryRequestError && error.status < 500)
      ) {
        pending.current = null;
        markStartUncertain(false);
        setMessage('입력 또는 Activity 연결을 확인하세요.');
      } else if (pending.current) {
        markStartUncertain(true);
        setMessage('시작 결과가 불확실합니다. 값을 바꾸지 말고 같은 명령을 다시 시도하세요.');
      } else {
        setMessage('시작 시각과 값을 확인하세요.');
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={styles.columns}>
      <section className={styles.card} aria-labelledby="execution-list-title">
        <h2 id="execution-list-title">보강 수행</h2>
        <p>운동은 공통 Activity 하나로 기록하고 세트는 그 활동의 상세로 연결합니다.</p>
        {executions.isPending ? <p role="status">수행 기록 불러오는 중</p> : null}
        {executions.isError ? <p role="alert">수행 기록을 불러오지 못했습니다.</p> : null}
        {executions.data?.hasMore ? <p role="status">수행 목록이 일부만 표시됩니다.</p> : null}
        {executions.data?.items.length === 0 ? <p>아직 보강 수행이 없습니다.</p> : null}
        <ul className={styles.list}>
          {executions.data?.items.map((entry) => (
            <li key={entry.executionId}>
              <a href={`/supplementary/sessions/${encodeURIComponent(entry.executionId)}/perform`}>
                {new Date(entry.startedAt).toLocaleString('ko-KR')} · {entry.status}
              </a>
              <p>
                Activity {entry.activityId} · 수정 {entry.revision}
              </p>
            </li>
          ))}
        </ul>
        <form onSubmit={(event) => void start(event)} className={styles.form}>
          <h3>수행 시작</h3>
          <fieldset disabled={startUncertain || busy} className={styles.inputGroup}>
            <label>
              Activity 연결 방식
              <select
                value={mode}
                onChange={(event) => {
                  setMode(event.target.value as 'manual' | 'match');
                  pending.current = null;
                }}
              >
                <option value="manual">수동 Activity 만들기</option>
                <option value="match">기존 Activity 연결</option>
              </select>
            </label>
            {mode === 'match' ? (
              <label>
                기존 Activity ID
                <input
                  required
                  value={activityId}
                  onChange={(event) => {
                    setActivityId(event.target.value);
                    pending.current = null;
                  }}
                />
              </label>
            ) : (
              <>
                <label>
                  운동 이름
                  <input
                    required
                    value={title}
                    onChange={(event) => {
                      setTitle(event.target.value);
                      pending.current = null;
                    }}
                  />
                </label>
                <label>
                  시작 시각
                  <input
                    required
                    type="datetime-local"
                    value={startedAt}
                    onChange={(event) => {
                      setStartedAt(event.target.value);
                      pending.current = null;
                    }}
                  />
                </label>
                <label>
                  확인한 소요 시간 (초, 모르면 비움)
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={duration}
                    onChange={(event) => {
                      setDuration(event.target.value);
                      pending.current = null;
                    }}
                  />
                </label>
              </>
            )}
          </fieldset>
          <Button type="submit" disabled={busy}>
            {startUncertain ? '같은 시작 명령 재시도' : '확인하고 수행 시작'}
          </Button>
        </form>
        {message ? <p role="status">{message}</p> : null}
      </section>
      <section className={styles.card} aria-labelledby="perform-title">
        <h2 id="perform-title">세트 수행</h2>
        {executionId === null ? (
          <p>수행을 시작하거나 기존 수행을 선택하세요.</p>
        ) : current.data ? (
          <>
            {current.isError ? (
              <p role="alert">
                최신 수행 상태를 불러오지 못했습니다. 초안은 유지되며 다시 조회할 때까지 저장할 수
                없습니다.
              </p>
            ) : null}
            {current.isFetching ? <p role="status">최신 수행 상태 확인 중</p> : null}
            {current.isError ? (
              <Button type="button" variant="secondary" onClick={() => void current.refetch()}>
                수행 다시 조회
              </Button>
            ) : null}
            <Runner
              key={executionId}
              api={api}
              scope={scope}
              executionId={executionId}
              execution={current.data}
              exercises={exercises.data?.items ?? []}
              writable={!current.isError && !current.isFetching}
            />
          </>
        ) : current.isPending ? (
          <p role="status">수행 불러오는 중</p>
        ) : (
          <p role="alert">
            수행을 불러오지 못했습니다.{' '}
            <Button type="button" variant="secondary" onClick={() => void current.refetch()}>
              다시 조회
            </Button>
          </p>
        )}
      </section>
    </div>
  );
}

function Runner({
  api,
  scope,
  executionId,
  execution,
  exercises,
  writable,
}: {
  api: SupplementaryApi;
  scope: SupplementaryScope;
  executionId: string;
  execution: NonNullable<Awaited<ReturnType<SupplementaryApi['readExecution']>>>;
  exercises: ExerciseVersionRead[];
  writable: boolean;
}) {
  const [store] = useState(createRunnerStore);
  const draft = useStore(store, (state) => state.draft);
  const correcting = useStore(store, (state) => state.correcting);
  const timerId = useStore(store, (state) => state.timerId);
  const actions = useStore(store, (state) => state.actions);
  const client = useQueryClient();
  const sets = useQuery({
    queryKey: [...scope, 'sets', executionId],
    queryFn: ({ signal }) => api.listSets(executionId, signal),
  });
  const timers = useQuery({
    queryKey: [...scope, 'timers', executionId],
    queryFn: ({ signal }) => api.listTimers(executionId, signal),
  });
  const activeTimerId =
    timerId ?? timers.data?.items.find((item) => item.status !== 'finished')?.timerId ?? null;
  const timer = useQuery({
    queryKey: [...scope, 'timer', executionId, activeTimerId],
    queryFn: ({ signal }) => {
      if (activeTimerId === null) throw new Error('TIMER_ID_REQUIRED');
      return api.readTimer(activeTimerId, signal);
    },
    enabled: activeTimerId !== null,
  });
  const pendingSet = useRef<SetLogCreateCommand | SetLogCorrectCommand | null>(null);
  const pendingDelete = useRef<SetLogDeleteCommand | null>(null);
  const pendingTimer = useRef<RestTimerCommand | null>(null);
  const pendingCompletion = useRef<ExecutionStatusCommand | null>(null);
  const [now, setNow] = useState(() => new Date().toISOString());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [setUncertain, markSetUncertain] = useState(false);
  const [correctionNeedsReview, setCorrectionNeedsReview] = useState(false);
  const [deleteUncertain, markDeleteUncertain] = useState(false);
  const [deleteUncertainLogId, setDeleteUncertainLogId] = useState<string | null>(null);
  const [timerUncertain, markTimerUncertain] = useState(false);
  const [completionUncertainStatus, setCompletionUncertainStatus] = useState<
    ExecutionStatusCommand['status'] | null
  >(null);
  const [restDuration, setRestDuration] = useState('60');
  useEffect(() => {
    const update = () => setNow(new Date().toISOString());
    const interval = window.setInterval(update, 1000);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  const selectedExercise = exercises.find(
    (item) => item.definition.versionId === draft.exerciseVersionId,
  );
  const currentLog = correcting
    ? sets.data?.items.find(
        (item) => item.status === 'active' && item.current.logId === correcting.logId,
      )
    : null;
  const targetSets = useMemo(
    () =>
      execution.plannedSession?.content.kind === 'embedded'
        ? execution.plannedSession.content.spec.blocks.flatMap((block) =>
            block.sets.map((set) => ({ ...set, blockId: block.id })),
          )
        : [],
    [execution.plannedSession],
  );
  const routineVersionId =
    execution.plannedSession?.content.kind === 'routine_version'
      ? execution.plannedSession.content.routineVersionId
      : null;
  const frozenRoutine = useQuery({
    queryKey: [...scope, 'routine-version', routineVersionId],
    queryFn: ({ signal }) => {
      if (routineVersionId === null) throw new Error('ROUTINE_VERSION_ID_REQUIRED');
      return api.readRoutineVersion(routineVersionId, signal);
    },
    enabled: routineVersionId !== null,
  });
  const frozenTargets =
    routineVersionId === null
      ? targetSets
      : (frozenRoutine.data?.template.spec.blocks.flatMap((block) =>
          block.sets.map((set) => ({ ...set, blockId: block.id })),
        ) ?? []);
  const definition =
    frozenTargets.find((target) => target.id === draft.targetSetId)?.count?.definition ??
    (currentLog?.status === 'active' ? currentLog.current.count?.definition : null) ??
    selectedExercise?.definition.countDefinitions[0] ??
    null;
  const correctionStale =
    correcting !== null &&
    (correctionNeedsReview ||
      currentLog?.status !== 'active' ||
      currentLog.current.revision !== correcting.revision);
  const correctionAwaitingReplay = correcting !== null && setUncertain;
  function change<K extends keyof SetDraft>(key: K, value: SetDraft[K]) {
    pendingSet.current = null;
    actions.change(key, value);
  }
  async function submitSet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || deleteUncertain || !writable || sets.isFetching || sets.isError || !sets.data)
      return;
    const retryCommand = pendingSet.current;
    if (setUncertain && retryCommand === null) {
      markSetUncertain(false);
      setNotice('재시도할 명령을 찾지 못했습니다. 최신 기록을 확인하고 다시 선택하세요.');
      return;
    }
    if (
      correctionStale &&
      !(
        setUncertain &&
        retryCommand !== null &&
        'expectedRevision' in retryCommand &&
        correcting !== null &&
        retryCommand.logId === correcting.logId
      )
    ) {
      setNotice(
        '정정 중인 세트가 변경됐습니다. 최신 기록과 초안을 비교한 뒤 목록에서 다시 정정을 선택하세요.',
      );
      return;
    }
    setBusy(true);
    setNotice('');
    try {
      const command =
        retryCommand ??
        (() => {
          const values = setValuesFromInputs({
            ...draft,
            definition,
            occurredAt: correcting?.occurredAt ?? new Date().toISOString(),
          });
          if (correcting)
            return {
              schemaVersion: 2 as const,
              executionId,
              logId: correcting.logId,
              expectedRevision: correcting.revision,
              idempotencyKey: crypto.randomUUID(),
              confirmation:
                draft.state === 'unconfirmed' ? ('draft' as const) : ('user_confirmed' as const),
              values,
            };
          return {
            schemaVersion: 2 as const,
            executionId,
            logId: crypto.randomUUID(),
            expectedExecutionRevision: execution.revision,
            idempotencyKey: crypto.randomUUID(),
            confirmation:
              draft.state === 'unconfirmed' ? ('draft' as const) : ('user_confirmed' as const),
            values,
          };
        })();
      pendingSet.current = command;
      if ('expectedRevision' in command) {
        await api.correctSet(command);
      } else {
        await api.createSet(command);
      }
      pendingSet.current = null;
      markSetUncertain(false);
      actions.reset();
      setNotice('세트 기록을 저장했습니다.');
      await Promise.all([
        client.invalidateQueries({ queryKey: [...scope, 'sets', executionId] }),
        client.invalidateQueries({ queryKey: [...scope, 'execution', executionId] }),
        client.invalidateQueries({ queryKey: [...scope, 'executions'] }),
      ]);
    } catch (error) {
      if (error instanceof SupplementaryRequestError && error.status === 409) {
        pendingSet.current = null;
        markSetUncertain(false);
        if (correcting) setCorrectionNeedsReview(true);
        setNotice(
          '세트 버전이 변경됐습니다. 최신 기록과 초안을 비교한 뒤 목록에서 다시 정정을 선택하세요.',
        );
        await Promise.all([
          client.invalidateQueries({ queryKey: [...scope, 'sets', executionId] }),
          client.invalidateQueries({ queryKey: [...scope, 'execution', executionId] }),
        ]);
      } else if (
        error instanceof ZodError ||
        (error instanceof SupplementaryRequestError && error.status < 500)
      ) {
        pendingSet.current = null;
        markSetUncertain(false);
        setNotice('입력 또는 기록 버전이 맞지 않습니다. 최신 목록을 확인하고 수정하세요.');
      } else if (pendingSet.current) {
        markSetUncertain(true);
        setNotice('저장 결과가 불확실합니다. 값을 바꾸지 말고 같은 명령을 다시 시도하세요.');
      } else {
        setNotice('세트 값을 확인하세요. 실제 수행에는 확인한 양수 값이 필요합니다.');
      }
    } finally {
      setBusy(false);
    }
  }
  async function deleteSet(item: Extract<SetLogRead, { status: 'active' }>) {
    if (busy || !writable || sets.isFetching || sets.isError || !sets.data) return;
    if (pendingDelete.current && pendingDelete.current.logId !== item.current.logId) return;
    setBusy(true);
    try {
      const command: SetLogDeleteCommand = pendingDelete.current ?? {
        schemaVersion: 2,
        executionId,
        logId: item.current.logId,
        expectedRevision: item.current.revision,
        idempotencyKey: crypto.randomUUID(),
        confirmed: true,
        reason: '사용자가 세트 기록 삭제',
      };
      pendingDelete.current = command;
      await api.deleteSet(command);
      pendingDelete.current = null;
      markDeleteUncertain(false);
      setDeleteUncertainLogId(null);
      await Promise.all([
        client.invalidateQueries({ queryKey: [...scope, 'sets', executionId] }),
        client.invalidateQueries({ queryKey: [...scope, 'execution', executionId] }),
      ]);
      setNotice('세트 기록을 삭제했습니다.');
    } catch (error) {
      if (error instanceof SupplementaryRequestError && error.status === 409) {
        pendingDelete.current = null;
        markDeleteUncertain(false);
        setDeleteUncertainLogId(null);
        setNotice('세트 버전이 변경됐습니다. 최신 기록을 다시 확인하세요.');
        await Promise.all([
          client.invalidateQueries({ queryKey: [...scope, 'sets', executionId] }),
          client.invalidateQueries({ queryKey: [...scope, 'execution', executionId] }),
        ]);
      } else if (
        error instanceof ZodError ||
        (error instanceof SupplementaryRequestError && error.status < 500)
      ) {
        pendingDelete.current = null;
        markDeleteUncertain(false);
        setDeleteUncertainLogId(null);
        setNotice('삭제 요청을 확인하세요.');
      } else {
        markDeleteUncertain(true);
        setDeleteUncertainLogId(item.current.logId);
        setNotice('삭제 결과가 불확실합니다. 같은 세트 삭제를 다시 시도하세요.');
      }
    } finally {
      setBusy(false);
    }
  }
  async function timerCommand(action: RestTimerCommand['action']) {
    if (busy || deleteUncertain || !writable) return;
    if (pendingTimer.current && pendingTimer.current.action !== action) {
      setNotice('이전 타이머 명령의 결과가 불확실합니다. 같은 명령을 다시 시도하세요.');
      return;
    }
    const currentTimer = timer.data;
    if (action !== 'start' && !currentTimer) return;
    setBusy(true);
    setNotice('');
    try {
      let command: RestTimerCommand;
      if (pendingTimer.current) command = pendingTimer.current;
      else if (action === 'start') {
        command = {
          action,
          executionId,
          timerId: crypto.randomUUID(),
          durationSeconds: Number(restDuration),
          at: new Date().toISOString(),
          idempotencyKey: crypto.randomUUID(),
        };
      } else {
        if (!currentTimer) throw new Error('TIMER_UNAVAILABLE');
        command = {
          action,
          executionId,
          timerId: currentTimer.timerId,
          expectedRevision: currentTimer.revision,
          at: new Date().toISOString(),
          idempotencyKey: crypto.randomUUID(),
        };
      }
      pendingTimer.current = command;
      const saved = await api.commandTimer(command);
      pendingTimer.current = null;
      markTimerUncertain(false);
      actions.setTimerId(saved.timerId);
      client.setQueryData([...scope, 'timer', executionId, saved.timerId], saved);
      await client.invalidateQueries({ queryKey: [...scope, 'timers', executionId] });
      setNow(new Date().toISOString());
    } catch (error) {
      if (error instanceof SupplementaryRequestError && error.status === 409) {
        pendingTimer.current = null;
        markTimerUncertain(false);
        setNotice('타이머 상태가 변경됐습니다. 최신 상태를 다시 불러왔습니다.');
        await Promise.all([
          client.invalidateQueries({ queryKey: [...scope, 'timers', executionId] }),
          client.invalidateQueries({ queryKey: [...scope, 'timer', executionId, activeTimerId] }),
        ]);
      } else if (
        error instanceof ZodError ||
        (error instanceof SupplementaryRequestError && error.status < 500)
      ) {
        pendingTimer.current = null;
        markTimerUncertain(false);
        setNotice('타이머 요청을 확인하세요. 세트 실제 기록에는 영향이 없습니다.');
      } else {
        markTimerUncertain(true);
        setNotice(
          '타이머 결과가 불확실합니다. 같은 명령을 다시 시도하세요. 세트 실제 기록에는 영향이 없습니다.',
        );
      }
    } finally {
      setBusy(false);
    }
  }
  async function complete(status: ExecutionStatusCommand['status']) {
    if (busy || deleteUncertain || !writable || execution.status !== 'active') return;
    if (pendingCompletion.current && pendingCompletion.current.status !== status) {
      setNotice('이전 종료 명령의 결과가 불확실합니다. 같은 명령을 다시 시도하세요.');
      return;
    }
    setBusy(true);
    setNotice('');
    try {
      const command: ExecutionStatusCommand = pendingCompletion.current ?? {
        schemaVersion: 2,
        executionId,
        expectedRevision: execution.revision,
        status,
        endedAt: new Date().toISOString(),
        idempotencyKey: crypto.randomUUID(),
        confirmed: true,
      };
      pendingCompletion.current = command;
      await api.completeExecution(command);
      pendingCompletion.current = null;
      setCompletionUncertainStatus(null);
      setNotice(status === 'finished' ? '수행 종료를 확인했습니다.' : '수행 중단을 확인했습니다.');
      await Promise.all([
        client.invalidateQueries({ queryKey: [...scope, 'execution', executionId] }),
        client.invalidateQueries({ queryKey: [...scope, 'executions'] }),
      ]);
    } catch (error) {
      if (error instanceof SupplementaryRequestError && error.status === 409) {
        pendingCompletion.current = null;
        setCompletionUncertainStatus(null);
        setNotice('수행 상태가 변경됐습니다. 최신 상태를 다시 확인하세요.');
        await client.invalidateQueries({ queryKey: [...scope, 'execution', executionId] });
      } else if (
        error instanceof ZodError ||
        (error instanceof SupplementaryRequestError && error.status < 500)
      ) {
        pendingCompletion.current = null;
        setCompletionUncertainStatus(null);
        setNotice('종료 요청을 확인하세요.');
      } else {
        setCompletionUncertainStatus(status);
        setNotice('종료 결과가 불확실합니다. 같은 명령을 다시 시도하세요.');
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={styles.stack}>
      <p>
        Activity{' '}
        <a href={`/activities?selected=${encodeURIComponent(execution.activityId)}`}>
          {execution.activityId}
        </a>{' '}
        · {execution.status} · 수정 {execution.revision}
      </p>
      {execution.status === 'active' ? (
        <div className={styles.actions}>
          <Button
            type="button"
            disabled={
              busy ||
              deleteUncertain ||
              !writable ||
              (completionUncertainStatus !== null && completionUncertainStatus !== 'finished')
            }
            onClick={() => void complete('finished')}
          >
            수행 종료 확인
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={
              busy ||
              deleteUncertain ||
              !writable ||
              (completionUncertainStatus !== null && completionUncertainStatus !== 'stopped')
            }
            onClick={() => void complete('stopped')}
          >
            중단 확인
          </Button>
        </div>
      ) : null}
      {execution.plannedSession ? (
        <p>
          계획 세션 {execution.plannedSession.plannedSessionId} · 고정된 계획 버전{' '}
          {execution.plannedSession.planVersionId}
        </p>
      ) : (
        <p>계획 세션 연결 없음</p>
      )}
      {routineVersionId ? (
        <p>고정된 루틴 버전 {routineVersionId}. 현재 라이브러리 버전으로 자동 대체하지 않습니다.</p>
      ) : null}
      {frozenRoutine.isError ? (
        <p role="alert">
          기록 당시 루틴 버전을 불러오지 못했습니다. 현재 버전으로 대체하지 않습니다.
        </p>
      ) : null}
      {frozenTargets.length > 0 ? (
        <section>
          <h3>계획된 세트</h3>
          <ul className={styles.list}>
            {frozenTargets.map((target) => (
              <li key={target.id}>
                동작 버전 {target.exerciseVersionId} ·{' '}
                {target.count
                  ? `${target.count.target.min} ${target.count.definition.kind}/${target.count.definition.basis}`
                  : target.durationSeconds
                    ? `${target.durationSeconds.min}초`
                    : '수치 미상'}{' '}
                <Button
                  type="button"
                  variant="secondary"
                  disabled={
                    busy ||
                    setUncertain ||
                    deleteUncertain ||
                    !writable ||
                    sets.isFetching ||
                    sets.isError
                  }
                  onClick={() => {
                    pendingSet.current = null;
                    setCorrectionNeedsReview(false);
                    actions.selectTarget(target.exerciseVersionId, target.id, target.blockId);
                  }}
                >
                  이 세트 기록
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {sets.isPending ? <p role="status">세트 기록 불러오는 중</p> : null}
      {sets.isError ? <p role="alert">세트 기록을 불러오지 못했습니다.</p> : null}
      {sets.data?.hasMore ? <p role="status">세트 기록이 일부만 표시됩니다.</p> : null}
      <section>
        <h3>실제 세트와 초안</h3>
        <ul className={styles.list}>
          {sets.data?.items.map((item) =>
            item.status === 'deleted' ? (
              <li key={item.logId}>삭제된 세트 · 수정 {item.revision}</li>
            ) : (
              <li key={item.current.logId}>
                동작 버전 {item.current.exerciseVersionId} · {item.current.state} ·{' '}
                {item.current.count?.actual.value ?? '횟수 미상'}회 ·{' '}
                {item.current.durationSeconds.value ?? '시간 미상'}초 · 수정 {item.current.revision}{' '}
                <Button
                  type="button"
                  variant="secondary"
                  disabled={
                    busy ||
                    setUncertain ||
                    deleteUncertain ||
                    !writable ||
                    sets.isFetching ||
                    sets.isError
                  }
                  onClick={() => {
                    pendingSet.current = null;
                    setCorrectionNeedsReview(false);
                    actions.correct(
                      item.current.logId,
                      item.current.revision,
                      item.current.occurredAt,
                      {
                        exerciseVersionId: item.current.exerciseVersionId,
                        targetSetId: item.current.targetSetId,
                        blockId: item.current.blockId,
                        roundIndex:
                          item.current.roundIndex === null ? '' : String(item.current.roundIndex),
                        side: item.current.side,
                        state: item.current.state,
                        count:
                          item.current.count?.actual.value === null || item.current.count === null
                            ? ''
                            : String(item.current.count.actual.value),
                        duration:
                          item.current.durationSeconds.value === null
                            ? ''
                            : String(item.current.durationSeconds.value),
                        resistance:
                          item.current.externalResistance.kind === 'external'
                            ? String(item.current.externalResistance.totalKg.value ?? '')
                            : item.current.externalResistance.kind === 'assisted'
                              ? String(item.current.externalResistance.assistanceKg.value ?? '')
                              : '',
                        resistanceKind:
                          item.current.externalResistance.kind === 'external' ||
                          item.current.externalResistance.kind === 'assisted' ||
                          item.current.externalResistance.kind === 'no_added_load'
                            ? item.current.externalResistance.kind
                            : 'unknown',
                        rpe:
                          item.current.effort?.rpe === null || item.current.effort === null
                            ? ''
                            : String(item.current.effort.rpe),
                        rir:
                          item.current.effort?.rir === null || item.current.effort === null
                            ? ''
                            : String(item.current.effort.rir),
                        reason: item.current.reason ?? '',
                      },
                    );
                  }}
                >
                  정정
                </Button>{' '}
                <Button
                  type="button"
                  variant="secondary"
                  disabled={
                    busy ||
                    !writable ||
                    sets.isFetching ||
                    sets.isError ||
                    (deleteUncertain && deleteUncertainLogId !== item.current.logId)
                  }
                  onClick={() => void deleteSet(item)}
                >
                  {deleteUncertain && deleteUncertainLogId === item.current.logId
                    ? '같은 삭제 명령 재시도'
                    : '삭제'}
                </Button>
              </li>
            ),
          )}
        </ul>
      </section>
      <form onSubmit={(event) => void submitSet(event)} className={styles.form}>
        <h3>{correcting ? '세트 정정' : '세트 추가'}</h3>
        {correctionStale && sets.data && !sets.isFetching ? (
          <p role="alert">
            {correctionAwaitingReplay
              ? '정정 중인 세트의 기준이 바뀌었지만 저장 결과가 불확실합니다. 먼저 같은 명령을 재시도해 결과를 확인하세요. 현재 초안은 유지됩니다.'
              : '정정 중인 세트의 기준이 바뀌었습니다. 위 최신 기록과 현재 초안을 비교한 뒤 목록에서 정정을 다시 선택하세요. 기존 초안은 비교를 위해 유지됩니다.'}
          </p>
        ) : null}
        <fieldset
          disabled={
            busy ||
            setUncertain ||
            deleteUncertain ||
            !writable ||
            sets.isFetching ||
            sets.isError ||
            !sets.data
          }
          className={styles.inputGroup}
        >
          <label>
            동작 버전
            <select
              required
              value={draft.exerciseVersionId}
              onChange={(event) => change('exerciseVersionId', event.target.value)}
            >
              <option value="">선택</option>
              {!exercises.some((item) => item.definition.versionId === draft.exerciseVersionId) &&
              draft.exerciseVersionId ? (
                <option value={draft.exerciseVersionId}>
                  기록 당시 동작 버전 {draft.exerciseVersionId}
                </option>
              ) : null}
              {exercises.map((item) => (
                <option key={item.definition.versionId} value={item.definition.versionId}>
                  {item.definition.name} · 버전 {item.version}
                </option>
              ))}
            </select>
          </label>
          <label>
            상태
            <select
              value={draft.state}
              onChange={(event) => change('state', event.target.value as SetDraft['state'])}
            >
              <option value="unconfirmed">미확인 초안</option>
              <option value="performed">수행 확인</option>
              <option value="partial">일부 수행</option>
              <option value="confirmed_skipped">미수행 확인</option>
              <option value="stopped">중단</option>
            </select>
          </label>
          <label>
            좌우
            <select
              value={draft.side}
              onChange={(event) => change('side', event.target.value as SetDraft['side'])}
            >
              <option value="bilateral">양측</option>
              <option value="left">왼쪽</option>
              <option value="right">오른쪽</option>
              <option value="alternating">교대</option>
              <option value="unspecified">미지정</option>
            </select>
          </label>
          {definition ? (
            <p>
              횟수 정의: {definition.kind} / {definition.basis}. 좌우 미기록을 자동으로 2배 계산하지
              않습니다.
            </p>
          ) : null}
          <label>
            실제 횟수 (모르면 비움)
            <input
              type="number"
              inputMode="numeric"
              min="0"
              step="1"
              value={draft.count}
              onChange={(event) => change('count', event.target.value)}
            />
          </label>
          <label>
            실제 시간 (초, 모르면 비움)
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={draft.duration}
              onChange={(event) => change('duration', event.target.value)}
            />
          </label>
          <label>
            외부저항 상태
            <select
              value={draft.resistanceKind}
              onChange={(event) =>
                change('resistanceKind', event.target.value as SetDraft['resistanceKind'])
              }
            >
              <option value="unknown">미상</option>
              <option value="no_added_load">추가 저항 없음</option>
              <option value="external">외부저항</option>
              <option value="assisted">보조저항</option>
            </select>
          </label>
          {draft.resistanceKind === 'external' || draft.resistanceKind === 'assisted' ? (
            <label>
              {draft.resistanceKind === 'external' ? '외부저항 총량' : '보조저항'} (kg)
              <input
                required
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={draft.resistance}
                onChange={(event) => change('resistance', event.target.value)}
              />
            </label>
          ) : null}
          {draft.targetSetId ? (
            <label>
              계획 블록 회차 (모르면 비움)
              <input
                type="number"
                min="0"
                step="1"
                value={draft.roundIndex}
                onChange={(event) => change('roundIndex', event.target.value)}
              />
            </label>
          ) : null}
          <label>
            RPE (0~10, 모르면 비움)
            <input
              type="number"
              min="0"
              max="10"
              step="any"
              value={draft.rpe}
              onChange={(event) => change('rpe', event.target.value)}
            />
          </label>
          <label>
            RIR (모르면 비움)
            <input
              type="number"
              min="0"
              step="any"
              value={draft.rir}
              onChange={(event) => change('rir', event.target.value)}
            />
          </label>
          <label>
            중단 이유
            <textarea
              value={draft.reason}
              onChange={(event) => change('reason', event.target.value)}
            />
          </label>
        </fieldset>
        <p>
          빈칸은 미상이며 0은 확인한 값입니다. 계획된 목표는 실제 값으로 자동 복사하지 않습니다.
        </p>
        <div className={styles.actions}>
          <Button
            type="submit"
            disabled={
              busy ||
              (correctionStale && !correctionAwaitingReplay) ||
              deleteUncertain ||
              !writable ||
              sets.isFetching ||
              sets.isError ||
              !sets.data
            }
          >
            {setUncertain
              ? '같은 세트 명령 재시도'
              : draft.state === 'unconfirmed'
                ? '세트 초안 저장'
                : '확인하고 실제 세트 저장'}
          </Button>
          {correcting ? (
            <Button
              type="button"
              variant="secondary"
              disabled={busy || setUncertain || deleteUncertain || !writable}
              onClick={() => {
                pendingSet.current = null;
                setCorrectionNeedsReview(false);
                actions.reset();
              }}
            >
              정정 취소
            </Button>
          ) : null}
        </div>
      </form>
      <section className={styles.timer} aria-labelledby="rest-title">
        <h3 id="rest-title">휴식 타이머</h3>
        <p>타이머 완료는 세트 수행이나 운동 종료로 기록되지 않습니다.</p>
        {activeTimerId === null ? (
          <>
            <label>
              휴식 길이 (초)
              <input
                type="number"
                min="1"
                max="86400"
                value={restDuration}
                disabled={busy || deleteUncertain || timerUncertain || !writable}
                onChange={(event) => {
                  setRestDuration(event.target.value);
                  pendingTimer.current = null;
                }}
              />
            </label>
            <Button
              type="button"
              disabled={busy || deleteUncertain || !writable || timers.isPending || timers.isError}
              onClick={() => void timerCommand('start')}
            >
              휴식 시작
            </Button>
          </>
        ) : timer.isPending ? (
          <p role="status">타이머 불러오는 중</p>
        ) : timer.isError || !timer.data ? (
          <p role="alert">타이머를 불러오지 못했습니다. 다시 조회하세요.</p>
        ) : (
          <>
            <p>
              남은 시간 {timerRemainingSeconds(timer.data, now)}초 · {timer.data.status}
            </p>
            <div className={styles.actions}>
              {timer.data.status === 'running' ? (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy || deleteUncertain || !writable || timer.isFetching}
                  onClick={() => void timerCommand('pause')}
                >
                  일시정지
                </Button>
              ) : null}
              {timer.data.status === 'paused' ? (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy || deleteUncertain || !writable || timer.isFetching}
                  onClick={() => void timerCommand('resume')}
                >
                  계속
                </Button>
              ) : null}
              {timer.data.status !== 'finished' ? (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy || deleteUncertain || !writable || timer.isFetching}
                  onClick={() => void timerCommand('finish')}
                >
                  타이머 종료
                </Button>
              ) : (
                <Button type="button" variant="secondary" onClick={() => actions.setTimerId(null)}>
                  새 휴식
                </Button>
              )}
            </div>
          </>
        )}
      </section>
      {notice ? <p role="status">{notice}</p> : null}
    </div>
  );
}
