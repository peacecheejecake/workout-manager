import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { migrate, grantOperations } from '../../../packages/server/persistence/src/migrate.ts';
import {
  captureSchema100RowInventory,
  withSchema100InventorySnapshot,
} from './schema100-row-inventory.mjs';

const enabled = process.env.WORKOUT_SCHEMA100_INVENTORY_REAL_PG === '1';
const bin = process.env.PG_BIN ?? '/opt/homebrew/opt/postgresql@14/bin';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const expectedCandidateSha256 = '6217fda6118b7919c8db07b7cba3cd642daf9dcf0c0bff6c29a152f75821a231';
const expectedCatalogSha256 = 'e37b164b4ef427f81f247f6e956511e51b8b633ced6c4522497b28411e32e526';
const failure = { message: 'SCHEMA100_ROW_INVENTORY_UNAVAILABLE' };
function run(name, args) {
  const result = spawnSync(join(bin, name), args, { encoding: 'utf8', timeout: 60000 });
  // Never echo a PG statement/row/provider payload on failure.
  if (result.error || result.status !== 0) throw new Error('DISPOSABLE_POSTGRES_COMMAND_FAILED');
}

test(
  'actual schema100 private inventory (candidate only, no restore admission)',
  { skip: !enabled },
  async (t) => {
    const candidateBytes = readFileSync(process.env.WORKOUT_SCHEMA100_INVENTORY_CANDIDATE);
    assert.equal(sha(candidateBytes), expectedCandidateSha256);
    const root = mkdtempSync(join(tmpdir(), 'wm-schema100-row-'));
    const data = join(root, 'data');
    const clients = [];
    let started = false;
    try {
      run('initdb', [
        '-D',
        data,
        '-U',
        'workout_admin',
        '-A',
        'trust',
        '--no-locale',
        '--encoding=UTF8',
      ]);
      run('pg_ctl', [
        '-D',
        data,
        '-l',
        join(root, 'postgres.log'),
        '-o',
        `-k ${root} -h ''`,
        '-w',
        'start',
      ]);
      started = true;
      const url = (role) =>
        `postgresql://${role}@localhost/postgres?host=${encodeURIComponent(root)}`;
      async function connect(role) {
        const c = new pg.Client({ connectionString: url(role) });
        await c.connect();
        clients.push(c);
        return c;
      }
      const admin = await connect('workout_admin');
      await admin.query(
        'CREATE ROLE inventory_owner LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE',
      );
      await admin.query(
        'CREATE ROLE inventory_runtime LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE',
      );
      await admin.query('ALTER DATABASE postgres OWNER TO inventory_owner');
      await admin.query('ALTER SCHEMA public OWNER TO inventory_owner');
      await migrate(url('inventory_owner'), 100);
      await grantOperations(url('inventory_owner'), 'inventory_runtime');
      const writer = await connect('inventory_owner'),
        holder = await connect('inventory_owner'),
        imported = await connect('inventory_owner'),
        runtime = await connect('inventory_runtime');
      assert.deepEqual(
        (
          await writer.query(
            "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN ('inventory_owner','inventory_runtime')",
          )
        ).rows,
        [
          { rolsuper: false, rolbypassrls: false },
          { rolsuper: false, rolbypassrls: false },
        ],
      );
      const owners = [];
      async function tenant(c, id, action) {
        await c.query('BEGIN');
        try {
          await c.query("SELECT set_config('app.athlete_id',$1,true)", [id]);
          const result = await action(c);
          await c.query('COMMIT');
          return result;
        } catch (e) {
          await c.query('ROLLBACK');
          throw e;
        }
      }
      async function account() {
        const id = randomUUID();
        owners.push(id);
        await writer.query(
          'INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1,$2,$3)',
          [id, 'https://synthetic.invalid', id],
        );
        return id;
      }
      async function capture(extra = {}, before) {
        return withSchema100InventorySnapshot(
          { exporter: holder, importer: imported },
          async (snapshotContext) => {
            if (before) await before();
            return captureSchema100RowInventory({
              snapshotContext,
              candidateBytes,
              expectedCandidateSha256,
              expectedCatalogSha256,
              candidateOwnerRole: 'candidate_owner',
              expectedOwners: owners,
              hmacKey: Buffer.alloc(32, 7),
              ...extra,
            });
          },
        );
      }
      await t.test(
        'normal migrations001–100 exact candidate and explicit empty roster',
        async () => {
          const result = await capture();
          assert.equal(result.complete, false);
          assert.equal(result.admissionAllowed, false);
          assert.equal(result.ownerCount, 0);
          assert.ok(result.gaps.includes('SCHEMA100_CANDIDATE_UNREVIEWED'));
        },
      );
      const absent = await account();
      await t.test(
        'app absent is distinct from revision0; literal zero sets retained',
        async () => {
          const result = await capture();
          assert.equal(result.ownerCount, 1);
          assert.deepEqual(result.owners[0].app, { state: 'absent' });
          for (const item of Object.values(result.owners[0].inventories))
            assert.equal(item.count, 0);
        },
      );
      const athlete = await account(),
        foreign = await account();
      const evidence = randomUUID(),
        runId = randomUUID(),
        candidate = randomUUID(),
        integrated = randomUUID(),
        plan = randomUUID(),
        thread = randomUUID(),
        decision = randomUUID(),
        proposal = randomUUID();
      await tenant(writer, athlete, async (c) => {
        // Minimal SQL lineage exercises actual capture triggers; this is not a complete plan approval.
        await c.query("INSERT INTO consent VALUES($1,'app',true,1)", [athlete]);
        await c.query(
          "INSERT INTO plan_snapshot(athlete_id,id,version,draft) VALUES($1,$2,1,'{}')",
          [athlete, plan],
        );
        await c.query(
          `INSERT INTO coaching_thread(athlete_id,id,plan_version_id,title,scope,revision) VALUES($1,$2,$3,'Synthetic','{"kind":"phase","targetId":"synthetic"}',1)`,
          [athlete, thread, plan],
        );
        await c.query(
          "INSERT INTO core_evidence_snapshot(athlete_id,id,thread_id,created_at,body) VALUES($1,$2,$3,clock_timestamp(),'{}')",
          [athlete, evidence, thread],
        );
        await c.query(
          "INSERT INTO coaching_run(athlete_id,id,thread_id,evidence_snapshot_id,conversation_revision,policy,source,basis) VALUES($1,$2,$3,$4,1,'{}','{}','{}')",
          [athlete, runId, thread, evidence],
        );
        await c.query(
          "INSERT INTO coaching_decision(athlete_id,id,run_id,body) VALUES($1,$2,$3,'{}')",
          [athlete, decision, runId],
        );
        await c.query(
          "INSERT INTO coaching_proposal(athlete_id,id,decision_id,body) VALUES($1,$2,$3,'{}')",
          [athlete, proposal, decision],
        );
        await c.query(
          "INSERT INTO coaching_candidate(athlete_id,id,decision_id,proposal_id,digest,body) VALUES($1,$2,$3,$4,$5,'{}')",
          [athlete, candidate, decision, proposal, 'a'.repeat(64)],
        );
        await c.query(
          'INSERT INTO integrated_candidate_v4(athlete_id,id,proposal_id,digest,body,created_at) VALUES($1,$2,$3,$4,$5,clock_timestamp())',
          [
            athlete,
            integrated,
            randomUUID(),
            'b'.repeat(64),
            { basis: { evidenceSnapshotId: evidence } },
          ],
        );
        const canonical = JSON.stringify({
          operation: 'training_candidate_approve',
          candidateId: candidate,
          confirmed: true,
        });
        const receipt = 'coaching:candidate:approve:' + sha('synthetic');
        await c.query('INSERT INTO command_receipt VALUES($1,$2,$3,$4)', [
          athlete,
          receipt,
          { requestHash: sha(canonical) },
          { versionId: plan },
        ]);
        await c.query('SELECT record_approval_app_binding($1,$2,$3)', [
          receipt,
          candidate,
          canonical,
        ]);
        await c.query(
          "UPDATE consent SET granted=false,revision=2 WHERE athlete_id=$1 AND kind='app'",
          [athlete],
        );
      });
      let activeTag;
      await t.test(
        'withdraw2/regrant3 retains exact five original bindings and receipts',
        async () => {
          const falseResult = await capture();
          const active = falseResult.owners.find((x) => x.app.state === 'present');
          activeTag = active.ownerTag;
          assert.deepEqual(active.app, { state: 'present', revision: 2, granted: false });
          for (const name of ['evidence', 'run', 'candidate', 'integrated_candidate', 'approval'])
            assert.equal(active.inventories[`${name}_app_admission_binding`].count, 1);
          assert.equal(active.inventories.command_receipt.count, 1);
          await tenant(writer, athlete, (c) =>
            c.query(
              "UPDATE consent SET granted=true,revision=3 WHERE athlete_id=$1 AND kind='app'",
              [athlete],
            ),
          );
          const after = (await capture()).owners.find((x) => x.ownerTag === activeTag);
          assert.deepEqual(after.app, { state: 'present', revision: 3, granted: true });
          for (const name of ['evidence', 'run', 'candidate', 'integrated_candidate', 'approval']) {
            assert.deepEqual(
              after.inventories[`${name}_app_admission_binding`],
              active.inventories[`${name}_app_admission_binding`],
            );
          }
          assert.deepEqual(after.inventories.command_receipt, active.inventories.command_receipt);
          assert.equal(
            (
              await tenant(writer, athlete, (c) =>
                c.query('SELECT app_revision FROM evidence_app_admission_binding'),
              )
            ).rows[0].app_revision,
            1,
          );
        },
      );
      await t.test('foreign tenant FORCE RLS and runtime global receipt denial', async () => {
        assert.equal(
          (
            await tenant(runtime, foreign, (c) =>
              c.query('SELECT * FROM evidence_app_admission_binding'),
            )
          ).rowCount,
          0,
        );
        await assert.rejects(runtime.query('SELECT * FROM restore_app_consent_replay_receipt'), {
          code: '42501',
        });
        await assert.rejects(
          withSchema100InventorySnapshot(
            { exporter: holder, importer: runtime },
            (snapshotContext) =>
              captureSchema100RowInventory({
                snapshotContext,
                candidateBytes,
                expectedCandidateSha256,
                expectedCatalogSha256,
                candidateOwnerRole: 'candidate_owner',
                expectedOwners: owners,
                hmacKey: Buffer.alloc(32, 7),
              }),
          ),
          failure,
        );
      });
      await t.test('independently imported snapshot excludes a later committed head', async () => {
        const old = await capture({}, () =>
          tenant(writer, athlete, (c) =>
            c.query(
              "UPDATE consent SET granted=false,revision=4 WHERE athlete_id=$1 AND kind='app'",
              [athlete],
            ),
          ),
        );
        assert.equal(old.owners.find((x) => x.ownerTag === activeTag).app.revision, 3);
        assert.equal(
          (await capture()).owners.find((x) => x.ownerTag === activeTag).app.revision,
          4,
        );
      });
      await t.test(
        'owner-only exact replay receipt survives erase; roster records erased owner',
        async () => {
          const event = (
            await writer.query(
              `SELECT event_id,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at FROM restore_suppression_event WHERE athlete_id=$1 AND kind='app_consent_transition' AND consent_revision=1`,
              [athlete],
            )
          ).rows[0];
          await tenant(writer, athlete, (c) =>
            c.query('SELECT replay_app_consent_transition_exact($1,$2,$3,$4,$5,$6,$7)', [
              athlete,
              event.event_id,
              event.occurred_at,
              null,
              null,
              1,
              true,
            ]),
          );
          await tenant(writer, athlete, (c) => c.query('SELECT erase_account($1)', [athlete]));
          const result = await capture();
          const erased = result.owners.find((x) => x.ownerTag === activeTag);
          assert.equal(erased.accountPresent, false);
          assert.deepEqual(erased.app, { state: 'absent' });
          assert.equal(erased.inventories.restore_app_consent_replay_receipt.count, 1);
          assert.equal(erased.inventories.tenant_erasure.count, 1);
          assert.equal(erased.inventories.command_receipt.count, 0);
          for (const name of ['evidence', 'run', 'candidate', 'integrated_candidate', 'approval'])
            assert.equal(erased.inventories[`${name}_app_admission_binding`].count, 0);
          const serialized = JSON.stringify(result);
          for (const value of [athlete, foreign, absent, evidence, runId, candidate, integrated])
            assert.equal(serialized.includes(value), false);
        },
      );
      await t.test('no forged snapshot context or candidate/hash/owner omission', async () => {
        await assert.rejects(
          capture({ snapshotContext: { kind: 'schema100_imported_snapshot' } }),
          failure,
        );
        await assert.rejects(capture({ expectedOwners: owners.slice(1) }), failure);
        await assert.rejects(capture({ expectedCatalogSha256: '0'.repeat(64) }), failure);
      });
      await t.test('row cap1001 rejects before row fetch', async () => {
        await tenant(writer, foreign, (c) =>
          c.query(
            "INSERT INTO command_receipt SELECT $1,'cap-'||n,'{}','{}' FROM generate_series(1,1001)n",
            [foreign],
          ),
        );
        await assert.rejects(capture(), failure);
        await tenant(writer, foreign, (c) =>
          c.query('DELETE FROM command_receipt WHERE athlete_id=$1', [foreign]),
        );
      });
      await t.test('byte preflight rejects oversized private receipt before decoding', async () => {
        await tenant(writer, foreign, (c) =>
          c.query(
            "INSERT INTO command_receipt VALUES($1,'large',jsonb_build_object('private',repeat('x',1100000)),'{}')",
            [foreign],
          ),
        );
        await assert.rejects(capture(), failure);
        await tenant(writer, foreign, (c) =>
          c.query('DELETE FROM command_receipt WHERE athlete_id=$1', [foreign]),
        );
      });
      await t.test(
        'global byte budget and owner roster1001 reject before private row fetch',
        async () => {
          const originalQuery = imported.query.bind(imported);
          let fetched = 0;
          imported.query = (sql, ...args) => {
            if (typeof sql === 'string' && sql.includes('AS row_json')) fetched++;
            return originalQuery(sql, ...args);
          };
          try {
            await tenant(writer, foreign, (c) =>
              c.query(
                "INSERT INTO command_receipt SELECT $1,'bytes-'||n,jsonb_build_object('private',repeat('x',950000)),'{}' FROM generate_series(1,9)n",
                [foreign],
              ),
            );
            await assert.rejects(capture(), failure);
            assert.equal(fetched, 0);
            await tenant(writer, foreign, (c) =>
              c.query('DELETE FROM command_receipt WHERE athlete_id=$1', [foreign]),
            );
            await writer.query(
              "INSERT INTO identity_private.account(athlete_id,issuer,subject) SELECT gen_random_uuid(),'https://cap.synthetic.invalid',n::text FROM generate_series(1,1001)n",
            );
            await assert.rejects(capture(), failure);
            assert.equal(fetched, 0);
            await writer.query(
              "DELETE FROM identity_private.account WHERE issuer='https://cap.synthetic.invalid'",
            );
          } finally {
            imported.query = originalQuery;
          }
        },
      );
      await t.test(
        'exporter must also be plain live owner and handle expires after transaction',
        async () => {
          await assert.rejects(
            withSchema100InventorySnapshot({ exporter: admin, importer: imported }, () => {}),
            failure,
          );
          let expired;
          await withSchema100InventorySnapshot(
            { exporter: holder, importer: imported },
            (handle) => {
              expired = handle;
            },
          );
          await assert.rejects(capture({ snapshotContext: expired }), failure);
        },
      );
      await t.test('catalog drift fails closed instead of learning a new pin', async () => {
        await writer.query('CREATE TABLE public.synthetic_inventory_drift(id integer)');
        await assert.rejects(capture(), failure);
        await writer.query('DROP TABLE public.synthetic_inventory_drift');
      });
    } finally {
      await Promise.allSettled(clients.map((c) => c.end()));
      if (started) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
      rmSync(root, { recursive: true, force: true });
      assert.equal(existsSync(root), false);
    }
  },
);
