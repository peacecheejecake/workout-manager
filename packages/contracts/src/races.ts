import { z } from 'zod';
import {
  idSchema,
  instantSchema,
  localDateSchema,
  localTimeSchema,
  revisionSchema,
  timeZoneSchema,
} from './primitives.js';

/** M2-02a contract only. Ownership and verification are enforced by the future server API. */
const uuid = z.uuid().transform((value) => value.toLowerCase());
const label = z.string().trim().min(1).max(200);
const metres = z.number().finite().positive().max(10_000_000);
const seconds = z.number().finite().nonnegative().max(604_800);
const officialUrl = z.url({ protocol: /^https$/ }).refine((value) => value.length <= 2048);

export const raceDistanceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('standard'),
    class: z.enum(['5k', '10k', 'half-marathon', 'marathon']),
  }),
  z.strictObject({ kind: z.literal('custom'), label, nominalMeters: metres.nullable() }),
]);
export type RaceDistance = z.infer<typeof raceDistanceSchema>;

/** A link names an immutable Course revision, never the mutable Course head. */
export const raceCourseRefSchema = z.strictObject({
  courseId: uuid,
  courseRevision: revisionSchema.min(1),
  revisionId: uuid,
});
export type RaceCourseRef = z.infer<typeof raceCourseRefSchema>;

/** Planned event only: attendance, a timer or a provider event cannot create a result here. */
export const raceEventSchema = z.strictObject({
  id: uuid,
  revision: revisionSchema.min(1),
  title: label,
  localDate: localDateSchema,
  localStartTime: localTimeSchema.nullable(),
  timezone: timeZoneSchema,
  locationName: label.nullable(),
  distance: raceDistanceSchema,
  priority: z.enum(['A', 'B', 'C']).nullable(),
  participation: z.enum(['considering', 'registered', 'withdrawn']),
  officialUrl: officialUrl.nullable(),
  course: raceCourseRefSchema.nullable(),
  targetSeconds: seconds.nullable(),
  planVersionId: idSchema.max(200).nullable(),
});
export type RaceEvent = z.infer<typeof raceEventSchema>;

/** `verifiedAt` is a server-owned review fact, not proof supplied by a browser client. */
export const raceResultSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('official'),
    authority: label,
    resultUrl: officialUrl,
    verifiedAt: instantSchema.nullable(),
  }),
  z.strictObject({ kind: z.literal('manual') }),
  z.strictObject({ kind: z.literal('device'), providerLabel: label }),
]);
export type RaceResultSource = z.infer<typeof raceResultSourceSchema>;

/** Actual race result. Official and device distances, chip and gun times stay separate. */
export const raceResultSchema = z.strictObject({
  kind: z.literal('race-result'),
  id: uuid,
  revision: revisionSchema.min(1),
  raceEventId: uuid.nullable(),
  localDate: localDateSchema,
  timezone: timeZoneSchema,
  source: raceResultSourceSchema,
  chipSeconds: seconds.nullable(),
  gunSeconds: seconds.nullable(),
  officialDistanceMeters: metres.nullable(),
  deviceDistanceMeters: metres.nullable(),
  linkedActivityId: uuid.nullable(),
  weatherNote: z.string().max(2000).nullable(),
});
export type RaceResult = z.infer<typeof raceResultSchema>;

/** A training best is a different actual, including an estimated device split. */
export const trainingBestSchema = z.strictObject({
  kind: z.literal('training-best'),
  id: uuid,
  revision: revisionSchema.min(1),
  observedAt: instantSchema,
  source: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('activity'), activityId: uuid }),
    z.strictObject({ kind: z.literal('manual') }),
  ]),
  basis: z.enum(['whole-activity', 'device-estimated-split', 'user-entered']),
  distanceMeters: metres.nullable(),
  elapsedSeconds: seconds.nullable(),
});
export type TrainingBest = z.infer<typeof trainingBestSchema>;

export const performanceRecordSchema = z.discriminatedUnion('kind', [
  raceResultSchema,
  trainingBestSchema,
]);
export type PerformanceRecord = z.infer<typeof performanceRecordSchema>;

/** Candidate classification only. User-visible PB inclusion/ranking is a later policy. */
export function isVerifiedOfficialRaceCandidate(record: PerformanceRecord): boolean {
  if (record.kind !== 'race-result' || record.source.kind !== 'official') return false;
  return (
    record.source.verifiedAt !== null &&
    record.officialDistanceMeters !== null &&
    ((record.chipSeconds !== null && record.chipSeconds > 0) ||
      (record.gunSeconds !== null && record.gunSeconds > 0))
  );
}
