import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const pgBin = process.env['PG_BIN'] ?? '/opt/homebrew/opt/postgresql@14/bin';

it('keeps pre-fence v1 receipts historical through migration and full pg_dump/restore', async () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const sourceName = `hk_upgrade_${suffix}`,
    targetName = `hk_restore_${suffix}`;
  const directory = await mkdtemp(join(tmpdir(), 'wm-hk-backup-'));
  const sourceUrl = new URL(adminUrl),
    targetUrl = new URL(adminUrl);
  sourceUrl.pathname = `/${sourceName}`;
  targetUrl.pathname = `/${targetName}`;
  let source: Pool | undefined, target: Pool | undefined;
  try {
    await admin.query(`CREATE DATABASE "${sourceName}"`);
    await admin.query(`CREATE DATABASE "${targetName}"`);
    await migrate(sourceUrl.toString(), 94);
    source = new Pool({ connectionString: sourceUrl.toString() });
    const athlete = randomUUID(),
      installation = randomUUID(),
      batch = randomUUID();
    await source.query(
      `INSERT INTO healthkit_workout_batch_receipt
      (athlete_id,installation_id,batch_id,request_digest,accepted_count) VALUES($1,$2,$3,$4,1)`,
      [athlete, installation, batch, 'a'.repeat(64)],
    );
    await migrate(sourceUrl.toString());
    const select = `SELECT protocol_version,pre_registration_historical,request_digest,accepted_count
      FROM healthkit_workout_batch_receipt WHERE athlete_id=$1`;
    const expected = {
      protocol_version: 1,
      pre_registration_historical: true,
      request_digest: 'a'.repeat(64),
      accepted_count: 1,
    };
    expect((await source.query(select, [athlete])).rows).toEqual([expected]);
    const dump = join(directory, 'synthetic.dump');
    execFileSync(
      join(pgBin, 'pg_dump'),
      ['--format=custom', '--file', dump, '--dbname', sourceUrl.toString()],
      { stdio: 'pipe' },
    );
    execFileSync(
      join(pgBin, 'pg_restore'),
      ['--exit-on-error', '--dbname', targetUrl.toString(), dump],
      { stdio: 'pipe' },
    );
    target = new Pool({ connectionString: targetUrl.toString() });
    expect((await target.query(select, [athlete])).rows).toEqual([expected]);
    // Defaults still fence post-restore old-protocol inserts, rather than
    // falsely marking new rows historical or converting old rows to v2.
    await expect(
      target.query(
        `INSERT INTO healthkit_workout_batch_receipt
      (athlete_id,installation_id,batch_id,request_digest,accepted_count) VALUES($1,$2,$3,$4,1)`,
        [athlete, randomUUID(), randomUUID(), 'b'.repeat(64)],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect((await target.query(select, [athlete])).rows).toEqual([expected]);
  } finally {
    await source?.end();
    await target?.end();
    await dropIsolatedDatabase(admin, sourceName);
    await dropIsolatedDatabase(admin, targetName);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
