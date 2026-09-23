import { z } from 'zod';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import { transportReplySchema } from '@workout/contracts/core';
import {
  activityDeletionImpactSchema,
  courseListSchema,
  courseReadResultSchema,
  courseRouteCandidateResultSchema,
  courseRouteProposalResultSchema,
  courseRoutePreviewResultSchema,
  type CourseCreateRequest,
  type CourseRoutePreviewRequest,
  type CourseRouteCandidateRequest,
  type CourseRouteProposalRequest,
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
    /**
     * Ask our own engine for a route under this draft.
     *
     * The abort signal is not a convenience: the server turns a dropped connection into a
     * cancellation of the computation itself and releases the tenant's permit, so a screen
     * that goes away or a draft that moves on stops costing engine time. Every outcome
     * other than `route_computed` has stored nothing.
     */
    async computeRoute(courseId: string, input: CourseRouteProposalRequest, signal?: AbortSignal) {
      const reply = transportReplySchema.parse(
        await transport.request({
          path: `/bff/v1/courses/${encodeURIComponent(courseId)}/route-proposals`,
          method: 'POST',
          body: z.json().parse(input),
          idempotencyKey: null,
          ...(signal ? { signal } : {}),
        }),
      );
      // A named outcome is an answer, not an error, even when its status is 429, 499, 502
      // or 504: the status says what kind of answer it is and the body says which one. Only
      // a reply that is not a known outcome at all becomes a request error, so "the engine
      // refused and stored nothing" is never collapsed into "something went wrong".
      const outcome = courseRouteProposalResultSchema.safeParse(reply.body);
      if (outcome.success) return outcome.data;
      const parsed = errorSchema.safeParse(reply.body);
      throw new CourseRequestError(
        reply.status,
        parsed.success ? parsed.data.error.code : 'REQUEST_FAILED',
      );
    },
    /**
     * Ask for a route under a draft that is not a course yet (M2-01r, `/courses/new`).
     *
     * Nothing is stored for it, on any outcome. The answer carries the server's digest of
     * the line, which is what a later save sends back: the save computes again and writes
     * only if it gets this line. A named outcome is an answer, exactly as for a proposal.
     */
    async previewRoute(input: CourseRoutePreviewRequest, signal?: AbortSignal) {
      const reply = transportReplySchema.parse(
        await transport.request({
          path: '/bff/v1/courses/route-previews',
          method: 'POST',
          body: z.json().parse(input),
          idempotencyKey: null,
          ...(signal ? { signal } : {}),
        }),
      );
      const outcome = courseRoutePreviewResultSchema.safeParse(reply.body);
      if (outcome.success) return outcome.data;
      const parsed = errorSchema.safeParse(reply.body);
      throw new CourseRequestError(
        reply.status,
        parsed.success ? parsed.data.error.code : 'REQUEST_FAILED',
      );
    },
    /**
     * Ask for bounded target-distance candidates under this draft (M2-01i).
     *
     * A search is longer than one computation, so the abort signal matters more: the server
     * stops between attempts when the connection drops and releases the tenant's permit.
     * Every outcome other than `candidates_generated` has stored nothing, and
     * `no_candidate` is an answer — the search looked and found none — rather than a
     * failure, which is why it is read from the body and not from the status alone.
     */
    async generateCandidates(
      courseId: string,
      input: CourseRouteCandidateRequest,
      signal?: AbortSignal,
    ) {
      const reply = transportReplySchema.parse(
        await transport.request({
          path: `/bff/v1/courses/${encodeURIComponent(courseId)}/route-candidates`,
          method: 'POST',
          body: z.json().parse(input),
          idempotencyKey: null,
          ...(signal ? { signal } : {}),
        }),
      );
      const outcome = courseRouteCandidateResultSchema.safeParse(reply.body);
      if (outcome.success) return outcome.data;
      const parsed = errorSchema.safeParse(reply.body);
      throw new CourseRequestError(
        reply.status,
        parsed.success ? parsed.data.error.code : 'REQUEST_FAILED',
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
