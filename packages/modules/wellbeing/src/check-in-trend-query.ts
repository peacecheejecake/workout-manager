import type { AuthenticatedTransport } from '@workout/contracts/core';
import {
  checkInListQuerySchema,
  checkInListSchema,
  type CheckInListQuery,
} from '@workout/contracts/check-ins';

export function readTrendQuery(search: string, period: CheckInListQuery | null) {
  if (!period) return { query: null, error: null };
  const parsed = checkInListQuerySchema.safeParse({
    from: period.from,
    toExclusive: period.toExclusive,
    limit: 100,
    offset: new URLSearchParams(search).get('trendOffset') ?? 0,
  });
  return parsed.success
    ? { query: parsed.data, error: null }
    : { query: null, error: '추세 페이지 주소가 올바르지 않습니다. 첫 페이지로 돌아가세요.' };
}

export async function fetchCheckInTrend(
  transport: AuthenticatedTransport,
  query: CheckInListQuery,
  signal: AbortSignal,
) {
  const params = new URLSearchParams(
    Object.entries(query).map(([key, value]) => [key, String(value)]),
  );
  const response = await transport.request({
    path: `/bff/v1/check-ins?${params}`,
    method: 'GET',
    body: null,
    idempotencyKey: null,
    signal,
  });
  if (response.status !== 200) throw new Error('TREND_UNAVAILABLE');
  const data = checkInListSchema.parse(response.body);
  // A page and its count/revision must describe one server snapshot, never a merge of pages.
  if (
    data.items.length !== Math.min(query.limit, Math.max(0, data.total - query.offset)) ||
    new Set(data.items.map((item) => item.id)).size !== data.items.length ||
    data.items.some((item) => item.localDate < query.from || item.localDate >= query.toExclusive)
  )
    throw new Error('TREND_INVALID_PAGE');
  return data;
}
