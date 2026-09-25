import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { z } from 'zod';

import {
  courseDisclosureExposureSchema,
  courseDisclosurePurposeSchema,
  courseDisclosureReceiptSchema,
  courseShareListSchema,
  courseShareSchema,
  courseSharingLimits,
  sharedCourseSchema,
  type CourseDisclosureExposure,
  type CourseDisclosurePurpose,
  type CourseDisclosureReceipt,
  type CourseShare,
  type CourseShareList,
} from '@workout/contracts/course-sharing';
import {
  courseLimits,
  coursePrivacyZoneSchema,
  type CoursePrivacyZone,
} from '@workout/contracts/courses';

import type { Database, Transaction } from './database.js';
import { PersistenceConflict } from './outbox.js';

/**
 * What may leave the account from a course, stored (M2-01k-o, migration 050).
 *
 * The geometry decisions — what a line discloses, where a share circle is, whether a link
 * touches a new circle — are the domain's, and arrive here as values or injected functions,
 * exactly like `requireZoneSet.digestOf` in the course ledger. This repository decides
 * nothing about what may leave; it makes the decisions atomic, tenant-scoped and final.
 */
const uuid = z.uuid().transform((value) => value.toLowerCase());
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const idempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const instant = (value: unknown) =>
  value instanceof Date ? value.toISOString() : new Date(z.string().parse(value)).toISOString();

/** A protected area's secret share offset: a point of the unit disc (B-1). */
export interface StoredShareOffset {
  readonly x: number;
  readonly y: number;
}

/**
 * A uniform point of the unit disc from the operating system's CSPRNG. The domain has the
 * same draw (`drawShareOffset`); this default exists so that a composition that injects
 * nothing still stores a secret offset rather than none.
 */
export function drawStoredShareOffset(): StoredShareOffset {
  const unit = () => randomBytes(6).readUIntBE(0, 6) / 2 ** 48;
  const radius = Math.sqrt(unit());
  const angle = 2 * Math.PI * unit();
  return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
}

export class CourseSharingStateError extends Error {
  constructor(
    readonly code:
      | 'COURSE_NOT_FOUND'
      | 'COURSE_UNAVAILABLE'
      | 'COURSE_REVISION_CONFLICT'
      | 'COURSE_ZONE_ACKNOWLEDGEMENT_STALE'
      | 'COURSE_EXPORT_NOT_CONFIRMED'
      | 'COURSE_SHARE_REQUIRES_PROTECTED_AREA'
      | 'COURSE_SHARE_LIMIT_REACHED'
      | 'COURSE_SHARE_AREA_LIFETIME_REACHED'
      | 'COURSE_SHARE_NOT_FOUND',
  ) {
    super(code);
    this.name = 'CourseSharingStateError';
  }
}

const snapshotSchema = sharedCourseSchema.omit({ expiresOn: true });

/** The line a link shows, stored beside the ledger. Exactly the recipient's read model. */
export type ShareSnapshot = z.infer<typeof snapshotSchema>;

async function tenantLock(tx: Transaction) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [tx.athleteId]);
}

async function readZones(tx: Transaction): Promise<CoursePrivacyZone[]> {
  const rows = await tx.query(
    `SELECT zone_id,name,center_longitude,center_latitude,radius_meters,created_at,updated_at
     FROM course_privacy_zone WHERE athlete_id=$1 ORDER BY created_at,zone_id LIMIT $2`,
    [tx.athleteId, courseLimits.privacyZonesPerTenant],
  );
  return rows.rows.map((row) =>
    coursePrivacyZoneSchema.parse({
      zoneId: row['zone_id'],
      name: row['name'],
      center: [Number(row['center_longitude']), Number(row['center_latitude'])],
      radiusMeters: Number(row['radius_meters']),
      createdAt: instant(row['created_at']),
      updatedAt: instant(row['updated_at']),
    }),
  );
}

/** The head of one course, or `null` when the course is not this owner's. */
async function readHead(
  tx: Transaction,
  courseId: string,
): Promise<{ status: 'available' | 'unavailable'; headRevision: number | null } | null> {
  const rows = await tx.query(
    'SELECT status,head_revision FROM course WHERE athlete_id=$1 AND course_id=$2',
    [tx.athleteId, courseId],
  );
  const row = rows.rows[0];
  if (!row) return null;
  return z
    .object({
      status: z.enum(['available', 'unavailable']),
      head_revision: z.number().int().positive().nullable(),
    })
    .transform((value) => ({ status: value.status, headRevision: value.head_revision }))
    .parse(row);
}

const receiptRowSchema = z.object({
  receipt_id: uuid,
  purpose: courseDisclosurePurposeSchema,
  course_id: uuid,
  course_revision: z.number().int().positive(),
  zone_set_digest: sha256,
  exposure: courseDisclosureExposureSchema,
  include_names: z.boolean(),
  confirmed_at: z.union([z.date(), z.string()]),
  expires_at: z.union([z.date(), z.string()]),
});
const RECEIPT_COLUMNS =
  'receipt_id,purpose,course_id,course_revision,zone_set_digest,exposure,include_names,confirmed_at,expires_at';

function receipt(row: unknown): CourseDisclosureReceipt {
  const parsed = receiptRowSchema.parse(row);
  return courseDisclosureReceiptSchema.parse({
    receiptId: parsed.receipt_id,
    purpose: parsed.purpose,
    courseId: parsed.course_id,
    courseRevision: parsed.course_revision,
    zoneSetDigest: parsed.zone_set_digest,
    exposure: parsed.exposure,
    includeNames: parsed.include_names,
    confirmedAt: instant(parsed.confirmed_at),
    expiresAt: instant(parsed.expires_at),
  });
}

const shareRowSchema = z.object({
  share_id: uuid,
  course_id: uuid,
  course_revision: z.number().int().positive(),
  state: z.enum(['active', 'revoked']),
  revoke_reason: z.enum(['owner', 'owner_all', 'zone_added', 'zone_removed']).nullable(),
  include_names: z.boolean(),
  epoch: z.number().int().positive(),
  created_at: z.union([z.date(), z.string()]),
  expires_at: z.union([z.date(), z.string()]),
  revoked_at: z.union([z.date(), z.string()]).nullable(),
  expired: z.boolean(),
});
const SHARE_COLUMNS = `share_id,course_id,course_revision,state,revoke_reason,include_names,epoch,
  created_at,expires_at,revoked_at,expires_at<=clock_timestamp() AS expired`;

/** A link as the owner sees it, with the state the reads actually apply. */
function share(row: unknown, epoch: number): CourseShare {
  const parsed = shareRowSchema.parse(row);
  const state =
    parsed.state === 'revoked'
      ? 'revoked'
      : parsed.epoch !== epoch
        ? 'invalidated'
        : parsed.expired
          ? 'expired'
          : 'active';
  return courseShareSchema.parse({
    shareId: parsed.share_id,
    courseId: parsed.course_id,
    courseRevision: parsed.course_revision,
    state,
    revokeReason: parsed.revoke_reason,
    includeNames: parsed.include_names,
    createdAt: instant(parsed.created_at),
    expiresAt: instant(parsed.expires_at),
    revokedAt: parsed.revoked_at === null ? null : instant(parsed.revoked_at),
  });
}

type RevokeReason = 'owner' | 'owner_all' | 'zone_added' | 'zone_removed';

/**
 * Revoke the given active links of the transaction's tenant, with an audit fact each. The
 * caller holds the tenant lock. Returns how many moved.
 */
export async function revokeSharesIn(
  tx: Transaction,
  shareIds: readonly string[],
  reason: RevokeReason,
): Promise<number> {
  if (shareIds.length === 0) return 0;
  const revoked = await tx.query(
    `UPDATE course_share SET state='revoked',revoked_at=clock_timestamp(),revoke_reason=$3
     WHERE athlete_id=$1 AND share_id=ANY($2::uuid[]) AND state='active'
     RETURNING share_id,course_id`,
    [tx.athleteId, shareIds, reason],
  );
  for (const row of revoked.rows)
    await tx.query(
      `INSERT INTO course_share_audit(athlete_id,audit_id,share_id,course_id,action,reason,
         occurred_at) VALUES($1,$2,$3,$4,'revoked',$5,clock_timestamp())`,
      [tx.athleteId, randomUUID(), row['share_id'], row['course_id'], reason],
    );
  return revoked.rows.length;
}

/**
 * The bound on the per-owner link queries below. An owner has at most
 * `activeSharesPerOwner` (20) unexpired active links under one epoch, and every link expires
 * within 30 days, so the unexpired active rows are 20 per epoch the deployment used in the
 * last 30 days — a restore raises the epoch, and restores are rare. 500 is far above that,
 * and each query here also skips expired rows, so the reaper's backlog cannot use it up.
 * The owner's list is newest first, so the bound can only ever hide the oldest facts.
 */
const OWNER_LINK_BOUND = 500;

/** The active links of the tenant, with their snapshots, for the zone-add re-check (B-6). */
export async function activeShareSnapshotsIn(
  tx: Transaction,
): Promise<{ shareId: string; snapshot: ShareSnapshot }[]> {
  const rows = await tx.query(
    `SELECT share_id,snapshot FROM course_share WHERE athlete_id=$1 AND state='active'
       AND expires_at>clock_timestamp()
     ORDER BY created_at DESC,share_id LIMIT ${OWNER_LINK_BOUND}`,
    [tx.athleteId],
  );
  return rows.rows.map((row) => ({
    shareId: uuid.parse(row['share_id']),
    snapshot: snapshotSchema.parse(row['snapshot']),
  }));
}

/** Store a new area's secret offset. Drawn once, never redrawn (a trigger refuses UPDATE). */
export async function insertShareOffsetIn(
  tx: Transaction,
  zoneId: string,
  offset: StoredShareOffset,
): Promise<void> {
  await tx.query(
    `INSERT INTO course_privacy_zone_share_offset(athlete_id,zone_id,offset_x,offset_y,created_at)
     VALUES($1,$2,$3,$4,clock_timestamp()) ON CONFLICT (athlete_id,zone_id) DO NOTHING`,
    [tx.athleteId, zoneId, offset.x, offset.y],
  );
}

export interface ZoneWithOffset {
  readonly zone: CoursePrivacyZone;
  readonly offset: StoredShareOffset;
}

export interface RecordReceiptInput {
  readonly courseId: string;
  readonly courseRevision: number;
  readonly purpose: CourseDisclosurePurpose;
  readonly exposure: CourseDisclosureExposure;
  readonly zoneSetDigest: string;
  readonly includeNames: boolean;
  readonly idempotencyKey: string;
  /** What the receipt records about the request, for recognising a resend. */
  readonly request: unknown;
  readonly digestOf: (zones: readonly CoursePrivacyZone[]) => string;
}

export interface CreateShareInput {
  readonly courseId: string;
  readonly receiptId: string;
  /** What the line being stored discloses. The receipt must have confirmed exactly this. */
  readonly exposure: 'trimmed' | 'no-zone-intersection';
  readonly tokenDigest: string;
  readonly epoch: number;
  readonly expiresInDays: number;
  readonly snapshot: ShareSnapshot;
  readonly zoneIds: readonly string[];
  /**
   * The protected areas that actually cut this link (M2-01as): each gives up one link of its
   * lifetime budget, all or nothing, in the same transaction as the link. Empty for a line
   * that touches no area. A subset of `zoneIds`.
   */
  readonly cutZoneIds: readonly string[];
  /** The protected-area set the snapshot was cut against, re-checked inside the write. */
  readonly zoneSetDigest: string;
  readonly digestOf: (zones: readonly CoursePrivacyZone[]) => string;
}

export interface CourseSharingRepository {
  /**
   * The receipt an earlier confirmation under this key produced, or `null` when the key is
   * unused. A different request under a used key is a conflict. Asked before anything is
   * recomputed, so a resend after a trimmed GPX confirmation (whose head has since moved on
   * by the revision it appended) is recognised instead of refused as stale.
   */
  replayReceipt(
    athleteId: string,
    idempotencyKey: string,
    request: unknown,
  ): Promise<CourseDisclosureReceipt | null>;
  /**
   * The owner's protected areas with their secret offsets. An area made before offsets
   * existed gets one now, drawn once and never again.
   */
  zonesWithShareOffsets(athleteId: string): Promise<ZoneWithOffset[]>;
  recordReceipt(athleteId: string, input: RecordReceiptInput): Promise<CourseDisclosureReceipt>;
  /**
   * One receipt that is still usable for `purpose`, read in the same snapshot as the
   * course head and the protected areas it has to match. `null` when there is no such
   * receipt for this course, or it has expired.
   */
  readUsableReceipt(
    athleteId: string,
    courseId: string,
    receiptId: string,
    purpose: CourseDisclosurePurpose | null,
  ): Promise<{
    receipt: CourseDisclosureReceipt;
    headRevision: number | null;
    zones: CoursePrivacyZone[];
  } | null>;
  listShares(athleteId: string, epoch: number): Promise<CourseShareList>;
  createShare(athleteId: string, input: CreateShareInput): Promise<CourseShare>;
  revokeShare(athleteId: string, shareId: string, epoch: number): Promise<CourseShare>;
  revokeAllShares(athleteId: string): Promise<number>;
}

export function createCourseSharingRepository(
  database: Database,
  options: { readonly drawShareOffset?: () => StoredShareOffset } = {},
): CourseSharingRepository {
  const draw = options.drawShareOffset ?? drawStoredShareOffset;
  return {
    replayReceipt(athleteId, rawKey, request) {
      const tenantId = uuid.parse(athleteId);
      const key = idempotencyKey.parse(rawKey);
      const requestDigest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
      return database.tenant(tenantId, async (tx) => {
        const previous = await tx.query(
          `SELECT ${RECEIPT_COLUMNS},request_digest FROM course_disclosure_receipt
           WHERE athlete_id=$1 AND idempotency_key=$2`,
          [tenantId, key],
        );
        if (!previous.rows[0]) return null;
        if (previous.rows[0]['request_digest'] !== requestDigest)
          throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
        return receipt(previous.rows[0]);
      });
    },

    zonesWithShareOffsets(athleteId) {
      const tenantId = uuid.parse(athleteId);
      return database.tenant(tenantId, async (tx) => {
        await tenantLock(tx);
        const zones = await readZones(tx);
        const existing = await tx.query(
          `SELECT zone_id,offset_x,offset_y FROM course_privacy_zone_share_offset
           WHERE athlete_id=$1`,
          [tenantId],
        );
        const offsets = new Map<string, StoredShareOffset>(
          existing.rows.map((row) => [
            uuid.parse(row['zone_id']),
            { x: Number(row['offset_x']), y: Number(row['offset_y']) },
          ]),
        );
        for (const zone of zones) {
          if (offsets.has(zone.zoneId)) continue;
          await insertShareOffsetIn(tx, zone.zoneId, draw());
          const stored = await tx.query(
            `SELECT offset_x,offset_y FROM course_privacy_zone_share_offset
             WHERE athlete_id=$1 AND zone_id=$2`,
            [tenantId, zone.zoneId],
          );
          const row = stored.rows[0];
          if (!row) throw new Error('SHARE_OFFSET_NOT_STORED');
          offsets.set(zone.zoneId, { x: Number(row['offset_x']), y: Number(row['offset_y']) });
        }
        return zones.map((zone) => {
          const offset = offsets.get(zone.zoneId);
          if (!offset) throw new Error('SHARE_OFFSET_NOT_STORED');
          return { zone, offset };
        });
      });
    },

    recordReceipt(athleteId, input) {
      const tenantId = uuid.parse(athleteId);
      const courseId = uuid.parse(input.courseId);
      const key = idempotencyKey.parse(input.idempotencyKey);
      const requestDigest = createHash('sha256')
        .update(JSON.stringify(input.request))
        .digest('hex');
      return database.tenant(tenantId, async (tx) => {
        await tenantLock(tx);
        const previous = await tx.query(
          `SELECT ${RECEIPT_COLUMNS},request_digest FROM course_disclosure_receipt
           WHERE athlete_id=$1 AND idempotency_key=$2`,
          [tenantId, key],
        );
        if (previous.rows[0]) {
          if (previous.rows[0]['request_digest'] !== requestDigest)
            throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
          return receipt(previous.rows[0]);
        }
        const head = await readHead(tx, courseId);
        if (head === null) throw new CourseSharingStateError('COURSE_NOT_FOUND');
        if (head.status !== 'available') throw new CourseSharingStateError('COURSE_UNAVAILABLE');
        if (head.headRevision !== input.courseRevision)
          throw new CourseSharingStateError('COURSE_REVISION_CONFLICT');
        // The set the confirmation was computed against, checked again under the same lock
        // every protected-area write takes.
        if (input.digestOf(await readZones(tx)) !== input.zoneSetDigest)
          throw new CourseSharingStateError('COURSE_ZONE_ACKNOWLEDGEMENT_STALE');
        await tx.query(
          'DELETE FROM course_disclosure_receipt WHERE athlete_id=$1 AND expires_at<=clock_timestamp()',
          [tenantId],
        );
        const inserted = await tx.query(
          `INSERT INTO course_disclosure_receipt(athlete_id,receipt_id,course_id,course_revision,
             purpose,exposure,zone_set_digest,include_names,idempotency_key,request_digest,
             confirmed_at,expires_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,statement_timestamp(),
             statement_timestamp()+make_interval(secs=>$11))
           RETURNING ${RECEIPT_COLUMNS}`,
          [
            tenantId,
            randomUUID(),
            courseId,
            input.courseRevision,
            input.purpose,
            input.exposure,
            sha256.parse(input.zoneSetDigest),
            input.includeNames,
            key,
            requestDigest,
            courseSharingLimits.confirmationTtlSeconds,
          ],
        );
        return receipt(inserted.rows[0]);
      });
    },

    readUsableReceipt(athleteId, rawCourseId, rawReceiptId, purpose) {
      const tenantId = uuid.parse(athleteId);
      const courseId = uuid.parse(rawCourseId);
      const receiptId = uuid.parse(rawReceiptId);
      return database.tenant(tenantId, async (tx) => {
        const found = await tx.query(
          `SELECT ${RECEIPT_COLUMNS} FROM course_disclosure_receipt
           WHERE athlete_id=$1 AND course_id=$2 AND receipt_id=$3
             AND ($4::text IS NULL OR purpose=$4::text) AND expires_at>clock_timestamp()`,
          [tenantId, courseId, receiptId, purpose],
        );
        if (!found.rows[0]) return null;
        const head = await readHead(tx, courseId);
        return {
          receipt: receipt(found.rows[0]),
          headRevision: head?.status === 'available' ? head.headRevision : null,
          zones: await readZones(tx),
        };
      });
    },

    listShares(athleteId, epoch) {
      const tenantId = uuid.parse(athleteId);
      return database.tenant(tenantId, async (tx) => {
        const rows = await tx.query(
          `SELECT ${SHARE_COLUMNS} FROM course_share WHERE athlete_id=$1
           ORDER BY created_at DESC,share_id LIMIT ${OWNER_LINK_BOUND}`,
          [tenantId],
        );
        const shares = rows.rows.map((row) => share(row, epoch));
        return courseShareListSchema.parse({
          shares,
          total: shares.length,
          activeTotal: shares.filter((item) => item.state === 'active').length,
        });
      });
    },

    createShare(athleteId, input) {
      const tenantId = uuid.parse(athleteId);
      const courseId = uuid.parse(input.courseId);
      const receiptId = uuid.parse(input.receiptId);
      const expiresInDays = z
        .number()
        .int()
        .min(1)
        .max(courseSharingLimits.shareExpiryMaxDays)
        .parse(input.expiresInDays);
      const snapshot = snapshotSchema.parse(input.snapshot);
      const zoneIds = z
        .array(uuid)
        .min(1)
        .max(courseLimits.privacyZonesPerTenant)
        .parse(input.zoneIds);
      const cutZoneIds = z
        .array(uuid)
        .max(courseLimits.privacyZonesPerTenant)
        .refine((ids) => ids.every((id) => zoneIds.includes(id)), 'CUT_ZONES_NOT_NAMED')
        .parse(input.cutZoneIds);
      return database.tenant(tenantId, async (tx) => {
        await tenantLock(tx);
        await tx.query('SELECT public.reap_course_shares(100)');
        // The one gate for "which confirmation may make a link" (D3b, T20): a `share`
        // receipt that confirmed exactly the line being stored. An export receipt — the
        // owner's exact line above all — is never one.
        const found = await tx.query(
          `SELECT ${RECEIPT_COLUMNS} FROM course_disclosure_receipt
           WHERE athlete_id=$1 AND course_id=$2 AND receipt_id=$3
             AND purpose='share' AND exposure=$4
             AND expires_at>clock_timestamp()`,
          [
            tenantId,
            courseId,
            receiptId,
            z.enum(['trimmed', 'no-zone-intersection']).parse(input.exposure),
          ],
        );
        if (!found.rows[0]) throw new CourseSharingStateError('COURSE_EXPORT_NOT_CONFIRMED');
        const confirmed = receipt(found.rows[0]);
        const head = await readHead(tx, courseId);
        if (head === null) throw new CourseSharingStateError('COURSE_NOT_FOUND');
        if (head.status !== 'available') throw new CourseSharingStateError('COURSE_UNAVAILABLE');
        // Pinned to the revision the owner confirmed, and that must still be the head: a link
        // made from a receipt for an older revision would show a line nobody confirmed now.
        if (head.headRevision !== confirmed.courseRevision)
          throw new CourseSharingStateError('COURSE_EXPORT_NOT_CONFIRMED');
        const zones = await readZones(tx);
        // D3c: a link needs at least one protected area, whatever the receipt says.
        if (zones.length === 0)
          throw new CourseSharingStateError('COURSE_SHARE_REQUIRES_PROTECTED_AREA');
        const digest = input.digestOf(zones);
        if (digest !== confirmed.zoneSetDigest || digest !== input.zoneSetDigest)
          throw new CourseSharingStateError('COURSE_EXPORT_NOT_CONFIRMED');
        const counts = await tx.query(
          `SELECT count(*) FILTER (WHERE TRUE)::integer AS for_owner,
             count(*) FILTER (WHERE course_id=$2)::integer AS for_course
           FROM course_share WHERE athlete_id=$1 AND state='active'
             AND expires_at>clock_timestamp() AND epoch=$3`,
          [tenantId, courseId, input.epoch],
        );
        const room = z
          .object({ for_owner: z.number().int(), for_course: z.number().int() })
          .parse(counts.rows[0]);
        if (
          room.for_owner >= courseSharingLimits.activeSharesPerOwner ||
          room.for_course >= courseSharingLimits.activeSharesPerCourse
        )
          throw new CourseSharingStateError('COURSE_SHARE_LIMIT_REACHED');
        // M2-01as: every area that cut this link gives up one link of its lifetime budget —
        // revoked, expired and restored-away links stay counted, and an area made again over
        // the same place inherits the count (migration 054). Refused when any has none left.
        if (cutZoneIds.length > 0) {
          const claimed = await tx.query(
            'SELECT public.claim_course_share_budget($1::uuid[]) AS claimed',
            [cutZoneIds],
          );
          if (!z.object({ claimed: z.boolean() }).parse(claimed.rows[0]).claimed)
            throw new CourseSharingStateError('COURSE_SHARE_AREA_LIFETIME_REACHED');
        }
        const shareId = randomUUID();
        // R-4: a link ends at a UTC midnight, `expiresInDays` days after the one before it
        // was made (so between days−1 and days after). The recipient sees only that date and
        // a 404 at a day boundary, neither of which says when in the day the link was made.
        const stored = confirmed.includeNames
          ? snapshot
          : {
              ...snapshot,
              name: undefined,
              waypoints: snapshot.waypoints.map((waypoint) => ({
                role: waypoint.role,
                position: waypoint.position,
              })),
            };
        const inserted = await tx.query(
          `INSERT INTO course_share(athlete_id,share_id,course_id,course_revision,receipt_id,
             token_digest,epoch,state,include_names,zone_ids,snapshot,created_at,expires_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,'active',$8,$9::uuid[],$10::jsonb,statement_timestamp(),
             date_trunc('day',statement_timestamp(),'UTC')+make_interval(days=>$11))
           RETURNING ${SHARE_COLUMNS}`,
          [
            tenantId,
            shareId,
            courseId,
            confirmed.courseRevision,
            receiptId,
            sha256.parse(input.tokenDigest),
            z.number().int().min(1).parse(input.epoch),
            confirmed.includeNames,
            zoneIds,
            JSON.stringify(snapshotSchema.parse(stored)),
            expiresInDays,
          ],
        );
        await tx.query(
          `INSERT INTO course_share_audit(athlete_id,audit_id,share_id,course_id,action,reason,
             occurred_at) VALUES($1,$2,$3,$4,'created',NULL,clock_timestamp())`,
          [tenantId, randomUUID(), shareId, courseId],
        );
        return share(inserted.rows[0], input.epoch);
      });
    },

    revokeShare(athleteId, rawShareId, epoch) {
      const tenantId = uuid.parse(athleteId);
      const shareId = uuid.parse(rawShareId);
      return database.tenant(tenantId, async (tx) => {
        await tenantLock(tx);
        await revokeSharesIn(tx, [shareId], 'owner');
        const found = await tx.query(
          `SELECT ${SHARE_COLUMNS} FROM course_share WHERE athlete_id=$1 AND share_id=$2`,
          [tenantId, shareId],
        );
        if (!found.rows[0]) throw new CourseSharingStateError('COURSE_SHARE_NOT_FOUND');
        return share(found.rows[0], epoch);
      });
    },

    revokeAllShares(athleteId) {
      const tenantId = uuid.parse(athleteId);
      return database.tenant(tenantId, async (tx) => {
        await tenantLock(tx);
        const active = await tx.query(
          `SELECT share_id FROM course_share WHERE athlete_id=$1 AND state='active'
             AND expires_at>clock_timestamp()
           ORDER BY created_at DESC,share_id LIMIT ${OWNER_LINK_BOUND}`,
          [tenantId],
        );
        return revokeSharesIn(
          tx,
          active.rows.map((row) => uuid.parse(row['share_id'])),
          'owner_all',
        );
      });
    },
  };
}

export type SharedReadOutcome =
  | {
      readonly outcome: 'ok';
      readonly snapshot: ShareSnapshot;
      readonly includeNames: boolean;
      readonly expiresAt: string;
    }
  | { readonly outcome: 'not_found' | 'limited' };

export interface SharedCourseReadLimits {
  readonly readsPerClientPerMinute: number;
  readonly readsPerSharePerMinute: number;
  readonly failedReadsPerClientPerHour: number;
}

/**
 * The one unauthenticated read (B). It has no tenant: it runs on its own pool, as the
 * restricted runtime role, and can do exactly one thing — call `read_course_share`.
 */
export interface SharedCourseReader {
  read(tokenDigest: string, epoch: number, clientKey: string): Promise<SharedReadOutcome>;
  close(): Promise<void>;
}

export function createSharedCourseReader(options: {
  readonly connectionString: string;
  readonly limits?: SharedCourseReadLimits;
  readonly max?: number;
}): SharedCourseReader {
  const limits = options.limits ?? {
    readsPerClientPerMinute: courseSharingLimits.readsPerClientPerMinute,
    readsPerSharePerMinute: courseSharingLimits.readsPerSharePerMinute,
    failedReadsPerClientPerHour: courseSharingLimits.failedReadsPerClientPerHour,
  };
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 4,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 5000,
  });
  let checked = false;
  return {
    async read(tokenDigest, epoch, clientKey) {
      const digest = sha256.parse(tokenDigest);
      const key = sha256.parse(clientKey);
      const client = await pool.connect();
      try {
        if (!checked) {
          // The same refusal every runtime pool makes: never a superuser, never BYPASSRLS,
          // never the owner of the tables this read reaches through its function.
          const role = await client.query(
            `SELECT r.rolsuper,r.rolbypassrls,EXISTS(SELECT 1 FROM pg_class c
               WHERE c.relname IN ('course_share','course_share_rate') AND c.relowner=r.oid)
               AS owns_tables FROM pg_roles r WHERE r.rolname=current_user`,
          );
          z.object({
            rolsuper: z.literal(false),
            rolbypassrls: z.literal(false),
            owns_tables: z.literal(false),
          }).parse(role.rows[0]);
          checked = true;
        }
        const result = await client.query(
          'SELECT outcome,snapshot,include_names,expires_at FROM public.read_course_share($1,$2,$3,$4,$5,$6)',
          [
            digest,
            epoch,
            key,
            limits.readsPerClientPerMinute,
            limits.readsPerSharePerMinute,
            limits.failedReadsPerClientPerHour,
          ],
        );
        const row = z
          .object({
            outcome: z.enum(['ok', 'not_found', 'limited']),
            snapshot: z.unknown(),
            include_names: z.boolean().nullable(),
            expires_at: z.union([z.date(), z.string()]).nullable(),
          })
          .parse(result.rows[0]);
        if (row.outcome !== 'ok') return { outcome: row.outcome };
        return {
          outcome: 'ok',
          snapshot: snapshotSchema.parse(row.snapshot),
          includeNames: z.boolean().parse(row.include_names),
          expiresAt: instant(row.expires_at),
        };
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
