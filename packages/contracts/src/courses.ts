import { idSchema, instantSchema, revisionSchema } from './primitives.js';
import {
  routeComputationRecordSchema,
  routingGraphIdentitySchema,
  routingLimits,
  snappedWaypointSchema,
} from './routing.js';
import {
  trackLimits,
  trackParserIdSchema,
  trackSampleIdSchema,
  trackTextSchema,
} from './tracks.js';
import { z } from 'zod';

/**
 * Course ledger contract (M2-01f).
 *
 * A Course is planned data with its own identity. It is never an Activity, never an
 * approved PlanVersion and never a recorded actual: editing a course cannot reach either
 * of those, and the coordinates a course was derived from stay in the recording that owns
 * them. A `CourseRevision` is immutable — geometry, waypoints, the conditions it was
 * generated under and the source revision it came from are all fixed when it is written,
 * and an edit appends the next revision instead of rewriting one.
 *
 * Courses are private. There is no visibility value other than `private` and no sharing
 * field anywhere in this file: public sharing waits for its own requirements, ACL and
 * re-identification review.
 */
export const courseLimits = {
  /** Vertices in one course geometry. */
  vertices: 20_000,
  /** Waypoints on one course, start and finish included. */
  waypoints: 12,
  /** Revisions one course may accumulate. */
  revisionsPerCourse: 50,
  /** Courses one tenant may keep. */
  coursesPerTenant: 200,
  /** Serialized bytes of one revision's geometry. */
  geometryBytes: 1024 * 1024,
  /** Course name characters. */
  nameLength: 120,
  /** Unconsumed route proposals one course may hold at a time. */
  openRouteProposalsPerCourse: 5,
  /** Unconsumed route proposals one tenant may hold at a time. */
  openRouteProposalsPerTenant: 20,
  /** How long a stored route proposal stays usable before it must be recomputed. */
  routeProposalTtlSeconds: 30 * 60,
  /** Draft edits one editing session may number. A draft revision never goes backwards. */
  maxDraftRevision: 1_000_000,
  /** Bytes of one imported file. Smaller than the parser's own file bound on purpose. */
  importFileBytes: 4 * 1024 * 1024,
  /** Protected areas one owner may keep. */
  privacyZonesPerTenant: 20,
  /** Radius of one protected area. A pin-point area protects nothing. */
  privacyZoneMinRadiusMeters: 50,
  privacyZoneMaxRadiusMeters: 5_000,
  /** Characters of one place-search query. */
  placeQueryLength: 80,
  /** Places one search may answer with. */
  placeResults: 20,
  /** Vertices one elevation profile reports on. A long course is sampled, never summarised. */
  elevationProfilePoints: 200,
} as const;

/**
 * Bounds for the STORED map thumbnail of a course revision (M2-01l, plan section 5).
 *
 * A thumbnail is private derived location data: it is a picture of where its owner has
 * been, so it follows the permission, deletion and export policy of the course it was
 * drawn from. Everything about it that could grow is fixed here rather than negotiated
 * per request — the picture has one viewport, one vertex budget and one byte ceiling, and
 * none of the three is client-supplied.
 *
 * It is an SVG and not a raster image on purpose. The projection that draws this line is
 * right here, shared by the browser and the server; emitting the same path as markup needs
 * no rasteriser and no new native runtime dependency in the worker, and it produces a
 * byte-stable artefact for a given revision, which is what makes a content hash mean
 * anything. The markup this product writes is one `path` element built from validated
 * finite numbers, with no user text in it at all.
 */
export const courseThumbnailLimits = {
  /** Square viewport, in SVG user units. The drawn line is centred inside `span`. */
  viewport: 100,
  span: 96,
  /** Vertices the picture may draw. A course may carry 20,000. */
  vertexBudget: 400,
  /** Hard ceiling on one stored thumbnail. The renderer's own output is far below it. */
  maxBytes: 64 * 1024,
  /** Stored thumbnail bytes one tenant may hold. */
  tenantBytes: 16 * 1024 * 1024,
  /** Render attempts one revision's thumbnail gets before it is abandoned. */
  maxAttempts: 5,
  /** How long a queued render may stay unfinished before it is reaped. */
  jobTtlSeconds: 60 * 60,
} as const;
/** Stored thumbnails are SVG. See `courseThumbnailLimits` for why. */
export const courseThumbnailMediaType = 'image/svg+xml';
/**
 * The colour both thumbnails draw the line in.
 *
 * It is a literal here rather than `currentColor` because the stored picture is embedded
 * through an `img` element, which makes it an independent document: `currentColor` there
 * resolves to that document's initial colour — black — not to the page's. The drawn
 * fallback used to inherit the page colour, so the two pictures changed appearance the
 * moment one replaced the other. Now both take the colour from here, which is the same
 * definition, so a swap cannot be visible.
 */
export const courseThumbnailStrokeColor = '#2b6cb0';
/** Identity of the renderer that produced a stored thumbnail. */
export const courseThumbnailRendererId = 'course-thumbnail-svg-v1';
export const courseThumbnailRendererVersion = 1;

/**
 * Evenly spaced sample of a long line, down to the vertex budget.
 *
 * Deterministic by construction: the same coordinates always yield the same sample, which
 * is what lets a stored picture be content-addressed.
 */
export function sampleCourseThumbnailVertices(
  coordinates: readonly CoursePosition[],
): readonly CoursePosition[] {
  const budget = courseThumbnailLimits.vertexBudget;
  if (coordinates.length <= budget) return coordinates;
  const step = (coordinates.length - 1) / (budget - 1);
  const sampled: CoursePosition[] = [];
  for (let index = 0; index < budget; index += 1) {
    const position = coordinates[Math.round(index * step)];
    if (position !== undefined) sampled.push(position);
  }
  return sampled;
}

/**
 * The one definition of how a course line becomes a thumbnail path.
 *
 * The browser draws it inline and the worker stores it as markup; both call this, so the
 * stored picture and the fallback the screen draws when there is none cannot disagree
 * about the shape of a line. `null` means the line is too short to draw — a single vertex
 * is a point, and stretching a point into a picture would invent a shape nobody recorded.
 */
export function courseThumbnailPath(
  coordinates: readonly CoursePosition[],
): { readonly path: string; readonly vertexCount: number } | null {
  if (coordinates.length < 2) return null;
  const points = sampleCourseThumbnailVertices(coordinates);
  const longitudes = points.map((position) => position[0]);
  const latitudes = points.map((position) => position[1]);
  const west = Math.min(...longitudes);
  const east = Math.max(...longitudes);
  const south = Math.min(...latitudes);
  const north = Math.max(...latitudes);
  // A degree of longitude is shorter than a degree of latitude everywhere but the equator,
  // so drawing both at the same scale stretches the picture sideways — about 27% at
  // Seoul's latitude, enough to turn a there-and-back into a shape the owner does not
  // recognise. One cosine at the middle latitude gives the picture the real proportions.
  const shrinkX = Math.cos((((north + south) / 2) * Math.PI) / 180);
  // A course can be a straight north-south line, so neither span may divide by zero.
  const spanX = (east - west) * shrinkX || 1e-6;
  const spanY = north - south || 1e-6;
  const { viewport, span } = courseThumbnailLimits;
  const scale = Math.min(span / spanX, span / spanY);
  const offsetX = (viewport - spanX * scale) / 2;
  const offsetY = (viewport - spanY * scale) / 2;
  const path = points
    .map((position, index) => {
      const x = offsetX + (position[0] - west) * shrinkX * scale;
      // SVG y grows downward; north belongs at the top.
      const y = offsetY + (north - position[1]) * scale;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
  return { path, vertexCount: points.length };
}

/**
 * Bounds for one target-distance candidate search (M2-01i).
 *
 * A target distance is an APPROXIMATION, not a specification. Everything about the search
 * that could run away is bounded here — how many candidates it may offer, how many engine
 * computations it may spend, how long it may take and how far from the origin it may
 * wander — and every bound is reported with the result so a reader can see what the search
 * was allowed to do.
 */
export const targetDistanceLimits = {
  minTargetMeters: 500,
  maxTargetMeters: 50_000,
  /** Candidates one search may offer. */
  maxCandidates: 4,
  /** Engine computations one search may spend, accepted and rejected alike. */
  maxAttempts: 8,
  /** Wall-clock budget for the whole search, measured by the server's own clock. */
  searchBudgetMilliseconds: 30_000,
  /** How far off the target a candidate may land and still be offered at all. */
  distanceToleranceRatio: 0.25,
  /** Gap between first and last vertex under which the line is called a closed loop. */
  loopClosureMeters: 30,
  /** Shared length above which a new candidate is the same proposal as an accepted one. */
  duplicateOverlapRatio: 0.8,
  /** Hard cap on how far from the origin any vertex of a candidate may lie. */
  maxSearchRadiusMeters: 15_000,
  /** Rounding used to compare two lines section by section, in degrees. */
  sectionGridDegrees: 0.00005,
} as const;

const uuid = z.uuid().transform((value) => value.toLowerCase());
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a lowercase SHA-256 hex digest');

/**
 * WGS84 `[longitude, latitude]`, exactly two finite dimensions. Deliberately its own
 * schema rather than a recorded-track position: a course vertex is planned geometry, not
 * an observation, and it carries no time, heart rate or elevation.
 */
export const coursePositionSchema = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
]);
export type CoursePosition = z.infer<typeof coursePositionSchema>;

/**
 * A course name is untrusted text held to the same rule as track metadata: control,
 * bidirectional-override and angle-bracket characters are refused rather than escaped
 * somewhere downstream.
 */
export const courseNameSchema = z.string().max(courseLimits.nameLength).pipe(trackTextSchema);

/**
 * A waypoint is planned input. `via` waypoints are added by the waypoint editor (M2-01h);
 * a course derived from a recorded segment starts with exactly its two ends.
 */
export const courseWaypointSchema = z.strictObject({
  role: z.enum(['start', 'via', 'finish']),
  position: coursePositionSchema,
  name: courseNameSchema.nullable(),
  /**
   * The recorded sample this waypoint was taken from, when it came from a recording.
   * It names an observation in the source track revision; it is not an index into the
   * course geometry.
   */
  sourceSampleId: trackSampleIdSchema.nullable(),
  /**
   * A locked waypoint is one the owner has pinned: the editor refuses to move, reorder or
   * remove it until it is unlocked, and candidate generation (M2-01i) must keep it.
   * Absent in revisions written before the waypoint editor existed, which read as false —
   * so a stored revision from M2-01f keeps its content digest.
   */
  locked: z.boolean().default(false),
});
export type CourseWaypoint = z.infer<typeof courseWaypointSchema>;

/**
 * An ordered waypoint list: exactly one `start` first, exactly one `finish` last and only
 * `via` in between. The roles are positional facts, so a list that disagrees with itself is
 * refused here rather than being normalised into something the user did not ask for.
 */
export const courseWaypointListSchema = z
  .array(courseWaypointSchema)
  .min(2)
  .max(courseLimits.waypoints)
  .superRefine((waypoints, context) => {
    for (const [index, waypoint] of waypoints.entries()) {
      const expected =
        index === 0 ? 'start' : index === waypoints.length - 1 ? 'finish' : ('via' as const);
      if (waypoint.role !== expected)
        context.addIssue({
          code: 'custom',
          path: [index, 'role'],
          message: `Expected the ${expected} role at position ${index}`,
        });
    }
  });

const seedSchema = z.string().regex(/^[0-9a-f]{16}$/, 'Expected a 16 character hex seed');

/**
 * What one generated candidate was measured to be (M2-01i), version 1.
 *
 * Every field here is either measured from the candidate's own line or copied from the
 * computation that produced it. There are **no coordinates**: the same rule the routed
 * conditions follow, because the account export carries generation conditions verbatim.
 *
 * `knowledge` is the part that matters most and it is deliberately unforgiving. The plan
 * forbids treating a missing stair, surface or night-access fact as satisfied, and our
 * engine result carries none of them — the road-class detail M2-01g requests is used to
 * check the answer and is not returned. So each of those is typed as the literal
 * `'unknown'`: writing anything else is a contract change, not a value a caller can set.
 * The same goes for gradient — there is no elevation source in this build at all.
 */
export const courseCandidateKnowledgeSchema = z.strictObject({
  stairs: z.literal('unknown'),
  surface: z.literal('unknown'),
  nightAccess: z.literal('unknown'),
  accessRestrictions: z.literal('unknown'),
  gradient: z.literal('unknown'),
});

export const courseCandidateEvaluationSchema = z.strictObject({
  evaluationVersion: z.literal(1),
  /** The approximation asked for. Never an achieved distance. */
  targetDistanceMeters: z.number().finite().min(1).max(targetDistanceLimits.maxTargetMeters),
  /** The engine's estimate along this line. */
  engineDistanceMeters: z.number().finite().nonnegative().max(routingLimits.maxRouteDistanceMeters),
  /** The length of the line as stored, measured from its own vertices. A different value. */
  plannedLineMeters: z.number().finite().nonnegative().max(1_000_000_000),
  /** Signed error of the engine estimate against the target. Positive means longer. */
  distanceErrorMeters: z.number().finite(),
  distanceErrorRatio: z.number().finite(),
  /** Loop closure measured between the first and the last vertex. */
  loop: z.strictObject({
    closed: z.boolean(),
    gapMeters: z.number().finite().nonnegative().max(1_000_000),
  }),
  /**
   * Every leg of this candidate is an answer the routing adapter accepted, which means the
   * engine attested the graph edges it traversed. It is evidence of connectivity in the
   * graph and nothing more: it is not a claim that a person can walk there now.
   */
  connectivity: z.literal('engine-attested-edges'),
  /** Length of the line covered more than once, and whether it is an out-and-back. */
  repetition: z.strictObject({
    repeatedMeters: z.number().finite().nonnegative().max(1_000_000_000),
    repeatedRatio: z.number().finite().min(0).max(1),
    outAndBack: z.boolean(),
  }),
  knowledge: courseCandidateKnowledgeSchema,
  /** Where gradient information came from. `none` means this build has none. */
  gradientSource: z.literal('none'),
  maxSnapDistanceMeters: z.number().finite().nonnegative().max(routingLimits.maxSnapMeters),
  waypointCount: z.number().int().min(2).max(courseLimits.waypoints),
  vertexCount: z.number().int().min(2).max(courseLimits.vertices),
});
export type CourseCandidateEvaluation = z.infer<typeof courseCandidateEvaluationSchema>;

/**
 * How one course revision's geometry was generated, and under what conditions.
 *
 * `recorded-segment` means the server re-read the stored map-path derivative of a track
 * revision and cut the explicitly selected inclusive sample range out of a single drawn
 * line. The content hash of that derivative is part of the conditions, so a revision
 * always names the exact bytes it was cut from.
 *
 * `routed-waypoints` (M2-01h) means our own pedestrian engine answered for an explicit
 * ordered waypoint list and the owner reviewed that answer before it was saved. It carries
 * the whole {@link routeComputationRecordSchema} — engine, profile, graph identity,
 * conditions, request revision, computation time — plus the engine's own distance estimate
 * and the warnings it came with, because a stored route is only comparable to another one
 * computed from the same identity. It carries **no coordinates**: the geometry lives in the
 * revision and the waypoints in its waypoint list, and the account export deliberately
 * takes the conditions without either.
 *
 * These are geometry conditions, not an edit history: a revision that only renames the
 * course keeps the conditions its geometry was generated under. What kind of edit produced
 * a revision is {@link courseEditSchema}.
 */
export const courseGenerationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('recorded-segment'),
    activityId: uuid,
    trackId: uuid,
    trackRevision: revisionSchema.min(1),
    /** Index of the drawn line the range was cut from. A range never spans two lines. */
    lineIndex: z.number().int().min(0).max(1_999),
    /** Source segment index that line renders. Display index and source index stay apart. */
    segmentIndex: z.number().int().min(0).max(999_999),
    startSampleId: trackSampleIdSchema,
    endSampleId: trackSampleIdSchema,
    vertexCount: z.number().int().min(2).max(courseLimits.vertices),
    mapPathContentSha256: sha256Schema,
    simplificationVersion: z.literal(1),
    toleranceMeters: z.number().finite().min(0).max(1_000),
  }),
  z.strictObject({
    kind: z.literal('routed-waypoints'),
    computation: routeComputationRecordSchema,
    /** The engine's estimate along the computed line. Never a recorded or planned actual. */
    engineDistanceMeters: z
      .number()
      .finite()
      .nonnegative()
      .max(routingLimits.maxRouteDistanceMeters),
    /** The engine's walking-time estimate. Never an actual duration. */
    engineDurationSeconds: z
      .number()
      .finite()
      .nonnegative()
      .max(30 * 24 * 3600),
    /** Furthest any waypoint had to move onto the network to be routed from. */
    maxSnapDistanceMeters: z.number().finite().nonnegative().max(routingLimits.maxSnapMeters),
    waypointCount: z.number().int().min(2).max(courseLimits.waypoints),
    vertexCount: z.number().int().min(2).max(courseLimits.vertices),
  }),
  /**
   * `target-distance-loop` (M2-01i) means a bounded search generated this line as one
   * candidate for an approximate target distance, our own engine computed every leg of it,
   * and the owner picked it and saved it explicitly. The seed of the search and of this
   * attempt, the generator and evaluation versions and the whole evaluation are kept, so
   * the candidate can be reproduced and so a reader can see how far off the target it is
   * rather than assuming it hit it. No coordinate is in here.
   */
  z.strictObject({
    kind: z.literal('target-distance-loop'),
    computation: routeComputationRecordSchema,
    engineDistanceMeters: z
      .number()
      .finite()
      .nonnegative()
      .max(routingLimits.maxRouteDistanceMeters),
    engineDurationSeconds: z
      .number()
      .finite()
      .nonnegative()
      .max(30 * 24 * 3600),
    maxSnapDistanceMeters: z.number().finite().nonnegative().max(routingLimits.maxSnapMeters),
    waypointCount: z.number().int().min(2).max(courseLimits.waypoints),
    vertexCount: z.number().int().min(2).max(courseLimits.vertices),
    targetDistanceMeters: z
      .number()
      .finite()
      .min(targetDistanceLimits.minTargetMeters)
      .max(targetDistanceLimits.maxTargetMeters),
    searchSeed: seedSchema,
    candidateSeed: seedSchema,
    attemptIndex: z
      .number()
      .int()
      .min(0)
      .max(targetDistanceLimits.maxAttempts - 1),
    generatorVersion: z.literal('target-distance-loop-v1'),
    evaluation: courseCandidateEvaluationSchema,
  }),
  /**
   * `imported-file` (M2-01j) means the owner handed us a GPX file and the **server** parsed
   * it under M2-01a's bounds. The line is a planned line whatever the file called it: a
   * GPX `trk` is a recording someone made, and importing it produces a course, never an
   * Activity and never a recorded actual — `sourceKind` keeps saying which of the two the
   * bytes came from so that distinction survives in the ledger.
   *
   * The conditions name the file (hash, length, filename) and the parser that read it, so
   * a stored course says which version of which reader produced its coordinates. They
   * carry **no coordinates**, like every other generation.
   */
  z.strictObject({
    kind: z.literal('imported-file'),
    format: z.literal('gpx'),
    /** Which GPX element the coordinates came from. A `trk` is not promoted to an actual. */
    sourceKind: z.enum(['gpx-trk', 'gpx-rte']),
    /** Which track or route of the file, when it held more than one. */
    itemIndex: z
      .number()
      .int()
      .min(0)
      .max(trackLimits.tracksPerFile - 1),
    parserId: trackParserIdSchema,
    parserVersion: z.literal(1),
    fileSha256: sha256Schema,
    fileByteLength: z.number().int().min(1).max(courseLimits.importFileBytes),
    originalFilename: trackTextSchema.nullable(),
    /** `creator` as the file declared it. Untrusted text, kept as a fact about the file. */
    fileCreator: trackTextSchema.nullable(),
    vertexCount: z.number().int().min(2).max(courseLimits.vertices),
    /** How many of the file's own `wpt` elements became course waypoints. */
    importedWaypointCount: z.number().int().min(0).max(courseLimits.waypoints),
    /** How many were left alone instead of being promoted into the course. */
    ignoredFileWaypointCount: z.number().int().min(0).max(trackLimits.samples),
  }),
  /**
   * `privacy-trimmed` (M2-01j) means this revision is a **derived** one: the vertices that
   * fell inside the owner's protected areas were removed from the line of an earlier
   * revision. It never overwrites that revision — the original stays in the ledger and this
   * one is appended after it.
   *
   * It names the policy version and the identity of the protected-area set it was computed
   * against, never a centre, a radius or a coordinate: the whole point of the trim is that
   * those coordinates stop travelling, and the account export takes these conditions
   * verbatim. `sourceGraphBuildId` is carried over from the revision that was trimmed so a
   * trimmed course still says which graph computed the line underneath it.
   */
  z.strictObject({
    kind: z.literal('privacy-trimmed'),
    sourceRevision: revisionSchema.min(1),
    sourceGenerationKind: z.enum([
      'recorded-segment',
      'routed-waypoints',
      'target-distance-loop',
      'imported-file',
      // Trimming an already trimmed course is allowed: the owner may have added an area.
      'privacy-trimmed',
    ]),
    sourceGraphBuildId: routingGraphIdentitySchema.shape.graphBuildId.nullable(),
    policyVersion: z.literal(1),
    /** Identity of the protected-area set applied. Ids and radii only, never a centre. */
    zoneSetDigest: sha256Schema,
    appliedZoneCount: z.number().int().min(1).max(courseLimits.privacyZonesPerTenant),
    removedVertexCount: z.number().int().min(1).max(courseLimits.vertices),
    removedLeadingVertexCount: z.number().int().min(0).max(courseLimits.vertices),
    removedTrailingVertexCount: z.number().int().min(0).max(courseLimits.vertices),
    removedWaypointCount: z.number().int().min(0).max(courseLimits.waypoints),
    vertexCount: z.number().int().min(2).max(courseLimits.vertices),
  }),
]);
export type CourseGeneration = z.infer<typeof courseGenerationSchema>;

/**
 * The graph a revision's geometry was computed on, or `null` when it was not computed at
 * all. A reroute must name this value back, which is how "a stored course is never
 * silently recomputed on a new graph" becomes something the server can refuse.
 */
export function courseGenerationGraphBuildId(generation: CourseGeneration): string | null {
  switch (generation.kind) {
    case 'recorded-segment':
    case 'imported-file':
      return null;
    // A trimmed revision was not computed by the engine, but the line under it may have
    // been: it carries that graph forward so trimming a course does not quietly turn
    // "computed on graph X" into "never computed".
    case 'privacy-trimmed':
      return generation.sourceGraphBuildId;
    default:
      return generation.computation.graph.graphBuildId;
  }
}

/**
 * What produced this revision. A copy names what it was copied from, which is how an
 * independently edited copy stays traceable; it does not change where the geometry came
 * from, and it never detaches the copy from the recording's lineage.
 */
export const courseEditSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('created') }),
  z.strictObject({ kind: z.literal('renamed') }),
  z.strictObject({ kind: z.literal('retrimmed') }),
  /** The owner edited the waypoints and explicitly saved a reviewed route proposal. */
  z.strictObject({ kind: z.literal('rerouted') }),
  /** The owner picked one generated target-distance candidate and saved it (M2-01i). */
  z.strictObject({ kind: z.literal('generated') }),
  /** The course was created from a file the owner handed us (M2-01j). */
  z.strictObject({ kind: z.literal('imported') }),
  /** The owner made a derived revision with their protected areas removed (M2-01j). */
  z.strictObject({ kind: z.literal('privacy-trimmed') }),
  z.strictObject({
    kind: z.literal('copied'),
    copiedFromCourseId: uuid,
    copiedFromRevision: revisionSchema.min(1),
  }),
]);
export type CourseEdit = z.infer<typeof courseEditSchema>;

/**
 * The recording a revision's coordinates came from. Lineage is a set because a revision
 * inherits every source of the revision it was derived from: an independently edited copy
 * keeps naming the recording it came from, so deleting that activity still reaches it.
 */
export const courseLineageSchema = z.strictObject({
  activityId: uuid,
  trackId: uuid,
  trackRevision: revisionSchema.min(1),
});
export type CourseLineage = z.infer<typeof courseLineageSchema>;

/**
 * One immutable revision. `distanceMeters` is the length of this planned line and nothing
 * else: it is not the device-reported distance, not the distance recomputed from the
 * recording's positions, and not a routing estimate.
 */
export const courseRevisionSchema = z
  .strictObject({
    courseId: uuid,
    courseRevision: revisionSchema.min(1),
    revisionId: uuid,
    name: courseNameSchema,
    geometry: z.strictObject({
      type: z.literal('LineString'),
      coordinates: z.array(coursePositionSchema).min(2).max(courseLimits.vertices),
    }),
    waypoints: courseWaypointListSchema,
    generation: courseGenerationSchema,
    edit: courseEditSchema,
    /**
     * Empty only for a course whose coordinates never came from one of our recordings — an
     * imported file (M2-01j), or a route computed from waypoints placed on an empty map
     * (M2-01r). Every course derived from a recording
     * still names it, and a revision derived from such a course inherits that lineage, so
     * reclamation on activity deletion is unchanged.
     */
    lineage: z.array(courseLineageSchema).max(courseLimits.waypoints),
    distanceMeters: z.number().finite().nonnegative().max(1_000_000_000),
    /** Digest over the revision's content. Equal content under CAS is not a new version. */
    contentDigest: sha256Schema,
    createdAt: instantSchema,
  })
  .superRefine((revision, context) => {
    // A revision cut from a recording must name it. Lineage is how deleting an activity
    // reaches every course derived from its coordinates, so a `recorded-segment` revision
    // without it would be exactly the detached copy the ledger refuses to make — the empty
    // lineage above exists for an imported file, which came from no recording of ours.
    if (revision.generation.kind !== 'recorded-segment') return;
    const generation = revision.generation;
    const named = revision.lineage.some(
      (source) =>
        source.activityId === generation.activityId &&
        source.trackId === generation.trackId &&
        source.trackRevision === generation.trackRevision,
    );
    if (!named)
      context.addIssue({
        code: 'custom',
        path: ['lineage'],
        message: 'A revision cut from a recording must name that recording in its lineage',
      });
  });
export type CourseRevision = z.infer<typeof courseRevisionSchema>;

/**
 * The head of a course. `unavailable` is what is left when the recording a course was
 * derived from is deleted: the reference stays visible to its owner and its revisions are
 * gone, rather than the course silently disappearing or dangling.
 */
export const availableCourseHeadSchema = z.strictObject({
  status: z.literal('available'),
  courseId: uuid,
  name: courseNameSchema,
  visibility: z.literal('private'),
  headRevision: revisionSchema.min(1),
  revisionId: uuid,
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export const unavailableCourseHeadSchema = z.strictObject({
  status: z.literal('unavailable'),
  courseId: uuid,
  name: courseNameSchema,
  visibility: z.literal('private'),
  reason: z.literal('source_activity_deleted'),
  reclaimedAt: instantSchema,
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export const courseHeadSchema = z.discriminatedUnion('status', [
  availableCourseHeadSchema,
  unavailableCourseHeadSchema,
]);
export type CourseHead = z.infer<typeof courseHeadSchema>;

/**
 * What the owner may know about the stored thumbnail of the course they are reading.
 *
 * These are six different facts and the screen must not confuse them. "Not there yet" is
 * not "cannot be made", and neither is "the render failed and is being retried". Every
 * state but `ready` means the screen falls back to drawing the head revision itself, which
 * it can always do because it already holds the coordinates.
 *
 * The state names a **revision**, never just a course. A stored thumbnail belongs to the
 * immutable revision it was drawn from, so a picture can never be a stale view of a line
 * that has since been edited or privacy-trimmed: a new revision gets a new thumbnail, and
 * the superseded one is reclaimed rather than kept.
 *
 * There is no storage key here. The bytes come through the owner's authenticated download
 * of their own course, exactly as a recorded track's geometry does.
 */
export const courseThumbnailStateSchema = z.discriminatedUnion('status', [
  /** No render was ever asked for — a revision written before this feature existed. */
  z.strictObject({ status: z.literal('none') }),
  /** Asked for, not finished. The picture does not exist yet. */
  z.strictObject({
    status: z.literal('pending'),
    courseRevision: revisionSchema.min(1),
    queuedAt: instantSchema,
  }),
  z.strictObject({
    status: z.literal('ready'),
    courseRevision: revisionSchema.min(1),
    revisionId: uuid,
    mediaType: z.literal(courseThumbnailMediaType),
    contentHash: sha256Schema,
    byteSize: z.number().int().min(1).max(courseThumbnailLimits.maxBytes),
    viewport: z.literal(courseThumbnailLimits.viewport),
    /** Vertices actually drawn, which is the course's count capped at the budget. */
    vertexCount: z.number().int().min(2).max(courseThumbnailLimits.vertexBudget),
    rendererId: z.literal(courseThumbnailRendererId),
    rendererVersion: z.literal(courseThumbnailRendererVersion),
    createdAt: instantSchema,
  }),
  /** A picture of this revision cannot be made, and retrying would not change that. */
  z.strictObject({
    status: z.literal('unavailable'),
    courseRevision: revisionSchema.min(1),
    reason: z.literal('line_too_short_to_draw'),
  }),
  /** The render failed and another attempt is scheduled. */
  z.strictObject({
    status: z.literal('retrying'),
    courseRevision: revisionSchema.min(1),
    attemptCount: z.number().int().min(1).max(courseThumbnailLimits.maxAttempts),
    failureCode: z.string().min(1).max(100),
  }),
  /** The render failed and no further attempt will be made. */
  z.strictObject({
    status: z.literal('abandoned'),
    courseRevision: revisionSchema.min(1),
    attemptCount: z.number().int().min(0).max(courseThumbnailLimits.maxAttempts),
    failureCode: z.string().min(1).max(100),
  }),
]);
export type CourseThumbnailState = z.infer<typeof courseThumbnailStateSchema>;

export const courseReadResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('available'),
    course: availableCourseHeadSchema,
    revision: courseRevisionSchema,
    /** State of the stored derivative, never its storage key. */
    thumbnail: courseThumbnailStateSchema,
  }),
  z.strictObject({
    status: z.literal('unavailable'),
    course: unavailableCourseHeadSchema,
  }),
]);
export type CourseReadResult = z.infer<typeof courseReadResultSchema>;

export const courseListSchema = z.strictObject({
  courses: z.array(courseHeadSchema).max(courseLimits.coursesPerTenant),
  total: z.number().int().min(0).max(courseLimits.coursesPerTenant),
});
export type CourseList = z.infer<typeof courseListSchema>;

/**
 * The waypoints of a course started on an empty map (M2-01r, S14 `/courses/new`).
 *
 * Nothing about them came from a recording, so no waypoint may name a recorded sample: a
 * sample id here would claim an observation for a position the owner simply placed, and a
 * course started this way has no lineage for such a claim to point at.
 */
export const courseNewWaypointListSchema = courseWaypointListSchema.superRefine(
  (waypoints, context) => {
    for (const [index, waypoint] of waypoints.entries())
      if (waypoint.sourceSampleId !== null)
        context.addIssue({
          code: 'custom',
          path: [index, 'sourceSampleId'],
          message: 'A waypoint placed on an empty map names no recorded sample',
        });
  },
);

/**
 * Creating a course names a selection, never geometry. The server reads its own stored
 * derivative for the coordinates: a client cannot hand in a line and have it recorded.
 *
 * `routed-waypoints` (M2-01r) is the one kind with no stored derivative behind it: a course
 * started on an empty map from waypoints the owner placed. It still carries no geometry.
 * The server computes the route again with its own engine and writes **its own answer**,
 * and only if that answer is the line the owner reviewed — `reviewedGeometrySha256` is the
 * digest the preview reported, and `acknowledgedGraph.next` the graph it was computed on.
 * A different line or a different graph is refused rather than saved in place of the one
 * that was read.
 */
export const courseCreateRequestSchema = z.strictObject({
  name: courseNameSchema,
  from: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('routed-waypoints'),
      waypoints: courseNewWaypointListSchema,
      /** The draft revision the reviewed preview was computed for. Recorded, not trusted. */
      draftRevision: z.number().int().min(1).max(courseLimits.maxDraftRevision),
      reviewedGeometrySha256: sha256Schema,
      acknowledgedGraph: z.strictObject({
        previous: z.null(),
        next: routingGraphIdentitySchema.shape.graphBuildId,
      }),
    }),
    z.strictObject({
      kind: z.literal('recorded-segment'),
      activityId: uuid,
      /** The revision the selection was made against. A newer stored track is refused. */
      trackRevision: revisionSchema.min(1),
      startSampleId: trackSampleIdSchema,
      endSampleId: trackSampleIdSchema,
    }),
    z.strictObject({
      kind: z.literal('course-copy'),
      courseId: uuid,
      expectedRevision: revisionSchema.min(1),
    }),
  ]),
});
export type CourseCreateRequest = z.infer<typeof courseCreateRequestSchema>;

/**
 * Every write carries the revision it expected to find. A stale expectation is refused;
 * it never merges, and it never silently wins.
 */
export const courseUpdateRequestSchema = z.strictObject({
  expectedRevision: revisionSchema.min(1),
  change: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('rename'), name: courseNameSchema }),
    /** Re-cut from the same stored derivative. The recording itself is never touched. */
    z.strictObject({
      kind: z.literal('retrim'),
      startSampleId: trackSampleIdSchema,
      endSampleId: trackSampleIdSchema,
    }),
    /**
     * Save a route the owner has reviewed.
     *
     * There is no geometry and no waypoint list here on purpose: both come from the stored
     * proposal named by `proposalId`, so a saved course can never carry the geometry of one
     * draft with the waypoints of another. `draftRevision` must be the revision the
     * proposal was computed from — a draft that moved on cannot be saved from a stale
     * computation, it has to be recomputed.
     */
    z.strictObject({
      kind: z.literal('reroute'),
      proposalId: uuid,
      draftRevision: z.number().int().min(1).max(courseLimits.maxDraftRevision),
      /**
       * What the owner reviewed about the graph. `previous` is the graph the course's
       * current head was computed on (`null` when it was not computed at all) and `next` is
       * the graph this proposal was computed on. Both are checked, so a course computed on
       * an older graph cannot be replaced by an answer from a newer one without the screen
       * having shown that the graph changed.
       */
      acknowledgedGraph: z.strictObject({
        previous: routingGraphIdentitySchema.shape.graphBuildId.nullable(),
        next: routingGraphIdentitySchema.shape.graphBuildId,
      }),
    }),
    /**
     * Save the one generated candidate the owner picked (M2-01i).
     *
     * A candidate is a proposal like any other: the geometry and the waypoints come from
     * the stored candidate, never from this request, and `candidateSetId` is checked
     * against the stored row inside the writing transaction so a candidate cannot be
     * saved as if it belonged to a different search. Until this request arrives the course
     * is untouched — generating candidates saves and approves nothing.
     */
    z.strictObject({
      kind: z.literal('pick-candidate'),
      candidateSetId: uuid,
      proposalId: uuid,
      draftRevision: z.number().int().min(1).max(courseLimits.maxDraftRevision),
      acknowledgedGraph: z.strictObject({
        previous: routingGraphIdentitySchema.shape.graphBuildId.nullable(),
        next: routingGraphIdentitySchema.shape.graphBuildId,
      }),
    }),
    /**
     * Append a derived revision with the owner's protected areas removed (M2-01j).
     *
     * There is no geometry here either: the server trims the line it already holds against
     * the protected areas it already holds. `acknowledgedZoneSetDigest` is the identity of
     * the area set the screen showed, so a trim computed against areas that have since
     * changed is refused instead of quietly using a different set. The revision this trims
     * is not rewritten — it stays in the ledger and this one is appended after it.
     */
    z.strictObject({
      kind: z.literal('privacy-trim'),
      acknowledgedZoneSetDigest: sha256Schema,
    }),
  ]),
});
export type CourseUpdateRequest = z.infer<typeof courseUpdateRequestSchema>;

export const courseDeleteRequestSchema = z.strictObject({
  expectedRevision: revisionSchema.min(1),
});

/**
 * What deleting an activity would take with it. The delete confirmation shows this, so a
 * reclamation is never a surprise. Courses are listed by identity and name only.
 */
export const activityDeletionImpactSchema = z.strictObject({
  activityId: uuid,
  /** Digest of exactly this list. The delete command carries it back for re-validation. */
  digest: sha256Schema,
  courses: z
    .array(
      z.strictObject({
        courseId: uuid,
        name: courseNameSchema,
        headRevision: revisionSchema.min(1),
      }),
    )
    .max(courseLimits.coursesPerTenant),
  total: z.number().int().min(0).max(courseLimits.coursesPerTenant),
});
export type ActivityDeletionImpact = z.infer<typeof activityDeletionImpactSchema>;

/** Exported GPX is a personal artifact, not a shareable publication. */
export const courseGpxMediaType = 'application/gpx+xml';
export const courseGpxCreator = 'workout-manager/course-v1';

/**
 * Asking our own engine for a route under the current draft (M2-01h).
 *
 * The request carries waypoints because the owner placed them; it never carries geometry,
 * a distance, an engine, a profile or a URL. `requestId` and `draftRevision` travel with
 * the computation into its record so a result can be matched back to the exact draft it
 * was asked for — a draft that has moved on discards the answer instead of applying it.
 */
export const courseRouteProposalRequestSchema = z.strictObject({
  requestId: idSchema.max(128),
  draftRevision: z.number().int().min(1).max(courseLimits.maxDraftRevision),
  waypoints: courseWaypointListSchema,
});
export type CourseRouteProposalRequest = z.infer<typeof courseRouteProposalRequestSchema>;

/**
 * A computed route the server has stored, waiting for the owner to review it.
 *
 * It is a **proposal**: not an actual, not an approved plan and not yet a course revision.
 * Nothing about the course changes until the owner explicitly saves it, and a proposal that
 * expires or is superseded simply stops being usable.
 */
export const courseRouteProposalSchema = z.strictObject({
  proposalId: uuid,
  courseId: uuid,
  requestId: idSchema.max(128),
  draftRevision: z.number().int().min(1).max(courseLimits.maxDraftRevision),
  waypoints: courseWaypointListSchema,
  geometry: z.strictObject({
    type: z.literal('LineString'),
    coordinates: z.array(coursePositionSchema).min(2).max(courseLimits.vertices),
  }),
  /** The engine's estimate. The planned line length of the saved course is computed separately. */
  engineDistanceMeters: z.number().finite().nonnegative().max(routingLimits.maxRouteDistanceMeters),
  engineDurationSeconds: z
    .number()
    .finite()
    .nonnegative()
    .max(30 * 24 * 3600),
  snappedWaypoints: z.array(snappedWaypointSchema).min(2).max(courseLimits.waypoints),
  computation: routeComputationRecordSchema,
  createdAt: instantSchema,
  expiresAt: instantSchema,
});
export type CourseRouteProposal = z.infer<typeof courseRouteProposalSchema>;

/**
 * What one computation attempt answered.
 *
 * The failures are the ones M2-01g distinguishes, kept distinct here too: NoRoute, outside
 * coverage, excessive snap, timeout, cancellation and overload are different facts, and
 * none of them stores anything or changes the draft. There is no outcome that returns a
 * straight line, and `route_computed` is the only one that produces a proposal.
 */
const routeProposalFailure = <Code extends string>(outcome: Code) =>
  z.strictObject({
    outcome: z.literal(outcome),
    /** The conditions the attempt ran under. Stored nowhere; reported so it can be read. */
    computation: routeComputationRecordSchema,
    /** The draft this attempt belongs to, so a stale answer is recognisable as stale. */
    draftRevision: z.number().int().min(1).max(courseLimits.maxDraftRevision),
  });

export const courseRouteProposalResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('route_computed'),
    proposal: courseRouteProposalSchema,
  }),
  routeProposalFailure('no_route'),
  routeProposalFailure('outside_coverage'),
  routeProposalFailure('snap_too_far'),
  routeProposalFailure('timeout'),
  routeProposalFailure('cancelled'),
  routeProposalFailure('overloaded'),
  routeProposalFailure('compute_budget_exceeded'),
  routeProposalFailure('engine_unavailable'),
  routeProposalFailure('engine_contract_violation'),
  routeProposalFailure('graph_mismatch'),
]);
export type CourseRouteProposalResult = z.infer<typeof courseRouteProposalResultSchema>;

/**
 * Asking for a route under a draft that is not a course yet (M2-01r, `/courses/new`).
 *
 * Same shape as a proposal request, but the waypoints must be ones the owner placed: none
 * of them may name a recorded sample.
 */
export const courseRoutePreviewRequestSchema = z.strictObject({
  requestId: idSchema.max(128),
  draftRevision: z.number().int().min(1).max(courseLimits.maxDraftRevision),
  waypoints: courseNewWaypointListSchema,
});
export type CourseRoutePreviewRequest = z.infer<typeof courseRoutePreviewRequestSchema>;

/**
 * A computed route for a course that does not exist yet.
 *
 * **Nothing is stored.** A preview has no id, no owner row and no expiry because there is no
 * row: a new draft has no course for a stored proposal to belong to, to be reclaimed with or
 * erased with, and storing private coordinates with nothing to hang them on is exactly what
 * the proposal table refuses to do. Saving a new course therefore asks the engine again and
 * writes that answer, and only when its digest equals `geometrySha256` — the digest of this
 * line, computed by the server, which the owner reviewed.
 */
export const courseRoutePreviewSchema = z.strictObject({
  requestId: idSchema.max(128),
  draftRevision: z.number().int().min(1).max(courseLimits.maxDraftRevision),
  waypoints: courseNewWaypointListSchema,
  geometry: z.strictObject({
    type: z.literal('LineString'),
    coordinates: z.array(coursePositionSchema).min(2).max(courseLimits.vertices),
  }),
  geometrySha256: sha256Schema,
  engineDistanceMeters: z.number().finite().nonnegative().max(routingLimits.maxRouteDistanceMeters),
  engineDurationSeconds: z
    .number()
    .finite()
    .nonnegative()
    .max(30 * 24 * 3600),
  snappedWaypoints: z.array(snappedWaypointSchema).min(2).max(courseLimits.waypoints),
  computation: routeComputationRecordSchema,
});
export type CourseRoutePreview = z.infer<typeof courseRoutePreviewSchema>;

export const courseRoutePreviewResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('route_computed'),
    preview: courseRoutePreviewSchema,
  }),
  routeProposalFailure('no_route'),
  routeProposalFailure('outside_coverage'),
  routeProposalFailure('snap_too_far'),
  routeProposalFailure('timeout'),
  routeProposalFailure('cancelled'),
  routeProposalFailure('overloaded'),
  routeProposalFailure('compute_budget_exceeded'),
  routeProposalFailure('engine_unavailable'),
  routeProposalFailure('engine_contract_violation'),
  routeProposalFailure('graph_mismatch'),
]);
export type CourseRoutePreviewResult = z.infer<typeof courseRoutePreviewResultSchema>;

/**
 * Asking for target-distance candidates under the current draft (M2-01i).
 *
 * The target is an approximation and this request says so by carrying bounds nowhere: the
 * bounds are the server's, not the caller's. `seed` is optional — supplying the seed a
 * previous search recorded reruns the same search, which is what makes a candidate
 * reproducible rather than a one-off accident. The waypoints come along because the search
 * starts at the draft's start waypoint and must keep every locked one; it never invents an
 * origin, and it never carries a geometry, an engine, a profile or a URL.
 */
export const courseRouteCandidateRequestSchema = z.strictObject({
  /**
   * Bounded at 120 rather than 128: each attempt appends its index to this id before it
   * reaches the routing contract, which caps request ids at 128.
   */
  requestId: idSchema.max(120),
  draftRevision: z.number().int().min(1).max(courseLimits.maxDraftRevision),
  targetDistanceMeters: z
    .number()
    .finite()
    .min(targetDistanceLimits.minTargetMeters)
    .max(targetDistanceLimits.maxTargetMeters),
  seed: seedSchema.nullable(),
  waypoints: courseWaypointListSchema,
});
export type CourseRouteCandidateRequest = z.infer<typeof courseRouteCandidateRequestSchema>;

/**
 * What one attempt of the search did. Accepted and rejected attempts are both here: a
 * reader has to be able to see that the search spent eight computations and offered two
 * candidates, not just the two.
 */
export const courseCandidateAttemptOutcomeSchema = z.enum([
  'accepted',
  /** Too close to a candidate already offered. Counted, never silently merged. */
  'duplicate',
  /** Outside the distance tolerance. Not offered — an approximation still has a bound. */
  'off_target',
  /** The line did not come back to where it started. */
  'not_a_loop',
  /** A vertex fell outside the search radius this search was allowed. */
  'outside_search_area',
  /** The routing service refused the request before the engine saw it. */
  'request_refused',
  'no_route',
  'outside_coverage',
  'snap_too_far',
  'timeout',
  'cancelled',
  'overloaded',
  'compute_budget_exceeded',
  'engine_unavailable',
  'engine_contract_violation',
  'graph_mismatch',
]);

export const courseCandidateAttemptSchema = z.strictObject({
  attemptIndex: z
    .number()
    .int()
    .min(0)
    .max(targetDistanceLimits.maxAttempts - 1),
  candidateSeed: seedSchema,
  /** The radius this attempt asked for, which is how the search's extent is auditable. */
  requestedRadiusMeters: z
    .number()
    .finite()
    .nonnegative()
    .max(targetDistanceLimits.maxSearchRadiusMeters),
  outcome: courseCandidateAttemptOutcomeSchema,
  /** The engine's distance, when there was one. `null` when no line came back at all. */
  engineDistanceMeters: z
    .number()
    .finite()
    .nonnegative()
    .max(routingLimits.maxRouteDistanceMeters)
    .nullable(),
});

/** Why the search stopped. A bound reached is a different fact from an engine refusal. */
export const courseCandidateStopReasonSchema = z.enum([
  'candidate_limit',
  'attempt_limit',
  'time_budget',
  'engine_refusal',
  'cancelled',
]);

export const courseCandidateSearchSummarySchema = z.strictObject({
  attemptsMade: z.number().int().min(0).max(targetDistanceLimits.maxAttempts),
  elapsedMilliseconds: z.number().int().nonnegative().max(600_000),
  duplicatesDropped: z.number().int().min(0).max(targetDistanceLimits.maxAttempts),
  attempts: z.array(courseCandidateAttemptSchema).max(targetDistanceLimits.maxAttempts),
  stoppedBecause: courseCandidateStopReasonSchema,
});
export type CourseCandidateSearchSummary = z.infer<typeof courseCandidateSearchSummarySchema>;

/** The bounds the search actually ran under, reported with every answer. */
export const courseCandidateBoundsSchema = z.strictObject({
  maxCandidates: z.number().int().min(1).max(targetDistanceLimits.maxCandidates),
  maxAttempts: z.number().int().min(1).max(targetDistanceLimits.maxAttempts),
  searchBudgetMilliseconds: z
    .number()
    .int()
    .min(1)
    .max(targetDistanceLimits.searchBudgetMilliseconds),
  maxSearchRadiusMeters: z.number().finite().min(1).max(targetDistanceLimits.maxSearchRadiusMeters),
  distanceToleranceRatio: z.number().finite().min(0).max(1),
});

/**
 * One generated candidate the server has stored, waiting for the owner to pick it.
 *
 * It is a **proposal**, exactly like a computed reroute: not an actual, not an approved
 * plan and not a course revision. Generating four of these changes nothing about the
 * course, and at most one of them can ever become a revision.
 */
export const courseRouteCandidateSchema = z.strictObject({
  proposalId: uuid,
  ordinal: z
    .number()
    .int()
    .min(0)
    .max(targetDistanceLimits.maxCandidates - 1),
  attemptIndex: z
    .number()
    .int()
    .min(0)
    .max(targetDistanceLimits.maxAttempts - 1),
  candidateSeed: seedSchema,
  waypoints: courseWaypointListSchema,
  geometry: z.strictObject({
    type: z.literal('LineString'),
    coordinates: z.array(coursePositionSchema).min(2).max(courseLimits.vertices),
  }),
  engineDistanceMeters: z.number().finite().nonnegative().max(routingLimits.maxRouteDistanceMeters),
  engineDurationSeconds: z
    .number()
    .finite()
    .nonnegative()
    .max(30 * 24 * 3600),
  snappedWaypoints: z.array(snappedWaypointSchema).min(2).max(courseLimits.waypoints),
  computation: routeComputationRecordSchema,
  evaluation: courseCandidateEvaluationSchema,
});
export type CourseRouteCandidate = z.infer<typeof courseRouteCandidateSchema>;

export const courseRouteCandidateSetSchema = z.strictObject({
  candidateSetId: uuid,
  courseId: uuid,
  requestId: idSchema.max(128),
  draftRevision: z.number().int().min(1).max(courseLimits.maxDraftRevision),
  targetDistanceMeters: z
    .number()
    .finite()
    .min(targetDistanceLimits.minTargetMeters)
    .max(targetDistanceLimits.maxTargetMeters),
  searchSeed: seedSchema,
  generatorVersion: z.literal('target-distance-loop-v1'),
  evaluationVersion: z.literal(1),
  bounds: courseCandidateBoundsSchema,
  search: courseCandidateSearchSummarySchema,
  candidates: z.array(courseRouteCandidateSchema).min(1).max(targetDistanceLimits.maxCandidates),
  createdAt: instantSchema,
  expiresAt: instantSchema,
});
export type CourseRouteCandidateSet = z.infer<typeof courseRouteCandidateSetSchema>;

/**
 * What one candidate search answered.
 *
 * `no_candidate` is a **known** outcome: the search ran inside its bounds, spent its
 * attempts and found nothing worth offering, and it stored nothing. That is a different
 * fact from a timeout or an engine failure, where the result is unknown, and a different
 * fact again from a straight line — which is not an outcome here at all. No outcome in
 * this union carries a geometry the engine did not attest.
 */
const candidateFailure = <Code extends string>(outcome: Code) =>
  z.strictObject({
    outcome: z.literal(outcome),
    courseId: uuid,
    draftRevision: z.number().int().min(1).max(courseLimits.maxDraftRevision),
    targetDistanceMeters: z
      .number()
      .finite()
      .min(targetDistanceLimits.minTargetMeters)
      .max(targetDistanceLimits.maxTargetMeters),
    searchSeed: seedSchema,
    generatorVersion: z.literal('target-distance-loop-v1'),
    evaluationVersion: z.literal(1),
    bounds: courseCandidateBoundsSchema,
    search: courseCandidateSearchSummarySchema,
    /**
     * The conditions of the last attempt that reached the engine, or `null` when none did.
     * A search that was refused before any engine call has no computation to report, and
     * inventing one would claim an observation that never happened.
     */
    computation: routeComputationRecordSchema.nullable(),
  });

export const courseRouteCandidateResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('candidates_generated'),
    set: courseRouteCandidateSetSchema,
  }),
  candidateFailure('no_candidate'),
  candidateFailure('no_route'),
  candidateFailure('outside_coverage'),
  candidateFailure('snap_too_far'),
  candidateFailure('timeout'),
  candidateFailure('cancelled'),
  candidateFailure('overloaded'),
  candidateFailure('compute_budget_exceeded'),
  candidateFailure('engine_unavailable'),
  candidateFailure('engine_contract_violation'),
  candidateFailure('graph_mismatch'),
]);
export type CourseRouteCandidateResult = z.infer<typeof courseRouteCandidateResultSchema>;

/**
 * Importing a GPX file as a course (M2-01j).
 *
 * The bytes are the input, not a parse: the client may have read the file to show a
 * preview, but the server parses it again under M2-01a's bounds and the course is built
 * from **the server's** parse. There is no geometry, no vertex count and no distance in
 * this request, so a client still has no way to hand in a line.
 *
 * `selection` is required when the file holds more than one track or route: the first
 * request answers `requires_selection` with what the file contains, and the owner picks.
 * Nothing is merged and nothing is guessed.
 */
export const courseImportRequestSchema = z.strictObject({
  /** `null` takes the name from the file; a file with no name of its own is refused. */
  name: courseNameSchema.nullable(),
  originalFilename: trackTextSchema.nullable(),
  selection: z
    .strictObject({
      sourceKind: z.enum(['gpx-trk', 'gpx-rte']),
      itemIndex: z
        .number()
        .int()
        .min(0)
        .max(trackLimits.tracksPerFile - 1),
    })
    .nullable(),
  /**
   * The file itself, base64. Bounded here as well as by the route's body limit, and the
   * decoded length is checked against {@link courseLimits.importFileBytes} before a parse
   * is attempted.
   */
  fileBase64: z
    .string()
    .min(4)
    .max(Math.ceil((courseLimits.importFileBytes / 3) * 4) + 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Expected standard base64 without whitespace'),
});
export type CourseImportRequest = z.infer<typeof courseImportRequestSchema>;

/** One importable item the server found in the file. Named as the file named it. */
export const courseImportItemSchema = z.strictObject({
  sourceKind: z.enum(['gpx-trk', 'gpx-rte']),
  itemIndex: z
    .number()
    .int()
    .min(0)
    .max(trackLimits.tracksPerFile - 1),
  name: trackTextSchema.nullable(),
  pointCount: z.number().int().min(0).max(trackLimits.samples),
  /** Points that carry a position. A recorded track may hold samples without one. */
  positionedPointCount: z.number().int().min(0).max(trackLimits.samples),
});

export const courseImportResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('imported'), course: courseReadResultSchema }),
  /** More than one track or route: the owner chooses, we never merge or pick for them. */
  z.strictObject({
    outcome: z.literal('requires_selection'),
    fileSha256: sha256Schema,
    items: z.array(courseImportItemSchema).min(2).max(trackLimits.tracksPerFile),
  }),
]);
export type CourseImportResult = z.infer<typeof courseImportResultSchema>;

/**
 * Per-owner course preferences (M2-01j): a favourite mark and when the course was last
 * used. These are **preferences, not course content** — they never produce a revision,
 * never enter the content digest and never leave this allowlist. Anything else a screen
 * might want to remember about a course is not persisted at all.
 */
export const coursePreferenceSchema = z.strictObject({
  courseId: uuid,
  favourite: z.boolean(),
  lastUsedAt: instantSchema.nullable(),
});
export type CoursePreference = z.infer<typeof coursePreferenceSchema>;

export const coursePreferenceListSchema = z.strictObject({
  preferences: z.array(coursePreferenceSchema).max(courseLimits.coursesPerTenant),
  total: z.number().int().min(0).max(courseLimits.coursesPerTenant),
});
export type CoursePreferenceList = z.infer<typeof coursePreferenceListSchema>;

/**
 * The only two things a screen may write here. `markUsed` records the moment on the
 * server's clock rather than accepting one, so a client cannot backdate or forward-date
 * what it did; `favourite` is the mark itself. Absent fields are left alone.
 */
export const coursePreferenceUpdateSchema = z
  .strictObject({
    favourite: z.boolean().optional(),
    markUsed: z.literal(true).optional(),
  })
  .refine(
    (value) => value.favourite !== undefined || value.markUsed !== undefined,
    'A preference write must change something',
  );
export type CoursePreferenceUpdate = z.infer<typeof coursePreferenceUpdateSchema>;

/**
 * A protected area (M2-01j). Private, per-owner, and the most sensitive coordinate this
 * product holds: it is typically where the owner lives. It is never logged, never part of
 * a course revision's conditions and never leaves an authenticated response to its owner.
 */
export const coursePrivacyZoneSchema = z.strictObject({
  zoneId: uuid,
  name: courseNameSchema,
  center: coursePositionSchema,
  radiusMeters: z
    .number()
    .finite()
    .min(courseLimits.privacyZoneMinRadiusMeters)
    .max(courseLimits.privacyZoneMaxRadiusMeters),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export type CoursePrivacyZone = z.infer<typeof coursePrivacyZoneSchema>;

export const coursePrivacyZoneCreateSchema = coursePrivacyZoneSchema.pick({
  name: true,
  center: true,
  radiusMeters: true,
});

/**
 * The owner's protected areas and the identity of that set. The digest covers zone ids and
 * radii, **never a centre**: it travels with a trim request so a trim computed against a
 * set that has since changed is refused, and it is stored in the trimmed revision's
 * conditions, which the account export carries verbatim.
 */
export const coursePrivacyZoneListSchema = z.strictObject({
  zones: z.array(coursePrivacyZoneSchema).max(courseLimits.privacyZonesPerTenant),
  total: z.number().int().min(0).max(courseLimits.privacyZonesPerTenant),
  zoneSetDigest: sha256Schema,
});
export type CoursePrivacyZoneList = z.infer<typeof coursePrivacyZoneListSchema>;

/**
 * The owner's accessibility note about a course (M2-01r, S13 "접근성 메모").
 *
 * Something the owner wrote down about getting along this course — stairs, a steep ramp, a
 * gate that is locked at night — in their own words. It is **stored data**, private to the
 * owner, and it is not course content: writing it appends no revision, moves no head and
 * enters no content digest, and it is not part of the GPX export. It is a claim by the
 * owner, never a fact the product checked, and the screen says so.
 *
 * It names the head revision it was written against. The course can change afterwards —
 * a reroute or a privacy trim moves the line — and a note about stairs on the old line is
 * not a note about the new one. The screen compares the two and says when the note was
 * written for a line that is no longer the head, rather than letting it read as current.
 *
 * One line of text under the same rule as a course name: control, bidirectional-override
 * and angle-bracket characters are refused, not escaped somewhere downstream.
 */
export const courseAccessibilityNoteTextSchema = trackTextSchema.refine(
  (value) => value === value.trim(),
  'Leading or trailing whitespace is not stored',
);

export const courseAccessibilityNoteSchema = z.strictObject({
  courseId: uuid,
  note: courseAccessibilityNoteTextSchema,
  /** The head revision the owner was looking at when they wrote it. */
  writtenAtRevision: revisionSchema.min(1),
  updatedAt: instantSchema,
});
export type CourseAccessibilityNote = z.infer<typeof courseAccessibilityNoteSchema>;

export const courseAccessibilityNoteListSchema = z.strictObject({
  notes: z.array(courseAccessibilityNoteSchema).max(courseLimits.coursesPerTenant),
  total: z.number().int().min(0).max(courseLimits.coursesPerTenant),
});
export type CourseAccessibilityNoteList = z.infer<typeof courseAccessibilityNoteListSchema>;

/**
 * Write or clear one note. `expectedRevision` is the head the screen was showing: a note
 * written while looking at revision 3 of a course that is now at revision 4 is refused,
 * because the owner has not seen the line it would be recorded against. `null` clears it.
 */
export const courseAccessibilityNoteWriteSchema = z.strictObject({
  expectedRevision: revisionSchema.min(1),
  note: courseAccessibilityNoteTextSchema.nullable(),
});
export type CourseAccessibilityNoteWrite = z.infer<typeof courseAccessibilityNoteWriteSchema>;

export const courseAccessibilityNoteWriteResultSchema = z.strictObject({
  courseId: uuid,
  note: courseAccessibilityNoteSchema.nullable(),
});
export type CourseAccessibilityNoteWriteResult = z.infer<
  typeof courseAccessibilityNoteWriteResultSchema
>;
