import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import type { PlanSnapshot } from '@workout/contracts/planning';
import {
  sessionCompletionCommandSchema,
  sessionCompletionDefinition,
  sessionCompletionReadSchema,
  sessionCompletionResultSchema,
  type SessionCompletion,
  type SessionCompletionCommand,
} from '@workout/contracts/session-completion';
import { Button } from '@workout/ui-foundation/button';
import styles from './session-completion-panel.module.css';

export interface SessionCompletionPanelProps {
  athleteId: string;
  sessionId: string;
  transport: AuthenticatedTransport;
  head: PlanSnapshot | null | undefined;
  plannedSessionId: string | null;
  createId: () => string;
  onCommitted: () => Promise<void>;
}
interface Prepared {
  command: SessionCompletionCommand;
  title: string;
  blockTitle: string;
  schedule: SessionCompletion['schedule'];
}
type Workflow =
  | { phase: 'idle' | 'refreshing' }
  | { phase: 'preview' | 'sending' | 'uncertain'; prepared: Prepared };
type Notice = { tone: 'status' | 'alert'; text: string } | null;

export function SessionCompletionPanel(props: SessionCompletionPanelProps) {
  if (props.plannedSessionId === null) return null;
  return (
    <CompletionForSelection
      key={JSON.stringify([props.athleteId, props.sessionId, props.plannedSessionId])}
      {...props}
      plannedSessionId={props.plannedSessionId}
    />
  );
}

function CompletionForSelection({
  athleteId,
  sessionId,
  transport,
  head,
  plannedSessionId,
  createId,
  onCommitted,
}: SessionCompletionPanelProps & { plannedSessionId: string }) {
  const target = head?.draft.sessions.find((session) => session.id === plannedSessionId);
  const path = `/bff/v1/plans/session-completion?${new URLSearchParams({ sessionId: plannedSessionId })}`;
  const read = useQuery({
    queryKey: [
      'planning-session-completion',
      athleteId,
      sessionId,
      plannedSessionId,
      head?.id ?? null,
    ],
    enabled: target !== undefined,
    retry: false,
    queryFn: async ({ signal }) => {
      const reply = transportReplySchema.parse(
        await transport.request({ path, method: 'GET', body: null, idempotencyKey: null, signal }),
      );
      if (reply.status !== 200) throw new Error('COMPLETION_READ_FAILED');
      const value = sessionCompletionReadSchema.parse(reply.body);
      if (value.sessionId !== plannedSessionId) throw new Error('COMPLETION_IDENTITY_MISMATCH');
      return value;
    },
  });
  const [reason, setReason] = useState('');
  const [workflow, setWorkflow] = useState<Workflow>({ phase: 'idle' });
  const [notice, setNotice] = useState<Notice>(null);
  const lifetime = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const cancel = useRef<HTMLButtonElement | null>(null);
  const returnFocus = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (workflow.phase === 'preview') cancel.current?.focus();
    if (workflow.phase === 'idle' && returnFocus.current) {
      returnFocus.current = false;
      opener.current?.focus();
    }
  }, [workflow.phase]);
  const current = read.isSuccess && !read.isFetching ? read.data : null;
  const ready = Boolean(head && target && current?.currentPlanVersionId === head.id);
  const report = current?.report ?? null;
  const frozen = 'prepared' in workflow ? workflow.prepared : null;
  const previewMatches =
    ready &&
    frozen !== null &&
    frozen.command.expectedPlanVersionId === head?.id &&
    frozen.command.expectedRevision === (report?.revision ?? null);

  async function refresh(controller: AbortController) {
    const results = await Promise.allSettled([
      read.refetch(),
      Promise.resolve().then(() => {
        if (!controller.signal.aborted) return onCommitted();
      }),
    ]);
    if (controller.signal.aborted) return false;
    return results.every(
      (result) =>
        result.status === 'fulfilled' && (result.value === undefined || !result.value.isError),
    );
  }
  async function refreshManually() {
    const controller = lifetime.current;
    if (!controller || busy.current || workflow.phase !== 'idle') return;
    busy.current = true;
    setWorkflow({ phase: 'refreshing' });
    try {
      const ok = await refresh(controller);
      if (!controller.signal.aborted) {
        setWorkflow({ phase: 'idle' });
        setNotice(
          ok
            ? null
            : {
                tone: 'alert',
                text: '최신 완료 기록이나 계획을 확인하지 못했습니다. 다시 확인해 주세요.',
              },
        );
      }
    } finally {
      busy.current = false;
    }
  }
  function prepare(action: SessionCompletionCommand['action'], button: HTMLButtonElement) {
    if (!ready || !head || !target || workflow.phase !== 'idle' || busy.current) return;
    const parsed = sessionCompletionCommandSchema.safeParse({
      action,
      confirmed: true,
      expectedPlanVersionId: head.id,
      expectedRevision: report?.revision ?? null,
      reason: reason.trim() || null,
      idempotencyKey: createId(),
    });
    if (!parsed.success) {
      setNotice({
        tone: 'alert',
        text: '철회·재확인에는 정정 사유가 필요합니다. 사유는 500자 이내로 입력해 주세요.',
      });
      return;
    }
    opener.current = button;
    setNotice(null);
    setWorkflow({
      phase: 'preview',
      prepared: {
        command: parsed.data,
        title: target.title,
        blockTitle:
          head.draft.periods.find((period) => period.id === target.blockId)?.title ??
          target.blockId,
        schedule: {
          blockId: target.blockId,
          date: target.date,
          localStartTime: target.localStartTime,
          timezone: head.draft.timezone,
        },
      },
    });
  }
  async function submit() {
    const controller = lifetime.current;
    if (
      !controller ||
      !frozen ||
      busy.current ||
      (workflow.phase !== 'uncertain' && (workflow.phase !== 'preview' || !previewMatches))
    )
      return;
    busy.current = true;
    const prepared = frozen;
    setWorkflow({ phase: 'sending', prepared });
    setNotice(null);
    try {
      const { idempotencyKey, ...body } = prepared.command;
      const response = transportReplySchema.parse(
        await transport.request({
          path,
          method: 'POST',
          body,
          idempotencyKey,
          signal: controller.signal,
        }),
      );
      if (controller.signal.aborted) return;
      if ([400, 401, 403, 404, 409].includes(response.status)) {
        setWorkflow({ phase: 'refreshing' });
        await refresh(controller);
        if (!controller.signal.aborted) {
          setWorkflow({ phase: 'idle' });
          setNotice({
            tone: 'alert',
            text:
              response.status === 409
                ? '계획 또는 완료 기록이 변경되었습니다. 사유는 유지했습니다. 최신 상태를 확인하고 새로 미리보기·확인해 주세요.'
                : '완료 요청이 거절되었습니다. 사유는 유지했습니다. 로그인·저장된 대상·입력 내용을 확인한 뒤 다시 준비해 주세요.',
          });
        }
        return;
      }
      if (response.status !== 200) throw new Error('COMPLETION_WRITE_UNRESOLVED');
      const receipt = sessionCompletionResultSchema.parse(response.body);
      if (
        receipt.report.sessionId !== plannedSessionId ||
        receipt.report.planVersionId !== prepared.command.expectedPlanVersionId ||
        receipt.report.revision !== (prepared.command.expectedRevision ?? 0) + 1 ||
        receipt.report.status !==
          (prepared.command.action === 'complete' ? 'completed' : 'retracted') ||
        receipt.report.reason !== prepared.command.reason ||
        Object.entries(prepared.schedule).some(
          ([key, value]) =>
            receipt.report.schedule[key as keyof typeof prepared.schedule] !== value,
        )
      )
        throw new Error('COMPLETION_RECEIPT_MISMATCH');
      setWorkflow({ phase: 'refreshing' });
      const refreshed = await refresh(controller);
      if (!controller.signal.aborted) {
        setWorkflow({ phase: 'idle' });
        setReason('');
        setNotice({
          tone: refreshed ? 'status' : 'alert',
          text: refreshed
            ? '완료 요청의 처리가 확인되었습니다. 현재 상태는 아래 최신 조회 기록을 확인하세요.'
            : '완료 요청의 처리는 확인했지만 최신 조회에 실패했습니다. 완료 기록을 다시 확인해 주세요.',
        });
      }
    } catch {
      if (!controller.signal.aborted) {
        setWorkflow({ phase: 'uncertain', prepared });
        setNotice({
          tone: 'alert',
          text: '요청 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인해 주세요. 새 완료 요청은 만들지 않습니다.',
        });
      }
    } finally {
      busy.current = false;
    }
  }
  return (
    <section aria-label="세션 완료 확인" className={styles.panel}>
      <h2>세션 완료 확인</h2>
      <p>{sessionCompletionDefinition.meaning}</p>
      <p>{sessionCompletionDefinition.timing}</p>
      <p>저장된 계획에만 보고합니다. 편집 중인 초안이나 실제 활동 값은 변경하지 않습니다.</p>
      {target && head ? (
        <p>
          저장 버전 {head.version} · {target.title} · {target.date} ·{' '}
          {head.draft.periods.find((period) => period.id === target.blockId)?.title ??
            target.blockId}{' '}
          · 시작 {target.localStartTime ?? '미정'} · {head.draft.timezone}
        </p>
      ) : (
        <p>
          {head === undefined
            ? '저장된 계획을 확인하고 있습니다.'
            : '저장된 계획에 이 세션이 없습니다. 새 세션은 저장 후 완료를 확인할 수 있습니다.'}
        </p>
      )}
      <Button
        variant="secondary"
        disabled={!target || workflow.phase !== 'idle' || read.isFetching}
        onClick={() => void refreshManually()}
      >
        완료 기록 다시 확인
      </Button>
      {read.isFetching ? (
        <p role="status">완료 기록을 확인하고 있습니다.</p>
      ) : read.isError ? (
        <p role="alert">완료 기록을 읽지 못했습니다. 이전 결과를 사용하지 않습니다.</p>
      ) : current ? (
        <>
          {!ready ? (
            <p role="alert">
              현재 저장 계획과 조회한 계획이 다릅니다. 최신 계획을 다시 확인해 주세요.
            </p>
          ) : null}
          <p>
            현재 보고:{' '}
            {report
              ? report.status === 'completed'
                ? '완료 확인됨'
                : '완료 확인 철회됨'
              : sessionCompletionDefinition.missing}
          </p>
          {report ? (
            <p>
              보고 수정 {report.revision} · 확인 시각{' '}
              <time dateTime={report.reportedAt}>{report.reportedAt}</time>
            </p>
          ) : null}
          <CompletionHistory history={current.history} total={current.totalHistory} />
        </>
      ) : null}
      <label className={styles.reason}>
        완료 보고 정정 사유
        <textarea
          value={reason}
          maxLength={500}
          disabled={workflow.phase !== 'idle'}
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      <p>첫 완료 확인의 사유는 선택이며 철회·재확인은 사유가 필요합니다.</p>
      <div className={styles.actions}>
        <Button
          disabled={!ready || workflow.phase !== 'idle' || report?.status === 'completed'}
          onClick={(event) => prepare('complete', event.currentTarget)}
        >
          완료 확인하기
        </Button>
        <Button
          variant="secondary"
          disabled={!ready || workflow.phase !== 'idle' || report?.status !== 'completed'}
          onClick={(event) => prepare('retract', event.currentTarget)}
        >
          완료 확인 철회
        </Button>
      </div>
      {frozen ? (
        <fieldset aria-label="완료 보고 확인">
          <legend>완료 보고 확인</legend>
          <p>
            {frozen.command.action === 'complete' ? '완료 확인' : '완료 확인 철회'} · {frozen.title}{' '}
            · {frozen.schedule.date} · {frozen.blockTitle} · 시작{' '}
            {frozen.schedule.localStartTime ?? '미정'} · {frozen.schedule.timezone}
          </p>
          <p>사유: {frozen.command.reason ?? '없음'}</p>
          {workflow.phase === 'preview' ? (
            <>
              {!previewMatches ? (
                <p role="alert">
                  미리보기 이후 조회 상태가 달라졌습니다. 취소 후 최신 상태에서 다시 준비해 주세요.
                </p>
              ) : null}
              <Button disabled={!previewMatches} onClick={() => void submit()}>
                확인하고 완료 기록
              </Button>
              <Button
                ref={cancel}
                variant="secondary"
                onClick={() => {
                  returnFocus.current = true;
                  setWorkflow({ phase: 'idle' });
                }}
              >
                취소
              </Button>
            </>
          ) : workflow.phase === 'uncertain' ? (
            <Button onClick={() => void submit()}>같은 완료 요청 다시 확인</Button>
          ) : (
            <p role="status">완료 요청의 결과를 확인하고 있습니다.</p>
          )}
        </fieldset>
      ) : null}
      {notice ? <p role={notice.tone}>{notice.text}</p> : null}
    </section>
  );
}

function CompletionHistory({ history, total }: { history: SessionCompletion[]; total: number }) {
  return (
    <section aria-label="완료 보고 이력">
      <h3>완료 보고 이력</h3>
      <p>
        전체 {total}건 중 최근 {history.length}건 (최대 100건)
      </p>
      <ol>
        {history.map((report) => (
          <li key={report.revision}>
            수정 {report.revision} ·{' '}
            {report.status === 'completed' ? '완료 확인' : '완료 확인 철회'} · 확인 시각{' '}
            <time dateTime={report.reportedAt}>{report.reportedAt}</time> · 일정{' '}
            {report.schedule.date} · 시작 {report.schedule.localStartTime ?? '미정'} ·{' '}
            {report.schedule.timezone} · 사유 {report.reason ?? '없음'}
          </li>
        ))}
      </ol>
    </section>
  );
}
