import { createBoundedPlainJsonSchema } from '@workout/contracts/bounded-plain-json';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { courseListSchema } from '@workout/contracts/courses';
import {
  galleryCourseLinkV2Schema,
  galleryNavigationV2Limits,
  type GalleryCourseLinkV2,
} from '@workout/contracts/gallery-navigation-v2';

export interface GalleryCourseChoice {
  label: string;
  link: GalleryCourseLinkV2;
}
export interface GalleryCourseChoices {
  choices: readonly GalleryCourseChoice[];
  unavailableCount: number;
}
export class GalleryCourseChoicesRequestError extends Error {
  constructor(
    readonly code:
      'INVALID_INPUT' | 'INVALID_REPLY' | 'REQUEST_FAILED' | 'TRANSPORT_FAILED' | 'ABORTED',
    readonly status: number | null = null,
  ) {
    super(code);
    this.name = 'GalleryCourseChoicesRequestError';
  }
}
const bounded = createBoundedPlainJsonSchema(galleryNavigationV2Limits.encodedBytes);

/** Current owned heads only. Does not read historical versions or grant access. */
export function createGalleryCourseChoicesApi(transport: AuthenticatedTransport) {
  return {
    async list(signal?: AbortSignal): Promise<GalleryCourseChoices> {
      if (signal !== undefined && !(signal instanceof AbortSignal))
        throw new GalleryCourseChoicesRequestError('INVALID_INPUT');
      if (signal?.aborted) throw new GalleryCourseChoicesRequestError('ABORTED');
      let raw: unknown;
      try {
        raw = await transport.request({
          method: 'GET',
          path: '/bff/v1/courses',
          body: null,
          idempotencyKey: null,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch {
        throw new GalleryCourseChoicesRequestError(
          signal?.aborted ? 'ABORTED' : 'TRANSPORT_FAILED',
        );
      }
      if (signal?.aborted) throw new GalleryCourseChoicesRequestError('ABORTED');
      // Reject accessors before public schemas touch either envelope or nested head fields.
      if (!bounded.safeParse(raw).success)
        throw new GalleryCourseChoicesRequestError('INVALID_REPLY');
      const reply = transportReplySchema.safeParse(raw);
      if (!reply.success) throw new GalleryCourseChoicesRequestError('INVALID_REPLY');
      if (reply.data.status !== 200) {
        if (reply.data.status >= 200 && reply.data.status < 300)
          throw new GalleryCourseChoicesRequestError('INVALID_REPLY');
        throw new GalleryCourseChoicesRequestError('REQUEST_FAILED', reply.data.status);
      }
      const list = courseListSchema.safeParse(reply.data.body);
      if (!list.success || list.data.total !== list.data.courses.length)
        throw new GalleryCourseChoicesRequestError('INVALID_REPLY');
      const ids = new Set<string>();
      const choices: GalleryCourseChoice[] = [];
      let unavailableCount = 0;
      for (const course of list.data.courses) {
        const id = course.courseId.toLowerCase();
        if (ids.has(id)) throw new GalleryCourseChoicesRequestError('INVALID_REPLY');
        ids.add(id);
        if (course.status === 'unavailable') {
          unavailableCount++;
          continue;
        }
        const link = galleryCourseLinkV2Schema.safeParse({
          courseId: course.courseId,
          courseRevision: course.headRevision,
          revisionId: course.revisionId,
        });
        if (!link.success) throw new GalleryCourseChoicesRequestError('INVALID_REPLY');
        choices.push({ label: course.name, link: link.data });
      }
      return { choices, unavailableCount };
    },
  };
}
export type GalleryCourseChoicesApi = ReturnType<typeof createGalleryCourseChoicesApi>;
