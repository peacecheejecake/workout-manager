'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import { activityListSchema } from '@workout/contracts/activity';
import { Button } from '@workout/ui-foundation/button';
import { readActivitySearch, updateActivitySearch } from './browser-search';
import { BrowserRecords, BrowserDetail, kindLabels, sourceLabels } from './browser-records';
import styles from './activity-browser.module.css';
import { activityContextSchema } from '@workout/contracts/activity-context';
import { ActivityDelete } from './activity-delete';
import { ActivityContextPanel } from './activity-context-panel';

export interface ActivityBrowserProps {
  athleteId: string;
  sessionId: string;
  transport: AuthenticatedTransport;
  search: string;
  onSearchChange(query: string): void;
  initialTimezone: string;
  importHref: string;
  createHref?: string;
  planDayHref?: (date: string) => string;
  editHref?: (id: string) => string;
}
export function ActivityBrowser(props: ActivityBrowserProps) {
  return <Lifetime key={JSON.stringify([props.athleteId, props.sessionId])} {...props} />;
}
function Lifetime(props: ActivityBrowserProps) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  useEffect(() => () => client.clear(), [client]);
  return (
    <QueryClientProvider client={client}>
      <Workspace {...props} />
    </QueryClientProvider>
  );
}
const sortLabels = {
  started_desc: '시작 시각 최신순',
  started_asc: '시작 시각 오래된순',
  distance_desc: '거리 큰순',
  distance_asc: '거리 작은순',
  title_asc: '제목순',
  id_asc: '식별자순',
};
function Workspace({
  athleteId,
  sessionId,
  transport,
  search,
  onSearchChange,
  initialTimezone,
  importHref,
  createHref,
  editHref,
  planDayHref,
}: ActivityBrowserProps) {
  const headingId = useId();
  const composing = useRef(false);
  const parsed = readActivitySearch(search);
  const params = new URLSearchParams(search);
  const prefix = ['users', athleteId, 'sessions', sessionId, 'activity-browser'];
  const list = useQuery({
    queryKey: [...prefix, 'list', parsed.query],
    enabled: !parsed.invalid,
    queryFn: async ({ signal }) => {
      if (!parsed.query) throw new Error('INVALID_QUERY');
      const query = new URLSearchParams(
        Object.entries(parsed.query).map(([name, value]) => [name, String(value)]),
      );
      const response = await transport.request({
        path: `/bff/v1/activities?${query}`,
        method: 'GET',
        body: null,
        idempotencyKey: null,
        signal,
      });
      if (signal.aborted || response.status !== 200) throw new Error('LIST_UNAVAILABLE');
      return activityListSchema.parse(response.body);
    },
  });
  const detail = useQuery({
    queryKey: [...prefix, 'detail', parsed.selected],
    enabled: !parsed.invalid && parsed.selected !== null,
    queryFn: async ({ signal }) => {
      const response = await transport.request({
        path: `/bff/v1/activities/${parsed.selected}/context`,
        method: 'GET',
        body: null,
        idempotencyKey: null,
        signal,
      });
      if (signal.aborted) throw new Error('CANCELLED');
      if (response.status !== 200)
        throw new Error(response.status === 404 ? 'NOT_FOUND' : 'DETAIL_UNAVAILABLE');
      const context = activityContextSchema.parse(response.body);
      if (context.activity.id !== parsed.selected) throw new Error('DETAIL_MISMATCH');
      return context;
    },
  });
  function change(changes: Record<string, string | null>) {
    onSearchChange(updateActivitySearch(search, changes));
  }
  const filterKey = ['search', 'from', 'toExclusive', 'timezone', 'kind', 'source', 'sort']
    .map((name) => `${name}:${params.get(name)}`)
    .join('|');
  return (
    <section className={styles.workspace} aria-labelledby={headingId}>
      <h2 id={headingId}>활동 검색과 조회</h2>
      <p>
        활동의 원본과 정정 반영 내용을 조회합니다. <a href={importHref}>FIT 가져오기·정정</a>
      </p>
      {createHref ? (
        <p>
          <a href={createHref}>수동 활동 입력</a>
        </p>
      ) : null}
      <form
        key={filterKey}
        className={styles.filters}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDownCapture={(event) => {
          if (
            event.key === 'Enter' &&
            (composing.current ||
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229)
          )
            event.preventDefault();
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (composing.current) return;
          const data = new FormData(event.currentTarget);
          const from = String(data.get('from') ?? '');
          const to = String(data.get('toExclusive') ?? '');
          change({
            search: String(data.get('search') ?? '').trim(),
            from,
            toExclusive: to,
            timezone: from || to ? String(data.get('timezone') ?? '') : null,
            kind: String(data.get('kind') ?? ''),
            source: String(data.get('source') ?? ''),
            sort: String(data.get('sort')),
            offset: null,
          });
        }}
      >
        <label>
          활동 제목 검색
          <input name="search" maxLength={200} defaultValue={params.get('search') ?? ''} />
        </label>
        <label>
          활동 시작일
          <input name="from" type="date" defaultValue={params.get('from') ?? ''} />
        </label>
        <label>
          활동 종료일 (이 날짜 제외)
          <input name="toExclusive" type="date" defaultValue={params.get('toExclusive') ?? ''} />
        </label>
        <label>
          날짜 조회 시간대
          <input name="timezone" defaultValue={params.get('timezone') ?? initialTimezone} />
        </label>
        <label>
          종목 필터
          <select name="kind" defaultValue={params.get('kind') ?? ''}>
            <option value="">모든 종목</option>
            {Object.entries(kindLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          출처 필터
          <select name="source" defaultValue={params.get('source') ?? ''}>
            <option value="">모든 출처</option>
            {Object.entries(sourceLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          활동 정렬
          <select name="sort" defaultValue={params.get('sort') ?? 'started_desc'}>
            {Object.entries(sortLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit">활동 필터 적용</Button>
        <Button
          variant="secondary"
          onClick={() => change({ from: null, toExclusive: null, timezone: null, offset: null })}
        >
          날짜 조건 지우기
        </Button>
      </form>
      <div className={styles.actions}>
        <Button
          variant="secondary"
          aria-pressed={parsed.view === 'cards'}
          onClick={() => change({ view: 'cards' })}
        >
          카드 보기
        </Button>
        <Button
          variant="secondary"
          aria-pressed={parsed.view === 'table'}
          onClick={() => change({ view: 'table' })}
        >
          표 보기
        </Button>
        <Button
          variant="secondary"
          disabled={parsed.invalid || list.isFetching}
          onClick={() => void list.refetch()}
        >
          활동 목록 다시 확인
        </Button>
      </div>
      {parsed.invalid ? (
        <div role="alert">
          <p>
            조회 주소를 확인하세요. 날짜는 시작일·종료일·시간대를 함께 지정하고 1~3660일 범위를
            사용하세요. 종목·출처·정렬·보기·선택한 기록도 유효해야 합니다.
          </p>
          <Button
            variant="secondary"
            onClick={() =>
              change({
                search: null,
                from: null,
                toExclusive: null,
                timezone: null,
                kind: null,
                source: null,
                sort: null,
                offset: null,
                view: null,
                selected: null,
              })
            }
          >
            활동 조회 조건 초기화
          </Button>
        </div>
      ) : (
        <>
          <p>
            적용 조건 (모두 충족): 제목 {parsed.query?.search ?? '전체'} · 종목{' '}
            {parsed.query?.kind ? kindLabels[parsed.query.kind] : '전체'} · 출처{' '}
            {parsed.query?.source ? sourceLabels[parsed.query.source] : '전체'} · 정렬{' '}
            {sortLabels[parsed.query?.sort ?? 'started_desc']}
            {parsed.query?.from
              ? ` · 날짜 ${parsed.query.from} ~ ${parsed.query.toExclusive} (종료일 제외) · ${parsed.query.timezone}`
              : ' · 날짜 제한 없음'}
          </p>
          {parsed.query?.from ? (
            <p>
              날짜 조건은 지정한 시간대의 시작 시각으로 적용합니다. 시작 시각이 미확인인 활동은 날짜
              조건에서 제외됩니다.
            </p>
          ) : null}
          {list.isFetching ? <p role="status">활동 목록을 확인하고 있습니다.</p> : null}
          {list.isError ? (
            <p role="alert">
              활동 목록 최신 확인 실패.{' '}
              {list.data
                ? '아래는 마지막 조회 결과이며 변경되었을 수 있습니다.'
                : '목록을 불러오지 못했습니다. 다시 확인하세요.'}
            </p>
          ) : null}
          {list.data ? (
            <>
              <p>
                조회 조건에 맞는 활동 {list.data.total}개 · 현재 페이지 {list.data.items.length}개
              </p>
              <p>
                마지막 목록 조회 시각: {new Date(list.dataUpdatedAt).toISOString()} · 공급자 동기화
                시각이 아닙니다.
              </p>
              {list.data.items.length === 0 ? (
                <p>
                  {list.data.total === 0
                    ? '조회 조건에 맞는 활동이 없습니다.'
                    : '이 페이지에 활동이 없습니다. 이전 페이지로 이동하거나 조회 조건을 다시 적용하세요.'}
                </p>
              ) : (
                <BrowserRecords
                  items={list.data.items}
                  view={parsed.view ?? 'cards'}
                  selected={parsed.selected}
                  onSelect={(selected) => change({ selected })}
                />
              )}
              <div className={styles.actions}>
                <Button
                  variant="secondary"
                  disabled={(parsed.query?.offset ?? 0) === 0}
                  onClick={() =>
                    change({ offset: String(Math.max(0, (parsed.query?.offset ?? 0) - 20)) })
                  }
                >
                  이전 활동
                </Button>
                <Button
                  variant="secondary"
                  disabled={
                    (parsed.query?.offset ?? 0) + 20 >= list.data.total ||
                    (parsed.query?.offset ?? 0) + 20 > 10000
                  }
                  onClick={() => change({ offset: String((parsed.query?.offset ?? 0) + 20) })}
                >
                  다음 활동
                </Button>
              </div>
            </>
          ) : null}
          {parsed.selected ? (
            <section aria-label="선택한 활동 상세">
              <h2>선택한 활동 상세</h2>
              <Button variant="secondary" onClick={() => change({ selected: null })}>
                활동 상세 닫기
              </Button>
              <Button
                variant="secondary"
                disabled={detail.isFetching}
                onClick={() => void detail.refetch()}
              >
                활동 상세 다시 확인
              </Button>
              {detail.isFetching ? <p role="status">활동 상세를 확인하고 있습니다.</p> : null}
              {detail.isError ? (
                <p role="alert">
                  {detail.error.message === 'NOT_FOUND'
                    ? '기록이 삭제되었거나 접근할 수 없습니다.'
                    : '활동 상세 최신 확인 실패. 다시 확인하세요.'}
                </p>
              ) : null}
              {detail.isSuccess && !detail.isFetching ? (
                <>
                  {editHref ? (
                    <p>
                      <a href={editHref(detail.data.activity.id)}>이 활동 정정</a>
                    </p>
                  ) : null}
                  <BrowserDetail activity={detail.data.activity} />
                  <ActivityContextPanel
                    context={detail.data}
                    {...(planDayHref ? { planDayHref } : {})}
                  />
                </>
              ) : null}
            </section>
          ) : null}
        </>
      )}
      <ActivityDelete
        current={
          !parsed.invalid && parsed.selected && detail.isSuccess && !detail.isFetching
            ? detail.data.activity
            : null
        }
        selected={parsed.selected}
        transport={transport}
        scope={prefix}
        onDeleted={(id) => {
          if (parsed.selected === id) change({ selected: null });
        }}
      />
    </section>
  );
}
