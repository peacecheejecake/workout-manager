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
const detailFields = z.strictObject({
  schemaVersion: z.literal(1),
  streamIndex: z.number().int().min(0).max(127),
  sessionIndex: z.number().int().min(0).max(99),
  startedAt: timestamp,
  recordedAt: timestamp,
  elapsedSeconds: metric,
  records: z.array(activityRecordSchema).max(activityDetailLimits.records),
  laps: z.array(activityLapSchema).max(activityDetailLimits.laps),
});
const checkDetails = (
  details: Omit<z.infer<typeof detailFields>, 'schemaVersion'>,
  context: z.RefinementCtx,
) => {
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
};
/** Legacy source payloads retain their exact fields for hash and receipt compatibility. */
export const activityDetailsV1Schema = detailFields.superRefine(checkDetails);
export const activitySessionSummarySchema = z.strictObject({
  averageHeartRateBpm: heartRate,
  maximumHeartRateBpm: heartRate,
});
export const activityDetailsV2Schema = detailFields
  .extend({
    schemaVersion: z.literal(2),
    sessionSummary: activitySessionSummarySchema,
  })
  .superRefine(checkDetails);
const boutKind = z.enum(['running', 'cycling', 'walking', 'strength', 'mixed_unallocated']);
const lapSport = z.enum(['running', 'cycling', 'walking', 'strength']);
const activityLapV3Schema = activityLapSchema.safeExtend({ sport: lapSport.nullable() });
const boutSchema = z.strictObject({
  sourceLapIndex: ordinal.nullable(),
  startedAt: z.iso.datetime({ offset: true }),
  endedAtExclusive: z.iso.datetime({ offset: true }),
  kind: boutKind,
});
/** Elapsed-time partition of one canonical FIT session. Bouts are detail, never Activities. */
export const activityDetailsV3Schema = z
  .strictObject({
    ...detailFields.shape,
    schemaVersion: z.literal(3),
    sessionSummary: activitySessionSummarySchema,
    laps: z.array(activityLapV3Schema).max(activityDetailLimits.laps),
    allocation: z.strictObject({
      parent: z.strictObject({
        startedAt: z.iso.datetime({ offset: true }),
        endedAtExclusive: z.iso.datetime({ offset: true }),
      }),
      bouts: z
        .array(boutSchema)
        .min(1)
        .max(activityDetailLimits.laps * 2 + 1),
    }),
  })
  .superRefine(checkDetails)
  .superRefine((details, context) => {
    const { parent, bouts } = details.allocation;
    const parentStart = Date.parse(parent.startedAt);
    const parentEnd = Date.parse(parent.endedAtExclusive);
    if (
      details.startedAt === null ||
      details.elapsedSeconds === null ||
      details.elapsedSeconds <= 0 ||
      Date.parse(details.startedAt) !== parentStart ||
      Math.abs(parentEnd - parentStart - details.elapsedSeconds * 1000) > 0.5
    )
      context.addIssue({
        code: 'custom',
        path: ['allocation', 'parent'],
        message: 'Parent interval must match the FIT session elapsed interval',
      });
    const laps = new Map(details.laps.map((lap) => [lap.index, lap]));
    const usedLaps = new Set<number>();
    let cursor = parentStart;
    for (const [index, bout] of bouts.entries()) {
      const start = Date.parse(bout.startedAt);
      const end = Date.parse(bout.endedAtExclusive);
      if (start !== cursor || end <= start || end > parentEnd)
        context.addIssue({
          code: 'custom',
          path: ['allocation', 'bouts', index],
          message: 'Bouts must partition the parent without overlap or gaps',
        });
      cursor = end;
      if (bout.sourceLapIndex === null) {
        if (bout.kind !== 'mixed_unallocated')
          context.addIssue({
            code: 'custom',
            path: ['allocation', 'bouts', index, 'kind'],
            message: 'Unattributed time cannot claim a sport',
          });
        continue;
      }
      const lap = laps.get(bout.sourceLapIndex);
      if (!lap || usedLaps.has(bout.sourceLapIndex)) {
        context.addIssue({
          code: 'custom',
          path: ['allocation', 'bouts', index, 'sourceLapIndex'],
          message: 'Bout requires a unique source lap',
        });
        continue;
      }
      usedLaps.add(bout.sourceLapIndex);
      if (
        lap.startedAt === null ||
        lap.elapsedSeconds === null ||
        Date.parse(lap.startedAt) !== start ||
        Math.abs(end - start - lap.elapsedSeconds * 1000) > 0.5 ||
        bout.kind !==
          (lap.sport === 'running' ||
          lap.sport === 'cycling' ||
          lap.sport === 'walking' ||
          lap.sport === 'strength'
            ? lap.sport
            : 'mixed_unallocated')
      )
        context.addIssue({
          code: 'custom',
          path: ['allocation', 'bouts', index],
          message: 'Bout must match its source lap boundary and sport',
        });
    }
    if (cursor !== parentEnd)
      context.addIssue({
        code: 'custom',
        path: ['allocation', 'bouts'],
        message: 'Unallocated remainder must be explicit',
      });
  });
export const activityDetailsSchema = z.discriminatedUnion('schemaVersion', [
  activityDetailsV1Schema,
  activityDetailsV2Schema,
  activityDetailsV3Schema,
]);
export type ActivityDetails = z.infer<typeof activityDetailsSchema>;
export type ActivityRecord = z.infer<typeof activityRecordSchema>;
export type ActivityLap = z.infer<typeof activityLapSchema>;
