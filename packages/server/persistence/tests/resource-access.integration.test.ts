import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { PrivateTextResourceCreate } from '@workout/contracts/resources';
import { createDatabase, type Database } from '../src/database.js';
import {
  grantOperations,
  grantResourceObjectCleanupWorker,
  grantResources,
  migrate,
} from '../src/migrate.js';
import { createOperationsRepository } from '../src/operations.js';
import { createPrivateTextResourceRepository } from '../src/resources.js';
import { createResourceAccessRepository, ResourceAccessError } from '../src/resource-access.js';
import {
  createResourceDerivedCleanupRepository,
  processOneResourceDerivedCleanup,
} from '../src/resource-derived-cleanup.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
let resources: ReturnType<typeof createPrivateTextResourceRepository>;
let access: ReturnType<typeof createResourceAccessRepository>;

beforeAll(async () => {
  await migrate(adminUrl);
  await admin.query('GRANT USAGE ON SCHEMA public TO workout_runtime');
  await grantOperations(adminUrl, 'workout_runtime');
  await grantResources(adminUrl, 'workout_runtime');
  await admin.query('GRANT SELECT,INSERT,UPDATE ON consent TO workout_runtime');
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
  resources = createPrivateTextResourceRepository(database);
  access = createResourceAccessRepository(database);
});

afterAll(async () => {
  await database?.close();
  await admin.end();
});

const command = (): PrivateTextResourceCreate => ({
  sourceKind: 'text',
  title: 'Marathon pacing guide',
  category: 'guide',
  metadata: {},
  tags: [],
  favorite: false,
  text: '첫 문단입니다.\n\nSecond paragraph.',
  idempotencyKey: randomUUID(),
});

async function grantAiConsent(athleteId: string) {
  await database.tenant(athleteId, async (tx) => {
    await tx.query(
      `INSERT INTO consent VALUES($1,'ai',true,1)
       ON CONFLICT (athlete_id,kind) DO UPDATE SET granted=true,revision=consent.revision+1`,
      [athleteId],
    );
  });
}

async function withdrawAiConsent(athleteId: string) {
  await database.tenant(athleteId, async (tx) => {
    await tx.query(
      "UPDATE consent SET granted=false,revision=revision+1 WHERE athlete_id=$1 AND kind='ai'",
      [athleteId],
    );
  });
}

async function createResource(athleteId: string) {
  const created = await resources.create(athleteId, command());
  if (created.status !== 'available') throw new Error('Expected an available resource');
  return created;
}

async function createFileResource(athleteId: string) {
  const resourceId = randomUUID();
  const versionId = randomUUID();
  const uploadId = randomUUID();
  const sha256 = 'e'.repeat(64);
  const storageRef =
    `private/v1/tenants/${athleteId}/resources/${resourceId}/objects/uploads/${uploadId}/` +
    `sha256/${sha256}.pdf`;
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    await client.query(
      `INSERT INTO resource_object(athlete_id,storage_ref,content_hash,size_bytes,media_type,created_at)
       VALUES($1,$2,$3,64,'application/pdf',now())`,
      [athleteId, storageRef, sha256],
    );
    await client.query(
      `INSERT INTO resource
        (athlete_id,id,source_kind,title,category,metadata,tags,favorite,include_for_coach,
         reviewed_state,access_revision,current_version,current_version_id,created_at,updated_at)
       VALUES($1,$2,'file','훈련 계획 PDF','guide','{}'::jsonb,'[]'::jsonb,false,false,
         'unreviewed',1,1,$3,now(),now())`,
      [athleteId, resourceId, versionId],
    );
    await client.query(
      `INSERT INTO resource_version
        (athlete_id,resource_id,version_id,version,previous_version,previous_version_id,
         content,content_hash,paragraphs,content_status,index_status,storage_ref,
         original_filename,media_type,size_bytes,created_at)
       VALUES($1,$2,$3,1,NULL,NULL,NULL,$4,'[]'::jsonb,'raw_stored','not_indexed',$5,
         '훈련-계획.pdf','application/pdf',64,now())`,
      [athleteId, resourceId, versionId, sha256, storageRef],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return { resourceId, versionId, storageRef, sha256 };
}

async function drainDerivedCleanup() {
  const repository = createResourceDerivedCleanupRepository({
    connectionString: adminUrl as string,
    max: 1,
  });
  try {
    for (let index = 0; index < 20; index += 1) {
      const now = new Date();
      const manifest = await repository.lease(now, new Date(now.getTime() + 60_000));
      if (!manifest) return index;
      await repository.finish(manifest, { ok: true });
    }
    return 20;
  } finally {
    await repository.close();
  }
}

describe('M2-04d resource access, sharing and coach-use boundary', () => {
  it('keeps reviewed and coach use separate and bumps a revision for every access change', async () => {
    const athlete = randomUUID();
    await grantAiConsent(athlete);
    const created = await createResource(athlete);
    const resourceId = created.resource.id;
    const versionId = created.version.id;

    const initial = await access.readAccess(athlete, resourceId);
    expect(initial.reviewedState).toBe('unreviewed');
    expect(initial.includeForCoach).toBe(false);
    expect(initial.coachUseAuthorized).toBe(false);

    // Coach use is refused while the resource is unreviewed.
    await expect(
      access.setCoachUse(athlete, resourceId, {
        includeForCoach: true,
        expectedAccessRevision: initial.accessRevision,
        expectedCurrentVersionId: versionId,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ResourceAccessError);

    const reviewed = await access.setReviewed(athlete, resourceId, {
      reviewed: true,
      expectedAccessRevision: initial.accessRevision,
      expectedCurrentVersionId: versionId,
      idempotencyKey: randomUUID(),
    });
    expect(reviewed.reviewedState).toBe('reviewed');
    expect(reviewed.includeForCoach).toBe(false);
    expect(reviewed.accessRevision).toBe(initial.accessRevision + 1);

    const coachUse = await access.setCoachUse(athlete, resourceId, {
      includeForCoach: true,
      expectedAccessRevision: reviewed.accessRevision,
      expectedCurrentVersionId: versionId,
      idempotencyKey: randomUUID(),
    });
    expect(coachUse.includeForCoach).toBe(true);
    expect(coachUse.coachUseAuthorized).toBe(true);
    expect(coachUse.accessRevision).toBe(reviewed.accessRevision + 1);

    // Appending a version never re-promotes either flag, but still advances the revision.
    const appended = await resources.appendVersion(athlete, resourceId, {
      expectedCurrentVersionId: versionId,
      text: 'Revised guidance.',
      idempotencyKey: randomUUID(),
    });
    if (appended.status !== 'available') throw new Error('Expected an available resource');
    const afterAppend = await access.readAccess(athlete, resourceId);
    expect(afterAppend.accessRevision).toBe(coachUse.accessRevision + 1);
    expect(afterAppend.reviewedState).toBe('reviewed');
    expect(afterAppend.includeForCoach).toBe(true);

    const audit = await admin.query(
      'SELECT action FROM resource_access_audit WHERE athlete_id=$1 ORDER BY occurred_at,event_id',
      [athlete],
    );
    expect(audit.rows.map((row) => row['action'])).toEqual([
      'reviewed_marked',
      'coach_use_enabled',
    ]);
  });

  it('shares explicitly, is idempotent, and blocks the grantee read immediately on revocation', async () => {
    const owner = randomUUID();
    const coach = randomUUID();
    const stranger = randomUUID();
    const created = await createResource(owner);
    const resourceId = created.resource.id;

    const before = await access.readAccess(owner, resourceId);
    const shared = await access.grantShare(owner, resourceId, {
      granteeKind: 'coach',
      granteePrincipalId: coach,
      expectedAccessRevision: before.accessRevision,
      idempotencyKey: randomUUID(),
    });
    expect(shared.accessRevision).toBe(before.accessRevision + 1);
    expect(shared.shares).toHaveLength(1);
    // Sharing never reviews the resource or turns on coach use.
    expect(shared.reviewedState).toBe('unreviewed');
    expect(shared.includeForCoach).toBe(false);

    const repeated = await access.grantShare(owner, resourceId, {
      granteeKind: 'coach',
      granteePrincipalId: coach,
      expectedAccessRevision: shared.accessRevision,
      idempotencyKey: randomUUID(),
    });
    expect(repeated.accessRevision).toBe(shared.accessRevision);
    expect(repeated.shares.filter((item) => item.state === 'active')).toHaveLength(1);

    const list = await access.listSharedWithMe(coach);
    expect(list.items.map((item) => item.resourceId)).toEqual([resourceId]);
    const read = await access.readSharedWithMe(coach, owner, resourceId);
    expect(read.status).toBe('available');

    // Another principal with no grant sees nothing, even naming the owner.
    expect((await access.listSharedWithMe(stranger)).items).toEqual([]);
    expect(await access.listSharedWithMe(stranger)).toMatchObject({ total: 0, hasMore: false });
    expect(await access.readSharedWithMe(stranger, owner, resourceId)).toEqual({
      status: 'unavailable',
    });

    const shareId = shared.shares[0]?.shareId as string;
    const revoked = await access.revokeShare(owner, resourceId, shareId, {
      expectedAccessRevision: repeated.accessRevision,
      idempotencyKey: randomUUID(),
    });
    expect(revoked.accessRevision).toBe(repeated.accessRevision + 1);
    expect((await access.listSharedWithMe(coach)).items).toEqual([]);
    expect(await access.readSharedWithMe(coach, owner, resourceId)).toEqual({
      status: 'unavailable',
    });

    const manifests = await admin.query(
      'SELECT reason,targets FROM resource_derived_cleanup WHERE athlete_id=$1',
      [owner],
    );
    expect(manifests.rows).toEqual([
      {
        reason: 'share_revoked',
        targets: { derivedData: true, searchIndex: true, cache: true, citations: true },
      },
    ]);
  });

  it('withdraws AI consent as a policy change that disables coach use everywhere', async () => {
    const athlete = randomUUID();
    await grantAiConsent(athlete);
    const created = await createResource(athlete);
    const resourceId = created.resource.id;
    const versionId = created.version.id;
    const reviewed = await access.setReviewed(athlete, resourceId, {
      reviewed: true,
      expectedAccessRevision: created.resource.accessRevision,
      expectedCurrentVersionId: versionId,
      idempotencyKey: randomUUID(),
    });
    const enabled = await access.setCoachUse(athlete, resourceId, {
      includeForCoach: true,
      expectedAccessRevision: reviewed.accessRevision,
      expectedCurrentVersionId: versionId,
      idempotencyKey: randomUUID(),
    });
    const manifest = await access.captureCoachUseManifest(athlete);
    expect(manifest.entries).toEqual([
      {
        resourceId,
        accessRevision: enabled.accessRevision,
        currentVersionId: versionId,
      },
    ]);
    expect(manifest.complete).toBe(true);
    expect(manifest.entriesDigest).toMatch(/^[a-f0-9]{64}$/);
    expect((await access.revalidateCoachUseManifest(athlete, manifest)).stale).toBe(false);

    await withdrawAiConsent(athlete);

    const afterWithdrawal = await access.readAccess(athlete, resourceId);
    expect(afterWithdrawal.includeForCoach).toBe(false);
    expect(afterWithdrawal.aiConsentGranted).toBe(false);
    expect(afterWithdrawal.coachUseAuthorized).toBe(false);
    expect(afterWithdrawal.accessRevision).toBe(enabled.accessRevision + 1);

    // A pinned manifest is never sufficient on its own.
    const revalidated = await access.revalidateCoachUseManifest(athlete, manifest);
    expect(revalidated.stale).toBe(true);
    expect(revalidated.results).toEqual([{ resourceId, status: 'blocked' }]);
    expect(revalidated.currentEntriesDigest).not.toBe(revalidated.capturedEntriesDigest);

    const reasons = await admin.query(
      'SELECT reason FROM resource_derived_cleanup WHERE athlete_id=$1',
      [athlete],
    );
    expect(reasons.rows.map((row) => row['reason'])).toEqual(['consent_withdrawn']);

    // Coach use cannot be re-enabled without consent even at the current revision.
    await expect(
      access.setCoachUse(athlete, resourceId, {
        includeForCoach: true,
        expectedAccessRevision: afterWithdrawal.accessRevision,
        expectedCurrentVersionId: versionId,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'COACH_USE_CONSENT_REQUIRED' });
  });

  it('withdrawing review withdraws coach use and fences retrieval until cleanup completes', async () => {
    const athlete = randomUUID();
    await grantAiConsent(athlete);
    const created = await createResource(athlete);
    const resourceId = created.resource.id;
    const versionId = created.version.id;
    const reviewed = await access.setReviewed(athlete, resourceId, {
      reviewed: true,
      expectedAccessRevision: created.resource.accessRevision,
      expectedCurrentVersionId: versionId,
      idempotencyKey: randomUUID(),
    });
    const enabled = await access.setCoachUse(athlete, resourceId, {
      includeForCoach: true,
      expectedAccessRevision: reviewed.accessRevision,
      expectedCurrentVersionId: versionId,
      idempotencyKey: randomUUID(),
    });

    // Review withdrawal may not silently carry a coach-use withdrawal.
    await expect(
      access.setReviewed(athlete, resourceId, {
        reviewed: false,
        expectedAccessRevision: enabled.accessRevision,
        expectedCurrentVersionId: versionId,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'REVIEW_WITHDRAWAL_BLOCKED' });
    const unchanged = await access.readAccess(athlete, resourceId);
    expect(unchanged.accessRevision).toBe(enabled.accessRevision);
    expect(unchanged.reviewedState).toBe('reviewed');
    expect(unchanged.includeForCoach).toBe(true);

    // The database refuses the same combination even without the service check.
    await expect(
      database.tenant(athlete, (tx) =>
        tx.query(
          `UPDATE resource SET reviewed_state='unreviewed',reviewed_at=NULL,
             access_revision=access_revision+1,updated_at=statement_timestamp()
           WHERE athlete_id=$1 AND id=$2`,
          [athlete, resourceId],
        ),
      ),
    ).rejects.toThrow(/REVIEW_WITHDRAWAL_BLOCKED/);

    const stopped = await access.setCoachUse(athlete, resourceId, {
      includeForCoach: false,
      expectedAccessRevision: enabled.accessRevision,
      expectedCurrentVersionId: versionId,
      idempotencyKey: randomUUID(),
    });
    expect(stopped.includeForCoach).toBe(false);
    expect(stopped.reviewedState).toBe('reviewed');
    expect(stopped.pendingCleanup).toBe(true);
    expect(stopped.coachUseAuthorized).toBe(false);

    const cleared = await access.setReviewed(athlete, resourceId, {
      reviewed: false,
      expectedAccessRevision: stopped.accessRevision,
      expectedCurrentVersionId: versionId,
      idempotencyKey: randomUUID(),
    });
    expect(cleared.reviewedState).toBe('unreviewed');
    expect(cleared.includeForCoach).toBe(false);

    expect(await drainDerivedCleanup()).toBeGreaterThan(0);
    expect((await access.readAccess(athlete, resourceId)).pendingCleanup).toBe(false);
  });

  it('keeps every active grant revocable behind a bounded revoked history', async () => {
    const owner = randomUUID();
    const created = await createResource(owner);
    const resourceId = created.resource.id;
    let revision = created.resource.accessRevision;
    const firstCoach = randomUUID();
    const first = await access.grantShare(owner, resourceId, {
      granteeKind: 'coach',
      granteePrincipalId: firstCoach,
      expectedAccessRevision: revision,
      idempotencyKey: randomUUID(),
    });
    revision = first.accessRevision;

    // Churn enough grant/revoke pairs to push the oldest active grant well past
    // any fixed history page.
    for (let index = 0; index < 55; index += 1) {
      const churned = randomUUID();
      const granted = await access.grantShare(owner, resourceId, {
        granteeKind: 'coach',
        granteePrincipalId: churned,
        expectedAccessRevision: revision,
        idempotencyKey: randomUUID(),
      });
      const shareId = granted.shares.find((item) => item.granteePrincipalId === churned)?.shareId;
      if (!shareId) throw new Error('Expected the new grant to be active');
      const revoked = await access.revokeShare(owner, resourceId, shareId, {
        expectedAccessRevision: granted.accessRevision,
        idempotencyKey: randomUUID(),
      });
      revision = revoked.accessRevision;
    }

    const state = await access.readAccess(owner, resourceId);
    expect(state.shares.map((item) => item.granteePrincipalId)).toEqual([firstCoach]);
    expect(state.shares.every((item) => item.state === 'active')).toBe(true);
    expect(state.revokedShares).toHaveLength(50);
    expect(state.revokedShareHistoryTruncated).toBe(true);
    expect(state.revokedShares.every((item) => item.state === 'revoked')).toBe(true);

    const firstShareId = state.shares[0]?.shareId as string;
    const revokedFirst = await access.revokeShare(owner, resourceId, firstShareId, {
      expectedAccessRevision: state.accessRevision,
      idempotencyKey: randomUUID(),
    });
    expect(revokedFirst.shares).toEqual([]);
  });

  it('fails explicitly instead of pinning a truncated coach-use manifest', async () => {
    const athlete = randomUUID();
    await grantAiConsent(athlete);
    // The tenant quota caps active resources, so the overflow guard is exercised
    // by seeding one row past the contract bound directly.
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      for (let index = 0; index <= 100; index += 1) {
        const id = randomUUID();
        const versionId = randomUUID();
        await client.query(
          `INSERT INTO resource
            (athlete_id,id,source_kind,title,category,metadata,tags,favorite,include_for_coach,
             reviewed_state,reviewed_at,coach_use_enabled_at,access_revision,current_version,
             current_version_id,created_at,updated_at)
           VALUES($1,$2,'text',$3,'note','{}'::jsonb,'[]'::jsonb,false,true,'reviewed',
             now(),now(),1,1,$4,now(),now())`,
          [athlete, id, `자료 ${index}`, versionId],
        );
        await client.query(
          `INSERT INTO resource_version
            (athlete_id,resource_id,version_id,version,previous_version,previous_version_id,
             content,content_hash,paragraphs,content_status,index_status,created_at)
           VALUES($1,$2,$3,1,NULL,NULL,'본문',$4,$5::jsonb,'parsed','not_indexed',now())`,
          [
            athlete,
            id,
            versionId,
            'd'.repeat(64),
            JSON.stringify([
              {
                locator: {
                  kind: 'paragraph',
                  resourceVersionId: versionId,
                  index: 0,
                  startOffset: 0,
                  endOffset: 2,
                  offsetUnit: 'utf16_code_unit',
                },
                text: '본문',
              },
            ]),
          ],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    await expect(access.captureCoachUseManifest(athlete)).rejects.toMatchObject({
      code: 'COACH_USE_MANIFEST_TOO_LARGE',
    });

    // Exactly at the bound the manifest is captured and marked complete.
    await admin.query(
      `UPDATE resource SET include_for_coach=false,coach_use_enabled_at=NULL,
         access_revision=access_revision+1,updated_at=statement_timestamp()
       WHERE athlete_id=$1 AND id=(SELECT id FROM resource WHERE athlete_id=$1 ORDER BY id LIMIT 1)`,
      [athlete],
    );
    const manifest = await access.captureCoachUseManifest(athlete);
    expect(manifest.complete).toBe(true);
    expect(manifest.entries).toHaveLength(100);
  });

  it('streams shared file bytes only while the grant is active', async () => {
    const owner = randomUUID();
    const coach = randomUUID();
    const stranger = randomUUID();
    const file = await createFileResource(owner);

    expect(await access.resolveSharedObject(coach, owner, file.resourceId)).toBeNull();

    const before = await access.readAccess(owner, file.resourceId);
    const shared = await access.grantShare(owner, file.resourceId, {
      granteeKind: 'coach',
      granteePrincipalId: coach,
      expectedAccessRevision: before.accessRevision,
      idempotencyKey: randomUUID(),
    });
    const resolved = await access.resolveSharedObject(coach, owner, file.resourceId);
    expect(resolved).toMatchObject({
      ownerPrincipalId: owner,
      resourceId: file.resourceId,
      versionId: file.versionId,
      storageRef: file.storageRef,
      file: {
        originalFileName: '훈련-계획.pdf',
        extension: 'pdf',
        mediaType: 'application/pdf',
        byteSize: 64,
        sha256: file.sha256,
      },
    });
    // A principal without a grant cannot resolve it even by naming the owner.
    expect(await access.resolveSharedObject(stranger, owner, file.resourceId)).toBeNull();
    // The grantee also cannot reach the shared object through its own tenancy.
    expect(await access.resolveSharedObject(coach, coach, file.resourceId)).toBeNull();

    const shareId = shared.shares[0]?.shareId as string;
    await access.revokeShare(owner, file.resourceId, shareId, {
      expectedAccessRevision: shared.accessRevision,
      idempotencyKey: randomUUID(),
    });
    expect(await access.resolveSharedObject(coach, owner, file.resourceId)).toBeNull();
  });

  it('stops a shared file read as soon as the owner deletes the resource', async () => {
    const owner = randomUUID();
    const coach = randomUUID();
    const file = await createFileResource(owner);
    const before = await access.readAccess(owner, file.resourceId);
    const shared = await access.grantShare(owner, file.resourceId, {
      granteeKind: 'coach',
      granteePrincipalId: coach,
      expectedAccessRevision: before.accessRevision,
      idempotencyKey: randomUUID(),
    });
    expect(await access.resolveSharedObject(coach, owner, file.resourceId)).not.toBeNull();

    await resources.softDelete(owner, file.resourceId, {
      expectedAccessRevision: shared.accessRevision,
      expectedCurrentVersionId: file.versionId,
      idempotencyKey: randomUUID(),
    });
    expect(await access.resolveSharedObject(coach, owner, file.resourceId)).toBeNull();
  });

  it('soft deletion revokes shares, enqueues the derived manifest and blocks the grantee', async () => {
    const owner = randomUUID();
    const coach = randomUUID();
    const created = await createResource(owner);
    const resourceId = created.resource.id;
    const shared = await access.grantShare(owner, resourceId, {
      granteeKind: 'coach',
      granteePrincipalId: coach,
      expectedAccessRevision: created.resource.accessRevision,
      idempotencyKey: randomUUID(),
    });

    await resources.softDelete(owner, resourceId, {
      expectedAccessRevision: shared.accessRevision,
      expectedCurrentVersionId: created.version.id,
      idempotencyKey: randomUUID(),
    });

    expect((await access.listSharedWithMe(coach)).items).toEqual([]);
    expect(await access.readSharedWithMe(coach, owner, resourceId)).toEqual({
      status: 'unavailable',
    });
    const states = await admin.query(
      'SELECT state FROM resource_share WHERE athlete_id=$1 AND resource_id=$2',
      [owner, resourceId],
    );
    expect(states.rows.map((row) => row['state'])).toEqual(['revoked']);
    const manifests = await admin.query(
      'SELECT reason FROM resource_derived_cleanup WHERE athlete_id=$1 AND resource_id=$2',
      [owner, resourceId],
    );
    expect(manifests.rows.map((row) => row['reason'])).toEqual(['resource_deleted']);
  });

  it('keeps the derived manifest after account erasure and exports access facts', async () => {
    const owner = randomUUID();
    const coach = randomUUID();
    await grantAiConsent(owner);
    const created = await createResource(owner);
    const resourceId = created.resource.id;
    const shared = await access.grantShare(owner, resourceId, {
      granteeKind: 'coach',
      granteePrincipalId: coach,
      expectedAccessRevision: created.resource.accessRevision,
      idempotencyKey: randomUUID(),
    });
    await access.setReviewed(owner, resourceId, {
      reviewed: true,
      expectedAccessRevision: shared.accessRevision,
      expectedCurrentVersionId: created.version.id,
      idempotencyKey: randomUUID(),
    });

    const operations = createOperationsRepository(database);
    const exported = await operations.exportAccount(owner);
    if (!('resourceShares' in exported.data) || !('resourceAccessAudit' in exported.data))
      throw new Error('Expected an export version that carries resource access facts');
    const shares = exported.data.resourceShares;
    const auditFacts = exported.data.resourceAccessAudit;
    expect(shares).toHaveLength(1);
    expect(shares[0]).toMatchObject({ grantee_principal_id: coach, state: 'active' });
    expect(auditFacts.map((fact: Record<string, unknown>) => fact['action'])).toEqual([
      'share_granted',
      'reviewed_marked',
    ]);
    expect(JSON.stringify(exported)).not.toContain('storage_ref');

    await operations.eraseAccount(owner);
    expect(
      (await admin.query('SELECT 1 FROM resource_share WHERE athlete_id=$1', [owner])).rowCount,
    ).toBe(0);
    expect(
      (await admin.query('SELECT 1 FROM resource_access_audit WHERE athlete_id=$1', [owner]))
        .rowCount,
    ).toBe(0);
    const remaining = await admin.query(
      'SELECT reason FROM resource_derived_cleanup WHERE athlete_id=$1 AND resource_id=$2',
      [owner, resourceId],
    );
    expect(remaining.rows.map((row) => row['reason'])).toContain('account_erased');
    expect((await access.listSharedWithMe(coach)).items).toEqual([]);
  });

  it('reports a resource authorized after capture instead of silently omitting it', async () => {
    const athlete = randomUUID();
    await grantAiConsent(athlete);
    const first = await createResource(athlete);
    const firstReviewed = await access.setReviewed(athlete, first.resource.id, {
      reviewed: true,
      expectedAccessRevision: first.resource.accessRevision,
      expectedCurrentVersionId: first.version.id,
      idempotencyKey: randomUUID(),
    });
    await access.setCoachUse(athlete, first.resource.id, {
      includeForCoach: true,
      expectedAccessRevision: firstReviewed.accessRevision,
      expectedCurrentVersionId: first.version.id,
      idempotencyKey: randomUUID(),
    });
    const manifest = await access.captureCoachUseManifest(athlete);
    expect(await access.revalidateCoachUseManifest(athlete, manifest)).toMatchObject({
      stale: false,
      results: [{ resourceId: first.resource.id, status: 'authorized' }],
    });

    const second = await createResource(athlete);
    const secondReviewed = await access.setReviewed(athlete, second.resource.id, {
      reviewed: true,
      expectedAccessRevision: second.resource.accessRevision,
      expectedCurrentVersionId: second.version.id,
      idempotencyKey: randomUUID(),
    });
    await access.setCoachUse(athlete, second.resource.id, {
      includeForCoach: true,
      expectedAccessRevision: secondReviewed.accessRevision,
      expectedCurrentVersionId: second.version.id,
      idempotencyKey: randomUUID(),
    });

    // The pinned entries are all still valid, but the set changed.
    const revalidated = await access.revalidateCoachUseManifest(athlete, manifest);
    expect(revalidated.stale).toBe(true);
    expect(revalidated.results).toEqual(
      expect.arrayContaining([
        { resourceId: first.resource.id, status: 'authorized' },
        { resourceId: second.resource.id, status: 'added' },
      ]),
    );
    expect(revalidated.capturedEntriesDigest).toBe(manifest.entriesDigest);
    expect(revalidated.currentEntriesDigest).not.toBe(manifest.entriesDigest);
  });

  it('captures the consent head and the authorized set from one snapshot', async () => {
    const athlete = randomUUID();
    await grantAiConsent(athlete);
    const created = await createResource(athlete);
    const reviewed = await access.setReviewed(athlete, created.resource.id, {
      reviewed: true,
      expectedAccessRevision: created.resource.accessRevision,
      expectedCurrentVersionId: created.version.id,
      idempotencyKey: randomUUID(),
    });
    await access.setCoachUse(athlete, created.resource.id, {
      includeForCoach: true,
      expectedAccessRevision: reviewed.accessRevision,
      expectedCurrentVersionId: created.version.id,
      idempotencyKey: randomUUID(),
    });

    // Repeated captures of an unchanged tenant are byte-identical apart from the
    // capture instant, so the digest is a usable dependency identity.
    const one = await access.captureCoachUseManifest(athlete);
    const two = await access.captureCoachUseManifest(athlete);
    expect(two.entriesDigest).toBe(one.entriesDigest);
    expect(two.aiConsentRevision).toBe(one.aiConsentRevision);

    // Withdrawing consent moves both the consent head and the set at once.
    await withdrawAiConsent(athlete);
    const after = await access.captureCoachUseManifest(athlete);
    expect(after.aiConsentGranted).toBe(false);
    expect(after.entries).toEqual([]);
    expect(after.entriesDigest).not.toBe(one.entriesDigest);
    expect(await access.revalidateCoachUseManifest(athlete, one)).toMatchObject({ stale: true });
  });

  it('never spends the derived cleanup budget while no store executor exists', async () => {
    const athlete = randomUUID();
    const created = await createResource(athlete);
    await resources.softDelete(athlete, created.resource.id, {
      expectedAccessRevision: created.resource.accessRevision,
      expectedCurrentVersionId: created.version.id,
      idempotencyKey: randomUUID(),
    });
    const manifestId = z.string().parse(
      (
        await admin.query(
          `SELECT id FROM resource_derived_cleanup
             WHERE athlete_id=$1 AND resource_id=$2 AND completed_at IS NULL`,
          [athlete, created.resource.id],
        )
      ).rows[0]?.['id'],
    );

    const repository = createResourceDerivedCleanupRepository({
      connectionString: adminUrl as string,
      max: 1,
    });
    try {
      // Far more cycles than the dead-letter threshold of 100 attempts.
      for (let cycle = 0; cycle < 150; cycle += 1) {
        expect(await processOneResourceDerivedCleanup(repository, {})).toBe('unsupported_target');
      }
      // A partially configured executor map releases the lease it took.
      for (let cycle = 0; cycle < 150; cycle += 1) {
        await admin.query(
          'UPDATE resource_derived_cleanup SET available_at=clock_timestamp() WHERE id=$1',
          [manifestId],
        );
        expect(
          await processOneResourceDerivedCleanup(repository, {
            derivedData: async () => undefined,
          }),
        ).toBe('unsupported_target');
      }
      const state = await admin.query(
        `SELECT attempts,completed_at,last_error_code FROM resource_derived_cleanup WHERE id=$1`,
        [manifestId],
      );
      expect(state.rows[0]).toMatchObject({
        attempts: 0,
        completed_at: null,
        last_error_code: 'DERIVED_TARGET_UNSUPPORTED',
      });

      // Once real executors exist the surviving backlog completes normally.
      await admin.query(
        'UPDATE resource_derived_cleanup SET available_at=clock_timestamp() WHERE id=$1',
        [manifestId],
      );
      const purged: string[] = [];
      let outcome = '';
      for (let attempt = 0; attempt < 50; attempt += 1) {
        outcome = await processOneResourceDerivedCleanup(repository, {
          derivedData: async () => void purged.push('derivedData'),
          searchIndex: async () => void purged.push('searchIndex'),
          cache: async () => void purged.push('cache'),
          citations: async () => void purged.push('citations'),
        });
        const done = await admin.query(
          'SELECT completed_at FROM resource_derived_cleanup WHERE id=$1',
          [manifestId],
        );
        if (done.rows[0]?.['completed_at'] !== null) break;
      }
      expect(outcome).toBe('completed');
      expect(purged).toContain('citations');
      const completed = await admin.query(
        'SELECT completed_at FROM resource_derived_cleanup WHERE id=$1',
        [manifestId],
      );
      expect(completed.rows[0]?.['completed_at']).not.toBeNull();
    } finally {
      await repository.close();
    }
  });

  it('pages shared resources with a real total instead of a silent cap', async () => {
    const coach = randomUUID();
    const owners = [randomUUID(), randomUUID(), randomUUID()];
    for (const owner of owners) {
      const created = await createResource(owner);
      await access.grantShare(owner, created.resource.id, {
        granteeKind: 'coach',
        granteePrincipalId: coach,
        expectedAccessRevision: created.resource.accessRevision,
        idempotencyKey: randomUUID(),
      });
    }

    const firstPage = await access.listSharedWithMe(coach, { limit: 2, offset: 0 });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.total).toBe(3);
    expect(firstPage.hasMore).toBe(true);

    const secondPage = await access.listSharedWithMe(coach, { limit: 2, offset: 2 });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.total).toBe(3);
    expect(secondPage.hasMore).toBe(false);
    expect(
      new Set([...firstPage.items, ...secondPage.items].map((item) => item.resourceId)).size,
    ).toBe(3);
  });

  it('rejects a tampered or ambiguous coach-use manifest instead of reporting it fresh', async () => {
    const athlete = randomUUID();
    await grantAiConsent(athlete);
    const created = await createResource(athlete);
    const reviewed = await access.setReviewed(athlete, created.resource.id, {
      reviewed: true,
      expectedAccessRevision: created.resource.accessRevision,
      expectedCurrentVersionId: created.version.id,
      idempotencyKey: randomUUID(),
    });
    const enabled = await access.setCoachUse(athlete, created.resource.id, {
      includeForCoach: true,
      expectedAccessRevision: reviewed.accessRevision,
      expectedCurrentVersionId: created.version.id,
      idempotencyKey: randomUUID(),
    });
    const manifest = await access.captureCoachUseManifest(athlete);
    expect(await access.revalidateCoachUseManifest(athlete, manifest)).toMatchObject({
      stale: false,
    });

    // Keeping the original digest while editing the consent head must not pass.
    await expect(
      access.revalidateCoachUseManifest(athlete, {
        ...manifest,
        aiConsentRevision: manifest.aiConsentRevision + 5,
      }),
    ).rejects.toMatchObject({ code: 'COACH_USE_MANIFEST_INVALID' });
    await expect(
      access.revalidateCoachUseManifest(athlete, { ...manifest, aiConsentGranted: false }),
    ).rejects.toMatchObject({ code: 'COACH_USE_MANIFEST_INVALID' });

    // Nor while editing a pinned entry revision.
    await expect(
      access.revalidateCoachUseManifest(athlete, {
        ...manifest,
        entries: manifest.entries.map((entry) => ({
          ...entry,
          accessRevision: entry.accessRevision + 1,
        })),
      }),
    ).rejects.toMatchObject({ code: 'COACH_USE_MANIFEST_INVALID' });

    // A duplicate entry makes the set identity ambiguous and is refused.
    await expect(
      access.revalidateCoachUseManifest(athlete, {
        ...manifest,
        entries: [...manifest.entries, ...manifest.entries],
      }),
    ).rejects.toThrow();

    // The untampered manifest still validates against the live revision.
    expect(await access.revalidateCoachUseManifest(athlete, manifest)).toMatchObject({
      stale: false,
      results: [{ resourceId: created.resource.id, status: 'authorized' }],
    });
    expect(enabled.accessRevision).toBe(manifest.entries[0]?.accessRevision);
  });

  it('keeps the shared list self-consistent while other owners grant and revoke', async () => {
    const coach = randomUUID();
    const owners = await Promise.all(
      Array.from({ length: 12 }, async () => {
        const owner = randomUUID();
        const created = await createResource(owner);
        return {
          owner,
          resourceId: created.resource.id,
          revision: created.resource.accessRevision,
        };
      }),
    );

    function deferred() {
      let resolve: () => void = () => undefined;
      const promise = new Promise<void>((settle) => {
        resolve = settle;
      });
      return { promise, resolve };
    }
    const churnStarted = deferred();
    const listedMidChurn = deferred();

    // Grants and revocations by many different owners cannot be serialized by
    // the grantee's own tenant lock, so the list statement must be atomic. The
    // barriers guarantee at least one listing runs strictly between two churn
    // operations rather than before or after the whole churn.
    const churn = (async () => {
      for (const [index, entry] of owners.entries()) {
        const granted = await access.grantShare(entry.owner, entry.resourceId, {
          granteeKind: 'coach',
          granteePrincipalId: coach,
          expectedAccessRevision: entry.revision,
          idempotencyKey: randomUUID(),
        });
        // A fixed alternating pattern, so the interleaving is reproducible.
        if (index % 2 === 1) {
          const shareId = granted.shares[0]?.shareId as string;
          await access.revokeShare(entry.owner, entry.resourceId, shareId, {
            expectedAccessRevision: granted.accessRevision,
            idempotencyKey: randomUUID(),
          });
        }
        if (index === 5) {
          churnStarted.resolve();
          await listedMidChurn.promise;
        }
      }
    })();

    const observations: { items: number; total: number; hasMore: boolean }[] = [];
    async function observe(rounds: number) {
      for (let round = 0; round < rounds; round += 1) {
        const page = await access.listSharedWithMe(coach, { limit: 1, offset: 0 });
        observations.push({ items: page.items.length, total: page.total, hasMore: page.hasMore });
      }
    }
    const listing = (async () => {
      await churnStarted.promise;
      await observe(10);
      listedMidChurn.resolve();
      await observe(50);
    })();
    await Promise.all([churn, listing]);

    // Every observation parsed, so the contract refinement never tripped, and
    // the page never claimed more rows than the count it was taken from.
    expect(observations).toHaveLength(60);
    for (const observation of observations) {
      expect(observation.total).toBeGreaterThanOrEqual(observation.items);
      expect(observation.hasMore).toBe(observation.items < observation.total);
      if (observation.total === 0) expect(observation.items).toBe(0);
    }
    const settled = await access.listSharedWithMe(coach, { limit: 100, offset: 0 });
    expect(settled.total).toBe(6);
    expect(settled.items).toHaveLength(6);
    expect(settled.hasMore).toBe(false);
  });

  it('reads a consistent shared list across an owner grant that is still open', async () => {
    const coach = randomUUID();
    const owner = randomUUID();
    const created = await createResource(owner);
    const shareId = randomUUID();

    // A real concurrent transaction: the grant row exists but is uncommitted
    // while the grantee's own connection runs the list statement.
    await database.tenant(owner, async (tx) => {
      await tx.query(
        `UPDATE resource SET access_revision=access_revision+1,updated_at=statement_timestamp()
         WHERE athlete_id=$1 AND id=$2`,
        [owner, created.resource.id],
      );
      await tx.query(
        `INSERT INTO resource_share
          (athlete_id,share_id,resource_id,grantee_kind,grantee_principal_id,state,
           granted_access_revision,granted_at,updated_at)
         VALUES($1,$2,$3,'coach',$4,'active',$5,statement_timestamp(),statement_timestamp())`,
        [owner, shareId, created.resource.id, coach, created.resource.accessRevision + 1],
      );
      const duringOpenTransaction = await access.listSharedWithMe(coach, {
        limit: 10,
        offset: 0,
      });
      expect(duringOpenTransaction.items).toEqual([]);
      expect(duringOpenTransaction.total).toBe(0);
      expect(duringOpenTransaction.hasMore).toBe(false);
    });

    const afterCommit = await access.listSharedWithMe(coach, { limit: 10, offset: 0 });
    expect(afterCommit.items.map((item) => item.resourceId)).toEqual([created.resource.id]);
    expect(afterCommit.total).toBe(1);
    expect(afterCommit.hasMore).toBe(false);
  });

  it('refuses another tenant manifest, including the identical empty set', async () => {
    const athlete = randomUUID();
    const other = randomUUID();
    await grantAiConsent(athlete);
    await grantAiConsent(other);

    // Both tenants currently authorize nothing, so only the tenant binding can
    // tell the two manifests apart.
    const empty = await access.captureCoachUseManifest(other);
    expect(empty.entries).toEqual([]);
    expect(empty.athleteId).toBe(other);
    const ownEmpty = await access.captureCoachUseManifest(athlete);
    expect(ownEmpty.entriesDigest).not.toBe(empty.entriesDigest);
    await expect(access.revalidateCoachUseManifest(athlete, empty)).rejects.toMatchObject({
      code: 'COACH_USE_MANIFEST_INVALID',
    });
    expect(await access.revalidateCoachUseManifest(athlete, ownEmpty)).toMatchObject({
      stale: false,
    });

    // A populated manifest is refused for another tenant as well, and simply
    // relabelling the tenant breaks the digest.
    const created = await createResource(other);
    const reviewed = await access.setReviewed(other, created.resource.id, {
      reviewed: true,
      expectedAccessRevision: created.resource.accessRevision,
      expectedCurrentVersionId: created.version.id,
      idempotencyKey: randomUUID(),
    });
    await access.setCoachUse(other, created.resource.id, {
      includeForCoach: true,
      expectedAccessRevision: reviewed.accessRevision,
      expectedCurrentVersionId: created.version.id,
      idempotencyKey: randomUUID(),
    });
    const populated = await access.captureCoachUseManifest(other);
    await expect(access.revalidateCoachUseManifest(athlete, populated)).rejects.toMatchObject({
      code: 'COACH_USE_MANIFEST_INVALID',
    });
    await expect(
      access.revalidateCoachUseManifest(athlete, { ...populated, athleteId: athlete }),
    ).rejects.toMatchObject({ code: 'COACH_USE_MANIFEST_INVALID' });
  });

  it('refuses cross-tenant access commands and self-sharing', async () => {
    const owner = randomUUID();
    const other = randomUUID();
    const created = await createResource(owner);
    const resourceId = created.resource.id;

    await expect(access.readAccess(other, resourceId)).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
    await expect(
      access.setReviewed(other, resourceId, {
        reviewed: true,
        expectedAccessRevision: created.resource.accessRevision,
        expectedCurrentVersionId: created.version.id,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await expect(
      access.grantShare(owner, resourceId, {
        granteeKind: 'coach',
        granteePrincipalId: owner,
        expectedAccessRevision: created.resource.accessRevision,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'SHARE_GRANTEE_INVALID' });
  });

  it('rejects a stale expected revision on every access transition', async () => {
    const athlete = randomUUID();
    await grantAiConsent(athlete);
    const created = await createResource(athlete);
    const resourceId = created.resource.id;
    const stale = created.resource.accessRevision;
    await access.setReviewed(athlete, resourceId, {
      reviewed: true,
      expectedAccessRevision: stale,
      expectedCurrentVersionId: created.version.id,
      idempotencyKey: randomUUID(),
    });

    await expect(
      access.setCoachUse(athlete, resourceId, {
        includeForCoach: true,
        expectedAccessRevision: stale,
        expectedCurrentVersionId: created.version.id,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(
      access.grantShare(athlete, resourceId, {
        granteeKind: 'coach',
        granteePrincipalId: randomUUID(),
        expectedAccessRevision: stale,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  });

  it('replays one access command idempotently without a second revision', async () => {
    const athlete = randomUUID();
    const created = await createResource(athlete);
    const resourceId = created.resource.id;
    const key = randomUUID();
    const input = {
      reviewed: true,
      expectedAccessRevision: created.resource.accessRevision,
      expectedCurrentVersionId: created.version.id,
      idempotencyKey: key,
    };
    const first = await access.setReviewed(athlete, resourceId, input);
    const replayed = await access.setReviewed(athlete, resourceId, input);
    expect(replayed.accessRevision).toBe(first.accessRevision);
    const audit = await admin.query(
      "SELECT count(*)::integer AS total FROM resource_access_audit WHERE athlete_id=$1 AND action='reviewed_marked'",
      [athlete],
    );
    expect(audit.rows[0]?.['total']).toBe(1);
  });

  it('drains the derived manifest with a least-privilege worker role only', async () => {
    const athlete = randomUUID();
    const created = await createResource(athlete);
    await resources.softDelete(athlete, created.resource.id, {
      expectedAccessRevision: created.resource.accessRevision,
      expectedCurrentVersionId: created.version.id,
      idempotencyKey: randomUUID(),
    });

    const workerRole = `derived_cleanup_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    await admin.query(`CREATE ROLE "${workerRole}" LOGIN NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO "${workerRole}"`);
    await grantResourceObjectCleanupWorker(adminUrl as string, workerRole);
    const privileges = await admin.query(
      `SELECT has_table_privilege($1,'resource_derived_cleanup','SELECT') AS can_select,
       has_table_privilege($1,'resource','SELECT') AS can_read_resources,
       has_function_privilege($1,'public.lease_resource_derived_cleanup(uuid,timestamptz,timestamptz)','EXECUTE') AS can_lease,
       has_function_privilege('workout_runtime','public.lease_resource_derived_cleanup(uuid,timestamptz,timestamptz)','EXECUTE') AS runtime_can_lease,
       has_table_privilege('workout_runtime','resource_derived_cleanup','SELECT') AS runtime_can_select`,
      [workerRole],
    );
    expect(privileges.rows[0]).toEqual({
      can_select: false,
      can_read_resources: false,
      can_lease: true,
      runtime_can_lease: false,
      runtime_can_select: false,
    });

    const workerUrl = new URL(runtimeUrl as string);
    workerUrl.username = workerRole;
    const repository = createResourceDerivedCleanupRepository({
      connectionString: workerUrl.href,
      max: 1,
    });
    try {
      // The queue is shared, so drain in order until this tenant's manifest appears.
      let manifest: Awaited<ReturnType<typeof repository.lease>> = null;
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const now = new Date();
        const leased = await repository.lease(now, new Date(now.getTime() + 60_000));
        if (!leased) break;
        if (leased.athleteId === athlete) {
          manifest = leased;
          break;
        }
        await repository.finish(leased, { ok: true });
      }
      expect(manifest).toMatchObject({
        athleteId: athlete,
        resourceId: created.resource.id,
        reason: 'resource_deleted',
        targets: { derivedData: true, searchIndex: true, cache: true, citations: true },
      });
      if (!manifest) throw new Error('Expected a leased manifest');
      expect(await repository.finish(manifest, { ok: true })).toBe(true);
      // The finished manifest cannot be completed twice by a stale worker.
      expect(await repository.finish(manifest, { ok: true })).toBe(false);
    } finally {
      await repository.close();
      await admin.query(`DROP OWNED BY "${workerRole}"`);
      await admin.query(`DROP ROLE "${workerRole}"`);
    }
  });
});
