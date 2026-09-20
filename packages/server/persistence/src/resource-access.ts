import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  privateResourceAccessStateSchema,
  privateResourceCoachUseManifestSchema,
  privateResourceCoachUseRevalidationSchema,
  privateResourceCoachUseTransitionSchema,
  privateResourceReviewedTransitionSchema,
  privateResourceShareGrantSchema,
  privateResourceShareRevokeSchema,
  privateResourceShareSchema,
  privateSharedResourceListQuerySchema,
  privateSharedResourceListSchema,
  privateSharedResourceReadSchema,
  type PrivateResourceAccessState,
  type PrivateResourceCoachUseManifest,
  type PrivateResourceCoachUseRevalidation,
  type PrivateResourceShare,
  type PrivateSharedResourceList,
  type PrivateSharedResourceListQuery,
  type PrivateSharedResourceRead,
} from '@workout/contracts/resources';

import type { Database, Transaction } from './database.js';
import { enqueue, PersistenceConflict } from './outbox.js';
import { ResourceNotFoundError } from './resources.js';

type ShareGrantInput = z.infer<typeof privateResourceShareGrantSchema>;
type ShareRevokeInput = z.infer<typeof privateResourceShareRevokeSchema>;
type ReviewedInput = z.infer<typeof privateResourceReviewedTransitionSchema>;
type CoachUseInput = z.infer<typeof privateResourceCoachUseTransitionSchema>;

const uuid = z.uuid().transform((value) => value.toLowerCase());
const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : new Date(z.string().parse(value)).toISOString();

export class ResourceAccessError extends Error {
  constructor(
    readonly code:
      | 'COACH_USE_REVIEW_REQUIRED'
      | 'COACH_USE_CONSENT_REQUIRED'
      | 'REVIEW_WITHDRAWAL_BLOCKED'
      | 'SHARE_GRANTEE_INVALID'
      | 'SHARE_LIMIT_EXCEEDED'
      | 'SHARE_NOT_FOUND'
      | 'COACH_USE_MANIFEST_TOO_LARGE'
      | 'COACH_USE_MANIFEST_INVALID',
  ) {
    super(code);
  }
}

const MAX_ACTIVE_SHARES_PER_RESOURCE = 20;
const MAX_REVOKED_SHARE_HISTORY = 50;
/** Must stay equal to the contract bound on manifest entries. */
const MAX_COACH_USE_MANIFEST_ENTRIES = 100;

const shareRowSchema = z.object({
  share_id: uuid,
  resource_id: uuid,
  grantee_kind: z.literal('coach'),
  grantee_principal_id: z.string().min(1).max(200),
  state: z.enum(['active', 'revoked']),
  granted_access_revision: z.number().int().positive(),
  revoked_access_revision: z.number().int().positive().nullable(),
  granted_at: z.union([z.date(), z.string()]),
  revoked_at: z.union([z.date(), z.string()]).nullable(),
});

const headRowSchema = z.object({
  access_revision: z.number().int().positive(),
  current_version_id: uuid,
  reviewed_state: z.enum(['unreviewed', 'reviewed']),
  reviewed_at: z.union([z.date(), z.string()]).nullable(),
  include_for_coach: z.boolean(),
  coach_use_enabled_at: z.union([z.date(), z.string()]).nullable(),
});

function share(row: z.infer<typeof shareRowSchema>): PrivateResourceShare {
  return privateResourceShareSchema.parse({
    schemaVersion: 1,
    shareId: row.share_id,
    resourceId: row.resource_id,
    granteeKind: row.grantee_kind,
    granteePrincipalId: row.grantee_principal_id,
    state: row.state,
    grantedAccessRevision: row.granted_access_revision,
    revokedAccessRevision: row.revoked_access_revision,
    grantedAt: iso(row.granted_at),
    revokedAt: row.revoked_at === null ? null : iso(row.revoked_at),
  });
}

async function lock(tx: Transaction) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [tx.athleteId]);
}

// The receipt stores no content, only the resource identity and the resulting
// revision, so tombstoning a deleted resource keeps replay free of stale facts.
const accessReceiptSchema = z.strictObject({
  status: z.literal('access'),
  resourceId: z.string(),
  accessRevision: z.number().int().positive(),
});

async function replayAccess(tx: Transaction, key: string, request: unknown) {
  const requestDigest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const row = (
    await tx.query(
      'SELECT request=$3::jsonb AS matches FROM command_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
      [tx.athleteId, key, JSON.stringify({ sha256: requestDigest })],
    )
  ).rows[0];
  if (!row) return false;
  if (row['matches'] !== true) throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
  return true;
}

async function finishAccessCommand(
  tx: Transaction,
  key: string,
  request: unknown,
  state: PrivateResourceAccessState,
  topic: string,
) {
  const requestDigest = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  await enqueue(tx, {
    id: randomUUID(),
    idempotencyKey: key,
    topic,
    payload: { resourceId: state.resourceId, accessRevision: state.accessRevision },
  });
  await tx.query(
    'INSERT INTO command_receipt(athlete_id,idempotency_key,request,result) VALUES($1,$2,$3::jsonb,$4::jsonb)',
    [
      tx.athleteId,
      key,
      JSON.stringify({ sha256: requestDigest }),
      JSON.stringify(
        accessReceiptSchema.parse({
          status: 'access',
          resourceId: state.resourceId,
          accessRevision: state.accessRevision,
        }),
      ),
    ],
  );
}

async function liveHead(tx: Transaction, resourceId: string) {
  const row = (
    await tx.query(
      `SELECT access_revision,current_version_id,reviewed_state,reviewed_at,include_for_coach,
        coach_use_enabled_at FROM resource
       WHERE athlete_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [tx.athleteId, resourceId],
    )
  ).rows[0];
  if (!row) throw new ResourceNotFoundError();
  return headRowSchema.parse(row);
}

async function aiConsentGranted(tx: Transaction) {
  const row = (
    await tx.query("SELECT granted FROM consent WHERE athlete_id=$1 AND kind='ai'", [tx.athleteId])
  ).rows[0];
  return row?.['granted'] === true;
}

export async function readResourceAccessState(
  tx: Transaction,
  resourceId: string,
): Promise<PrivateResourceAccessState> {
  const found = (
    await tx.query(
      `SELECT access_revision,current_version_id,reviewed_state,reviewed_at,include_for_coach,
        coach_use_enabled_at FROM resource
       WHERE athlete_id=$1 AND id=$2 AND deleted_at IS NULL`,
      [tx.athleteId, resourceId],
    )
  ).rows[0];
  if (!found) throw new ResourceNotFoundError();
  const head = headRowSchema.parse(found);
  // Every active grant is returned so none can become unrevocable; revoked
  // history is a separate bounded page.
  const shareColumns = `share_id,resource_id,grantee_kind,grantee_principal_id,state,
    granted_access_revision,revoked_access_revision,granted_at,revoked_at`;
  const shares = z.array(shareRowSchema).parse(
    (
      await tx.query(
        `SELECT ${shareColumns} FROM resource_share
         WHERE athlete_id=$1 AND resource_id=$2 AND state='active'
         ORDER BY granted_at DESC,share_id`,
        [tx.athleteId, resourceId],
      )
    ).rows,
  );
  // One row past the page decides truncation, so a history of exactly the page
  // size is not misreported as truncated.
  const revokedPage = z.array(shareRowSchema).parse(
    (
      await tx.query(
        `SELECT ${shareColumns} FROM resource_share
         WHERE athlete_id=$1 AND resource_id=$2 AND state='revoked'
         ORDER BY revoked_at DESC,share_id LIMIT ${MAX_REVOKED_SHARE_HISTORY + 1}`,
        [tx.athleteId, resourceId],
      )
    ).rows,
  );
  const revokedShares = revokedPage.slice(0, MAX_REVOKED_SHARE_HISTORY);
  const consent = await aiConsentGranted(tx);
  const authorized = (
    await tx.query('SELECT public.resource_coach_use_authorized($1) AS authorized', [resourceId])
  ).rows[0];
  const pending = (
    await tx.query('SELECT public.resource_derived_cleanup_pending($1) AS pending', [resourceId])
  ).rows[0];
  return privateResourceAccessStateSchema.parse({
    schemaVersion: 1,
    resourceId,
    accessRevision: head.access_revision,
    currentVersionId: head.current_version_id,
    reviewedState: head.reviewed_state,
    reviewedAt: head.reviewed_at === null ? null : iso(head.reviewed_at),
    includeForCoach: head.include_for_coach,
    coachUseEnabledAt: head.coach_use_enabled_at === null ? null : iso(head.coach_use_enabled_at),
    aiConsentGranted: consent,
    coachUseAuthorized: authorized?.['authorized'] === true,
    pendingCleanup: pending?.['pending'] === true,
    shares: shares.map(share),
    revokedShares: revokedShares.map(share),
    revokedShareHistoryTruncated: revokedPage.length > MAX_REVOKED_SHARE_HISTORY,
  });
}

async function auditAccess(
  tx: Transaction,
  resourceId: string,
  action: string,
  accessRevision: number,
  grantee: { shareId: string; granteeKind: 'coach'; granteePrincipalId: string } | null,
) {
  await tx.query(
    `INSERT INTO resource_access_audit
      (athlete_id,event_id,resource_id,action,access_revision,share_id,grantee_kind,
       grantee_principal_id,occurred_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,statement_timestamp())`,
    [
      tx.athleteId,
      randomUUID(),
      resourceId,
      action,
      accessRevision,
      grantee?.shareId ?? null,
      grantee?.granteeKind ?? null,
      grantee?.granteePrincipalId ?? null,
    ],
  );
}

async function bumpAccessRevision(
  tx: Transaction,
  resourceId: string,
  changes: {
    reviewedState?: 'unreviewed' | 'reviewed';
    includeForCoach?: boolean;
  },
) {
  const result = await tx.query(
    `UPDATE resource SET access_revision=access_revision+1,updated_at=statement_timestamp(),
       reviewed_state=coalesce($3::text,reviewed_state),
       reviewed_at=CASE WHEN $3::text IS NULL THEN reviewed_at
         WHEN $3::text='reviewed' THEN coalesce(reviewed_at,statement_timestamp()) ELSE NULL END,
       include_for_coach=coalesce($4::boolean,include_for_coach),
       coach_use_enabled_at=CASE WHEN $4::boolean IS NULL THEN coach_use_enabled_at
         WHEN $4::boolean THEN coalesce(coach_use_enabled_at,statement_timestamp())
         ELSE NULL END
     WHERE athlete_id=$1 AND id=$2 AND deleted_at IS NULL
     RETURNING access_revision`,
    [
      tx.athleteId,
      resourceId,
      changes.reviewedState ?? null,
      changes.includeForCoach === undefined ? null : changes.includeForCoach,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new ResourceNotFoundError();
  return z.number().int().positive().parse(row['access_revision']);
}

export interface SharedObjectResolution {
  ownerPrincipalId: string;
  resourceId: string;
  versionId: string;
  storageRef: string;
  file: {
    originalFileName: string;
    extension: 'pdf' | 'md' | 'markdown';
    mediaType: 'application/pdf' | 'text/markdown';
    byteSize: number;
    sha256: string;
  };
}

export interface ResourceAccessRepository {
  readAccess(athleteId: string, resourceId: string): Promise<PrivateResourceAccessState>;
  grantShare(
    athleteId: string,
    resourceId: string,
    input: unknown,
  ): Promise<PrivateResourceAccessState>;
  revokeShare(
    athleteId: string,
    resourceId: string,
    shareId: string,
    input: unknown,
  ): Promise<PrivateResourceAccessState>;
  setReviewed(
    athleteId: string,
    resourceId: string,
    input: unknown,
  ): Promise<PrivateResourceAccessState>;
  setCoachUse(
    athleteId: string,
    resourceId: string,
    input: unknown,
  ): Promise<PrivateResourceAccessState>;
  listSharedWithMe(
    granteePrincipalId: string,
    query?: Partial<PrivateSharedResourceListQuery>,
  ): Promise<PrivateSharedResourceList>;
  /**
   * Resolves the current file object of a shared resource. The active share,
   * the live resource and the pinned current version are re-validated in one
   * statement at request time, so revocation or deletion blocks every
   * subsequent read. Authorization is request-start only: a transfer that has
   * already begun is not aborted mid-stream. Shared files are bounded at
   * 10 MiB, so the window is one bounded response body.
   */
  resolveSharedObject(
    granteePrincipalId: string,
    ownerPrincipalId: string,
    resourceId: string,
  ): Promise<SharedObjectResolution | null>;
  readSharedWithMe(
    granteePrincipalId: string,
    ownerPrincipalId: string,
    resourceId: string,
  ): Promise<PrivateSharedResourceRead>;
  captureCoachUseManifest(athleteId: string): Promise<PrivateResourceCoachUseManifest>;
  revalidateCoachUseManifest(
    athleteId: string,
    manifest: unknown,
  ): Promise<PrivateResourceCoachUseRevalidation>;
}

/**
 * One snapshot of the resource access facts a coaching run depends on.
 *
 * Completeness rests on the single statement, not on a lock. Consent head,
 * authorized set and capture instant all come from one statement, so its MVCC
 * snapshot cannot mix two states even under READ COMMITTED. The tenant command
 * advisory lock is taken as well, which serializes this capture against the
 * application's own access and consent commands; it does NOT serialize against
 * the derived-cleanup lifecycle functions or against direct SQL updates, since
 * neither takes that lock. The authorized set uses exactly the use-time gate
 * predicate, and the digest pins the whole set — including its absence — rather
 * than only the listed entries, so an unserialized concurrent change surfaces
 * as a digest mismatch instead of a silently mixed snapshot.
 */
const coachUseSetSql = `SELECT
  to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at,
  coalesce((SELECT c.granted FROM consent c WHERE c.athlete_id=$1 AND c.kind='ai'),false) AS granted,
  coalesce((SELECT c.revision FROM consent c WHERE c.athlete_id=$1 AND c.kind='ai'),0) AS revision,
  coalesce((
    SELECT jsonb_agg(entry ORDER BY entry->>0) FROM (
      SELECT jsonb_build_array(r.id::text,r.access_revision,r.current_version_id::text) AS entry
      FROM resource r
      WHERE r.athlete_id=$1 AND r.deleted_at IS NULL AND r.include_for_coach
        AND r.reviewed_state='reviewed'
        AND EXISTS(SELECT 1 FROM consent c
          WHERE c.athlete_id=r.athlete_id AND c.kind='ai' AND c.granted)
        AND NOT public.resource_derived_cleanup_pending(r.id)
      ORDER BY r.id LIMIT ${MAX_COACH_USE_MANIFEST_ENTRIES + 1}
    ) authorized
  ),'[]'::jsonb) AS entries`;

const coachUseSetRowSchema = z.object({
  at: z.string(),
  granted: z.boolean(),
  revision: z.number().int().nonnegative(),
  entries: z.array(z.tuple([uuid, z.number().int().positive(), uuid])),
});

type CoachUseSet = {
  athleteId: string;
  capturedAt: string;
  aiConsentGranted: boolean;
  aiConsentRevision: number;
  entries: { resourceId: string; accessRevision: number; currentVersionId: string }[];
  digest: string;
};

async function readCoachUseSet(tx: Transaction): Promise<CoachUseSet> {
  await lock(tx);
  const row = coachUseSetRowSchema.parse((await tx.query(coachUseSetSql, [tx.athleteId])).rows[0]);
  if (row.entries.length > MAX_COACH_USE_MANIFEST_ENTRIES)
    throw new ResourceAccessError('COACH_USE_MANIFEST_TOO_LARGE');
  const entries = row.entries.map(([resourceId, accessRevision, currentVersionId]) => ({
    resourceId,
    accessRevision,
    currentVersionId,
  }));
  return {
    athleteId: tx.athleteId,
    capturedAt: row.at,
    aiConsentGranted: row.granted,
    aiConsentRevision: row.revision,
    entries,
    digest: coachUseSetDigest({
      athleteId: tx.athleteId,
      aiConsentGranted: row.granted,
      aiConsentRevision: row.revision,
      entries,
    }),
  };
}

/**
 * Deterministic over the tenant, the ordered set, its revisions and the consent
 * head. The tenant is part of the digest so one tenant's manifest — including
 * the identical empty set — cannot validate against another tenant.
 */
function coachUseSetDigest(input: {
  athleteId: string;
  aiConsentGranted: boolean;
  aiConsentRevision: number;
  entries: { resourceId: string; accessRevision: number; currentVersionId: string }[];
}) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        scope: 'resource-access-v1',
        athleteId: input.athleteId,
        aiConsentGranted: input.aiConsentGranted,
        aiConsentRevision: input.aiConsentRevision,
        entries: [...input.entries]
          .sort((left, right) => (left.resourceId < right.resourceId ? -1 : 1))
          .map((entry) => [entry.resourceId, entry.accessRevision, entry.currentVersionId]),
      }),
    )
    .digest('hex');
}

export async function captureResourceCoachUseManifest(
  tx: Transaction,
): Promise<PrivateResourceCoachUseManifest> {
  const captured = await readCoachUseSet(tx);
  return privateResourceCoachUseManifestSchema.parse({
    schemaVersion: 1,
    scope: 'resource-access-v1',
    athleteId: captured.athleteId,
    capturedAt: captured.capturedAt,
    aiConsentRevision: captured.aiConsentRevision,
    aiConsentGranted: captured.aiConsentGranted,
    complete: true,
    entriesDigest: captured.digest,
    entries: captured.entries,
  });
}

/**
 * Query-time gate. A pinned revision is never sufficient on its own, and the
 * whole authorized set is compared, so a resource that became coach-eligible
 * after capture is reported as `added` instead of silently missing.
 */
export async function revalidateResourceCoachUseManifest(
  tx: Transaction,
  input: unknown,
): Promise<PrivateResourceCoachUseRevalidation> {
  const manifest = privateResourceCoachUseManifestSchema.parse(input);
  // The manifest is a trusted server-side artifact, not an authenticated one.
  // Recomputing the unkeyed digest only proves self-consistency: it catches a
  // manifest edited after capture, a manifest belonging to another tenant, and
  // accidental corruption. It cannot prove origin, because anyone who can
  // recompute SHA-256 can forge a consistent manifest. No route accepts a
  // manifest from outside today; exposing one would require an HMAC or a
  // server-stored manifest identifier instead of this check.
  if (manifest.athleteId !== tx.athleteId)
    throw new ResourceAccessError('COACH_USE_MANIFEST_INVALID');
  const submittedDigest = coachUseSetDigest({
    athleteId: manifest.athleteId,
    aiConsentGranted: manifest.aiConsentGranted,
    aiConsentRevision: manifest.aiConsentRevision,
    entries: manifest.entries,
  });
  if (submittedDigest !== manifest.entriesDigest)
    throw new ResourceAccessError('COACH_USE_MANIFEST_INVALID');
  const current = await readCoachUseSet(tx);
  const currentById = new Map(current.entries.map((entry) => [entry.resourceId, entry]));
  const results: {
    resourceId: string;
    status: 'authorized' | 'revision_changed' | 'blocked' | 'added';
  }[] = [];
  const pinned = new Set<string>();
  for (const entry of manifest.entries) {
    pinned.add(entry.resourceId);
    const live = currentById.get(entry.resourceId);
    if (!live) results.push({ resourceId: entry.resourceId, status: 'blocked' });
    else if (
      live.accessRevision !== entry.accessRevision ||
      live.currentVersionId !== entry.currentVersionId
    )
      results.push({ resourceId: entry.resourceId, status: 'revision_changed' });
    else results.push({ resourceId: entry.resourceId, status: 'authorized' });
  }
  for (const entry of current.entries)
    if (!pinned.has(entry.resourceId))
      results.push({ resourceId: entry.resourceId, status: 'added' });
  return privateResourceCoachUseRevalidationSchema.parse({
    schemaVersion: 1,
    checkedAt: current.capturedAt,
    stale: current.digest !== manifest.entriesDigest,
    capturedEntriesDigest: manifest.entriesDigest,
    currentEntriesDigest: current.digest,
    results,
  });
}

export function createResourceAccessRepository(database: Database): ResourceAccessRepository {
  async function requireRevision(
    tx: Transaction,
    resourceId: string,
    expectedAccessRevision: number,
    expectedCurrentVersionId?: string,
  ) {
    const head = await liveHead(tx, resourceId);
    if (
      head.access_revision !== expectedAccessRevision ||
      (expectedCurrentVersionId !== undefined &&
        head.current_version_id !== expectedCurrentVersionId)
    )
      throw new PersistenceConflict('REVISION_CONFLICT');
    return head;
  }

  return {
    readAccess(athleteId, resourceId) {
      const id = uuid.parse(resourceId);
      return database.tenant(athleteId, (tx) => readResourceAccessState(tx, id));
    },

    grantShare(athleteId, resourceId, raw) {
      const id = uuid.parse(resourceId);
      const shareInput: ShareGrantInput = privateResourceShareGrantSchema.parse(raw);
      const key = `resource:share:${shareInput.idempotencyKey}`;
      const request = { kind: 'resource_share_grant', resourceId: id, ...shareInput };
      return database.tenant(athleteId, async (tx) => {
        await lock(tx);
        if (await replayAccess(tx, key, request)) return readResourceAccessState(tx, id);
        if (shareInput.granteePrincipalId === athleteId)
          throw new ResourceAccessError('SHARE_GRANTEE_INVALID');
        await requireRevision(tx, id, shareInput.expectedAccessRevision);
        const existing = (
          await tx.query(
            `SELECT share_id,state FROM resource_share
             WHERE athlete_id=$1 AND resource_id=$2 AND grantee_kind=$3 AND grantee_principal_id=$4
               AND state='active' FOR UPDATE`,
            [athleteId, id, shareInput.granteeKind, shareInput.granteePrincipalId],
          )
        ).rows[0];
        if (existing) {
          // A repeated grant to the same principal is a no-op, not a new
          // revision, so it must not publish a change event either.
          const state = await readResourceAccessState(tx, id);
          await finishAccessCommand(tx, key, request, state, 'resource.access_unchanged');
          return state;
        }
        const active = (
          await tx.query(
            `SELECT count(*)::integer AS active FROM resource_share
             WHERE athlete_id=$1 AND resource_id=$2 AND state='active'`,
            [athleteId, id],
          )
        ).rows[0];
        if (z.number().int().parse(active?.['active']) >= MAX_ACTIVE_SHARES_PER_RESOURCE)
          throw new ResourceAccessError('SHARE_LIMIT_EXCEEDED');
        const accessRevision = await bumpAccessRevision(tx, id, {});
        const shareId = randomUUID();
        await tx.query(
          `INSERT INTO resource_share
            (athlete_id,share_id,resource_id,grantee_kind,grantee_principal_id,state,
             granted_access_revision,granted_at,updated_at)
           VALUES($1,$2,$3,$4,$5,'active',$6,statement_timestamp(),statement_timestamp())`,
          [
            athleteId,
            shareId,
            id,
            shareInput.granteeKind,
            shareInput.granteePrincipalId,
            accessRevision,
          ],
        );
        await auditAccess(tx, id, 'share_granted', accessRevision, {
          shareId,
          granteeKind: shareInput.granteeKind,
          granteePrincipalId: shareInput.granteePrincipalId,
        });
        const state = await readResourceAccessState(tx, id);
        await finishAccessCommand(tx, key, request, state, 'resource.share_granted');
        return state;
      });
    },

    revokeShare(athleteId, resourceId, shareId, raw) {
      const id = uuid.parse(resourceId);
      const share = uuid.parse(shareId);
      const revokeInput: ShareRevokeInput = privateResourceShareRevokeSchema.parse(raw);
      const key = `resource:share-revoke:${revokeInput.idempotencyKey}`;
      const request = {
        kind: 'resource_share_revoke',
        resourceId: id,
        shareId: share,
        ...revokeInput,
      };
      return database.tenant(athleteId, async (tx) => {
        await lock(tx);
        if (await replayAccess(tx, key, request)) return readResourceAccessState(tx, id);
        const existing = (
          await tx.query(
            `SELECT state,grantee_kind,grantee_principal_id FROM resource_share
             WHERE athlete_id=$1 AND resource_id=$2 AND share_id=$3 FOR UPDATE`,
            [athleteId, id, share],
          )
        ).rows[0];
        if (!existing) throw new ResourceAccessError('SHARE_NOT_FOUND');
        if (existing['state'] === 'revoked') {
          const state = await readResourceAccessState(tx, id);
          await finishAccessCommand(tx, key, request, state, 'resource.access_unchanged');
          return state;
        }
        await requireRevision(tx, id, revokeInput.expectedAccessRevision);
        const accessRevision = await bumpAccessRevision(tx, id, {});
        await tx.query(
          `UPDATE resource_share SET state='revoked',revoked_at=statement_timestamp(),
             revoked_access_revision=$4,updated_at=statement_timestamp()
           WHERE athlete_id=$1 AND resource_id=$2 AND share_id=$3`,
          [athleteId, id, share, accessRevision],
        );
        await auditAccess(tx, id, 'share_revoked', accessRevision, {
          shareId: share,
          granteeKind: 'coach',
          granteePrincipalId: z.string().parse(existing['grantee_principal_id']),
        });
        await tx.query("SELECT public.enqueue_resource_derived_cleanup($1,'share_revoked')", [id]);
        const state = await readResourceAccessState(tx, id);
        await finishAccessCommand(tx, key, request, state, 'resource.share_revoked');
        return state;
      });
    },

    setReviewed(athleteId, resourceId, raw) {
      const id = uuid.parse(resourceId);
      const reviewedInput: ReviewedInput = privateResourceReviewedTransitionSchema.parse(raw);
      const key = `resource:reviewed:${reviewedInput.idempotencyKey}`;
      const request = { kind: 'resource_reviewed', resourceId: id, ...reviewedInput };
      return database.tenant(athleteId, async (tx) => {
        await lock(tx);
        if (await replayAccess(tx, key, request)) return readResourceAccessState(tx, id);
        const head = await requireRevision(
          tx,
          id,
          reviewedInput.expectedAccessRevision,
          reviewedInput.expectedCurrentVersionId,
        );
        const target = reviewedInput.reviewed ? 'reviewed' : 'unreviewed';
        if (head.reviewed_state === target) {
          const state = await readResourceAccessState(tx, id);
          await finishAccessCommand(tx, key, request, state, 'resource.access_unchanged');
          return state;
        }
        // Review withdrawal is not allowed to silently carry a coach-use
        // withdrawal; the owner must stop coach use as its own transition.
        if (head.include_for_coach) throw new ResourceAccessError('REVIEW_WITHDRAWAL_BLOCKED');
        const accessRevision = await bumpAccessRevision(tx, id, { reviewedState: target });
        await auditAccess(
          tx,
          id,
          reviewedInput.reviewed ? 'reviewed_marked' : 'reviewed_cleared',
          accessRevision,
          null,
        );
        if (!reviewedInput.reviewed)
          await tx.query("SELECT public.enqueue_resource_derived_cleanup($1,'review_withdrawn')", [
            id,
          ]);
        const state = await readResourceAccessState(tx, id);
        await finishAccessCommand(tx, key, request, state, 'resource.reviewed_changed');
        return state;
      });
    },

    setCoachUse(athleteId, resourceId, raw) {
      const id = uuid.parse(resourceId);
      const coachInput: CoachUseInput = privateResourceCoachUseTransitionSchema.parse(raw);
      const key = `resource:coach-use:${coachInput.idempotencyKey}`;
      const request = { kind: 'resource_coach_use', resourceId: id, ...coachInput };
      return database.tenant(athleteId, async (tx) => {
        await lock(tx);
        if (await replayAccess(tx, key, request)) return readResourceAccessState(tx, id);
        const head = await requireRevision(
          tx,
          id,
          coachInput.expectedAccessRevision,
          coachInput.expectedCurrentVersionId,
        );
        if (coachInput.includeForCoach) {
          if (head.reviewed_state !== 'reviewed')
            throw new ResourceAccessError('COACH_USE_REVIEW_REQUIRED');
          if (!(await aiConsentGranted(tx)))
            throw new ResourceAccessError('COACH_USE_CONSENT_REQUIRED');
        }
        if (head.include_for_coach === coachInput.includeForCoach) {
          const state = await readResourceAccessState(tx, id);
          await finishAccessCommand(tx, key, request, state, 'resource.access_unchanged');
          return state;
        }
        const accessRevision = await bumpAccessRevision(tx, id, {
          includeForCoach: coachInput.includeForCoach,
        });
        await auditAccess(
          tx,
          id,
          coachInput.includeForCoach ? 'coach_use_enabled' : 'coach_use_disabled',
          accessRevision,
          null,
        );
        if (!coachInput.includeForCoach)
          await tx.query(
            "SELECT public.enqueue_resource_derived_cleanup($1,'coach_use_withdrawn')",
            [id],
          );
        const state = await readResourceAccessState(tx, id);
        await finishAccessCommand(tx, key, request, state, 'resource.coach_use_changed');
        return state;
      });
    },

    listSharedWithMe(granteePrincipalId, rawQuery = {}) {
      const query = privateSharedResourceListQuerySchema.parse(rawQuery);
      return database.tenant(granteePrincipalId, async (tx) => {
        // Filtered set, page and count come from one statement. The grantee
        // tenant lock cannot serialize grants made by many different owners, so
        // a separate count would race a concurrent grant or revoke and report a
        // total smaller than the page it returned.
        // Only share keys and sort keys are buffered for the count scan; the
        // wide resource row is joined for the page alone, so a principal with
        // many grants does not spill the whole set into a temp file.
        const result = await tx.query(
          `WITH filtered AS MATERIALIZED (
             SELECT s.athlete_id,s.resource_id,s.share_id,s.granted_at
             FROM resource_share s JOIN resource r
               ON r.athlete_id=s.athlete_id AND r.id=s.resource_id
             WHERE s.grantee_principal_id=$1 AND s.state='active' AND r.deleted_at IS NULL
           ), page AS (
             SELECT f.*,row_number() OVER (ORDER BY f.granted_at DESC,f.share_id) AS ordinal
             FROM filtered f ORDER BY f.granted_at DESC,f.share_id LIMIT $2 OFFSET $3
           ), detailed AS (
             SELECT p.ordinal,jsonb_build_object(
               'athlete_id',p.athlete_id,'resource_id',p.resource_id,'share_id',p.share_id,
               'granted_at',p.granted_at,'source_kind',r.source_kind,'title',r.title,
               'category',r.category,'reviewed_state',r.reviewed_state,
               'current_version_id',r.current_version_id,'updated_at',r.updated_at) AS item
             FROM page p JOIN resource r
               ON r.athlete_id=p.athlete_id AND r.id=p.resource_id
           ) SELECT (SELECT count(*)::integer FROM filtered) AS total,
             coalesce((SELECT jsonb_agg(d.item ORDER BY d.ordinal) FROM detailed d),
               '[]'::jsonb) AS items`,
          [granteePrincipalId, query.limit, query.offset],
        );
        const total = z.number().int().nonnegative().parse(result.rows[0]?.['total']);
        const parsed = z
          .array(
            z.object({
              athlete_id: z.string().min(1).max(200),
              resource_id: uuid,
              share_id: uuid,
              granted_at: z.union([z.date(), z.string()]),
              source_kind: z.enum(['text', 'file', 'url']),
              title: z.string().min(1).max(200),
              category: z.string(),
              reviewed_state: z.enum(['unreviewed', 'reviewed']),
              current_version_id: uuid,
              updated_at: z.union([z.date(), z.string()]),
            }),
          )
          .parse(result.rows[0]?.['items']);
        return privateSharedResourceListSchema.parse({
          items: parsed.map((row) => ({
            schemaVersion: 1,
            ownerPrincipalId: row.athlete_id,
            resourceId: row.resource_id,
            shareId: row.share_id,
            sourceKind: row.source_kind,
            title: row.title,
            category: row.category,
            reviewedState: row.reviewed_state,
            currentVersionId: row.current_version_id,
            sharedAt: iso(row.granted_at),
            updatedAt: iso(row.updated_at),
          })),
          total,
          hasMore: query.offset + parsed.length < total,
        });
      });
    },

    readSharedWithMe(granteePrincipalId, ownerPrincipalId, resourceId) {
      const id = uuid.parse(resourceId);
      return database.tenant(granteePrincipalId, async (tx) => {
        // Tenant policy, not this query, decides whether the row is visible.
        const row = (
          await tx.query(
            `SELECT s.athlete_id,s.share_id,s.granted_at,r.source_kind,r.title,r.category,
               r.reviewed_state,r.current_version_id,r.updated_at,
               v.content,v.original_filename,v.media_type,v.size_bytes,v.content_hash
             FROM resource_share s JOIN resource r
               ON r.athlete_id=s.athlete_id AND r.id=s.resource_id
             JOIN resource_version v
               ON v.athlete_id=r.athlete_id AND v.version_id=r.current_version_id
             WHERE s.grantee_principal_id=$1 AND s.athlete_id=$2 AND s.resource_id=$3
               AND s.state='active' AND r.deleted_at IS NULL`,
            [granteePrincipalId, ownerPrincipalId, id],
          )
        ).rows[0];
        if (!row) return privateSharedResourceReadSchema.parse({ status: 'unavailable' });
        const parsed = z
          .object({
            athlete_id: z.string().min(1).max(200),
            share_id: uuid,
            granted_at: z.union([z.date(), z.string()]),
            source_kind: z.enum(['text', 'file', 'url']),
            title: z.string().min(1).max(200),
            category: z.string(),
            reviewed_state: z.enum(['unreviewed', 'reviewed']),
            current_version_id: uuid,
            updated_at: z.union([z.date(), z.string()]),
            content: z.string().nullable(),
            original_filename: z.string().nullable(),
            media_type: z.enum(['application/pdf', 'text/markdown']).nullable(),
            size_bytes: z.coerce.number().int().nullable(),
            content_hash: z.string(),
          })
          .parse(row);
        const summary = {
          schemaVersion: 1,
          ownerPrincipalId: parsed.athlete_id,
          resourceId: id,
          shareId: parsed.share_id,
          sourceKind: parsed.source_kind,
          title: parsed.title,
          category: parsed.category,
          reviewedState: parsed.reviewed_state,
          currentVersionId: parsed.current_version_id,
          sharedAt: iso(parsed.granted_at),
          updatedAt: iso(parsed.updated_at),
        };
        // Storage references and URLs with query strings never leave the server.
        const reader =
          parsed.source_kind === 'text'
            ? { sourceKind: 'text' as const, originalText: z.string().parse(parsed.content) }
            : parsed.source_kind === 'file'
              ? {
                  sourceKind: 'file' as const,
                  file: {
                    originalFileName: z.string().parse(parsed.original_filename),
                    extension:
                      parsed.media_type === 'application/pdf'
                        ? ('pdf' as const)
                        : parsed.original_filename?.toLocaleLowerCase('en-US').endsWith('.markdown')
                          ? ('markdown' as const)
                          : ('md' as const),
                    mediaType: parsed.media_type,
                    byteSize: parsed.size_bytes,
                    sha256: parsed.content_hash,
                  },
                }
              : {
                  sourceKind: 'url' as const,
                  displayUrl: z.string().parse(
                    (
                      await tx.query(
                        `SELECT display_url FROM resource_url_provenance
                         WHERE athlete_id=$1 AND resource_id=$2 AND version_id=$3`,
                        [parsed.athlete_id, id, parsed.current_version_id],
                      )
                    ).rows[0]?.['display_url'],
                  ),
                  parsedText: parsed.content,
                };
        return privateSharedResourceReadSchema.parse({ status: 'available', summary, reader });
      });
    },

    resolveSharedObject(granteePrincipalId, ownerPrincipalId, resourceId) {
      const id = uuid.parse(resourceId);
      return database.tenant(granteePrincipalId, async (tx) => {
        // Tenant policy decides visibility; the owner identity is only a filter.
        const row = (
          await tx.query(
            `SELECT r.athlete_id,v.version_id,v.storage_ref,v.original_filename,v.media_type,
               v.size_bytes,v.content_hash
             FROM resource_share s JOIN resource r
               ON r.athlete_id=s.athlete_id AND r.id=s.resource_id
             JOIN resource_version v
               ON v.athlete_id=r.athlete_id AND v.version_id=r.current_version_id
             WHERE s.grantee_principal_id=$1 AND s.athlete_id=$2 AND s.resource_id=$3
               AND s.state='active' AND r.deleted_at IS NULL AND r.source_kind='file'
               AND v.storage_ref IS NOT NULL`,
            [granteePrincipalId, ownerPrincipalId, id],
          )
        ).rows[0];
        if (!row) return null;
        const parsed = z
          .object({
            athlete_id: z.string().min(1).max(200),
            version_id: uuid,
            storage_ref: z.string().min(1).max(512),
            original_filename: z.string().min(1),
            media_type: z.enum(['application/pdf', 'text/markdown']),
            size_bytes: z.coerce.number().int().positive(),
            content_hash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .parse(row);
        return {
          ownerPrincipalId: parsed.athlete_id,
          resourceId: id,
          versionId: parsed.version_id,
          storageRef: parsed.storage_ref,
          file: {
            originalFileName: parsed.original_filename,
            extension:
              parsed.media_type === 'application/pdf'
                ? ('pdf' as const)
                : parsed.original_filename.toLocaleLowerCase('en-US').endsWith('.markdown')
                  ? ('markdown' as const)
                  : ('md' as const),
            mediaType: parsed.media_type,
            byteSize: parsed.size_bytes,
            sha256: parsed.content_hash,
          },
        };
      });
    },

    captureCoachUseManifest(athleteId) {
      return database.tenant(athleteId, captureResourceCoachUseManifest);
    },

    revalidateCoachUseManifest(athleteId, manifest) {
      return database.tenant(athleteId, (tx) => revalidateResourceCoachUseManifest(tx, manifest));
    },
  };
}
