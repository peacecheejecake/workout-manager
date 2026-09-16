import { checkInListQuerySchema } from '@workout/contracts/check-ins';

export function localDateAt(instant: string, timezone: string) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instant));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year').padStart(4, '0')}-${value('month')}-${value('day')}`;
}
function shiftDate(date: string, days: number) {
  const instant = new Date(`${date}T00:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}
export function readWellbeingSearch(search: string, today: string) {
  const params = new URLSearchParams(search);
  const result = checkInListQuerySchema.safeParse({
    from: params.get('from') ?? shiftDate(today, -29),
    toExclusive: params.get('toExclusive') ?? shiftDate(today, 1),
    offset: params.get('offset') ?? 0,
    limit: 20,
  });
  return result.success
    ? { query: result.data, error: null }
    : { query: null, error: '조회 기간은 시작일 이후 1~90일로 지정하고 페이지 범위를 확인하세요.' };
}
export function changeWellbeingSearch(search: string, changes: Record<string, string | null>) {
  const params = new URLSearchParams(search);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  return params.toString();
}
