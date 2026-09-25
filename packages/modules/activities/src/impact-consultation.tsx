import { useQuery } from '@tanstack/react-query';
import type { ActivityContext } from '@workout/contracts/activity-context';
import { coachingThreadListSchema } from '@workout/contracts/coaching-threads';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import { consultationItems, consultationRuleVersion } from './impact-split';

/**
 * Where the shell's coach screen (S10) opens: an existing consultation thread, or a new
 * review of one Block of a plan version. Opening it changes nothing; a plan changes only
 * when the user approves a proposal there.
 */
export type CoachingLink =
  | { kind: 'thread'; threadId: string }
  | { kind: 'review'; planVersionId: string; scopeKind: 'block'; targetId: string };

const threadPage = 100;

function RelatedThreads({
  context,
  transport,
  scope,
  coachingHref,
}: {
  context: ActivityContext;
  transport: AuthenticatedTransport;
  scope: ReadonlyArray<string>;
  coachingHref: ((link: CoachingLink) => string) | undefined;
}) {
  const planContext = context.planContext;
  // Read only. The coach's own thread list is the source; this screen never creates one.
  // Threads are created on the coach screen, whose query cache is its own, so nothing there
  // can invalidate this list. It is read again whenever the tab mounts and whenever the page
  // becomes visible again (back from the coach screen, another tab or the back/forward
  // cache), whatever the enclosing client's default freshness is.
  const threads = useQuery({
    queryKey: [...scope, 'impact-related-threads'],
    enabled: planContext.status === 'linked',
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    queryFn: async ({ signal }) => {
      const response = await transport.request({
        path: `/bff/v1/coaching-threads?${new URLSearchParams({ limit: String(threadPage), offset: '0' })}`,
        method: 'GET',
        body: null,
        idempotencyKey: null,
        signal,
      });
      if (signal.aborted) throw new Error('CANCELLED');
      if (response.status !== 200) throw new Error('THREADS_UNAVAILABLE');
      return coachingThreadListSchema.parse(response.body);
    },
  });
  if (planContext.status === 'unlinked')
    return <p>연결한 계획이 없어 관련 상담을 찾지 않습니다.</p>;
  if (planContext.status === 'unavailable')
    return (
      <p>
        {planContext.reason === 'unsupported_calendar'
          ? '기록 또는 연결 계획에 지원 범위를 벗어난 날짜가 있어 관련 상담을 찾지 않습니다.'
          : '저장된 계획 연결을 확인할 수 없어 관련 상담을 찾지 않습니다.'}
      </p>
    );
  const plan = planContext;
  if (threads.isPending) return <p role="status">관련 상담 기록을 확인하고 있습니다.</p>;
  if (threads.isError) return <p role="alert">관련 상담 기록을 확인하지 못했습니다.</p>;
  const planVersionId = plan.planVersion.id.toLowerCase();
  const related = threads.data.items.filter(
    (thread) =>
      thread.planVersionId === planVersionId &&
      ((thread.scope.kind === 'block' && thread.scope.targetId === plan.block.id) ||
        (thread.scope.kind === 'session' && thread.scope.targetId === plan.session.id)),
  );
  return (
    <>
      {threads.data.total > threads.data.items.length ? (
        <p>
          최근 상담 {threads.data.items.length}개만 확인했습니다. 더 오래된 상담은 코치 화면에서
          확인하세요.
        </p>
      ) : null}
      {related.length === 0 ? (
        <p>이 Block이나 세션을 대상으로 한 상담 기록이 없습니다.</p>
      ) : (
        <ul aria-label="관련 상담 기록">
          {related.map((thread) => (
            <li key={thread.id}>
              {coachingHref ? (
                <a href={coachingHref({ kind: 'thread', threadId: thread.id })}>{thread.title}</a>
              ) : (
                thread.title
              )}{' '}
              · {thread.scope.kind === 'block' ? 'Block' : '세션'} 검토
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function ImpactConsultationSection({
  context,
  transport,
  scope,
  coachingHref,
}: {
  context: ActivityContext;
  transport: AuthenticatedTransport;
  scope: ReadonlyArray<string>;
  coachingHref?: (link: CoachingLink) => string;
}) {
  const plan = context.planContext;
  return (
    <section aria-label="상담">
      <h3>상담</h3>
      <p>
        출처: 관측·계산 절의 값에서 고정 규칙({consultationRuleVersion})으로 고른 검토 항목과 코치
        상담 기록입니다. 제안일 뿐이며 계획을 바꾸지 않습니다. 계획은 코치 화면에서 만든 제안을
        사용자가 명시적으로 승인할 때만 바뀝니다.
      </p>
      <h4>향후 계획에서 검토할 항목</h4>
      <ul aria-label="향후 계획에서 검토할 항목">
        {consultationItems(context).map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <h4>관련 제안</h4>
      {plan.status === 'linked' && coachingHref ? (
        plan.currentPlanVersionId === plan.planVersion.id ? (
          <p>
            <a
              href={coachingHref({
                kind: 'review',
                planVersionId: plan.planVersion.id,
                scopeKind: 'block',
                targetId: plan.block.id,
              })}
            >
              코치에서 연결 Block 검토 열기
            </a>{' '}
            (열기만으로는 계획이 바뀌지 않습니다)
          </p>
        ) : (
          <p>과거 계획 버전의 Block이라 코치 검토로 바로 연결하지 않습니다.</p>
        )
      ) : null}
      <RelatedThreads
        context={context}
        transport={transport}
        scope={scope}
        coachingHref={coachingHref}
      />
    </section>
  );
}
