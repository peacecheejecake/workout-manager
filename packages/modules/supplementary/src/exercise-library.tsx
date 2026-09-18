import { useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ZodError } from 'zod';
import type {
  ExerciseVersionRead,
  ExerciseVersionSaveCommand,
} from '@workout/contracts/supplementary-core';
import { Button } from '@workout/ui-foundation/button';
import { SupplementaryRequestError, type SupplementaryApi } from './supplementary-api';
import {
  definitionFromForm,
  emptyExerciseForm,
  exerciseFormFrom,
  type ExerciseForm,
} from './supplementary-model';
import type { SupplementaryScope } from './supplementary-workspace';
import styles from './supplementary.module.css';

const families: ExerciseForm['family'][] = [
  'resistance',
  'plyometric',
  'mobility',
  'balance_stability',
  'activation',
  'other',
];
const equipment: ExerciseForm['equipment'][] = [
  'bodyweight',
  'dumbbell',
  'barbell',
  'machine',
  'band',
  'other',
];

export function ExerciseLibrary({
  api,
  scope,
  exerciseId,
}: {
  api: SupplementaryApi;
  scope: SupplementaryScope;
  exerciseId: string | null;
}) {
  const client = useQueryClient();
  const list = useQuery({
    queryKey: [...scope, 'exercises'],
    queryFn: ({ signal }) => api.listExercises(signal),
  });
  const detail = useQuery({
    queryKey: [...scope, 'exercise', exerciseId],
    queryFn: ({ signal }) => {
      if (exerciseId === null) throw new Error('EXERCISE_ID_REQUIRED');
      return api.readExercise(exerciseId, signal);
    },
    enabled: exerciseId !== null,
  });
  const selected = exerciseId === null ? null : (detail.data ?? null);
  const [editing, setEditing] = useState(false);
  const [draftPrior, setDraftPrior] = useState<ExerciseVersionRead | null>(null);
  const [form, setForm] = useState<ExerciseForm>(emptyExerciseForm);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState('');
  const pending = useRef<ExerciseVersionSaveCommand | null>(null);
  function begin(record: ExerciseVersionRead | null) {
    if (busy || uncertain) return;
    setDraftPrior(record);
    setForm(record ? exerciseFormFrom(record) : emptyExerciseForm);
    setEditing(true);
    setMessage('');
    setUncertain(false);
    pending.current = null;
  }
  function change<K extends keyof ExerciseForm>(field: K, value: ExerciseForm[K]) {
    if (busy || uncertain) return;
    setForm((current) => ({ ...current, [field]: value }));
    pending.current = null;
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const command = pending.current ?? {
      definition: definitionFromForm(
        form,
        draftPrior,
        {
          exerciseId: crypto.randomUUID(),
          versionId: crypto.randomUUID(),
          definitionId: crypto.randomUUID(),
        },
        new Date().toISOString(),
      ),
      expectedVersionId: draftPrior?.definition.versionId ?? null,
      idempotencyKey: crypto.randomUUID(),
      confirmed: true as const,
    };
    pending.current = command;
    setBusy(true);
    setMessage('');
    try {
      const saved = await api.saveExercise(command);
      pending.current = null;
      setUncertain(false);
      setEditing(false);
      setMessage(
        `동작 버전 ${saved.version}을 저장했습니다. 이전 계획은 자동으로 바뀌지 않습니다.`,
      );
      await client.invalidateQueries({ queryKey: [...scope, 'exercises'] });
      await client.invalidateQueries({
        queryKey: [...scope, 'exercise', saved.definition.exerciseId],
      });
    } catch (error) {
      if (
        error instanceof ZodError ||
        (error instanceof SupplementaryRequestError && error.status < 500)
      ) {
        pending.current = null;
        setUncertain(false);
        setMessage('입력 또는 동작 버전을 확인하고 다시 시도하세요.');
      } else {
        setUncertain(true);
        setMessage('저장 결과가 불확실합니다. 값을 바꾸지 말고 같은 명령을 다시 시도하세요.');
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={styles.columns}>
      <section className={styles.card} aria-labelledby="exercise-list-title">
        <div className={styles.head}>
          <h2 id="exercise-list-title">동작 라이브러리</h2>
          <Button type="button" disabled={busy || uncertain} onClick={() => begin(null)}>
            동작 추가
          </Button>
        </div>
        {list.isPending ? <p role="status">동작 불러오는 중</p> : null}
        {list.isError ? (
          <p role="alert">동작을 불러오지 못했습니다. 새로 고침 후 다시 시도하세요.</p>
        ) : null}
        {list.data?.hasMore ? <p role="status">목록이 일부만 표시됩니다.</p> : null}
        {list.data?.items.length === 0 ? <p>등록된 동작이 없습니다.</p> : null}
        <ul className={styles.list}>
          {list.data?.items.map((item) => (
            <li key={item.definition.exerciseId}>
              <a
                href={`/supplementary/exercises/${encodeURIComponent(item.definition.exerciseId)}`}
              >
                {item.definition.name}
              </a>
              <p>
                {item.definition.family} · {item.definition.equipment.join(', ')} · 버전{' '}
                {item.version} ·{' '}
                {item.definition.reviewState === 'reviewed' ? '검토됨' : '사용자 등록·미검토'}
              </p>
            </li>
          ))}
        </ul>
      </section>
      <section className={styles.card} aria-labelledby="exercise-detail-title">
        <h2 id="exercise-detail-title">{selected?.definition.name ?? '동작 상세'}</h2>
        {exerciseId !== null && detail.isPending ? <p role="status">상세 불러오는 중</p> : null}
        {detail.isError ? <p role="alert">선택한 동작을 불러오지 못했습니다.</p> : null}
        {selected ? (
          <>
            <p>{selected.definition.description}</p>
            <p>주의: {selected.definition.safetyNotes || '등록된 주의 정보가 없습니다.'}</p>
            <p>
              계열 {selected.definition.family} · 장비 {selected.definition.equipment.join(', ')} ·
              기준{' '}
              {selected.definition.countDefinitions
                .map((definition) => `${definition.kind}/${definition.basis}`)
                .join(', ') || '시간'}
            </p>
            <p>
              자료/미디어 {selected.definition.resourceVersionIds.length}/
              {selected.definition.mediaAssetIds.length} ·{' '}
              {selected.definition.reviewState === 'reviewed' ? '검토됨' : '사용자 입력·미검토'}
            </p>
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
          <p>동작을 선택하거나 새로 추가하세요.</p>
        )}
        {message ? <p role="status">{message}</p> : null}
        {editing ? (
          <form onSubmit={(event) => void submit(event)} className={styles.form}>
            <h3>{draftPrior ? '새 동작 버전' : '새 동작'}</h3>
            <fieldset disabled={busy || uncertain} className={styles.inputGroup}>
              <label>
                이름
                <input
                  required
                  maxLength={200}
                  value={form.name}
                  onChange={(event) => change('name', event.target.value)}
                />
              </label>
              <label>
                동작 계열
                <select
                  value={form.family}
                  onChange={(event) =>
                    change('family', event.target.value as ExerciseForm['family'])
                  }
                >
                  {families.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                장비
                <select
                  value={form.equipment}
                  onChange={(event) =>
                    change('equipment', event.target.value as ExerciseForm['equipment'])
                  }
                >
                  {equipment.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                목적·부위 태그 (쉼표 구분)
                <input value={form.tags} onChange={(event) => change('tags', event.target.value)} />
              </label>
              <label>
                입력 단위
                <select
                  value={form.metric}
                  onChange={(event) =>
                    change('metric', event.target.value as ExerciseForm['metric'])
                  }
                >
                  <option value="count">횟수·접촉 수</option>
                  <option value="duration">시간</option>
                </select>
              </label>
              {form.metric === 'count' ? (
                <>
                  <label>
                    횟수 정의
                    <select
                      value={form.countKind}
                      onChange={(event) =>
                        change('countKind', event.target.value as ExerciseForm['countKind'])
                      }
                    >
                      <option value="repetitions">반복</option>
                      <option value="jumps">점프</option>
                      <option value="landing_events">착지</option>
                      <option value="foot_contacts">발 접촉</option>
                    </select>
                  </label>
                  <label>
                    횟수 기준
                    <select
                      value={form.countBasis}
                      onChange={(event) =>
                        change('countBasis', event.target.value as ExerciseForm['countBasis'])
                      }
                    >
                      <option value="total">전체</option>
                      <option value="per_side">좌우 각각</option>
                      <option value="unspecified">미지정</option>
                    </select>
                  </label>
                </>
              ) : null}
              <label>
                수행 설명
                <textarea
                  required
                  maxLength={2000}
                  value={form.description}
                  onChange={(event) => change('description', event.target.value)}
                />
              </label>
              <label>
                주의 사항
                <textarea
                  maxLength={2000}
                  value={form.safetyNotes}
                  onChange={(event) => change('safetyNotes', event.target.value)}
                />
              </label>
              <p>사용자 입력은 검토 완료 자료로 표시되지 않습니다.</p>
            </fieldset>
            <div className={styles.actions}>
              <Button type="submit" disabled={busy}>
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
