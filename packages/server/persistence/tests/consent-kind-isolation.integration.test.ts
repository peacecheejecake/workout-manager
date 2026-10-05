import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import { grantOperations, migrate } from '../src/migrate.js';
import { createConsentRepository } from '../src/repositories.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl)
  throw new Error('Real isolated PostgreSQL required: run pnpm test:integration');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
const kinds = ['app', 'provider', 'ai'] as const;

beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await admin.query('GRANT USAGE ON SCHEMA public TO workout_runtime');
  await admin.query(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON consent, outbox, command_receipt TO workout_runtime',
  );
  database = createDatabase({ connectionString: runtimeUrl, max: 4 });
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});

describe('same-account consent kind isolation in real PostgreSQL', () => {
  it.each(kinds)(
    'withdrawing and granting %s preserves the other consent heads',
    async (changed) => {
      const athleteId = randomUUID();
      const repository = createConsentRepository(database);
      for (const kind of kinds) {
        await repository.setConsent(athleteId, {
          kind,
          granted: true,
          expectedRevision: 0,
          idempotencyKey: randomUUID(),
        });
      }
      const foreignAthleteId = randomUUID();
      for (const kind of kinds) {
        await repository.setConsent(foreignAthleteId, {
          kind,
          granted: true,
          expectedRevision: 0,
          idempotencyKey: randomUUID(),
        });
      }
      const readHeads = () =>
        Promise.all(kinds.map((kind) => repository.getConsent(athleteId, kind)));
      expect(await readHeads()).toEqual(
        kinds.map((kind) => ({ kind, granted: true, revision: 1 })),
      );

      await repository.setConsent(athleteId, {
        kind: changed,
        granted: false,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      });
      expect(await readHeads()).toEqual(
        kinds.map((kind) => ({
          kind,
          granted: kind !== changed,
          revision: kind === changed ? 2 : 1,
        })),
      );

      // Other valid revision-1 heads remain usable after an unrelated withdrawal.
      const other = kinds.find((kind) => kind !== changed);
      if (!other) throw new Error('Expected another consent kind');
      await repository.setConsent(athleteId, {
        kind: other,
        granted: false,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      });
      await repository.setConsent(athleteId, {
        kind: changed,
        granted: true,
        expectedRevision: 2,
        idempotencyKey: randomUUID(),
      });
      const expected = kinds.map((kind) => ({
        kind,
        granted: kind !== other,
        revision: kind === changed ? 3 : kind === other ? 2 : 1,
      }));
      expect(await readHeads()).toEqual(expected);
      await database.tenant(athleteId, async (tx) => {
        const stored = await tx.query('SELECT kind, granted, revision FROM consent ORDER BY kind');
        expect(stored.rows).toEqual(
          [...expected].sort((left, right) => left.kind.localeCompare(right.kind)),
        );
        const events = await tx.query(
          "SELECT payload->>'kind' AS kind, count(*)::integer AS count FROM outbox WHERE topic='consent.changed' GROUP BY payload->>'kind' ORDER BY kind",
        );
        expect(events.rows).toEqual(
          kinds
            .map((kind) => ({ kind, count: kind === changed ? 3 : kind === other ? 2 : 1 }))
            .sort((left, right) => left.kind.localeCompare(right.kind)),
        );
      });
      // Both tenants have real consent/outbox rows; omit account filters to exercise RLS.
      for (const [ownerId, hiddenId, heads] of [
        [athleteId, foreignAthleteId, expected],
        [foreignAthleteId, athleteId, kinds.map((kind) => ({ kind, granted: true, revision: 1 }))],
      ] as const) {
        await database.tenant(ownerId, async (tx) => {
          const stored = await tx.query(
            'SELECT athlete_id, kind, granted, revision FROM consent ORDER BY kind',
          );
          expect(stored.rows).toEqual(
            heads
              .map((head) => ({ athlete_id: ownerId, ...head }))
              .sort((left, right) => left.kind.localeCompare(right.kind)),
          );
          const events = await tx.query(
            "SELECT athlete_id, payload->>'kind' AS kind, count(*)::integer AS count FROM outbox WHERE topic='consent.changed' GROUP BY athlete_id, payload->>'kind' ORDER BY kind",
          );
          expect(events.rows).toEqual(
            heads
              .map((head) => ({ athlete_id: ownerId, kind: head.kind, count: head.revision }))
              .sort((left, right) => left.kind.localeCompare(right.kind)),
          );
          for (const table of ['consent', 'outbox'] as const) {
            const hidden = await tx.query(`SELECT athlete_id FROM ${table} WHERE athlete_id=$1`, [
              hiddenId,
            ]);
            expect(hidden.rows).toEqual([]);
          }
        });
      }
      const emptyAthleteId = randomUUID();
      expect(
        await Promise.all(kinds.map((kind) => repository.getConsent(emptyAthleteId, kind))),
      ).toEqual(kinds.map((kind) => ({ kind, granted: false, revision: 0 })));
    },
  );
});
