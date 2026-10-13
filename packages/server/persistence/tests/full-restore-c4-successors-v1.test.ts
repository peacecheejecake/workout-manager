import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  bindPg17NodeTreeV1,
  decodePg17NodeTreeV1,
  Pg17NodeDecodeError,
  PG17_SUPPORTED_NODE_TAGS,
  type Pg17CatalogSnapshotV1,
} from '../src/full-restore-pg17-node-decoder-v1.js';
import {
  classifyFullRestoreRelationsV1,
  FullRestoreClassificationErrorV1,
} from '../src/full-restore-relation-classification-v1.js';
import { fullRestoreDurableRowColumnsV1 } from '../src/full-restore-durable-row-codecs-v1.js';
import {
  compareDumpCorrespondenceV1,
  parsePlainDataDumpV1,
  runSnapshotDataDumpV1,
  FullRestoreDumpCorrespondenceErrorV1,
  FULL_RESTORE_DUMP_HARD_LIMITS_V1,
} from '../src/full-restore-dump-correspondence-v1.js';
import {
  createFullRestoreStructureComparatorV1,
  FullRestoreStructureErrorV1,
  type FullRestoreStructureV1,
} from '../src/full-restore-expected-structure-v1.js';

// PG17 node texts copied from catalog metadata of a disposable install (schema only, no rows).
const CHECK_TREE =
  '{SCALARARRAYOPEXPR :opno 96 :opfuncid 65 :hashfuncid 0 :negfuncid 0 :useOr true :inputcollid 0 :args ({FUNCEXPR :funcid 440 :funcresulttype 23 :funcretset false :funcvariadic false :funcformat 0 :funccollid 0 :inputcollid 100 :args ({VAR :varno 1 :varattno 7 :vartype 25 :vartypmod -1 :varcollid 100 :varnullingrels (b) :varlevelsup 0 :varnosyn 1 :varattnosyn 7 :location -1} {VAR :varno 1 :varattno 8 :vartype 25 :vartypmod -1 :varcollid 100 :varnullingrels (b) :varlevelsup 0 :varnosyn 1 :varattnosyn 8 :location -1}) :location -1} {ARRAYEXPR :array_typeid 1007 :array_collid 0 :element_typeid 23 :elements ({CONST :consttype 23 :consttypmod -1 :constcollid 0 :constlen 4 :constbyval true :constisnull false :location -1 :constvalue 4 [ 0 0 0 0 0 0 0 0 ]} {CONST :consttype 23 :consttypmod -1 :constcollid 0 :constlen 4 :constbyval true :constisnull false :location -1 :constvalue 4 [ 2 0 0 0 0 0 0 0 ]}) :multidims false :location -1}) :location -1}';
const WHEN_TREE =
  '{BOOLEXPR :boolop and :args ({VAR :varno 2 :varattno 5 :vartype 16 :vartypmod -1 :varcollid 0 :varnullingrels (b) :varlevelsup 0 :varnosyn 2 :varattnosyn 5 :location -1} {BOOLEXPR :boolop not :args ({VAR :varno 1 :varattno 5 :vartype 16 :vartypmod -1 :varcollid 0 :varnullingrels (b) :varlevelsup 0 :varnosyn 1 :varattnosyn 5 :location -1}) :location -1}) :location -1}';
const RELABEL_TREE =
  '{NULLTEST :arg {RELABELTYPE :arg {VAR :varno 1 :varattno 7 :vartype 25 :vartypmod -1 :varcollid 100 :varnullingrels (b) :varlevelsup 0 :varnosyn 1 :varattnosyn 7 :location 10} :resulttype 25 :resulttypmod -1 :resultcollid 100 :relabelformat 2 :location -1} :nulltesttype 1 :argisrow false :location 4}';
type Row<K extends keyof Pg17CatalogSnapshotV1> = Pg17CatalogSnapshotV1[K][number];
type MutableCatalog = { [K in keyof Pg17CatalogSnapshotV1]: Row<K>[] };
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('fixture');
  return value;
}
const catalog = (): MutableCatalog => ({
  types: [
    { oid: 16, schema: 'pg_catalog', name: 'bool', typlen: 1, typbyval: true, typtype: 'b' },
    { oid: 23, schema: 'pg_catalog', name: 'int4', typlen: 4, typbyval: true, typtype: 'b' },
    { oid: 25, schema: 'pg_catalog', name: 'text', typlen: -1, typbyval: false, typtype: 'b' },
    { oid: 1007, schema: 'pg_catalog', name: '_int4', typlen: -1, typbyval: false, typtype: 'b' },
    { oid: 2276, schema: 'pg_catalog', name: 'any', typlen: 4, typbyval: true, typtype: 'p' },
  ],
  collations: [{ oid: 100, schema: 'pg_catalog', name: 'default' }],
  operators: [
    { oid: 96, schema: 'pg_catalog', name: '=', left: 23, right: 23, result: 16, code: 65 },
  ],
  procedures: [
    {
      oid: 65,
      schema: 'pg_catalog',
      name: 'int4eq',
      args: [23, 23],
      result: 16,
      retset: false,
      variadic: 0,
    },
    {
      oid: 440,
      schema: 'pg_catalog',
      name: 'num_nonnulls',
      args: [2276],
      result: 23,
      retset: false,
      variadic: 2276,
    },
  ],
});
const columns = [
  { attnum: 5, name: 'active', typeOid: 16, typmod: -1, collationOid: 0 },
  { attnum: 7, name: 'provider', typeOid: 25, typmod: -1, collationOid: 100 },
  { attnum: 8, name: 'model', typeOid: 25, typmod: -1, collationOid: 100 },
];
function decodeCode(text: string): string {
  try {
    decodePg17NodeTreeV1(text);
  } catch (error) {
    if (error instanceof Pg17NodeDecodeError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
}
function bindCode(
  text: string,
  edit: (c: ReturnType<typeof catalog>) => void,
  scope: 'relation' | 'trigger' = 'relation',
) {
  const c = catalog();
  edit(c);
  try {
    bindPg17NodeTreeV1(decodePg17NodeTreeV1(text), c, { scope, columns });
  } catch (error) {
    if (error instanceof Pg17NodeDecodeError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
}

describe('PG17 typed node decoder and catalog binding', () => {
  it('decodes composite real trees with references and closed tag set', () => {
    const decoded = decodePg17NodeTreeV1(CHECK_TREE);
    expect(decoded.references).toEqual([
      { catalog: 'pg_collation', oid: 100 },
      { catalog: 'pg_operator', oid: 96 },
      { catalog: 'pg_proc', oid: 65 },
      { catalog: 'pg_proc', oid: 440 },
      { catalog: 'pg_type', oid: 23 },
      { catalog: 'pg_type', oid: 25 },
      { catalog: 'pg_type', oid: 1007 },
    ]);
    expect(decoded.nodeCount).toBe(7);
    expect(decoded.authority).toBe('none');
    expect([...PG17_SUPPORTED_NODE_TAGS].sort()).toEqual(
      [
        'ARRAYEXPR',
        'BOOLEANTEST',
        'BOOLEXPR',
        'CASEEXPR',
        'CASEWHEN',
        'COALESCEEXPR',
        'COERCEVIAIO',
        'CONST',
        'DISTINCTEXPR',
        'FUNCEXPR',
        'MINMAXEXPR',
        'NULLTEST',
        'OPEXPR',
        'RELABELTYPE',
        'SCALARARRAYOPEXPR',
        'VAR',
      ].sort(),
    );
  });

  it('binds to an OID-free normalized tree that ignores locations only', () => {
    const a = bindPg17NodeTreeV1(decodePg17NodeTreeV1(CHECK_TREE), catalog(), {
      scope: 'relation',
      columns,
    });
    expect(a.normalized).toMatchObject({
      arrayOp: 'pg_catalog.=(pg_catalog.int4,pg_catalog.int4)',
      useOr: true,
      args: [
        {
          func: 'pg_catalog.num_nonnulls(pg_catalog.any)',
          args: [{ var: 'provider' }, { var: 'model' }],
        },
        {},
      ],
    });
    expect(a.polymorphicResults).toBe(0);
    // Same structure under different OIDs binds to the identical normalized SHA.
    const shifted = CHECK_TREE.replaceAll(':opno 96', ':opno 9096').replaceAll(
      ':funcid 440',
      ':funcid 9440',
    );
    const c = catalog();
    c.operators[0] = { ...must(c.operators[0]), oid: 9096 };
    c.procedures[1] = { ...must(c.procedures[1]), oid: 9440 };
    expect(
      bindPg17NodeTreeV1(decodePg17NodeTreeV1(shifted), c, { scope: 'relation', columns })
        .normalizedSha256,
    ).toBe(a.normalizedSha256);
    const moved = RELABEL_TREE.replace(':location 10', ':location 99');
    expect(
      bindPg17NodeTreeV1(decodePg17NodeTreeV1(moved), catalog(), { scope: 'relation', columns })
        .normalizedSha256,
    ).toBe(
      bindPg17NodeTreeV1(decodePg17NodeTreeV1(RELABEL_TREE), catalog(), {
        scope: 'relation',
        columns,
      }).normalizedSha256,
    );
    const trigger = bindPg17NodeTreeV1(decodePg17NodeTreeV1(WHEN_TREE), catalog(), {
      scope: 'trigger',
      columns,
    });
    expect(trigger.normalized).toEqual({
      bool: 'and',
      args: [
        { var: 'active', row: 'NEW' },
        { bool: 'not', args: [{ var: 'active', row: 'OLD' }] },
      ],
    });
  });

  it('binds a searched CASE (144 gallery_rendition_job CHECK shape) and rejects other CASE forms', () => {
    const c = catalog();
    c.operators.push({
      oid: 98,
      schema: 'pg_catalog',
      name: '=',
      left: 25,
      right: 25,
      result: 16,
      code: 67,
    });
    c.procedures.push({
      oid: 67,
      schema: 'pg_catalog',
      name: 'texteq',
      args: [25, 25],
      result: 16,
      retset: false,
      variadic: 0,
    });
    const when =
      '{CASEWHEN :expr {OPEXPR :opno 98 :opfuncid 67 :opresulttype 16 :opretset false :opcollid 0 :inputcollid 100 :args ({VAR :varno 1 :varattno 7 :vartype 25 :vartypmod -1 :varcollid 100 :varnullingrels (b) :varlevelsup 0 :varnosyn 1 :varattnosyn 7 :location -1} {CONST :consttype 25 :consttypmod -1 :constcollid 100 :constlen -1 :constbyval false :constisnull false :location -1 :constvalue 5 [ 20 0 0 0 120 ]}) :location -1} :result {CONST :consttype 23 :consttypmod -1 :constcollid 0 :constlen 4 :constbyval true :constisnull false :location -1 :constvalue 4 [ 1 0 0 0 0 0 0 0 ]} :location -1}';
    const otherwise =
      '{CONST :consttype 23 :consttypmod -1 :constcollid 0 :constlen 4 :constbyval true :constisnull false :location -1 :constvalue 4 [ 2 0 0 0 0 0 0 0 ]}';
    const tree = `{CASEEXPR :casetype 23 :casecollid 0 :arg <> :args (${when}) :defresult ${otherwise} :location 3}`;
    const bound = bindPg17NodeTreeV1(decodePg17NodeTreeV1(tree), c, {
      scope: 'relation',
      columns,
    });
    expect(bound.normalized).toMatchObject({
      case: 'pg_catalog.int4',
      collation: null,
      when: [{ when: { op: 'pg_catalog.=(pg_catalog.text,pg_catalog.text)' }, then: {} }],
      else: { const: 'pg_catalog.int4' },
    });
    expect(
      bindPg17NodeTreeV1(decodePg17NodeTreeV1(tree.replace(':location 3', ':location 9')), c, {
        scope: 'relation',
        columns,
      }).normalizedSha256,
    ).toBe(bound.normalizedSha256);
    // Simple CASE (test expression), empty WHEN list, a non-WHEN arm and a bare WHEN.
    expect(decodeCode(tree.replace(':arg <>', `:arg ${otherwise}`))).toBe(
      'NODE_SYNTAX_UNSUPPORTED',
    );
    expect(decodeCode(tree.replace(`:args (${when})`, ':args <>'))).toBe('NODE_VALUE_UNSUPPORTED');
    expect(decodeCode(tree.replace(`:args (${when})`, `:args (${otherwise})`))).toBe(
      'NODE_VALUE_UNSUPPORTED',
    );
    let code = 'NO_ERROR';
    try {
      bindPg17NodeTreeV1(decodePg17NodeTreeV1(when), c, { scope: 'relation', columns });
    } catch (error) {
      if (error instanceof Pg17NodeDecodeError) code = error.code;
    }
    expect(code).toBe('NODE_TAG_UNSUPPORTED');
  });

  it('decodes a datum byte identically whether the server printed char signed or unsigned', () => {
    // 1 day as an interval: byte 0xD7 is `-41` from macOS arm64 and `215` from Linux aarch64.
    const interval = (b: string) =>
      `{CONST :consttype 1186 :consttypmod -1 :constcollid 0 :constlen 16 :constbyval false :constisnull false :location -1 :constvalue 16 [ 0 96 ${b} 29 20 0 0 0 0 0 0 0 0 0 0 0 ]}`;
    const signed = decodePg17NodeTreeV1(interval('-41'));
    const unsigned = decodePg17NodeTreeV1(interval('215'));
    expect(signed.root).toEqual(unsigned.root);
    expect((unsigned.root as { fields: Record<string, unknown> }).fields['constvalue']).toEqual({
      isNull: false,
      length: 16,
      octets: [0, 96, 215, 29, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    });
    expect(decodeCode(interval('-129'))).toBe('NODE_VALUE_UNSUPPORTED');
    expect(decodeCode(interval('256'))).toBe('NODE_VALUE_UNSUPPORTED');
  });

  it('rejects unknown tags, fields, order, enums, bounds and trailing input', () => {
    expect(decodeCode('{SUBLINK :subLinkType 0}')).toBe('NODE_TAG_UNSUPPORTED');
    expect(decodeCode(CHECK_TREE.replace(':useOr true', ':useOr maybe'))).toBe(
      'NODE_VALUE_UNSUPPORTED',
    );
    expect(
      decodeCode(CHECK_TREE.replace(':hashfuncid 0 :negfuncid 0', ':negfuncid 0 :hashfuncid 0')),
    ).toBe('NODE_FIELD_UNSUPPORTED');
    expect(decodeCode(WHEN_TREE.replace(':boolop and', ':boolop xor'))).toBe(
      'NODE_VALUE_UNSUPPORTED',
    );
    expect(
      decodeCode(WHEN_TREE.replace(':varlevelsup 0 :varnosyn 2', ':varlevelsup 1 :varnosyn 2')),
    ).toBe('NODE_VALUE_UNSUPPORTED');
    expect(
      decodeCode(
        WHEN_TREE.replace(
          ':varnullingrels (b) :varlevelsup 0 :varnosyn 2',
          ':varnullingrels (b 1) :varlevelsup 0 :varnosyn 2',
        ),
      ),
    ).toBe('NODE_SYNTAX_UNSUPPORTED');
    expect(decodeCode(`${WHEN_TREE} {CONST}`)).toBe('NODE_SYNTAX_UNSUPPORTED');
    expect(decodeCode(CHECK_TREE.replace(':funcretset false', ':funcretset true'))).toBe(
      'NODE_VALUE_UNSUPPORTED',
    );
    expect(decodeCode(CHECK_TREE.replace('4 [ 2 0 0 0 0 0 0 0 ]', '4 [ 2 0 0 0 ]'))).toBe(
      'NODE_VALUE_UNSUPPORTED',
    );
    expect(decodeCode(CHECK_TREE.replace(':constisnull false', ':constisnull true'))).toBe(
      'NODE_VALUE_UNSUPPORTED',
    );
    expect(
      decodeCode(
        WHEN_TREE.replace(':varattnosyn 5 :location -1}) ', ':varattnosyn 6 :location -1}) '),
      ),
    ).toBe('NODE_VALUE_UNSUPPORTED');
    let deep =
      '{CONST :consttype 16 :consttypmod -1 :constcollid 0 :constlen 1 :constbyval true :constisnull false :location -1 :constvalue 1 [ 1 0 0 0 0 0 0 0 ]}';
    for (let i = 0; i < 70; i++)
      deep = `{NULLTEST :arg ${deep} :nulltesttype 1 :argisrow false :location -1}`;
    expect(decodeCode(deep)).toBe('NODE_BOUND_EXCEEDED');
    expect(decodeCode('x'.repeat(262145))).toBe('NODE_BOUND_EXCEEDED');
    expect(decodeCode('')).toBe('NODE_BOUND_EXCEEDED');
  });

  it('rejects unbound or inconsistent catalog references', () => {
    expect(bindCode(CHECK_TREE, () => undefined)).toBe('NO_ERROR');
    expect(bindCode(CHECK_TREE, (c) => c.operators.pop())).toBe('NODE_REFERENCE_UNBOUND');
    expect(
      bindCode(CHECK_TREE, (c) => {
        c.operators[0] = { ...must(c.operators[0]), code: 66 };
      }),
    ).toBe('NODE_REFERENCE_INCONSISTENT');
    expect(
      bindCode(CHECK_TREE, (c) => {
        c.procedures[1] = { ...must(c.procedures[1]), variadic: 0 };
      }),
    ).toBe('NODE_REFERENCE_INCONSISTENT');
    expect(
      bindCode(CHECK_TREE, (c) => {
        c.procedures[1] = { ...must(c.procedures[1]), result: 20 };
        c.types.push({
          oid: 20,
          schema: 'pg_catalog',
          name: 'int8',
          typlen: 8,
          typbyval: true,
          typtype: 'b',
        });
      }),
    ).toBe('NODE_REFERENCE_INCONSISTENT');
    expect(
      bindCode(CHECK_TREE, (c) => {
        c.types[1] = { ...must(c.types[1]), typlen: 8 };
      }),
    ).toBe('NODE_REFERENCE_INCONSISTENT');
    expect(
      bindCode(
        CHECK_TREE.replace(':varattno 8 :vartype 25', ':varattno 9 :vartype 25').replace(
          ':varattnosyn 8',
          ':varattnosyn 9',
        ),
        () => undefined,
      ),
    ).toBe('NODE_REFERENCE_INCONSISTENT');
    // OLD/NEW range index 2 is only valid for trigger WHEN.
    expect(bindCode(WHEN_TREE, () => undefined, 'relation')).toBe('NODE_REFERENCE_INCONSISTENT');
    expect(bindCode(WHEN_TREE, (c) => c.collations.pop(), 'trigger')).toBe('NO_ERROR');
    expect(bindCode(CHECK_TREE, (c) => c.collations.pop())).toBe('NODE_REFERENCE_UNBOUND');
  });
});

describe('durable7 relation classification successor', () => {
  const rosterBytes = new Uint8Array(
    readFileSync(
      new URL('../src/full-restore-native-catalog-v2/source-owned-roster.json', import.meta.url),
    ),
  );
  const code = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      if (error instanceof FullRestoreClassificationErrorV1) return error.code;
      throw error;
    }
    return 'NO_ERROR';
  };
  it('promotes exactly the seven codec-backed relations without editing the pinned roster', () => {
    const result = classifyFullRestoreRelationsV1(rosterBytes);
    expect(result.counts).toEqual({
      source_retained: 203,
      source_retained_durable_codec_v1: 7,
      authentication_reset: 7,
      target_local_exclude: 22,
    });
    expect(result.relations).toHaveLength(239);
    expect(result.authority).toBe('none');
  });
  it('fails closed on roster drift, missing codec or column mismatch', () => {
    const changed = Uint8Array.from(rosterBytes);
    changed[changed.length - 2] = 0x20;
    expect(code(() => classifyFullRestoreRelationsV1(changed))).toBe(
      'CLASSIFICATION_ROSTER_PIN_MISMATCH',
    );
    const { race_manual_public_receipt_v1: _removed, ...six } = fullRestoreDurableRowColumnsV1;
    void _removed;
    expect(code(() => classifyFullRestoreRelationsV1(rosterBytes, six))).toBe(
      'CLASSIFICATION_DURABLE_MISMATCH',
    );
    expect(
      code(() =>
        classifyFullRestoreRelationsV1(rosterBytes, {
          ...fullRestoreDurableRowColumnsV1,
          check_in_template_head: ['athlete_id', 'template_id', 'version_id'],
        }),
      ),
    ).toBe('CLASSIFICATION_DURABLE_MISMATCH');
    expect(
      code(() =>
        classifyFullRestoreRelationsV1(rosterBytes, {
          ...fullRestoreDurableRowColumnsV1,
          check_in_template_head: [
            ...(fullRestoreDurableRowColumnsV1['check_in_template_head'] ?? []),
            'extra',
          ],
        }),
      ),
    ).toBe('CLASSIFICATION_DURABLE_MISMATCH');
  });
});

describe('pg_dump data correspondence', () => {
  const dump = (
    rows: string[],
    seq = "SELECT pg_catalog.setval('public.openai_budget_journal_sequence_id_seq', 3, true);",
  ) =>
    Buffer.from(
      [
        '--',
        '\\restrict synthetic',
        'SET statement_timeout = 0;',
        'COPY public.alpha (id, "Order", note) FROM stdin;',
        ...rows,
        '\\.',
        '',
        'COPY "odd""schema".beta (id) FROM stdin;',
        '\\.',
        '',
        seq,
        '\\unrestrict synthetic',
        '',
      ].join('\n'),
    );
  const limits = { maxBytes: 1 << 20, maxRelations: 10 };
  const expected = {
    relations: [
      { schema: 'public', relation: 'alpha', columns: ['id', 'Order', 'note'], rowCount: 2 },
      { schema: 'odd"schema', relation: 'beta', columns: ['id'], rowCount: 0 },
    ],
    sequences: [
      {
        schema: 'public',
        relation: 'openai_budget_journal_sequence_id_seq',
        lastValue: '3',
        isCalled: true,
      },
    ],
  };
  it('parses COPY sections, quoted identifiers and setval and corresponds exactly', () => {
    const parsed = parsePlainDataDumpV1(dump(['1\ta\t\\N', '2\tb\tline\\nbreak']), limits);
    expect(parsed.relations.map((r) => [r.schema, r.relation, r.rowCount])).toEqual([
      ['odd"schema', 'beta', 0],
      ['public', 'alpha', 2],
    ]);
    const result = compareDumpCorrespondenceV1(parsed, expected);
    expect(result).toMatchObject({
      corresponds: true,
      rowContent: 'not_compared',
      authority: 'none',
    });
  });
  it('reports count, column, missing, unexpected and sequence differences', () => {
    const parsed = parsePlainDataDumpV1(
      dump(
        ['1\ta\t\\N'],
        "SELECT pg_catalog.setval('public.openai_budget_journal_sequence_id_seq', 2, true);",
      ),
      limits,
    );
    const result = compareDumpCorrespondenceV1(parsed, {
      relations: [
        { schema: 'public', relation: 'alpha', columns: ['id', 'note', 'Order'], rowCount: 2 },
        { schema: 'public', relation: 'gamma', columns: ['id'], rowCount: 0 },
      ],
      sequences: expected.sequences,
    });
    expect(result.corresponds).toBe(false);
    expect([...result.differences].sort()).toEqual(
      [
        'odd"schema.beta:unexpected',
        'public.alpha:columns',
        'public.alpha:rowCount',
        'public.gamma:missing',
        'public.openai_budget_journal_sequence_id_seq:sequence_state',
      ].sort(),
    );
  });
  it('rejects unterminated COPY, duplicates, DDL and oversize dumps', () => {
    const code = (bytes: Uint8Array, l = limits) => {
      try {
        parsePlainDataDumpV1(bytes, l);
      } catch (error) {
        if (error instanceof FullRestoreDumpCorrespondenceErrorV1) return error.code;
        throw error;
      }
      return 'NO_ERROR';
    };
    expect(code(Buffer.from('COPY public.alpha (id) FROM stdin;\n1\n'))).toBe(
      'DUMP_SYNTAX_UNSUPPORTED',
    );
    expect(
      code(
        Buffer.from('COPY public.a (id) FROM stdin;\n\\.\nCOPY public.a (id) FROM stdin;\n\\.\n'),
      ),
    ).toBe('DUMP_SYNTAX_UNSUPPORTED');
    expect(code(Buffer.from('CREATE TABLE public.x (id int);\n'))).toBe('DUMP_SYNTAX_UNSUPPORTED');
    expect(code(dump([]), { maxBytes: 10, maxRelations: 10 })).toBe('DUMP_BOUND_EXCEEDED');
    expect(code(Buffer.from([0xff]))).toBe('DUMP_INPUT_INVALID');
  });
  const code = (bytes: Uint8Array, l: unknown = limits) => {
    try {
      parsePlainDataDumpV1(bytes, l as typeof limits);
    } catch (error) {
      if (error instanceof FullRestoreDumpCorrespondenceErrorV1) return error.code;
      throw error;
    }
    return 'NO_ERROR';
  };
  const withLine = (extra: string, at: 'preamble' | 'afterCopy' | 'afterSetval' | 'tail') => {
    const text = dump(['1\ta\t\\N', '2\tb\tline\\nbreak']).toString('utf8').split('\n');
    const index = {
      preamble: text.indexOf('SET statement_timeout = 0;') + 1,
      afterCopy: text.indexOf('COPY "odd""schema".beta (id) FROM stdin;') - 1,
      afterSetval: text.findIndex((l) => l.startsWith('SELECT pg_catalog.setval')) + 1,
      tail: text.length - 1,
    }[at];
    text.splice(index, 0, extra);
    return Buffer.from(text.join('\n'));
  };
  it('accepts only allow-listed dump constructs (P27-p2a-1)', () => {
    expect(code(withLine('-- any comment; DELETE FROM public.alpha;', 'afterCopy'))).toBe(
      'NO_ERROR',
    );
    for (const extra of [
      'DELETE FROM public.alpha;',
      'UPDATE public.alpha SET note = NULL;',
      "INSERT INTO public.alpha VALUES (3, 'c', NULL);",
      'TRUNCATE public.alpha;',
      'ALTER TABLE public.alpha DISABLE TRIGGER ALL;',
      "SELECT pg_catalog.setval('public.other_seq', 1, true); DELETE FROM public.alpha;",
      "SELECT pg_catalog.set_config('search_path', 'public', false);",
      'SET row_security = off;',
      'SET session_replication_role = replica;',
      'SET SESSION AUTHORIZATION admin;',
      'BEGIN;',
      '\\i /etc/passwd',
      '\\! true',
      ' DELETE FROM public.alpha;',
      'delete from public.alpha;',
      'COPY public.alpha (id) TO stdout;',
      'COPY public.gamma FROM stdin;',
      'SELECT 1;',
    ])
      for (const at of ['preamble', 'afterCopy', 'afterSetval'] as const)
        expect([extra, at, code(withLine(extra, at))]).toEqual([
          extra,
          at,
          'DUMP_SYNTAX_UNSUPPORTED',
        ]);
    // Nothing but comments after \unrestrict; preamble lines only once and before data.
    expect(code(withLine('SET statement_timeout = 0;', 'tail'))).toBe('DUMP_SYNTAX_UNSUPPORTED');
    expect(code(withLine('SET statement_timeout = 0;', 'preamble'))).toBe(
      'DUMP_SYNTAX_UNSUPPORTED',
    );
    expect(code(withLine('SET lock_timeout = 0;', 'afterCopy'))).toBe('DUMP_SYNTAX_UNSUPPORTED');
    expect(code(withLine('SET lock_timeout = 0;', 'preamble'))).toBe('NO_ERROR');
    // \restrict / \unrestrict must pair with the same key, restrict first.
    const text = dump([]).toString('utf8');
    expect(code(Buffer.from(text.replace('\\unrestrict synthetic', '\\unrestrict other')))).toBe(
      'DUMP_SYNTAX_UNSUPPORTED',
    );
    expect(code(Buffer.from(text.replace('\\unrestrict synthetic\n', '')))).toBe(
      'DUMP_SYNTAX_UNSUPPORTED',
    );
    expect(code(Buffer.from(text.replace('\\restrict synthetic\n', '')))).toBe(
      'DUMP_SYNTAX_UNSUPPORTED',
    );
    expect(
      code(
        Buffer.from(
          text.replace('\\restrict synthetic\n', '').replace('\\unrestrict synthetic\n', ''),
        ),
      ),
    ).toBe('NO_ERROR');
  });
  it('rejects duplicate sequence records instead of keeping the last one (P27-p2a-1)', () => {
    const seq =
      "SELECT pg_catalog.setval('public.openai_budget_journal_sequence_id_seq', 3, true);";
    for (const second of [
      seq,
      "SELECT pg_catalog.setval('public.openai_budget_journal_sequence_id_seq', 1, false);",
      "SELECT pg_catalog.setval('public.openai_budget_journal_sequence_id_seq', 9, true);",
      'SELECT pg_catalog.setval(\'"public"."openai_budget_journal_sequence_id_seq"\', 3, true);',
    ])
      expect(code(withLine(second, 'afterSetval'))).toBe('DUMP_SYNTAX_UNSUPPORTED');
    expect(
      code(
        withLine(
          "SELECT pg_catalog.setval('public.other_seq', 99999999999999999999, true);",
          'afterSetval',
        ),
      ),
    ).toBe('DUMP_SYNTAX_UNSUPPORTED');
    // A hand-built parse result with repeated keys is reported, never collapsed.
    const parsed = parsePlainDataDumpV1(dump(['1\ta\t\\N', '2\tb\tline\\nbreak']), limits);
    const doubled = {
      relations: parsed.relations,
      sequences: [
        ...parsed.sequences,
        { ...expected.sequences[0], lastValue: '9' } as (typeof parsed.sequences)[number],
      ],
    };
    const result = compareDumpCorrespondenceV1(doubled, expected);
    expect(result.corresponds).toBe(false);
    expect(result.differences).toContain('dump:sequence_duplicate');
    const relDoubled = { ...parsed, relations: [...parsed.relations, ...parsed.relations] };
    expect(compareDumpCorrespondenceV1(relDoubled, expected).differences).toContain(
      'dump:duplicate',
    );
    expect(
      compareDumpCorrespondenceV1(parsed, {
        ...expected,
        sequences: [...expected.sequences, ...expected.sequences],
      }).differences,
    ).toContain('expected:sequence_duplicate');
  });
  it('validates limits as finite positive safe integers under fixed hard caps (P27-p2a-2)', () => {
    const bytes = dump([]);
    for (const bad of [
      { maxBytes: Infinity, maxRelations: 10 },
      { maxBytes: Number.NaN, maxRelations: 10 },
      { maxBytes: -1, maxRelations: 10 },
      { maxBytes: 0, maxRelations: 10 },
      { maxBytes: 1.5, maxRelations: 10 },
      { maxBytes: 2 ** 53, maxRelations: 10 },
      { maxBytes: FULL_RESTORE_DUMP_HARD_LIMITS_V1.maxBytes + 1, maxRelations: 10 },
      { maxBytes: '1048576', maxRelations: 10 },
      { maxBytes: 1 << 20, maxRelations: Infinity },
      { maxBytes: 1 << 20, maxRelations: FULL_RESTORE_DUMP_HARD_LIMITS_V1.maxRelations + 1 },
      { maxBytes: 1 << 20 },
      null,
      [],
      7,
    ])
      expect([bad, code(bytes, bad)]).toEqual([bad, 'DUMP_INPUT_INVALID']);
    expect(
      code(bytes, {
        maxBytes: FULL_RESTORE_DUMP_HARD_LIMITS_V1.maxBytes,
        maxRelations: FULL_RESTORE_DUMP_HARD_LIMITS_V1.maxRelations,
      }),
    ).toBe('NO_ERROR');
    expect(code(bytes, { maxBytes: 1 << 20, maxRelations: 1 })).toBe('DUMP_BOUND_EXCEEDED');
  });
  it('validates pg_dump run limits before spawning (P27-p2a-2)', async () => {
    const base = {
      pgDumpPath: '/nonexistent/bin/pg_dump',
      snapshotId: '00000003-00000002-1',
      connection: { host: '127.0.0.1', user: 'x', database: 'y' },
      maxBytes: 1 << 20,
      timeoutMs: 1000,
    };
    for (const bad of [
      { maxBytes: Infinity },
      { maxBytes: Number.NaN },
      { maxBytes: 0 },
      { maxBytes: FULL_RESTORE_DUMP_HARD_LIMITS_V1.maxBytes + 1 },
      { timeoutMs: Infinity },
      { timeoutMs: -1 },
      { timeoutMs: 0.5 },
      { timeoutMs: FULL_RESTORE_DUMP_HARD_LIMITS_V1.timeoutMs + 1 },
    ])
      await expect(runSnapshotDataDumpV1({ ...base, ...bad })).rejects.toMatchObject({
        code: 'DUMP_INPUT_INVALID',
      });
    // Valid limits reach the spawn, which fails for the absent binary.
    await expect(runSnapshotDataDumpV1(base)).rejects.toMatchObject({
      code: 'DUMP_EXECUTION_FAILED',
    });
  });
});

describe('committed expected structure census', () => {
  const expectedBytes = new Uint8Array(
    readFileSync(
      new URL('../src/full-restore-expected-structure-v1/expected-structure.json', import.meta.url),
    ),
  );
  const EXPECTED_SHA256 = '1d26190fb4c0ea29e111675b224d6cd73097df1c8ee622e63186de3b897cd949';
  type Census = FullRestoreStructureV1 & {
    relations: {
      schema: string;
      relation: string;
      columns: {
        attnum: number;
        name: string;
        notNull: boolean;
        typmod: number;
        typeText: string;
      }[];
      constraints: { type: string; key: string[] | null }[];
    }[];
  };
  it('is pinned and matches the independently drafted source roster for every relation', () => {
    expect(createHash('sha256').update(expectedBytes).digest('hex')).toBe(EXPECTED_SHA256);
    const census = JSON.parse(Buffer.from(expectedBytes).toString('utf8')) as Census;
    const roster = JSON.parse(
      readFileSync(
        new URL('../src/full-restore-native-catalog-v2/source-owned-roster.json', import.meta.url),
        'utf8',
      ),
    ) as {
      tables: {
        schema: string;
        relation: string;
        orderingKey: string[];
        columns: {
          position: number;
          name: string;
          type: string;
          typmod: number;
          nullable: boolean;
        }[];
      }[];
    };
    expect(census.relations).toHaveLength(239);
    roster.tables.forEach((table, index) => {
      const relation = census.relations[index];
      expect(relation && `${relation.schema}.${relation.relation}`).toBe(
        `${table.schema}.${table.relation}`,
      );
      expect(
        relation?.columns.map((c) => [c.attnum, c.name, !c.notNull, c.typmod, c.typeText]),
      ).toEqual(table.columns.map((c) => [c.position, c.name, c.nullable, c.typmod, c.type]));
      expect(relation?.constraints.find((k) => k.type === 'p')?.key).toEqual(table.orderingKey);
    });
  });
  it('comparator requires the pin and reports precise differences', () => {
    expect(() =>
      createFullRestoreStructureComparatorV1({ expectedBytes, expectedSha256: '0'.repeat(64) }),
    ).toThrow(FullRestoreStructureErrorV1);
    const comparator = createFullRestoreStructureComparatorV1({
      expectedBytes,
      expectedSha256: EXPECTED_SHA256,
    });
    const actual = JSON.parse(Buffer.from(expectedBytes).toString('utf8')) as Census;
    expect(comparator.compare(actual)).toMatchObject({ matched: true, relationCount: 239 });
    const first = actual.relations[0];
    if (!first?.columns[0]) throw new Error('fixture');
    first.columns[0].notNull = !first.columns[0].notNull;
    const result = comparator.compare(actual);
    expect(result.matched).toBe(false);
    expect(result.differences).toEqual(['/relations/0/columns/0/notNull']);
    expect(result.admissionAllowed).toBe(false);
  });
  it('binds every trigger routine and detects body or security drift under one signature (P27-p2a-3)', () => {
    type Routine = { securityDefiner: boolean; bodySha256: string; config: string[] | null };
    const census = JSON.parse(Buffer.from(expectedBytes).toString('utf8')) as {
      method: string;
      relations: { triggers: { function: string; routine: Routine }[] }[];
    };
    expect(census.method).toBe(
      'pg17-normalized-node-tree-v1+policy-deparse-text+trigger-routine-v1',
    );
    const triggers = census.relations.flatMap((r) => r.triggers);
    expect(triggers.length).toBeGreaterThan(0);
    for (const t of triggers) {
      expect(t.routine.bodySha256).toMatch(/^[a-f0-9]{64}$/);
      expect(t.routine.config).not.toBeNull();
    }
    // The same function always carries the same routine facts.
    const byFunction = new Map<string, string>();
    for (const t of triggers) {
      const facts = JSON.stringify(t.routine);
      expect(byFunction.get(t.function) ?? facts).toBe(facts);
      byFunction.set(t.function, facts);
    }
    const comparator = createFullRestoreStructureComparatorV1({
      expectedBytes,
      expectedSha256: EXPECTED_SHA256,
    });
    const index = census.relations.findIndex((r) => r.triggers.length > 0);
    for (const [field, change] of [
      ['bodySha256', (r: Routine) => (r.bodySha256 = 'f'.repeat(64))],
      ['securityDefiner', (r: Routine) => (r.securityDefiner = !r.securityDefiner)],
    ] as const) {
      const actual = JSON.parse(Buffer.from(expectedBytes).toString('utf8')) as typeof census;
      const routine = actual.relations[index]?.triggers[0]?.routine;
      if (!routine) throw new Error('fixture');
      change(routine);
      const result = comparator.compare(actual as unknown as FullRestoreStructureV1);
      expect(result.differences).toEqual([`/relations/${index}/triggers/0/routine/${field}`]);
    }
    // A census without routine binding (the previous method) is not accepted as expected input.
    const old = JSON.parse(Buffer.from(expectedBytes).toString('utf8')) as typeof census;
    old.method = 'pg17-normalized-node-tree-v1+policy-deparse-text';
    const oldBytes = new Uint8Array(Buffer.from(JSON.stringify(old)));
    expect(() =>
      createFullRestoreStructureComparatorV1({
        expectedBytes: oldBytes,
        expectedSha256: createHash('sha256').update(oldBytes).digest('hex'),
      }),
    ).toThrow(FullRestoreStructureErrorV1);
  });
});
