import {
  courseAccessibilityNoteListSchema,
  courseAccessibilityNoteWriteResultSchema,
  courseAccessibilityNoteWriteSchema,
  courseImportRequestSchema,
  courseImportResultSchema,
  courseLimits,
  coursePreferenceListSchema,
  coursePreferenceSchema,
  coursePreferenceUpdateSchema,
  coursePrivacyZoneCreateSchema,
  coursePrivacyZoneListSchema,
  courseReadResultSchema,
  type CourseGeneration,
  type CoursePrivacyZone,
} from '@workout/contracts/courses';
import {
  courseElevationResultSchema,
  placeSearchRequestSchema,
  placeSearchResultSchema,
} from '@workout/contracts/geo-data';
import { courseContentDigest } from '@workout/server-courses/digest';
import {
  CourseImportError,
  courseFromImportedFile,
  listImportItems,
} from '@workout/server-courses/import';
import { privacyZoneSetDigest } from '@workout/server-courses/privacy-trim';
import type { ElevationIndex, PlaceIndex } from '@workout/server-courses/geo-data';
import {
  CourseAccessibilityNoteStateError,
  CoursePreferenceError,
  PrivacyZoneStateError,
  type CoursePreferenceRepository,
} from '@workout/server-persistence/course-preferences';
import { CourseNotFoundError, type CourseRepository } from '@workout/server-persistence/courses';
import type { BoundedTrackParser } from '@workout/server-track-storage/parse-host';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Principal } from './ports.js';
import { command, emptyQuery, input, ProductRequestError } from './product-boundary.js';

/**
 * The rest of S13/S14 (M2-01j): importing a GPX file as a course, the owner's private
 * preferences, their protected areas, place search and elevation.
 *
 * These live beside the course ledger rather than inside it, and every one of them keeps a
 * boundary the ledger already has:
 *
 * - **The server parses the file.** A client may have read the GPX to show a preview; this
 *   route never sees that parse. The bytes go through the same bounded parse host a stored
 *   recording goes through — real heap ceiling, its own deadline, XXE blocked, archives
 *   refused, format sniffed from content rather than from a name or a MIME type — and the
 *   course is built from what *it* produced. The bound that ends a runaway parse is the
 *   host's deadline, not the client hanging up: like the stored-recording route beside it,
 *   this one passes no request signal, so a disconnect does not shorten a parse already
 *   under way.
 * - **A preference is not course content.** Favourites and last-used go to their own table
 *   and produce no revision at all, so they cannot change a course, its digest or its head.
 * - **A query is not a log line.** Place search is a POST with the bias position in the
 *   body, because a request line lands in access logs and a precise position must not.
 *   Nothing in this file logs a coordinate, a query, a file name or a zone.
 */
const courseParamsSchema = z.strictObject({
  courseId: z.uuid().transform((value) => value.toLowerCase()),
});
const zoneParamsSchema = z.strictObject({
  zoneId: z.uuid().transform((value) => value.toLowerCase()),
});
const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

/** Base64 of a 4 MiB file plus the JSON around it, with room for neither much more. */
const IMPORT_BODY_LIMIT = Math.ceil((courseLimits.importFileBytes / 3) * 4) + 4096;
const SMALL_BODY_LIMIT = 4 * 1024;

export interface CourseExtrasServices {
  courses: CourseRepository;
  preferences: CoursePreferenceRepository;
  /** The same bounded parse host stored recordings use. Absent: no import route at all. */
  parser?: BoundedTrackParser;
  /** Our own place index. Absent: the route answers `no_dataset` rather than guessing. */
  places?: PlaceIndex | null;
  elevation?: ElevationIndex | null;
}

function extrasError(error: unknown): ProductRequestError | undefined {
  if (error instanceof CourseNotFoundError) return new ProductRequestError(404, 'COURSE_NOT_FOUND');
  if (error instanceof CoursePreferenceError)
    return new ProductRequestError(404, 'COURSE_NOT_FOUND');
  if (error instanceof CourseAccessibilityNoteStateError)
    return new ProductRequestError(error.code === 'COURSE_UNAVAILABLE' ? 410 : 409, error.code);
  if (error instanceof PrivacyZoneStateError)
    return new ProductRequestError(error.code === 'PRIVACY_ZONE_NOT_FOUND' ? 404 : 429, error.code);
  if (error instanceof CourseImportError) return new ProductRequestError(422, error.code);
  return undefined;
}

function execute<T>(operation: () => Promise<T>) {
  return command(operation, extrasError);
}

function zoneList(zones: readonly CoursePrivacyZone[]) {
  return coursePrivacyZoneListSchema.parse({
    zones,
    total: zones.length,
    zoneSetDigest: privacyZoneSetDigest(zones),
  });
}

/**
 * A parse failure carries a code and nothing else — never a message, never a fragment of
 * the file. 413 for a file that is too large, 422 for a file we refuse to read, 503 for a
 * host problem that says nothing about the file.
 */
function importParseStatus(code: string): number {
  if (code === 'TRACK_FILE_TOO_LARGE') return 413;
  if (code === 'TRACK_PARSER_BUSY') return 429;
  if (
    code === 'TRACK_PARSE_WORKER_FAILED' ||
    code === 'TRACK_PARSE_REPLY_INVALID' ||
    code === 'TRACK_PARSE_CEILING_NOT_APPLIED'
  )
    return 503;
  if (code === 'TRACK_PARSE_TIMEOUT' || code === 'TRACK_PARSE_MEMORY_EXCEEDED') return 422;
  return 422;
}

export function registerCourseExtrasRoutes(
  routes: FastifyInstance,
  services: CourseExtrasServices,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.register(async (extras) => {
    if (services.parser) {
      const parser = services.parser;
      /**
       * Import a GPX file as a course.
       *
       * A GPX `trk` is somebody's recording and a `rte` is a planned line. Either can
       * become a **course**, which is planned data; neither becomes an Activity, a source
       * revision or a recorded actual, and which of the two the bytes came from is written
       * into the revision's conditions instead of being forgotten. A file holding more
       * than one of them is answered with what it holds so the owner can choose: nothing
       * is merged and nothing is picked for them.
       */
      extras.post('/courses/imports', { bodyLimit: IMPORT_BODY_LIMIT }, async (request, reply) => {
        input(emptyQuery, request.query);
        const athleteId = principal(request).athleteId;
        const body = input(courseImportRequestSchema, request.body);
        const key = input(idempotencyKeySchema, request.headers['idempotency-key']);
        const command = { kind: 'course_import', body };
        const replayed = await execute(() =>
          services.courses.replayCommand(athleteId, key, command),
        );
        if (replayed)
          return courseImportResultSchema.parse({
            outcome: 'imported',
            course: await execute(() => services.courses.read(athleteId, replayed.courseId)),
          });
        const bytes = new Uint8Array(Buffer.from(body.fileBase64, 'base64'));
        if (bytes.byteLength === 0) throw new ProductRequestError(422, 'TRACK_FILE_EMPTY');
        if (bytes.byteLength > courseLimits.importFileBytes)
          throw new ProductRequestError(413, 'TRACK_FILE_TOO_LARGE');
        // The server's own parse, under the server's own bounds. Nothing the client may
        // have computed about this file reaches the course.
        const parsed = await parser.parseFile(bytes, { filename: body.originalFilename ?? null });
        if (!parsed.ok) throw new ProductRequestError(importParseStatus(parsed.code), parsed.code);
        const file = parsed.file;
        // The extension and the declared type decide nothing: the parser sniffed the
        // format from the bytes, and a course is imported from GPX only.
        if (file.format !== 'gpx')
          throw new ProductRequestError(422, 'COURSE_IMPORT_FORMAT_UNSUPPORTED');
        const items = listImportItems(file);
        if (items.length === 0)
          throw new ProductRequestError(422, 'COURSE_IMPORT_NO_IMPORTABLE_ITEM');
        if (items.length > 1 && body.selection === null)
          return reply.code(200).send(
            courseImportResultSchema.parse({
              outcome: 'requires_selection',
              fileSha256: file.fileSha256,
              items,
            }),
          );
        const content = await execute(async () =>
          courseFromImportedFile({
            parsed: file,
            selection: body.selection,
            name: body.name,
          }),
        );
        const generation: CourseGeneration = content.generation;
        const course = await execute(() =>
          services.courses.create(
            athleteId,
            {
              name: content.name,
              coordinates: content.coordinates,
              waypoints: content.waypoints,
              generation,
              edit: { kind: 'imported' },
              // An imported file names no recording of ours. It is not lineage we lost: it
              // is lineage that never existed, and inventing one would claim the course
              // came from an activity it did not.
              lineage: [],
              distanceMeters: content.distanceMeters,
              contentDigest: courseContentDigest({
                name: content.name,
                coordinates: content.coordinates,
                waypoints: content.waypoints,
                generation,
                lineage: [],
              }),
            },
            key,
            command,
          ),
        );
        return courseImportResultSchema.parse({
          outcome: 'imported',
          course: courseReadResultSchema.parse(course),
        });
      });
    }

    extras.get('/courses/preferences', async (request) => {
      input(emptyQuery, request.query);
      return coursePreferenceListSchema.parse(
        await execute(() => services.preferences.list(principal(request).athleteId)),
      );
    });

    /**
     * Write the two preferences a course may carry. This appends no revision, moves no
     * head and changes no digest: marking a course as a favourite is not an edit of it.
     */
    extras.put('/courses/preferences', { bodyLimit: SMALL_BODY_LIMIT }, async (request) => {
      input(emptyQuery, request.query);
      const body = input(
        z.strictObject({
          courseId: z.uuid().transform((value) => value.toLowerCase()),
          update: coursePreferenceUpdateSchema,
        }),
        request.body,
      );
      return coursePreferenceSchema.parse(
        await execute(() =>
          services.preferences.write(principal(request).athleteId, body.courseId, body.update),
        ),
      );
    });

    /**
     * The owner's accessibility notes (M2-01r, S13). Their own words, kept beside the
     * ledger: listing them reads no course content and writing one appends no revision.
     */
    extras.get('/courses/accessibility-notes', async (request) => {
      input(emptyQuery, request.query);
      return courseAccessibilityNoteListSchema.parse(
        await execute(() =>
          services.preferences.listAccessibilityNotes(principal(request).athleteId),
        ),
      );
    });

    /**
     * Write or clear one note. The head revision the screen was showing travels with it and
     * the note is recorded against that revision, so a note can never be attached to a line
     * the owner has not seen. A course that is not the caller's is 404, exactly as for every
     * other course route: nothing here says whether it exists for someone else.
     */
    extras.put(
      '/courses/:courseId/accessibility-note',
      { bodyLimit: SMALL_BODY_LIMIT },
      async (request) => {
        input(emptyQuery, request.query);
        const { courseId } = input(courseParamsSchema, request.params);
        const body = input(courseAccessibilityNoteWriteSchema, request.body);
        const note = await execute(() =>
          services.preferences.writeAccessibilityNote(principal(request).athleteId, courseId, body),
        );
        return courseAccessibilityNoteWriteResultSchema.parse({ courseId, note });
      },
    );

    extras.get('/courses/privacy-zones', async (request) => {
      input(emptyQuery, request.query);
      return zoneList(
        await execute(() => services.preferences.listPrivacyZones(principal(request).athleteId)),
      );
    });

    extras.post('/courses/privacy-zones', { bodyLimit: SMALL_BODY_LIMIT }, async (request) => {
      input(emptyQuery, request.query);
      const body = input(coursePrivacyZoneCreateSchema, request.body);
      return zoneList(
        await execute(() =>
          services.preferences.createPrivacyZone(principal(request).athleteId, {
            name: body.name,
            center: body.center,
            radiusMeters: body.radiusMeters,
          }),
        ),
      );
    });

    extras.delete('/courses/privacy-zones/:zoneId', async (request) => {
      if (request.body !== undefined) throw new ProductRequestError(400, 'INVALID_REQUEST');
      input(emptyQuery, request.query);
      const { zoneId } = input(zoneParamsSchema, request.params);
      return zoneList(
        await execute(() =>
          services.preferences.removePrivacyZone(principal(request).athleteId, zoneId),
        ),
      );
    });

    /**
     * Search our own place data.
     *
     * A POST, with the bias position in the body: a GET would put the owner's position in
     * a request line, and request lines are logged. The answer names the dataset that
     * produced it — identity, licence, attribution, when it was built and how often it is
     * rebuilt — and when no dataset is deployed the answer says exactly that instead of
     * pretending the place does not exist or asking somebody else.
     */
    extras.post('/courses/place-search', { bodyLimit: SMALL_BODY_LIMIT }, async (request) => {
      input(emptyQuery, request.query);
      // Authentication is enforced by the plugin this is registered in; deriving the
      // principal here keeps that true for this route as well.
      principal(request);
      const body = input(placeSearchRequestSchema, request.body);
      const places = services.places;
      if (!places) return placeSearchResultSchema.parse({ outcome: 'no_dataset' });
      return placeSearchResultSchema.parse(places.search(body));
    });

    /**
     * Elevation along one course, from our own dataset.
     *
     * The dataset is sparse by nature, so most points have no value and say so with
     * `null`. Nothing here interpolates, substitutes zero or totals an ascent: a sum over
     * a sparse sample would be a number nobody measured.
     */
    extras.get('/courses/:courseId/elevation', async (request) => {
      input(emptyQuery, request.query);
      const { courseId } = input(courseParamsSchema, request.params);
      const result = courseReadResultSchema.parse(
        await execute(() => services.courses.read(principal(request).athleteId, courseId)),
      );
      if (result.status !== 'available') throw new ProductRequestError(410, 'COURSE_UNAVAILABLE');
      const elevation = services.elevation;
      if (!elevation) return courseElevationResultSchema.parse({ outcome: 'no_dataset' });
      return courseElevationResultSchema.parse(elevation.profile(result.revision));
    });
  });
}
