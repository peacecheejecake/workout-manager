import { z } from 'zod';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import { transportReplySchema } from '@workout/contracts/core';
import {
  activityDeletionImpactSchema,
  courseListSchema,
  courseReadResultSchema,
  type CourseCreateRequest,
  type CourseUpdateRequest,
} from '@workout/contracts/courses';

/**
 * Course API client.
 *
 * Every write carries the revision the caller saw, and every response is validated against
 * the contract before it reaches a screen. There is no sharing call here because there is
 * no sharing route: a course leaves the server only as its owner's GPX download.
 */
const errorSchema = z.object({ error: z.object({ code: z.string() }) });

export class CourseRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'CourseRequestError';
  }
}

/** Where the owner's authenticated GPX download lives. Same origin, no object key. */
export function courseExportPath(courseId: string): string {
  return `/bff/v1/courses/${encodeURIComponent(courseId)}/export.gpx`;
}

export function createCourseApi(transport: AuthenticatedTransport) {
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
    list(signal?: AbortSignal) {
      return request('/bff/v1/courses', 'GET', courseListSchema, null, null, signal);
    },
    read(courseId: string, signal?: AbortSignal) {
      return request(
        `/bff/v1/courses/${encodeURIComponent(courseId)}`,
        'GET',
        courseReadResultSchema,
        null,
        null,
        signal,
      );
    },
    create(input: CourseCreateRequest, idempotencyKey: string) {
      return request('/bff/v1/courses', 'POST', courseReadResultSchema, input, idempotencyKey);
    },
    update(courseId: string, input: CourseUpdateRequest, idempotencyKey: string) {
      return request(
        `/bff/v1/courses/${encodeURIComponent(courseId)}`,
        'PATCH',
        courseReadResultSchema,
        input,
        idempotencyKey,
      );
    },
    remove(courseId: string, expectedRevision: number) {
      return request(
        `/bff/v1/courses/${encodeURIComponent(courseId)}?expectedRevision=${expectedRevision}`,
        'DELETE',
        z.object({ deleted: z.boolean() }),
      );
    },
    deletionImpact(activityId: string, signal?: AbortSignal) {
      return request(
        `/bff/v1/activities/${encodeURIComponent(activityId)}/deletion-impact`,
        'GET',
        activityDeletionImpactSchema,
        null,
        null,
        signal,
      );
    },
  };
}

export type CourseApi = ReturnType<typeof createCourseApi>;
