import type { Activity, ActivityDetailsRead } from '@workout/contracts/activity';
import type { ActivityLap, ActivityRecord } from '@workout/contracts/activity-details';

export type TimeRange = { start: number; end: number };
export type ChartPoint = { index: number; time: number; value: number };
const validTime = (value: number) =>
  Number.isFinite(value) && Math.abs(value) <= 8_640_000_000_000_000;
function timestamp(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return validTime(parsed) ? parsed : null;
}
export function recordTime(record: ActivityRecord): number | null {
  return timestamp(record.timestamp);
}
export function lapTimeRange(lap: ActivityLap): TimeRange | null {
  const start = timestamp(lap.startedAt);
  const elapsed = lap.elapsedSeconds;
  if (start === null || elapsed === null || !Number.isFinite(elapsed) || elapsed < 0) return null;
  const end = start + elapsed * 1000;
  return validTime(end) ? { start, end } : null;
}
export function detailsMatchActivity(activity: Activity, read: ActivityDetailsRead): boolean {
  return (
    activity.id === read.activityId &&
    activity.revision === read.activityRevision &&
    activity.source.kind === read.source.kind &&
    activity.source.sourceId === read.source.sourceId &&
    activity.source.revision === read.source.revision &&
    activity.source.contentHash === read.source.contentHash
  );
}
/** Source-order observations; missing or non-increasing time never creates a connecting line. */
export function chartSegments(
  records: ActivityRecord[],
  metric: 'heartRateBpm' | 'distanceMeters',
): ChartPoint[][] {
  const segments: ChartPoint[][] = [];
  let segment: ChartPoint[] | null = null;
  let previousTime: number | null = null;
  for (const record of records) {
    const time = recordTime(record);
    const value = record[metric];
    if (time === null || value === null || !Number.isFinite(value)) {
      segment = null;
      previousTime = time;
      continue;
    }
    if (segment === null || (previousTime !== null && time <= previousTime)) {
      segment = [];
      segments.push(segment);
    }
    segment.push({ index: record.index, time, value });
    previousTime = time;
  }
  return segments;
}
function validRange(range: TimeRange): boolean {
  return validTime(range.start) && validTime(range.end) && range.start <= range.end;
}
/** Inclusive endpoints retain zero-duration and single-observation selections. */
export function recordInRange(record: ActivityRecord, range: TimeRange): boolean {
  const time = recordTime(record);
  return validRange(range) && time !== null && time >= range.start && time <= range.end;
}
export function lapOverlapsRange(lap: ActivityLap, range: TimeRange): boolean {
  const lapRange = lapTimeRange(lap);
  return (
    validRange(range) &&
    lapRange !== null &&
    lapRange.start <= range.end &&
    lapRange.end >= range.start
  );
}
