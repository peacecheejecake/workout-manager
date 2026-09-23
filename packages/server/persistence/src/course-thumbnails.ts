import { randomUUID } from 'node:crypto';

import { coursePositionSchema, type CoursePosition } from '@workout/contracts/courses';
import { Pool } from 'pg';
import { z } from 'zod';

/**
 * The render worker's view of a stored course thumbnail (M2-01l).
 *
 * The worker has **no table access at all**: every call below is one bounded SECURITY
 * DEFINER function. It therefore cannot read a course name, a protected area, another
 * tenant's rows, or any object key it was not handed. What it sees of a tenant is the one
 * line it was asked to draw.
 */
const uuid = z.uuid().transform((value) => value.toLowerCase());
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const failureCode = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Z0-9_:-]+$/);

const leaseSchema = z.object({
  athlete_id: uuid,
  course_id: uuid,
  course_revision: z.number().int().positive(),
  revision_id: uuid,
  job_id: uuid,
  lease_token: uuid,
  temporary_ref: z.string().min(1).max(512),
  geometry: z.object({
    type: z.literal('LineString'),
    coordinates: z.array(coursePositionSchema).min(1),
  }),
});

export interface CourseThumbnailLease {
  readonly athleteId: string;
  readonly courseId: string;
  readonly courseRevision: number;
  readonly revisionId: string;
  readonly jobId: string;
  readonly leaseToken: string;
  readonly temporaryRef: string;
  readonly coordinates: readonly CoursePosition[];
}

/** What `finalize` concluded. `superseded` means the course moved on while we drew. */
export type CourseThumbnailFinalizeOutcome = 'ready' | 'superseded' | 'lease_lost';

export interface CourseThumbnailWorkerRepository {
  lease(durationSeconds?: number): Promise<CourseThumbnailLease | null>;
  prepare(
    lease: CourseThumbnailLease,
    input: { storageRef: string; sha256: string; byteSize: number; vertexCount: number },
  ): Promise<boolean>;
  publicationFenceOpen(lease: CourseThumbnailLease): Promise<boolean>;
  finalize(lease: CourseThumbnailLease): Promise<CourseThumbnailFinalizeOutcome>;
  markUnavailable(lease: CourseThumbnailLease, reason: 'line_too_short_to_draw'): Promise<boolean>;
  /**
   * Hand a lease back without spending an attempt. Only a render that has not prepared yet
   * can be released; anything further along is the reaper's to unwind.
   */
  release(lease: CourseThumbnailLease): Promise<boolean>;
  fail(
    lease: CourseThumbnailLease,
    code: string,
    options?: { retryable?: boolean; retryAfterSeconds?: number },
  ): Promise<boolean>;
  requeueRefs(lease: CourseThumbnailLease): Promise<boolean>;
  close(): Promise<void>;
}

export function createCourseThumbnailWorkerRepository(options: {
  connectionString: string;
  workerId?: string;
}): CourseThumbnailWorkerRepository {
  // Two connections and short timeouts: a render must never be the reason another writer
  // waits, and a stuck statement must give the lease back rather than hold it.
  const pool = new Pool({
    connectionString: options.connectionString,
    max: 2,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
    lock_timeout: 5000,
  });
  const workerId = uuid.parse(options.workerId ?? randomUUID());
  return {
    async lease(durationSeconds = 60) {
      const duration = z.number().int().min(1).max(300).parse(durationSeconds);
      const result = await pool.query('SELECT * FROM public.lease_course_thumbnail_render($1,$2)', [
        workerId,
        `${duration} seconds`,
      ]);
      if (!result.rows[0]) return null;
      const row = leaseSchema.parse(result.rows[0]);
      return {
        athleteId: row.athlete_id,
        courseId: row.course_id,
        courseRevision: row.course_revision,
        revisionId: row.revision_id,
        jobId: row.job_id,
        leaseToken: row.lease_token,
        temporaryRef: row.temporary_ref,
        coordinates: row.geometry.coordinates,
      };
    },
    async prepare(lease, input) {
      const result = await pool.query(
        'SELECT public.prepare_course_thumbnail($1,$2,$3,$4,$5,$6) AS prepared',
        [
          lease.jobId,
          lease.leaseToken,
          z.string().min(1).max(512).parse(input.storageRef),
          sha256.parse(input.sha256),
          z.number().int().min(1).max(65536).parse(input.byteSize),
          z.number().int().min(2).max(400).parse(input.vertexCount),
        ],
      );
      return result.rows[0]?.['prepared'] === true;
    },
    async publicationFenceOpen(lease) {
      const result = await pool.query(
        'SELECT public.course_thumbnail_publication_fence_open($1,$2) AS open',
        [lease.jobId, lease.leaseToken],
      );
      return result.rows[0]?.['open'] === true;
    },
    async finalize(lease) {
      const result = await pool.query(
        'SELECT outcome FROM public.finalize_course_thumbnail($1,$2)',
        [lease.jobId, lease.leaseToken],
      );
      return z
        .enum(['ready', 'superseded', 'lease_lost'])
        .parse(result.rows[0]?.['outcome'] ?? 'lease_lost');
    },
    async markUnavailable(lease, reason) {
      const result = await pool.query(
        'SELECT public.mark_course_thumbnail_unavailable($1,$2,$3) AS marked',
        [lease.jobId, lease.leaseToken, z.literal('line_too_short_to_draw').parse(reason)],
      );
      return result.rows[0]?.['marked'] === true;
    },
    async release(lease) {
      const result = await pool.query(
        'SELECT public.release_course_thumbnail_render($1,$2) AS released',
        [lease.jobId, lease.leaseToken],
      );
      return result.rows[0]?.['released'] === true;
    },
    async fail(lease, code, options) {
      const retryable = options?.retryable ?? false;
      const retryAfterSeconds = retryable
        ? z
            .number()
            .int()
            .min(0)
            .max(86400)
            .parse(options?.retryAfterSeconds ?? 60)
        : 0;
      const result = await pool.query(
        'SELECT public.fail_course_thumbnail($1,$2,$3,$4,$5) AS failed',
        [
          lease.jobId,
          lease.leaseToken,
          failureCode.parse(code),
          retryable,
          `${retryAfterSeconds} seconds`,
        ],
      );
      return result.rows[0]?.['failed'] === true;
    },
    async requeueRefs(lease) {
      const result = await pool.query('SELECT public.requeue_course_thumbnail_refs($1) AS queued', [
        lease.jobId,
      ]);
      return Number(result.rows[0]?.['queued'] ?? 0) >= 0;
    },
    close: () => pool.end(),
  };
}
