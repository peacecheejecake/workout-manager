import { z } from 'zod';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import { transportReplySchema } from '@workout/contracts/core';
import {
  courseDisclosurePreviewSchema,
  courseDisclosureReceiptSchema,
  courseShareCreatedSchema,
  courseShareListSchema,
  courseShareRevokeAllResultSchema,
  courseShareSchema,
  sharedCourseReadPath,
  sharedCourseSchema,
  sharedCourseViewPath,
  type CourseDisclosureConfirmationRequest,
  type CourseDisclosurePurpose,
  type SharedCourse,
} from '@workout/contracts/course-sharing';

import { CourseRequestError } from './course-api';

/**
 * Client for what may leave the account from a course (M2-01k-o): the privacy
 * confirmation, the confirmed GPX download and — when the server has the flag on — the
 * owner's link management. Every response is validated against the contract.
 *
 * **The token is never kept.** `createShare` hands it to its caller and nowhere else: this
 * file puts nothing into a query cache, a store, `localStorage`, `sessionStorage` or
 * IndexedDB (B-7, T24).
 */
const errorSchema = z.object({ error: z.object({ code: z.string() }) });

export function createCourseSharingApi(transport: AuthenticatedTransport) {
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
  const course = (courseId: string) => `/bff/v1/courses/${encodeURIComponent(courseId)}`;
  return {
    preview(courseId: string, purpose: CourseDisclosurePurpose, signal?: AbortSignal) {
      return request(
        `${course(courseId)}/disclosure-preview?purpose=${purpose}`,
        'GET',
        courseDisclosurePreviewSchema,
        null,
        null,
        signal,
      );
    },
    confirm(courseId: string, input: CourseDisclosureConfirmationRequest, idempotencyKey: string) {
      return request(
        `${course(courseId)}/disclosure-confirmations`,
        'POST',
        courseDisclosureReceiptSchema,
        input,
        idempotencyKey,
      );
    },
    /**
     * The owner's links. A server with the flag off has no such route, and this answers
     * `null` for it rather than an error: "sharing is off" is a state the screen shows by
     * showing nothing.
     */
    async shares(signal?: AbortSignal) {
      try {
        return await request(
          '/bff/v1/courses/shares',
          'GET',
          courseShareListSchema,
          null,
          null,
          signal,
        );
      } catch (error) {
        if (error instanceof CourseRequestError && (error.status === 404 || error.status === 400))
          return null;
        throw error;
      }
    },
    createShare(courseId: string, receiptId: string, expiresInDays: number) {
      return request(`${course(courseId)}/shares`, 'POST', courseShareCreatedSchema, {
        receiptId,
        expiresInDays,
      });
    },
    revokeShare(shareId: string) {
      return request(
        `/bff/v1/courses/shares/${encodeURIComponent(shareId)}/revoke`,
        'POST',
        courseShareSchema,
        {},
      );
    },
    revokeAllShares() {
      return request(
        '/bff/v1/courses/shares/revoke-all',
        'POST',
        courseShareRevokeAllResultSchema,
        {},
      );
    },
  };
}

export type CourseSharingApi = ReturnType<typeof createCourseSharingApi>;

/** The link the owner hands on: this origin, the view path, the token in the fragment. */
export function sharedCourseLink(origin: string, token: string): string {
  return `${origin}${sharedCourseViewPath}#${token}`;
}

/**
 * The recipient's one read (§3 B). The token goes in a POST body — never an address — the
 * request carries no credentials and no referrer, and nothing about it is cached.
 */
export async function readSharedCourse(
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<SharedCourse | null> {
  const response = await fetcher(sharedCourseReadPath, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    redirect: 'error',
  });
  if (response.status !== 200) return null;
  const parsed = sharedCourseSchema.safeParse(await response.json());
  return parsed.success ? parsed.data : null;
}
