import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  courseLimits,
  courseNameSchema,
  coursePositionSchema,
  coursePreferenceListSchema,
  coursePrivacyZoneSchema,
  type CoursePreference,
  type CoursePreferenceList,
  type CoursePreferenceUpdate,
  type CoursePrivacyZone,
} from '@workout/contracts/courses';

import type { Database, Transaction } from './database.js';

/**
 * Per-owner course preferences and protected areas (M2-01j).
 *
 * Deliberately a separate repository from the course ledger. Nothing in here appends a
 * revision, touches a content digest or moves a head: a favourite mark is not a change to
 * a course, and marking a course as used is not an edit of it. Keeping the two apart is
 * what makes "a preference never becomes course content" structural rather than a habit.
 *
 * A protected-area centre is the most sensitive coordinate this product holds. It is read
 * and written here and nowhere else, and it is never logged, never digested into anything
 * that leaves the server and never copied into a course revision.
 */
const uuid = z.uuid().transform((value) => value.toLowerCase());

export class PrivacyZoneStateError extends Error {
  constructor(readonly code: 'PRIVACY_ZONE_QUOTA_EXCEEDED' | 'PRIVACY_ZONE_NOT_FOUND') {
    super(code);
    this.name = 'PrivacyZoneStateError';
  }
}

export class CoursePreferenceError extends Error {
  readonly code = 'COURSE_NOT_FOUND';

  constructor() {
    super('COURSE_NOT_FOUND');
    this.name = 'CoursePreferenceError';
  }
}

const instant = (value: unknown) =>
  value instanceof Date ? value.toISOString() : new Date(z.string().parse(value)).toISOString();

const preferenceRowSchema = z.object({
  course_id: uuid,
  favourite: z.boolean(),
  last_used_at: z.union([z.date(), z.string()]).nullable(),
});

const zoneRowSchema = z.object({
  zone_id: uuid,
  name: z.string(),
  center_longitude: z.coerce.number().finite(),
  center_latitude: z.coerce.number().finite(),
  radius_meters: z.coerce.number().finite(),
  created_at: z.union([z.date(), z.string()]),
  updated_at: z.union([z.date(), z.string()]),
});

function zone(row: z.infer<typeof zoneRowSchema>): CoursePrivacyZone {
  return coursePrivacyZoneSchema.parse({
    zoneId: row.zone_id,
    name: row.name,
    center: [row.center_longitude, row.center_latitude],
    radiusMeters: row.radius_meters,
    createdAt: instant(row.created_at),
    updatedAt: instant(row.updated_at),
  });
}

async function databaseNow(tx: Transaction) {
  return instant((await tx.query('SELECT statement_timestamp() AS at')).rows[0]?.['at']);
}

/**
 * The owner's protected areas, ordered. The identity of the set is computed by the domain
 * (it must never cover a centre), which is why this repository returns the rows and not a
 * list DTO: a digest is a decision about what may leave the server, not a storage concern.
 */
async function listZones(tx: Transaction): Promise<CoursePrivacyZone[]> {
  const rows = await tx.query(
    `SELECT zone_id,name,center_longitude,center_latitude,radius_meters,created_at,updated_at
     FROM course_privacy_zone WHERE athlete_id=$1 ORDER BY created_at,zone_id LIMIT $2`,
    [tx.athleteId, courseLimits.privacyZonesPerTenant],
  );
  return rows.rows.map((row) => zone(zoneRowSchema.parse(row)));
}

export interface CoursePreferenceRepository {
  /** Every preference this owner has. Courses without one simply have no row. */
  list(athleteId: string): Promise<CoursePreferenceList>;
  /**
   * Write the allowlisted fields of one preference. `markUsed` records the server's clock.
   * The course must exist and belong to the caller — the foreign key enforces that, and a
   * violation is reported as a missing course rather than as a database error.
   */
  write(
    athleteId: string,
    courseId: string,
    update: CoursePreferenceUpdate,
  ): Promise<CoursePreference>;
  listPrivacyZones(athleteId: string): Promise<CoursePrivacyZone[]>;
  createPrivacyZone(
    athleteId: string,
    input: { name: string; center: readonly [number, number]; radiusMeters: number },
  ): Promise<CoursePrivacyZone[]>;
  removePrivacyZone(athleteId: string, zoneId: string): Promise<CoursePrivacyZone[]>;
}

export function createCoursePreferenceRepository(database: Database): CoursePreferenceRepository {
  return {
    list(athleteId) {
      const tenantId = uuid.parse(athleteId);
      return database.tenant(tenantId, async (tx) => {
        const rows = await tx.query(
          `SELECT course_id,favourite,last_used_at FROM course_preference
           WHERE athlete_id=$1 ORDER BY course_id LIMIT $2`,
          [tenantId, courseLimits.coursesPerTenant],
        );
        const preferences = rows.rows.map((row) => {
          const parsed = preferenceRowSchema.parse(row);
          return {
            courseId: parsed.course_id,
            favourite: parsed.favourite,
            lastUsedAt: parsed.last_used_at === null ? null : instant(parsed.last_used_at),
          };
        });
        return coursePreferenceListSchema.parse({ preferences, total: preferences.length });
      });
    },

    write(athleteId, rawCourseId, update) {
      const tenantId = uuid.parse(athleteId);
      const courseId = uuid.parse(rawCourseId);
      const favourite = update.favourite;
      const markUsed = update.markUsed === true;
      return database.tenant(tenantId, async (tx) => {
        // The same tenant lock the protected-area writes and every course write take, in
        // the same place: after the account lock `database.tenant` has already taken and
        // before any row. Without it the course check below and the insert that follows
        // are two decisions, and a course deleted in between turns the promised
        // COURSE_NOT_FOUND into a raw foreign-key violation — observed in 198 of 200
        // rounds of a preference write racing a deletion of the same course.
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [tenantId]);
        const at = await databaseNow(tx);
        // A course that is not this owner's has no row to write against. Checked here so
        // the answer is a missing course rather than a foreign-key violation surfacing as
        // an unexpected error.
        const course = await tx.query('SELECT 1 FROM course WHERE athlete_id=$1 AND course_id=$2', [
          tenantId,
          courseId,
        ]);
        if (course.rows.length === 0) throw new CoursePreferenceError();
        const written = await tx.query(
          `INSERT INTO course_preference(athlete_id,course_id,favourite,last_used_at,
             created_at,updated_at)
           VALUES($1,$2,coalesce($3,false),CASE WHEN $4 THEN $5::timestamptz ELSE NULL END,$5,$5)
           ON CONFLICT (athlete_id,course_id) DO UPDATE
             SET favourite=coalesce($3,course_preference.favourite),
                 last_used_at=CASE WHEN $4 THEN $5::timestamptz
                                   ELSE course_preference.last_used_at END,
                 updated_at=$5
           RETURNING course_id,favourite,last_used_at`,
          [tenantId, courseId, favourite ?? null, markUsed, at],
        );
        const parsed = preferenceRowSchema.parse(written.rows[0]);
        return {
          courseId: parsed.course_id,
          favourite: parsed.favourite,
          lastUsedAt: parsed.last_used_at === null ? null : instant(parsed.last_used_at),
        };
      });
    },

    listPrivacyZones(athleteId) {
      const tenantId = uuid.parse(athleteId);
      return database.tenant(tenantId, (tx) => listZones(tx));
    },

    createPrivacyZone(athleteId, input) {
      const tenantId = uuid.parse(athleteId);
      const name = courseNameSchema.parse(input.name);
      const center = coursePositionSchema.parse(input.center);
      const radiusMeters = z
        .number()
        .finite()
        .min(courseLimits.privacyZoneMinRadiusMeters)
        .max(courseLimits.privacyZoneMaxRadiusMeters)
        .parse(input.radiusMeters);
      return database.tenant(tenantId, async (tx) => {
        // One tenant, one lock: the count below and the insert that follows it have to be
        // one decision, or two concurrent additions both see room for the last one.
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [tenantId]);
        const existing = await tx.query(
          'SELECT count(*)::integer AS total FROM course_privacy_zone WHERE athlete_id=$1',
          [tenantId],
        );
        if (
          z.number().int().parse(existing.rows[0]?.['total']) >= courseLimits.privacyZonesPerTenant
        )
          throw new PrivacyZoneStateError('PRIVACY_ZONE_QUOTA_EXCEEDED');
        const at = await databaseNow(tx);
        await tx.query(
          `INSERT INTO course_privacy_zone(athlete_id,zone_id,name,center_longitude,
             center_latitude,radius_meters,created_at,updated_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$7)`,
          [tenantId, randomUUID(), name, center[0], center[1], radiusMeters, at],
        );
        return listZones(tx);
      });
    },

    removePrivacyZone(athleteId, rawZoneId) {
      const tenantId = uuid.parse(athleteId);
      const zoneId = uuid.parse(rawZoneId);
      return database.tenant(tenantId, async (tx) => {
        // The same tenant lock the addition takes, and the one a course write takes while
        // it re-checks this set: a removal must not slip between that check and the
        // revision it guards.
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [tenantId]);
        const removed = await tx.query(
          'DELETE FROM course_privacy_zone WHERE athlete_id=$1 AND zone_id=$2',
          [tenantId, zoneId],
        );
        if (removed.rowCount !== 1) throw new PrivacyZoneStateError('PRIVACY_ZONE_NOT_FOUND');
        return listZones(tx);
      });
    },
  };
}
