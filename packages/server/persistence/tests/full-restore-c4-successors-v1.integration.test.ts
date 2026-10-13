import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as baseline from '../src/migrate.js';
import { installCurrentRuntimeV9 } from '../src/current-runtime-installation-v9.js';
import {
  captureFullRestoreStructureV1,
  createFullRestoreStructureComparatorV1,
  FullRestoreStructureErrorV1,
} from '../src/full-restore-expected-structure-v1.js';
import {
  applyFullRestoreSequenceHighWaterV1,
  captureFullRestoreSequenceHighWaterV1,
  FullRestoreSequenceHighWaterErrorV1,
} from '../src/full-restore-sequence-high-water-v1.js';
import {
  compareDumpCorrespondenceV1,
  parsePlainDataDumpV1,
  runSnapshotDataDumpV1,
} from '../src/full-restore-dump-correspondence-v1.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Metadata and synthetic sequence/account rows only; no health or personal data.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
// pg_dump 17 client, as other restore suites resolve their PostgreSQL binaries by default.
const pgDumpPath = z
  .string()
  .min(1)
  .parse(process.env['TEST_PG_DUMP_PATH'] ?? '/opt/homebrew/opt/postgresql@17/bin/pg_dump');
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const owner = `c4_successor_owner_${suffix}`;
const source = `c4_successor_source_${suffix}`;
const target = `c4_successor_target_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const created: string[] = [];
const EXPECTED_SHA256 = '1d26190fb4c0ea29e111675b224d6cd73097df1c8ee622e63186de3b897cd949';
const comparator = createFullRestoreStructureComparatorV1({
  expectedBytes: new Uint8Array(
    readFileSync(
      new URL('../src/full-restore-expected-structure-v1/expected-structure.json', import.meta.url),
    ),
  ),
  expectedSha256: EXPECTED_SHA256,
});
const relations = comparator.relations;

function url(database: string, role = owner) {
  const value = new URL(adminUrl);
  value.pathname = `/${database}`;
  if (role !== 'admin') {
    value.username = role;
    value.password = 'isolated';
  }
  return value.toString();
}
async function session<T>(database: string, role: string, apply: (tx: PoolClient) => Promise<T>) {
  const pool = new Pool({ connectionString: url(database, role), max: 1 });
  const tx = await pool.connect();
  try {
    return await apply(tx);
  } finally {
    tx.release();
    await pool.end();
  }
}
async function readOnly<T>(database: string, role: string, apply: (tx: PoolClient) => Promise<T>) {
  return session(database, role, async (tx) => {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      return await apply(tx);
    } finally {
      await tx.query('ROLLBACK');
    }
  });
}
const capture = (database = source) =>
  readOnly(database, owner, (tx) => captureFullRestoreStructureV1(tx, relations));
async function mutation(sql: string, undo: string) {
  await session(source, owner, (tx) => tx.query(sql));
  try {
    return comparator.compare(await capture());
  } finally {
    await session(source, owner, (tx) => tx.query(undo));
  }
}

beforeAll(async () => {
  await admin.query(
    `CREATE ROLE "${owner}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
  );
  for (const database of [source, target]) {
    await admin.query(`CREATE DATABASE "${database}" OWNER "${owner}"`);
    created.push(database);
    await session(database, 'admin', (tx) => tx.query(`ALTER SCHEMA public OWNER TO "${owner}"`));
    await baseline.migrate(url(database), 107);
    await installCurrentRuntimeV9(url(database));
  }
}, 300000);
afterAll(async () => {
  for (const database of created.reverse()) await dropIsolatedDatabase(admin, database);
  await admin.query(`DROP ROLE IF EXISTS "${owner}"`);
  await admin.end();
});

describe('C4 independent expected structure (real PostgreSQL)', () => {
  it('two fresh plain-owner installs match the committed census independent of OIDs and owner name', async () => {
    const [a, b] = [await capture(source), await capture(target)];
    for (const result of [comparator.compare(a), comparator.compare(b)]) {
      expect(result.differences).toEqual([]);
      expect(result).toMatchObject({ matched: true, relationCount: 239, authority: 'none' });
    }
  }, 120000);

  it('rejects CHECK, default, nullability, extra column and shadowed-function drift', async () => {
    const check = await mutation(
      `ALTER TABLE public.ai_settings_revision DROP CONSTRAINT ai_settings_revision_check,
        ADD CONSTRAINT ai_settings_revision_check CHECK (num_nonnulls(default_provider_id, default_model_id) = ANY (ARRAY[0, 1, 2]))`,
      `ALTER TABLE public.ai_settings_revision DROP CONSTRAINT ai_settings_revision_check,
        ADD CONSTRAINT ai_settings_revision_check CHECK (num_nonnulls(default_provider_id, default_model_id) = ANY (ARRAY[0, 2]))`,
    );
    expect(check.matched).toBe(false);
    expect(check.differences.some((d) => /\/constraints\/\d+\/expression$/.test(d))).toBe(true);

    const shadow = await mutation(
      `CREATE FUNCTION public.num_nonnulls(text,text) RETURNS integer LANGUAGE sql IMMUTABLE
         AS $$ SELECT (($1 IS NOT NULL)::int + ($2 IS NOT NULL)::int) $$;
       ALTER TABLE public.ai_settings_revision DROP CONSTRAINT ai_settings_revision_check,
        ADD CONSTRAINT ai_settings_revision_check CHECK (public.num_nonnulls(default_provider_id, default_model_id) = ANY (ARRAY[0, 2]))`,
      `ALTER TABLE public.ai_settings_revision DROP CONSTRAINT ai_settings_revision_check,
        ADD CONSTRAINT ai_settings_revision_check CHECK (pg_catalog.num_nonnulls(default_provider_id, default_model_id) = ANY (ARRAY[0, 2]));
       DROP FUNCTION public.num_nonnulls(text,text)`,
    );
    expect(shadow.matched).toBe(false);
    expect(shadow.differences.some((d) => /\/constraints\/\d+\/expression$/.test(d))).toBe(true);

    const defaults = await mutation(
      `ALTER TABLE identity_private.session ALTER COLUMN kind SET DEFAULT 'native'`,
      `ALTER TABLE identity_private.session ALTER COLUMN kind SET DEFAULT 'browser'`,
    );
    expect(defaults.differences.some((d) => /\/columns\/\d+\/default$/.test(d))).toBe(true);

    const nullable = await mutation(
      'ALTER TABLE identity_private.session ALTER COLUMN provider_session_id SET NOT NULL',
      'ALTER TABLE identity_private.session ALTER COLUMN provider_session_id DROP NOT NULL',
    );
    expect(nullable.differences.some((d) => /\/columns\/\d+\/notNull$/.test(d))).toBe(true);

    const extra = await mutation(
      'ALTER TABLE identity_private.account ADD COLUMN extra_c4 text',
      'ALTER TABLE identity_private.account DROP COLUMN extra_c4',
    );
    expect(extra.differences.some((d) => /\/columns:length$/.test(d))).toBe(true);
    // The undo leaves a dropped attribute behind, which is itself a structural difference.
    const afterDrop = comparator.compare(await capture());
    expect(afterDrop.differences.some((d) => d.endsWith('/droppedColumns'))).toBe(true);
  }, 180000);

  it('binds trigger routine body and security attributes, not only the signature (P27-p2a-3)', async () => {
    const fn = 'public.activity_track_cleanup_on_delete()';
    const routine = /^\/relations\/\d+\/triggers\/\d+\/routine\/(\w+)(?:\/\d+)?$/;
    // The earlier drift test leaves a dropped attribute on the source; only new differences count.
    const baseline = comparator.compare(await capture()).differences;
    const fields = (differences: readonly string[]) =>
      [
        ...new Set(
          differences
            .filter((d) => !baseline.includes(d))
            .map((d) => routine.exec(d)?.[1] ?? `other:${d}`),
        ),
      ].sort();
    const original = await session(
      source,
      owner,
      async (tx) =>
        (await tx.query(`SELECT pg_catalog.pg_get_functiondef('${fn}'::regprocedure) AS d`))
          .rows[0]?.['d'] as string,
    );
    expect(original).toContain('SECURITY DEFINER');
    // Same signature, same attributes, body changed only by an inert comment.
    const replaced = original.replace(/\$function\$\n/, '$function$\n-- c4 drift\n');
    expect(replaced).not.toBe(original);
    const body = await mutation(replaced, original);
    expect(body.matched).toBe(false);
    expect(fields(body.differences)).toEqual(['bodySha256']);

    const invoker = await mutation(
      `ALTER FUNCTION ${fn} SECURITY INVOKER`,
      `ALTER FUNCTION ${fn} SECURITY DEFINER`,
    );
    expect(fields(invoker.differences)).toEqual(['securityDefiner']);

    const searchPath = await mutation(
      `ALTER FUNCTION ${fn} SET search_path = public, pg_catalog`,
      `ALTER FUNCTION ${fn} SET search_path = pg_catalog`,
    );
    expect(fields(searchPath.differences)).toEqual(['config']);

    const volatility = await mutation(
      `ALTER FUNCTION ${fn} STABLE`,
      `ALTER FUNCTION ${fn} VOLATILE`,
    );
    expect(fields(volatility.differences)).toEqual(['volatility']);

    // Every undo restored the prior census exactly.
    expect(comparator.compare(await capture()).differences).toEqual(baseline);
  }, 180000);

  it('requires a REPEATABLE READ READ ONLY transaction and every registered relation', async () => {
    await expect(
      session(source, owner, (tx) => captureFullRestoreStructureV1(tx, relations)),
    ).rejects.toMatchObject({ code: 'STRUCTURE_TRANSACTION_INVALID' });
    await expect(
      readOnly(target, owner, (tx) =>
        captureFullRestoreStructureV1(tx, [
          ...relations,
          { schema: 'public', relation: 'zz_absent' },
        ]),
      ),
    ).rejects.toBeInstanceOf(FullRestoreStructureErrorV1);
  }, 60000);
});

describe('budget journal sequence high-water (real PostgreSQL)', () => {
  const sequence = 'public.openai_budget_journal_sequence_id_seq';
  it('captures a non-transactional floor and raises the target to it, never lowering', async () => {
    const empty = await readOnly(target, owner, (tx) => captureFullRestoreSequenceHighWaterV1(tx));
    expect(empty).toMatchObject({ lastValue: '1', isCalled: false, ownerColumnMax: null });
    await session(target, owner, (tx) =>
      tx.query(`SELECT nextval('${sequence}'), nextval('${sequence}'), nextval('${sequence}')`),
    );
    const observed = await readOnly(target, owner, async (tx) => {
      const first = await captureFullRestoreSequenceHighWaterV1(tx);
      // Allocation by another session after the snapshot is visible: sequence state is not MVCC.
      await session(target, owner, (other) => other.query(`SELECT nextval('${sequence}')`));
      const second = await captureFullRestoreSequenceHighWaterV1(tx);
      return [first, second];
    });
    expect(observed.map((o) => [o.lastValue, o.isCalled])).toEqual([
      ['3', true],
      ['4', true],
    ]);
    const facts = observed[1];
    if (!facts) throw new Error('fixture');
    const applied = await session(source, owner, async (tx) => {
      await tx.query('BEGIN');
      try {
        return await applyFullRestoreSequenceHighWaterV1(tx, facts);
      } finally {
        await tx.query('COMMIT');
      }
    });
    expect(applied).toEqual({
      schema: 'public',
      relation: 'openai_budget_journal_sequence_id_seq',
      lastValue: '4',
      isCalled: true,
      ownerColumnMax: null,
    });
    await session(source, owner, (tx) => tx.query(`SELECT setval('${sequence}', 10, true)`));
    await expect(
      session(source, owner, async (tx) => {
        await tx.query('BEGIN');
        try {
          return await applyFullRestoreSequenceHighWaterV1(tx, facts);
        } finally {
          await tx.query('ROLLBACK');
        }
      }),
    ).rejects.toMatchObject({ code: 'SEQUENCE_TARGET_AHEAD' });
    await expect(
      readOnly(target, 'admin', (tx) => captureFullRestoreSequenceHighWaterV1(tx)),
    ).rejects.toBeInstanceOf(FullRestoreSequenceHighWaterErrorV1);
    await expect(
      session(target, owner, (tx) => captureFullRestoreSequenceHighWaterV1(tx)),
    ).rejects.toMatchObject({ code: 'SEQUENCE_TRANSACTION_INVALID' });
  }, 120000);
});

describe('pg_dump snapshot correspondence (real PostgreSQL)', () => {
  const columns = new Map(
    (
      JSON.parse(
        readFileSync(
          new URL(
            '../src/full-restore-expected-structure-v1/expected-structure.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ) as { relations: { schema: string; relation: string; columns: { name: string }[] }[] }
    ).relations.map((r) => [`${r.schema}.${r.relation}`, r.columns.map((c) => c.name)]),
  );
  const connection = () => {
    const value = new URL(adminUrl);
    const host = value.searchParams.get('host') ?? value.hostname;
    const port = value.searchParams.get('port') ?? value.port;
    return {
      host,
      ...(port ? { port: Number(port) } : {}),
      user: decodeURIComponent(value.username),
      // Password-authenticated servers (the pinned image over TCP) need it; env only.
      ...(value.password ? { password: decodeURIComponent(value.password) } : {}),
      database: target,
    };
  };
  async function snapshotFacts(tx: PoolClient) {
    const snapshot = (await tx.query('SELECT pg_export_snapshot() AS id')).rows[0]?.[
      'id'
    ] as string;
    const counted = [];
    for (const r of relations) {
      const count = await tx.query(`SELECT count(*)::int AS n FROM "${r.schema}"."${r.relation}"`);
      counted.push({
        schema: r.schema,
        relation: r.relation,
        columns: columns.get(`${r.schema}.${r.relation}`) ?? [],
        rowCount: count.rows[0]?.['n'] as number,
      });
    }
    const seq = await tx.query(
      'SELECT last_value::text AS v, is_called FROM public.openai_budget_journal_sequence_id_seq',
    );
    return {
      snapshot,
      expected: {
        relations: counted,
        sequences: [
          {
            schema: 'public',
            relation: 'openai_budget_journal_sequence_id_seq',
            lastValue: seq.rows[0]?.['v'] as string,
            isCalled: seq.rows[0]?.['is_called'] as boolean,
          },
        ],
      },
    };
  }
  it('a dump bound to the capture snapshot corresponds; a later snapshot does not', async () => {
    const limits = { maxBytes: 64 * 1024 * 1024, maxRelations: 1000 };
    const first = await readOnly(target, 'admin', async (tx) => {
      const facts = await snapshotFacts(tx);
      // Committed after the export: invisible to the snapshot-bound dump.
      await session(target, 'admin', (other) =>
        other.query(
          "INSERT INTO identity_private.account(issuer,subject) VALUES ('https://synthetic.invalid','c4-dump')",
        ),
      );
      const dump = await runSnapshotDataDumpV1({
        pgDumpPath,
        snapshotId: facts.snapshot,
        connection: connection(),
        maxBytes: limits.maxBytes,
        timeoutMs: 120000,
      });
      return { facts, dump };
    });
    const parsed = parsePlainDataDumpV1(first.dump, limits);
    expect(parsed.relations).toHaveLength(239);
    const result = compareDumpCorrespondenceV1(parsed, first.facts.expected);
    expect(result.differences).toEqual([]);
    expect(result).toMatchObject({ corresponds: true, rowContent: 'not_compared' });

    const later = await readOnly(target, 'admin', async (tx) => {
      const facts = await snapshotFacts(tx);
      return runSnapshotDataDumpV1({
        pgDumpPath,
        snapshotId: facts.snapshot,
        connection: connection(),
        maxBytes: limits.maxBytes,
        timeoutMs: 120000,
      });
    });
    const stale = compareDumpCorrespondenceV1(
      parsePlainDataDumpV1(later, limits),
      first.facts.expected,
    );
    expect(stale.corresponds).toBe(false);
    expect(stale.differences).toEqual(['identity_private.account:rowCount']);
  }, 240000);
});
