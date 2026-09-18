import { useRef, useState, type FormEvent } from 'react';
import { ZodError } from 'zod';
import type { StretchingExerciseRead, StretchingExerciseSave } from '@workout/contracts/stretching';
import { Button } from '@workout/ui-foundation/button';
import { StretchingRequestError, type StretchingApi } from './stretching-api';
import styles from './supplementary.module.css';

type Form = {
  name: string;
  description: string;
  safetyNotes: string;
  equipment: 'bodyweight' | 'dumbbell' | 'barbell' | 'machine' | 'band' | 'other';
  tags: string;
  method: 'static_hold' | 'dynamic_repetitions';
  movement: 'active' | 'passive' | 'unspecified';
  assistance: 'self' | 'equipment' | 'partner' | 'unspecified';
  context: 'warmup' | 'mobility_practice' | 'cooldown' | 'other';
  bodyRegions: string;
  sideBasis: 'per_side' | 'total' | 'unspecified';
};
function formFrom(read: StretchingExerciseRead | null): Form {
  return {
    name: read?.definition.name ?? '',
    description: read?.definition.description ?? '',
    safetyNotes: read?.definition.safetyNotes ?? '',
    equipment: read?.definition.equipment[0] ?? 'bodyweight',
    tags: read?.definition.tags.join(', ') ?? '',
    method: read?.profile.method ?? 'static_hold',
    movement: read?.profile.movement ?? 'unspecified',
    assistance: read?.profile.assistance ?? 'self',
    context: read?.profile.context ?? 'mobility_practice',
    bodyRegions: read?.profile.bodyRegions.join(', ') ?? '',
    sideBasis: read?.profile.sideBasis ?? 'unspecified',
  };
}
export function StretchingExerciseForm({
  api,
  prior,
  onSaved,
  onCancel,
}: {
  api: StretchingApi;
  prior: StretchingExerciseRead | null;
  onSaved(read: StretchingExerciseRead): void;
  onCancel(): void;
}) {
  const [form, setForm] = useState<Form>(() => formFrom(prior));
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState('');
  const pending = useRef<StretchingExerciseSave | null>(null);
  function change<K extends keyof Form>(key: K, value: Form[K]) {
    if (busy || uncertain) return;
    setForm((current) => ({ ...current, [key]: value }));
    pending.current = null;
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const metric = form.method === 'static_hold' ? 'duration' : 'count';
    const command = pending.current ?? {
      definition: {
        schemaVersion: 2 as const,
        exerciseId: prior?.definition.exerciseId ?? crypto.randomUUID(),
        versionId: crypto.randomUUID(),
        name: form.name.trim(),
        family: 'stretching' as const,
        equipment: [form.equipment],
        tags: form.tags
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
        countDefinitions:
          metric === 'count'
            ? [
                {
                  kind: 'repetitions' as const,
                  basis: form.sideBasis,
                  definitionId: crypto.randomUUID(),
                },
              ]
            : [],
        mediaAssetIds: prior?.definition.mediaAssetIds ?? [],
        resourceVersionIds: prior?.definition.resourceVersionIds ?? [],
        description: form.description.trim(),
        safetyNotes: form.safetyNotes.trim(),
        supportedMetrics: [metric],
        reviewState: 'unreviewed' as const,
        createdAt: new Date().toISOString(),
      },
      profile: {
        method: form.method,
        movement: form.movement,
        assistance: form.assistance,
        context: form.context,
        bodyRegions: form.bodyRegions
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
        sideBasis: form.sideBasis,
        source: { kind: 'user_authored' as const },
      },
      expectedVersionId: prior?.definition.versionId ?? null,
      idempotencyKey: crypto.randomUUID(),
      confirmed: true as const,
    };
    pending.current = command;
    setBusy(true);
    setMessage('');
    try {
      onSaved(await api.saveExercise(command));
      pending.current = null;
      setUncertain(false);
    } catch (error) {
      if (
        error instanceof ZodError ||
        (error instanceof StretchingRequestError && error.status < 500)
      ) {
        pending.current = null;
        setUncertain(false);
        setMessage('동작 버전·필수 입력·출처를 확인하고 다시 시도하세요.');
      } else {
        setUncertain(true);
        setMessage('저장 결과가 불확실합니다. 같은 명령을 재시도하세요.');
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className={styles.form} onSubmit={(event) => void submit(event)}>
      <h3>{prior ? '스트레칭 새 버전' : '스트레칭 동작 추가'}</h3>
      {message ? <p role="alert">{message}</p> : null}
      <fieldset className={styles.inputGroup} disabled={busy || uncertain}>
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
          방법
          <select
            value={form.method}
            onChange={(event) => change('method', event.target.value as Form['method'])}
          >
            <option value="static_hold">정적 유지</option>
            <option value="dynamic_repetitions">동적 반복</option>
          </select>
        </label>
        <label>
          부위 (쉼표 구분)
          <input
            required
            value={form.bodyRegions}
            onChange={(event) => change('bodyRegions', event.target.value)}
          />
        </label>
        <label>
          좌우 기준
          <select
            value={form.sideBasis}
            onChange={(event) => change('sideBasis', event.target.value as Form['sideBasis'])}
          >
            <option value="per_side">좌우 각각</option>
            <option value="total">전체 합계</option>
            <option value="unspecified">미지정</option>
          </select>
        </label>
        <label>
          맥락
          <select
            value={form.context}
            onChange={(event) => change('context', event.target.value as Form['context'])}
          >
            <option value="warmup">준비 운동</option>
            <option value="mobility_practice">가동성 연습</option>
            <option value="cooldown">운동 후 정리</option>
            <option value="other">기타</option>
          </select>
        </label>
        <label>
          움직임
          <select
            value={form.movement}
            onChange={(event) => change('movement', event.target.value as Form['movement'])}
          >
            <option value="active">능동</option>
            <option value="passive">수동</option>
            <option value="unspecified">미지정</option>
          </select>
        </label>
        <label>
          보조
          <select
            value={form.assistance}
            onChange={(event) => change('assistance', event.target.value as Form['assistance'])}
          >
            <option value="self">자가</option>
            <option value="equipment">장비</option>
            <option value="partner">파트너</option>
            <option value="unspecified">미지정</option>
          </select>
        </label>
        <label>
          장비
          <select
            value={form.equipment}
            onChange={(event) => change('equipment', event.target.value as Form['equipment'])}
          >
            <option value="bodyweight">맨몸</option>
            <option value="band">밴드</option>
            <option value="dumbbell">덤벨</option>
            <option value="barbell">바벨</option>
            <option value="machine">기구</option>
            <option value="other">기타</option>
          </select>
        </label>
        <label>
          목적·태그 (쉼표 구분)
          <input value={form.tags} onChange={(event) => change('tags', event.target.value)} />
        </label>
        <label>
          텍스트 수행 설명
          <textarea
            required
            maxLength={2000}
            value={form.description}
            onChange={(event) => change('description', event.target.value)}
          />
        </label>
        <label>
          주의·중단 안내
          <textarea
            maxLength={2000}
            value={form.safetyNotes}
            onChange={(event) => change('safetyNotes', event.target.value)}
          />
        </label>
        <p>
          사용자 입력은 검토 완료 자료나 효능 보증으로 표시하지 않습니다. 기존 계획은 이 새 버전으로
          바뀌지 않습니다.
        </p>
      </fieldset>
      <div className={styles.actions}>
        <Button type="submit" disabled={busy}>
          {uncertain ? '같은 저장 명령 재시도' : '확인하고 버전 저장'}
        </Button>
        <Button type="button" variant="secondary" disabled={busy || uncertain} onClick={onCancel}>
          취소
        </Button>
      </div>
    </form>
  );
}
