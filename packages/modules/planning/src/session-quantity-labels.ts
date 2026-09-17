import type { PlannedSession } from '@workout/contracts/planning';
function label(
  scalar: number | null,
  range: { min: number; max: number } | null | undefined,
  unit: string,
  limit: number,
): string {
  const valid = (value: number) => Number.isFinite(value) && value >= 0 && value <= limit;
  if (range)
    return scalar === null && valid(range.min) && valid(range.max) && range.min <= range.max
      ? `${range.min}–${range.max}${unit} (범위)`
      : '범위 입력 오류';
  return scalar === null ? '미정' : valid(scalar) ? `${scalar}${unit}` : '입력 오류';
}
export function sessionDurationLabel(session: PlannedSession): string {
  return label(
    session.durationSeconds,
    session.durationRange && {
      min: session.durationRange.minSeconds,
      max: session.durationRange.maxSeconds,
    },
    '초',
    604800,
  );
}
export function sessionDistanceLabel(session: PlannedSession): string {
  return label(
    session.distanceMeters,
    session.distanceRange && {
      min: session.distanceRange.minMeters,
      max: session.distanceRange.maxMeters,
    },
    'm',
    10000000,
  );
}
export function rangePresenceLabel(value: object | null | undefined): string {
  return value === undefined
    ? '이전 형식에 범위 값 없음'
    : value === null
      ? '범위 명시적으로 비움'
      : '범위 지정';
}
