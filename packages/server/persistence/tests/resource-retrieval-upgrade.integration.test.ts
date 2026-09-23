import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { migrate } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

/**
 * Migration 032 has to run against a populated database, not only a fresh one.
 * This suite builds a real 031 schema, seeds the states M2-04d could produce,
 * and then migrates the rest of the way.
 */
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
const database = `upgrade_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const upgradeUrl = () => {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
};
let upgraded: Pool;

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${database}`);
  upgraded = new Pool({ connectionString: upgradeUrl() });
});

afterAll(async () => {
  await upgraded?.end();
  await dropIsolatedDatabase(admin, database);
  await admin.end();
});

const versionColumns = `(athlete_id,resource_id,version_id,version,previous_version,
  previous_version_id,content,content_hash,paragraphs,content_status,index_status,created_at)`;
const hash = (value: string) =>
  value
    .padEnd(64, '0')
    .slice(0, 64)
    .replaceAll(/[^a-f0-9]/g, 'a');

/** Every seed statement runs with the tenant session variable the triggers expect. */
async function withTenant<T>(athleteId: string, run: (client: PoolClient) => Promise<T>) {
  const client = await upgraded.connect();
  try {
    await client.query('SELECT set_config($1,$2,false)', ['app.athlete_id', athleteId]);
    return await run(client);
  } finally {
    client.release();
  }
}

async function seedResource(input: {
  athleteId: string;
  reviewed: boolean;
  includeForCoach: boolean;
  /** Seconds the review predates or follows the current version's creation. */
  reviewOffsetSeconds: number | null;
  versions: number;
}) {
  const resourceId = randomUUID();
  const versionIds = Array.from({ length: input.versions }, () => randomUUID());
  await withTenant(input.athleteId, async (client) => {
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    const current = versionIds[versionIds.length - 1];
    await client.query(
      `INSERT INTO resource
        (athlete_id,id,source_kind,title,category,metadata,tags,favorite,include_for_coach,
         reviewed_state,reviewed_at,coach_use_enabled_at,access_revision,current_version,
         current_version_id,created_at,updated_at)
       VALUES($1,$2,'text',$3,'note','{}'::jsonb,'[]'::jsonb,false,$4,$5,
         CASE WHEN $6::integer IS NULL THEN NULL
           ELSE now()+make_interval(secs=>$6::integer) END,
         CASE WHEN $4 THEN now() ELSE NULL END,1,$7,$8,now(),now())`,
      [
        input.athleteId,
        resourceId,
        `자료 ${resourceId.slice(0, 8)}`,
        input.includeForCoach,
        input.reviewed ? 'reviewed' : 'unreviewed',
        input.reviewOffsetSeconds,
        input.versions,
        current,
      ],
    );
    for (const [index, versionId] of versionIds.entries())
      await client.query(
        `INSERT INTO resource_version ${versionColumns}
         VALUES($1,$2,$3,$4,$5,$6,'본문',$7,$8::jsonb,'parsed','not_indexed',now())`,
        [
          input.athleteId,
          resourceId,
          versionId,
          index + 1,
          index === 0 ? null : index,
          index === 0 ? null : versionIds[index - 1],
          hash(`content${index}`),
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
    await client.query('COMMIT');
  });
  return { resourceId, currentVersionId: versionIds[versionIds.length - 1] };
}

async function reviewedVersionOf(resourceId: string) {
  const row = (
    await upgraded.query('SELECT reviewed_state,reviewed_version_id FROM resource WHERE id=$1', [
      resourceId,
    ])
  ).rows[0];
  return z
    .object({
      reviewed_state: z.enum(['unreviewed', 'reviewed']),
      reviewed_version_id: z.string().nullable(),
    })
    .parse(row);
}

describe('migration 032 upgrade of a populated 031 database', () => {
  it('backfills conservatively and never promotes an unreviewed body', async () => {
    // A real 031 schema, then rows only M2-04d could have produced.
    await migrate(adminUrl as string, 31);
    await migrate(upgradeUrl(), 31);
    const athleteId = randomUUID();
    await withTenant(athleteId, (client) =>
      client.query("INSERT INTO consent VALUES($1,'ai',true,1)", [athleteId]),
    );
    const reviewedSingle = await seedResource({
      athleteId,
      reviewed: true,
      includeForCoach: true,
      reviewOffsetSeconds: 60,
      versions: 1,
    });
    const reviewedThenReplaced = await seedResource({
      athleteId,
      reviewed: true,
      includeForCoach: true,
      // The review predates the current version: under M2-04d the flag simply
      // survived the append, so this body was never reviewed by anyone.
      reviewOffsetSeconds: -60,
      versions: 2,
    });
    const reviewedAtSameInstant = await seedResource({
      athleteId,
      reviewed: true,
      includeForCoach: true,
      // Identical timestamps. Wall clock alone cannot order "reviewed, then a
      // version was created" against the reverse, so this must stay unpinned.
      reviewOffsetSeconds: 0,
      versions: 2,
    });
    const singleVersionSameInstant = await seedResource({
      athleteId,
      reviewed: true,
      includeForCoach: true,
      // Same tie, but a single version: the body is provably the reviewed one
      // without inferring any ordering.
      reviewOffsetSeconds: 0,
      versions: 1,
    });
    const neverReviewed = await seedResource({
      athleteId,
      reviewed: false,
      includeForCoach: false,
      reviewOffsetSeconds: null,
      versions: 1,
    });

    // The upgrade itself must not fail on an existing reviewed row.
    await expect(migrate(upgradeUrl())).resolves.toBeUndefined();

    expect(await reviewedVersionOf(reviewedSingle.resourceId)).toEqual({
      reviewed_state: 'reviewed',
      reviewed_version_id: reviewedSingle.currentVersionId,
    });
    // Conservative: not pinned, so the gate stays shut until it is reviewed.
    expect(await reviewedVersionOf(reviewedThenReplaced.resourceId)).toEqual({
      reviewed_state: 'reviewed',
      reviewed_version_id: null,
    });
    // An unprovable ordering is left unpinned, but a single-version resource is
    // pinned on structure alone even when the instants tie.
    expect(await reviewedVersionOf(reviewedAtSameInstant.resourceId)).toEqual({
      reviewed_state: 'reviewed',
      reviewed_version_id: null,
    });
    expect(await reviewedVersionOf(singleVersionSameInstant.resourceId)).toEqual({
      reviewed_state: 'reviewed',
      reviewed_version_id: singleVersionSameInstant.currentVersionId,
    });
    expect(await reviewedVersionOf(neverReviewed.resourceId)).toEqual({
      reviewed_state: 'unreviewed',
      reviewed_version_id: null,
    });

    const authorized = (resourceId: string) =>
      withTenant(athleteId, async (client) =>
        z
          .boolean()
          .parse(
            (
              await client.query('SELECT public.resource_coach_use_authorized($1) AS ok', [
                resourceId,
              ])
            ).rows[0]?.['ok'],
          ),
      );
    expect(await authorized(reviewedSingle.resourceId)).toBe(true);
    expect(await authorized(singleVersionSameInstant.resourceId)).toBe(true);
    // The bodies that were never provably reviewed are not coach-usable.
    expect(await authorized(reviewedThenReplaced.resourceId)).toBe(false);
    expect(await authorized(reviewedAtSameInstant.resourceId)).toBe(false);
    expect(await authorized(neverReviewed.resourceId)).toBe(false);

    // No new unpinned reviewed row can be created after the upgrade: the
    // migration's own rows are the only ones that may exist in that state.
    await expect(
      withTenant(athleteId, (client) =>
        client.query(
          `INSERT INTO resource
            (athlete_id,id,source_kind,title,category,metadata,tags,favorite,include_for_coach,
             reviewed_state,reviewed_at,coach_use_enabled_at,access_revision,current_version,
             current_version_id,created_at,updated_at)
           VALUES($1,$2,'text','검토됨 미고정','note','{}'::jsonb,'[]'::jsonb,false,false,
             'reviewed',now(),NULL,1,1,$3,now(),now())`,
          [athleteId, randomUUID(), reviewedSingle.currentVersionId],
        ),
      ),
    ).rejects.toThrow(/INVALID_RESOURCE_TRANSITION/);

    // The legacy unpinned row stays usable as a row: other access commands
    // must not be rejected by the new trigger rules.
    await expect(
      withTenant(athleteId, (client) =>
        client.query(
          `UPDATE resource SET include_for_coach=false,coach_use_enabled_at=NULL,
             access_revision=access_revision+1,updated_at=now()
           WHERE id=$1`,
          [reviewedThenReplaced.resourceId],
        ),
      ),
    ).resolves.toBeDefined();
    // Marking the current body reviewed pins it and reopens the gate.
    await withTenant(athleteId, (client) =>
      client.query(
        `UPDATE resource SET reviewed_version_id=current_version_id,
           access_revision=access_revision+1,updated_at=now()
         WHERE id=$1`,
        [reviewedThenReplaced.resourceId],
      ),
    );
    expect((await reviewedVersionOf(reviewedThenReplaced.resourceId)).reviewed_version_id).toBe(
      reviewedThenReplaced.currentVersionId,
    );
    // Clearing a pin while staying reviewed is refused.
    await expect(
      withTenant(athleteId, (client) =>
        client.query(
          `UPDATE resource SET reviewed_version_id=NULL,
             access_revision=access_revision+1,updated_at=now()
           WHERE id=$1`,
          [reviewedThenReplaced.resourceId],
        ),
      ),
    ).rejects.toThrow(/INVALID_RESOURCE_TRANSITION/);
  });
});
