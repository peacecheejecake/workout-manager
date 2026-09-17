import { plannedSessionSchema, type PlannedSession } from '@workout/contracts/planning';

const absent = '미지정 (이전 형식에 값 없음)';
const cleared = '미지정 (명시적으로 비움)';
export function paceTargetLabel(value: PlannedSession['paceTarget']): string {
  if (value === undefined) return absent;
  if (value === null) return cleared;
  if (!plannedSessionSchema.shape.paceTarget.safeParse(value).success) return '입력 오류';
  return value.minSecondsPerKm === value.maxSecondsPerKm
    ? `${value.minSecondsPerKm} 초/km`
    : `${value.minSecondsPerKm}–${value.maxSecondsPerKm} 초/km`;
}
export function heartRateTargetLabel(value: PlannedSession['heartRateTarget']): string {
  if (value === undefined) return absent;
  if (value === null) return cleared;
  if (!plannedSessionSchema.shape.heartRateTarget.safeParse(value).success) return '입력 오류';
  return value.minBpm === value.maxBpm
    ? `${value.minBpm} bpm`
    : `${value.minBpm}–${value.maxBpm} bpm`;
}
