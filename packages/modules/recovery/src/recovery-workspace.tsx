'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import type {
  CorrectRecoveryActionRequest,
  CreateRecoveryActionRequest,
  CreateRecoveryMethodRequest,
  CreateRecoveryStrategyRequest,
  RecoveryActionLog,
  RecoveryMethodVersion,
  RecoveryStrategyVersion,
} from '@workout/contracts/recovery-core';
import { createRecoveryApi, RecoveryRequestError } from './recovery-api';
import styles from './recovery.module.css';

export interface RecoveryWorkspaceProps {
  athleteId: string;
  sessionId: string;
  transport: AuthenticatedTransport;
  strategyId?: string | null;
}

export function RecoveryWorkspace(props: RecoveryWorkspaceProps) {
  return <Lifetime key={props.athleteId + ':' + props.sessionId} {...props} />;
}

function Lifetime(props: RecoveryWorkspaceProps) {
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

type RecoveryApi = ReturnType<typeof createRecoveryApi>;
type Scope = readonly ['users', string, 'sessions', string, 'recovery'];

function isDefinitiveRejection(error: unknown) {
  return (
    error instanceof RecoveryRequestError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

function useRequestKeys() {
  const keys = useRef(new Map<string, string>());
  return {
    forPayload(payload: unknown) {
      const content = JSON.stringify(payload);
      let key = keys.current.get(content);
      if (key === undefined) {
        key = crypto.randomUUID();
        keys.current.set(content, key);
      }
      return key;
    },
    clear(payload: unknown) {
      keys.current.delete(JSON.stringify(payload));
    },
  };
}

function Workspace({ athleteId, sessionId, transport, strategyId = null }: RecoveryWorkspaceProps) {
  const api = useMemo(() => createRecoveryApi(transport), [transport]);
  const scope: Scope = ['users', athleteId, 'sessions', sessionId, 'recovery'];
  const result = useQuery({ queryKey: scope, queryFn: ({ signal }) => api.workspace(signal) });
  const detail = useQuery({
    queryKey: [...scope, 'strategy', strategyId],
    queryFn: ({ signal }) => api.readStrategy(strategyId ?? '', signal),
    enabled: strategyId !== null,
  });
  const visibleStrategies =
    strategyId === null ? (result.data?.strategies ?? []) : detail.data ? [detail.data] : [];
  const availableStrategies = [...(result.data?.strategies ?? [])];
  if (
    detail.data &&
    !availableStrategies.some((strategy) => strategy.strategyId === detail.data.strategyId)
  ) {
    availableStrategies.push(detail.data);
  }
  const workspaceData = result.data;
  const needsInitialData = workspaceData === undefined || (strategyId !== null && !detail.data);
  const readFailed = result.isError || (strategyId !== null && detail.isError);
  return (
    <section className={styles.workspace} aria-label="회복 전략 작업 공간">
      <header className={styles.header}>
        <p className={styles.eyebrow}>회복 · 수동 계획과 기록</p>
        <h1>회복 전략</h1>
        <p>관측, 선택한 전략, 실제 행동을 분리해 봅니다. 쉬는 안도 정식 선택지입니다.</p>
        <p>이 화면은 회복 효과, 의료 안전성, 다음 운동 가능 여부를 판정하지 않습니다.</p>
      </header>
      {needsInitialData ? (
        readFailed ? (
          <div role="alert">
            <p>회복 기록을 불러오지 못했습니다.</p>
            <button
              onClick={() => {
                void result.refetch();
                if (strategyId !== null) void detail.refetch();
              }}
            >
              다시 시도
            </button>
          </div>
        ) : (
          <p role="status">회복 기록을 불러오는 중</p>
        )
      ) : (
        <>
          {readFailed ? (
            <div role="alert" className={styles.notice}>
              <p>최신 기록을 불러오지 못했습니다. 편집 중인 입력은 유지됩니다.</p>
              <button
                onClick={() => {
                  void result.refetch();
                  if (strategyId !== null) void detail.refetch();
                }}
              >
                다시 시도
              </button>
            </div>
          ) : null}
          <div className={styles.columns}>
            <section aria-labelledby="recovery-observations" className={styles.panel}>
              <h2 id="recovery-observations">관측과 재검토</h2>
              <p>
                활동·섭취·체크인은 원래 기록을 참조합니다. 여기서는 합산하거나 효과를 추정하지
                않습니다.
              </p>
              {workspaceData.observations.length === 0 && workspaceData.planRefs.length === 0 ? (
                <p>연결된 관측이 없습니다. 기록 부재는 충분한 휴식이나 미실시를 뜻하지 않습니다.</p>
              ) : (
                <ul>
                  {workspaceData.observations.map(({ reference, state }) => (
                    <li key={reference.kind + reference.id + reference.revision}>
                      {reference.kind === 'check_in'
                        ? '체크인'
                        : reference.kind === 'activity'
                          ? '활동'
                          : '섭취'}
                      {' · '}
                      {state === 'current'
                        ? '연결됨'
                        : state === 'revised'
                          ? '정정됨 · 재검토 필요'
                          : '삭제됨 · 재검토 필요'}
                    </li>
                  ))}
                  {workspaceData.planRefs.map(({ reference, state }) => (
                    <li key={reference.kind + reference.aggregateId}>
                      {reference.kind === 'training' ? '훈련 계획' : '영양 계획'}
                      {' · '}
                      {state === 'current' ? '연결됨' : '변경됨 · 재검토 필요'}
                    </li>
                  ))}
                </ul>
              )}
              {workspaceData.reassessment.length > 0 ? (
                <div role="status" className={styles.notice}>
                  <strong>재검토 조건 {workspaceData.reassessment.length}건</strong>
                  <p>
                    조건 충족은 계획 변경이나 자동 승인으로 이어지지 않습니다. 사용자 확인이
                    필요합니다.
                  </p>
                </div>
              ) : (
                <p>현재 이 전략에 표시할 재검토 조건은 없습니다.</p>
              )}
            </section>
            <section aria-labelledby="recovery-strategies" className={styles.panel}>
              <h2 id="recovery-strategies">전략과 선택</h2>
              {strategyId === null ? (
                <StrategyForm api={api} scope={scope} methods={workspaceData.methods} />
              ) : (
                <p>
                  <a href="/recovery">전체 전략으로 돌아가기</a>
                </p>
              )}
              <div className={styles.stack}>
                {visibleStrategies.length === 0 ? <p>저장된 전략이 없습니다.</p> : null}
                {visibleStrategies.map((strategy) => (
                  <StrategyCard
                    key={strategy.strategyId}
                    strategy={strategy}
                    api={api}
                    scope={scope}
                  />
                ))}
              </div>
            </section>
            <section aria-labelledby="recovery-actions" className={styles.panel}>
              <h2 id="recovery-actions">방법과 실제 행동</h2>
              <p>취침 준비 행동을 마쳐도 실제 수면 시간이나 회복 상태는 별도 관측입니다.</p>
              <MethodForm api={api} scope={scope} />
              <div className={styles.stack}>
                {workspaceData.methods.map((method) => (
                  <article key={method.versionId} className={styles.card}>
                    <h3>{method.title}</h3>
                    <p>사용 목적: {method.intendedUse || '입력 없음'}</p>
                    <p>검토 상태: 미검토 · 개인 수동 기록용</p>
                    <p>출처: {method.sourceDescription || '사용자 입력'}</p>
                    <p>근거 한계: {method.evidenceLimitations || '효과 미검증'}</p>
                    {method.cautions.length > 0 ? <p>주의: {method.cautions.join(', ')}</p> : null}
                  </article>
                ))}
              </div>
              <h3>행동 기록</h3>
              <ActionForm
                api={api}
                scope={scope}
                methods={workspaceData.methods}
                strategies={availableStrategies}
              />
              <div className={styles.stack}>
                {workspaceData.actions.length === 0 ? <p>확인된 행동 기록이 없습니다.</p> : null}
                {workspaceData.actions.map((action) =>
                  action.status === 'deleted' ? (
                    <p key={action.actionId}>삭제된 기록 · 이전 건강 정보는 표시하지 않습니다.</p>
                  ) : (
                    <ActionCard
                      key={action.actionId}
                      action={action}
                      methods={workspaceData.methods}
                      strategies={availableStrategies}
                      api={api}
                      scope={scope}
                    />
                  ),
                )}
              </div>
            </section>
          </div>
        </>
      )}
    </section>
  );
}

function MethodForm({ api, scope }: { api: RecoveryApi; scope: Scope }) {
  const client = useQueryClient();
  const [pendingCommand, setPendingCommand] = useState<CreateRecoveryMethodRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    let command = pendingCommand;
    if (command === null) {
      const values = new FormData(form);
      command = {
        title: String(values.get('title') ?? ''),
        category: String(values.get('category') ?? 'rest') as RecoveryMethodVersion['category'],
        intendedUse: String(values.get('intendedUse') ?? ''),
        applicability: [],
        cautions: String(values.get('cautions') ?? '')
          .split('\n')
          .map((value) => value.trim())
          .filter(Boolean),
        sourceDescription: String(values.get('sourceDescription') ?? ''),
        evidenceLimitations: String(values.get('evidenceLimitations') ?? ''),
        idempotencyKey: crypto.randomUUID(),
      };
      setPendingCommand(command);
    }
    setSaving(true);
    setError(null);
    try {
      await api.createMethod(command);
      setPendingCommand(null);
      form.reset();
    } catch (error) {
      if (isDefinitiveRejection(error)) {
        setPendingCommand(null);
        setError('방법 저장 요청이 거절되었습니다. 입력을 확인하고 다시 저장해 주세요.');
        return;
      }
      setError('요청 결과를 확인하지 못했습니다. 같은 방법 저장 요청으로 다시 시도해 주세요.');
      return;
    } finally {
      setSaving(false);
    }
    void client.invalidateQueries({ queryKey: scope });
  }
  return (
    <form onSubmit={(event) => void submit(event)} className={styles.form}>
      <h3>개인 방법 수동 기록</h3>
      <p>미검토 방법은 자동 추천이나 효과 보장에 쓰이지 않습니다.</p>
      <fieldset className={styles.fields} disabled={pendingCommand !== null || saving}>
        <label>
          방법 이름
          <input name="title" required maxLength={160} />
        </label>
        <label>
          분류
          <select name="category" defaultValue="rest">
            <option value="rest">수동 휴식</option>
            <option value="sleep_preparation">취침 준비</option>
            <option value="relaxation">이완·호흡</option>
            <option value="manual_method">마사지·폼롤링</option>
            <option value="compression">압박</option>
            <option value="thermal_method">냉·온 적용</option>
            <option value="electrical_stimulation">전기 자극</option>
            <option value="other">기타</option>
          </select>
        </label>
        <label>
          사용 목적
          <textarea name="intendedUse" maxLength={2000} />
        </label>
        <label>
          주의 사항 (줄마다 하나)
          <textarea name="cautions" maxLength={2000} />
        </label>
        <label>
          정보 출처
          <textarea name="sourceDescription" maxLength={2000} />
        </label>
        <label>
          근거의 한계
          <textarea
            name="evidenceLimitations"
            maxLength={2000}
            defaultValue="개인 수동 기록이며 효과를 검증하지 않았습니다."
          />
        </label>
      </fieldset>
      {error ? <p role="alert">{error}</p> : null}
      <button type="submit" disabled={saving}>
        {saving ? '저장 중' : pendingCommand !== null ? '같은 방법 요청 다시 시도' : '방법 저장'}
      </button>
    </form>
  );
}

function StrategyForm({
  api,
  scope,
  methods,
}: {
  api: RecoveryApi;
  scope: Scope;
  methods: RecoveryMethodVersion[];
}) {
  const client = useQueryClient();
  const [pendingCommand, setPendingCommand] = useState<CreateRecoveryStrategyRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    let command = pendingCommand;
    if (command === null) {
      const values = new FormData(form);
      const methodVersionId = String(values.get('methodVersionId') ?? '');
      const reassessAt = String(values.get('reassessAt') ?? '');
      const ids: [string, string, string, string] = [
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
      ];
      const options: RecoveryStrategyVersion['draft']['options'] = [
        {
          id: ids[0],
          title: '완전 휴식 · 추가 활동 없음',
          kind: 'full_rest',
          methodVersionId: null,
          explanation: '새 운동이나 행동을 만들지 않고 다시 확인합니다.',
        },
        {
          id: ids[1],
          title: '기존 계획 유지',
          kind: 'maintain_existing_plan',
          methodVersionId: null,
          explanation: '기존 계획 변경은 별도 승인 흐름에서 다룹니다.',
        },
      ];
      if (methodVersionId) {
        const method = methods.find((item) => item.versionId === methodVersionId);
        if (method)
          options.push({
            id: ids[2],
            title: method.title,
            kind: 'nonexercise_action',
            methodVersionId,
            explanation: '사용자가 선택하는 비운동 행동',
          });
      }
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      command = {
        draft: {
          title: String(values.get('title') ?? ''),
          goal: String(values.get('goal') ?? ''),
          startDate: String(values.get('startDate') ?? ''),
          endDateExclusive: String(values.get('endDateExclusive') ?? ''),
          timezone,
          knownFacts: [],
          missingInformation: String(values.get('missingInformation') ?? '')
            .split('\n')
            .map((value) => value.trim())
            .filter(Boolean),
          priority: 'normal',
          observations: [],
          planRefs: [],
          options,
          reassessment: [
            {
              id: ids[3],
              trigger: 'scheduled_checkin',
              plannedAt: new Date(reassessAt).toISOString(),
              description: '상태를 다시 확인하기',
              policyVersion: null,
            },
          ],
        },
        idempotencyKey: crypto.randomUUID(),
      };
      setPendingCommand(command);
    }
    setSaving(true);
    setError(null);
    try {
      await api.createStrategy(command);
      setPendingCommand(null);
      form.reset();
    } catch (error) {
      if (isDefinitiveRejection(error)) {
        setPendingCommand(null);
        setError('전략 초안 요청이 거절되었습니다. 입력을 확인하고 다시 저장해 주세요.');
        return;
      }
      setError('요청 결과를 확인하지 못했습니다. 같은 전략 초안 요청으로 다시 시도해 주세요.');
      return;
    } finally {
      setSaving(false);
    }
    void client.invalidateQueries({ queryKey: scope });
  }
  return (
    <form onSubmit={(event) => void submit(event)} className={styles.form}>
      <h3>새 전략 초안</h3>
      <p>초안 저장은 선택 확인이나 기존 훈련·영양 일정 변경이 아닙니다.</p>
      <fieldset className={styles.fields} disabled={pendingCommand !== null || saving}>
        <label>
          제목
          <input name="title" required maxLength={160} />
        </label>
        <label>
          목적
          <textarea name="goal" maxLength={2000} />
        </label>
        <div className={styles.row}>
          <label>
            시작 날짜
            <input name="startDate" type="date" required />
          </label>
          <label>
            종료 날짜 (미포함)
            <input name="endDateExclusive" type="date" required />
          </label>
        </div>
        <label>
          아직 모르는 정보 (줄마다 하나)
          <textarea name="missingInformation" maxLength={2000} />
        </label>
        <label>
          추가할 비운동 행동 (선택)
          <select name="methodVersionId" defaultValue="">
            <option value="">추가하지 않음</option>
            {methods.map((method) => (
              <option key={method.versionId} value={method.versionId}>
                {method.title} · 미검토
              </option>
            ))}
          </select>
        </label>
        <label>
          다시 확인할 시점
          <input name="reassessAt" type="datetime-local" required />
        </label>
      </fieldset>
      {error ? <p role="alert">{error}</p> : null}
      <button type="submit" disabled={saving}>
        {saving
          ? '저장 중'
          : pendingCommand !== null
            ? '같은 전략 요청 다시 시도'
            : '전략 초안 저장'}
      </button>
    </form>
  );
}

function StrategyCard({
  strategy,
  api,
  scope,
}: {
  strategy: RecoveryStrategyVersion;
  api: RecoveryApi;
  scope: Scope;
}) {
  const client = useQueryClient();
  const keys = useRequestKeys();
  const [selected, setSelected] = useState(strategy.draft.options[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function confirm() {
    const body = {
      strategyId: strategy.strategyId,
      expectedHeadVersionId: strategy.versionId,
      selectedOptionId: selected,
    };
    setSaving(true);
    setError(null);
    try {
      await api.confirmStrategy({ ...body, idempotencyKey: keys.forPayload(body) });
      keys.clear(body);
      await client.invalidateQueries({ queryKey: scope });
    } catch {
      setError('선택을 확인하지 못했습니다. 최신 전략과 관측을 다시 확인해 주세요.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <article className={styles.card}>
      <h3>{strategy.draft.title}</h3>
      <p>
        <a href={`/recovery/strategies/${encodeURIComponent(strategy.strategyId)}`}>전략 상세</a>
      </p>
      <p>목적: {strategy.draft.goal || '입력 없음'}</p>
      <p>
        기간: {strategy.draft.startDate} ~ {strategy.draft.endDateExclusive} (종료일 미포함)
      </p>
      <p>
        상태: {strategy.status === 'draft' ? '초안 · 아직 선택 확인 전' : '사용자가 선택 확인함'}
      </p>
      {strategy.draft.missingInformation.length > 0 ? (
        <p>미확인: {strategy.draft.missingInformation.join(', ')}</p>
      ) : null}
      {strategy.status === 'draft' ? (
        <div className={styles.form}>
          <label>
            선택할 안
            <select value={selected} onChange={(event) => setSelected(event.target.value)}>
              {strategy.draft.options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.title}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => void confirm()} disabled={saving || !selected}>
            {saving ? '확인 중' : '이 안을 명시적으로 선택'}
          </button>
          <p>
            이 선택은 전략 기록입니다. 기존 훈련·영양·루틴 일정과 실제 수행은 변경하지 않습니다.
          </p>
        </div>
      ) : (
        <p>
          선택한 안:{' '}
          {strategy.draft.options.find((option) => option.id === strategy.selectedOptionId)?.title}
        </p>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </article>
  );
}

function localDateTime(instant: string) {
  const date = new Date(instant);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function ActionForm({
  api,
  scope,
  methods,
  strategies,
  existing,
  currentRevisionId,
  onPendingChange,
  onDone,
}: {
  api: RecoveryApi;
  scope: Scope;
  methods: RecoveryMethodVersion[];
  strategies: RecoveryStrategyVersion[];
  existing?: RecoveryActionLog;
  currentRevisionId?: string;
  onPendingChange?: (pending: boolean) => void;
  onDone?: () => void;
}) {
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingCommand, setPendingCommand] = useState<
    | { kind: 'create'; payload: CreateRecoveryActionRequest }
    | { kind: 'correct'; payload: CorrectRecoveryActionRequest }
    | null
  >(null);
  const [selectedMethod, setSelectedMethod] = useState(existing?.methodVersionId ?? '');
  const [selectedPlanOption, setSelectedPlanOption] = useState(
    existing?.strategyVersionId && existing.plannedOptionId
      ? existing.strategyVersionId + ':' + existing.plannedOptionId
      : '',
  );
  const planOptions = strategies
    .filter((strategy) => strategy.status === 'user_confirmed')
    .flatMap((strategy) =>
      strategy.draft.options
        .filter(
          (option) =>
            option.kind === 'nonexercise_action' &&
            option.id === strategy.selectedOptionId &&
            option.methodVersionId === selectedMethod,
        )
        .map((option) => ({ strategy, option })),
    );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (existing && currentRevisionId !== existing.revisionId && pendingCommand === null) {
      setError('기록이 변경되었습니다. 입력은 유지되며 새 버전으로 다시 시작해야 합니다.');
      return;
    }
    const form = event.currentTarget;
    let command = pendingCommand;
    if (command === null) {
      const values = new FormData(form);
      const link = String(values.get('planOption') ?? '');
      const matched = planOptions.find(
        ({ strategy, option }) => strategy.versionId + ':' + option.id === link,
      );
      const duration = String(values.get('durationSeconds') ?? '');
      const enteredAt = String(values.get('occurredAt') ?? '');
      const timeUnchanged =
        existing !== undefined && enteredAt === localDateTime(existing.occurredAt);
      const body = {
        methodVersionId: String(values.get('methodVersionId') ?? ''),
        strategyVersionId: matched?.strategy.versionId ?? null,
        plannedOptionId: matched?.option.id ?? null,
        occurredAt: timeUnchanged ? existing.occurredAt : new Date(enteredAt).toISOString(),
        timezone: timeUnchanged
          ? existing.timezone
          : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        state: String(values.get('state') ?? 'performed') as RecoveryActionLog['state'],
        durationSeconds: duration === '' ? null : Number(duration),
        actualConditions: String(values.get('actualConditions') ?? ''),
        beforeCheckIn: existing?.beforeCheckIn ?? null,
        afterCheckIn: existing?.afterCheckIn ?? null,
        discomfort: String(values.get('discomfort') ?? ''),
        userNotes: String(values.get('userNotes') ?? ''),
        source: 'user_confirmed' as const,
      };
      command = existing
        ? {
            kind: 'correct',
            payload: {
              ...body,
              actionId: existing.actionId,
              expectedRevision: existing.revision,
              idempotencyKey: crypto.randomUUID(),
            },
          }
        : { kind: 'create', payload: { ...body, idempotencyKey: crypto.randomUUID() } };
      setPendingCommand(command);
      onPendingChange?.(true);
    }
    setSaving(true);
    setError(null);
    try {
      if (command.kind === 'correct') {
        await api.correctAction(command.payload);
        setPendingCommand(null);
        onPendingChange?.(false);
        onDone?.();
      } else {
        await api.createAction(command.payload);
        setPendingCommand(null);
        onPendingChange?.(false);
        form.reset();
        setSelectedMethod('');
        setSelectedPlanOption('');
      }
    } catch (error) {
      if (isDefinitiveRejection(error)) {
        setPendingCommand(null);
        onPendingChange?.(false);
        setError('행동 기록 요청이 거절되었습니다. 최신 상태와 입력을 확인해 주세요.');
        return;
      }
      setError(
        '요청 결과를 확인하지 못했습니다. 입력을 잠갔습니다. 같은 요청으로 다시 시도해 주세요.',
      );
      return;
    } finally {
      setSaving(false);
    }
    void client.invalidateQueries({ queryKey: scope });
  }
  return (
    <form onSubmit={(event) => void submit(event)} className={styles.form}>
      <h4>{existing ? '행동 기록 정정' : '비운동 행동 수동 기록'}</h4>
      {methods.length === 0 ? <p>먼저 개인 방법을 기록해 주세요.</p> : null}
      <fieldset className={styles.fields} disabled={pendingCommand !== null || saving}>
        <label>
          방법
          <select
            name="methodVersionId"
            required
            value={selectedMethod}
            onChange={(event) => {
              setSelectedMethod(event.target.value);
              setSelectedPlanOption('');
            }}
          >
            <option value="">선택</option>
            {methods.map((method) => (
              <option key={method.versionId} value={method.versionId}>
                {method.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          선택한 전략과 연결 (선택)
          <select
            name="planOption"
            value={selectedPlanOption}
            onChange={(event) => setSelectedPlanOption(event.target.value)}
          >
            <option value="">계획 없이 기록</option>
            {planOptions.map(({ strategy, option }) => (
              <option
                key={strategy.versionId + option.id}
                value={strategy.versionId + ':' + option.id}
              >
                {strategy.draft.title} · {option.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          실제 시각
          <input
            name="occurredAt"
            type="datetime-local"
            required
            defaultValue={existing ? localDateTime(existing.occurredAt) : ''}
          />
        </label>
        <label>
          수행 상태
          <select name="state" defaultValue={existing?.state ?? 'performed'}>
            <option value="performed">수행 확인</option>
            <option value="partial">부분 수행</option>
            <option value="confirmed_skipped">건너뜀 확인</option>
            <option value="stopped">중단</option>
            <option value="unconfirmed">미확인</option>
          </select>
        </label>
        <label>
          실제 확인한 시간 (초, 선택)
          <input
            name="durationSeconds"
            type="number"
            min="0"
            max="86400"
            defaultValue={existing?.durationSeconds ?? ''}
          />
        </label>
        <label>
          실제 조건
          <textarea
            name="actualConditions"
            maxLength={2000}
            defaultValue={existing?.actualConditions ?? ''}
          />
        </label>
        <label>
          불편감 (선택)
          <textarea name="discomfort" maxLength={2000} defaultValue={existing?.discomfort ?? ''} />
        </label>
        <label>
          내 기록
          <textarea name="userNotes" maxLength={2000} defaultValue={existing?.userNotes ?? ''} />
        </label>
      </fieldset>
      <p>행동 확인은 수면·회복 상태의 확인이나 효과 검증이 아닙니다.</p>
      {error ? <p role="alert">{error}</p> : null}
      <button
        type="submit"
        disabled={
          saving ||
          methods.length === 0 ||
          (existing !== undefined &&
            currentRevisionId !== existing.revisionId &&
            pendingCommand === null)
        }
      >
        {saving
          ? '저장 중'
          : pendingCommand !== null
            ? '같은 요청 다시 시도'
            : existing
              ? '정정 저장'
              : '행동 저장'}
      </button>
      {existing ? (
        <button type="button" onClick={onDone} disabled={pendingCommand !== null || saving}>
          정정 취소
        </button>
      ) : null}
    </form>
  );
}

function ActionCard({
  action,
  methods,
  strategies,
  api,
  scope,
}: {
  action: RecoveryActionLog;
  methods: RecoveryMethodVersion[];
  strategies: RecoveryStrategyVersion[];
  api: RecoveryApi;
  scope: Scope;
}) {
  const [editingBaseline, setEditingBaseline] = useState<RecoveryActionLog | null>(null);
  const [uncertainCorrection, setUncertainCorrection] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const client = useQueryClient();
  const keys = useRequestKeys();
  const method = methods.find((item) => item.versionId === action.methodVersionId);
  async function remove() {
    if (!window.confirm('이 행동 기록을 삭제할까요?')) return;
    const body = { actionId: action.actionId, expectedRevision: action.revision };
    setDeleting(true);
    setError(null);
    try {
      await api.deleteAction({ ...body, idempotencyKey: keys.forPayload(body) });
      keys.clear(body);
      await client.invalidateQueries({ queryKey: scope });
    } catch {
      setError('기록을 삭제하지 못했습니다. 최신 상태를 다시 확인해 주세요.');
    } finally {
      setDeleting(false);
    }
  }
  return (
    <article className={styles.card}>
      <h4>
        {method?.title ?? '이전 방법'} · {action.state}
      </h4>
      <p>{new Date(action.occurredAt).toLocaleString()}</p>
      <p>
        확인한 시간: {action.durationSeconds === null ? '미확인' : action.durationSeconds + '초'}
      </p>
      {action.discomfort ? <p>불편감 보고: {action.discomfort}</p> : null}
      <button
        type="button"
        onClick={() => setEditingBaseline((current) => (current === null ? action : null))}
        disabled={uncertainCorrection}
      >
        정정
      </button>
      <button
        type="button"
        onClick={() => void remove()}
        disabled={deleting || uncertainCorrection}
      >
        기록 삭제
      </button>
      {editingBaseline ? (
        <>
          {editingBaseline.revisionId !== action.revisionId ? (
            <div role="alert">
              <p>
                {uncertainCorrection
                  ? '다른 변경이 반영되었습니다. 이전 정정 요청의 결과를 같은 키로 다시 확인해 주세요.'
                  : '다른 변경이 반영되었습니다. 입력을 유지하며 정정 저장은 멈췄습니다.'}
              </p>
              {uncertainCorrection ? null : (
                <button type="button" onClick={() => setEditingBaseline(action)}>
                  최신 기록으로 다시 입력
                </button>
              )}
            </div>
          ) : null}
          <ActionForm
            key={editingBaseline.revisionId}
            api={api}
            scope={scope}
            methods={methods}
            strategies={strategies}
            existing={editingBaseline}
            currentRevisionId={action.revisionId}
            onPendingChange={setUncertainCorrection}
            onDone={() => setEditingBaseline(null)}
          />
        </>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </article>
  );
}
