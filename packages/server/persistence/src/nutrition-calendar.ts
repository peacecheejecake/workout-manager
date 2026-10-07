const formatterCache = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string) {
  let format = formatterCache.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timezone, format);
  }
  return format;
}
export function localParts(instant: number, timezone: string) {
  const parts = Object.fromEntries(
    formatter(timezone)
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts['year']?.padStart(4, '0')}-${parts['month']}-${parts['day']}`,
    time: `${parts['hour']}:${parts['minute']}:${parts['second']}`,
  };
}
/** Reject nonexistent/ambiguous wall times instead of silently picking a DST offset. */
export function localInstant(date: string, time: string, timezone: string): number | null {
  const target = Date.parse(`${date}T${time.length === 5 ? `${time}:00` : time}Z`);
  if (!Number.isFinite(target)) return null;
  const offsets = new Set<number>();
  for (const sample of [target - 86_400_000, target, target + 86_400_000]) {
    const local = localParts(sample, timezone);
    offsets.add(Date.parse(`${local.date}T${local.time}Z`) - sample);
  }
  const matching = [...offsets]
    .map((offset) => target - offset)
    .filter((candidate) => {
      const local = localParts(candidate, timezone);
      return local.date === date && local.time === (time.length === 5 ? `${time}:00` : time);
    });
  return matching.length === 1 ? (matching[0] ?? null) : null;
}
