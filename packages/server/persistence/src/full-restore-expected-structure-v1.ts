import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  bindPg17NodeTreeV1,
  canonicalPg17Json,
  decodePg17NodeTreeV1,
  Pg17NodeDecodeError,
  type DecodedPg17NodeTreeV1,
  type Pg17BindingColumnV1,
  type Pg17CatalogSnapshotV1,
} from './full-restore-pg17-node-decoder-v1.js';

/**
 * OID-free structure census for the full-restore relation roster (EXT-RESTOREa C4).
 *
 * Captures, in the caller's REPEATABLE READ READ ONLY transaction, every
 * relation's columns, defaults, constraints, non-internal triggers (with WHEN),
 * indexes and RLS policies, then replaces OIDs with catalog identities from the
 * SAME snapshot. DEFAULT/CHECK/WHEN/index expressions are compared as decoded
 * and catalog-bound PG17 node trees (normalized SHA). Policy expressions contain
 * query nodes the decoder does not support; they are compared by
 * `pg_get_expr` deparse text only and labelled as such.
 *
 * The expected census is a committed, SHA-pinned file generated from a clean
 * install of the reviewed migrations (not from an archive or the target under
 * test). Equality yields structure facts only: authority none, no admission.
 */
export class FullRestoreStructureErrorV1 extends Error {
  constructor(
    readonly code:
      | 'STRUCTURE_INPUT_INVALID'
      | 'STRUCTURE_EXPECTED_INVALID'
      | 'STRUCTURE_REPLY_INVALID'
      | 'STRUCTURE_RELATION_MISSING'
      | 'STRUCTURE_ROLE_UNMAPPED'
      | 'STRUCTURE_EXPRESSION_UNSUPPORTED'
      | 'STRUCTURE_TRANSACTION_INVALID',
    readonly detail?: string,
  ) {
    super(code);
    this.name = 'FullRestoreStructureErrorV1';
  }
}
const fail = (code: FullRestoreStructureErrorV1['code'], detail?: string): never => {
  throw new FullRestoreStructureErrorV1(code, detail);
};

export interface FullRestoreStructureQueryPortV1 {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

const RELATIONS_SQL = `WITH wanted AS (
 SELECT u.ord,split_part(u.q,'.',1) AS s,split_part(u.q,'.',2) AS r FROM unnest($1::text[]) WITH ORDINALITY u(q,ord)),
rel AS (SELECT w.ord,w.s,w.r,c.oid,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,c.relowner
 FROM wanted w LEFT JOIN pg_catalog.pg_namespace n ON n.nspname=w.s
 LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=w.r)
SELECT pg_catalog.jsonb_build_object('schema',rel.s,'relation',rel.r,'present',rel.oid IS NOT NULL,
 'relkind',rel.relkind,'persistence',rel.relpersistence,'rls',rel.relrowsecurity,'forceRls',rel.relforcerowsecurity,
 'droppedColumns',(SELECT count(*) FROM pg_catalog.pg_attribute a WHERE a.attrelid=rel.oid AND a.attnum>0 AND a.attisdropped),
 'columns',(SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('attnum',a.attnum,'name',a.attname,
   'typeOid',a.atttypid::bigint,'typmod',a.atttypmod,'notNull',a.attnotnull,'collationOid',a.attcollation::bigint,
   'identity',a.attidentity,'generated',a.attgenerated,'typeText',pg_catalog.format_type(a.atttypid,a.atttypmod),
   'default',d.adbin::text) ORDER BY a.attnum),'[]'::jsonb)
  FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE a.attrelid=rel.oid AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',k.conname,'type',k.contype,
   'deferrable',k.condeferrable,'deferred',k.condeferred,'validated',k.convalidated,'noInherit',k.connoinherit,
   'key',(SELECT pg_catalog.jsonb_agg(a.attname ORDER BY u.o) FROM unnest(k.conkey) WITH ORDINALITY u(n,o)
     JOIN pg_catalog.pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=u.n),
   'foreignSchema',fn.nspname,'foreignRelation',fc.relname,
   'foreignKey',(SELECT pg_catalog.jsonb_agg(a.attname ORDER BY u.o) FROM unnest(k.confkey) WITH ORDINALITY u(n,o)
     JOIN pg_catalog.pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=u.n),
   'update',k.confupdtype,'delete',k.confdeltype,'match',k.confmatchtype,'expression',k.conbin::text,'index',ic.relname)
   ORDER BY k.conname,k.contype),'[]'::jsonb)
  FROM pg_catalog.pg_constraint k LEFT JOIN pg_catalog.pg_class fc ON fc.oid=k.confrelid
  LEFT JOIN pg_catalog.pg_namespace fn ON fn.oid=fc.relnamespace LEFT JOIN pg_catalog.pg_class ic ON ic.oid=k.conindid
  WHERE k.conrelid=rel.oid),
 'triggers',(SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',t.tgname,'type',t.tgtype,
   'enabled',t.tgenabled,'deferrable',t.tgdeferrable,'initDeferred',t.tginitdeferred,
   'constraint',(SELECT k.conname FROM pg_catalog.pg_constraint k WHERE k.oid=t.tgconstraint),
   'function',pn.nspname||'.'||p.proname||'('||pg_catalog.oidvectortypes(p.proargtypes)||')',
   'arguments',pg_catalog.encode(t.tgargs,'hex'),
   'columns',(SELECT pg_catalog.jsonb_agg(a.attname ORDER BY u.o) FROM unnest(t.tgattr::int2[]) WITH ORDINALITY u(n,o)
     JOIN pg_catalog.pg_attribute a ON a.attrelid=t.tgrelid AND a.attnum=u.n),
   'when',t.tgqual::text,'oldTable',t.tgoldtable,'newTable',t.tgnewtable) ORDER BY t.tgname),'[]'::jsonb)
  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
  WHERE t.tgrelid=rel.oid AND NOT t.tgisinternal),
 'indexes',(SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',ic.relname,'method',am.amname,
   'unique',i.indisunique,'primary',i.indisprimary,'nullsNotDistinct',i.indnullsnotdistinct,'immediate',i.indimmediate,
   'keyAttributes',i.indnkeyatts,
   'keys',(SELECT pg_catalog.jsonb_agg(a.attname ORDER BY u.o) FROM unnest(i.indkey::int2[]) WITH ORDINALITY u(n,o)
     LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=u.n),
   'opclasses',(SELECT pg_catalog.jsonb_agg(cn.nspname||'.'||oc.opcname ORDER BY u.o) FROM unnest(i.indclass::oid[]) WITH ORDINALITY u(c,o)
     JOIN pg_catalog.pg_opclass oc ON oc.oid=u.c JOIN pg_catalog.pg_namespace cn ON cn.oid=oc.opcnamespace),
   'collations',(SELECT pg_catalog.jsonb_agg(CASE WHEN u.c=0 THEN NULL ELSE cn.nspname||'.'||co.collname END ORDER BY u.o)
     FROM unnest(i.indcollation::oid[]) WITH ORDINALITY u(c,o) LEFT JOIN pg_catalog.pg_collation co ON co.oid=u.c
     LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=co.collnamespace),
   'options',pg_catalog.to_jsonb(i.indoption::int2[]),'expressions',i.indexprs::text,'predicate',i.indpred::text)
   ORDER BY ic.relname),'[]'::jsonb)
  FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid JOIN pg_catalog.pg_am am ON am.oid=ic.relam
  WHERE i.indrelid=rel.oid),
 'policies',(SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',p.polname,'command',p.polcmd,
   'permissive',p.polpermissive,
   'roles',(SELECT pg_catalog.jsonb_agg(CASE WHEN u.r=0 THEN 'PUBLIC' WHEN u.r=rel.relowner THEN '$owner' ELSE 'unmapped' END ORDER BY u.r)
     FROM unnest(p.polroles) u(r)),
   'using',pg_catalog.pg_get_expr(p.polqual,p.polrelid),'withCheck',pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid))
   ORDER BY p.polname),'[]'::jsonb)
  FROM pg_catalog.pg_policy p WHERE p.polrelid=rel.oid)
) AS relation FROM rel ORDER BY rel.ord`;

const CATALOG_SQL = `WITH ops AS (SELECT * FROM pg_catalog.pg_operator WHERE oid=ANY($3::oid[])),
procs AS (SELECT * FROM pg_catalog.pg_proc WHERE oid=ANY($4::oid[]) OR oid IN (SELECT oprcode FROM ops)),
typeset AS (SELECT unnest($1::oid[]) AS oid UNION SELECT oprleft FROM ops UNION SELECT oprright FROM ops
 UNION SELECT oprresult FROM ops UNION SELECT prorettype FROM procs UNION SELECT unnest(proargtypes::oid[]) FROM procs)
SELECT pg_catalog.jsonb_build_object(
 'types',(SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('oid',t.oid::bigint,'schema',n.nspname,
   'name',t.typname,'typlen',t.typlen,'typbyval',t.typbyval,'typtype',t.typtype) ORDER BY t.oid),'[]'::jsonb)
  FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE t.oid IN (SELECT oid FROM typeset)),
 'collations',(SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('oid',c.oid::bigint,'schema',n.nspname,
   'name',c.collname) ORDER BY c.oid),'[]'::jsonb)
  FROM pg_catalog.pg_collation c JOIN pg_catalog.pg_namespace n ON n.oid=c.collnamespace WHERE c.oid=ANY($2::oid[])),
 'operators',(SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('oid',o.oid::bigint,'schema',n.nspname,
   'name',o.oprname,'left',o.oprleft::bigint,'right',o.oprright::bigint,'result',o.oprresult::bigint,'code',o.oprcode::oid::bigint)
   ORDER BY o.oid),'[]'::jsonb) FROM ops o JOIN pg_catalog.pg_namespace n ON n.oid=o.oprnamespace),
 'procedures',(SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('oid',p.oid::bigint,'schema',n.nspname,
   'name',p.proname,'args',(SELECT coalesce(pg_catalog.jsonb_agg(a::bigint ORDER BY o),'[]'::jsonb)
     FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY u(a,o)),
   'result',p.prorettype::bigint,'retset',p.proretset,'variadic',p.provariadic::bigint) ORDER BY p.oid),'[]'::jsonb)
  FROM procs p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace)
) AS catalog`;
export const fullRestoreStructureQuerySha256V1 = createHash('sha256')
  .update(RELATIONS_SQL)
  .update('\0')
  .update(CATALOG_SQL)
  .digest('hex');

const name = z.string().min(1).max(63);
const nullableText = z.string().max(1048576).nullable();
const char = z.string().max(1);
const rawColumn = z.strictObject({
  attnum: z.number().int().min(1).max(1600),
  name,
  typeOid: z.number().int().min(1),
  typmod: z.number().int(),
  notNull: z.boolean(),
  collationOid: z.number().int().min(0),
  identity: char,
  generated: char,
  typeText: z.string().max(1024),
  default: nullableText,
});
const nameList = z.array(name).nullable();
const rawRelation = z.strictObject({
  schema: name,
  relation: name,
  present: z.boolean(),
  relkind: char.nullable(),
  persistence: char.nullable(),
  rls: z.boolean().nullable(),
  forceRls: z.boolean().nullable(),
  droppedColumns: z.number().int().min(0),
  columns: z.array(rawColumn),
  constraints: z.array(
    z.strictObject({
      name,
      type: char,
      deferrable: z.boolean(),
      deferred: z.boolean(),
      validated: z.boolean(),
      noInherit: z.boolean(),
      key: nameList,
      foreignSchema: name.nullable(),
      foreignRelation: name.nullable(),
      foreignKey: nameList,
      update: char,
      delete: char,
      match: char,
      expression: nullableText,
      index: name.nullable(),
    }),
  ),
  triggers: z.array(
    z.strictObject({
      name,
      type: z.number().int(),
      enabled: char,
      deferrable: z.boolean(),
      initDeferred: z.boolean(),
      constraint: name.nullable(),
      function: z.string().max(4096),
      arguments: z.string().max(65536),
      columns: nameList,
      when: nullableText,
      oldTable: name.nullable(),
      newTable: name.nullable(),
    }),
  ),
  indexes: z.array(
    z.strictObject({
      name,
      method: name,
      unique: z.boolean(),
      primary: z.boolean(),
      nullsNotDistinct: z.boolean(),
      immediate: z.boolean(),
      keyAttributes: z.number().int(),
      keys: z.array(name.nullable()),
      opclasses: z.array(z.string().max(200)),
      collations: z.array(z.string().max(200).nullable()),
      options: z.array(z.number().int()),
      expressions: nullableText,
      predicate: nullableText,
    }),
  ),
  policies: z.array(
    z.strictObject({
      name,
      command: char,
      permissive: z.boolean(),
      roles: z.array(z.string().max(64)),
      using: nullableText,
      withCheck: nullableText,
    }),
  ),
});
type RawRelation = z.infer<typeof rawRelation>;
const oid = z.number().int().min(1).max(4294967295);
const catalogSchema = z.strictObject({
  types: z.array(
    z.strictObject({
      oid,
      schema: name,
      name,
      typlen: z.number().int(),
      typbyval: z.boolean(),
      typtype: char,
    }),
  ),
  collations: z.array(z.strictObject({ oid, schema: name, name })),
  operators: z.array(
    z.strictObject({
      oid,
      schema: name,
      name: z.string().min(1).max(63),
      left: z.number().int().min(0),
      right: z.number().int().min(0),
      result: z.number().int().min(0),
      code: z.number().int().min(0),
    }),
  ),
  procedures: z.array(
    z.strictObject({
      oid,
      schema: name,
      name,
      args: z.array(z.number().int().min(1)),
      result: z.number().int().min(1),
      retset: z.boolean(),
      variadic: z.number().int().min(0),
    }),
  ),
});

const textSha = (text: string | null) =>
  text === null ? null : createHash('sha256').update(text, 'utf8').digest('hex');

export type FullRestoreStructureV1 = Readonly<{
  schemaVersion: 1;
  method: 'pg17-normalized-node-tree-v1+policy-deparse-text';
  relations: readonly unknown[];
}>;

/**
 * Capture inside an already-open REPEATABLE READ READ ONLY transaction. The
 * relation list is the independently registered roster, in roster order.
 */
export async function captureFullRestoreStructureV1(
  tx: FullRestoreStructureQueryPortV1,
  relations: readonly { schema: string; relation: string }[],
): Promise<FullRestoreStructureV1> {
  if (!Array.isArray(relations) || relations.length < 1 || relations.length > 1000)
    fail('STRUCTURE_INPUT_INVALID');
  const names = relations.map((r) => {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(r.schema) || !/^[a-z_][a-z0-9_]{0,62}$/.test(r.relation))
      fail('STRUCTURE_INPUT_INVALID');
    return `${r.schema}.${r.relation}`;
  });
  if (new Set(names).size !== names.length) fail('STRUCTURE_INPUT_INVALID');
  const isolation = await tx.query(
    "SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only",
  );
  if (
    isolation.rows[0]?.['isolation'] !== 'repeatable read' ||
    isolation.rows[0]?.['read_only'] !== 'on'
  )
    fail('STRUCTURE_TRANSACTION_INVALID');
  const reply = await tx.query(RELATIONS_SQL, [names]);
  if (reply.rows.length !== names.length) fail('STRUCTURE_REPLY_INVALID');
  const raw: RawRelation[] = reply.rows.map((row, index) => {
    const parsed = rawRelation.safeParse(row['relation']);
    if (!parsed.success) return fail('STRUCTURE_REPLY_INVALID');
    if (`${parsed.data.schema}.${parsed.data.relation}` !== names[index])
      fail('STRUCTURE_REPLY_INVALID');
    if (!parsed.data.present) fail('STRUCTURE_RELATION_MISSING', names[index]);
    return parsed.data;
  });
  // Decode every expression first so the catalog query is bounded to referenced OIDs.
  const decoded = new Map<string, DecodedPg17NodeTreeV1>();
  const decode = (text: string | null, where: string) => {
    if (text === null) return;
    try {
      decoded.set(text, decoded.get(text) ?? decodePg17NodeTreeV1(text));
    } catch (error) {
      if (error instanceof Pg17NodeDecodeError)
        fail('STRUCTURE_EXPRESSION_UNSUPPORTED', `${where}:${error.code}`);
      throw error;
    }
  };
  const typeOids = new Set<number>(),
    collationOids = new Set<number>(),
    operatorOids = new Set<number>(),
    procedureOids = new Set<number>();
  for (const relation of raw) {
    const where = `${relation.schema}.${relation.relation}`;
    for (const column of relation.columns) {
      typeOids.add(column.typeOid);
      if (column.collationOid !== 0) collationOids.add(column.collationOid);
      decode(column.default, `${where}.${column.name}`);
    }
    for (const constraint of relation.constraints) decode(constraint.expression, where);
    for (const trigger of relation.triggers) decode(trigger.when, where);
    for (const index of relation.indexes) {
      decode(index.expressions, where);
      decode(index.predicate, where);
    }
  }
  for (const tree of decoded.values())
    for (const reference of tree.references)
      ({
        pg_type: typeOids,
        pg_collation: collationOids,
        pg_operator: operatorOids,
        pg_proc: procedureOids,
      })[reference.catalog].add(reference.oid);
  const catalogReply = await tx.query(CATALOG_SQL, [
    [...typeOids],
    [...collationOids],
    [...operatorOids],
    [...procedureOids],
  ]);
  const parsedCatalog = catalogSchema.safeParse(catalogReply.rows[0]?.['catalog']);
  if (catalogReply.rows.length !== 1 || !parsedCatalog.success)
    return fail('STRUCTURE_REPLY_INVALID');
  const catalog: Pg17CatalogSnapshotV1 = parsedCatalog.data;
  const types = new Map(catalog.types.map((t) => [t.oid, `${t.schema}.${t.name}`]));
  const collations = new Map(catalog.collations.map((c) => [c.oid, `${c.schema}.${c.name}`]));
  const bound = (
    text: string | null,
    columns: readonly Pg17BindingColumnV1[],
    scope: 'relation' | 'trigger',
    where: string,
  ) => {
    if (text === null) return null;
    const tree = decoded.get(text);
    if (!tree) return fail('STRUCTURE_REPLY_INVALID');
    try {
      return bindPg17NodeTreeV1(tree, catalog, { scope, columns }).normalizedSha256;
    } catch (error) {
      if (error instanceof Pg17NodeDecodeError)
        fail('STRUCTURE_EXPRESSION_UNSUPPORTED', `${where}:${error.code}`);
      throw error;
    }
  };
  const normalized = raw.map((relation) => {
    const where = `${relation.schema}.${relation.relation}`;
    const columns: Pg17BindingColumnV1[] = relation.columns.map((c) => ({
      attnum: c.attnum,
      name: c.name,
      typeOid: c.typeOid,
      typmod: c.typmod,
      collationOid: c.collationOid,
    }));
    for (const policy of relation.policies)
      if (policy.roles.includes('unmapped')) fail('STRUCTURE_ROLE_UNMAPPED', where);
    const typeName = (o: number) => types.get(o) ?? fail('STRUCTURE_REPLY_INVALID');
    return {
      schema: relation.schema,
      relation: relation.relation,
      relkind: relation.relkind,
      persistence: relation.persistence,
      rls: relation.rls,
      forceRls: relation.forceRls,
      droppedColumns: relation.droppedColumns,
      columns: relation.columns.map((c) => ({
        attnum: c.attnum,
        name: c.name,
        type: typeName(c.typeOid),
        typeText: c.typeText,
        typmod: c.typmod,
        notNull: c.notNull,
        collation:
          c.collationOid === 0
            ? null
            : (collations.get(c.collationOid) ?? fail('STRUCTURE_REPLY_INVALID')),
        identity: c.identity,
        generated: c.generated,
        default: bound(c.default, columns, 'relation', `${where}.${c.name}`),
      })),
      constraints: relation.constraints.map((k) => ({
        ...k,
        expression: bound(k.expression, columns, 'relation', `${where}.${k.name}`),
      })),
      triggers: relation.triggers.map((t) => ({
        ...t,
        when: bound(t.when, columns, 'trigger', `${where}.${t.name}`),
      })),
      indexes: relation.indexes.map((i) => ({
        ...i,
        expressions: bound(i.expressions, columns, 'relation', `${where}.${i.name}`),
        predicate: bound(i.predicate, columns, 'relation', `${where}.${i.name}`),
      })),
      policies: relation.policies.map((p) => ({
        ...p,
        using: textSha(p.using),
        withCheck: textSha(p.withCheck),
      })),
    };
  });
  return Object.freeze({
    schemaVersion: 1,
    method: 'pg17-normalized-node-tree-v1+policy-deparse-text',
    relations: JSON.parse(canonicalPg17Json(normalized)) as unknown[],
  });
}

export type FullRestoreStructureComparisonV1 = Readonly<{
  kind: 'full_restore_structure_comparison_v1';
  matched: boolean;
  expectedSha256: string;
  actualSha256: string;
  relationCount: number;
  differences: readonly string[];
  authority: 'none';
  admissionAllowed: false;
  policyExpressions: 'deparse_text_only';
  datumInterpretation: 'not_performed';
}>;

export function fullRestoreStructureSha256V1(structure: FullRestoreStructureV1): string {
  return createHash('sha256').update(canonicalPg17Json(structure)).digest('hex');
}

function diff(expected: unknown, actual: unknown, path: string, out: string[]) {
  if (out.length >= 64) return;
  if (canonicalPg17Json(expected) === canonicalPg17Json(actual)) return;
  if (
    expected !== null &&
    actual !== null &&
    typeof expected === 'object' &&
    typeof actual === 'object' &&
    Array.isArray(expected) === Array.isArray(actual)
  ) {
    if (Array.isArray(expected) && Array.isArray(actual) && expected.length !== actual.length) {
      out.push(`${path}:length`);
      return;
    }
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of [...keys].sort())
      diff(
        (expected as Record<string, unknown>)[key],
        (actual as Record<string, unknown>)[key],
        `${path}/${key}`,
        out,
      );
    return;
  }
  out.push(path);
}

/** Expected bytes and their pin are supplied by the caller from reviewed source. */
export function createFullRestoreStructureComparatorV1(input: {
  readonly expectedBytes: Uint8Array;
  readonly expectedSha256: string;
}) {
  if (
    !(input.expectedBytes instanceof Uint8Array) ||
    !/^[a-f0-9]{64}$/.test(input.expectedSha256) ||
    createHash('sha256').update(input.expectedBytes).digest('hex') !== input.expectedSha256
  )
    fail('STRUCTURE_EXPECTED_INVALID');
  let expected: FullRestoreStructureV1;
  try {
    expected = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.expectedBytes));
  } catch {
    return fail('STRUCTURE_EXPECTED_INVALID');
  }
  if (
    expected.schemaVersion !== 1 ||
    expected.method !== 'pg17-normalized-node-tree-v1+policy-deparse-text' ||
    !Array.isArray(expected.relations)
  )
    fail('STRUCTURE_EXPECTED_INVALID');
  const expectedText = canonicalPg17Json(expected);
  const expectedSha256 = createHash('sha256').update(expectedText).digest('hex');
  const frozen = JSON.parse(expectedText) as FullRestoreStructureV1;
  return Object.freeze({
    relations: Object.freeze(
      (frozen.relations as { schema: string; relation: string }[]).map((r) =>
        Object.freeze({ schema: r.schema, relation: r.relation }),
      ),
    ),
    compare(actual: FullRestoreStructureV1): FullRestoreStructureComparisonV1 {
      const differences: string[] = [];
      diff(frozen, actual, '', differences);
      return Object.freeze({
        kind: 'full_restore_structure_comparison_v1',
        matched: differences.length === 0,
        expectedSha256,
        actualSha256: fullRestoreStructureSha256V1(actual),
        relationCount: frozen.relations.length,
        differences: Object.freeze(differences),
        authority: 'none',
        admissionAllowed: false,
        policyExpressions: 'deparse_text_only',
        datumInterpretation: 'not_performed',
      });
    },
  });
}
