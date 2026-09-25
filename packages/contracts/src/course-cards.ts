import {
  availableCourseHeadSchema,
  courseLimits,
  coursePositionSchema,
  courseThumbnailLimits,
  courseThumbnailStateSchema,
  unavailableCourseHeadSchema,
} from './courses.js';
import { geoDatasetIdentitySchema } from './geo-data.js';
import { routingGraphIdentitySchema, routingLimits } from './routing.js';
import { z } from 'zod';

/**
 * The S13 course list card (M2-01k-a, `docs/.pre/01_product_screen_spec.md` §9: "S13 코스
 * 카드에 지도 썸네일, 실제/추정 거리, 고도 데이터 출처, 노면 정보의 확인 상태, 접근성 메모,
 * 마지막 사용을 표시한다").
 *
 * **Why a separate read and not new fields on `GET /courses`.** `courseListSchema` and
 * `courseHeadSchema` are strict objects, and a strict consumer refuses a field it does not
 * know. Adding the card facts to the existing list would therefore break every client
 * still parsing the old shape; a new read beside it is the additive change. The list keeps
 * its meaning (identity and head) and this read answers "what does the card say".
 *
 * Every fact here is derived from data the server already holds — the head revision's
 * line and generation conditions, the stored-thumbnail state M2-01l keeps per revision, and
 * the self-hosted elevation dataset M2-01j loads — and each one keeps "not known" apart
 * from "known to be fine":
 *
 * - **Distance.** `plannedLineMeters` is the length of the stored line and nothing else.
 *   `basis` says what that line *is*: cut from one of our own recordings (an actual path),
 *   a line our routing engine proposed (an estimate, with the engine's own figure beside
 *   it), a line read from a file whose truth we cannot check, or unknown. It is never a
 *   device-reported or GPS-recomputed distance and never an achieved one.
 * - **Elevation source.** Which dataset answered, and how much of this course it covers;
 *   or that no dataset is deployed, which is `not_deployed` and never an empty profile.
 * - **Surface.** There is no surface source in this build. The value is the literal
 *   `unknown`, so claiming anything else is a contract change, not a value a server can
 *   write (the same rule as `courseCandidateKnowledgeSchema`).
 * - **Thumbnail.** The stored-picture state of the head revision, plus the evenly spaced
 *   sample the stored picture is drawn from, so the card can draw the same picture while
 *   the stored one is pending, impossible or still loading. The sample is at most the
 *   renderer's own vertex budget: the card never carries the whole line.
 *
 * Last-used moments and accessibility notes are not repeated here: they are the owner's
 * preferences and notes, served by their own reads, and a second copy would be a second
 * source of truth.
 */
export const courseCardDistanceBasisSchema = z.discriminatedUnion('kind', [
  /**
   * The line was cut from one of our own stored recordings, so its length is measured
   * along a path that was actually travelled (as simplified for the map derivative).
   */
  z.strictObject({ kind: z.literal('recorded') }),
  /**
   * Our routing engine proposed the line. `engineDistanceMeters` is the engine's estimate
   * for it, or `null` when the line was changed after the engine answered (a privacy trim)
   * and the engine's figure no longer describes it.
   */
  z.strictObject({
    kind: z.literal('engine-estimate'),
    engineDistanceMeters: z
      .number()
      .finite()
      .nonnegative()
      .max(routingLimits.maxRouteDistanceMeters)
      .nullable(),
    graphBuildId: routingGraphIdentitySchema.shape.graphBuildId.nullable(),
  }),
  /**
   * Read from a file the owner handed us. A GPX `trk` claims to be a recording and an
   * `rte` a plan; we can verify neither, so the card says so instead of calling it actual.
   * `null` when the trim that produced this revision no longer says which element it was.
   */
  z.strictObject({
    kind: z.literal('imported-file'),
    sourceKind: z.enum(['gpx-trk', 'gpx-rte']).nullable(),
  }),
  /** Nothing the server holds says what this line is. Shown as unknown. */
  z.strictObject({ kind: z.literal('unknown') }),
]);
export type CourseCardDistanceBasis = z.infer<typeof courseCardDistanceBasisSchema>;

export const courseCardDistanceSchema = z.strictObject({
  /** Length of the stored head line, measured from its own vertices. */
  plannedLineMeters: z.number().finite().nonnegative().max(1_000_000_000),
  basis: courseCardDistanceBasisSchema,
  /** The head is a privacy-trimmed revision: part of the original line was removed. */
  privacyTrimmed: z.boolean(),
});
export type CourseCardDistance = z.infer<typeof courseCardDistanceSchema>;

export const courseCardElevationSchema = z.discriminatedUnion('status', [
  /** No elevation dataset is deployed on this server. Not "flat", not "zero": none. */
  z.strictObject({ status: z.literal('not_deployed') }),
  /** A dataset is deployed and this course lies outside the region it covers. */
  z.strictObject({ status: z.literal('outside_region'), dataset: geoDatasetIdentitySchema }),
  /**
   * The dataset was sampled along this course. `knownCount` of `sampledCount` points have a
   * value; the rest are unknown, never zero and never interpolated.
   */
  z.strictObject({
    status: z.literal('sampled'),
    dataset: geoDatasetIdentitySchema,
    sampledCount: z.number().int().min(2).max(courseLimits.elevationProfilePoints),
    knownCount: z.number().int().min(0).max(courseLimits.elevationProfilePoints),
    maxSourceDistanceMeters: z.number().finite().positive().max(10_000),
  }),
]);
export type CourseCardElevation = z.infer<typeof courseCardElevationSchema>;

/** No surface source exists in this build; see the file comment. */
export const courseCardSurfaceSchema = z.strictObject({
  confirmation: z.literal('unknown'),
});
export type CourseCardSurface = z.infer<typeof courseCardSurfaceSchema>;

export const courseCardThumbnailSchema = z.strictObject({
  state: courseThumbnailStateSchema,
  /** Evenly spaced sample of the head line, at most the renderer's vertex budget. */
  drawnVertices: z.array(coursePositionSchema).min(2).max(courseThumbnailLimits.vertexBudget),
});

export const courseCardSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('available'),
    course: availableCourseHeadSchema,
    distance: courseCardDistanceSchema,
    thumbnail: courseCardThumbnailSchema,
    elevation: courseCardElevationSchema,
    surface: courseCardSurfaceSchema,
  }),
  /** The source recording was deleted; nothing but the reference is left to describe. */
  z.strictObject({
    status: z.literal('unavailable'),
    course: unavailableCourseHeadSchema,
  }),
]);
export type CourseCard = z.infer<typeof courseCardSchema>;

export const courseCardListSchema = z.strictObject({
  cards: z.array(courseCardSchema).max(courseLimits.coursesPerTenant),
  total: z.number().int().min(0).max(courseLimits.coursesPerTenant),
});
export type CourseCardList = z.infer<typeof courseCardListSchema>;
