import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Activity } from '@workout/contracts/activity';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { Button } from '@workout/ui-foundation/button';
import styles from './activity-browser.module.css';
interface Command {
  id: string;
  revision: number;
  title: string;
  source: string;
}
export function ActivityDelete({
  current,
  selected,
  transport,
  scope,
  onDeleted,
}: {
  current: Activity | null;
  selected: string | null;
  transport: AuthenticatedTransport;
  scope: string[];
  onDeleted(id: string): void;
}) {
  const client = useQueryClient();
  const [command, setCommand] = useState<Command | null>(null);
  const [phase, setPhase] = useState<'ready' | 'pending' | 'uncertain'>('ready');
  const [message, setMessage] = useState('');
  const [blocked, setBlocked] = useState<Command | null>(null);
  const active = useRef(true);
  const request = useRef<AbortController | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
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
  const matches =
    command !== null &&
    current?.id === command.id &&
    current.revision === command.revision &&
    selected === command.id;
  if (phase === 'ready' && command && !matches) setCommand(null);
  const focusCancel = useCallback((node: HTMLButtonElement | null) => {
    node?.focus();
  }, []);
  async function remove(frozen: Command) {
    if (!active.current || request.current || (phase === 'ready' && !matches)) return;
    const controller = new AbortController();
    request.current = controller;
    setPhase('pending');
    setMessage('');
    try {
      const result = transportReplySchema.parse(
        await transport.request({
          path: `/bff/v1/activities/${frozen.id}`,
          method: 'DELETE',
          body: { expectedRevision: frozen.revision },
          idempotencyKey: null,
          signal: controller.signal,
        }),
      );
      if (!active.current || controller.signal.aborted) return;
      if (result.status === 409 || result.status === 404) {
        setBlocked(frozen);
        setCommand(null);
        setPhase('ready');
        setMessage(
          result.status === 409
            ? '활동이 변경되었습니다. 최신 기록을 확인한 뒤 삭제를 다시 확인하세요.'
            : '기록이 삭제되었거나 접근할 수 없습니다.',
        );
        await client.cancelQueries({ queryKey: [...scope, 'detail', frozen.id] });
        if (active.current && !controller.signal.aborted)
          await client.resetQueries({ queryKey: [...scope, 'detail', frozen.id] });
        return;
      }
      if (result.status !== 204) throw new Error('DELETE_UNCONFIRMED');
      await client.cancelQueries({ queryKey: scope });
      if (!active.current || controller.signal.aborted) return;
      callbacks.current.onDeleted(frozen.id);
      setCommand(null);
      setPhase('ready');
      setMessage(`로컬 삭제가 확인되었습니다: ${frozen.title}`);
      await client.resetQueries({ queryKey: scope });
    } catch {
      if (active.current && !controller.signal.aborted) {
        setPhase('uncertain');
        setMessage('삭제 결과를 확인하지 못했습니다. 같은 기록과 수정 번호로 다시 확인하세요.');
      }
    } finally {
      if (request.current === controller) request.current = null;
    }
  }
  return (
    <section aria-label="활동 로컬 삭제">
      {message ? <p role="status">{message}</p> : null}
      {current && phase === 'ready' && !command ? (
        <Button
          ref={trigger}
          disabled={blocked?.id === current.id && blocked.revision === current.revision}
          variant="danger"
          onClick={() => {
            setMessage('');
            setCommand({
              id: current.id,
              revision: current.revision,
              title: current.effective.title ?? '제목 미확인',
              source:
                current.source.kind === 'manual'
                  ? '수동 기록'
                  : current.source.kind === 'fit'
                    ? 'FIT'
                    : '테스트 자료',
            });
          }}
        >
          이 활동 로컬 삭제
        </Button>
      ) : null}
      {command && (phase !== 'ready' || matches) ? (
        <div role="group" aria-label="로컬 삭제 확인">
          <p>
            삭제 대상: {command.title} · 출처 {command.source} · 확인한 수정 번호 {command.revision}
          </p>
          <p>
            이 앱에서 활동을 숨기고 같은 출처의 재수집을 막습니다. 제공자 원본은 삭제하지 않습니다.
            원본과 변경 이력은 보관되며 전체 계정 데이터 삭제와 다릅니다.
          </p>
          <div className={styles.actions}>
            {phase === 'pending' ? (
              <p role="status">로컬 삭제 결과를 확인하고 있습니다.</p>
            ) : (
              <Button variant="danger" onClick={() => void remove(command)}>
                {phase === 'uncertain' ? '같은 활동 삭제 다시 확인' : '이 활동 삭제 확인'}
              </Button>
            )}
            {phase === 'ready' ? (
              <Button
                variant="secondary"
                ref={focusCancel}
                onClick={() => {
                  setCommand(null);
                  requestAnimationFrame(() => trigger.current?.focus());
                }}
              >
                로컬 삭제 취소
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
