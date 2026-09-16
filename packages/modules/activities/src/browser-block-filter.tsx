import { useState } from 'react';
import { activityListQuerySchema } from '@workout/contracts/activity';
import { useQuery } from '@tanstack/react-query';
import { planReadSchema } from '@workout/contracts/planning';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { Button } from '@workout/ui-foundation/button';
import { updateActivitySearch } from './browser-search';
import styles from './activity-browser.module.css';
export function BrowserBlockFilter({
  transport,
  scope,
  search,
  onSearchChange,
}: {
  transport: AuthenticatedTransport;
  scope: string[];
  search: string;
  onSearchChange(query: string): void;
}) {
  const [selectionError, setSelectionError] = useState(false);
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
  const params = new URLSearchParams(search);
  const version = params.get('linkedPlanVersionId');
  const block = params.get('linkedBlockId');
  const selected = version !== null || block !== null ? JSON.stringify([version, block]) : '';
  const head = plans.isSuccess && !plans.isFetching ? plans.data.head : null;
  const blocks = head?.draft.periods.filter((period) => period.level === 'block') ?? [];
  const known =
    head &&
    version?.toLowerCase() === head.id.toLowerCase() &&
    blocks.some((period) => period.id === block);
  function clear() {
    setSelectionError(false);
    onSearchChange(
      updateActivitySearch(search, {
        linkedPlanVersionId: null,
        linkedBlockId: null,
        offset: null,
      }),
    );
  }
  return (
    <section aria-label="명시적 계획 Block 연결 필터">
      <h3>계획 Block 연결 필터</h3>
      <p>
        저장된 계획 연결이 이 Block의 세션을 가리키는 활동만 조회합니다. 날짜가 같다는 이유로
        연결하지 않습니다. 날짜 조건을 함께 적용하면 두 조건을 모두 충족해야 합니다.
      </p>
      {selected ? (
        <p>
          적용 중인 연결 조건: 계획 버전 {version ?? '누락'} · Block {block ?? '누락'}
          {known ? ' · 현재 계획' : ' · 현재 선택 목록에서 확인되지 않는 저장 조건'}
        </p>
      ) : (
        <p>계획 연결 조건 없음</p>
      )}
      <div className={styles.filters}>
        <label>
          연결된 계획 Block
          <select
            value={known && head ? JSON.stringify([head.id, block]) : selected}
            onChange={(event) => {
              if (!event.target.value) {
                clear();
                return;
              }
              const chosen = blocks.find(
                (period) => JSON.stringify([head?.id, period.id]) === event.target.value,
              );
              if (chosen && head) {
                if (
                  !activityListQuerySchema.safeParse({
                    linkedPlanVersionId: head.id,
                    linkedBlockId: chosen.id,
                  }).success
                ) {
                  setSelectionError(true);
                  return;
                }
                setSelectionError(false);
                onSearchChange(
                  updateActivitySearch(search, {
                    linkedPlanVersionId: head.id,
                    linkedBlockId: chosen.id,
                    offset: null,
                  }),
                );
              }
            }}
          >
            <option value="">모든 계획 연결</option>
            {selected && !known ? (
              <option value={selected}>
                기존 조건 유지 · {version ?? '버전 누락'} · {block ?? 'Block 누락'}
              </option>
            ) : null}
            {blocks.map((period) => (
              <option key={period.id} value={JSON.stringify([head?.id, period.id])}>
                {period.title} · {period.startDate} ~ {period.endDateExclusive}
              </option>
            ))}
          </select>
        </label>
        <Button variant="secondary" onClick={clear}>
          계획 Block 조건 지우기
        </Button>
      </div>
      {selectionError ? (
        <p role="alert">이 계획의 연결 식별자를 사용할 수 없습니다. 현재 계획을 다시 확인하세요.</p>
      ) : null}
      {plans.isFetching ? <p role="status">선택 가능한 현재 계획을 확인하고 있습니다.</p> : null}
      {plans.isError ? (
        <p role="alert">
          현재 계획 선택 목록을 불러오지 못했습니다. 기존 연결 조건과 활동 조회는 유지됩니다.{' '}
          <Button onClick={() => void plans.refetch()}>계획 선택 목록 다시 확인</Button>
        </p>
      ) : null}
      {plans.isSuccess && !plans.isFetching && blocks.length === 0 ? (
        <p>선택 가능한 현재 Block이 없습니다. 기존 연결 조건은 자동으로 바꾸지 않습니다.</p>
      ) : null}
    </section>
  );
}
