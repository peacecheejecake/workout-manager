import { useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  nutritionPlanDraftSchema,
  type NutritionPlanDraft,
  type NutritionPlanItemDraft,
  type NutritionPlanVersion,
} from '@workout/contracts/nutrition-core';
import { Button } from '@workout/ui-foundation/button';
import { TextAreaField, TextField } from '@workout/ui-foundation/text-field';
import { NutritionRequestError } from './nutrition-api';
import { nutrientFields, type NutrientKey } from './nutrition-model';
import type { NutritionApi, NutritionClock, NutritionScope } from './nutrition-workspace';
import styles from './nutrition.module.css';

const categories = [
  ['meal', '식사'],
  ['snack', '간식'],
  ['before', '운동 전'],
  ['during', '운동 중'],
  ['after', '운동 후'],
  ['hydration', '수분'],
] as const;
type TargetInput = { metric: NutrientKey | ''; min: string; max: string };
function targetInput(item: NutritionPlanItemDraft): TargetInput {
  const first = item.targets[0];
  return first
    ? { metric: first.metric, min: String(first.amount.min), max: String(first.amount.max) }
    : { metric: '', min: '', max: '' };
}
function makeTarget(
  metric: NutrientKey,
  min: number,
  max: number,
): NutritionPlanItemDraft['targets'][number] {
  const common = { min, max, basis: 'user_confirmed' as const, evidenceIds: [] };
  switch (metric) {
    case 'energy':
      return { metric, amount: { ...common, unit: 'kcal' } };
    case 'carbohydrate':
      return { metric, amount: { ...common, unit: 'g' } };
    case 'protein':
      return { metric, amount: { ...common, unit: 'g' } };
    case 'fat':
      return { metric, amount: { ...common, unit: 'g' } };
    case 'fluid':
      return { metric, amount: { ...common, unit: 'mL' } };
    case 'sodium':
      return { metric, amount: { ...common, unit: 'mg' } };
  }
}

function blankDraft(clock: NutritionClock): NutritionPlanDraft {
  return {
    period: { from: clock.day, toInclusive: clock.day },
    timezone: clock.timezone,
    purpose: '',
    linkedTrainingPlanVersionId: null,
    items: [],
  };
}
function existingDraft(plan: NutritionPlanVersion): NutritionPlanDraft | null {
  const candidate = {
    period: plan.period,
    timezone: plan.timezone,
    purpose: plan.purpose,
    linkedTrainingPlanVersionId: plan.linkedTrainingPlanVersionId,
    items: plan.items.map(({ planVersionId, ...item }) => {
      void planVersionId;
      return item;
    }),
  };
  const parsed = nutritionPlanDraftSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
function blankItem(date: string, timezone: string): NutritionPlanItemDraft {
  return {
    id: crypto.randomUUID(),
    category: 'meal',
    title: '',
    anchor: { kind: 'absolute', date, localTime: null, timezone },
    foods: [],
    targets: [],
    instructions: '',
    evidenceIds: [],
    source: 'user_confirmed',
  };
}

export function PlanEditor({
  api,
  scope,
  clock,
  planId,
  navigate,
}: {
  api: NutritionApi;
  scope: NutritionScope;
  clock: NutritionClock;
  planId: string | null;
  navigate: ((path: string) => void) | undefined;
}) {
  const plan = useQuery({
    queryKey: [...scope, 'plan', planId],
    queryFn: ({ signal }) => {
      if (planId === null) throw new Error('PLAN_ID_REQUIRED');
      return api.readPlan(planId, signal);
    },
    enabled: planId !== null,
  });
  if (planId !== null && plan.isPending && !plan.data)
    return <p role="status">영양 계획 불러오는 중</p>;
  if (planId !== null && plan.isError && !plan.data)
    return (
      <p role="alert">
        계획을 불러오지 못했습니다.{' '}
        <Button
          variant="secondary"
          onClick={() => {
            void plan.refetch();
          }}
        >
          다시 불러오기
        </Button>
      </p>
    );
  return (
    <PlanLoaded
      key={planId ?? 'new'}
      api={api}
      scope={scope}
      clock={clock}
      initialHead={planId === null ? null : (plan.data?.head ?? null)}
      latestHead={planId === null ? null : (plan.data?.head ?? null)}
      requestedPlanId={planId}
      refetchFailed={plan.isError}
      refreshing={plan.isFetching}
      onRefresh={() => {
        void plan.refetch();
      }}
      navigate={navigate}
    />
  );
}

function PlanLoaded({
  api,
  scope,
  clock,
  initialHead,
  latestHead,
  requestedPlanId,
  refetchFailed,
  refreshing,
  onRefresh,
  navigate,
}: {
  api: NutritionApi;
  scope: NutritionScope;
  clock: NutritionClock;
  initialHead: NutritionPlanVersion | null;
  latestHead: NutritionPlanVersion | null;
  requestedPlanId: string | null;
  refetchFailed: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  navigate: ((path: string) => void) | undefined;
}) {
  const [baselineHead] = useState(initialHead);
  const [cloneDraft, setCloneDraft] = useState<NutritionPlanDraft | null>(null);
  if (requestedPlanId !== null && baselineHead === null)
    return <p role="alert">계획을 찾을 수 없습니다.</p>;
  const originalDraft = baselineHead ? existingDraft(baselineHead) : blankDraft(clock);
  const initialDraft = cloneDraft ?? originalDraft;
  if (initialDraft === null)
    return (
      <p role="alert">
        이 계획 버전은 수동 편집 범위 밖의 출처 또는 항목이 있어 편집할 수 없습니다. 버전{' '}
        {baselineHead?.version}의 원본은 보존됩니다.
      </p>
    );
  return (
    <>
      {baselineHead ? (
        <div className={styles.stack}>
          <Button variant="secondary" onClick={onRefresh} disabled={refreshing}>
            서버 최신 버전 확인
          </Button>
          {refetchFailed ? (
            <p role="alert">최신 버전을 다시 조회하지 못했습니다. 아래 편집 초안은 유지됩니다.</p>
          ) : null}
          {latestHead && latestHead.versionId !== baselineHead.versionId ? (
            <p role="alert">
              서버에는 버전 {latestHead.version} ({latestHead.versionId})이 있습니다. 이 초안의 편집
              기준은 버전 {baselineHead.version}입니다. 변경 내용을 비교한 뒤 새 화면에서 다시
              편집하세요.
            </p>
          ) : null}
          {!latestHead && !refetchFailed ? (
            <p role="alert">서버에서 이 계획을 더 이상 조회할 수 없습니다. 초안은 유지됩니다.</p>
          ) : null}
        </div>
      ) : null}
      {baselineHead && originalDraft ? (
        <div className={styles.actions}>
          {cloneDraft ? (
            <Button variant="secondary" onClick={() => setCloneDraft(null)}>
              원본 버전 편집으로 돌아가기
            </Button>
          ) : (
            <Button
              variant="secondary"
              onClick={() =>
                setCloneDraft({
                  ...originalDraft,
                  items: originalDraft.items.map((item) => ({ ...item, id: crypto.randomUUID() })),
                })
              }
            >
              새 계획으로 복제
            </Button>
          )}
        </div>
      ) : null}
      {cloneDraft ? (
        <p role="status">
          원본 항목을 새 계획 초안으로 복사했습니다. 기간과 내용을 확인해야 저장됩니다. 섭취 기록은
          생성되지 않습니다.
        </p>
      ) : null}
      <PlanForm
        key={cloneDraft ? `clone-${baselineHead?.versionId}` : (baselineHead?.versionId ?? 'new')}
        api={api}
        scope={scope}
        head={cloneDraft ? null : baselineHead}
        stale={Boolean(
          !cloneDraft &&
          baselineHead &&
          (!latestHead || latestHead.versionId !== baselineHead.versionId),
        )}
        initialDraft={initialDraft}
        navigate={navigate}
      />
    </>
  );
}

function PlanForm({
  api,
  scope,
  head,
  stale,
  initialDraft,
  navigate,
}: {
  api: NutritionApi;
  scope: NutritionScope;
  head: NutritionPlanVersion | null;
  stale: boolean;
  initialDraft: NutritionPlanDraft;
  navigate: ((path: string) => void) | undefined;
}) {
  const [draft, setDraft] = useState<NutritionPlanDraft>(initialDraft);
  const training = useQuery({
    queryKey: [...scope, 'training-plan', draft.linkedTrainingPlanVersionId],
    queryFn: ({ signal }) => {
      if (draft.linkedTrainingPlanVersionId === null) throw new Error('TRAINING_PLAN_REQUIRED');
      return api.trainingPlan(draft.linkedTrainingPlanVersionId, signal);
    },
    enabled: draft.linkedTrainingPlanVersionId !== null,
  });
  const currentTraining = useQuery({
    queryKey: [...scope, 'current-training-plan'],
    queryFn: ({ signal }) => api.currentTrainingPlan(signal),
    enabled: false,
  });
  const [targetInputs, setTargetInputs] = useState<Record<string, TargetInput>>(() =>
    Object.fromEntries(initialDraft.items.map((item) => [item.id, targetInput(item)])),
  );
  const additionalTargets = useRef(
    Object.fromEntries(initialDraft.items.map((item) => [item.id, item.targets.slice(1)])),
  );
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [notice, setNotice] = useState('');
  const [connecting, setConnecting] = useState(false);
  const key = useRef<string | null>(null);
  function updateItem(id: string, next: NutritionPlanItemDraft) {
    setDraft((current) => ({
      ...current,
      items: current.items.map((item) => (item.id === id ? next : item)),
    }));
  }
  function updateTarget(item: NutritionPlanItemDraft, next: TargetInput) {
    setTargetInputs((current) => ({ ...current, [item.id]: next }));
    const min = Number(next.min);
    const max = Number(next.max);
    const target =
      next.metric !== '' &&
      next.min !== '' &&
      next.max !== '' &&
      Number.isFinite(min) &&
      Number.isFinite(max)
        ? makeTarget(next.metric, min, max)
        : null;
    setDraft((current) => ({
      ...current,
      items: current.items.map((latest) =>
        latest.id === item.id
          ? {
              ...latest,
              targets: target
                ? [target, ...(additionalTargets.current[latest.id] ?? [])]
                : [...(additionalTargets.current[latest.id] ?? [])],
            }
          : latest,
      ),
    }));
  }
  async function connectCurrentTraining() {
    if (connecting || busy || locked) return;
    setConnecting(true);
    setNotice('');
    try {
      const result = await currentTraining.refetch();
      if (result.isError || !result.data) {
        setNotice(
          '현재 훈련 계획을 조회하지 못했습니다. 계획 화면에서 로그인과 저장 상태를 확인하세요.',
        );
      } else if (!result.data.head) {
        setNotice('연결할 현재 훈련 계획이 없습니다. 먼저 훈련 계획을 저장하세요.');
      } else {
        const versionId = result.data.head.id;
        setDraft((current) => ({ ...current, linkedTrainingPlanVersionId: versionId }));
        setNotice('현재 훈련 계획을 연결했습니다. 상대 시각 항목은 아래 세션을 선택하세요.');
      }
    } finally {
      setConnecting(false);
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmed || busy || locked || stale) return;
    const relativeItems = draft.items.filter((item) => item.anchor.kind === 'relative');
    const validSessionIds = new Set(
      training.data?.draft.sessions.map((session) => session.id) ?? [],
    );
    if (
      relativeItems.length > 0 &&
      (draft.linkedTrainingPlanVersionId === null ||
        training.data?.id !== draft.linkedTrainingPlanVersionId ||
        relativeItems.some(
          (item) =>
            item.anchor.kind === 'relative' &&
            (item.anchor.entity !== 'session' || !validSessionIds.has(item.anchor.entityId)),
        ))
    ) {
      setNotice('상대 시각은 연결된 훈련 계획의 세션을 선택한 뒤 저장하세요.');
      return;
    }
    if (
      Object.values(targetInputs).some(
        (target) => target.metric !== '' && (target.min === '' || target.max === ''),
      )
    ) {
      setNotice('선택한 영양 목표의 최소·최대 값을 모두 입력하세요. 빈칸은 0이 아닙니다.');
      return;
    }
    const parsed = nutritionPlanDraftSchema.safeParse(draft);
    if (!parsed.success) {
      setNotice(
        '계획 기간과 항목을 확인하세요. 각 항목에는 음식, 목표 또는 행동 설명이 필요합니다.',
      );
      return;
    }
    const idempotencyKey = key.current ?? crypto.randomUUID();
    key.current = idempotencyKey;
    setBusy(true);
    setNotice('');
    try {
      const saved = await api.savePlan(
        head
          ? {
              kind: 'update',
              planId: head.planId,
              expectedHeadVersionId: head.versionId,
              idempotencyKey,
              confirmed: true,
              draft: parsed.data,
            }
          : { kind: 'create', idempotencyKey, confirmed: true, draft: parsed.data },
      );
      key.current = null;
      (navigate ?? window.location.assign.bind(window.location))(
        `/nutrition/plans/${encodeURIComponent(saved.planId)}`,
      );
    } catch (error) {
      if (error instanceof NutritionRequestError && [400, 404, 409, 422].includes(error.status)) {
        key.current = null;
        setNotice(
          error.status === 409
            ? '계획의 기준 버전이 바뀌었습니다. 최신 버전을 열고 변경 사항을 다시 검토하세요.'
            : error.status === 422
              ? '계획 또는 세션 연결을 서버가 수락하지 않았습니다. 현재 훈련 계획을 다시 연결하고 항목을 확인하세요.'
              : '계획 입력 또는 연결 대상을 확인하세요. 저장되지 않았습니다.',
        );
      } else {
        setLocked(true);
        setNotice(
          '저장 결과를 확인할 수 없습니다. 중복 적용을 피하려면 계획 목록에서 최신 버전을 확인하세요.',
        );
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={styles.card} aria-labelledby="plan-editor-title">
      <h2 id="plan-editor-title">{head ? `영양 계획 · 버전 ${head.version}` : '새 영양 계획'}</h2>
      {head ? (
        <p>
          확인된 버전 {head.versionId} · {head.approvedAt}
        </p>
      ) : null}
      <p>
        이 계획을 저장해도 섭취 기록은 생기지 않습니다. 운동 관련 상대 시각은 기준 일정이 없으면
        미해결로 남습니다.
      </p>
      <form
        onSubmit={(event) => {
          void save(event);
        }}
        className={styles.form}
      >
        <TextField
          label="계획 목적"
          required
          maxLength={160}
          value={draft.purpose}
          disabled={busy || locked}
          onChange={(event) => setDraft({ ...draft, purpose: event.target.value })}
        />
        <div className={styles.row}>
          <TextField
            label="시작 날짜"
            type="date"
            required
            value={draft.period.from}
            disabled={busy || locked}
            onChange={(event) =>
              setDraft({ ...draft, period: { ...draft.period, from: event.target.value } })
            }
          />
          <TextField
            label="종료 날짜"
            type="date"
            required
            value={draft.period.toInclusive}
            disabled={busy || locked}
            onChange={(event) =>
              setDraft({ ...draft, period: { ...draft.period, toInclusive: event.target.value } })
            }
          />
        </div>
        <p>적용 시간대: {draft.timezone}</p>
        <div className={styles.item}>
          <h3>훈련 계획 연결</h3>
          <p>
            세션 상대 시각은 본인 훈련 계획의 버전과 세션이 필요합니다. 대회 연결은 현재 수동
            편집기에서 지원하지 않습니다.
          </p>
          <Button
            variant="secondary"
            disabled={busy || locked || connecting}
            onClick={() => {
              void connectCurrentTraining();
            }}
          >
            {connecting ? '훈련 계획 확인 중' : '현재 훈련 계획 연결'}
          </Button>
          {draft.linkedTrainingPlanVersionId ? (
            <p>연결 버전: {draft.linkedTrainingPlanVersionId}</p>
          ) : (
            <p>연결된 훈련 계획 없음</p>
          )}
          {training.data ? (
            <p role="status">훈련 세션 {training.data.draft.sessions.length}개 연결됨</p>
          ) : null}
          {training.isError ? (
            <p role="alert">
              연결된 훈련 계획 버전을 불러오지 못했습니다. 상대 시각 항목을 저장할 수 없습니다.
            </p>
          ) : null}
        </div>
        <div className={styles.sectionHead}>
          <h3>식사·보급 항목</h3>
          <Button
            variant="secondary"
            disabled={busy || locked}
            onClick={() =>
              setDraft({
                ...draft,
                items: [...draft.items, blankItem(draft.period.from, draft.timezone)],
              })
            }
          >
            항목 추가
          </Button>
        </div>
        {draft.items.length === 0 ? (
          <p>항목 없이 기간만 저장할 수 있습니다. 실제 섭취는 별도로 기록하세요.</p>
        ) : null}
        {draft.items.map((item, index) => (
          <fieldset key={item.id} className={styles.item} disabled={busy || locked}>
            <legend>계획 항목 {index + 1}</legend>
            <div className={styles.row}>
              <TextField
                label="항목 이름"
                value={item.title}
                required
                maxLength={160}
                onChange={(event) => updateItem(item.id, { ...item, title: event.target.value })}
              />
              <label>
                종류
                <select
                  value={item.category}
                  onChange={(event) =>
                    updateItem(item.id, {
                      ...item,
                      category: event.target.value as NutritionPlanItemDraft['category'],
                    })
                  }
                >
                  {categories.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              시각 기준
              <select
                value={item.anchor.kind}
                onChange={(event) => {
                  if (
                    event.target.value === 'relative' &&
                    (draft.linkedTrainingPlanVersionId === null ||
                      training.data?.id !== draft.linkedTrainingPlanVersionId)
                  ) {
                    setNotice(
                      '상대 시각을 사용하려면 먼저 현재 훈련 계획을 연결하고 세션 목록을 불러오세요.',
                    );
                    return;
                  }
                  updateItem(item.id, {
                    ...item,
                    anchor:
                      event.target.value === 'absolute'
                        ? {
                            kind: 'absolute',
                            date: draft.period.from,
                            localTime: null,
                            timezone: draft.timezone,
                          }
                        : {
                            kind: 'relative',
                            entity: 'session',
                            entityId: '',
                            point: 'start',
                            offsetMinutes: 0,
                          },
                  });
                }}
              >
                <option value="absolute">날짜·시각</option>
                <option value="relative">훈련 세션 상대 시각</option>
              </select>
            </label>
            {item.anchor.kind === 'absolute' ? (
              <div className={styles.row}>
                <TextField
                  label="예정 날짜"
                  type="date"
                  required
                  value={item.anchor.date}
                  onChange={(event) =>
                    updateItem(item.id, {
                      ...item,
                      anchor:
                        item.anchor.kind === 'absolute'
                          ? { ...item.anchor, date: event.target.value }
                          : item.anchor,
                    })
                  }
                />
                <TextField
                  label="예정 시각 (선택)"
                  type="time"
                  value={item.anchor.localTime ?? ''}
                  onChange={(event) =>
                    updateItem(item.id, {
                      ...item,
                      anchor:
                        item.anchor.kind === 'absolute'
                          ? { ...item.anchor, localTime: event.target.value || null }
                          : item.anchor,
                    })
                  }
                />
              </div>
            ) : (
              <div className={styles.row}>
                <label>
                  연결 종류
                  <select
                    value={item.anchor.entity}
                    onChange={(event) =>
                      updateItem(item.id, {
                        ...item,
                        anchor:
                          item.anchor.kind === 'relative'
                            ? { ...item.anchor, entity: event.target.value as 'session' | 'race' }
                            : item.anchor,
                      })
                    }
                  >
                    <option value="session">세션</option>
                    {item.anchor.entity === 'race' ? (
                      <option value="race" disabled>
                        대회 · 현재 편집 불가
                      </option>
                    ) : null}
                  </select>
                </label>
                {item.anchor.entity === 'race' ? (
                  <p role="alert">
                    기존 대회 기준 항목은 이 편집기에서 저장할 수 없습니다. 세션으로 바꾸거나
                    날짜·시각을 선택하세요.
                  </p>
                ) : null}
                <label>
                  연결할 훈련 세션
                  <select
                    required
                    value={item.anchor.entityId}
                    onChange={(event) =>
                      updateItem(item.id, {
                        ...item,
                        anchor:
                          item.anchor.kind === 'relative'
                            ? { ...item.anchor, entityId: event.target.value }
                            : item.anchor,
                      })
                    }
                  >
                    <option value="">세션 선택</option>
                    {training.data?.draft.sessions.map((session) => (
                      <option key={session.id} value={session.id}>
                        {session.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  기준 지점
                  <select
                    value={item.anchor.point}
                    onChange={(event) =>
                      updateItem(item.id, {
                        ...item,
                        anchor:
                          item.anchor.kind === 'relative'
                            ? { ...item.anchor, point: event.target.value as 'start' | 'end' }
                            : item.anchor,
                      })
                    }
                  >
                    <option value="start">시작</option>
                    <option value="end">종료</option>
                  </select>
                </label>
                <TextField
                  label="전후 분 (이전은 음수)"
                  type="number"
                  step="1"
                  value={item.anchor.offsetMinutes}
                  onChange={(event) =>
                    updateItem(item.id, {
                      ...item,
                      anchor:
                        item.anchor.kind === 'relative'
                          ? { ...item.anchor, offsetMinutes: Number(event.target.value) }
                          : item.anchor,
                    })
                  }
                />
              </div>
            )}
            <TextField
              label="계획한 음식·음료 (선택)"
              maxLength={160}
              value={item.foods[0]?.description ?? ''}
              onChange={(event) => {
                const description = event.target.value;
                updateItem(item.id, {
                  ...item,
                  foods: description.trim()
                    ? [
                        {
                          ...(item.foods[0] ?? {
                            foodVersionId: null,
                            quantity: null,
                            unit: 'unspecified',
                            sourceBasis: 'unknown',
                          }),
                          description,
                        },
                        ...item.foods.slice(1),
                      ]
                    : item.foods.slice(1),
                });
              }}
            />
            {item.foods[0] ? (
              <div className={styles.row}>
                <TextField
                  label="계획한 양 (모르면 빈칸)"
                  type="number"
                  min="0"
                  step="any"
                  value={item.foods[0].quantity ?? ''}
                  onChange={(event) => {
                    const first = item.foods[0];
                    if (!first) return;
                    updateItem(item.id, {
                      ...item,
                      foods: [
                        {
                          ...first,
                          quantity: event.target.value === '' ? null : Number(event.target.value),
                          unit:
                            event.target.value && first.unit === 'unspecified' ? 'g' : first.unit,
                        },
                        ...item.foods.slice(1),
                      ],
                    });
                  }}
                />
                <label>
                  계획한 양의 단위
                  <select
                    value={item.foods[0].unit}
                    onChange={(event) => {
                      const first = item.foods[0];
                      if (!first) return;
                      updateItem(item.id, {
                        ...item,
                        foods: [
                          {
                            ...first,
                            foodVersionId: null,
                            sourceBasis: 'unknown',
                            unit: event.target.value as typeof first.unit,
                          },
                          ...item.foods.slice(1),
                        ],
                      });
                    }}
                  >
                    <option value="unspecified">모름</option>
                    <option value="g">g</option>
                    <option value="mL">mL</option>
                    <option value="serving">회분</option>
                    <option value="piece">개</option>
                  </select>
                </label>
              </div>
            ) : null}
            {item.foods.length > 1 ? (
              <p>추가 음식 {item.foods.length - 1}개는 이 수동 편집기에서 유지됩니다.</p>
            ) : null}
            <div className={styles.row}>
              <label>
                영양 목표 (선택)
                <select
                  value={(targetInputs[item.id] ?? targetInput(item)).metric}
                  onChange={(event) =>
                    updateTarget(item, {
                      ...(targetInputs[item.id] ?? targetInput(item)),
                      metric: event.target.value as NutrientKey | '',
                    })
                  }
                >
                  <option value="">목표 없음 · 미상</option>
                  {nutrientFields.map((field) => (
                    <option key={field.key} value={field.key}>
                      {field.label} ({field.unit})
                    </option>
                  ))}
                </select>
              </label>
              {(targetInputs[item.id] ?? targetInput(item)).metric !== '' ? (
                <>
                  <TextField
                    label="목표 최소값"
                    type="number"
                    min="0"
                    step="any"
                    value={(targetInputs[item.id] ?? targetInput(item)).min}
                    onChange={(event) =>
                      updateTarget(item, {
                        ...(targetInputs[item.id] ?? targetInput(item)),
                        min: event.target.value,
                      })
                    }
                  />
                  <TextField
                    label="목표 최대값"
                    type="number"
                    min="0"
                    step="any"
                    value={(targetInputs[item.id] ?? targetInput(item)).max}
                    onChange={(event) =>
                      updateTarget(item, {
                        ...(targetInputs[item.id] ?? targetInput(item)),
                        max: event.target.value,
                      })
                    }
                  />
                </>
              ) : null}
            </div>
            {item.targets.length > 1 ? (
              <p>추가 영양 목표 {item.targets.length - 1}개는 변경 없이 유지됩니다.</p>
            ) : null}
            <TextAreaField
              label="시간·행동 계획 (선택)"
              maxLength={2000}
              value={item.instructions}
              onChange={(event) =>
                updateItem(item.id, { ...item, instructions: event.target.value })
              }
            />
            <Button
              variant="danger"
              onClick={() => {
                setDraft({ ...draft, items: draft.items.filter((other) => other.id !== item.id) });
                setTargetInputs((current) =>
                  Object.fromEntries(Object.entries(current).filter(([key]) => key !== item.id)),
                );
              }}
            >
              항목 제거
            </Button>
          </fieldset>
        ))}
        <label className={styles.confirm}>
          <input
            type="checkbox"
            checked={confirmed}
            disabled={busy || locked}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          계획 내용을 직접 확인했고 이 버전을 저장합니다. 실제로 먹었다는 뜻은 아닙니다.
        </label>
        {notice ? (
          <p role="alert" className={styles.notice}>
            {notice}
          </p>
        ) : null}
        <div className={styles.actions}>
          <Button type="submit" disabled={!confirmed || busy || locked || stale}>
            {busy ? '저장 중' : '확인한 계획 저장'}
          </Button>
          <a href="/nutrition">목록으로</a>
        </div>
      </form>
    </section>
  );
}
