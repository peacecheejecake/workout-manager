import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { migrate } from '../src/migrate.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl, max: 1 });

beforeAll(async () => {
  await migrate(adminUrl, 28);
});

afterAll(async () => {
  await admin.end();
});

it('revokes a legacy runtime grant when migration 029 renames the erasure wrapper', async () => {
  await admin.query('GRANT EXECUTE ON FUNCTION public.erase_account(text) TO workout_runtime');
  expect(
    (
      await admin.query(
        "SELECT has_function_privilege('workout_runtime','public.erase_account(text)','EXECUTE') AS allowed",
      )
    ).rows[0]?.['allowed'],
  ).toBe(true);

  await migrate(adminUrl);

  expect(
    (
      await admin.query(
        `SELECT
          has_function_privilege('workout_runtime',
            'public.erase_account_before_url_resources(text)','EXECUTE') AS legacy_allowed,
          has_function_privilege('workout_runtime','public.erase_account(text)','EXECUTE') AS new_allowed`,
      )
    ).rows[0],
  ).toEqual({ legacy_allowed: false, new_allowed: false });
});
