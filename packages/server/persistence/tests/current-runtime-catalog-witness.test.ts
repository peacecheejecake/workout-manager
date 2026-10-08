import { describe, it, expect, vi } from 'vitest';
import {
  buildCurrentRuntimeCatalogWitness,
  parseCurrentRuntimeCatalogMetadata,
  parseCurrentRuntimeCatalogWitness,
  captureCurrentRuntimeCatalogWitnessIn,
  CurrentRuntimeCatalogWitnessError,
} from '../src/current-runtime-catalog-witness.js';
import type { CurrentRuntimeCatalogMetadata } from '../src/current-runtime-catalog-witness.js';

function metadata(): CurrentRuntimeCatalogMetadata {
  const role = (tag: string) => ({
    tag,
    superuser: false,
    bypassRls: false,
    createRole: false,
    createDb: false,
    inherit: true,
    login: true,
    replication: false,
    configurationSha256: null,
  });
  return {
    serverVersion: '170006',
    schemas: [
      {
        name: 'public',
        owner: 'owner',
        acl: [{ grantee: 'runtime', grantor: 'owner', privilege: 'USAGE', grantable: false }],
        runtimeUsage: true,
        runtimeCreate: false,
      },
    ],
    functions: [
      {
        schema: 'public',
        name: 'example_rpc',
        arguments: 'value jsonb',
        returns: 'jsonb',
        owner: 'owner',
        kind: 'f',
        language: 'plpgsql',
        returnSet: false,
        securityDefiner: true,
        strict: false,
        leakproof: false,
        volatility: 'v',
        parallel: 'u',
        configuration: ['search_path=pg_catalog, pg_temp', 'TimeZone=UTC'],
        sourceBytes: 12,
        sourceSha256: 'a'.repeat(64),
        binarySha256: null,
        acl: [{ grantee: 'runtime', grantor: 'owner', privilege: 'EXECUTE', grantable: false }],
        runtimeExecute: true,
      },
    ],
    relations: [
      {
        schema: 'public',
        name: 'example_record',
        owner: 'owner',
        kind: 'r',
        persistence: 'p',
        rls: true,
        force: true,
        partitionBound: null,
        acl: [],
        columns: [
          {
            position: 1,
            name: 'id',
            dropped: false,
            type: 'uuid',
            typmod: -1,
            collation: null,
            notNull: true,
            identity: '',
            generated: '',
            default: null,
            acl: [],
            runtimeSelect: true,
            runtimeInsert: false,
            runtimeUpdate: false,
            runtimeReferences: false,
          },
        ],
        constraints: [
          {
            name: 'example_pk',
            kind: 'p',
            definition: 'PRIMARY KEY (id)',
            validated: true,
            deferrable: false,
            deferred: false,
          },
        ],
        triggers: [
          {
            name: 'example_guard',
            definition:
              'CREATE TRIGGER example_guard BEFORE UPDATE ON public.example_record FOR EACH ROW EXECUTE FUNCTION public.example_rpc()',
            enabled: 'O',
            constraint: false,
            deferrable: false,
            deferred: false,
            function: 'example_rpc(jsonb)',
          },
        ],
        policies: [
          {
            name: 'tenant',
            command: '*',
            permissive: true,
            roles: ['PUBLIC'],
            qual: "athlete_id = current_setting('app.athlete_id'::text)",
            check: null,
          },
        ],
        index: null,
        sequence: null,
        runtimePrivileges: {
          select: true,
          insert: false,
          update: false,
          delete: false,
          truncate: false,
          references: false,
          trigger: false,
          usage: false,
        },
      },
    ],
    roles: [role('owner'), role('runtime')],
    memberships: [],
    defaultPrivileges: [],
    extensions: [],
    types: [],
    collations: [],
    dependencies: [
      {
        dependent: 'trigger example_guard on table example_record',
        referenced: 'function example_rpc(jsonb)',
        kind: 'n',
      },
    ],
  };
}
function failure(raw: unknown, code = 'CATALOG_WITNESS_INVALID') {
  try {
    parseCurrentRuntimeCatalogMetadata(raw);
    throw new Error('expected failure');
  } catch (error) {
    expect(error).toBeInstanceOf(CurrentRuntimeCatalogWitnessError);
    expect(error).toMatchObject({ code });
  }
}
describe('private normalized witness observation is not a support seal', () => {
  it('preserves source hash/length, physical security metadata and effective caller observations', () => {
    const m = metadata(),
      witness = buildCurrentRuntimeCatalogWitness(m);
    expect(witness.metadata).toEqual(m);
    expect(witness.supported).toBe(false);
    expect(witness.closure).toEqual({
      dynamicDependencies: 'not_verified',
      strictCallerWire: 'not_verified',
      effectiveRecipe: 'not_verified',
      independentNormalization: 'not_verified',
    });
    expect(witness.profile.runtimeSteps).toHaveLength(17);
    expect(witness.profile.runtimeSteps.map((x) => x.sourceDdlId)).not.toContain(128);
    expect(witness.sections.find((x) => x.section === 'functions')).toMatchObject({
      rowCount: 1,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(witness.metadata.functions[0]).not.toHaveProperty('source');
  });
  it('canonical object-key order is deterministic without altering semantic array/config order', () => {
    const a = metadata(),
      b = {
        ...a,
        schemas: a.schemas.map((s) => ({
          runtimeCreate: s.runtimeCreate,
          runtimeUsage: s.runtimeUsage,
          acl: s.acl,
          owner: s.owner,
          name: s.name,
        })),
      };
    expect(buildCurrentRuntimeCatalogWitness(a).catalogSha256).toBe(
      buildCurrentRuntimeCatalogWitness(b).catalogSha256,
    );
    const moved = metadata(),
      f = moved.functions[0];
    if (!f || !f.configuration) throw new Error('fixture');
    f.configuration.reverse();
    expect(buildCurrentRuntimeCatalogWitness(moved).catalogSha256).not.toBe(
      buildCurrentRuntimeCatalogWitness(a).catalogSha256,
    );
  });
  it.each(['force', 'rls'] as const)('does not normalize away %s drift', (field) => {
    const before = metadata(),
      after = metadata(),
      r = after.relations[0];
    if (!r) throw new Error('fixture');
    r[field] = false;
    expect(buildCurrentRuntimeCatalogWitness(after).catalogSha256).not.toBe(
      buildCurrentRuntimeCatalogWitness(before).catalogSha256,
    );
  });
  it('retains unknown namespace and unmapped ACL principals rather than dropping them', () => {
    const m = metadata(),
      r = m.roles[0];
    if (!r) throw new Error('fixture');
    m.roles.push({ ...r, tag: 'unmapped:unexpected_reader' });
    m.schemas.push({
      name: 'unexpected_schema',
      owner: 'unmapped:unexpected_reader',
      acl: [],
      runtimeUsage: false,
      runtimeCreate: false,
    });
    m.schemas[0]?.acl.push({
      grantee: 'unmapped:unexpected_reader',
      grantor: 'owner',
      privilege: 'CREATE',
      grantable: true,
    });
    const witness = buildCurrentRuntimeCatalogWitness(m);
    expect(witness.unknownNamespaces).toEqual(['unexpected_schema']);
    expect(witness.unmappedRoleTags).toEqual(['unmapped:unexpected_reader']);
    expect(witness.supported).toBe(false);
  });
  it('grant option, grantor, runtime EXECUTE and trigger enabled state remain semantic', () => {
    const initial = buildCurrentRuntimeCatalogWitness(metadata()).catalogSha256;
    const m = metadata(),
      f = m.functions[0],
      t = m.relations[0]?.triggers[0];
    if (!f || !t || !f.acl[0]) throw new Error('fixture');
    f.acl[0].grantable = true;
    f.runtimeExecute = false;
    t.enabled = 'D';
    expect(buildCurrentRuntimeCatalogWitness(m).catalogSha256).not.toBe(initial);
  });
  it('dropped physical columns and nullable definitions are preserved', () => {
    const m = metadata(),
      r = m.relations[0];
    if (!r) throw new Error('fixture');
    r.columns.push({
      position: 2,
      name: '........pg.dropped.2........',
      dropped: true,
      type: 'dropped',
      typmod: -1,
      collation: null,
      notNull: false,
      identity: '',
      generated: '',
      default: null,
      acl: [],
      runtimeSelect: false,
      runtimeInsert: false,
      runtimeUpdate: false,
      runtimeReferences: false,
    });
    expect(parseCurrentRuntimeCatalogMetadata(m).relations[0]?.columns[1]?.dropped).toBe(true);
  });
  it.each(['schemas', 'relations', 'functions', 'roles', 'extensions'] as const)(
    'rejects duplicate %s identities',
    (section) => {
      const m = metadata();
      switch (section) {
        case 'schemas':
          if (m.schemas[0]) m.schemas.push(m.schemas[0]);
          break;
        case 'relations':
          if (m.relations[0]) m.relations.push(m.relations[0]);
          break;
        case 'functions':
          if (m.functions[0]) m.functions.push(m.functions[0]);
          break;
        case 'roles':
          if (m.roles[0]) m.roles.push(m.roles[0]);
          break;
        case 'extensions':
          m.extensions = [
            { name: 'sample', version: '1', schema: 'public', owner: 'owner', members: [] },
            { name: 'sample', version: '1', schema: 'public', owner: 'owner', members: [] },
          ];
          break;
      }
      failure(m);
    },
  );
  it('rejects unexplained owner/ACL role, unknown fields or caller support claims', () => {
    const m = metadata();
    if (m.schemas[0]) m.schemas[0].owner = 'unregistered';
    failure(m);
    failure({ ...metadata(), supported: true });
    failure({ ...metadata(), inventory: ['public.example_record'] });
    failure({ ...metadata(), roles: metadata().roles.filter((r) => r.tag !== 'runtime') });
  });
  it('rejects raw source/body fields, bad hash, oversized source length and malformed scalar semantics', () => {
    const m = metadata(),
      f = m.functions[0];
    if (!f) throw new Error('fixture');
    f.sourceSha256 = 'not-a-hash';
    failure(m);
    failure({ ...metadata(), functions: [{ ...metadata().functions[0], source: 'raw source' }] });
    failure({ ...metadata(), functions: [{ ...metadata().functions[0], sourceBytes: 2097153 }] });
    failure({ ...metadata(), relations: [{ ...metadata().relations[0], force: 'true' }] });
  });
  it('unknown accessor is never executed and cycles/nonplain/hole/large primitive are bounded before parse', () => {
    const getter = vi.fn(),
      object = Object.defineProperty({}, 'schemas', { get: getter, enumerable: true });
    failure(object);
    expect(getter).not.toHaveBeenCalled();
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    failure(cyclic);
    failure(new Date());
    const hole = metadata();
    hole.schemas.length += 1;
    failure(hole);
    failure({ ['x'.repeat(16777217)]: null }, 'CATALOG_WITNESS_LIMIT');
  });
  it('owner capture validates runtime role and actual owner/RR context before installed/profile metadata calls', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    await expect(
      captureCurrentRuntimeCatalogWitnessIn({ query }, 'runtime; DROP TABLE x'),
    ).rejects.toMatchObject({ code: 'CATALOG_WITNESS_INVALID' });
    expect(query).not.toHaveBeenCalled();
    await expect(captureCurrentRuntimeCatalogWitnessIn({ query }, 'runtime')).rejects.toMatchObject(
      { code: 'CATALOG_WITNESS_CONTEXT_REQUIRED' },
    );
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('READ COMMITTED or READ WRITE context is refused without interpreting owner JSON as authority', async () => {
    const query = vi.fn(async () => ({
      rows: [
        { owner: true, runtime: true, readOnly: false, isolation: 'read committed', roleCount: 3 },
      ],
      rowCount: 1,
    }));
    await expect(captureCurrentRuntimeCatalogWitnessIn({ query }, 'runtime')).rejects.toMatchObject(
      { code: 'CATALOG_WITNESS_CONTEXT_REQUIRED' },
    );
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('database errors propagate unchanged for caller rollback and never become unavailable-as-success', async () => {
    const error = new Error('synthetic catalog permission failure');
    await expect(
      captureCurrentRuntimeCatalogWitnessIn(
        {
          query: async () => {
            throw error;
          },
        },
        'runtime',
      ),
    ).rejects.toBe(error);
  });
});

it('private artifact strict decoder recomputes finite sections/profile without minting authority', () => {
  const artifact = buildCurrentRuntimeCatalogWitness(metadata());
  expect(parseCurrentRuntimeCatalogWitness(artifact)).toEqual(artifact);
  for (const raw of [
    { ...artifact, supported: true },
    { ...artifact, catalogSha256: '0'.repeat(64) },
    { ...artifact, closure: { ...artifact.closure, dynamicDependencies: 'verified' } },
    { ...artifact, profile: { ...artifact.profile, runtimeSteps: [] } },
  ])
    expect(() => parseCurrentRuntimeCatalogWitness(raw)).toThrow('CATALOG_WITNESS_INVALID');
});

it('canonical internal FK dependency identities preserve semantic changes and every edge', () => {
  // Structural identities model the SQL catalog producer, not caller authority.
  // Actual independent-DB normalization is covered by the Root-run PG fixture.
  const identity = {
    constraintRelation: 'public.child',
    constraintName: 'child_parent_fkey',
    constraintDefinition: 'FOREIGN KEY (parent_id) REFERENCES public.parent(id)',
    constraintValidated: true,
    referencedRelation: 'public.parent',
    triggerRelation: 'public.child',
    function: 'pg_catalog.RI_FKey_check_ins()',
    type: 5,
    enabled: 'O',
    deferrable: false,
    deferred: false,
    arguments: '',
    columns: '',
    qual: null,
  };
  function witness(value: typeof identity) {
    const m = metadata();
    m.dependencies = [
      {
        dependent: `internal-fk-trigger:${JSON.stringify(value)}`,
        referenced: 'constraint child_parent_fkey on table public.child',
        kind: 'i',
      },
      {
        dependent: `internal-fk-trigger:${JSON.stringify(value)}`,
        referenced: 'function pg_catalog.RI_FKey_check_ins()',
        kind: 'n',
      },
    ];
    return buildCurrentRuntimeCatalogWitness(m);
  }
  const before = witness(identity);
  expect(before.metadata.dependencies).toHaveLength(2);
  expect(witness({ ...identity }).catalogSha256).toBe(before.catalogSha256);
  for (const change of [
    { constraintName: 'different_fkey' },
    { constraintDefinition: 'FOREIGN KEY (parent_id) REFERENCES public.other_parent(id)' },
    { constraintValidated: false },
    { triggerRelation: 'public.other_child' },
    { function: 'pg_catalog.RI_FKey_check_upd()' },
    { type: 17 },
    { enabled: 'D' },
    { deferrable: true },
    { deferred: true },
  ])
    expect(witness({ ...identity, ...change }).catalogSha256).not.toBe(before.catalogSha256);
  const fewer = { ...before.metadata, dependencies: before.metadata.dependencies.slice(0, 1) };
  expect(buildCurrentRuntimeCatalogWitness(fewer).catalogSha256).not.toBe(before.catalogSha256);
});
it('user RI trigger name lookalikes remain exact facts and are never broadly OID-stripped', () => {
  const a = metadata(),
    b = metadata();
  a.dependencies = [
    {
      dependent: 'trigger RI_ConstraintTrigger_a_12345 on table public.example_record',
      referenced: 'function public.example_rpc(jsonb)',
      kind: 'n',
    },
  ];
  b.dependencies = [
    {
      referenced: 'function public.example_rpc(jsonb)',
      kind: 'n',
      dependent: 'trigger RI_ConstraintTrigger_a_67890 on table public.example_record',
    },
  ];
  expect(buildCurrentRuntimeCatalogWitness(a).catalogSha256).not.toBe(
    buildCurrentRuntimeCatalogWitness(b).catalogSha256,
  );
  expect(parseCurrentRuntimeCatalogMetadata(a).dependencies[0]?.dependent).toContain('12345');
});

it('actual quoted uppercase and Unicode catalog identifiers remain exact with PostgreSQL byte bounds', () => {
  const m = metadata();
  const relation = m.relations[0],
    fn = m.functions[0];
  if (!relation || !fn) throw new Error('fixture');
  relation.name = 'Quoted_대회';
  fn.name = 'MixedCase_함수';
  const trigger = relation.triggers[0];
  if (!trigger) throw new Error('fixture');
  trigger.name = 'RI_ConstraintTrigger_a_12345';
  expect(parseCurrentRuntimeCatalogMetadata(m).relations[0]?.triggers[0]?.name).toBe(trigger.name);
  expect(parseCurrentRuntimeCatalogMetadata(m).functions[0]?.name).toBe(fn.name);
  for (const invalid of ['', 'a'.repeat(64), '가'.repeat(22), 'name\0suffix']) {
    const bad = metadata();
    const r = bad.relations[0];
    if (!r) throw new Error('fixture');
    r.name = invalid;
    failure(bad);
  }
  relation.name = '가'.repeat(21);
  expect(parseCurrentRuntimeCatalogMetadata(m).relations[0]?.name).toBe(relation.name);
});
it('accepting catalog identifiers does not loosen the separately safe runtime role parameter', async () => {
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  for (const role of ['QuotedRole', '사용자', 'runtime;select', 'x\0y']) {
    await expect(captureCurrentRuntimeCatalogWitnessIn({ query }, role)).rejects.toThrow(
      'CATALOG_WITNESS_INVALID',
    );
  }
  expect(query).not.toHaveBeenCalled();
});
