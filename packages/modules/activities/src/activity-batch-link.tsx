import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { planReadSchema } from '@workout/contracts/planning';
import { activityReportValuesSchema } from '@workout/contracts/activity';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { Button } from '@workout/ui-foundation/button';
import type { BatchSelectionStore } from './batch-selection';
import {
  prepareActivityBatchLink,
  runActivityBatchLink,
  type PlanLink,
  type PreparedLink,
  type LinkPreviewResult,
  type BatchLinkResult,
} from './batch-link-command';
import styles from './activity-batch-link.module.css';
export interface ActivityBatchLinkProps {
  store: BatchSelectionStore;
  transport: AuthenticatedTransport;
  scope: string[];
  createId?: () => string;
}
export function ActivityBatchLink(props: ActivityBatchLinkProps) {
  return <Controller key={JSON.stringify(props.scope)} {...props} />;
}
const linkText = (link: PlanLink) =>
  link === null ? '연결 없음' : `계획 버전 ${link.planVersionId} · 세션 ${link.sessionId}`;
const previewLabels = {
  unchanged: '이미 같은 연결: 변경하지 않음',
  conflict: '수정 충돌: 최신 기록 확인 필요',
  unavailable: '기록 없음 또는 접근 불가',
  read_error: '기존 보고 조회 실패',
  reauth_required: '로그인 재확인 필요',
  not_attempted: '조회하지 않음',
};
const resultLabels = {
  applied: '계획 연결 변경 확인',
  conflict: '수정 충돌: 최신 기록 확인 필요',
  unavailable: '기록 없음 또는 접근 불가',
  invalid_link: '연결 대상 또는 입력 확인 필요',
  uncertain: '변경 결과 미확인',
  reauth_required: '로그인 재확인 필요',
  not_attempted: '실행하지 않음',
};
function Controller({
  store,
  transport,
  scope,
  createId = () => crypto.randomUUID(),
}: ActivityBatchLinkProps) {
  const targets = useStore(store, (state) => state.targets),
    locked = useStore(store, (state) => state.locked);
  const client = useQueryClient();
  const plans = useQuery({
    queryKey: [...scope, 'block-filter-plan'],
    queryFn: async ({ signal }) => {
      const reply = transportReplySchema.parse(
        await transport.request({
          path: '/bff/v1/plans/current',
          method: 'GET',
          body: null,
          idempotencyKey: null,
          signal,
        }),
      );
      if (signal.aborted || reply.status !== 200) throw new Error('PLAN_UNAVAILABLE');
      return planReadSchema.parse(reply.body);
    },
  });
  const [mode, setMode] = useState<'planlink' | 'unlink'>('planlink'),
    [chosen, setChosen] = useState<PlanLink>(null),
    [reason, setReason] = useState('');
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'preview' | 'pending' | 'result'>(
    'idle',
  );
  const [preview, setPreview] = useState<LinkPreviewResult[]>([]),
    [results, setResults] = useState<BatchLinkResult[]>([]);
  const [frozen, setFrozen] = useState<{ link: PlanLink; reason: string } | null>(null);
  const [error, setError] = useState(''),
    [cacheError, setCacheError] = useState(false);
  const active = useRef(true),
    request = useRef<AbortController | null>(null),
    focusBack = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null),
    heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      request.current?.abort();
    };
  }, []);
  useLayoutEffect(() => {
    if (phase === 'idle' && focusBack.current) {
      focusBack.current = false;
      if (trigger.current && !trigger.current.disabled) trigger.current.focus();
      else heading.current?.focus();
    }
  }, [phase]);
  const focusCancel = useCallback((node: HTMLButtonElement | null) => node?.focus(), []);
  const head = plans.isSuccess && !plans.isFetching ? plans.data.head : null;
  const currentChoice =
    chosen !== null &&
    head?.id === chosen.planVersionId &&
    head.draft.sessions.some((session) => session.id === chosen.sessionId);
  function close() {
    if (phase === 'pending') return;
    request.current?.abort();
    request.current = null;
    store.getState().setLocked(false);
    focusBack.current = true;
    setPhase('idle');
    setPreview([]);
    setResults([]);
    setFrozen(null);
  }
  async function prepare() {
    const state = store.getState();
    if (state.locked || !state.targets.length || request.current) return;
    const link = mode === 'unlink' ? null : chosen;
    if ((mode === 'planlink' && link === null) || !reason.trim() || reason.trim().length > 500) {
      setError(
        '계획 세션과 1–500자 정정 사유를 확인하세요. 연결 해제에는 계획이 필요하지 않습니다.',
      );
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    state.setLocked(true);
    setPhase('preparing');
    setError('');
    setCacheError(false);
    setFrozen({ link: link === null ? null : { ...link }, reason: reason.trim() });
    try {
      const prepared = await prepareActivityBatchLink({
        targets: state.targets.map((target) => ({ ...target })),
        link,
        reason: reason.trim(),
        transport,
        signal: controller.signal,
        createId,
      });
      if (!active.current || controller.signal.aborted || request.current !== controller) return;
      const rejected = prepared.filter(
        (item) => item.status === 'conflict' || item.status === 'unavailable',
      );
      store
        .getState()
        .remove(
          rejected
            .filter((item) =>
              store
                .getState()
                .targets.some(
                  (target) =>
                    target.id === item.target.id && target.revision === item.target.revision,
                ),
            )
            .map((item) => item.target.id),
        );
      setPreview(prepared);
      setPhase('preview');
    } catch {
      if (active.current && !controller.signal.aborted && request.current === controller) {
        setError('변경 전 기록을 확인하지 못했습니다. 취소 후 다시 조회하세요.');
        setPhase('preview');
      }
    } finally {
      if (request.current === controller) request.current = null;
    }
  }
  async function refresh(signal: AbortSignal) {
    try {
      await client.cancelQueries({ queryKey: scope });
      if (!active.current || signal.aborted) return;
      await client.resetQueries({ queryKey: scope }, { throwOnError: true });
    } catch {
      if (active.current && !signal.aborted) setCacheError(true);
    }
  }
  async function execute(prepared: PreparedLink[]) {
    if (!active.current || request.current || !prepared.length) return;
    const controller = new AbortController();
    request.current = controller;
    setPhase('pending');
    setCacheError(false);
    setError('');
    let changed = false;
    try {
      await runActivityBatchLink({
        prepared,
        transport,
        signal: controller.signal,
        onResult: (result) => {
          if (!active.current || controller.signal.aborted) return;
          setResults((previous) => [
            ...previous.filter((item) => item.prepared.target.id !== result.prepared.target.id),
            result,
          ]);
          if (
            result.status === 'applied' ||
            result.status === 'conflict' ||
            result.status === 'unavailable'
          ) {
            changed = true;
            const target = result.prepared.target;
            if (
              store
                .getState()
                .targets.some(
                  (current) => current.id === target.id && current.revision === target.revision,
                )
            )
              store.getState().remove([target.id]);
          }
        },
      });
      if (!active.current || controller.signal.aborted) return;
      if (changed) await refresh(controller.signal);
    } catch {
      if (active.current && !controller.signal.aborted)
        setError('실행 상태를 확인하지 못했습니다. 확인된 항목별 결과는 유지됩니다.');
    } finally {
      if (request.current === controller) request.current = null;
      if (active.current && !controller.signal.aborted) setPhase('result');
    }
  }
  const ready = preview.flatMap((item) => (item.status === 'ready' ? [item.prepared] : []));
  const auth =
    preview.some((item) => item.status === 'reauth_required') ||
    results.some((item) => item.status === 'reauth_required');
  const retries = results
    .filter((item) => item.status === 'uncertain')
    .map((item) => item.prepared);
  return (
    <section className={styles.panel} aria-label="선택 활동 일괄 계획 연결">
      <h3 ref={heading} tabIndex={-1}>
        선택 활동 일괄 계획 연결
      </h3>
      <p>
        현재 선택 {targets.length}개. 계획 연결은 실제 수행 기록을 새로 만들지 않으며 기존
        RPE·메모를 유지합니다.
      </p>
      {phase === 'idle' ? (
        <>
          <div className={styles.fields}>
            <label>
              일괄 계획 동작
              <select
                disabled={locked}
                value={mode}
                onChange={(event) =>
                  setMode(event.target.value === 'unlink' ? 'unlink' : 'planlink')
                }
              >
                <option value="planlink">계획 연결</option>
                <option value="unlink">연결 해제</option>
              </select>
            </label>
            {mode === 'planlink' ? (
              <>
                <label>
                  연결할 계획 세션
                  <select
                    disabled={locked || !head}
                    value={chosen ? JSON.stringify(chosen) : ''}
                    onChange={(event) => {
                      if (!event.target.value) {
                        setChosen(null);
                        return;
                      }
                      const parsed = activityReportValuesSchema.shape.planLink.safeParse(
                        JSON.parse(event.target.value),
                      );
                      if (parsed.success) setChosen(parsed.data);
                    }}
                  >
                    <option value="">세션 선택</option>
                    {chosen && !currentChoice ? (
                      <option value={JSON.stringify(chosen)}>
                        이전 선택 유지 · {linkText(chosen)}
                      </option>
                    ) : null}
                    {head?.draft.sessions.map((session) => (
                      <option
                        key={session.id}
                        value={JSON.stringify({ planVersionId: head.id, sessionId: session.id })}
                      >
                        {session.title} · {session.date} · {session.id}
                      </option>
                    ))}
                  </select>
                </label>
                <p>선택한 연결: {linkText(chosen)}</p>
                <Button
                  variant="secondary"
                  disabled={locked || plans.isFetching}
                  onClick={() => void plans.refetch()}
                >
                  일괄 연결 계획 다시 확인
                </Button>
                {plans.isFetching ? (
                  <p role="status">저장된 계획을 조회하고 있습니다.</p>
                ) : plans.isError ? (
                  <p>
                    저장된 계획을 조회하지 못했습니다. 이전 선택은 유지하며 연결 해제는 사용할 수
                    있습니다.
                  </p>
                ) : plans.isSuccess && !head ? (
                  <p>저장된 계획이 없습니다. 연결 해제는 사용할 수 있습니다.</p>
                ) : head && head.draft.sessions.length === 0 ? (
                  <p>저장된 계획에 선택할 세션이 없습니다.</p>
                ) : null}
              </>
            ) : null}
            <label>
              일괄 계획 연결 사유
              <textarea
                disabled={locked}
                maxLength={500}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
          </div>
          <div className={styles.actions}>
            <Button
              ref={trigger}
              variant="secondary"
              disabled={locked || !targets.length}
              onClick={() => void prepare()}
            >
              계획 연결 변경 미리보기
            </Button>
          </div>
          {locked ? (
            <p>
              다른 일괄 작업을 확인 중입니다. 그 작업을 닫으면 일괄 계획 동작을 시작할 수 있습니다.
            </p>
          ) : null}
        </>
      ) : (
        <div className={styles.preview} role="group" aria-label="일괄 계획 연결 확인">
          <p>
            변경할 연결: {linkText(frozen?.link ?? null)} · 사유: {frozen?.reason}
          </p>
          <p>
            확인한 활동·수정 번호·기존 보고 값을 고정했습니다. 항목별로 처리하므로 일부만 변경될 수
            있습니다. 미리보기 조회는 변경을 저장하지 않습니다.
          </p>
          {preview.some(
            (item) =>
              item.status === 'conflict' ||
              item.status === 'unavailable' ||
              item.status === 'read_error',
          ) ||
          results.some(
            (item) =>
              item.status === 'conflict' ||
              item.status === 'unavailable' ||
              item.status === 'invalid_link',
          ) ? (
            <p>
              충돌하거나 사용할 수 없는 활동은 선택에서 해제합니다. 취소 또는 결과 닫기 후 활동
              목록을 새로 조회하고, 변경된 활동은 기존 선택을 해제한 뒤 다시 선택하세요. 조회 실패
              항목도 취소 후 다시 미리보기로 확인하세요. 수정 번호는 자동으로 올리지 않습니다.
            </p>
          ) : null}
          {phase === 'preparing' ? (
            <p role="status">선택한 활동의 기존 보고를 조회하고 있습니다.</p>
          ) : null}
          <ul className={styles.targets}>
            {preview.map((item) => {
              const target = item.status === 'ready' ? item.prepared.target : item.target;
              return (
                <li key={target.id}>
                  {target.title} · 수정 번호 {target.revision} ·{' '}
                  {item.status === 'ready' ? (
                    <>
                      이전 연결: {linkText(item.prepared.previousLink)} → 새 연결:{' '}
                      {linkText(frozen?.link ?? null)}
                    </>
                  ) : (
                    previewLabels[item.status]
                  )}{' '}
                  · 활동 ID {target.id}
                </li>
              );
            })}
          </ul>
          {phase === 'preview' || phase === 'preparing' ? (
            <div className={styles.actions}>
              {phase === 'preview' ? (
                <Button
                  variant="secondary"
                  disabled={!ready.length || auth}
                  onClick={() => void execute(ready)}
                >
                  계획 연결 변경 확인
                </Button>
              ) : null}
              <Button ref={focusCancel} variant="secondary" onClick={close}>
                계획 연결 변경 취소
              </Button>
            </div>
          ) : null}
          {phase === 'pending' ? (
            <p role="status">확인한 계획 연결을 항목별로 반영하고 있습니다.</p>
          ) : null}
          {results.length ? (
            <section aria-label="일괄 계획 연결 결과">
              <h4>활동별 연결 결과</h4>
              <ul className={styles.targets}>
                {results.map((item) => (
                  <li key={item.prepared.target.id}>
                    {item.prepared.target.title} · 수정 번호 {item.prepared.target.revision} ·{' '}
                    {resultLabels[item.status]} · 이전 연결: {linkText(item.prepared.previousLink)}{' '}
                    → 새 연결: {linkText(item.prepared.command.report?.planLink ?? null)} · 활동 ID{' '}
                    {item.prepared.target.id}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {phase === 'result' ? (
            <>
              <p>
                결과를 닫아도 반영된 변경은 취소되지 않습니다. 미확인 대상의 재확인은 같은 수정
                번호·내용·요청 식별자로 수행합니다.
              </p>
              <div className={styles.actions}>
                {retries.length && !auth ? (
                  <Button variant="secondary" onClick={() => void execute(retries)}>
                    미확인 계획 연결 다시 확인
                  </Button>
                ) : null}
                <Button variant="secondary" onClick={close}>
                  계획 연결 결과 닫기
                </Button>
              </div>
            </>
          ) : null}
          {auth ? (
            <p role="alert">
              로그인을 다시 확인하세요. 남은 항목은 처리하지 않으며 여기서 재시도하지 않습니다.
            </p>
          ) : null}
        </div>
      )}
      {error ? <p role="alert">{error}</p> : null}
      {cacheError ? (
        <p role="status">
          변경 응답은 확인했지만 최신 목록 조회에 실패했습니다. 확인된 변경 결과는 유지됩니다.
        </p>
      ) : null}
    </section>
  );
}
