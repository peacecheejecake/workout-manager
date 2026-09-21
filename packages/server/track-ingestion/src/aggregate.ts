import type { RecordedTrack, TrackAggregates } from '@workout/contracts/tracks';
import { haversineMeters } from './geo.js';

/**
 * Aggregates read from the samples, never from display geometry. Pace uses the
 * device-reported distance only, preserving the existing actual-summary source priority;
 * when the device reported none, pace is unknown rather than derived from GPS.
 * `averageHeartRateBpm` is an unweighted sample mean, not a device session average.
 */
export function trackAggregates(track: RecordedTrack): TrackAggregates {
  const byId = new Map(track.samples.map((sample) => [sample.sampleId, sample]));
  let recomputed: number | null = null;
  for (const segment of track.segments) {
    let previous = null as (typeof track.samples)[number] | null;
    for (const sampleId of segment.sampleIds) {
      const sample = byId.get(sampleId);
      if (!sample) continue;
      if (previous?.position && sample.position)
        recomputed = (recomputed ?? 0) + haversineMeters(previous.position, sample.position);
      previous = sample;
    }
  }
  const times = track.samples
    .map((sample) => (sample.recordedAt === null ? null : Date.parse(sample.recordedAt)))
    .filter((value): value is number => value !== null);
  const first = times.length > 0 ? Math.min(...times) : null;
  const last = times.length > 0 ? Math.max(...times) : null;
  const elapsedSeconds = first === null || last === null ? null : (last - first) / 1000;
  const device = track.distances.deviceReportedMeters;
  const beats = track.samples
    .map((sample) => sample.heartRateBpm)
    .filter((value): value is number => value !== null);
  return {
    sampleCount: track.samples.length,
    positionedSampleCount: track.samples.filter((sample) => sample.position !== null).length,
    segmentCount: track.segments.length,
    elapsedSeconds,
    deviceDistanceMeters: device,
    recomputedDistanceMeters: recomputed,
    averagePaceSecondsPerKilometer:
      elapsedSeconds === null || elapsedSeconds <= 0 || device === null || device <= 0
        ? null
        : (elapsedSeconds / device) * 1000,
    averageHeartRateBpm:
      beats.length === 0 ? null : beats.reduce((sum, value) => sum + value, 0) / beats.length,
  };
}
