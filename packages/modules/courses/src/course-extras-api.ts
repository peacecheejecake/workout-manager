import { z } from 'zod';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import { transportReplySchema } from '@workout/contracts/core';
import { courseCardListSchema } from '@workout/contracts/course-cards';
import {
  courseAccessibilityNoteListSchema,
  courseAccessibilityNoteWriteResultSchema,
  courseImportResultSchema,
  coursePreferenceListSchema,
  coursePreferenceSchema,
  coursePrivacyZoneListSchema,
  type CourseAccessibilityNoteWrite,
  type CourseImportRequest,
  type CoursePosition,
  type CoursePreferenceUpdate,
} from '@workout/contracts/courses';
import {
  courseElevationResultSchema,
  placeSearchResultSchema,
  type LineElevationRequest,
  type PlaceSearchRequest,
} from '@workout/contracts/geo-data';

import { CourseRequestError } from './course-api';

/**
 * Client for the rest of S13/S14 (M2-01j): import, preferences, protected areas, place
 * search and elevation.
 *
 * Everything here is an authenticated same-origin call to our own API. There is no
 * geocoding service, no elevation service and no external URL anywhere in this file, and
 * the search request is a POST so the owner's bias position never appears in a request
 * line. Every response is validated against the contract before it reaches a screen.
 */
const errorSchema = z.object({ error: z.object({ code: z.string() }) });

/** The file's bytes, however the runtime lets us read them. */
export function readFileBytes(file: Blob): Promise<Uint8Array> {
  // `Blob.arrayBuffer` is the modern path; a runtime without it (older Safari, and the
  // jsdom build the component tests run under) still has `FileReader`. Reading the file is
  // all this does — nothing here parses it, and the server reads the bytes again anyway.
  if (typeof file.arrayBuffer === 'function')
    return file.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('FILE_READ_FAILED'));
    reader.onload = () => {
      const result = reader.result;
      if (result instanceof ArrayBuffer) resolve(new Uint8Array(result));
      else reject(new Error('FILE_READ_FAILED'));
    };
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Base64 in chunks. A course file may be megabytes, and spreading a whole megabyte-long
 * byte array into `String.fromCharCode` overflows the call stack.
 */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk)
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  return btoa(binary);
}

export function createCourseExtrasApi(transport: AuthenticatedTransport) {
  async function request<T>(
    path: string,
    method: TransportRequest['method'],
    schema: z.ZodType<T>,
    body: unknown = null,
    idempotencyKey: string | null = null,
    signal?: AbortSignal,
  ) {
    const reply = transportReplySchema.parse(
      await transport.request({
        path,
        method,
        body: body === null ? null : z.json().parse(body),
        idempotencyKey,
        ...(signal ? { signal } : {}),
      }),
    );
    if (reply.status < 200 || reply.status >= 300) {
      const parsed = errorSchema.safeParse(reply.body);
      throw new CourseRequestError(
        reply.status,
        parsed.success ? parsed.data.error.code : 'REQUEST_FAILED',
      );
    }
    return schema.parse(reply.body);
  }

  return {
    /** The server parses the file; this only carries the bytes and what the owner chose. */
    importCourse(input: CourseImportRequest, idempotencyKey: string) {
      return request(
        '/bff/v1/courses/imports',
        'POST',
        courseImportResultSchema,
        input,
        idempotencyKey,
      );
    },
    preferences(signal?: AbortSignal) {
      return request(
        '/bff/v1/courses/preferences',
        'GET',
        coursePreferenceListSchema,
        null,
        null,
        signal,
      );
    },
    writePreference(courseId: string, update: CoursePreferenceUpdate) {
      return request('/bff/v1/courses/preferences', 'PUT', coursePreferenceSchema, {
        courseId,
        update,
      });
    },
    /** The owner's accessibility notes (M2-01r). Their own words, not course content. */
    accessibilityNotes(signal?: AbortSignal) {
      return request(
        '/bff/v1/courses/accessibility-notes',
        'GET',
        courseAccessibilityNoteListSchema,
        null,
        null,
        signal,
      );
    },
    /** Write or clear one note, against the head revision the screen was showing. */
    writeAccessibilityNote(courseId: string, write: CourseAccessibilityNoteWrite) {
      return request(
        `/bff/v1/courses/${encodeURIComponent(courseId)}/accessibility-note`,
        'PUT',
        courseAccessibilityNoteWriteResultSchema,
        write,
      );
    },
    privacyZones(signal?: AbortSignal) {
      return request(
        '/bff/v1/courses/privacy-zones',
        'GET',
        coursePrivacyZoneListSchema,
        null,
        null,
        signal,
      );
    },
    createPrivacyZone(input: { name: string; center: CoursePosition; radiusMeters: number }) {
      return request('/bff/v1/courses/privacy-zones', 'POST', coursePrivacyZoneListSchema, input);
    },
    removePrivacyZone(zoneId: string) {
      return request(
        `/bff/v1/courses/privacy-zones/${encodeURIComponent(zoneId)}`,
        'DELETE',
        coursePrivacyZoneListSchema,
      );
    },
    searchPlaces(input: PlaceSearchRequest, signal?: AbortSignal) {
      return request(
        '/bff/v1/courses/place-search',
        'POST',
        placeSearchResultSchema,
        input,
        null,
        signal,
      );
    },
    elevation(courseId: string, signal?: AbortSignal) {
      return request(
        `/bff/v1/courses/${encodeURIComponent(courseId)}/elevation`,
        'GET',
        courseElevationResultSchema,
        null,
        null,
        signal,
      );
    },
    /** The S13 list cards (M2-01k-a). Facts the server derived; the screen adds none. */
    cards(signal?: AbortSignal) {
      return request('/bff/v1/courses/cards', 'GET', courseCardListSchema, null, null, signal);
    },
    /**
     * Elevation along a line that is not saved yet (M2-01k-b): a route preview or a stored
     * proposal under review. A POST, so the line never appears in a request line.
     */
    elevationProfile(input: LineElevationRequest, signal?: AbortSignal) {
      return request(
        '/bff/v1/courses/elevation-profiles',
        'POST',
        courseElevationResultSchema,
        input,
        null,
        signal,
      );
    },
  };
}

export type CourseExtrasApi = ReturnType<typeof createCourseExtrasApi>;
