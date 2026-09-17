import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useQueryClient } from '@tanstack/react-query';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import { Button } from '@workout/ui-foundation/button';
import type { BatchSelectionStore, BatchTarget } from './batch-selection';
import { runActivityBatchDelete, type BatchResult } from './batch-delete-command';
import styles from './activity-batch-delete.module.css';

export interface ActivityBatchDeleteProps {
  store: BatchSelectionStore;
  transport: AuthenticatedTransport;
  scope: string[];
  onDeleted(ids: string[]): void;
}
export function ActivityBatchDelete(props: ActivityBatchDeleteProps) {
  return <Controller key={JSON.stringify(props.scope)} {...props} />;
}
const statusLabels = {
  deleted: '로컬 삭제 확인',
  conflict: '수정 충돌: 최신 기록 확인 필요',
  unavailable: '기록 없음 또는 접근 불가',
  uncertain: '삭제 결과 미확인',
  not_attempted: '실행하지 않음',
  reauth_required: '로그인 재확인 필요',
};
function Controller({ store, transport, scope, onDeleted }: ActivityBatchDeleteProps) {
  const targets = useStore(store, (state) => state.targets);
  const locked = useStore(store, (state) => state.locked);
  const exceeded = useStore(store, (state) => state.limitExceeded);
  const client = useQueryClient();
  const [frozen, setFrozen] = useState<BatchTarget[] | null>(null);
  const [phase, setPhase] = useState<'preview' | 'pending' | 'result'>('preview');
  const [results, setResults] = useState<BatchResult[]>([]);
  const [cacheError, setCacheError] = useState(false);
  const [requestError, setRequestError] = useState(false);
  const active = useRef(true);
  const request = useRef<AbortController | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef(false);
  const callbacks = useRef({ onDeleted });
  useLayoutEffect(() => {
    callbacks.current = { onDeleted };
  }, [onDeleted]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      request.current?.abort();
    };
  }, []);
  useLayoutEffect(() => {
    if (frozen === null && returnFocus.current) {
      returnFocus.current = false;
      if (trigger.current && !trigger.current.disabled) trigger.current.focus();
      else heading.current?.focus();
    }
  }, [frozen]);
  const focusCancel = useCallback((node: HTMLButtonElement | null) => {
    node?.focus();
  }, []);
  function open() {
    const current = store.getState();
    if (request.current || current.locked || !current.targets.length) return;
    setFrozen(current.targets.map((target) => ({ ...target })));
    current.setLocked(true);
    setResults([]);
    setCacheError(false);
    setRequestError(false);
    setPhase('preview');
  }
  function close() {
    if (request.current) return;
    store.getState().setLocked(false);
    returnFocus.current = true;
    setFrozen(null);
    setResults([]);
  }
  async function execute(command: BatchTarget[]) {
    if (!active.current || request.current || !command.length) return;
    const controller = new AbortController();
    request.current = controller;
    setPhase('pending');
    setRequestError(false);
    setCacheError(false);
    const received: BatchResult[] = [];
    try {
      await runActivityBatchDelete({
        targets: command,
        transport,
        signal: controller.signal,
        onResult: (result) => {
          if (!active.current || controller.signal.aborted) return;
          received.push(result);
          if (result.status === 'deleted') {
            if (
              store
                .getState()
                .targets.some(
                  (target) =>
                    target.id === result.target.id && target.revision === result.target.revision,
                )
            )
              store.getState().remove([result.target.id]);
            callbacks.current.onDeleted([result.target.id]);
          }
          setResults((previous) => [
            ...previous.filter((item) => item.target.id !== result.target.id),
            result,
          ]);
        },
      });
      if (!active.current || controller.signal.aborted) return;
      const resolved = received.filter(
        (result) =>
          result.status === 'deleted' ||
          result.status === 'conflict' ||
          result.status === 'unavailable',
      );
      const removable = resolved
        .filter((result) =>
          store
            .getState()
            .targets.some(
              (target) =>
                target.id === result.target.id && target.revision === result.target.revision,
            ),
        )
        .map((result) => result.target.id);
      store.getState().remove(removable);
      // Receipt status is final independently from subsequent cache refresh.
      if (resolved.length) {
        try {
          await client.cancelQueries({ queryKey: scope });
        } catch {
          if (active.current && !controller.signal.aborted) setCacheError(true);
        }
        if (!active.current || controller.signal.aborted) return;
        try {
          await client.resetQueries({ queryKey: scope }, { throwOnError: true });
        } catch {
          if (active.current && !controller.signal.aborted) setCacheError(true);
        }
      }
    } catch {
      if (active.current && !controller.signal.aborted) setRequestError(true);
    } finally {
      if (request.current === controller) request.current = null;
      if (active.current && !controller.signal.aborted) setPhase('result');
    }
  }
  const retry = results
    .filter((result) => result.status === 'uncertain')
    .map((result) => result.target);
  const authRequired = results.some((result) => result.status === 'reauth_required');
  return (
    <section className={styles.panel} aria-label="선택 활동 일괄 로컬 삭제">
      <h3 ref={heading} tabIndex={-1}>
        선택 활동 일괄 로컬 삭제
      </h3>
      <p>현재 선택 {targets.length}개 · 필터와 페이지 밖의 선택도 포함합니다. 최대 100개입니다.</p>
      {exceeded ? (
        <p role="alert">선택은 최대 100개입니다. 일부를 해제한 뒤 다시 선택하세요.</p>
      ) : null}
      {!frozen ? (
        <Button ref={trigger} variant="danger" disabled={locked || !targets.length} onClick={open}>
          선택 활동 삭제 미리보기
        </Button>
      ) : (
        <div className={styles.preview} role="group" aria-label="일괄 로컬 삭제 확인">
          <h4>확인 대상 {frozen.length}개</h4>
          <p>
            아래 목록과 수정 번호를 고정했습니다. 결과를 닫을 때까지 목록 선택은 잠깁니다. 항목별로
            처리하므로 일부만 삭제될 수 있습니다.
          </p>
          <p>
            이 앱에서 활동을 숨기고 같은 출처의 재수집을 막습니다. 제공자 원본은 삭제하지 않습니다.
            원본과 변경 이력은 보관되며 전체 계정 데이터 삭제와 다릅니다.
          </p>
          <ul className={styles.targets}>
            {frozen.map((target) => (
              <li key={target.id}>
                {target.title} · 출처{' '}
                {{ fit: 'FIT', fixture: '테스트 자료', manual: '수동 기록' }[target.sourceKind]} ·
                확인한 수정 번호 {target.revision} · 활동 ID {target.id}
              </li>
            ))}
          </ul>
          {phase === 'preview' ? (
            <div className={styles.actions}>
              <Button variant="danger" onClick={() => void execute(frozen)}>
                선택 활동 삭제 확인
              </Button>
              <Button ref={focusCancel} variant="secondary" onClick={close}>
                일괄 삭제 취소
              </Button>
            </div>
          ) : null}
          {phase === 'pending' ? (
            <p role="status">확인한 활동을 순서대로 삭제하고 있습니다. 결과를 기다려 주세요.</p>
          ) : null}
          {results.length ? (
            <section aria-label="일괄 삭제 결과">
              <h4>활동별 삭제 결과</h4>
              <ul className={styles.targets}>
                {results.map((result) => (
                  <li key={result.target.id}>
                    {result.target.title} · 수정 번호 {result.target.revision} ·{' '}
                    {statusLabels[result.status]} · 활동 ID {result.target.id}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {cacheError ? (
            <p role="status">
              삭제 응답은 확인했지만 목록을 새로 조회하지 못했습니다. 확인된 삭제 결과는 유지됩니다.
              목록을 다시 조회하세요.
            </p>
          ) : null}
          {requestError ? (
            <p role="alert">
              실행 상태를 확인하지 못했습니다. 표시된 결과를 검토한 뒤 목록을 다시 조회하세요.
            </p>
          ) : null}
          {results.some(
            (result) => result.status === 'conflict' || result.status === 'unavailable',
          ) ? (
            <p>
              변경되었거나 사용할 수 없는 대상은 선택에서 해제했습니다. 최신 기록을 확인하고 다시
              선택하세요.
            </p>
          ) : null}
          {authRequired ? (
            <p role="alert">
              로그인을 다시 확인해야 합니다. 남은 대상은 실행하지 않았으며 여기서 재시도하지
              않습니다.
            </p>
          ) : null}
          {phase === 'result' ? (
            <>
              <p>
                결과를 닫아도 이미 처리된 삭제는 취소되지 않습니다. 미확인 대상은 삭제되었을 수도
                있으며 같은 수정 번호의 선택을 유지합니다.
              </p>
              <div className={styles.actions}>
                {retry.length && !authRequired ? (
                  <Button variant="danger" onClick={() => void execute(retry)}>
                    미확인 활동 삭제 다시 확인
                  </Button>
                ) : null}
                <Button variant="secondary" onClick={close}>
                  결과 닫기
                </Button>
              </div>
            </>
          ) : null}
        </div>
      )}
    </section>
  );
}
