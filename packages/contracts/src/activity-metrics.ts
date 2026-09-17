import type { z } from 'zod';
import { activityValuesSchema } from './activity.js';

export type ActivityPaceUnavailableReason =
  | 'unsupported_sport'
  | 'unknown_duration_kind'
  | 'missing_duration'
  | 'missing_distance'
  | 'zero_duration'
  | 'zero_distance'
  | 'unrepresentable';
interface PaceDefinition {
  definitionVersion: 'activity-duration-distance-pace-v1';
  durationKind: z.infer<typeof activityValuesSchema>['durationKind'];
}
export type ActivityPace = PaceDefinition &
  (
    | { state: 'available'; secondsPerKilometer: number }
    | { state: 'unavailable'; reason: ActivityPaceUnavailableReason }
  );
/** App calculation using one validated summary's distance and explicitly defined duration.
 * Never a measured speed, provider average, record interpolation or performance score.
 */
export function calculateActivityPace(input: z.infer<typeof activityValuesSchema>): ActivityPace {
  const value = activityValuesSchema.parse(input);
  const definition: PaceDefinition = {
    definitionVersion: 'activity-duration-distance-pace-v1',
    durationKind: value.durationKind,
  };
  const unavailable = (reason: ActivityPaceUnavailableReason): ActivityPace => ({
    ...definition,
    state: 'unavailable',
    reason,
  });
  if (!['running', 'walking', 'cycling'].includes(value.kind))
    return unavailable('unsupported_sport');
  if (value.durationKind === 'unknown') return unavailable('unknown_duration_kind');
  if (value.durationSeconds === null) return unavailable('missing_duration');
  if (value.distanceMeters === null) return unavailable('missing_distance');
  if (value.distanceMeters === 0) return unavailable('zero_distance');
  if (value.durationSeconds === 0) return unavailable('zero_duration');
  const secondsPerKilometer = (value.durationSeconds / value.distanceMeters) * 1000;
  if (
    !Number.isFinite(secondsPerKilometer) ||
    secondsPerKilometer <= 0 ||
    secondsPerKilometer > Number.MAX_SAFE_INTEGER
  )
    return unavailable('unrepresentable');
  return { ...definition, state: 'available', secondsPerKilometer };
}
