import { z } from 'zod';

const isoInstant = z.iso.datetime({ offset: true });

// PostgreSQL 17 ParseFractionalSecond uses strtod followed by rint(frac * 1e6).
// Round the binary64 fraction to nearest-even before integral calendar/zone arithmetic;
// rounding the signed epoch value or decimal digits directly changes boundary results.
function postgresFractionMicros(fraction: string): bigint {
  const scaled = Number(`0.${fraction || '0'}`) * 1000000;
  const lower = Math.floor(scaled);
  const remainder = scaled - lower;
  const rounded = remainder < 0.5 ? lower : remainder > 0.5 ? lower + 1 : lower + (lower % 2);
  return BigInt(rounded);
}
// Native calendar arithmetic retains microseconds and permits fractional carry; no Date coercion.
/** PostgreSQL 17 microsecond correspondence for public ISO instants.
 * Returns facts only; preserves the supplied string and grants no authority.
 * PostgreSQL has no ISO year zero. Named zones, BC and expanded years are unsupported.
 */
export function postgresInstantMicros(value: unknown): bigint | null {
  if (typeof value !== 'string') return null;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !isoInstant.safeParse(value).success || match[1] === '0000') return null;
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3]);
  const a = Math.floor((14 - month) / 12),
    y = year + 4800 - a,
    m = month + 12 * a - 3;
  const days =
    day +
    Math.floor((153 * m + 2) / 5) +
    365 * y +
    Math.floor(y / 4) -
    Math.floor(y / 100) +
    Math.floor(y / 400) -
    32045 -
    2440588;
  const zone = match[8] ?? 'Z';
  if (zone !== 'Z' && Number(zone.slice(1, 3)) > 15) return null;
  const offset =
    zone === 'Z'
      ? 0
      : (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6))) *
        60 *
        (zone[0] === '+' ? 1 : -1);
  const seconds =
    BigInt(days) * 86400n +
    BigInt(Number(match[4]) * 3600 + Number(match[5]) * 60 + Number(match[6]) - offset);
  return seconds * 1000000n + postgresFractionMicros(match[7] ?? '');
}
