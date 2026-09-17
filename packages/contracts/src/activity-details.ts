import { z } from 'zod';

export const activityDetailLimits = {
  records: 20_000,
  laps: 1_000,
  detailBytes: 4 * 1024 * 1024,
  importRequestBytes: 5 * 1024 * 1024,
  importFileBytes: 16 * 1024 * 1024,
} as const;
const metric = z.number().finite().nonnegative().max(1_000_000_000).nullable();
const heartRate = z.number().int().min(0).max(255).nullable();
const timestamp = z.iso.datetime({ offset: true }).nullable();
const ordinal = z.number().int().min(0).max(999_999);
export const activityRecordSchema = z.strictObject({
  index: ordinal,
  timestamp,
  distanceMeters: metric,
  heartRateBpm: heartRate,
});
export const activityLapSchema = z.strictObject({
  index: ordinal,
  startedAt: timestamp,
  recordedAt: timestamp,
  elapsedSeconds: metric,
  timerSeconds: metric,
  distanceMeters: metric,
  averageHeartRateBpm: heartRate,
  maximumHeartRateBpm: heartRate,
});
/** Source observations; summary timestamps are write times, never interval endpoints. */
export const activityDetailsSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    streamIndex: z.number().int().min(0).max(127),
    sessionIndex: z.number().int().min(0).max(99),
    startedAt: timestamp,
    recordedAt: timestamp,
    elapsedSeconds: metric,
    records: z.array(activityRecordSchema).max(activityDetailLimits.records),
    laps: z.array(activityLapSchema).max(activityDetailLimits.laps),
  })
  .superRefine((details, context) => {
    for (const key of ['records', 'laps'] as const) {
      let previous = -1;
      details[key].forEach((item, index) => {
        if (item.index <= previous)
          context.addIssue({
            code: 'custom',
            message: 'Source indices must be unique and increasing',
            path: [key, index, 'index'],
          });
        previous = item.index;
      });
    }
    if (new TextEncoder().encode(JSON.stringify(details)).length > activityDetailLimits.detailBytes)
      context.addIssue({ code: 'custom', message: 'Activity details exceed byte limit' });
  });
export type ActivityDetails = z.infer<typeof activityDetailsSchema>;
export type ActivityRecord = z.infer<typeof activityRecordSchema>;
export type ActivityLap = z.infer<typeof activityLapSchema>;
