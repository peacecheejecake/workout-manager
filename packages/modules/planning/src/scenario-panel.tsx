'use client';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useStore } from 'zustand';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import {
  planDraftSchema,
  planSnapshotSchema,
  preservesSessionLocks,
  type PlanRead,
} from '@workout/contracts/planning';
import {
  planScenarioSchema,
  planScenarioLabelSchema,
  planScenarioListSchema,
  planScenarioListQuerySchema,
  planScenarioCreateSchema,
  planScenarioSaveSchema,
} from '@workout/contracts/plan-scenarios';
import { Button } from '@workout/ui-foundation/button';
import { PlanSummary } from './plan-summary';
import { PlanConstraintsReport } from './period-constraints-summary';
import { preservesSessionCompletions } from '@workout/contracts/session-completion';
import { useSessionCompletions } from './use-session-completions';
import type { ScenarioDraftStore } from './scenario-draft-store';
import { ScenarioEditor } from './scenario-editor';
import { ScenarioComparison } from './scenario-comparison';
import {
  readScenarioResource,
  prepareScenarioApply,
  runScenarioCommand,
  ScenarioRequestError,
  type ScenarioCommand,
} from './scenario-commands';
import styles from './scenario-panel.module.css';
export interface PlanScenarioPanelProps {
  athleteId: string;
  sessionId: string;
  transport: AuthenticatedTransport;
  current: PlanRead | undefined;
  search: string;
  onSearchChange(query: string): void;
  manualDraftActive: boolean;
  store: ScenarioDraftStore;
  onApplied(): Promise<void>;
  today: string;
  createId: () => string;
}
export function PlanScenarioPanel(props: PlanScenarioPanelProps) {
  return <Controller key={JSON.stringify([props.athleteId, props.sessionId])} {...props} />;
}
function Controller({
  athleteId,
  sessionId,
  transport: upstreamTransport,
  current,
  search,
  onSearchChange,
  manualDraftActive,
  store,
  onApplied,
  today,
  createId,
}: PlanScenarioPanelProps) {
  const client = useQueryClient();
  const scope = ['plan-scenarios', athleteId, sessionId];
  const draft = useStore(store, (state) => state.draft),
    source = useStore(store, (state) => state.source);
  const [frozen, setFrozen] = useState<ScenarioCommand | null>(null);
  const phase = useStore(store, (state) => state.phase);
  const setPhase = store.getState().setPhase;
  const [message, setMessage] = useState(''),
    [error, setError] = useState('');
  const [newScenarioLabel, setNewScenarioLabel] = useState('');
  const [authExpired, setAuthExpired] = useState(false);
  const revoked = useRef(false);
  const active = useRef(true),
    request = useRef<AbortController | null>(null),
    manual = useRef(manualDraftActive);
  useLayoutEffect(() => {
    manual.current = manualDraftActive;
  }, [manualDraftActive]);
  const revoke = useCallback(() => {
    revoked.current = true;
    request.current?.abort();
    store.getState().reset();
    store.getState().setPhase('idle');
    setFrozen(null);
    setMessage('');
    setError('');
    setAuthExpired(true);
    client.removeQueries({ queryKey: ['plan-scenarios', athleteId, sessionId] });
    client.removeQueries({ queryKey: ['planning-completions', athleteId, sessionId] });
  }, [store, client, athleteId, sessionId]);
  const transport = useMemo<AuthenticatedTransport>(
    () => ({
      request: async (input) => {
        if (revoked.current) throw new ScenarioRequestError(401);
        try {
          const reply = await upstreamTransport.request(input);
          if (reply.status === 401) {
            revoke();
            throw new ScenarioRequestError(401);
          }
          return reply;
        } catch (error) {
          if (error instanceof Error && error.message === 'SESSION_EXPIRED') revoke();
          throw error;
        }
      },
    }),
    [upstreamTransport, revoke],
  );
  const trigger = useRef<HTMLElement | null>(null),
    returnFocus = useRef(false);
  const busy = draft !== null || phase !== 'idle';
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      request.current?.abort();
      store.getState().reset();
      store.getState().setPhase('idle');
    };
  }, [store]);
  useLayoutEffect(() => {
    if (phase === 'idle' && returnFocus.current) {
      returnFocus.current = false;
      trigger.current?.focus();
    }
  }, [phase]);
  const focusCancel = useCallback((node: HTMLButtonElement | null) => node?.focus(), []);
  const params = new URLSearchParams(search);
  const baseId = planScenarioSchema.shape.id
    .nullable()
    .safeParse(params.get('scenarioBase') ?? current?.head?.id ?? null);
  const selectedId = planScenarioSchema.shape.id.nullable().safeParse(params.get('scenario'));
  const requestedOffset = planScenarioListQuerySchema.shape.offset.safeParse(
    params.get('scenarioOffset') ?? 0,
  );
  const revision = planScenarioSchema.shape.revision
    .nullable()
    .safeParse(params.has('scenarioRevision') ? Number(params.get('scenarioRevision')) : null);
  const invalid =
    !baseId.success || !selectedId.success || !revision.success || !requestedOffset.success;
  const base = baseId.success ? (baseId.data?.toLowerCase() ?? null) : null;
  const selected = selectedId.success ? (selectedId.data?.toLowerCase() ?? null) : null;
  const version = revision.success ? revision.data : null;
  const offset = requestedOffset.success ? requestedOffset.data : 0;
  function change(values: Record<string, string | null>) {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(values))
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    onSearchChange(next.toString());
  }
  const baseRead = useQuery({
    queryKey: [...scope, 'base', base],
    enabled: !authExpired && !invalid && base !== null,
    retry: false,
    queryFn: async ({ signal }) => {
      const snapshot = await readScenarioResource(
        transport,
        `/bff/v1/plans/versions/${base}`,
        planSnapshotSchema,
        signal,
      );
      if (snapshot.id !== base) throw new Error('BASE_MISMATCH');
      return snapshot;
    },
  });
  const list = useQuery({
    queryKey: [...scope, 'list', base, offset],
    enabled: !authExpired && !invalid && base !== null,
    retry: false,
    queryFn: ({ signal }) =>
      readScenarioResource(
        transport,
        `/bff/v1/plan-scenarios?${new URLSearchParams({ basePlanVersionId: base ?? '', limit: '100', offset: String(offset) })}`,
        planScenarioListSchema,
        signal,
      ),
  });
  const detail = useQuery({
    queryKey: [...scope, version === null ? 'detail' : 'revision', selected, version],
    enabled: !authExpired && !invalid && selected !== null,
    retry: false,
    queryFn: async ({ signal }) => {
      const result = await readScenarioResource(
        transport,
        `/bff/v1/plan-scenarios/${selected}${version === null ? '' : `/revisions/${version}`}`,
        planScenarioSchema,
        signal,
      );
      if (result.id !== selected || (version !== null && result.revision !== version))
        throw new Error('SCENARIO_MISMATCH');
      return result;
    },
  });
  const currentScenario = detail.isSuccess && !detail.isFetching ? detail.data : null;
  const readyBase = baseRead.isSuccess && !baseRead.isFetching ? baseRead.data : null;
  const completions = useSessionCompletions({
    athleteId,
    sessionId,
    transport,
    planVersionId: authExpired ? null : (current?.head?.id ?? null),
  });
  const completionReady = Boolean(
    current?.head &&
    completions.isSuccess &&
    !completions.isFetching &&
    completions.data.currentPlanVersionId === current.head.id,
  );
  const reports = completions.data?.items.filter((item) => item.status === 'completed') ?? [];
  const completionValid = !draft || preservesSessionCompletions(draft, reports);
  const writable = !manualDraftActive && !busy && !invalid;
  const parsedNewLabel = planScenarioLabelSchema.safeParse(newScenarioLabel);
  async function refresh() {
    await client.cancelQueries({ queryKey: scope });
    await client.resetQueries({ queryKey: scope }, { throwOnError: true });
  }
  function startReview(command: ScenarioCommand) {
    setMessage('');
    setError('');
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setFrozen(structuredClone(command));
    setPhase('preview');
  }
  function cancel() {
    if (phase === 'pending' || phase === 'uncertain') return;
    request.current?.abort();
    request.current = null;
    setFrozen(null);
    setPhase('idle');
    returnFocus.current = true;
  }
  async function prepareApply() {
    if (!writable || !currentScenario || version !== null || request.current) return;
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const controller = new AbortController();
    request.current = controller;
    setPhase('preparing');
    setMessage('');
    setError('');
    try {
      const command = await prepareScenarioApply(
        transport,
        currentScenario,
        controller.signal,
        createId,
      );
      if (!active.current || revoked.current || controller.signal.aborted || manual.current) return;
      setFrozen(structuredClone(command));
      setPhase('preview');
    } catch (reason) {
      if (active.current && !revoked.current && !controller.signal.aborted) {
        setError(
          reason instanceof ScenarioRequestError && reason.code === 'SCENARIO_LOCKED'
            ? '최신 현재 계획의 잠금과 충돌합니다. 현재 계획에서 먼저 잠금 해제를 저장하고 다시 검토하세요.'
            : reason instanceof ScenarioRequestError && reason.code === 'SCENARIO_COMPLETED'
              ? '완료 확인으로 고정된 일정과 충돌합니다. 자동으로 완료 기록을 철회하거나 일정을 바꾸지 않습니다.'
              : '현재 계획·시나리오·완료 확인을 함께 검증하지 못했습니다. 최신 상태를 다시 확인한 뒤 새로 검토하세요.',
        );
        setPhase('idle');
      }
    } finally {
      if (request.current === controller) request.current = null;
    }
  }
  async function execute() {
    if (!frozen || request.current || manual.current) return;
    const controller = new AbortController();
    request.current = controller;
    setPhase('pending');
    setError('');
    try {
      const result = await runScenarioCommand(transport, frozen, controller.signal);
      if (!active.current || revoked.current || controller.signal.aborted) return;
      if (frozen.kind === 'save') store.getState().reset();
      setFrozen(null);
      setMessage(
        result.kind === 'applied'
          ? '현재 계획 적용 요청 처리를 확인했습니다. 현재 상태는 별도로 다시 조회합니다.'
          : '시나리오 저장 요청 처리를 확인했습니다. 현재 계획은 적용 요청을 하기 전까지 변경되지 않습니다.',
      );
      if (result.kind === 'scenario')
        change({
          scenarioBase: result.scenario.basePlanVersionId,
          scenario: result.scenario.id,
          scenarioRevision: null,
          scenarioOffset: null,
        });
      try {
        await Promise.all([
          refresh(),
          result.kind === 'applied' &&
          active.current &&
          !revoked.current &&
          !controller.signal.aborted
            ? onApplied()
            : Promise.resolve(),
        ]);
      } catch {
        if (active.current && !revoked.current && !controller.signal.aborted)
          setError(
            '요청 처리는 확인했지만 최신 조회가 실패했습니다. 같은 변경을 다시 만들지 말고 시나리오와 현재 계획을 다시 확인하세요.',
          );
      }
      if (active.current && !revoked.current && !controller.signal.aborted) setPhase('idle');
    } catch (reason) {
      if (!active.current || revoked.current || controller.signal.aborted) return;
      if (
        reason instanceof ScenarioRequestError &&
        [400, 401, 403, 404, 409].includes(reason.status)
      ) {
        setFrozen(null);
        setPhase('idle');
        setError(
          reason.status === 409
            ? '다른 변경과 충돌했습니다. 시나리오 초안은 유지합니다. 최신 상태를 확인하고 새로 미리보기하세요.'
            : '요청이 거절되었습니다. 로그인·입력·접근 상태를 확인하세요. 시나리오 초안은 유지합니다.',
        );
        try {
          await Promise.all([
            refresh(),
            frozen.kind === 'apply' &&
            active.current &&
            !revoked.current &&
            !controller.signal.aborted
              ? onApplied()
              : Promise.resolve(),
          ]);
        } catch {
          /* The rejected command is settled; read failures stay visible in query state. */
        }
      } else {
        setPhase('uncertain');
        setError(
          '요청 결과가 미확인입니다. 내용과 요청 키를 고정했습니다. 같은 요청으로만 다시 확인하세요.',
        );
      }
    } finally {
      if (request.current === controller) request.current = null;
    }
  }
  const versions = current
    ? Array.from(
        new Map(
          [
            ...(current.head
              ? [
                  {
                    id: current.head.id,
                    version: current.head.version,
                    title: current.head.draft.title,
                  },
                ]
              : []),
            ...current.history,
          ].map((item) => [item.id, item]),
        ).values(),
      )
    : [];
  const commandLabel =
    frozen?.kind === 'create'
      ? '확인하고 시나리오 만들기'
      : frozen?.kind === 'save'
        ? '확인하고 시나리오 저장'
        : '확인하고 현재 계획에 적용';
  if (authExpired)
    return (
      <section aria-label="계획 시나리오">
        <h2>계획 시나리오</h2>
        <p role="alert">
          로그인을 다시 확인하세요. 이 계정의 시나리오 초안과 미확인 요청은 화면에서 지웠습니다.
        </p>
      </section>
    );
  return (
    <section className={styles.panel} aria-label="계획 시나리오">
      <h2>계획 시나리오</h2>
      <p>
        하나의 저장된 기준 계획 버전에서 여러 대안을 따로 관리합니다. A·B·C는 이름을 정할 때 사용할
        수 있는 예시일 뿐 개수나 이름을 제한하지 않습니다. 강도 라벨이 아니며 선택·편집·대안
        저장만으로 현재 계획이나 실제 활동은 바뀌지 않습니다.
      </p>
      {manualDraftActive ? (
        <p role="status">
          현재 계획 초안 편집을 마치거나 버린 뒤 시나리오를 편집·저장·적용할 수 있습니다.
        </p>
      ) : null}
      {invalid ? (
        <>
          <p role="alert">
            시나리오 주소가 올바르지 않습니다. 다른 대안으로 대신 선택하지 않습니다.
          </p>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() =>
              change({
                scenarioBase: null,
                scenario: null,
                scenarioRevision: null,
                scenarioOffset: null,
              })
            }
          >
            시나리오 조회 초기화
          </Button>
        </>
      ) : null}
      <fieldset disabled={busy}>
        <legend>시나리오 기준과 선택</legend>
        <label>
          시나리오 기준 계획 버전
          <select
            value={base ?? ''}
            onChange={(event) =>
              change({
                scenarioBase: event.target.value || null,
                scenario: null,
                scenarioRevision: null,
                scenarioOffset: null,
                scenarioCompareFrom: null,
                scenarioCompareTo: null,
                scenarioPeriod: null,
              })
            }
          >
            <option value="">저장된 기준 계획 선택</option>
            {base && !versions.some((item) => item.id === base) ? (
              <option value={base}>선택한 이전 기준 계획</option>
            ) : null}
            {versions.map((item) => (
              <option key={item.id} value={item.id}>
                계획 버전 {item.version} · {item.title}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="secondary"
          onClick={() => {
            void refresh().catch(() => {
              if (active.current && !revoked.current)
                setError(
                  '시나리오 최신 조회에 실패했습니다. 입력 내용을 유지하며 다시 확인할 수 있습니다.',
                );
            });
          }}
        >
          시나리오 다시 확인
        </Button>
        {readyBase ? (
          <p>
            고정 기준: 계획 버전 {readyBase.version} · {readyBase.draft.title} · {readyBase.id}
          </p>
        ) : baseRead.isFetching ? (
          <p role="status">기준 계획을 조회하고 있습니다.</p>
        ) : baseRead.isError ? (
          <p role="alert">기준 계획을 불러오지 못했습니다.</p>
        ) : (
          <p>시나리오를 만들려면 저장된 계획이 필요합니다.</p>
        )}
        <div className={styles.actions}>
          <label>
            새 시나리오 이름
            <input
              value={newScenarioLabel}
              maxLength={80}
              onChange={(event) => setNewScenarioLabel(event.target.value)}
              placeholder="예: 대회 준비 주간"
            />
          </label>
          <Button
            variant="secondary"
            disabled={
              !writable ||
              !readyBase ||
              !list.isSuccess ||
              list.isFetching ||
              !parsedNewLabel.success ||
              list.data.items.some((item) => item.label === parsedNewLabel.data)
            }
            onClick={() => {
              if (!readyBase || !writable) return;
              if (!parsedNewLabel.success) return;
              startReview({
                kind: 'create',
                base: readyBase,
                command: planScenarioCreateSchema.parse({
                  confirmed: true,
                  idempotencyKey: createId(),
                  basePlanVersionId: readyBase.id,
                  label: parsedNewLabel.data,
                }),
              });
            }}
          >
            이름으로 시나리오 만들기
          </Button>
          {(['A', 'B', 'C'] as const).map((label) => (
            <Button
              key={label}
              variant="secondary"
              disabled={
                !writable ||
                !readyBase ||
                !list.isSuccess ||
                list.isFetching ||
                list.data.items.some((item) => item.label === label)
              }
              onClick={() => {
                if (!readyBase || !writable) return;
                startReview({
                  kind: 'create',
                  base: readyBase,
                  command: planScenarioCreateSchema.parse({
                    confirmed: true,
                    idempotencyKey: createId(),
                    basePlanVersionId: readyBase.id,
                    label,
                  }),
                });
              }}
            >
              시나리오 {label} 만들기
            </Button>
          ))}
        </div>
        {list.isError ? (
          <p role="alert">대안 목록을 불러오지 못했습니다. 새로 확인하세요.</p>
        ) : list.isFetching ? (
          <p role="status">대안 목록을 조회하고 있습니다.</p>
        ) : list.isSuccess ? (
          <>
            <p>
              이 기준의 시나리오 {list.data.total}개 ·{' '}
              {list.data.items.length === 0 ? 0 : offset + 1}–
              {Math.min(offset + list.data.items.length, list.data.total)} 표시
            </p>
            <ul>
              {list.data.items.map((item) => (
                <li key={item.id}>
                  <Button
                    variant="secondary"
                    aria-pressed={selected === item.id}
                    onClick={() =>
                      change({
                        scenario: item.id,
                        scenarioRevision: null,
                        scenarioCompareFrom: null,
                        scenarioCompareTo: null,
                        scenarioPeriod: null,
                      })
                    }
                  >
                    시나리오 {item.label} 선택
                  </Button>{' '}
                  · 수정 {item.revision} · {item.title}
                </li>
              ))}
            </ul>
            <div className={styles.actions}>
              <Button
                variant="secondary"
                disabled={offset === 0}
                onClick={() => change({ scenarioOffset: String(Math.max(0, offset - 100)) })}
              >
                이전 시나리오 페이지
              </Button>
              <Button
                variant="secondary"
                disabled={offset + 100 >= list.data.total}
                onClick={() => change({ scenarioOffset: String(offset + 100) })}
              >
                다음 시나리오 페이지
              </Button>
            </div>
          </>
        ) : null}
      </fieldset>
      {detail.isFetching && selected ? (
        <p role="status">선택한 시나리오 본문을 조회하고 있습니다.</p>
      ) : detail.isError && selected ? (
        <p role="alert">
          선택한 시나리오를 불러오지 못했습니다. 다른 대안을 대신 표시하지 않습니다.
        </p>
      ) : null}
      {currentScenario ? (
        <section aria-label="선택한 시나리오">
          <h3>
            시나리오 {currentScenario.label} · 수정 {currentScenario.revision}
          </h3>
          <p>
            기준 계획 ID {currentScenario.basePlanVersionId} · 마지막 저장{' '}
            {currentScenario.updatedAt}
          </p>
          <form
            key={`${currentScenario.id}:${version}`}
            onSubmit={(event) => {
              event.preventDefault();
              if (busy) return;
              const data = new FormData(event.currentTarget);
              change({ scenarioRevision: String(data.get('revision') ?? '') });
            }}
          >
            <label>
              조회할 시나리오 수정 번호
              <input
                type="number"
                min="1"
                name="revision"
                defaultValue={currentScenario.revision}
                disabled={busy}
              />
            </label>
            <Button type="submit" variant="secondary" disabled={busy}>
              이전 시나리오 수정 조회
            </Button>
          </form>
          {version !== null ? (
            <>
              <p>불변 이전 수정 본문입니다. 편집·적용은 최신 수정에서 시작하세요.</p>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => change({ scenarioRevision: null })}
              >
                최신 시나리오 조회
              </Button>
            </>
          ) : null}
          <details>
            <summary>저장된 시나리오 전체 본문</summary>
            <PlanSummary draft={currentScenario.draft} />
          </details>
          <div className={styles.actions}>
            <Button
              variant="secondary"
              disabled={!writable || version !== null || !completionReady}
              onClick={() => {
                if (writable && completionReady) {
                  setMessage('');
                  setError('');
                  store.getState().start(currentScenario);
                }
              }}
            >
              시나리오 초안 편집
            </Button>
            <Button
              variant="secondary"
              disabled={!writable || version !== null}
              onClick={() => void prepareApply()}
            >
              현재 계획 적용 미리보기
            </Button>
          </div>
          <ScenarioComparison
            scenario={currentScenario}
            alternatives={list.data?.items ?? []}
            transport={transport}
            scope={scope}
            search={search}
            onChange={change}
          />
        </section>
      ) : null}
      {draft && source && !manualDraftActive ? (
        <ScenarioEditor
          key={source.id}
          store={store}
          disabled={phase !== 'idle' || !completionReady}
          canSave={completionValid}
          completedSessionIds={reports.map((item) => item.sessionId)}
          today={today}
          createId={createId}
          onPreview={() => {
            const parsed = planDraftSchema.safeParse(store.getState().draft);
            if (
              !parsed.success ||
              !source ||
              manual.current ||
              phase !== 'idle' ||
              !completionReady ||
              !preservesSessionLocks(source.draft, parsed.data) ||
              !preservesSessionCompletions(parsed.data, reports)
            )
              return;
            startReview({
              kind: 'save',
              scenario: source,
              command: planScenarioSaveSchema.parse({
                confirmed: true,
                idempotencyKey: createId(),
                expectedRevision: source.revision,
                draft: parsed.data,
              }),
            });
          }}
        />
      ) : null}
      {draft &&
      source &&
      currentScenario &&
      currentScenario.id === source.id &&
      currentScenario.revision !== source.revision &&
      phase === 'idle' ? (
        <>
          <p role="alert">
            시나리오가 다른 수정으로 변경되었습니다. 내 초안 전체와 최신 저장 본문을 비교한 후 기준
            변경을 명시적으로 선택하세요.
          </p>
          <Button
            variant="secondary"
            disabled={manualDraftActive || !completionReady}
            onClick={() => store.getState().rebase(currentScenario)}
          >
            최신 시나리오를 기준으로 초안 다시 검토
          </Button>
        </>
      ) : null}
      {draft && !completionReady ? (
        <p role="status">시나리오 편집을 위해 최신 완료 확인을 조회해야 합니다.</p>
      ) : null}
      {draft && !completionValid ? (
        <p role="alert">
          시나리오 초안이 현재 완료 확인의 일정과 충돌합니다. 날짜·Block·시작 시각·시간대·삭제를
          복원하거나 완료 확인을 별도로 철회한 뒤 다시 검토하세요.
        </p>
      ) : null}
      {phase === 'preparing' ? (
        <>
          <p role="status">현재 계획·완료 확인·저장된 시나리오를 함께 검증하고 있습니다.</p>
          <Button ref={focusCancel} variant="secondary" onClick={cancel}>
            시나리오 검토 취소
          </Button>
        </>
      ) : null}
      {frozen ? (
        <section className={styles.preview} role="group" aria-label="시나리오 변경 확인">
          <h3>
            {frozen.kind === 'apply'
              ? '현재 계획 전체 교체 확인'
              : frozen.kind === 'create'
                ? '시나리오 생성 확인'
                : '시나리오 대안 저장 확인'}
          </h3>
          {frozen.kind === 'create' ? (
            <>
              <p>
                계획 버전 {frozen.base.version} · {frozen.base.draft.title}에서 시나리오{' '}
                {frozen.command.label}을 만듭니다.
              </p>
              <PlanSummary draft={frozen.base.draft} />
            </>
          ) : frozen.kind === 'save' ? (
            <>
              <p>
                시나리오 {frozen.scenario.label} 수정 {frozen.command.expectedRevision} → 새 대안
                수정. 현재 계획은 바뀌지 않습니다.
              </p>
              <details>
                <summary>저장 전 시나리오</summary>
                <PlanSummary draft={frozen.scenario.draft} />
              </details>
              <PlanSummary draft={frozen.command.draft} />
              <PlanConstraintsReport plan={frozen.command.draft} />
            </>
          ) : (
            <>
              <p>
                현재 계획 버전 {frozen.before.version} · {frozen.before.draft.title}를 시나리오{' '}
                {frozen.scenario.label} 수정 {frozen.scenario.revision}의 전체 본문으로 바꿉니다.
                선택 기간만 적용하는 작업이 아닙니다. 실제 기록은 변경하지 않습니다.
              </p>
              <p>
                완료 확인 수정 {frozen.command.expectedCompletionRevision}. 확인한
                계획·시나리오·완료 상태가 바뀌면 적용이 거절됩니다.
              </p>
              <details>
                <summary>적용 전 현재 계획</summary>
                <PlanSummary draft={frozen.before.draft} />
              </details>
              <section aria-label="적용 후 계획">
                <PlanSummary draft={frozen.scenario.draft} />
                <PlanConstraintsReport plan={frozen.scenario.draft} />
              </section>
            </>
          )}
          {phase === 'pending' ? (
            <p role="status">확인한 요청을 처리하고 있습니다.</p>
          ) : phase === 'uncertain' ? (
            <Button disabled={manualDraftActive} onClick={() => void execute()}>
              같은 시나리오 요청 다시 확인
            </Button>
          ) : (
            <div className={styles.actions}>
              <Button disabled={manualDraftActive} onClick={() => void execute()}>
                {commandLabel}
              </Button>
              <Button ref={focusCancel} variant="secondary" onClick={cancel}>
                시나리오 검토 취소
              </Button>
            </div>
          )}
        </section>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
