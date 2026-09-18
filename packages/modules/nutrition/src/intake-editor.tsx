import { useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  ActiveIntakeEntry,
  FoodDefinitionVersion,
  IntakeEntryRecord,
} from '@workout/contracts/nutrition-core';
import { Button } from '@workout/ui-foundation/button';
import { TextAreaField, TextField } from '@workout/ui-foundation/text-field';
import { NutritionRequestError } from './nutrition-api';
import {
  dayInTimezone,
  frozenFoodNutrients,
  nutrientFields,
  nutrientInputs,
  nextCalendarDay,
  parseNutrientInputs,
  type NutrientInput,
} from './nutrition-model';
import type { NutritionApi, NutritionClock, NutritionScope } from './nutrition-workspace';
import styles from './nutrition.module.css';

type FoodInput = {
  description: string;
  foodVersionId: string | null;
  quantity: string;
  unit: 'g' | 'mL' | 'serving' | 'piece' | 'unspecified';
  sourceBasis: 'per_100g' | 'per_100mL' | 'per_serving' | 'manual_total' | 'unknown';
};
type EditableIntakeEntry = ActiveIntakeEntry & {
  source: 'user' | 'user_confirmed_extraction';
};
function isEditable(entry: ActiveIntakeEntry): entry is EditableIntakeEntry {
  return entry.source !== 'provider';
}
type IntakeForm = {
  occurredLocal: string;
  foods: FoodInput[];
  nutrients: NutrientInput;
  plannedItemId: string;
  notes: string;
};
function localInput(instant: string) {
  const date = new Date(instant);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function emptyFood(): FoodInput {
  return {
    description: '',
    foodVersionId: null,
    quantity: '',
    unit: 'unspecified',
    sourceBasis: 'unknown',
  };
}
function blankForm(clock: NutritionClock): IntakeForm {
  return {
    occurredLocal: `${clock.day}T${localInput(clock.now).slice(11)}`,
    foods: [emptyFood()],
    nutrients: { energy: '', carbohydrate: '', protein: '', fat: '', fluid: '', sodium: '' },
    plannedItemId: '',
    notes: '',
  };
}
function fromRecord(record: ActiveIntakeEntry): IntakeForm {
  return {
    occurredLocal: localInput(record.occurredAt),
    foods: record.foods.map((food) => ({
      ...food,
      quantity: food.quantity === null ? '' : String(food.quantity),
    })),
    nutrients: nutrientInputs(record.nutrientTotal),
    plannedItemId: record.plannedItemId ?? '',
    notes: record.notes ?? '',
  };
}

export function IntakeEditor({
  api,
  scope,
  clock,
  intakeId,
  navigate,
}: {
  api: NutritionApi;
  scope: NutritionScope;
  clock: NutritionClock;
  intakeId: string | null;
  navigate: ((path: string) => void) | undefined;
}) {
  const entry = useQuery({
    queryKey: [...scope, 'intake', intakeId],
    queryFn: ({ signal }) => {
      if (intakeId === null) throw new Error('INTAKE_ID_REQUIRED');
      return api.readIntake(intakeId, signal);
    },
    enabled: intakeId !== null,
  });
  if (intakeId !== null && entry.isPending && !entry.data)
    return <p role="status">섭취 기록 불러오는 중</p>;
  if (intakeId !== null && entry.isError && !entry.data)
    return (
      <p role="alert">
        섭취 기록을 불러오지 못했습니다.{' '}
        <Button
          variant="secondary"
          onClick={() => {
            void entry.refetch();
          }}
        >
          다시 불러오기
        </Button>
      </p>
    );
  return (
    <IntakeLoaded
      key={intakeId ?? 'new'}
      api={api}
      scope={scope}
      clock={clock}
      requestedIntakeId={intakeId}
      initialRecord={intakeId === null ? null : (entry.data ?? null)}
      latestRecord={intakeId === null ? null : (entry.data ?? null)}
      refetchFailed={entry.isError}
      refreshing={entry.isFetching}
      onRefresh={() => {
        void entry.refetch();
      }}
      navigate={navigate}
    />
  );
}

function IntakeLoaded({
  api,
  scope,
  clock,
  requestedIntakeId,
  initialRecord,
  latestRecord,
  refetchFailed,
  refreshing,
  onRefresh,
  navigate,
}: {
  api: NutritionApi;
  scope: NutritionScope;
  clock: NutritionClock;
  requestedIntakeId: string | null;
  initialRecord: IntakeEntryRecord | null;
  latestRecord: IntakeEntryRecord | null;
  refetchFailed: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  navigate: ((path: string) => void) | undefined;
}) {
  const [baselineRecord] = useState(initialRecord);
  if (requestedIntakeId !== null && (!baselineRecord || baselineRecord.status === 'deleted'))
    return <p role="status">삭제되었거나 찾을 수 없는 섭취 기록입니다.</p>;
  const record = baselineRecord?.status === 'active' ? baselineRecord : null;
  if (record && !isEditable(record))
    return (
      <p role="status">
        공급자 출처 섭취는 이 수동 편집기에서 정정할 수 없습니다. 원본 출처와 revision을 유지합니다.
      </p>
    );
  if (record && record.timezone !== clock.timezone)
    return (
      <p role="status">
        이 기록의 시간대({record.timezone})와 현재 기기 시간대({clock.timezone})가 달라 시각을
        안전하게 정정할 수 없습니다. 원본 기록은 유지됩니다.
      </p>
    );
  return (
    <>
      {record ? (
        <div className={styles.stack}>
          <Button variant="secondary" onClick={onRefresh} disabled={refreshing}>
            서버 최신 기록 확인
          </Button>
          {refetchFailed ? (
            <p role="alert">최신 기록을 다시 조회하지 못했습니다. 아래 편집 초안은 유지됩니다.</p>
          ) : null}
          {latestRecord?.status === 'active' && latestRecord.revisionId !== record.revisionId ? (
            <p role="alert">
              서버 기록은 수정 {latestRecord.revision} ({latestRecord.revisionId})입니다. 이 초안은
              수정 {record.revision}을 기준으로 합니다. 변경 내용을 비교한 뒤 새 화면에서 다시
              정정하세요.
            </p>
          ) : null}
          {latestRecord?.status === 'deleted' ? (
            <p role="alert">
              서버에서 이 기록이 삭제되었습니다. 초안은 유지되지만 저장할 수 없습니다.
            </p>
          ) : null}
        </div>
      ) : null}
      <IntakeFormView
        key={record?.intakeId ?? 'new'}
        api={api}
        scope={scope}
        clock={clock}
        record={record}
        stale={Boolean(
          record &&
          latestRecord &&
          (latestRecord.status === 'deleted' || latestRecord.revisionId !== record.revisionId),
        )}
        navigate={navigate}
      />
    </>
  );
}

function IntakeFormView({
  api,
  scope,
  clock,
  record,
  stale,
  navigate,
}: {
  api: NutritionApi;
  scope: NutritionScope;
  clock: NutritionClock;
  record: EditableIntakeEntry | null;
  stale: boolean;
  navigate: ((path: string) => void) | undefined;
}) {
  const foods = useQuery({
    queryKey: [...scope, 'foods'],
    queryFn: ({ signal }) => api.listFoods(signal),
  });
  const [form, setForm] = useState<IntakeForm>(() =>
    record ? fromRecord(record) : blankForm(clock),
  );
  const [occurredEdited, setOccurredEdited] = useState(false);
  const occurredDate = new Date(form.occurredLocal);
  const activityDay = Number.isFinite(occurredDate.valueOf())
    ? dayInTimezone(occurredDate.toISOString(), clock.timezone)
    : clock.day;
  const activities = useQuery({
    queryKey: [...scope, 'activities', activityDay, clock.timezone],
    queryFn: ({ signal }) =>
      api.listActivities(activityDay, nextCalendarDay(activityDay), clock.timezone, signal),
  });
  const [relatedActivityIds, setRelatedActivityIds] = useState<string[]>(
    record?.relatedActivityIds ?? [],
  );
  const [confirmed, setConfirmed] = useState(false);
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [notice, setNotice] = useState('');
  const key = useRef<string | null>(null);
  const deleteKey = useRef<string | null>(null);
  const newId = useRef<string | null>(null);
  function changeFood(index: number, next: FoodInput) {
    setForm((current) => ({
      ...current,
      foods: current.foods.map((food, at) => (at === index ? next : food)),
    }));
  }
  function selectFood(index: number, versionId: string) {
    const food = foods.data?.foods.find((item) => item.versionId === versionId);
    if (!food) {
      changeFood(index, emptyFood());
      return;
    }
    const unit =
      food.basis.kind === 'per_100g' ? 'g' : food.basis.kind === 'per_100mL' ? 'mL' : 'serving';
    changeFood(index, {
      description: food.name,
      foodVersionId: food.versionId,
      quantity: food.basis.kind === 'per_serving' ? '1' : '100',
      unit,
      sourceBasis: food.basis.kind,
    });
  }
  function applyFoodValues(food: FoodDefinitionVersion, portion: FoodInput) {
    const calculated = frozenFoodNutrients(food, Number(portion.quantity), portion.unit);
    if (!calculated || portion.quantity.trim() === '') {
      setNotice('식품 기준과 수량 단위가 맞아야 영양값을 복사할 수 있습니다.');
      return;
    }
    setForm((current) => ({
      ...current,
      nutrients: nutrientInputs(calculated),
    }));
    setNotice(
      `식품 정의 ${food.version}버전의 기준으로 한 번 계산했습니다. 저장 전 실제 양과 값을 확인하세요.`,
    );
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmed || busy || locked || stale) return;
    const occurredAt = new Date(record && !occurredEdited ? record.occurredAt : form.occurredLocal);
    if (!Number.isFinite(occurredAt.valueOf()) || occurredAt.valueOf() > Date.now()) {
      setNotice('실제로 섭취한 시각을 확인하세요. 미래 시각은 기록할 수 없습니다.');
      return;
    }
    if (occurredEdited && localInput(occurredAt.toISOString()) !== form.occurredLocal) {
      setNotice('시간대 변경 구간의 존재하지 않는 현지 시각입니다. 다른 시각을 선택하세요.');
      return;
    }
    const nutrients = parseNutrientInputs(form.nutrients);
    if (nutrients === null) {
      setNotice('영양값은 0 이상의 값 또는 빈칸으로 입력하세요.');
      return;
    }
    const portions = form.foods.map((food) => ({
      description: food.description.trim(),
      foodVersionId: food.foodVersionId,
      quantity: food.quantity.trim() === '' ? null : Number(food.quantity),
      unit: food.unit,
      sourceBasis: food.sourceBasis,
    }));
    if (
      portions.some(
        (food) =>
          !food.description ||
          (food.quantity !== null && (!Number.isFinite(food.quantity) || food.quantity < 0)),
      )
    ) {
      setNotice('음식 이름과 양을 확인하세요. 양을 모르면 빈칸으로 두세요.');
      return;
    }
    const idempotencyKey = key.current ?? crypto.randomUUID();
    key.current = idempotencyKey;
    newId.current ??= crypto.randomUUID();
    setBusy(true);
    setNotice('');
    try {
      const content = {
        occurredAt: record && !occurredEdited ? record.occurredAt : occurredAt.toISOString(),
        timezone: clock.timezone,
        foods: portions,
        nutrientTotal: nutrients,
        plannedItemId: form.plannedItemId.trim() || null,
        relatedSessionIds: record?.relatedSessionIds ?? [],
        relatedActivityIds,
        source: record?.source ?? 'user',
        sourceRecordId: record?.sourceRecordId ?? null,
        notes: form.notes.trim() || null,
      };
      if (record) {
        await api.correctIntake({
          ...content,
          intakeId: record.intakeId,
          expectedRevision: record.revision,
          idempotencyKey,
          confirmed: true,
        });
      } else {
        await api.createIntake({
          ...content,
          intakeId: newId.current,
          idempotencyKey,
          confirmed: true,
        });
      }
      key.current = null;
      (navigate ?? window.location.assign.bind(window.location))(
        `/nutrition/logs?date=${encodeURIComponent(dayInTimezone(content.occurredAt, clock.timezone))}`,
      );
    } catch (error) {
      if (error instanceof NutritionRequestError && [400, 404, 409].includes(error.status)) {
        key.current = null;
        setNotice(
          error.status === 409
            ? '기록이 변경되었습니다. 최신 기록을 열고 다시 정정하세요.'
            : '입력값 또는 연결 대상을 확인하세요. 저장되지 않았습니다.',
        );
      } else {
        setLocked(true);
        setNotice(
          '저장 결과를 확인할 수 없습니다. 중복 생성을 피하려면 기록 목록에서 같은 섭취를 확인하세요.',
        );
      }
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!record || !deleteConfirmed || busy || locked || stale) return;
    const idempotencyKey = deleteKey.current ?? crypto.randomUUID();
    deleteKey.current = idempotencyKey;
    setBusy(true);
    setNotice('');
    try {
      await api.deleteIntake({
        intakeId: record.intakeId,
        expectedRevision: record.revision,
        confirmed: true,
        reason: 'user_requested',
        idempotencyKey,
      });
      deleteKey.current = null;
      (navigate ?? window.location.assign.bind(window.location))(
        `/nutrition/logs?date=${encodeURIComponent(clock.day)}`,
      );
    } catch (error) {
      if (error instanceof NutritionRequestError && [400, 404, 409].includes(error.status)) {
        deleteKey.current = null;
        setNotice('삭제하지 못했습니다. 최신 기록과 연결 상태를 확인하세요.');
      } else {
        setLocked(true);
        setNotice('삭제 결과를 확인할 수 없습니다. 목록에서 현재 상태를 확인하세요.');
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={styles.card} aria-labelledby="intake-editor-title">
      <h2 id="intake-editor-title">{record ? '섭취 기록 정정' : '실제 섭취 기록'}</h2>
      <p>음식 이름만 알아도 기록할 수 있습니다. 빈 영양값은 미상이고 입력한 0은 보고한 값입니다.</p>
      {record ? (
        <p>
          기록 {record.intakeId} · 수정 {record.revision} · 출처 {record.source}
        </p>
      ) : null}
      <form
        onSubmit={(event) => {
          void save(event);
        }}
        className={styles.form}
      >
        <TextField
          label="실제로 섭취한 날짜와 시각"
          description="시각을 변경하지 않으면 원래 기록의 초·밀리초와 시간대 경계가 보존됩니다."
          type="datetime-local"
          required
          value={form.occurredLocal}
          disabled={busy || locked}
          onChange={(event) => {
            setOccurredEdited(true);
            setForm({ ...form, occurredLocal: event.target.value });
          }}
        />
        {form.foods.map((food, index) => {
          const definition = foods.data?.foods.find(
            (item) => item.versionId === food.foodVersionId,
          );
          return (
            <fieldset key={index} className={styles.item} disabled={busy || locked}>
              <legend>음식·음료 {index + 1}</legend>
              <label>
                저장한 식품 정의 (선택)
                <select
                  value={food.foodVersionId ?? ''}
                  onChange={(event) => selectFood(index, event.target.value)}
                >
                  <option value="">직접 입력 · 영양값 미상</option>
                  {foods.data?.foods.map((item) => (
                    <option key={item.versionId} value={item.versionId}>
                      {item.name} · v{item.version}
                    </option>
                  ))}
                </select>
              </label>
              <div className={styles.row}>
                <TextField
                  label="먹은 음식·음료"
                  required
                  maxLength={160}
                  value={food.description}
                  onChange={(event) =>
                    changeFood(index, { ...food, description: event.target.value })
                  }
                />
                <TextField
                  label="실제 양 (모르면 빈칸)"
                  type="number"
                  min="0"
                  step="any"
                  value={food.quantity}
                  onChange={(event) =>
                    changeFood(index, {
                      ...food,
                      quantity: event.target.value,
                      unit: event.target.value && food.unit === 'unspecified' ? 'g' : food.unit,
                    })
                  }
                />
                <label>
                  양 단위
                  <select
                    value={food.unit}
                    disabled={food.foodVersionId !== null}
                    onChange={(event) =>
                      changeFood(index, { ...food, unit: event.target.value as FoodInput['unit'] })
                    }
                  >
                    <option value="unspecified">모름</option>
                    <option value="g">g</option>
                    <option value="mL">mL</option>
                    <option value="serving">회분</option>
                    <option value="piece">개</option>
                  </select>
                </label>
              </div>
              {definition ? (
                <Button variant="secondary" onClick={() => applyFoodValues(definition, food)}>
                  이 식품 버전의 값으로 영양값 채우기
                </Button>
              ) : null}
              <Button
                variant="danger"
                disabled={form.foods.length === 1}
                onClick={() =>
                  setForm({ ...form, foods: form.foods.filter((_, at) => at !== index) })
                }
              >
                항목 제거
              </Button>
            </fieldset>
          );
        })}
        <Button
          variant="secondary"
          disabled={busy || locked || form.foods.length >= 40}
          onClick={() => setForm({ ...form, foods: [...form.foods, emptyFood()] })}
        >
          음식·음료 추가
        </Button>
        <div className={styles.metricFields}>
          {nutrientFields.map((field) => (
            <TextField
              key={field.key}
              label={`${field.label} (${field.unit}, 미상은 빈칸)`}
              type="number"
              min="0"
              step="any"
              value={form.nutrients[field.key]}
              disabled={busy || locked}
              onChange={(event) =>
                setForm({
                  ...form,
                  nutrients: { ...form.nutrients, [field.key]: event.target.value },
                })
              }
            />
          ))}
        </div>
        <TextField
          label="연결할 계획 항목 ID (선택)"
          value={form.plannedItemId}
          disabled={busy || locked}
          onChange={(event) => setForm({ ...form, plannedItemId: event.target.value })}
        />
        <fieldset className={styles.item} disabled={busy || locked}>
          <legend>이 섭취와 관련된 활동 (선택)</legend>
          <p>한 섭취를 여러 활동에 연결해도 섭취 합계는 한 번만 계산합니다.</p>
          {activities.isPending ? <p role="status">활동 목록 불러오는 중</p> : null}
          {activities.isError ? (
            <p role="alert">활동 목록을 불러오지 못했습니다. 기존 연결은 유지됩니다.</p>
          ) : null}
          {activities.data?.items.length === 0 ? <p>섭취 날짜에 선택할 활동이 없습니다.</p> : null}
          {activities.data && activities.data.total > activities.data.items.length ? (
            <p role="status">이 날짜의 활동이 많아 일부만 표시됩니다. 기존 연결은 유지됩니다.</p>
          ) : null}
          {activities.data?.items.map((activity) => (
            <label key={activity.id} className={styles.confirm}>
              <input
                type="checkbox"
                checked={relatedActivityIds.includes(activity.id)}
                onChange={(event) =>
                  setRelatedActivityIds((current) =>
                    event.target.checked
                      ? [...new Set([...current, activity.id])]
                      : current.filter((id) => id !== activity.id),
                  )
                }
              />
              {activity.effective.title ?? '이름 없는 활동'} ·{' '}
              {activity.effective.startedAt ?? '시각 미상'}
            </label>
          ))}
          {relatedActivityIds.some(
            (id) => !activities.data?.items.some((activity) => activity.id === id),
          ) ? (
            <p>현재 날짜 목록에 없는 기존 활동 연결도 저장 시 유지됩니다.</p>
          ) : null}
        </fieldset>
        {record?.relatedSessionIds.length ? <p>기존 계획 세션 연결은 정정 시 유지됩니다.</p> : null}
        <TextAreaField
          label="메모·불편감 (선택)"
          maxLength={2000}
          value={form.notes}
          disabled={busy || locked}
          onChange={(event) => setForm({ ...form, notes: event.target.value })}
        />
        <label className={styles.confirm}>
          <input
            type="checkbox"
            checked={confirmed}
            disabled={busy || locked}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          실제로 섭취한 시각·내용·양을 확인했습니다.
        </label>
        {notice ? (
          <p role="alert" className={styles.notice}>
            {notice}
          </p>
        ) : null}
        <div className={styles.actions}>
          <Button type="submit" disabled={!confirmed || busy || locked || stale}>
            {busy ? '저장 중' : record ? '정정 저장' : '섭취 저장'}
          </Button>
          <a href="/nutrition/logs">목록으로</a>
        </div>
      </form>
      {record ? (
        <div className={styles.deletePanel}>
          <h3>이 섭취 기록 삭제</h3>
          <label className={styles.confirm}>
            <input
              type="checkbox"
              checked={deleteConfirmed}
              disabled={busy || locked}
              onChange={(event) => setDeleteConfirmed(event.target.checked)}
            />
            삭제할 기록을 확인했습니다. 계획은 삭제되지 않습니다.
          </label>
          <Button
            variant="danger"
            disabled={!deleteConfirmed || busy || locked || stale}
            onClick={() => {
              void remove();
            }}
          >
            기록 삭제
          </Button>
        </div>
      ) : null}
    </section>
  );
}
