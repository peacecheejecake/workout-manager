import { z } from 'zod';

const uuid = z.uuid().transform((value) => value.toLowerCase());

export interface StretchingRoute {
  exerciseId: string | null;
  activityId: string | null;
}

/** Keep route parsing shared by the Next and mobile-web shells. */
export function parseStretchingRoute(
  pathname: string,
  activityId: string | null,
): StretchingRoute | null {
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] !== 'stretching') return null;
  if (segments.length !== 1 && (segments.length !== 3 || segments[1] !== 'exercises')) return null;
  const parsedActivity = activityId === null ? null : uuid.safeParse(activityId);
  if (parsedActivity !== null && !parsedActivity.success) return null;
  if (segments.length === 1) return { exerciseId: null, activityId: parsedActivity?.data ?? null };
  const exercise = uuid.safeParse(segments[2]);
  if (!exercise.success) return null;
  return { exerciseId: exercise.data, activityId: parsedActivity?.data ?? null };
}
