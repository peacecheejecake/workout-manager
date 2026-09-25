import {
  courseDisclosureConfirmationRequestSchema,
  courseDisclosurePreviewSchema,
  courseDisclosurePurposeSchema,
  courseDisclosureReceiptSchema,
  courseShareCreateRequestSchema,
  courseShareCreatedSchema,
  courseShareListSchema,
  courseShareRevokeAllResultSchema,
  courseShareSchema,
  courseSharingLimits,
  type CourseDisclosurePurpose,
  type CourseDisclosureReceipt,
} from '@workout/contracts/course-sharing';
import {
  courseGenerationGraphBuildId,
  courseGpxMediaType,
  courseReadResultSchema,
  type CoursePosition,
  type CoursePrivacyZone,
  type CourseWaypoint,
} from '@workout/contracts/courses';
import { courseContentDigest } from '@workout/server-courses/digest';
import {
  disclosureChoices,
  exactLine,
  removedVerticesPerCircle,
  shareCircleSet,
  shareCutAreaIndexes,
  type DisclosedLine,
  type DisclosureCircle,
} from '@workout/server-courses/disclosure';
import {
  courseGpxFileName,
  DISCLOSED_COORDINATE_DIGITS,
  EXACT_COORDINATE_DIGITS,
  writeCourseGpx,
} from '@workout/server-courses/gpx';
import { privacyZoneSetDigest, trimCourseForPrivacy } from '@workout/server-courses/privacy-trim';
import type { CoursePreferenceRepository } from '@workout/server-persistence/course-preferences';
import {
  CourseSharingStateError,
  type CourseSharingRepository,
} from '@workout/server-persistence/course-sharing';
import {
  CourseNotFoundError,
  CourseStateError,
  type CourseHeadContent,
  type CourseRepository,
} from '@workout/server-persistence/courses';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { createShareToken, shareTokenDigest } from './course-sharing.js';
import type { Principal } from './ports.js';
import { command, emptyQuery, input, ProductRequestError } from './product-boundary.js';

/**
 * What may leave the account from a course (M2-01k-o): the privacy confirmation, the owner's
 * GPX export behind it, and — only when the sharing flag is on — the owner's link management.
 *
 * Every route here derives its owner from the session, and another owner's course or link is
 * a 404 like every other course route. The confirmation is recomputed on the server from the
 * head and the protected areas it holds; the screen's preview is never trusted, only its
 * revision and area-set acknowledgements are checked against what is there now.
 */
export interface CourseDisclosureServices {
  readonly courses: CourseRepository;
  readonly preferences: CoursePreferenceRepository;
  readonly sharing: CourseSharingRepository;
  /**
   * Present only when the sharing flag is on. Absent: no link route is registered at all and
   * a `share` confirmation is not offered (D1, T9).
   */
  readonly links?: { readonly epoch: number };
}

const SMALL_BODY_LIMIT = 4 * 1024;
const courseParamsSchema = z.strictObject({
  courseId: z.uuid().transform((value) => value.toLowerCase()),
});
const shareParamsSchema = z.strictObject({
  shareId: z.uuid().transform((value) => value.toLowerCase()),
});
const previewQuerySchema = z.strictObject({ purpose: courseDisclosurePurposeSchema });
const exportQuerySchema = z.strictObject({
  receipt: z
    .uuid()
    .transform((value) => value.toLowerCase())
    .optional(),
});
const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

function disclosureError(error: unknown): ProductRequestError | undefined {
  if (error instanceof CourseNotFoundError) return new ProductRequestError(404, 'COURSE_NOT_FOUND');
  if (error instanceof CourseStateError)
    return new ProductRequestError(error.code === 'COURSE_UNAVAILABLE' ? 410 : 409, error.code);
  if (error instanceof CourseSharingStateError) {
    switch (error.code) {
      case 'COURSE_NOT_FOUND':
        return new ProductRequestError(404, error.code);
      case 'COURSE_SHARE_NOT_FOUND':
        return new ProductRequestError(404, 'NOT_FOUND');
      case 'COURSE_UNAVAILABLE':
        return new ProductRequestError(410, error.code);
      default:
        return new ProductRequestError(409, error.code);
    }
  }
  return undefined;
}

function execute<T>(operation: () => Promise<T>) {
  return command(operation, disclosureError);
}

function contentDisposition(fileName: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/** The head of an available course, or the answer for one that is not. */
async function availableHead(
  services: CourseDisclosureServices,
  athleteId: string,
  courseId: string,
): Promise<CourseHeadContent> {
  const head = await execute(() => services.courses.headContent(athleteId, courseId));
  if (head === null) throw new ProductRequestError(410, 'COURSE_UNAVAILABLE');
  return head;
}

/**
 * The circles a purpose cuts against, with the protected areas behind them. A GPX is cut
 * against the areas themselves (D10); a link against each area's wider share circle, moved
 * by its secret offset (B-1), and against the area itself as well (R-2). The offsets never
 * leave this function.
 *
 * Order matters to the preview: the first `zones.length` circles are the share circles, one
 * per area in the areas' order, so `removedVerticesPerCircle` counts line up with `zones`.
 * The areas follow; they only ever add the slivers a flat-map share circle misses. Every
 * one of a link's circles carries its area's continuation cut (M2-01as), so a link loses a
 * further 2.5 · S of path past whichever of them cut an end.
 */
async function circlesFor(
  services: CourseDisclosureServices,
  athleteId: string,
  purpose: CourseDisclosurePurpose,
): Promise<{ zones: CoursePrivacyZone[]; circles: DisclosureCircle[] }> {
  if (purpose === 'export') {
    const zones = await execute(() => services.preferences.listPrivacyZones(athleteId));
    return { zones, circles: zones };
  }
  const withOffsets = await execute(() => services.sharing.zonesWithShareOffsets(athleteId));
  return { zones: withOffsets.map((entry) => entry.zone), circles: shareCircleSet(withOffsets) };
}

/**
 * Refuse a GPX without a usable confirmation, saying which of two things it is: the course
 * cannot be confirmed at all (a refused trim, D3) or it has not been confirmed (§3 A).
 */
async function refuseExport(
  services: CourseDisclosureServices,
  athleteId: string,
  head: CourseHeadContent,
): Promise<never> {
  const { circles } = await circlesFor(services, athleteId, 'export');
  const choices = disclosureChoices('export', head.coordinates, head.waypoints, circles);
  if (choices.classification.outcome === 'blocked')
    throw new ProductRequestError(409, 'COURSE_EXPORT_BLOCKED');
  throw new ProductRequestError(409, 'COURSE_EXPORT_NOT_CONFIRMED');
}

/**
 * The line a usable export receipt allows, from the current head. After a trimmed
 * confirmation the head IS the trimmed revision, so it no longer touches any area and leaves
 * as it is. Anything that does not line up with the receipt is refused, never re-decided.
 */
function exportLine(
  receipt: CourseDisclosureReceipt,
  head: CourseHeadContent,
  zones: readonly CoursePrivacyZone[],
): {
  line: DisclosedLine;
  digits: typeof EXACT_COORDINATE_DIGITS | typeof DISCLOSED_COORDINATE_DIGITS;
} | null {
  const choices = disclosureChoices('export', head.coordinates, head.waypoints, zones);
  if (receipt.exposure === 'owner-exact')
    return choices.classification.outcome === 'ends-inside'
      ? { line: exactLine(head.coordinates, head.waypoints), digits: EXACT_COORDINATE_DIGITS }
      : null;
  const wanted = receipt.exposure === 'trimmed' ? 'no-zone-intersection' : receipt.exposure;
  const option = choices.options.find((candidate) => candidate.exposure === wanted);
  return option ? { line: option.line, digits: DISCLOSED_COORDINATE_DIGITS } : null;
}

/** A link's snapshot: the recipient's read model, names only where the owner kept them. */
function linkSnapshot(name: string, line: DisclosedLine, includeNames: boolean) {
  return {
    ...(includeNames ? { name } : {}),
    coordinates: line.coordinates.map((position): CoursePosition => [position[0], position[1]]),
    // The two ends never carry a name: an end that lost its name would say it was cut (B-3).
    waypoints: line.waypoints.map((waypoint: CourseWaypoint) => ({
      role: waypoint.role,
      position: [waypoint.position[0], waypoint.position[1]] as CoursePosition,
      ...(includeNames && waypoint.role === 'via' && waypoint.name !== null
        ? { name: waypoint.name }
        : {}),
    })),
    distanceMeters: Math.round(line.distanceMeters),
  };
}

export function registerCourseDisclosureRoutes(
  routes: FastifyInstance,
  services: CourseDisclosureServices,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.register(async (disclosure) => {
    /**
     * What the confirmation screen shows (§5): each line the owner may confirm for this
     * purpose, exactly as it would leave, and the protected areas by name with how much of
     * the line each one covers. Never a centre, never an offset.
     */
    disclosure.get('/courses/:courseId/disclosure-preview', async (request) => {
      const athleteId = principal(request).athleteId;
      const { purpose } = input(previewQuerySchema, request.query);
      const { courseId } = input(courseParamsSchema, request.params);
      if (purpose === 'share' && services.links === undefined)
        throw new ProductRequestError(404, 'NOT_FOUND');
      const head = await availableHead(services, athleteId, courseId);
      const { zones, circles } = await circlesFor(services, athleteId, purpose);
      const choices = disclosureChoices(purpose, head.coordinates, head.waypoints, circles);
      const counts = removedVerticesPerCircle(head.coordinates, circles);
      return courseDisclosurePreviewSchema.parse({
        purpose,
        courseId,
        courseRevision: head.courseRevision,
        zoneSetDigest: privacyZoneSetDigest(zones),
        zoneCount: zones.length,
        outcome: choices.classification.outcome,
        blockedReason:
          choices.classification.outcome === 'blocked' ? choices.classification.reason : null,
        zones: zones.map((zone, index) => ({
          name: zone.name,
          removedVertexCount: counts[index] ?? 0,
        })),
        options: choices.options.map(({ line: _line, ...option }) => option),
        defaultExposure: choices.defaultExposure,
        includeNamesDefault: purpose === 'export',
      });
    });

    /**
     * Confirm one option and record a receipt (§5 step 4). Everything is recomputed here;
     * the request only names the choice and what the screen was showing.
     *
     * A trimmed GPX appends the trimmed revision to the owner's course, exactly as the
     * privacy trim does, and the receipt is for that revision (R-10). No receipt is ever
     * written for a refused trim (D3).
     *
     * Retry path (trimmed GPX). The revision and the receipt are written in two transactions,
     * the course update first. A resend under the same key after both committed replays the
     * receipt (`replayReceipt`, asked first). If only the update committed — the receipt
     * write failed — a resend finds no receipt and a head that has moved past
     * `expectedRevision`, and is refused with 409 `COURSE_REVISION_CONFLICT`; nothing is
     * exported, since no receipt exists. The screen says the course changed and asks the owner
     * to open the confirmation again; its new preview offers the trimmed head as it now is
     * (`no-zone-intersection`), and that confirmation, under a new key, exports it. The retry never re-trims and never appends a second
     * revision.
     */
    disclosure.post(
      '/courses/:courseId/disclosure-confirmations',
      { bodyLimit: SMALL_BODY_LIMIT },
      async (request) => {
        input(emptyQuery, request.query);
        const athleteId = principal(request).athleteId;
        const { courseId } = input(courseParamsSchema, request.params);
        const body = input(courseDisclosureConfirmationRequestSchema, request.body);
        const key = input(idempotencyKeySchema, request.headers['idempotency-key']);
        if (body.purpose === 'share' && services.links === undefined)
          throw new ProductRequestError(404, 'NOT_FOUND');
        const commandRecord = { kind: 'course_disclosure_confirmation', courseId, body };
        const replayed = await execute(() =>
          services.sharing.replayReceipt(athleteId, key, commandRecord),
        );
        if (replayed) return courseDisclosureReceiptSchema.parse(replayed);
        const head = await availableHead(services, athleteId, courseId);
        if (head.courseRevision !== body.expectedRevision)
          throw new ProductRequestError(409, 'COURSE_REVISION_CONFLICT');
        const { zones, circles } = await circlesFor(services, athleteId, body.purpose);
        if (privacyZoneSetDigest(zones) !== body.acknowledgedZoneSetDigest)
          throw new ProductRequestError(409, 'COURSE_ZONE_ACKNOWLEDGEMENT_STALE');
        // D3c: a link needs a protected area. Said by name, not left to the absent option.
        if (body.purpose === 'share' && zones.length === 0)
          throw new ProductRequestError(409, 'COURSE_SHARE_REQUIRES_PROTECTED_AREA');
        const choices = disclosureChoices(body.purpose, head.coordinates, head.waypoints, circles);
        if (choices.classification.outcome === 'blocked')
          throw new ProductRequestError(409, 'COURSE_EXPORT_BLOCKED');
        const chosen = choices.options.find((option) => option.exposure === body.exposure);
        if (!chosen) throw new ProductRequestError(409, 'COURSE_DISCLOSURE_STALE');
        // D3a/D3b: an exact line leaves only after the owner ticked the explicit warning.
        if (chosen.requiresAcknowledgement && !body.acknowledgedRisk)
          throw new ProductRequestError(409, 'COURSE_EXPORT_NOT_CONFIRMED');
        let confirmedRevision = head.courseRevision;
        if (body.purpose === 'export' && body.exposure === 'trimmed') {
          const trimmed = trimCourseForPrivacy({
            coordinates: head.coordinates,
            waypoints: head.waypoints,
            zones,
            sourceRevision: head.courseRevision,
            sourceGenerationKind: head.generation.kind,
            sourceGraphBuildId: courseGenerationGraphBuildId(head.generation),
          });
          const updated = courseReadResultSchema.parse(
            await execute(() =>
              services.courses.update(
                athleteId,
                courseId,
                head.courseRevision,
                {
                  name: head.name,
                  coordinates: trimmed.coordinates,
                  waypoints: trimmed.waypoints,
                  generation: trimmed.generation,
                  edit: { kind: 'privacy-trimmed' },
                  lineage: head.lineage,
                  distanceMeters: trimmed.distanceMeters,
                  contentDigest: courseContentDigest({
                    name: head.name,
                    coordinates: trimmed.coordinates,
                    waypoints: trimmed.waypoints,
                    generation: trimmed.generation,
                    lineage: head.lineage,
                  }),
                },
                key,
                commandRecord,
                {
                  requireZoneSet: {
                    expectedDigest: body.acknowledgedZoneSetDigest,
                    digestOf: privacyZoneSetDigest,
                  },
                },
              ),
            ),
          );
          if (updated.status !== 'available')
            throw new ProductRequestError(410, 'COURSE_UNAVAILABLE');
          confirmedRevision = updated.revision.courseRevision;
        }
        return courseDisclosureReceiptSchema.parse(
          await execute(() =>
            services.sharing.recordReceipt(athleteId, {
              courseId,
              courseRevision: confirmedRevision,
              purpose: body.purpose,
              exposure: body.exposure,
              zoneSetDigest: body.acknowledgedZoneSetDigest,
              includeNames: body.includeNames,
              idempotencyKey: key,
              request: commandRecord,
              digestOf: privacyZoneSetDigest,
            }),
          ),
        );
      },
    );

    /**
     * The owner's GPX, behind a confirmation (§2 A). Without a usable receipt for this head
     * and this protected-area set there is no body at all — 409, and which of "not
     * confirmed" or "cannot be confirmed" it is. The file carries no description, no time,
     * no id, no revision and no product name, and its name has no revision number (A-1).
     */
    disclosure.get('/courses/:courseId/export.gpx', async (request, reply) => {
      const athleteId = principal(request).athleteId;
      const { receipt: receiptId } = input(exportQuerySchema, request.query);
      const { courseId } = input(courseParamsSchema, request.params);
      // Another owner's course is a 404 and a reclaimed one a 410 before anything else.
      const current = courseReadResultSchema.parse(
        await execute(() => services.courses.read(athleteId, courseId)),
      );
      if (current.status !== 'available') throw new ProductRequestError(410, 'COURSE_UNAVAILABLE');
      const head = await availableHead(services, athleteId, courseId);
      if (receiptId === undefined) return refuseExport(services, athleteId, head);
      const usable = await execute(() =>
        services.sharing.readUsableReceipt(athleteId, courseId, receiptId, 'export'),
      );
      if (
        usable === null ||
        usable.headRevision !== usable.receipt.courseRevision ||
        head.courseRevision !== usable.receipt.courseRevision ||
        privacyZoneSetDigest(usable.zones) !== usable.receipt.zoneSetDigest
      )
        return refuseExport(services, athleteId, head);
      const allowed = exportLine(usable.receipt, head, usable.zones);
      if (allowed === null) return refuseExport(services, athleteId, head);
      const includeNames = usable.receipt.includeNames;
      const body = Buffer.from(
        writeCourseGpx({
          name: head.name,
          includeNames,
          coordinates: allowed.line.coordinates,
          waypoints: allowed.line.waypoints,
          coordinateDigits: allowed.digits,
        }),
        'utf8',
      );
      return reply
        .header('content-type', `${courseGpxMediaType}; charset=utf-8`)
        .header('content-length', body.byteLength)
        .header('cache-control', 'private, no-store')
        .header(
          'content-disposition',
          contentDisposition(courseGpxFileName(includeNames ? head.name : null)),
        )
        .send(body);
    });

    const links = services.links;
    if (links === undefined) return;

    /** The owner's links: facts only, never a token (it was shown once, at creation). */
    disclosure.get('/courses/shares', async (request) => {
      input(emptyQuery, request.query);
      return courseShareListSchema.parse(
        await execute(() => services.sharing.listShares(principal(request).athleteId, links.epoch)),
      );
    });

    /**
     * Make a link from a `share` receipt (B). The snapshot is cut here, against the share
     * circles, from the confirmed revision — which must still be the head — and stored beside
     * the ledger; the token goes back once and only its digest is kept.
     */
    disclosure.post(
      '/courses/:courseId/shares',
      { bodyLimit: SMALL_BODY_LIMIT },
      async (request, reply) => {
        input(emptyQuery, request.query);
        const athleteId = principal(request).athleteId;
        const { courseId } = input(courseParamsSchema, request.params);
        const body = input(courseShareCreateRequestSchema, request.body);
        const usable = await execute(() =>
          services.sharing.readUsableReceipt(athleteId, courseId, body.receiptId, null),
        );
        if (usable === null) throw new ProductRequestError(409, 'COURSE_EXPORT_NOT_CONFIRMED');
        const head = await availableHead(services, athleteId, courseId);
        const { zones, circles } = await circlesFor(services, athleteId, 'share');
        const choices = disclosureChoices('share', head.coordinates, head.waypoints, circles);
        // A link has exactly one possible line: the share cut of the head (D3b — never the
        // exact one). Whether the receipt confirmed THIS line — a `share` receipt, for this
        // revision and area set, with this exposure — is decided by the store, in one place,
        // inside the transaction that writes the link.
        const option = choices.options[0];
        const exposure = option?.exposure;
        if (!option || (exposure !== 'trimmed' && exposure !== 'no-zone-intersection'))
          throw new ProductRequestError(409, 'COURSE_EXPORT_NOT_CONFIRMED');
        const token = createShareToken();
        const created = await execute(() =>
          services.sharing.createShare(athleteId, {
            courseId,
            receiptId: body.receiptId,
            exposure,
            tokenDigest: shareTokenDigest(token),
            epoch: links.epoch,
            expiresInDays: body.expiresInDays ?? courseSharingLimits.shareExpiryDefaultDays,
            snapshot: linkSnapshot(head.name, option.line, usable.receipt.includeNames),
            zoneIds: zones.map((zone) => zone.zoneId),
            // M2-01as: the areas that cut this link each give up one of their lifetime links.
            cutZoneIds: shareCutAreaIndexes(head.coordinates, circles, zones.length).flatMap(
              (index) => (zones[index] ? [zones[index].zoneId] : []),
            ),
            zoneSetDigest: privacyZoneSetDigest(zones),
            digestOf: privacyZoneSetDigest,
          }),
        );
        return reply.code(201).send(courseShareCreatedSchema.parse({ share: created, token }));
      },
    );

    disclosure.post(
      '/courses/shares/:shareId/revoke',
      { bodyLimit: SMALL_BODY_LIMIT },
      async (request) => {
        input(emptyQuery, request.query);
        const { shareId } = input(shareParamsSchema, request.params);
        return courseShareSchema.parse(
          await execute(() =>
            services.sharing.revokeShare(principal(request).athleteId, shareId, links.epoch),
          ),
        );
      },
    );

    /** "모든 링크 끄기" (R-6): every active link of this owner, at once. */
    disclosure.post(
      '/courses/shares/revoke-all',
      { bodyLimit: SMALL_BODY_LIMIT },
      async (request) => {
        input(emptyQuery, request.query);
        return courseShareRevokeAllResultSchema.parse({
          revokedCount: await execute(() =>
            services.sharing.revokeAllShares(principal(request).athleteId),
          ),
        });
      },
    );
  });
}
