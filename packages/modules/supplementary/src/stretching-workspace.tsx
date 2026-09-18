'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { ZodError } from 'zod';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import type {
  StretchLogCreate,
  StretchLogCorrect,
  StretchLogRevision,
} from '@workout/contracts/stretching';
import type { StretchingExerciseRead } from '@workout/contracts/stretching';
import { Button } from '@workout/ui-foundation/button';
import { createStretchingApi, StretchingRequestError } from './stretching-api';
import {
  emptyStretchForm,
  localDateTimeInput,
  stretchValuesFromForm,
  type StretchForm,
} from './stretching-model';
import { StretchingExerciseForm } from './stretching-exercise-form';
import styles from './supplementary.module.css';

export interface StretchingWorkspaceProps {
  athleteId: string;
  sessionId: string;
  transport: AuthenticatedTransport;
  exerciseId: string | null;
  activityId: string | null;
}
const href = (exerciseId: string | null, activityId: string | null) => {
  const path =
    exerciseId === null ? '/stretching' : `/stretching/exercises/${encodeURIComponent(exerciseId)}`;
  return activityId === null ? path : `${path}?activityId=${encodeURIComponent(activityId)}`;
};
function formFromLog(log: StretchLogRevision): StretchForm {
  return {
    side: log.side,
    state: log.state,
    metric:
      log.holdSeconds === null ? (log.repetitions?.toString() ?? '') : String(log.holdSeconds),
    rest: log.restSeconds?.toString() ?? '',
    comfort: log.comfort,
    discomfortNote: log.discomfortNote ?? '',
    reason: log.reason ?? '',
    occurredAt: localDateTimeInput(log.occurredAt),
    allocation: log.allocation.kind,
    plannedTargetId: log.plannedTarget?.targetSetId ?? '',
    blockStart:
      log.allocation.kind === 'activity_block' && log.allocation.startedAt
        ? localDateTimeInput(log.allocation.startedAt)
        : '',
    blockEnd:
      log.allocation.kind === 'activity_block' && log.allocation.endedAtExclusive
        ? localDateTimeInput(log.allocation.endedAtExclusive)
        : '',
  };
}
export function StretchingWorkspace(props: StretchingWorkspaceProps) {
  return <Lifetime key={JSON.stringify([props.athleteId, props.sessionId])} {...props} />;
}
function Lifetime(props: StretchingWorkspaceProps) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      }),
  );
  useEffect(() => () => client.clear(), [client]);
  return (
    <QueryClientProvider client={client}>
      <Workspace {...props} />
    </QueryClientProvider>
  );
}
function Workspace({
  athleteId,
  sessionId,
  transport,
  exerciseId,
  activityId,
}: StretchingWorkspaceProps) {
  const api = useMemo(() => createStretchingApi(transport), [transport]);
  const client = useQueryClient();
  const scope = ['users', athleteId, 'sessions', sessionId, 'stretching'];
  const exercises = useQuery({
    queryKey: [...scope, 'exercises'],
    queryFn: ({ signal }) => api.listExercises(signal),
  });
  const detail = useQuery({
    queryKey: [...scope, 'exercise', exerciseId],
    enabled: exerciseId !== null,
    queryFn: ({ signal }) => {
      if (exerciseId === null) throw new Error('EXERCISE_ID_REQUIRED');
      return api.readExercise(exerciseId, signal);
    },
  });
  const activities = useQuery({
    queryKey: [...scope, 'activities'],
    queryFn: ({ signal }) => api.listActivities(signal),
  });
  const logs = useQuery({
    queryKey: [...scope, 'logs', activityId],
    queryFn: ({ signal }) => api.listLogs(activityId, signal),
  });
  const targets = useQuery({
    queryKey: [...scope, 'targets', activityId],
    enabled: activityId !== null,
    queryFn: ({ signal }) => {
      if (activityId === null) throw new Error('ACTIVITY_ID_REQUIRED');
      return api.listTargets(activityId, signal);
    },
  });
  const selected = exerciseId === null ? null : (detail.data ?? null);
  const profile = selected?.profile ?? null;
  const [form, setForm] = useState<StretchForm>(emptyStretchForm);
  const [editing, setEditing] = useState<StretchLogRevision | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState('');
  const [editingDefinition, setEditingDefinition] = useState<'new' | 'existing' | null>(null);
  const [savedDefinition, setSavedDefinition] = useState<StretchingExerciseRead | null>(null);
  const pending = useRef<StretchLogCreate | StretchLogCorrect | null>(null);
  function change<K extends keyof StretchForm>(key: K, value: StretchForm[K]) {
    if (busy || uncertain) return;
    setForm((current) => ({ ...current, [key]: value }));
    pending.current = null;
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !profile || activityId === null || busy) return;
    let command: StretchLogCreate | StretchLogCorrect;
    try {
      const frozen = pending.current;
      if (frozen) command = frozen;
      else {
        const values = stretchValuesFromForm(
          form,
          activityId,
          selected,
          targets.data?.items ?? [],
          editing,
        );
        const confirmation = form.state === 'unconfirmed' ? 'draft' : 'user_confirmed';
        const idempotencyKey = crypto.randomUUID();
        command = editing
          ? {
              schemaVersion: 1,
              logId: editing.logId,
              expectedRevision: editing.revision,
              idempotencyKey,
              confirmation,
              values,
            }
          : {
              schemaVersion: 1,
              logId: crypto.randomUUID(),
              idempotencyKey,
              confirmation,
              values,
            };
      }
    } catch {
      setMessage('수행 값·시각·구간을 확인하세요. 빈 값은 미확인으로 남습니다.');
      return;
    }
    pending.current = command;
    setBusy(true);
    setMessage('');
    try {
      const saved =
        'expectedRevision' in command
          ? await api.correctLog(command)
          : await api.createLog(command);
      pending.current = null;
      setUncertain(false);
      setEditing(null);
      setForm(emptyStretchForm);
      setMessage(
        saved.status === 'active' && saved.current.state === 'unconfirmed'
          ? '미확인 초안을 저장했습니다. 실제 수행으로 집계되지 않습니다.'
          : '사용자가 확인한 스트레칭 실제를 저장했습니다. Activity 시간은 더하지 않습니다.',
      );
      await client.invalidateQueries({ queryKey: [...scope, 'logs', activityId] });
    } catch (error) {
      if (
        error instanceof ZodError ||
        (error instanceof StretchingRequestError && error.status < 500)
      ) {
        pending.current = null;
        setUncertain(false);
        setMessage('동작 버전·활동 연결·입력 값을 확인하고 다시 시도하세요.');
      } else {
        setUncertain(true);
        setMessage('저장 결과가 불확실합니다. 값을 바꾸지 말고 같은 명령을 재시도하세요.');
      }
    } finally {
      setBusy(false);
    }
  }
  const validStretch = profile !== null;
  const withdrawn = selected?.definition.reviewState === 'withdrawn';
  return (
    <section className={styles.workspace} aria-label="스트레칭 작업 공간">
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>스트레칭 · 수동 계획과 실제</p>
          <h1>스트레칭</h1>
          <p>
            공통 동작 버전과 canonical Activity를 연결합니다. 타이머·공급자 요약은 좌우 실제의
            증거가 아닙니다.
          </p>
        </div>
        <nav aria-label="스트레칭 화면" className={styles.nav}>
          <a href="/stretching">동작 탐색</a>
          <a href="/supplementary/exercises">공통 동작 라이브러리</a>
          <a href="/supplementary">운동 계획</a>
          <a href="/activities/new">단독 Activity 만들기</a>
        </nav>
      </header>
      <div className={styles.columns}>
        <section className={styles.card} aria-labelledby="stretch-list-title">
          <div className={styles.head}>
            <h2 id="stretch-list-title">스트레칭 동작</h2>
            <Button type="button" onClick={() => setEditingDefinition('new')}>
              동작 추가
            </Button>
          </div>
          <p>기존 mobility 동작은 자동으로 스트레칭에 포함되지 않습니다.</p>
          {exercises.isPending ? <p role="status">동작 불러오는 중</p> : null}
          {exercises.isError ? <p role="alert">동작 목록을 불러오지 못했습니다.</p> : null}
          {exercises.data?.hasMore ? <p role="status">동작 목록 일부만 표시됩니다.</p> : null}
          {exercises.data?.items.length === 0 ? <p>등록된 스트레칭 동작이 없습니다.</p> : null}
          <ul className={styles.list}>
            {exercises.data?.items.map((item) => (
              <li key={item.definition.exerciseId}>
                <a href={href(item.definition.exerciseId, activityId)}>{item.definition.name}</a>
                <p>
                  {item.profile.method === 'static_hold' ? '정적 유지' : '동적 반복'}
                  {' · '}
                  {item.profile.bodyRegions.join(', ')}
                  {' · '}버전 {item.version}
                  {' · '}
                  {item.definition.reviewState === 'reviewed' ? '자료 검토됨' : '미검토'}
                </p>
              </li>
            ))}
          </ul>
        </section>
        <section className={styles.card} aria-labelledby="stretch-detail-title">
          <h2 id="stretch-detail-title">{selected?.definition.name ?? '동작 상세'}</h2>
          {exerciseId !== null && detail.isPending ? <p role="status">상세 불러오는 중</p> : null}
          {detail.isError ? <p role="alert">동작 상세를 불러오지 못했습니다.</p> : null}
          {selected && !validStretch ? (
            <p role="alert">스트레칭 프로필이 없는 동작입니다.</p>
          ) : null}
          {selected && profile ? (
            <>
              <p>{selected.definition.description}</p>
              <p>주의·중단 안내: {selected.definition.safetyNotes || '등록된 안내가 없습니다.'}</p>
              <p>
                방법 {profile.method === 'static_hold' ? '정적 유지' : '동적 반복'}
                {' · '}움직임 {profile.movement}
                {' · '}보조 {profile.assistance}
                {' · '}맥락 {profile.context}
              </p>
              <p>
                부위 {profile.bodyRegions.join(', ')} · 좌우 기준 {profile.sideBasis}
              </p>
              <p>
                출처{' '}
                {profile.source.kind === 'user_authored'
                  ? '사용자 입력'
                  : `자료 버전 ${profile.source.resourceVersionId}`}
                {' · '}검토 {selected.definition.reviewState}
                {' · '}자료 {selected.definition.resourceVersionIds.length}개{' · '}미디어{' '}
                {selected.definition.mediaAssetIds.length}개
              </p>
              {withdrawn ? (
                <p role="alert">
                  이 동작은 철회되어 새 수행 기록을 만들 수 없습니다. 과거 기록은 유지됩니다.
                </p>
              ) : null}
              <p>동작 설명의 검토 상태는 효과·부상 예방·재활 효능 검증을 뜻하지 않습니다.</p>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setEditingDefinition('existing')}
              >
                새 버전으로 편집
              </Button>
            </>
          ) : (
            <p>동작을 선택하면 방법과 실제를 기록할 수 있습니다.</p>
          )}
          {savedDefinition ? (
            <p role="status">
              버전 {savedDefinition.version}을 저장했습니다.{' '}
              <a href={href(savedDefinition.definition.exerciseId, activityId)}>새 버전 보기</a>
            </p>
          ) : null}
          {editingDefinition ? (
            <StretchingExerciseForm
              key={
                editingDefinition === 'new' ? 'new' : (selected?.definition.versionId ?? 'missing')
              }
              api={api}
              prior={editingDefinition === 'existing' ? selected : null}
              onCancel={() => setEditingDefinition(null)}
              onSaved={(read) => {
                setSavedDefinition(read);
                setEditingDefinition(null);
                void client.invalidateQueries({ queryKey: [...scope, 'exercises'] });
                void client.invalidateQueries({
                  queryKey: [...scope, 'exercise', read.definition.exerciseId],
                });
              }}
            />
          ) : null}
        </section>
      </div>
      <div className={styles.columns}>
        <section className={styles.card} aria-labelledby="stretch-activity-title">
          <h2 id="stretch-activity-title">Activity 선택</h2>
          <p>
            계획 없는 단독 수행은 Activity를 먼저 만든 뒤 연결합니다. 운동 일부라면 기존 Activity를
            선택합니다.
          </p>
          {activities.isPending ? <p role="status">활동 불러오는 중</p> : null}
          {activities.isError ? <p role="alert">활동 목록을 불러오지 못했습니다.</p> : null}
          {activities.data && activities.data.total > activities.data.items.length ? (
            <p role="status">
              최근 활동 일부만 표시됩니다. 오래된 활동은 Activity 원장에서 확인하세요.
            </p>
          ) : null}
          <ul className={styles.list}>
            {activities.data?.items.map((activity) => (
              <li key={activity.id}>
                <a
                  href={href(exerciseId, activity.id)}
                  aria-current={activityId === activity.id ? 'page' : undefined}
                >
                  {activity.effective.title ?? activity.original.title ?? '제목 없는 활동'}
                </a>
                <p>
                  {activity.effective.startedAt ?? '시각 미확인'} · {activity.effective.kind}
                  {' · '}
                  {activity.source.kind}
                </p>
              </li>
            ))}
          </ul>
          {activityId !== null && !activities.data?.items.some((item) => item.id === activityId) ? (
            <p>
              선택한 Activity가 최근 목록 밖에 있습니다. 저장 시 소유권과 삭제 상태를 확인합니다.
            </p>
          ) : null}
        </section>
        <section className={styles.card} aria-labelledby="stretch-log-title">
          <h2 id="stretch-log-title">실제 기록</h2>
          {activityId === null || selected === null || !validStretch ? (
            <p>동작과 Activity를 선택하세요.</p>
          ) : null}
          {message ? (
            <p role={message.includes('못') || message.includes('확인하고') ? 'alert' : 'status'}>
              {message}
            </p>
          ) : null}
          {activityId !== null && selected !== null && validStretch ? (
            <form className={styles.form} onSubmit={(event) => void submit(event)}>
              <fieldset
                className={styles.inputGroup}
                disabled={busy || uncertain || (withdrawn && editing === null)}
              >
                <legend>{editing ? '기록 정정' : '새 기록'}</legend>
                <label>
                  좌우·전체
                  <select
                    value={form.side}
                    onChange={(event) => change('side', event.target.value as StretchForm['side'])}
                  >
                    <option value="unknown">미확인</option>
                    <option value="left">왼쪽</option>
                    <option value="right">오른쪽</option>
                    <option value="both">양쪽 동시</option>
                    <option value="total">전체 합계</option>
                  </select>
                </label>
                <label>
                  수행 상태
                  <select
                    value={form.state}
                    onChange={(event) =>
                      change('state', event.target.value as StretchForm['state'])
                    }
                  >
                    <option value="unconfirmed">미확인 초안</option>
                    <option value="performed">수행 확인</option>
                    <option value="partial">부분 수행</option>
                    <option value="stopped">중단</option>
                    <option value="confirmed_skipped">건너뜀 확인</option>
                  </select>
                </label>
                <label>
                  {profile?.method === 'static_hold' ? '확인한 유지시간 (초)' : '확인한 반복 횟수'}
                  <input
                    type="number"
                    min="0"
                    step={profile?.method === 'static_hold' ? 'any' : '1'}
                    value={form.metric}
                    onChange={(event) => change('metric', event.target.value)}
                  />
                </label>
                <label>
                  확인한 휴식 (초, 선택)
                  <input
                    type="number"
                    min="0"
                    value={form.rest}
                    onChange={(event) => change('rest', event.target.value)}
                  />
                </label>
                <label>
                  수행 시각
                  <input
                    required
                    type="datetime-local"
                    value={form.occurredAt}
                    onChange={(event) => change('occurredAt', event.target.value)}
                  />
                </label>
                <label>
                  Activity 안의 위치
                  <select
                    value={form.allocation}
                    onChange={(event) =>
                      change('allocation', event.target.value as StretchForm['allocation'])
                    }
                  >
                    <option value="standalone">단독 수행</option>
                    <option value="activity_block">기존 운동의 일부</option>
                  </select>
                </label>
                <label>
                  계획 세트 연결 (선택)
                  <select
                    value={form.plannedTargetId}
                    onChange={(event) => change('plannedTargetId', event.target.value)}
                  >
                    <option value="">계획 없이 기록</option>
                    {targets.data?.items
                      .filter(
                        (target) => target.exerciseVersionId === selected.definition.versionId,
                      )
                      .map((target) => (
                        <option key={target.targetSetId} value={target.targetSetId}>
                          {target.targetSetId} · {target.side} · 계획{' '}
                          {target.plannedHoldSeconds
                            ? `${target.plannedHoldSeconds.min}–${target.plannedHoldSeconds.max}초`
                            : target.plannedRepetitions
                              ? `${target.plannedRepetitions.min}–${target.plannedRepetitions.max}회`
                              : '미확인'}
                        </option>
                      ))}
                  </select>
                </label>
                {targets.isError ? (
                  <p role="alert">
                    계획 세트를 불러오지 못했습니다. 계획 없는 실제로만 저장할 수 있습니다.
                  </p>
                ) : null}
                {form.allocation === 'activity_block' ? (
                  <>
                    <p>구간을 모르면 비워 둡니다. 공급자 요약으로 시작·끝을 추정하지 않습니다.</p>
                    <label>
                      구간 시작 (선택)
                      <input
                        type="datetime-local"
                        value={form.blockStart}
                        onChange={(event) => change('blockStart', event.target.value)}
                      />
                    </label>
                    <label>
                      구간 끝 (선택)
                      <input
                        type="datetime-local"
                        value={form.blockEnd}
                        onChange={(event) => change('blockEnd', event.target.value)}
                      />
                    </label>
                  </>
                ) : null}
                <label>
                  체감
                  <select
                    value={form.comfort}
                    onChange={(event) =>
                      change('comfort', event.target.value as StretchForm['comfort'])
                    }
                  >
                    <option value="unknown">미확인</option>
                    <option value="comfortable">편안함</option>
                    <option value="discomfort">불편감</option>
                  </select>
                </label>
                {form.comfort === 'discomfort' ? (
                  <label>
                    불편감 설명
                    <textarea
                      required
                      maxLength={2000}
                      value={form.discomfortNote}
                      onChange={(event) => change('discomfortNote', event.target.value)}
                    />
                  </label>
                ) : null}
                {form.state === 'stopped' ? (
                  <label>
                    중단 이유
                    <textarea
                      required
                      maxLength={2000}
                      value={form.reason}
                      onChange={(event) => change('reason', event.target.value)}
                    />
                  </label>
                ) : null}
                <p>
                  전체 시간은 좌우로 자동 분할하지 않습니다. 휴식과 유지시간, Activity 총시간도
                  별개입니다.
                </p>
              </fieldset>
              <div className={styles.actions}>
                <Button type="submit" disabled={busy || (withdrawn && editing === null)}>
                  {uncertain
                    ? '같은 저장 명령 재시도'
                    : editing
                      ? '정정 확인'
                      : form.state === 'unconfirmed'
                        ? '미확인 초안 저장'
                        : '실제 수행 확인·저장'}
                </Button>
                {editing ? (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy || uncertain}
                    onClick={() => {
                      setEditing(null);
                      setForm(emptyStretchForm);
                      pending.current = null;
                    }}
                  >
                    정정 취소
                  </Button>
                ) : null}
              </div>
            </form>
          ) : null}
        </section>
      </div>
      <section className={styles.card} aria-labelledby="stretch-records-title">
        <h2 id="stretch-records-title">
          {activityId === null ? '최근 스트레칭 실제' : '선택 Activity의 스트레칭 실제'}
        </h2>
        {logs.isPending ? <p role="status">실제 불러오는 중</p> : null}
        {logs.isError ? <p role="alert">실제를 불러오지 못했습니다.</p> : null}
        {logs.data?.hasMore ? <p role="status">최근 기록 일부만 표시됩니다.</p> : null}
        {logs.data?.items.length === 0 ? (
          <p>기록이 없습니다. 공급자 요약만으로 상세를 만들지 않습니다.</p>
        ) : null}
        <ul className={styles.list}>
          {logs.data?.items.map((entry) =>
            entry.status === 'active' ? (
              <li key={entry.current.logId}>
                <a
                  href={href(
                    exercises.data?.items.find(
                      (item) => item.definition.versionId === entry.current.exerciseVersionId,
                    )?.definition.exerciseId ?? null,
                    entry.current.activityId,
                  )}
                >
                  {entry.current.occurredAt} · {entry.current.side} · {entry.current.state}
                </a>
                <p>
                  유지 {entry.current.holdSeconds ?? '미확인'}초 · 반복{' '}
                  {entry.current.repetitions ?? '미확인'}회{' · '}휴식{' '}
                  {entry.current.restSeconds ?? '미확인'}초 · {entry.current.comfort}
                </p>
                <p>
                  Activity {entry.current.activityId} · {entry.current.allocation.kind}
                  {' · '}원본 사용자 확인 · 버전 {entry.current.revision}
                </p>
                {entry.current.plannedTarget ? (
                  <p>계획 세트 {entry.current.plannedTarget.targetSetId}</p>
                ) : null}
                {entry.current.reason ? <p>중단 이유: {entry.current.reason}</p> : null}
                {entry.current.discomfortNote ? (
                  <p>불편감: {entry.current.discomfortNote}</p>
                ) : null}
                {selected?.definition.versionId === entry.current.exerciseVersionId &&
                activityId === entry.current.activityId ? (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy || uncertain}
                    onClick={() => {
                      setEditing(entry.current);
                      setForm(formFromLog(entry.current));
                      setMessage('');
                      pending.current = null;
                    }}
                  >
                    이 기록 정정
                  </Button>
                ) : null}
              </li>
            ) : null,
          )}
        </ul>
        <p>단계 유지시간은 Activity 총시간에 다시 합산하지 않습니다.</p>
      </section>
    </section>
  );
}
