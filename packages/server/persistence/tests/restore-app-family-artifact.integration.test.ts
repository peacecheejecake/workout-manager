import { createHash, createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { migrate } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
import { stageVerifiedAppFamilyArtifactIn } from '../src/restore-app-family-stage.js';
import {
  appFamilyRowsSha256,
  prepareVerifiedAppFamilyArtifact,
  signAppFamilyArtifact,
  stageVerifiedAppFamilyArtifact,
  type AppFamilyArtifactBodyV1,
  type AppFamilyVerificationAuthority,
  type AppFamilyRow,
} from '../src/restore-app-family-artifact.js';
// Registered integration configuration, but this initial suite is unit crypto/parser
// acceptance. No PostgreSQL/staging/restore/admission success is claimed here.
const key = Buffer.alloc(32, 84),
  stamp = '2020-01-01T00:00:00.123456+00:00';
function fixture() {
  const ownerId = randomUUID();
  const rows: AppFamilyRow[] = [
    {
      ordinal: 1,
      relation: 'plan_snapshot',
      row: {
        athlete_id: ownerId,
        id: randomUUID(),
        version: 1,
        created_at: stamp,
        draft: {
          title: 'Synthetic',
          timezone: 'UTC',
          periods: [
            {
              id: 'season',
              parentId: null,
              level: 'season',
              title: 'season',
              startDate: '2080-01-01',
              endDateExclusive: '2080-02-01',
              timezone: 'UTC',
              intent: 'Synthetic',
              isPartial: false,
            },
          ],
          sessions: [],
        },
      },
      binding: null,
      absence: true,
      witness: null,
    },
  ];
  const body: AppFamilyArtifactBodyV1 = {
    artifactVersion: 1,
    sourceKeyId: 'synthetic-source',
    sourceKeyVersion: 1,
    purpose: 'owner_restore_app_family',
    schemaVersion: 100,
    targetSchemaVersion: 102,
    controlRevision: '1',
    targetIncarnation: randomUUID(),
    schemaHash: 'a'.repeat(64),
    targetNonce: randomUUID(),
    ownerId,
    proofHash: 'b'.repeat(64),
    expectedStateVersion: 1,
    count: rows.length,
    rowsSha256: appFamilyRowsSha256(rows),
    rows,
  };
  const { artifactVersion: _, rows: __, ...expected } = body;
  const authority: AppFamilyVerificationAuthority = { expected, resolveSourceKey: () => key };
  return { body, authority };
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object')
    return (
      '{' +
      Object.entries(v)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => JSON.stringify(k) + ':' + canonical(x))
        .join(',') +
      '}'
    );
  return JSON.stringify(v);
}
// Malicious source-signed fixtures intentionally bypass signing-side preflight.
function malicious(body: unknown) {
  return Buffer.from(
    canonical({
      body,
      hmacSha256: createHmac('sha256', key)
        .update('wm-owner-restore-app-family-v1\0')
        .update(canonical(body))
        .digest('hex'),
    }),
  );
}
function verifyChanged(body: AppFamilyArtifactBodyV1, authority: AppFamilyVerificationAuthority) {
  body.rowsSha256 = createHash('sha256').update(canonical(body.rows)).digest('hex');
  body.count = body.rows.length;
  return prepareVerifiedAppFamilyArtifact(malicious(body), {
    ...authority,
    expected: { ...authority.expected, count: body.count, rowsSha256: body.rowsSha256 },
  });
}
describe('app family artifact unit boundary (no actual PG)', () => {
  it('preserves original row and microsecond timestamp through immutable stage port without admission', async () => {
    const { body, authority } = fixture();
    const bytes = signAppFamilyArtifact(body, key);
    const handle = prepareVerifiedAppFamilyArtifact(bytes, authority);
    let called = 0;
    await stageVerifiedAppFamilyArtifact(
      {
        async computeSqlInventory() {
          return {
            canonicalRowsSha256: body.rowsSha256,
            count: 1,
            sqlInventorySha256: 'c'.repeat(64),
            rows: [{ ordinal: 1, rowSha256: 'd'.repeat(64), tupleSha256: 'e'.repeat(64) }],
          };
        },
        async stageVerifiedFamily(input) {
          called++;
          expect(input.rows).toEqual(body.rows);
          expect(input.rows[0]?.row.created_at).toBe(stamp);
          expect(input.identity).toEqual(authority.expected);
          expect(input.admissionAllowed).toBe(false);
          expect(Object.isFrozen(input.rows[0]?.row)).toBe(true);
        },
      },
      handle,
    );
    expect(called).toBe(1);
    expect(handle.admissionAllowed).toBe(false);
  });
  it('rejects copied or serialized opaque handle before any port call', async () => {
    const { body, authority } = fixture();
    const handle = prepareVerifiedAppFamilyArtifact(signAppFamilyArtifact(body, key), authority);
    let calls = 0;
    const port = {
      async computeSqlInventory() {
        calls++;
        return null;
      },
      async stageVerifiedFamily() {
        calls++;
      },
    };
    await expect(stageVerifiedAppFamilyArtifact(port, { ...handle })).rejects.toThrow(
      'INVALID_APP_FAMILY_ARTIFACT',
    );
    await expect(
      stageVerifiedAppFamilyArtifact(port, JSON.parse(JSON.stringify(handle))),
    ).rejects.toThrow('INVALID_APP_FAMILY_ARTIFACT');
    expect(calls).toBe(0);
  });
  it.each([
    'controlRevision',
    'targetIncarnation',
    'targetSchemaVersion',
    'schemaHash',
    'targetNonce',
    'ownerId',
    'proofHash',
    'expectedStateVersion',
    'sourceKeyVersion',
    'rowsSha256',
    'count',
  ] as const)('requires independent expected %s', (field) => {
    const { body, authority } = fixture();
    const bytes = signAppFamilyArtifact(body, key);
    const expected = {
      ...authority.expected,
      [field]: typeof authority.expected[field] === 'number' ? 999 : 'c'.repeat(64),
    };
    expect(() => prepareVerifiedAppFamilyArtifact(bytes, { ...authority, expected })).toThrow(
      'INVALID_APP_FAMILY_ARTIFACT',
    );
  });
  it('rejects unknown key/version, wrong purpose, bad MAC, missing baseline identity and ambiguous bytes', () => {
    const { body, authority } = fixture();
    const bytes = signAppFamilyArtifact(body, key);
    expect(() =>
      prepareVerifiedAppFamilyArtifact(bytes, {
        ...authority,
        resolveSourceKey: () => Buffer.alloc(32, 85),
      }),
    ).toThrow();
    for (const changed of [
      { ...body, artifactVersion: 2 },
      { ...body, purpose: 'generation_open' },
      { ...body, proofHash: null },
      { ...body, extra: true },
    ])
      expect(() => prepareVerifiedAppFamilyArtifact(malicious(changed), authority)).toThrow();
    expect(() =>
      prepareVerifiedAppFamilyArtifact(Buffer.from(' ' + bytes.toString()), authority),
    ).toThrow();
    expect(() =>
      prepareVerifiedAppFamilyArtifact(
        Buffer.from('{"body":null,"body":null,"hmacSha256":"' + 'a'.repeat(64) + '"}'),
        authority,
      ),
    ).toThrow();
  });
  it.each([
    'unknown_table',
    'unknown_column',
    'foreign',
    'duplicate',
    'absence',
    'bad_timestamp',
    'unknown_binding_key',
  ])('rejects signed %s row mutation', (kind) => {
    const { body, authority } = fixture();
    const row = body.rows[0];
    if (!row) throw new Error('fixture');
    if (kind === 'unknown_table') Object.assign(row, { relation: 'consent' });
    if (kind === 'unknown_column') row.row.extra = true;
    if (kind === 'foreign') row.row.athlete_id = randomUUID();
    if (kind === 'duplicate') body.rows.push({ ...row, ordinal: 2 });
    if (kind === 'absence') row.absence = false;
    if (kind === 'bad_timestamp') row.row.created_at = '2020-01-01';
    if (kind === 'unknown_binding_key') row.binding = { extra: true };
    // Digest is independently re-pinned for semantic rejection cases.
    try {
      body.rowsSha256 = appFamilyRowsSha256(body.rows);
    } catch {
      expect(() => prepareVerifiedAppFamilyArtifact(malicious(body), authority)).toThrow();
      return;
    }
    body.count = body.rows.length;
    const expected = { ...authority.expected, rowsSha256: body.rowsSha256, count: body.count };
    expect(() =>
      prepareVerifiedAppFamilyArtifact(malicious(body), { ...authority, expected }),
    ).toThrow();
  });
  it('rejects truncated, deep, invalid UTF8 and cap+1 raw bytes before decode', () => {
    const { body, authority } = fixture();
    const bytes = signAppFamilyArtifact(body, key);
    for (const raw of [
      bytes.subarray(0, bytes.length - 1),
      Buffer.from('['.repeat(65) + '0' + ']'.repeat(65)),
      Buffer.from([255]),
      Buffer.alloc(16 * 1024 * 1024 + 65537),
    ])
      expect(() => prepareVerifiedAppFamilyArtifact(raw, authority)).toThrow();
  });
  it('rejects count33 and row4MiB+1 and total16MiB+1 signed artifacts', () => {
    const { body, authority } = fixture();
    const first = body.rows[0];
    if (!first) throw new Error('fixture');
    const count33 = {
      ...body,
      count: 33,
      rows: Array.from({ length: 33 }, (_, i) => ({ ...first, ordinal: i + 1 })),
    };
    expect(() => prepareVerifiedAppFamilyArtifact(malicious(count33), authority)).toThrow();
    const huge = {
      ...body,
      rows: [
        {
          ...first,
          row: { ...first.row, draft: { ...first.row, title: 'x'.repeat(4 * 1024 * 1024 + 1) } },
        },
      ],
    };
    expect(() => verifyChanged(huge, authority)).toThrow();
    const rows = Array.from({ length: 5 }, (_, i) => ({
      ...first,
      ordinal: i + 1,
      row: {
        ...first.row,
        id: randomUUID(),
        draft: {
          title: 'x'.repeat(3500000),
          timezone: 'UTC',
          periods: [
            {
              id: 'season',
              parentId: null,
              level: 'season',
              title: 'season',
              startDate: '2080-01-01',
              endDateExclusive: '2080-02-01',
              timezone: 'UTC',
              intent: 'Synthetic',
              isPartial: false,
            },
          ],
          sessions: [],
        },
      },
    }));
    expect(() => verifyChanged({ ...body, rows, count: 5 }, authority)).toThrow();
  });
  it('rejects missing SQL digest mapping before any staging mutation', async () => {
    const { body, authority } = fixture();
    let writes = 0;
    const handle = prepareVerifiedAppFamilyArtifact(signAppFamilyArtifact(body, key), authority);
    await expect(
      stageVerifiedAppFamilyArtifact(
        {
          async computeSqlInventory() {
            return null;
          },
          async stageVerifiedFamily() {
            writes++;
          },
        },
        handle,
      ),
    ).rejects.toThrow();
    expect(writes).toBe(0);
  });
  it('rejects foreign canonical-to-SQL digest mapping before staging', async () => {
    const { body, authority } = fixture();
    let writes = 0;
    const handle = prepareVerifiedAppFamilyArtifact(signAppFamilyArtifact(body, key), authority);
    await expect(
      stageVerifiedAppFamilyArtifact(
        {
          async computeSqlInventory() {
            return {
              canonicalRowsSha256: 'f'.repeat(64),
              count: 1,
              sqlInventorySha256: 'c'.repeat(64),
              rows: [{ ordinal: 1, rowSha256: 'd'.repeat(64), tupleSha256: 'e'.repeat(64) }],
            };
          },
          async stageVerifiedFamily() {
            writes++;
          },
        },
        handle,
      ),
    ).rejects.toThrow();
    expect(writes).toBe(0);
  });
  it('preserves explicit legacy evidence absence and rejects fabricated binding epoch/foreign parent', () => {
    const { body, authority } = fixture();
    const plan = body.rows[0];
    if (!plan) throw new Error('fixture');
    const threadId = randomUUID(),
      evidenceId = randomUUID();
    body.rows.push(
      {
        ordinal: 2,
        relation: 'coaching_thread',
        row: {
          athlete_id: body.ownerId,
          id: threadId,
          plan_version_id: plan.row.id ?? null,
          title: 'Synthetic',
          scope: { kind: 'session', targetId: 'synthetic' },
          revision: 1,
          created_at: stamp,
          updated_at: stamp,
        },
        binding: null,
        absence: true,
        witness: null,
      },
      {
        ordinal: 3,
        relation: 'core_evidence_snapshot',
        row: {
          athlete_id: body.ownerId,
          id: evidenceId,
          thread_id: threadId,
          created_at: stamp,
          body: null,
          purged_reason: 'consent_withdrawn',
        },
        binding: null,
        absence: true,
        witness: null,
      },
    );
    const handle = verifyChanged(body, authority);
    expect(handle.admissionAllowed).toBe(false);
    const evidence = body.rows[2];
    if (!evidence) throw new Error('fixture');
    evidence.absence = false;
    evidence.binding = {
      athlete_id: body.ownerId,
      evidence_snapshot_id: evidenceId,
      binding_version: 1,
      app_revision: 1,
      captured_at: stamp,
    };
    expect(verifyChanged(body, authority).admissionAllowed).toBe(false);
    evidence.binding.app_revision = 0;
    expect(() => verifyChanged(body, authority)).toThrow();
    evidence.binding.app_revision = 1;
    evidence.row.thread_id = randomUUID();
    expect(() => verifyChanged(body, authority)).toThrow();
  });
  it('rejects signed history whose immutable original version is missing', () => {
    const { body, authority } = fixture();
    body.rows.push({
      ordinal: 2,
      relation: 'nutrition_plan_history',
      row: {
        athlete_id: body.ownerId,
        plan_id: randomUUID(),
        version_id: randomUUID(),
        approval_id: randomUUID(),
        action: 'candidate_approved',
        created_at: stamp,
      },
      binding: null,
      absence: true,
      witness: null,
    });
    expect(() => verifyChanged(body, authority)).toThrow();
  });
  it('allows exactly32 distinct immutable SQL100 plan rows with original versions', () => {
    const { body, authority } = fixture();
    const first = body.rows[0];
    if (!first) throw new Error('fixture');
    body.rows = Array.from({ length: 32 }, (_, i) => ({
      ...first,
      ordinal: i + 1,
      row: { ...first.row, id: randomUUID(), version: i + 1 },
    }));
    expect(verifyChanged(body, authority).admissionAllowed).toBe(false);
  });
  it('rejects a row byte cap with individually bounded JSON strings and matching authenticated digest', () => {
    const { body, authority } = fixture();
    body.rows = [
      {
        ordinal: 1,
        relation: 'command_receipt',
        row: {
          athlete_id: body.ownerId,
          idempotency_key: 'synthetic-cap',
          request: { padding: ['x'.repeat(2097152), 'y'.repeat(2097152)] },
          result: {},
        },
        binding: null,
        absence: true,
        witness: null,
      },
    ];
    expect(() => verifyChanged(body, authority)).toThrow();
  });
});

// Actual SQL102 transaction adapter acceptance uses a minimal SQL-shaped plan
// fixture. The separate loader suite owns real public training/integrated
// producers and authenticated tail replay; this section does not replace it.

describe('app family actual SQL102 owner transaction adapter (minimal SQL fixture)', () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10),
    ownerRole = 'family_stage_owner_' + suffix,
    runtimeRole = 'family_stage_runtime_' + suffix,
    name = 'family_stage_' + suffix;
  let admin: Pool, ownerPool: Pool, runtimePool: Pool;
  let prepared: ReturnType<typeof fixture>,
    handle: ReturnType<typeof prepareVerifiedAppFamilyArtifact>;
  function url(role: string) {
    const u = new URL(process.env['TEST_DATABASE_ADMIN_URL'] ?? '');
    u.pathname = '/' + name;
    u.username = role;
    u.password = 'isolated';
    return u.toString();
  }
  async function transaction<T>(fn: (client: PoolClient) => Promise<T>) {
    const c = await ownerPool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('timezone','UTC',true)");
      const value = await fn(c);
      await c.query('COMMIT');
      return value;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async function count() {
    return transaction(async (c) => {
      await c.query("SELECT set_config('app.athlete_id',$1,true)", [prepared.body.ownerId]);
      return Number(
        (
          await c.query('SELECT count(*)::int n FROM plan_snapshot WHERE athlete_id=$1', [
            prepared.body.ownerId,
          ])
        ).rows[0].n,
      );
    });
  }
  beforeAll(async () => {
    const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
    if (!adminUrl) throw new Error('Use isolated PostgreSQL integration harness');
    admin = new Pool({ connectionString: adminUrl });
    for (const role of [ownerRole, runtimeRole])
      await admin.query(
        `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
    await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
    await migrate(url(ownerRole), 102);
    ownerPool = new Pool({ connectionString: url(ownerRole) });
    runtimePool = new Pool({ connectionString: url(runtimeRole) });
    prepared = fixture();
    await transaction(async (c) => {
      await c.query(
        'INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1,$2,$3)',
        [prepared.body.ownerId, 'https://synthetic.test', randomUUID()],
      );
      const closed = (
        await c.query('SELECT public.close_restore_processing_exact(1,$1,$2,$3) AS state', [
          randomUUID(),
          prepared.body.targetNonce,
          prepared.body.targetIncarnation,
        ])
      ).rows[0].state;
      prepared.body.controlRevision = closed.localRevision;
      prepared.authority.expected.controlRevision = closed.localRevision;
      await c.query("INSERT INTO wm_app_load.target VALUES(true,$1,$2,'CLOSED',$3)", [
        prepared.body.targetNonce,
        prepared.body.schemaHash,
        prepared.body.expectedStateVersion,
      ]);
      const row = prepared.body.rows[0];
      if (!row) throw new Error('fixture');
      row.row = (
        await c.query(
          'SELECT to_jsonb(jsonb_populate_record(NULL::public.plan_snapshot,$1::jsonb)) AS row',
          [JSON.stringify(row.row)],
        )
      ).rows[0].row;
    });
    prepared.body.rowsSha256 = appFamilyRowsSha256(prepared.body.rows);
    prepared.authority.expected.rowsSha256 = prepared.body.rowsSha256;
    handle = prepareVerifiedAppFamilyArtifact(
      signAppFamilyArtifact(prepared.body, key),
      prepared.authority,
    );
  });
  afterAll(async () => {
    await ownerPool?.end();
    await runtimePool?.end();
    if (admin) {
      await dropIsolatedDatabase(admin, name);
      for (const role of [ownerRole, runtimeRole])
        await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await admin.end();
    }
  });
  it('pins exact SQL100 binding field rosters without invented child timestamps', async () => {
    for (const [name, expected] of Object.entries({
      run_app_admission_binding: [
        'athlete_id',
        'run_id',
        'evidence_snapshot_id',
        'binding_version',
      ],
      candidate_app_admission_binding: ['athlete_id', 'candidate_id', 'run_id', 'binding_version'],
      integrated_candidate_app_admission_binding: [
        'athlete_id',
        'candidate_id',
        'evidence_snapshot_id',
        'binding_version',
      ],
    })) {
      const columns = (
        await ownerPool.query(
          'SELECT attname FROM pg_attribute WHERE attrelid=to_regclass($1) AND attnum>0 AND NOT attisdropped ORDER BY attnum',
          ['public.' + name],
        )
      ).rows.map((r) => r.attname);
      expect(columns).toEqual(expected);
      expect(columns).not.toContain('created_at');
    }
  });
  it('rejects autocommit owner without creating descriptor or live rows', async () => {
    await expect(
      stageVerifiedAppFamilyArtifactIn(
        ownerPool,
        handle,
        prepared.authority.expected,
        randomUUID(),
      ),
    ).rejects.toThrow('APP_FAMILY_OWNER_TRANSACTION_REQUIRED');
    expect(await count()).toBe(0);
    expect(
      Number(
        (await ownerPool.query('SELECT count(*)::int n FROM wm_app_load.descriptor')).rows[0].n,
      ),
    ).toBe(0);
  });
  it('rejects runtime role without helper grants or any mutation', async () => {
    await expect(
      stageVerifiedAppFamilyArtifactIn(
        runtimePool,
        handle,
        prepared.authority.expected,
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    expect(await count()).toBe(0);
  });
  it('rejects independent expected tuple and copied handle before owner port writes', async () => {
    await expect(
      transaction((c) =>
        stageVerifiedAppFamilyArtifactIn(
          c,
          handle,
          { ...prepared.authority.expected, controlRevision: '999' },
          randomUUID(),
        ),
      ),
    ).rejects.toThrow('APP_FAMILY_STAGE_REJECTED');
    await expect(
      transaction((c) =>
        stageVerifiedAppFamilyArtifactIn(
          c,
          { ...handle },
          prepared.authority.expected,
          randomUUID(),
        ),
      ),
    ).rejects.toThrow('INVALID_APP_FAMILY_ARTIFACT');
    expect(await count()).toBe(0);
  });
  it('rejects foreign transaction account scope and stale private metadata', async () => {
    await expect(
      transaction(async (c) => {
        await c.query("SELECT set_config('app.athlete_id',$1,true)", [randomUUID()]);
        await stageVerifiedAppFamilyArtifactIn(
          c,
          handle,
          prepared.authority.expected,
          randomUUID(),
        );
      }),
    ).rejects.toThrow('APP_FAMILY_STAGE_REJECTED');
    await expect(
      transaction(async (c) => {
        await c.query('UPDATE wm_app_load.target SET state_version=state_version+1');
        await stageVerifiedAppFamilyArtifactIn(
          c,
          handle,
          prepared.authority.expected,
          randomUUID(),
        );
      }),
    ).rejects.toThrow();
    expect(await count()).toBe(0);
  });
  it('rejects target migration103 metadata for independently expected target102 before staging', async () => {
    await expect(
      transaction(async (c) => {
        await c.query('INSERT INTO public.schema_migrations(version,checksum) VALUES(103,$1)', [
          'f'.repeat(64),
        ]);
        await stageVerifiedAppFamilyArtifactIn(
          c,
          handle,
          prepared.authority.expected,
          randomUUID(),
        );
      }),
    ).rejects.toThrow('APP_FAMILY_TARGET_SCHEMA_MISMATCH');
    expect(await count()).toBe(0);
    expect(
      Number(
        (await ownerPool.query('SELECT max(version) n FROM public.schema_migrations')).rows[0].n,
      ),
    ).toBe(102);
    expect(
      Number(
        (await ownerPool.query('SELECT count(*)::int n FROM wm_app_load.descriptor')).rows[0].n,
      ),
    ).toBe(0);
  });
  it('rejects a genuinely advanced CLOSED global revision and rolls back the close receipt too', async () => {
    const before = Number(
      (await ownerPool.query('SELECT count(*)::int n FROM public.restore_processing_close_receipt'))
        .rows[0].n,
    );
    await expect(
      transaction(async (c) => {
        await c.query('SELECT public.close_restore_processing_exact($1::bigint,$2,$3,$4)', [
          prepared.body.controlRevision,
          randomUUID(),
          prepared.body.targetNonce,
          prepared.body.targetIncarnation,
        ]);
        await stageVerifiedAppFamilyArtifactIn(
          c,
          handle,
          prepared.authority.expected,
          randomUUID(),
        );
      }),
    ).rejects.toThrow('RESTORE_PROCESSING_CONTROL_CONFLICT');
    expect(await count()).toBe(0);
    expect(
      Number(
        (
          await ownerPool.query(
            'SELECT count(*)::int n FROM public.restore_processing_close_receipt',
          )
        ).rows[0].n,
      ),
    ).toBe(before);
  });
  it('same transaction SQL mapping/load then subsequent failure rolls back all stage/live rows', async () => {
    await expect(
      transaction(async (c) => {
        await stageVerifiedAppFamilyArtifactIn(
          c,
          handle,
          prepared.authority.expected,
          randomUUID(),
        );
        await c.query('SELECT 1/0');
      }),
    ).rejects.toMatchObject({ code: '22012' });
    expect(await count()).toBe(0);
    expect(
      Number(
        (await ownerPool.query('SELECT count(*)::int n FROM wm_app_load.family_stage')).rows[0].n,
      ),
    ).toBe(0);
  });
  it('commits exact authenticated original plan row while global state remains CLOSED', async () => {
    await transaction(async (c) => {
      expect(
        await stageVerifiedAppFamilyArtifactIn(
          c,
          handle,
          prepared.authority.expected,
          randomUUID(),
        ),
      ).toEqual({ admissionAllowed: false });
      const saved = (
        await c.query('SELECT to_jsonb(p) row FROM plan_snapshot p WHERE athlete_id=$1', [
          prepared.body.ownerId,
        ])
      ).rows[0].row;
      expect(saved).toEqual(prepared.body.rows[0]?.row);
    });
    expect(await count()).toBe(1);
    const control = (
      await ownerPool.query('SELECT public.read_restore_processing_admission() AS state')
    ).rows[0].state;
    expect(control.state).toBe('CLOSED');
    expect(control.admissionAllowed).toBe(false);
  });
});
