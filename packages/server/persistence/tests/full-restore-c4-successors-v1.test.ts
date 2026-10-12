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
  FullRestoreDumpCorrespondenceErrorV1,
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
});

describe('committed expected structure census', () => {
  const expectedBytes = new Uint8Array(
    readFileSync(
      new URL('../src/full-restore-expected-structure-v1/expected-structure.json', import.meta.url),
    ),
  );
  const EXPECTED_SHA256 = 'd4fe6ab8595fc8dcd071097cf1a3962738b4fc4af241a4b1cc644c92371a32b9';
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
});
