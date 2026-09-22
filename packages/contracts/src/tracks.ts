import { activityDetailLimits } from './activity-details.js';
import { idSchema, instantSchema, revisionSchema } from './primitives.js';
import { z } from 'zod';

/**
 * Versioned recorded-track contract. Deliberately separate from `activity-details.ts`:
 * detail v1~v3 records stay GPS-free and their hashes and interpretation are unchanged.
 * A track references detail observations only through {@link trackDetailLinkSchema}.
 */
export const trackLimits = {
  /** Raw FIT/GPX upload bytes. */
  fileBytes: 32 * 1024 * 1024,
  /** Samples in one normalized track. */
  samples: 200_000,
  /** Segments in one normalized track. */
  segments: 2_000,
  /** Recorded tracks + routes discovered in one file before explicit selection. */
  tracksPerFile: 64,
  /** FIT chained streams / GPX `trk` elements. */
  streams: 128,
  /** XML element nesting depth. */
  xmlDepth: 32,
  /** Bytes of one XML text node. */
  xmlTextBytes: 64 * 1024,
  /** Characters of any single user-visible metadata string (filename, track name). */
  metadataTextLength: 256,
  /** Serialized normalized output bytes. */
  normalizedBytes: 8 * 1024 * 1024,
  /** Lap messages read from one FIT stream. */
  lapsPerStream: 1_000,
  /** Timer/event messages read from one FIT stream. */
  eventsPerStream: 1_000,
  /** Wall-clock budget for one parse. */
  parseMilliseconds: 5_000,
  /**
   * Budget for the bytes a parse allocates, charged as the work happens: decoded text,
   * raw samples, normalized samples and serialized output. It is an accounted estimate
   * that fails before the allocation is made, not a measurement of process heap.
   */
  parseMemoryBytes: 192 * 1024 * 1024,
  /** Concurrent parse workers per process. */
  workerConcurrency: 2,
  /** Vertices in one displayed MapPath line. */
  pathVertices: 50_000,
} as const;

const ordinal = z.number().int().min(0).max(999_999);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a lowercase SHA-256 hex digest');
const heartRate = z.number().int().min(0).max(255).nullable();
const nonNegativeMetric = z.number().finite().nonnegative().max(1_000_000_000).nullable();
const elevationMeters = z.number().finite().min(-12_000).max(12_000).nullable();
/** Control, C1 and bidirectional-override code points, checked without a control regex. */
const hasUnsafeCharacter = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    )
      return true;
  }
  return false;
};

/**
 * Filenames and GPX metadata are untrusted text. Control, bidirectional-override and
 * angle-bracket characters are rejected outright rather than escaped downstream.
 */
export const trackTextSchema = z
  .string()
  .min(1)
  .max(trackLimits.metadataTextLength)
  .refine(
    (value) => !hasUnsafeCharacter(value),
    'Control or bidirectional override characters are not allowed',
  )
  .refine((value) => !/[<>]/u.test(value), 'Angle brackets are not allowed in track metadata');

export const trackFormatSchema = z.enum(['fit', 'gpx']);
/** Parser identity is part of sample correspondence: a different parser is a different id. */
export const trackParserIdSchema = z.enum(['fit-track-v1', 'gpx-track-v1', 'fit-python-export-v1']);

/**
 * WGS84 `[longitude, latitude]`. Exactly two finite dimensions: time, heart rate and
 * elevation are sample fields, never extra GeoJSON coordinate dimensions.
 */
export const trackPositionSchema = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
]);
export type TrackPosition = z.infer<typeof trackPositionSchema>;

/**
 * `${streamIndex}:${sourceIndex}`. Stable within one source stream/revision. If a re-parse
 * changes which observation an id denotes, that is a new track revision, not a mutation.
 */
export const trackSampleIdSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,2}):(?:0|[1-9][0-9]{0,5})$/, 'Expected `streamIndex:sourceIndex`');
export const makeTrackSampleId = (streamIndex: number, sourceIndex: number): string =>
  `${streamIndex}:${sourceIndex}`;

/** Local preview provenance. There is no Activity here and none may be fabricated. */
export const localFileProvenanceSchema = z.strictObject({
  kind: z.literal('local-file'),
  format: trackFormatSchema,
  fileSha256: sha256Schema,
  fileByteLength: z.number().int().min(1).max(trackLimits.fileBytes),
  parserId: trackParserIdSchema,
  parserVersion: z.literal(1),
  streamIndex: z
    .number()
    .int()
    .min(0)
    .max(trackLimits.streams - 1),
  /** Ordinal of this track within its stream (FIT session order). Distinguishes siblings. */
  sourceItemIndex: z
    .number()
    .int()
    .min(0)
    .max(trackLimits.tracksPerFile - 1),
  /** Sanitized source label (`trk/name`, FIT session ordinal); never an Activity title. */
  streamLabel: trackTextSchema.nullable(),
});

/** Stored-track provenance, linked by an explicit server-side import result. */
export const activitySourceProvenanceSchema = z.strictObject({
  kind: z.literal('activity-source'),
  activityId: idSchema,
  sourceId: idSchema,
  sourceRevision: revisionSchema,
  trackRevision: revisionSchema.min(1),
});

export const trackProvenanceSchema = z.discriminatedUnion('kind', [
  localFileProvenanceSchema,
  activitySourceProvenanceSchema,
]);
export type TrackProvenance = z.infer<typeof trackProvenanceSchema>;

/**
 * Explicit link to the GPS-free detail contract. `detailSchemaVersion` names the
 * `activity-details.ts` version whose `records[].index` this sample corresponds to; the
 * detail payload itself keeps rejecting coordinates.
 */
export const trackDetailLinkSchema = z.strictObject({
  detailSchemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  streamIndex: z.number().int().min(0).max(127),
  sessionIndex: z.number().int().min(0).max(99),
  recordIndex: z
    .number()
    .int()
    .min(0)
    .max(activityDetailLimits.records - 1),
});

export const trackSampleSchema = z.strictObject({
  sampleId: trackSampleIdSchema,
  sourceIndex: ordinal,
  recordedAt: instantSchema.nullable(),
  /** `null` means "no fix": the sample keeps its other measurements and is never invented. */
  position: trackPositionSchema.nullable(),
  elevationMeters,
  /** Device-reported cumulative distance. Not the recomputed or the displayed length. */
  distanceMeters: nonNegativeMetric,
  speedMetersPerSecond: z.number().finite().min(0).max(1_000).nullable(),
  heartRateBpm: heartRate,
  lapIndex: ordinal.nullable(),
  detailLink: trackDetailLinkSchema.nullable(),
});
export type TrackSample = z.infer<typeof trackSampleSchema>;

export const trackSegmentBreakSchema = z.enum([
  'stream-start',
  'gpx-trkseg',
  'fit-session',
  'fit-event-stop',
  'missing-position',
  'time-gap',
  'position-gap',
  'time-reversal',
  'duplicate-timestamp',
  'antimeridian-crossing',
]);
export type TrackSegmentBreak = z.infer<typeof trackSegmentBreakSchema>;

export const trackSegmentSchema = z.strictObject({
  index: ordinal,
  startReason: trackSegmentBreakSchema,
  sampleIds: z.array(trackSampleIdSchema).min(1).max(trackLimits.samples),
});
export type TrackSegment = z.infer<typeof trackSegmentSchema>;

/** The split policy is data, not a hidden constant: a stored track pins the version used. */
export const trackSegmentPolicySchema = z.strictObject({
  version: z.literal(1),
  maxGapSeconds: z.number().int().min(1).max(86_400),
  maxGapMeters: z.number().finite().min(1).max(1_000_000),
});

/**
 * Four different distances exist: device-reported, recomputed from positions, displayed
 * polyline length ({@link mapPathSchema}) and a routing estimate (Course/RouteRevision).
 * Only the first two belong to a recording, and neither overwrites the other.
 */
export const trackDistancesSchema = z.strictObject({
  deviceReportedMeters: nonNegativeMetric,
  recomputedFromPositionsMeters: nonNegativeMetric,
});

export const trackSourceKindSchema = z.enum(['fit-session', 'gpx-trk']);

const checkTrack = (
  track: { samples: readonly TrackSample[]; segments: readonly TrackSegment[] },
  context: z.core.$RefinementCtx,
): void => {
  const known = new Set<string>();
  let previousIndex = -1;
  track.samples.forEach((sample, index) => {
    const [, source] = sample.sampleId.split(':');
    if (Number(source) !== sample.sourceIndex)
      context.addIssue({
        code: 'custom',
        path: ['samples', index, 'sampleId'],
        message: 'Sample id must encode its own source index',
      });
    if (known.has(sample.sampleId) || sample.sourceIndex <= previousIndex)
      context.addIssue({
        code: 'custom',
        path: ['samples', index, 'sampleId'],
        message: 'Sample ids must be unique and source order must increase',
      });
    known.add(sample.sampleId);
    previousIndex = sample.sourceIndex;
  });
  const assigned = new Set<string>();
  track.segments.forEach((segment, index) => {
    if (segment.index !== index)
      context.addIssue({
        code: 'custom',
        path: ['segments', index, 'index'],
        message: 'Segment indices must be dense and ordered',
      });
    for (const sampleId of segment.sampleIds) {
      if (!known.has(sampleId) || assigned.has(sampleId))
        context.addIssue({
          code: 'custom',
          path: ['segments', index, 'sampleIds'],
          message: 'Segments must reference each known sample at most once',
        });
      assigned.add(sampleId);
    }
  });
  if (assigned.size !== known.size)
    context.addIssue({
      code: 'custom',
      path: ['segments'],
      message: 'Every sample must belong to exactly one segment',
    });
};

/** An actually recorded track: FIT record messages or a GPX `trk`. Never a GPX `rte`. */
export const recordedTrackSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    provenance: trackProvenanceSchema,
    sourceKind: trackSourceKindSchema,
    name: trackTextSchema.nullable(),
    samples: z.array(trackSampleSchema).min(1).max(trackLimits.samples),
    segments: z.array(trackSegmentSchema).min(1).max(trackLimits.segments),
    segmentPolicy: trackSegmentPolicySchema,
    distances: trackDistancesSchema,
  })
  .superRefine(checkTrack);
export type RecordedTrack = z.infer<typeof recordedTrackSchema>;

/**
 * A GPX `rte` is a planned line. It stays separate, is never promoted into a recorded
 * actual, and its points are not recorded observations.
 */
export const plannedRouteSchema = z.strictObject({
  schemaVersion: z.literal(1),
  provenance: localFileProvenanceSchema,
  sourceKind: z.literal('gpx-rte'),
  name: trackTextSchema.nullable(),
  points: z
    .array(
      z.strictObject({
        sourceIndex: ordinal,
        position: trackPositionSchema,
        elevationMeters,
        name: trackTextSchema.nullable(),
      }),
    )
    .min(1)
    .max(trackLimits.samples),
});
export type PlannedRoute = z.infer<typeof plannedRouteSchema>;

export const trackWaypointSchema = z.strictObject({
  sourceIndex: ordinal,
  position: trackPositionSchema,
  elevationMeters,
  name: trackTextSchema.nullable(),
});

/** Private original file record. Re-parsing never overwrites it. */
export const rawTrackFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ownerAthleteId: idSchema,
  importId: idSchema,
  /** Server-generated object key; a client-supplied storage key is never trusted. */
  objectKey: idSchema,
  format: trackFormatSchema,
  byteLength: z.number().int().min(1).max(trackLimits.fileBytes),
  sha256: sha256Schema,
  originalFilename: trackTextSchema.nullable(),
  sourceOrigin: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('user-upload') }),
    z.strictObject({
      kind: z.literal('activity-source'),
      activityId: idSchema,
      sourceId: idSchema,
      sourceRevision: revisionSchema,
    }),
  ]),
  parserId: trackParserIdSchema,
  parserVersion: z.literal(1),
  receivedAt: instantSchema,
});

/**
 * One parsed file. Multiple tracks/sessions are listed, never merged: a consumer must
 * select explicitly when `requiresSelection` is true.
 */
export const parsedTrackFileSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    format: trackFormatSchema,
    fileSha256: sha256Schema,
    fileByteLength: z.number().int().min(1).max(trackLimits.fileBytes),
    parserId: trackParserIdSchema,
    parserVersion: z.literal(1),
    originalFilename: trackTextSchema.nullable(),
    /**
     * What the file declared produced it (GPX `creator`). Untrusted text, and a fact about
     * the file rather than an authority: nothing about how the file is parsed depends on
     * it. Absent in documents written before it existed, which read as `null`.
     */
    creator: trackTextSchema.nullable().default(null),
    recorded: z.array(recordedTrackSchema).max(trackLimits.tracksPerFile),
    routes: z.array(plannedRouteSchema).max(trackLimits.tracksPerFile),
    waypoints: z.array(trackWaypointSchema).max(trackLimits.samples),
    requiresSelection: z.boolean(),
  })
  .superRefine((file, context) => {
    if (file.requiresSelection !== file.recorded.length + file.routes.length > 1)
      context.addIssue({
        code: 'custom',
        path: ['requiresSelection'],
        message: 'Multiple tracks or routes require explicit selection',
      });
    if (file.recorded.length + file.routes.length > trackLimits.tracksPerFile)
      context.addIssue({ code: 'custom', message: 'File exceeds the track count limit' });
  });
export type ParsedTrackFile = z.infer<typeof parsedTrackFileSchema>;

export const mapPathRoleSchema = z.enum(['recorded', 'planned', 'candidate']);
export const insufficientPathReasonSchema = z.enum(['single-point', 'no-position']);

/**
 * Display geometry. Vertex indices are display indices mapped back to source sample ids;
 * they are never reused as source time-series indices. A segment that cannot form a line
 * is reported as a point or an insufficient state, never as a drawn line.
 */
export const mapPathSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    role: mapPathRoleSchema,
    sourceRevision: trackProvenanceSchema,
    simplificationVersion: z.literal(1),
    toleranceMeters: z.number().finite().min(0).max(1_000),
    geometry: z.strictObject({
      type: z.literal('MultiLineString'),
      coordinates: z
        .array(z.array(trackPositionSchema).min(2).max(trackLimits.pathVertices))
        .max(trackLimits.segments),
    }),
    /** Per line, per vertex: the source sample the displayed vertex came from. */
    vertexSampleIds: z.array(z.array(trackSampleIdSchema).min(2)).max(trackLimits.segments),
    /** Per line: the source segment index it renders. */
    lineSegmentIndices: z.array(ordinal).max(trackLimits.segments),
    points: z
      .array(
        z.strictObject({
          segmentIndex: ordinal,
          sampleId: trackSampleIdSchema,
          position: trackPositionSchema,
        }),
      )
      .max(trackLimits.segments),
    insufficient: z
      .array(
        z.strictObject({
          segmentIndex: ordinal,
          reason: insufficientPathReasonSchema,
          sampleIds: z.array(trackSampleIdSchema).min(1),
        }),
      )
      .max(trackLimits.segments),
    /** Length of the drawn line only. Never a training distance. */
    displayedPolylineLengthMeters: z.number().finite().nonnegative().nullable(),
    /** True when a line crosses the antimeridian and was split for display. */
    crossesAntimeridian: z.boolean(),
    /** True when a position lies outside the web-mercator display latitude range. */
    outsideDisplayLatitude: z.boolean(),
  })
  .superRefine((path, context) => {
    if (
      path.vertexSampleIds.length !== path.geometry.coordinates.length ||
      path.lineSegmentIndices.length !== path.geometry.coordinates.length
    )
      context.addIssue({
        code: 'custom',
        path: ['vertexSampleIds'],
        message: 'Every line needs a matching sample mapping and source segment index',
      });
    path.geometry.coordinates.forEach((line, index) => {
      if (line.length !== path.vertexSampleIds[index]?.length)
        context.addIssue({
          code: 'custom',
          path: ['vertexSampleIds', index],
          message: 'Vertex to sample mapping must cover every vertex',
        });
    });
  });
export type MapPath = z.infer<typeof mapPathSchema>;

/**
 * Aggregates derived from samples. Simplification, zoom and level-of-detail changes must
 * not change any of these values; only the MapPath display length may change.
 */
export const trackAggregatesSchema = z.strictObject({
  sampleCount: z.number().int().nonnegative(),
  positionedSampleCount: z.number().int().nonnegative(),
  segmentCount: z.number().int().nonnegative(),
  elapsedSeconds: z.number().finite().nonnegative().nullable(),
  deviceDistanceMeters: nonNegativeMetric,
  recomputedDistanceMeters: nonNegativeMetric,
  averagePaceSecondsPerKilometer: z.number().finite().positive().nullable(),
  averageHeartRateBpm: z.number().finite().min(0).max(255).nullable(),
});
export type TrackAggregates = z.infer<typeof trackAggregatesSchema>;

/** Future track schema versions join this union; v1 keeps its exact interpretation. */
export const trackDocumentSchema = z.discriminatedUnion('schemaVersion', [recordedTrackSchema]);
