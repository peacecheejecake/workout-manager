import { useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ZodError } from 'zod';
import type {
  RoutineTemplateRead,
  RoutineTemplateSaveCommand,
} from '@workout/contracts/supplementary-core';
import { Button } from '@workout/ui-foundation/button';
import { SupplementaryRequestError, type SupplementaryApi } from './supplementary-api';
import {
  newTargetForm,
  specFromTargets,
  targetFormsFrom,
  type TargetForm,
} from './supplementary-model';
import type { SupplementaryScope } from './supplementary-workspace';
import styles from './supplementary.module.css';

export function RoutineWorkspace({
  api,
  scope,
  routineId,
}: {
  api: SupplementaryApi;
  scope: SupplementaryScope;
  routineId: string | null;
}) {
  const client = useQueryClient();
  const routines = useQuery({
    queryKey: [...scope, 'routines'],
    queryFn: ({ signal }) => api.listRoutines(signal),
  });
  const exercises = useQuery({
    queryKey: [...scope, 'exercises'],
    queryFn: ({ signal }) => api.listExercises(signal),
  });
  const detail = useQuery({
    queryKey: [...scope, 'routine', routineId],
    queryFn: ({ signal }) => {
      if (routineId === null) throw new Error('ROUTINE_ID_REQUIRED');
      return api.readRoutine(routineId, signal);
    },
    enabled: routineId !== null,
  });
  const selected = routineId === null ? null : (detail.data ?? null);
  const [editing, setEditing] = useState(false);
  const [draftPrior, setDraftPrior] = useState<RoutineTemplateRead | null>(null);
  const [title, setTitle] = useState('');
  const [purpose, setPurpose] = useState('');
  const [targets, setTargets] = useState<TargetForm[]>([]);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState('');
  const pending = useRef<RoutineTemplateSaveCommand | null>(null);
  function begin(record: RoutineTemplateRead | null) {
    if (busy || uncertain) return;
    setDraftPrior(record);
    setTitle(record?.template.title ?? '');
    setPurpose(record?.template.purpose ?? '');
    setTargets(record ? targetFormsFrom(record) : []);
    setEditing(true);
    setMessage('');
    setUncertain(false);
    pending.current = null;
  }
  function changeTarget(id: string, field: keyof TargetForm, value: string) {
    if (busy || uncertain) return;
    setTargets((current) =>
      current.map((target) => (target.id === id ? { ...target, [field]: value } : target)),
    );
    pending.current = null;
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (targets.length === 0) {
      setMessage('루틴에 세트를 하나 이상 추가하세요.');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const versionId = crypto.randomUUID();
      const command = pending.current ?? {
        template: {
          schemaVersion: 2 as const,
          routineId: draftPrior?.template.routineId ?? crypto.randomUUID(),
          versionId,
          title: title.trim(),
          purpose: purpose.trim(),
          requiredEquipment: [
            ...new Set([
              ...(draftPrior?.template.requiredEquipment ?? []),
              ...targets.flatMap(
                (target) =>
                  exercises.data?.items.find(
                    (item) => item.definition.versionId === target.exerciseVersionId,
                  )?.definition.equipment ?? [],
              ),
            ]),
          ],
          spec: specFromTargets(
            targets,
            exercises.data?.items ?? [],
            versionId,
            crypto.randomUUID(),
            draftPrior,
          ),
          createdAt: new Date().toISOString(),
        },
        expectedVersionId: draftPrior?.template.versionId ?? null,
        idempotencyKey: crypto.randomUUID(),
        confirmed: true as const,
      };
      pending.current = command;
      const saved = await api.saveRoutine(command);
      pending.current = null;
      setUncertain(false);
      setEditing(false);
      setMessage(
        `루틴 버전 ${saved.version}을 저장했습니다. 기존 일정과 수행 기록은 당시 버전을 유지합니다.`,
      );
      await client.invalidateQueries({ queryKey: [...scope, 'routines'] });
      await client.invalidateQueries({ queryKey: [...scope, 'routine', saved.template.routineId] });
    } catch (error) {
      if (
        error instanceof ZodError ||
        (error instanceof SupplementaryRequestError && error.status < 500)
      ) {
        pending.current = null;
        setUncertain(false);
        setMessage('입력 또는 루틴 버전을 확인하고 다시 시도하세요.');
      } else if (pending.current) {
        setUncertain(true);
        setMessage('저장 결과가 불확실합니다. 값을 바꾸지 말고 같은 명령을 다시 시도하세요.');
      } else {
        setMessage(
          error instanceof Error && error.message.startsWith('INVALID_')
            ? '세트 목표에는 0 이상의 숫자를 입력하세요.'
            : '루틴 입력을 확인하세요.',
        );
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={styles.columns}>
      <section className={styles.card} aria-labelledby="routines-title">
        <div className={styles.head}>
          <h2 id="routines-title">보강 루틴</h2>
          <Button type="button" disabled={busy || uncertain} onClick={() => begin(null)}>
            루틴 만들기
          </Button>
        </div>
        <p>루틴은 재사용할 계획 콘텐츠입니다. 세트 목표는 실제 수행이 아닙니다.</p>
        {routines.isPending ? <p role="status">루틴 불러오는 중</p> : null}
        {routines.isError ? <p role="alert">루틴을 불러오지 못했습니다.</p> : null}
        {routines.data?.hasMore ? <p role="status">루틴 목록이 일부만 표시됩니다.</p> : null}
        {routines.data?.items.length === 0 ? <p>등록된 루틴이 없습니다.</p> : null}
        <ul className={styles.list}>
          {routines.data?.items.map((item) => (
            <li key={item.template.routineId}>
              <a href={`/supplementary/routines/${encodeURIComponent(item.template.routineId)}`}>
                {item.template.title}
              </a>
              <p>
                버전 {item.version} · 세트{' '}
                {item.template.spec.blocks.reduce((sum, block) => sum + block.sets.length, 0)}개
              </p>
            </li>
          ))}
        </ul>
        <a href="/planner">훈련 계획에서 보강 세션 배치하기</a>
      </section>
      <section className={styles.card} aria-labelledby="routine-detail-title">
        <h2 id="routine-detail-title">{selected?.template.title ?? '루틴 상세'}</h2>
        {routineId !== null && detail.isPending ? <p role="status">루틴 상세 불러오는 중</p> : null}
        {detail.isError ? <p role="alert">선택한 루틴을 불러오지 못했습니다.</p> : null}
        {selected ? (
          <>
            <p>{selected.template.purpose}</p>
            <p>
              버전 {selected.version} · 장비{' '}
              {selected.template.requiredEquipment.join(', ') || '미지정'}
            </p>
            <ol className={styles.list}>
              {selected.template.spec.blocks.flatMap((block) =>
                block.sets.map((set) => (
                  <li key={set.id}>
                    동작 버전 {set.exerciseVersionId} · {set.side} ·{' '}
                    {set.count
                      ? `${set.count.target.min} ${set.count.definition.kind}/${set.count.definition.basis}`
                      : set.durationSeconds
                        ? `${set.durationSeconds.min}초`
                        : '목표 미상'}{' '}
                    · 휴식 {set.restAfterSeconds ?? '미지정'}초
                  </li>
                )),
              )}
            </ol>
            <Button
              type="button"
              variant="secondary"
              disabled={busy || uncertain}
              onClick={() => begin(selected)}
            >
              새 버전으로 편집
            </Button>
          </>
        ) : (
          <p>루틴을 선택하거나 새로 만드세요.</p>
        )}
        {message ? <p role="status">{message}</p> : null}
        {editing ? (
          <form onSubmit={(event) => void submit(event)} className={styles.form}>
            <h3>{draftPrior ? '새 루틴 버전' : '새 루틴'}</h3>
            <fieldset disabled={busy || uncertain} className={styles.inputGroup}>
              <label>
                이름
                <input
                  required
                  maxLength={200}
                  value={title}
                  onChange={(event) => {
                    setTitle(event.target.value);
                    pending.current = null;
                  }}
                />
              </label>
              <label>
                목적
                <textarea
                  maxLength={2000}
                  value={purpose}
                  onChange={(event) => {
                    setPurpose(event.target.value);
                    pending.current = null;
                  }}
                />
              </label>
              {targets.map((target, index) => (
                <fieldset key={target.id} className={styles.target}>
                  <legend>세트 {index + 1}</legend>
                  <label>
                    동작 버전
                    <select
                      required
                      value={target.exerciseVersionId}
                      onChange={(event) =>
                        changeTarget(target.id, 'exerciseVersionId', event.target.value)
                      }
                    >
                      <option value="">선택</option>
                      {!exercises.data?.items.some(
                        (item) => item.definition.versionId === target.exerciseVersionId,
                      ) && target.exerciseVersionId ? (
                        <option value={target.exerciseVersionId}>
                          이전 동작 버전 {target.exerciseVersionId}
                        </option>
                      ) : null}
                      {exercises.data?.items.map((item) => (
                        <option key={item.definition.versionId} value={item.definition.versionId}>
                          {item.definition.name} · 버전 {item.version}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    좌우
                    <select
                      value={target.side}
                      onChange={(event) => changeTarget(target.id, 'side', event.target.value)}
                    >
                      <option value="bilateral">양측</option>
                      <option value="left">왼쪽</option>
                      <option value="right">오른쪽</option>
                      <option value="alternating">교대</option>
                      <option value="unspecified">미지정</option>
                    </select>
                  </label>
                  <label>
                    목표 횟수
                    <input
                      inputMode="numeric"
                      type="number"
                      min="0"
                      step="1"
                      value={target.count}
                      onChange={(event) => changeTarget(target.id, 'count', event.target.value)}
                    />
                  </label>
                  <label>
                    목표 시간 (초)
                    <input
                      inputMode="decimal"
                      type="number"
                      min="0"
                      step="any"
                      value={target.duration}
                      onChange={(event) => changeTarget(target.id, 'duration', event.target.value)}
                    />
                  </label>
                  <label>
                    세트 뒤 휴식 (초)
                    <input
                      inputMode="decimal"
                      type="number"
                      min="0"
                      step="any"
                      value={target.rest}
                      onChange={(event) => changeTarget(target.id, 'rest', event.target.value)}
                    />
                  </label>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      setTargets((current) => current.filter((row) => row.id !== target.id));
                      pending.current = null;
                    }}
                  >
                    세트 제거
                  </Button>
                </fieldset>
              ))}
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setTargets((current) => [
                    ...current,
                    newTargetForm(
                      crypto.randomUUID(),
                      exercises.data?.items[0]?.definition.versionId ?? '',
                    ),
                  ]);
                  pending.current = null;
                }}
              >
                세트 추가
              </Button>
              <p>기존 계획과 수행은 루틴 편집으로 자동 변경되지 않습니다.</p>
            </fieldset>
            <div className={styles.actions}>
              <Button type="submit" disabled={busy || exercises.isPending}>
                {uncertain ? '같은 저장 명령 재시도' : '확인하고 버전 저장'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={busy || uncertain}
                onClick={() => setEditing(false)}
              >
                취소
              </Button>
            </div>
          </form>
        ) : null}
      </section>
    </div>
  );
}
