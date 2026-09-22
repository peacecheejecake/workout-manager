import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Activity } from '@workout/contracts/activity';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { activityDeletionImpactSchema } from '@workout/contracts/courses';
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
  /**
   * The courses this deletion would reclaim. The plan requires the confirmation to show
   * them, so the list is loaded before the user can confirm and its own failure is shown
   * as such — "we could not check" is not the same as "nothing is affected".
   */
  const [impact, setImpact] = useState<{
    activityId: string;
    outcome: 'unknown' | { digest: string; courses: { courseId: string; name: string }[] };
  } | null>(null);
  const [impactAttempt, setImpactAttempt] = useState(0);
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
  const activityId = command?.id ?? null;
  useEffect(() => {
    if (activityId === null) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const reply = transportReplySchema.parse(
          await transport.request({
            path: `/bff/v1/activities/${activityId}/deletion-impact`,
            method: 'GET',
            body: null,
            idempotencyKey: null,
            signal: controller.signal,
          }),
        );
        if (controller.signal.aborted) return;
        if (reply.status !== 200) {
          setImpact({ activityId, outcome: 'unknown' });
          return;
        }
        const parsed = activityDeletionImpactSchema.parse(reply.body);
        setImpact({
          activityId: parsed.activityId,
          outcome: {
            digest: parsed.digest,
            courses: parsed.courses.map((course) => ({
              courseId: course.courseId,
              name: course.name,
            })),
          },
        });
      } catch {
        if (!controller.signal.aborted) setImpact({ activityId, outcome: 'unknown' });
      }
    })();
    return () => controller.abort();
  }, [activityId, transport, impactAttempt]);
  async function remove(frozen: Command, confirmedImpact: string) {
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
          // The confirmed list travels with the command and is re-checked inside the
          // deletion transaction: the Activity revision alone cannot say whether the
          // courses the user saw are still the courses this deletion would reclaim.
          body: { expectedRevision: frozen.revision, expectedCourseImpact: confirmedImpact },
          idempotencyKey: null,
          signal: controller.signal,
        }),
      );
      if (!active.current || controller.signal.aborted) return;
      if (result.status === 409 && impactChanged(result.body)) {
        // Not a revision conflict: the affected-course list moved. The list is refreshed
        // and the user confirms again against what would really be reclaimed.
        setPhase('ready');
        setImpact(null);
        setImpactAttempt((attempt) => attempt + 1);
        setMessage(
          '이 기록에서 만든 코스 목록이 바뀌었습니다. 아래 목록을 다시 확인한 뒤 삭제를 확인하세요.',
        );
        return;
      }
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
  const confirmedImpact =
    command !== null && impact !== null && impact.activityId === command.id ? impact.outcome : null;
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
          <DeletionImpact
            outcome={confirmedImpact}
            onRetry={() => {
              setImpact(null);
              setImpactAttempt((attempt) => attempt + 1);
            }}
          />
          <div className={styles.actions}>
            {phase === 'pending' ? (
              <p role="status">로컬 삭제 결과를 확인하고 있습니다.</p>
            ) : (
              <Button
                variant="danger"
                // Deletion waits for the affected-course list. A pending or failed check is
                // not "no courses are affected", so it cannot be confirmed through.
                disabled={confirmedImpact === null || confirmedImpact === 'unknown'}
                onClick={() => {
                  if (confirmedImpact === null || confirmedImpact === 'unknown') return;
                  void remove(command, confirmedImpact.digest);
                }}
              >
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

function impactChanged(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof body.error === 'object' &&
    body.error !== null &&
    'code' in body.error &&
    body.error.code === 'COURSE_IMPACT_CHANGED'
  );
}

/**
 * The courses an activity deletion would reclaim.
 *
 * `null` is "not answered yet", and a failed check is said out loud: an unchecked list is
 * not evidence that nothing is affected.
 */
function DeletionImpact({
  outcome,
  onRetry,
}: {
  outcome: 'unknown' | { digest: string; courses: { courseId: string; name: string }[] } | null;
  onRetry: () => void;
}) {
  return (
    <section aria-label="삭제 영향 코스">
      {outcome === null ? (
        <p role="status">이 기록에서 만든 코스를 확인하고 있습니다.</p>
      ) : outcome === 'unknown' ? (
        <>
          <p role="alert">
            이 기록에서 만든 코스를 확인하지 못했습니다. 확인하기 전에는 삭제할 수 없습니다.
          </p>
          <Button variant="secondary" onClick={onRetry}>
            영향 코스 다시 확인
          </Button>
        </>
      ) : outcome.courses.length > 0 ? (
        <>
          <p>
            이 기록의 좌표에서 만든 코스 {outcome.courses.length}개도 함께 회수되어 사용할 수 없게
            됩니다. 독립 편집본과 복사본도 같은 출처를 유지하므로 포함됩니다.
          </p>
          <ul>
            {outcome.courses.map((course) => (
              <li key={course.courseId}>{course.name}</li>
            ))}
          </ul>
        </>
      ) : (
        <p>이 기록에서 만든 코스는 없습니다.</p>
      )}
    </section>
  );
}
