import assert from 'node:assert/strict';
import test from 'node:test';

import { connection, createOrLimitRole } from './bootstrap-db.mjs';

test('setup URLs require the exact internal host, database, role, and a strong password', () => {
  const password = 'synthetic-credential-32-chars-long';
  const valid = `postgresql://workout_runtime:${password}@wm-postgres:5432/workout`;
  assert.equal(connection(valid, 'workout_runtime').password, password);
  for (const invalid of [
    valid.replace('workout_runtime:', 'postgres:'),
    valid.replace('@wm-postgres:', '@example.com:'),
    valid.replace('@wm-postgres:', '@postgres:'),
    valid.replace('/workout', '/other'),
    valid.replace(password, 'short'),
    `${valid}?sslmode=disable`,
  ]) {
    assert.throws(() => connection(invalid, 'workout_runtime'));
  }
});

test('role setup parameterizes the password and rolls back on failure', async () => {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('DO $$')) throw new Error('synthetic failure');
    },
  };
  await assert.rejects(
    createOrLimitRole(client, 'workout_runtime', 'synthetic-password-value'),
    /synthetic failure/,
  );
  assert.deepEqual(
    calls.map(({ sql }) => sql.trim().slice(0, 6)),
    ['BEGIN', 'SELECT', 'DO $$\n', 'ROLLBA'],
  );
  assert.equal(calls[1].values[0], 'synthetic-password-value');
  assert.equal(calls[2].sql.includes('synthetic-password-value'), false);
  await assert.rejects(
    createOrLimitRole(client, 'workout_runtime; DROP DATABASE workout', 'anything'),
    /DATABASE_SETUP_ROLE_INVALID/,
  );
});
