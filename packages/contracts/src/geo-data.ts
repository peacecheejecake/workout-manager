import { instantSchema } from './primitives.js';
import { courseLimits, coursePositionSchema } from './courses.js';
import { trackTextSchema } from './tracks.js';
import { z } from 'zod';

/**
 * Self-hosted place search and elevation (M2-01j).
 *
 * Both answers come from data we build ourselves from the same regional extract the
 * basemap and the routing graph are built from. There is no external geocoder, no external
 * elevation service and no public demo endpoint anywhere in this contract: a dataset is
 * either deployed on our side or the answer is `no_dataset`, which is a state the screen
 * shows rather than a reason to ask someone else.
 *
 * Every answer names the dataset it came from — identity, licence, attribution, when it
 * was built and how often it is rebuilt — because "which version of which data said this"
 * is part of the answer, not decoration.
 */
export const geoDatasetKindSchema = z.enum(['places', 'elevation']);

export const geoDatasetIdentitySchema = z.strictObject({
  kind: geoDatasetKindSchema,
  /** Derived from the inputs, so the same inputs name the same dataset. */
  datasetId: z.string().regex(/^[0-9a-f]{12}$/),
  datasetVersion: z.literal(1),
  region: z.string().min(1).max(64),
  /** The extract every feature in this dataset came from. */
  sourceExtractSha256: z.string().regex(/^[0-9a-f]{64}$/),
  licence: z.string().min(1).max(64),
  licenceUrl: z.url().max(256),
  attribution: z.string().min(1).max(200),
  /** How often the dataset is rebuilt. A statement of operating intent, not a promise. */
  updateCadence: z.string().min(1).max(120),
  builtAt: instantSchema,
  featureCount: z.number().int().min(0).max(50_000_000),
  /** `[west, south, east, north]`. Outside it we answer "outside the region", not zero. */
  bbox: z.tuple([
    z.number().finite().min(-180).max(180),
    z.number().finite().min(-90).max(90),
    z.number().finite().min(-180).max(180),
    z.number().finite().min(-90).max(90),
  ]),
});
export type GeoDatasetIdentity = z.infer<typeof geoDatasetIdentitySchema>;

/**
 * One place search. It is a POST and the bias point is in the body on purpose: a request
 * line ends up in access logs, and "where the owner is looking" is exactly the kind of
 * precise position that must not be logged.
 */
export const placeSearchRequestSchema = z.strictObject({
  query: z.string().min(1).max(courseLimits.placeQueryLength).pipe(trackTextSchema),
  /** Optional bias. Results are ordered by distance from it when it is given. */
  near: coursePositionSchema.nullable(),
});
export type PlaceSearchRequest = z.infer<typeof placeSearchRequestSchema>;

export const placeSchema = z.strictObject({
  placeId: z.string().min(1).max(64),
  name: trackTextSchema,
  /** The local-language name when the dataset holds one and it differs from `name`. */
  localName: trackTextSchema.nullable(),
  /** What the source data called it, e.g. `place:suburb` or `leisure:park`. */
  kind: z.string().min(1).max(64),
  position: coursePositionSchema,
  /** Distance from the bias point, or `null` when no bias point was given. */
  distanceMeters: z.number().finite().nonnegative().max(40_075_000).nullable(),
});
export type Place = z.infer<typeof placeSchema>;

export const placeSearchResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('results'),
    dataset: geoDatasetIdentitySchema,
    places: z.array(placeSchema).max(courseLimits.placeResults),
    /** Matches found before the result bound was applied. */
    matchCount: z.number().int().min(0),
  }),
  /**
   * No dataset is deployed on this server. Not "no results": we did not look, and the
   * screen says so rather than implying the place does not exist.
   */
  z.strictObject({ outcome: z.literal('no_dataset') }),
  /** The bias point is outside the region our dataset covers. */
  z.strictObject({ outcome: z.literal('outside_region'), dataset: geoDatasetIdentitySchema }),
]);
export type PlaceSearchResult = z.infer<typeof placeSearchResultSchema>;

/**
 * Elevation along a course.
 *
 * Our elevation dataset is built from the `ele` tags of our own extract. It is **sparse**:
 * most points on a course have no elevation fact within the search radius, and this
 * contract makes that the normal answer rather than an edge case. `elevationMeters` is
 * `null` where nothing is known — never zero, never interpolated between two known points
 * and never estimated. There is deliberately no total ascent or descent field: summing a
 * sparse sample would fabricate a number, so the contract gives a reader the known points
 * and the coverage and leaves the arithmetic undone.
 */
export const elevationPointSchema = z.strictObject({
  /** Index into the course geometry this point was sampled from. */
  vertexIndex: z
    .number()
    .int()
    .min(0)
    .max(courseLimits.vertices - 1),
  elevationMeters: z.number().finite().min(-12_000).max(12_000).nullable(),
  /** How far the nearest known elevation fact was, or `null` when none was in range. */
  sourceDistanceMeters: z.number().finite().nonnegative().nullable(),
});

export const courseElevationResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('profile'),
    dataset: geoDatasetIdentitySchema,
    /** The radius a fact had to be within to be used at all. */
    maxSourceDistanceMeters: z.number().finite().positive().max(10_000),
    points: z.array(elevationPointSchema).min(2).max(courseLimits.elevationProfilePoints),
    /** How many of the reported points have a value. Coverage, stated rather than implied. */
    knownCount: z.number().int().min(0).max(courseLimits.elevationProfilePoints),
    /** Vertices in the course, so a reader knows the profile is a sample of a longer line. */
    vertexCount: z.number().int().min(2).max(courseLimits.vertices),
  }),
  z.strictObject({ outcome: z.literal('no_dataset') }),
  z.strictObject({ outcome: z.literal('outside_region'), dataset: geoDatasetIdentitySchema }),
]);
export type CourseElevationResult = z.infer<typeof courseElevationResultSchema>;

/**
 * The dataset documents themselves, as the build writes them and the server reads them.
 * Validated at the boundary like any other untrusted input: a file on disk is not a
 * promise, and a malformed one disables the feature instead of degrading it silently.
 */
export const placeDatasetDocumentSchema = z.strictObject({
  identity: geoDatasetIdentitySchema.extend({ kind: z.literal('places') }),
  places: z
    .array(
      z.strictObject({
        placeId: z.string().min(1).max(64),
        name: trackTextSchema,
        localName: trackTextSchema.nullable(),
        kind: z.string().min(1).max(64),
        position: coursePositionSchema,
      }),
    )
    .max(2_000_000),
});
export type PlaceDatasetDocument = z.infer<typeof placeDatasetDocumentSchema>;

export const elevationDatasetDocumentSchema = z.strictObject({
  identity: geoDatasetIdentitySchema.extend({ kind: z.literal('elevation') }),
  maxSourceDistanceMeters: z.number().finite().positive().max(10_000),
  points: z
    .array(
      z.strictObject({
        position: coursePositionSchema,
        elevationMeters: z.number().finite().min(-12_000).max(12_000),
      }),
    )
    .max(5_000_000),
});
export type ElevationDatasetDocument = z.infer<typeof elevationDatasetDocumentSchema>;
