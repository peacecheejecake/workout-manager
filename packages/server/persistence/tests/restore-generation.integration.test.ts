import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrate, migrationFileNames } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const database = `restore_gen_${suffix}`;
const firstOwner = `restore_gen_first_${suffix}`;
const nextOwner = `restore_gen_next_${suffix}`;
const runtimeRole = `restore_gen_rt_${suffix}`;
const outsiderRole = `restore_gen_other_${suffix}`;
const priorVersion = migrationFileNames.findIndex((file) => file === '076_restore_generation.sql');

function urlFor(role: string): string {
  const url = new URL(adminUrl as string);
  url.pathname = `/${database}`;
  url.username = role;
  url.password = 'plain';
  return url.toString();
}

async function generation(pool: Pool): Promise<string> {
  const result = await pool.query<{ generation_id: string }>(
    'SELECT public.current_restore_generation() AS generation_id',
  );
  const value = result.rows[0]?.generation_id;
  if (!value) throw new Error('Missing restore generation');
  return value;
}

let owner: Pool;
let runtime: Pool;
let outsider: Pool;
let next: Pool;

beforeAll(async () => {
  expect(priorVersion).toBe(75);
  for (const role of [firstOwner, nextOwner, runtimeRole, outsiderRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'plain' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${database}" OWNER "${firstOwner}"`);
  owner = new Pool({ connectionString: urlFor(firstOwner), max: 1 });
  runtime = new Pool({ connectionString: urlFor(runtimeRole), max: 1 });
  outsider = new Pool({ connectionString: urlFor(outsiderRole), max: 1 });
  next = new Pool({ connectionString: urlFor(nextOwner), max: 1 });
  await migrate(urlFor(firstOwner), priorVersion);
  await owner.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}","${outsiderRole}"`);
});

afterAll(async () => {
  await Promise.all([owner?.end(), runtime?.end(), outsider?.end(), next?.end()]);
  await dropIsolatedDatabase(admin, database);
  for (const role of [outsiderRole, runtimeRole, nextOwner, firstOwner])
    await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});

describe('restore generation storage (EXT-HOSTING)', () => {
  it('upgrades once, initializes exactly one UUID, and preserves earlier checksums', async () => {
    const before = await owner.query<{ version: number; checksum: string }>(
      'SELECT version,checksum FROM schema_migrations ORDER BY version',
    );
    expect(before.rows).toHaveLength(priorVersion);
    await migrate(urlFor(firstOwner), priorVersion + 1);
    const initial = await generation(owner);
    expect(initial).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/);
    expect(await owner.query('SELECT * FROM public.restore_generation')).toMatchObject({
      rowCount: 1,
    });
    const security = await owner.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.restore_generation'::regclass",
    );
    expect(security.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    await migrate(urlFor(firstOwner), priorVersion + 1);
    expect(await generation(owner)).toBe(initial);
    const after = await owner.query<{ version: number; checksum: string }>(
      'SELECT version,checksum FROM schema_migrations ORDER BY version',
    );
    expect(after.rows.slice(0, priorVersion)).toEqual(before.rows);
    expect(after.rows).toHaveLength(priorVersion + 1);
  });

  it('allows a granted runtime read only through the function and denies other roles', async () => {
    await owner.query(
      `GRANT EXECUTE ON FUNCTION public.current_restore_generation() TO "${runtimeRole}"`,
    );
    const expected = await generation(owner);
    expect(await generation(runtime)).toBe(expected);
    expect(await generation(runtime)).toBe(expected);
    await expect(runtime.query('SELECT * FROM public.restore_generation')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      runtime.query('UPDATE public.restore_generation SET generation_id=$1', [randomUUID()]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(runtime.query('SELECT public.rotate_restore_generation()')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(generation(outsider)).rejects.toMatchObject({ code: '42501' });
    expect(await generation(owner)).toBe(expected);
  });

  it('rotates only for the owner and rolls back an uncommitted rotation', async () => {
    const before = await generation(owner);
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      const inside = await client.query<{ generation_id: string }>(
        'SELECT public.rotate_restore_generation() AS generation_id',
      );
      expect(inside.rows[0]?.generation_id).not.toBe(before);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await generation(owner)).toBe(before);
    const rotated = await owner.query<{ generation_id: string }>(
      'SELECT public.rotate_restore_generation() AS generation_id',
    );
    expect(rotated.rows[0]?.generation_id).not.toBe(before);
    expect(await generation(runtime)).toBe(rotated.rows[0]?.generation_id);
    expect((await owner.query('SELECT * FROM public.restore_generation')).rowCount).toBe(1);
  });

  it('follows owner reassignment without exposing the table to runtime', async () => {
    const before = await generation(owner);
    const inspectUrl = new URL(adminUrl);
    inspectUrl.pathname = `/${database}`;
    const inspect = new Pool({ connectionString: inspectUrl.toString() });
    try {
      await inspect.query(`REASSIGN OWNED BY "${firstOwner}" TO "${nextOwner}"`);
    } finally {
      await inspect.end();
    }
    expect(await generation(runtime)).toBe(before);
    await expect(owner.query('SELECT public.rotate_restore_generation()')).rejects.toMatchObject({
      code: '42501',
    });
    const rotated = await next.query<{ generation_id: string }>(
      'SELECT public.rotate_restore_generation() AS generation_id',
    );
    expect(rotated.rows[0]?.generation_id).not.toBe(before);
    expect(await generation(runtime)).toBe(rotated.rows[0]?.generation_id);
    await expect(runtime.query('SELECT * FROM public.restore_generation')).rejects.toMatchObject({
      code: '42501',
    });
  });
});
