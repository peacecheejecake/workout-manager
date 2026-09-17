import { useQueries } from '@tanstack/react-query';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import {
  planScenarioSchema,
  type PlanScenario,
  type PlanScenarioList,
} from '@workout/contracts/plan-scenarios';
import type { PlanDraft } from '@workout/contracts/planning';
import { Button } from '@workout/ui-foundation/button';
import { comparePlanHistory } from './plan-history-comparison';
import { PlanSummary } from './plan-summary';
import { readScenarioResource } from './scenario-commands';
const revision = planScenarioSchema.shape.revision;
export function ScenarioComparison({
  scenario,
  transport,
  scope,
  search,
  onChange,
  alternatives,
}: {
  scenario: PlanScenario;
  alternatives: PlanScenarioList['items'];
  transport: AuthenticatedTransport;
  scope: string[];
  search: string;
  onChange: (values: Record<string, string | null>) => void;
}) {
  const params = new URLSearchParams(search);
  const before = revision.safeParse(Number(params.get('scenarioCompareFrom')));
  const after = revision.safeParse(Number(params.get('scenarioCompareTo')));
  const requested = params.has('scenarioCompareFrom') || params.has('scenarioCompareTo');
  const beforeId = planScenarioSchema.shape.id.safeParse(
    params.get('scenarioCompareFromId') ?? scenario.id,
  );
  const afterId = planScenarioSchema.shape.id.safeParse(
    params.get('scenarioCompareToId') ?? scenario.id,
  );
  const choices = [
    ...new Map(
      [{ ...scenario, title: scenario.draft.title }, ...alternatives].map((item) => [
        item.id,
        item,
      ]),
    ).values(),
  ];
  const selections = [
    { parsed: before, id: beforeId },
    { parsed: after, id: afterId },
  ].map((item) => ({
    ...item,
    key: JSON.stringify([
      item.id.success ? item.id.data : null,
      item.parsed.success ? item.parsed.data : null,
    ]),
  }));
  const unique = [...new Map(selections.map((item) => [item.key, item])).values()];
  const queries = useQueries({
    queries: unique.map(({ parsed, id }) => ({
      queryKey: [
        ...scope,
        'revision',
        id.success ? id.data : null,
        parsed.success ? parsed.data : null,
      ],
      enabled: requested && parsed.success && id.success,
      retry: false,
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        if (!parsed.success || !id.success) throw new Error('INVALID_REVISION');
        const result = await readScenarioResource(
          transport,
          `/bff/v1/plan-scenarios/${id.data}/revisions/${parsed.data}`,
          planScenarioSchema,
          signal,
        );
        if (
          result.id !== id.data ||
          result.revision !== parsed.data ||
          result.basePlanVersionId !== scenario.basePlanVersionId
        )
          throw new Error('REVISION_MISMATCH');
        return result;
      },
    })),
  });
  const left = queries[unique.findIndex((item) => item.key === selections[0]?.key)],
    right = queries[unique.findIndex((item) => item.key === selections[1]?.key)];
  const ready = left?.isSuccess && !left.isFetching && right?.isSuccess && !right.isFetching;
  const wrap = (value: PlanScenario) => ({
    id: value.id,
    version: value.revision,
    createdAt: value.createdAt,
    draft: value.draft,
  });
  // Adapt immutable draft containers only. Scenario revisions are never presented as plan versions.
  const comparison = ready
    ? comparePlanHistory(wrap(left.data), wrap(right.data), params.get('scenarioPeriod'))
    : null;
  const scoped = (side: 'before' | 'after', draft: PlanDraft): PlanDraft =>
    comparison
      ? {
          ...draft,
          periods: comparison.periods.flatMap((row) =>
            row[side] && row[`${side}InScope`] ? [row[side]] : [],
          ),
          sessions: comparison.sessions.flatMap((row) =>
            row[side] && row[`${side}InScope`] ? [row[side]] : [],
          ),
        }
      : draft;
  const status = { added: '추가', removed: '삭제', changed: '변경', unchanged: '동일' };
  return (
    <section aria-label="시나리오 수정 비교">
      <h3>시나리오 {scenario.label} 수정 비교</h3>
      <form
        key={`${scenario.id}:${params.get('scenarioCompareFromId')}:${params.get('scenarioCompareToId')}:${params.get('scenarioCompareFrom')}:${params.get('scenarioCompareTo')}`}
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          onChange({
            scenarioCompareFromId: String(data.get('fromId') ?? ''),
            scenarioCompareToId: String(data.get('toId') ?? ''),
            scenarioCompareFrom: String(data.get('from') ?? ''),
            scenarioCompareTo: String(data.get('to') ?? ''),
          });
        }}
      >
        <label>
          이전 비교 시나리오
          <select name="fromId" defaultValue={beforeId.success ? beforeId.data : scenario.id}>
            {choices.map((item) => (
              <option key={item.id} value={item.id}>
                시나리오 {item.label} · 최신 수정 {item.revision}
              </option>
            ))}
          </select>
        </label>
        <label>
          이후 비교 시나리오
          <select name="toId" defaultValue={afterId.success ? afterId.data : scenario.id}>
            {choices.map((item) => (
              <option key={item.id} value={item.id}>
                시나리오 {item.label} · 최신 수정 {item.revision}
              </option>
            ))}
          </select>
        </label>
        <label>
          이전 시나리오 수정 번호
          <input
            name="from"
            type="number"
            min="1"
            max={2147483646}
            defaultValue={params.get('scenarioCompareFrom') ?? Math.max(1, scenario.revision - 1)}
          />
        </label>
        <label>
          이후 시나리오 수정 번호
          <input
            name="to"
            type="number"
            min="1"
            max={2147483646}
            defaultValue={params.get('scenarioCompareTo') ?? scenario.revision}
          />
        </label>
        <Button variant="secondary" type="submit">
          시나리오 수정 비교하기
        </Button>
      </form>
      {requested && (!before.success || !after.success || !beforeId.success || !afterId.success) ? (
        <p role="alert">비교할 시나리오 수정 번호를 1 이상의 정수로 입력하세요.</p>
      ) : null}
      {requested && queries.some((query) => query.isFetching) ? (
        <p role="status">불변 시나리오 본문을 조회하고 있습니다.</p>
      ) : null}
      {requested && queries.some((query) => query.isError) ? (
        <>
          <p role="alert">
            선택한 시나리오 수정을 조회하지 못했습니다. 다른 수정으로 대신 표시하지 않습니다.
          </p>
          <Button
            variant="secondary"
            onClick={() => void Promise.all(queries.map((query) => query.refetch()))}
          >
            시나리오 비교 다시 확인
          </Button>
        </>
      ) : null}
      {comparison && ready ? (
        <>
          <p>
            시나리오 {left.data.label} 수정 {left.data.revision} → 시나리오 {right.data.label} 수정{' '}
            {right.data.revision}. 현재 계획 버전이나 강도 라벨이 아닙니다.
          </p>
          <label>
            시나리오 비교 기간
            <select
              value={params.get('scenarioPeriod') ?? ''}
              onChange={(event) => onChange({ scenarioPeriod: event.target.value || null })}
            >
              <option value="">전체 계획</option>
              {params.get('scenarioPeriod') &&
              !comparison.periodOptions.some(
                (period) => period.id === params.get('scenarioPeriod'),
              ) ? (
                <option value={params.get('scenarioPeriod') ?? ''}>두 수정에 없는 기간</option>
              ) : null}
              {comparison.periodOptions.map((period) => (
                <option key={period.id} value={period.id}>
                  {period.title} ·{' '}
                  {period.presence === 'shared'
                    ? '양쪽'
                    : period.presence === 'beforeOnly'
                      ? '이전에만'
                      : '이후에만'}
                </option>
              ))}
            </select>
          </label>
          {comparison.scope.status === 'missing' ? (
            <p role="status">선택한 기간은 두 수정에 없습니다.</p>
          ) : (
            <>
              <p>
                기간 {comparison.periods.length}개 · 세션 {comparison.sessions.length}개 · 계획
                제목·시간대 {comparison.planMetadata.changed ? '변경' : '동일'}
              </p>
              <ul>
                {comparison.sessions.map((row) => (
                  <li key={row.id}>
                    세션 {row.after?.title ?? row.before?.title} · ID {row.id} ·{' '}
                    {status[row.status]}
                    {row.movement === 'outOfScope'
                      ? ' · 선택 기간 밖으로 이동'
                      : row.movement === 'intoScope'
                        ? ' · 선택 기간 안으로 이동'
                        : ''}
                  </li>
                ))}
              </ul>
              <details>
                <summary>이전 시나리오 범위 본문</summary>
                <PlanSummary draft={scoped('before', left.data.draft)} />
              </details>
              <details>
                <summary>이후 시나리오 범위 본문</summary>
                <PlanSummary draft={scoped('after', right.data.draft)} />
              </details>
            </>
          )}
        </>
      ) : null}
    </section>
  );
}
