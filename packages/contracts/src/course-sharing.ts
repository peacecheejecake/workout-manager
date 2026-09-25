import { courseLimits, courseNameSchema, coursePositionSchema } from './courses.js';
import { instantSchema, localDateSchema, revisionSchema } from './primitives.js';
import { z } from 'zod';

/**
 * What may leave the account from a course (M2-01k-o,
 * `docs/implementation/research/m2-01k-o-sharing-requirement.md`).
 *
 * Two ways out, both behind the same privacy confirmation:
 *
 * - **A. The owner's GPX export.** Always on. The server gives no GPX body without a
 *   confirmation receipt for this revision and this protected-area set.
 * - **B. A view-only unlisted link.** Behind a server flag that is **off by default**. The
 *   link is a 256-bit token in the address fragment; the server keeps only its SHA-256. The
 *   recipient sees a fixed, trimmed snapshot of the confirmed revision and nothing else.
 *
 * There is no public discovery here: no list, no search, no route that names a share by
 * anything but its token. The recipient's read model is an allowlist of its own, never the
 * course read model with fields removed.
 */
export const courseSharingLimits = {
  /** A link's life when the owner does not choose one (D2). */
  shareExpiryDefaultDays: 7,
  /** The longest a link may live (D2). Longer is refused, not clamped. */
  shareExpiryMaxDays: 30,
  /** Active links one owner may hold (D2). */
  activeSharesPerOwner: 20,
  /** Active links one course may hold (D2). */
  activeSharesPerCourse: 5,
  /** Unauthenticated reads per client address per minute (D7). */
  readsPerClientPerMinute: 30,
  /** Reads that matched one link per minute, keyed by the link (D7, R-5). */
  readsPerSharePerMinute: 60,
  /** Failed reads per client address per hour; past it every read is a 404 (D7). */
  failedReadsPerClientPerHour: 100,
  /** How long a rate counter row may outlive its window (B-4: at most two hours). */
  rateCounterRetentionSeconds: 2 * 60 * 60,
  /** Random bytes in one link token (256 bits). */
  shareTokenBytes: 32,
  /** Base64url characters of those bytes, without padding. */
  shareTokenLength: 43,
  /** A share circle is never smaller than this, whatever the protected area's radius (B-1). */
  shareMinimumScaleMeters: 200,
  /** R_eff = 1.5 · S (B-1). */
  shareRadiusFactor: 1.5,
  /** The secret offset is drawn from a disc of radius 0.5 · S (B-1). */
  shareOffsetFactor: 0.5,
  /** Decimal places of every disclosed coordinate except the owner's exact line (R-2). */
  disclosedCoordinateDigits: 5,
  exactCoordinateDigits: 7,
  /** How long a confirmation receipt can be used. It is also bound to a revision and set. */
  confirmationTtlSeconds: 60 * 60,
} as const;

/** Where the recipient's screen lives on either shell. The token follows as `#<token>`. */
export const sharedCourseViewPath = '/shared/course';
/** The one unauthenticated read. POST, so the token travels in the body, never a URL. */
export const sharedCourseReadPath = '/bff/v1/shared/course';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const courseShareTokenSchema = z
  .string()
  .length(courseSharingLimits.shareTokenLength)
  .regex(/^[A-Za-z0-9_-]+$/);

/** What a confirmation is for. The two never stand in for each other. */
export const courseDisclosurePurposeSchema = z.enum(['export', 'share']);
export type CourseDisclosurePurpose = z.infer<typeof courseDisclosurePurposeSchema>;

/**
 * What the confirmed line discloses about its ends.
 *
 * - `trimmed`: the ends inside a protected area were removed (for a link: inside the wider
 *   share circle).
 * - `no-zone-intersection`: the line touches no protected area (no share circle); it
 *   leaves as it is.
 * - `no-zones-exact`: the owner has no protected area; the exact ends leave, after an
 *   explicit warning. Export only (D3a, D3c).
 * - `owner-exact`: the ends lie inside a protected area and the owner chose the exact line
 *   anyway, after an explicit warning. Their own GPX only (D3b).
 */
export const courseDisclosureExposureSchema = z.enum([
  'trimmed',
  'no-zone-intersection',
  'no-zones-exact',
  'owner-exact',
]);
export type CourseDisclosureExposure = z.infer<typeof courseDisclosureExposureSchema>;

/** Why a line cannot be confirmed at all (D3). The owner is told which. */
export const courseDisclosureBlockedReasonSchema = z.enum([
  'COURSE_TRIM_SPLITS_THE_LINE',
  'COURSE_TRIM_LINE_CROSSES_AREA',
  'COURSE_TRIM_REMOVES_EVERYTHING',
]);

/** One line the owner could confirm, exactly as it would leave. */
export const courseDisclosureOptionSchema = z.strictObject({
  exposure: courseDisclosureExposureSchema,
  coordinates: z.array(coursePositionSchema).min(2).max(courseLimits.vertices),
  start: coursePositionSchema,
  finish: coursePositionSchema,
  /** How far the disclosed start is from the course's own start. 0 when unchanged. */
  startShiftMeters: z.number().finite().nonnegative(),
  finishShiftMeters: z.number().finite().nonnegative(),
  vertexCount: z.number().int().min(2).max(courseLimits.vertices),
  distanceMeters: z.number().finite().nonnegative(),
  removedWaypointCount: z.number().int().min(0).max(courseLimits.waypoints),
  coordinateDigits: z.union([
    z.literal(courseSharingLimits.disclosedCoordinateDigits),
    z.literal(courseSharingLimits.exactCoordinateDigits),
  ]),
  /** The owner must tick an explicit warning before this can be confirmed. */
  requiresAcknowledgement: z.boolean(),
  /** Confirming this appends a trimmed revision to the owner's own course (R-10). */
  appendsRevision: z.boolean(),
});
export type CourseDisclosureOption = z.infer<typeof courseDisclosureOptionSchema>;

/**
 * What the confirmation screen shows the owner (§5). Owner-only and authenticated: it
 * names their protected areas, never a centre.
 */
export const courseDisclosurePreviewSchema = z
  .strictObject({
    purpose: courseDisclosurePurposeSchema,
    courseId: uuid,
    courseRevision: revisionSchema.min(1),
    zoneSetDigest: sha256Schema,
    zoneCount: z.number().int().min(0).max(courseLimits.privacyZonesPerTenant),
    outcome: z.enum(['no-zones', 'blocked', 'no-intersection', 'ends-inside']),
    blockedReason: courseDisclosureBlockedReasonSchema.nullable(),
    /** Every protected area by name and how many of the line's vertices each removes. */
    zones: z
      .array(
        z.strictObject({
          name: courseNameSchema,
          removedVertexCount: z.number().int().min(0).max(courseLimits.vertices),
        }),
      )
      .max(courseLimits.privacyZonesPerTenant),
    options: z.array(courseDisclosureOptionSchema).max(2),
    defaultExposure: courseDisclosureExposureSchema.nullable(),
    /** GPX keeps names by default; a link leaves them out by default (D6). */
    includeNamesDefault: z.boolean(),
  })
  .superRefine((preview, context) => {
    if ((preview.outcome === 'blocked') !== (preview.blockedReason !== null))
      context.addIssue({ code: 'custom', path: ['blockedReason'], message: 'Blocked iff reason' });
  });
export type CourseDisclosurePreview = z.infer<typeof courseDisclosurePreviewSchema>;

/**
 * Confirm one option. The server recomputes everything and checks the revision and the
 * protected-area set the screen showed; it trusts none of what it recomputes.
 *
 * A link can never be confirmed on an exact line: `owner-exact` and `no-zones-exact` are
 * refused for `share` by the contract itself (T20(4), D3c).
 */
export const courseDisclosureConfirmationRequestSchema = z
  .strictObject({
    purpose: courseDisclosurePurposeSchema,
    expectedRevision: revisionSchema.min(1),
    acknowledgedZoneSetDigest: sha256Schema,
    exposure: courseDisclosureExposureSchema,
    includeNames: z.boolean(),
    /** The explicit warning tick for `no-zones-exact` and `owner-exact`. */
    acknowledgedRisk: z.boolean(),
  })
  .superRefine((request, context) => {
    if (
      request.purpose === 'share' &&
      (request.exposure === 'owner-exact' || request.exposure === 'no-zones-exact')
    )
      context.addIssue({
        code: 'custom',
        path: ['exposure'],
        message: 'A link never discloses an exact line',
      });
  });
export type CourseDisclosureConfirmationRequest = z.infer<
  typeof courseDisclosureConfirmationRequestSchema
>;

/** A server-side record of what the owner confirmed. It carries no coordinate. */
export const courseDisclosureReceiptSchema = z.strictObject({
  receiptId: uuid,
  purpose: courseDisclosurePurposeSchema,
  courseId: uuid,
  /** The revision the confirmation is for. After a trimmed GPX confirmation, the new one. */
  courseRevision: revisionSchema.min(1),
  zoneSetDigest: sha256Schema,
  exposure: courseDisclosureExposureSchema,
  includeNames: z.boolean(),
  confirmedAt: instantSchema,
  expiresAt: instantSchema,
});
export type CourseDisclosureReceipt = z.infer<typeof courseDisclosureReceiptSchema>;

/** A link as its owner sees it. No token and no digest: the token was shown once. */
export const courseShareSchema = z.strictObject({
  shareId: uuid,
  courseId: uuid,
  courseRevision: revisionSchema.min(1),
  /**
   * `invalidated` is an active link a backup restore made unusable (B-5): it will never
   * be served again, and the owner needs a new confirmation and a new link.
   */
  state: z.enum(['active', 'revoked', 'expired', 'invalidated']),
  revokeReason: z.enum(['owner', 'owner_all', 'zone_added', 'zone_removed']).nullable(),
  includeNames: z.boolean(),
  createdAt: instantSchema,
  expiresAt: instantSchema,
  revokedAt: instantSchema.nullable(),
});
export type CourseShare = z.infer<typeof courseShareSchema>;

export const courseShareListSchema = z.strictObject({
  shares: z.array(courseShareSchema).max(500),
  total: z.number().int().min(0).max(500),
  activeTotal: z.number().int().min(0).max(courseSharingLimits.activeSharesPerOwner),
});
export type CourseShareList = z.infer<typeof courseShareListSchema>;

export const courseShareCreateRequestSchema = z.strictObject({
  receiptId: uuid,
  /** Optional: seven days when absent. More than thirty is refused, never clamped. */
  expiresInDays: z.number().int().min(1).max(courseSharingLimits.shareExpiryMaxDays).optional(),
});
export type CourseShareCreateRequest = z.infer<typeof courseShareCreateRequestSchema>;

/** The only response that ever carries the plain token. The server keeps its digest only. */
export const courseShareCreatedSchema = z.strictObject({
  share: courseShareSchema,
  token: courseShareTokenSchema,
});
export type CourseShareCreated = z.infer<typeof courseShareCreatedSchema>;

export const courseShareRevokeAllResultSchema = z.strictObject({
  revokedCount: z.number().int().min(0).max(courseSharingLimits.activeSharesPerOwner),
});

/**
 * The recipient's read model (§3, B-3). An allowlist, parsed strictly.
 *
 * Nothing here says whether the line was trimmed, how much or by how many areas: the fact
 * of a trim is itself the clue that something near an end is protected. There is no course
 * id, revision, time, generation, lineage, activity, thumbnail or owner. The expiry is a
 * date. Names appear only when the owner turned them on — and even then the two ends carry
 * none, because an end that lost its name would say it had been cut.
 */
export const sharedCourseWaypointSchema = z.strictObject({
  role: z.enum(['start', 'via', 'finish']),
  position: coursePositionSchema,
  name: courseNameSchema.optional(),
});
export const sharedCourseSchema = z.strictObject({
  name: courseNameSchema.optional(),
  coordinates: z.array(coursePositionSchema).min(2).max(courseLimits.vertices),
  waypoints: z.array(sharedCourseWaypointSchema).min(2).max(courseLimits.waypoints),
  /** Planned length of the shared line, whole metres. */
  distanceMeters: z.number().int().nonnegative(),
  expiresOn: localDateSchema,
});
export type SharedCourse = z.infer<typeof sharedCourseSchema>;

/** The one answer to every read that is not a live link (§3): the same body every time. */
export const sharedCourseNotFoundBody = { error: { code: 'NOT_FOUND' } } as const;
