/** Executable examples of pure shared logic. Not health prescription rules. */
const DAY_MS = 86_400_000;
function utcDate(date: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RangeError('Expected YYYY-MM-DD');
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date)
    throw new RangeError('Invalid calendar date');
  return parsed;
}
/** Calendar-date arithmetic; does not reinterpret timezone or use N*24h on a local instant. */
export function rollingDateWindow(anchor: string, days: number) {
  if (!Number.isSafeInteger(days) || days < 1 || days > 3660)
    throw new RangeError('Invalid window length');
  const end = utcDate(anchor).getTime();
  return {
    from: new Date(end - (days - 1) * DAY_MS).toISOString().slice(0, 10),
    toExclusive: new Date(end + DAY_MS).toISOString().slice(0, 10),
  };
}
export function sessionLoad(durationSeconds: number, rpe: number | null): number | null {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0)
    throw new RangeError('Invalid duration');
  if (rpe === null) return null;
  if (!Number.isFinite(rpe) || rpe < 0 || rpe > 10) throw new RangeError('Invalid RPE');
  return (durationSeconds / 60) * rpe;
}
/** Descriptive percentile only. minBaseline is a product quality setting, not clinical evidence. */
export function relativePercentile(value: number, baseline: readonly number[], minBaseline: number): number | null {
  if (!Number.isFinite(value) || baseline.some(v => !Number.isFinite(v)))
    throw new RangeError('Non-finite input');
  if (!Number.isSafeInteger(minBaseline) || minBaseline < 1)
    throw new RangeError('Invalid minimum baseline');
  if (baseline.length < minBaseline) return null;
  const below = baseline.filter(v => v < value).length;
  const equal = baseline.filter(v => v === value).length;
  return 100 * (below + 0.5 * equal) / baseline.length;
}
