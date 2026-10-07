import { z } from 'zod';

/** Caller owns an actual READ ONLY RR/serializable transaction; this port changes no role/GUC. */
export interface CurrentSourceCaptureTransaction {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}
const limit = 16 * 1024 * 1024;
const identifier = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const decimal = z
  .string()
  .max(20)
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine((v) => BigInt(v) <= 18446744073709551615n);
const oid = decimal.refine((v) => BigInt(v) > 0n && BigInt(v) <= 4294967295n);
const text = z.string().max(limit);
const nullableText = text.nullable();
const role = z.strictObject({ tag: identifier, name: identifier });
const relationIdentity = z.strictObject({ schema: identifier, name: identifier });
const normalRegistry = z
  .array(z.strictObject({ version: z.number().int().min(1).max(107), checksum: hash }))
  .length(107)
  .refine((rows) => rows.every((row, i) => row.version === i + 1));
const explicitPins = z
  .array(z.strictObject({ version: z.number().int().min(108).max(116), checksum: hash }))
  .length(9)
  .refine((rows) => rows.every((r, i) => r.version === 108 + i));
const expectedBaseSchema = z.strictObject({
  profileVersion: z.literal(1),
  normalSchemaVersion: z.literal(107),
  explicitPins,
  normalRegistry,
  schemas: z.array(identifier).min(1).max(16),
  relations: z.array(relationIdentity).min(1).max(1000),
  roles: z.array(role).min(1).max(64),
  source: z.strictObject({
    databaseName: identifier,
    databaseOid: oid,
    systemIdentifier: decimal.refine((v) => BigInt(v) > 0n && BigInt(v) <= 18446744073709551615n),
  }),
  operator: z.strictObject({
    roleName: identifier,
    roleOid: oid,
    superuser: z.boolean(),
    bypassRls: z.boolean(),
  }),
});
export const currentSourceCatalogExpectedSchema = expectedBaseSchema
  .extend({ catalogSha256: hash })
  .strict();
export type CurrentSourceCatalogExpected = z.infer<typeof currentSourceCatalogExpectedSchema>;
export type CurrentSourceCatalogProfile = z.infer<typeof expectedBaseSchema>;
const acl = z
  .array(z.strictObject({ grantee: text, grantor: text, privilege: text, grantable: z.boolean() }))
  .max(1000);
const column = z.strictObject({
  name: identifier,
  type: text,
  notNull: z.boolean(),
  identity: text,
  generated: text,
  default: nullableText,
  rawAcl: nullableText,
  acl,
});
const constraint = z.strictObject({
  name: identifier,
  kind: text,
  definition: text,
  validated: z.boolean(),
  deferrable: z.boolean(),
  deferred: z.boolean(),
});
const trigger = z.strictObject({
  name: identifier,
  definition: text,
  enabled: text,
  constraint: z.boolean(),
  deferrable: z.boolean(),
  deferred: z.boolean(),
  function: text,
});
const policy = z.strictObject({
  name: identifier,
  command: text,
  permissive: z.boolean(),
  roles: z.array(text).max(64),
  qual: nullableText,
  check: nullableText,
});
const sequence = z.strictObject({
  type: text,
  start: decimal.or(z.string().regex(/^-?[1-9][0-9]*$/)),
  increment: text,
  max: text,
  min: text,
  cache: text,
  cycle: z.boolean(),
  links: z
    .array(
      z.strictObject({ schema: identifier, table: identifier, column: identifier, kind: text }),
    )
    .max(1000),
});
const catalogSchema = z.strictObject({
  database: z.strictObject({
    owner: text,
    encoding: text,
    collation: text,
    ctype: text,
    locale: nullableText,
    collationVersion: nullableText,
    allowConnections: z.boolean(),
    connectionLimit: z.number().int(),
    rawAcl: nullableText,
    acl,
  }),
  defaultPrivileges: z
    .array(z.strictObject({ owner: text, schema: nullableText, kind: text, rawAcl: text, acl }))
    .max(1000),
  schemas: z
    .array(z.strictObject({ name: identifier, owner: text, rawAcl: nullableText, acl }))
    .max(16),
  relations: z
    .array(
      z.strictObject({
        schema: identifier,
        name: identifier,
        kind: z.enum(['r', 'p', 'S', 'i', 'I']),
        owner: text,
        rls: z.boolean(),
        force: z.boolean(),
        persistence: text,
        partitionBound: nullableText,
        rawAcl: nullableText,
        acl,
        columns: z.array(column).max(256),
        constraints: z.array(constraint).max(256),
        triggers: z.array(trigger).max(256),
        policies: z.array(policy).max(256),
        index: nullableText,
        sequence: sequence.nullable(),
      }),
    )
    .max(4096),
  functions: z
    .array(
      z.strictObject({
        schema: identifier,
        name: identifier,
        arguments: text,
        returns: text,
        owner: text,
        language: identifier,
        securityDefiner: z.boolean(),
        strict: z.boolean(),
        leakproof: z.boolean(),
        volatility: text,
        parallel: text,
        config: z.array(text).max(64).nullable(),
        definition: text,
        rawAcl: nullableText,
        acl,
      }),
    )
    .max(4096),
  extensions: z
    .array(
      z.strictObject({
        name: identifier,
        version: text,
        schema: identifier,
        owner: text,
        members: z
          .array(z.strictObject({ identity: text, owner: nullableText, definition: text }))
          .max(10000),
      }),
    )
    .max(64),
  roles: z
    .array(
      z.strictObject({
        tag: identifier,
        name: identifier,
        oid,
        superuser: z.boolean(),
        bypassRls: z.boolean(),
        inherit: z.boolean(),
        createDb: z.boolean(),
        createRole: z.boolean(),
        login: z.boolean(),
        replication: z.boolean(),
        connectionLimit: z.number().int(),
        config: z.array(text).max(64).nullable(),
        memberships: z
          .array(
            z.strictObject({
              role: text,
              member: text,
              grantor: text,
              adminOption: z.boolean(),
              inheritOption: z.boolean().nullable(),
              setOption: z.boolean().nullable(),
            }),
          )
          .max(1000),
      }),
    )
    .max(64),
  registry: normalRegistry,
});
export type CurrentSourceCatalogMetadata = z.infer<typeof catalogSchema>;
const snapshotSchema = z.strictObject({
  transactionSnapshot: z.string().regex(/^[0-9]+:[0-9]+:[0-9,]*$/),
  isolation: z.enum(['repeatable read', 'serializable']),
  readOnly: z.literal(true),
  roleName: identifier,
  roleOid: oid,
  statementTimeout: z.string().min(1).max(32),
});
const censusSchema = z
  .array(
    z.strictObject({
      schema: identifier,
      relation: identifier,
      rows: decimal,
      rowStorageBytes: decimal,
    }),
  )
  .max(1000);
export type CurrentSourceCatalogCapture = Readonly<{
  source: CurrentSourceCatalogProfile['source'];
  snapshot: z.infer<typeof snapshotSchema>;
  profile: Readonly<{
    profileVersion: 1;
    normalSchemaVersion: 107;
    explicitPins: CurrentSourceCatalogProfile['explicitPins'];
  }>;
  catalog: CurrentSourceCatalogMetadata;
  catalogSha256: string;
  census: z.infer<typeof censusSchema>;
  byteAccounting: Readonly<{
    catalogBytes: string;
    censusBytes: number;
    rowStorageBytes: string;
    meaning: 'pg_column_size_not_transport';
  }>;
  observation: 'actual_same_snapshot_metadata_and_counts';
  authentication: 'not_captured';
  authority: 'none';
  admissionAllowed: false;
  limits: Readonly<{
    sequenceCurrentValues: 'not_captured_non_mvcc';
    sourceSignature: 'not_captured';
    archive: 'not_captured';
    tailBoundary: 'not_captured';
  }>;
}>;
export class CurrentSourceCatalogError extends Error {
  constructor(
    readonly code:
      | 'INVALID_PROFILE'
      | 'SOURCE_CONTEXT_MISMATCH'
      | 'SOURCE_VISIBILITY_UNAVAILABLE'
      | 'CATALOG_MISMATCH'
      | 'CATALOG_LIMIT'
      | 'CATALOG_UNSUPPORTED'
      | 'CENSUS_LIMIT',
  ) {
    super(code);
  }
}
function reject(code: CurrentSourceCatalogError['code']): never {
  throw new CurrentSourceCatalogError(code);
}
function boundedPlain(value: unknown): void {
  let visits = 0,
    bytes = 0;
  const active = new WeakSet<object>();
  function visit(v: unknown, depth: number): void {
    if (++visits > limit || depth > 64) reject('CATALOG_LIMIT');
    bytes += typeof v === 'string' ? Buffer.byteLength(v, 'utf8') : 1;
    if (bytes > limit) reject('CATALOG_LIMIT');
    if (
      v === null ||
      typeof v === 'string' ||
      typeof v === 'boolean' ||
      (typeof v === 'number' && Number.isFinite(v))
    )
      return;
    if (
      typeof v !== 'object' ||
      active.has(v) ||
      Object.getOwnPropertySymbols(v).length ||
      (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype)
    )
      reject('CATALOG_UNSUPPORTED');
    if (
      Array.isArray(v) &&
      (Object.keys(v).length !== v.length || Object.getOwnPropertyNames(v).length !== v.length + 1)
    )
      reject('CATALOG_UNSUPPORTED');
    active.add(v);
    for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
      if (Array.isArray(v) && key === 'length') continue;
      if (!d.enumerable || !('value' in d)) reject('CATALOG_UNSUPPORTED');
      bytes += Buffer.byteLength(key, 'utf8');
      visit(d.value, depth + 1);
    }
    active.delete(v);
  }
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > limit) reject('CATALOG_LIMIT');
}
function orderedUnique(values: readonly string[]): boolean {
  return values.every((v, i) => i === 0 || v > (values[i - 1] ?? ''));
}
function profile(raw: unknown): CurrentSourceCatalogProfile {
  boundedPlain(raw);
  const result = expectedBaseSchema.safeParse(raw);
  if (!result.success) reject('INVALID_PROFILE');
  const p = result.data;
  if (
    !orderedUnique(p.schemas) ||
    !orderedUnique(p.relations.map((r) => `${r.schema}.${r.name}`)) ||
    !orderedUnique(p.roles.map((r) => r.tag)) ||
    new Set(p.roles.map((r) => r.name)).size !== p.roles.length ||
    !p.roles.some((r) => r.name === p.operator.roleName)
  )
    reject('INVALID_PROFILE');
  return p;
}
const contextRow = z.strictObject({
  databaseName: identifier,
  databaseOid: oid,
  currentRole: identifier,
  sessionRole: identifier,
  roleOid: oid,
  superuser: z.boolean(),
  bypassRls: z.boolean(),
  isolation: text,
  readOnly: z.boolean(),
  transactionSnapshot: text,
  statementTimeout: text,
});
async function context(tx: CurrentSourceCaptureTransaction, p: CurrentSourceCatalogProfile) {
  const result = await tx.query(
    `SELECT current_database() AS "databaseName",(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS "databaseOid",current_user AS "currentRole",session_user AS "sessionRole",r.oid::text AS "roleOid",r.rolsuper AS "superuser",r.rolbypassrls AS "bypassRls",current_setting('transaction_isolation') AS "isolation",current_setting('transaction_read_only')='on' AS "readOnly",txid_current_snapshot()::text AS "transactionSnapshot",(SELECT setting FROM pg_settings WHERE name='statement_timeout') AS "statementTimeout" FROM pg_roles r WHERE r.rolname=current_user`,
  );
  const r = contextRow.safeParse(result.rows[0]);
  if (!r.success) reject('SOURCE_CONTEXT_MISMATCH');
  const v = r.data;
  if (
    v.databaseName !== p.source.databaseName ||
    v.databaseOid !== p.source.databaseOid ||
    v.currentRole !== v.sessionRole ||
    v.currentRole !== p.operator.roleName ||
    v.roleOid !== p.operator.roleOid ||
    v.superuser !== p.operator.superuser ||
    v.bypassRls !== p.operator.bypassRls ||
    !v.readOnly ||
    !['repeatable read', 'serializable'].includes(v.isolation) ||
    !/^\d+$/.test(v.statementTimeout) ||
    BigInt(v.statementTimeout) === 0n ||
    BigInt(v.statementTimeout) > 60000n
  )
    reject('SOURCE_CONTEXT_MISMATCH');
  return snapshotSchema.parse({
    transactionSnapshot: v.transactionSnapshot,
    isolation: v.isolation,
    readOnly: v.readOnly,
    roleName: v.currentRole,
    roleOid: v.roleOid,
    statementTimeout: v.statementTimeout,
  });
}
async function sourceSystemIdentity(
  tx: CurrentSourceCaptureTransaction,
  p: CurrentSourceCatalogProfile,
): Promise<void> {
  const system = await tx.query('SELECT system_identifier::text AS id FROM pg_control_system()');
  if (
    !z.strictObject({ id: decimal }).safeParse(system.rows[0]).success ||
    system.rows[0]?.['id'] !== p.source.systemIdentifier
  )
    reject('SOURCE_CONTEXT_MISMATCH');
}
async function visibility(
  tx: CurrentSourceCaptureTransaction,
  p: CurrentSourceCatalogProfile,
): Promise<void> {
  const schemaRows = await tx.query(
    `SELECT nspname AS name FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema' ORDER BY nspname COLLATE "C"`,
  );
  const names = z
    .array(z.strictObject({ name: identifier }))
    .parse(schemaRows.rows)
    .map((r) => r.name);
  if (JSON.stringify(names) !== JSON.stringify(p.schemas)) reject('CATALOG_MISMATCH');
  const result = await tx.query(
    `SELECT n.nspname AS schema,c.relname AS name,c.relkind::text AS kind,has_table_privilege(c.oid,'SELECT') AS readable,row_security_active(c.oid) AS filtered FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','p') ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C"`,
    [p.schemas],
  );
  const rows = z
    .array(
      z.strictObject({
        schema: identifier,
        name: identifier,
        kind: z.enum(['r', 'p']),
        readable: z.boolean(),
        filtered: z.boolean(),
      }),
    )
    .max(1000)
    .parse(result.rows);
  if (
    JSON.stringify(rows.map(({ schema, name }) => ({ schema, name }))) !==
    JSON.stringify(p.relations)
  )
    reject('CATALOG_MISMATCH');
  if (rows.some((r) => !r.readable || r.filtered)) reject('SOURCE_VISIBILITY_UNAVAILABLE');
}

// Expressions are compile-time SQL, never caller-provided identifiers or fragments.
function ownerName(expression: string): string {
  return `COALESCE((SELECT m.tag FROM role_map m WHERE m.name=pg_get_userbyid(${expression})),pg_get_userbyid(${expression}))`;
}
function aclSql(expression: string, owner: string, kind: string): string {
  return `COALESCE((SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE ${ownerName('a.grantee')} END,'grantor',${ownerName('a.grantor')},'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY a.grantee,a.grantor,a.privilege_type,a.is_grantable) FROM aclexplode(COALESCE(${expression},acldefault('${kind}',${owner}))) a),'[]'::jsonb)`;
}
const catalogSql = `WITH role_map AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS m(tag text,name text)), payload AS (SELECT jsonb_build_object(
 'database',(SELECT jsonb_build_object('owner',${ownerName('d.datdba')},'encoding',pg_encoding_to_char(d.encoding),'collation',d.datcollate,'ctype',d.datctype,'locale',to_jsonb(d)->>'datlocale','collationVersion',to_jsonb(d)->>'datcollversion','allowConnections',d.datallowconn,'connectionLimit',d.datconnlimit,'rawAcl',d.datacl::text,'acl',${aclSql('d.datacl', 'd.datdba', 'd')}) FROM pg_database d WHERE d.datname=current_database()),
 'defaultPrivileges',COALESCE((SELECT jsonb_agg(jsonb_build_object('owner',${ownerName('a.defaclrole')},'schema',n.nspname,'kind',a.defaclobjtype,'rawAcl',a.defaclacl::text,'acl',${aclSql('a.defaclacl', 'a.defaclrole', 'r')}) ORDER BY a.defaclrole,a.defaclnamespace,a.defaclobjtype) FROM pg_default_acl a LEFT JOIN pg_namespace n ON n.oid=a.defaclnamespace WHERE a.defaclnamespace=0 OR n.nspname=ANY($1::text[])),'[]'::jsonb),
 'schemas',(SELECT jsonb_agg(jsonb_build_object('name',n.nspname,'owner',${ownerName('n.nspowner')},'rawAcl',n.nspacl::text,'acl',${aclSql('n.nspacl', 'n.nspowner', 'n')}) ORDER BY n.nspname COLLATE "C") FROM pg_namespace n WHERE n.nspname=ANY($1::text[])),
 'relations',COALESCE((SELECT jsonb_agg(jsonb_build_object(
  'schema',n.nspname,'name',c.relname,'kind',c.relkind,'owner',${ownerName('c.relowner')},'rls',c.relrowsecurity,'force',c.relforcerowsecurity,'persistence',c.relpersistence,
  'partitionBound',pg_get_expr(c.relpartbound,c.oid),'rawAcl',c.relacl::text,
  'acl',CASE WHEN c.relkind='S' THEN ${aclSql('c.relacl', 'c.relowner', 's')} ELSE ${aclSql('c.relacl', 'c.relowner', 'r')} END,
  'columns',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid),'rawAcl',a.attacl::text,'acl',${aclSql('a.attacl', 'c.relowner', 'c')}) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'[]'::jsonb),
  'constraints',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',x.conname,'kind',x.contype,'definition',pg_get_constraintdef(x.oid,true),'validated',x.convalidated,'deferrable',x.condeferrable,'deferred',x.condeferred) ORDER BY x.conname COLLATE "C") FROM pg_constraint x WHERE x.conrelid=c.oid),'[]'::jsonb),
  'triggers',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'definition',pg_get_triggerdef(t.oid),'enabled',t.tgenabled,'constraint',t.tgconstraint<>0,'deferrable',t.tgdeferrable,'deferred',t.tginitdeferred,'function',t.tgfoid::regprocedure::text) ORDER BY t.tgname COLLATE "C") FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),'[]'::jsonb),
  'policies',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,'roles',(SELECT jsonb_agg(CASE WHEN x=0 THEN 'PUBLIC' ELSE ${ownerName('x')} END ORDER BY x) FROM unnest(p.polroles) x),'qual',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname COLLATE "C") FROM pg_policy p WHERE p.polrelid=c.oid),'[]'::jsonb),
  'index',CASE WHEN c.relkind IN ('i','I') THEN pg_get_indexdef(c.oid) ELSE NULL END,
  'sequence',CASE WHEN c.relkind='S' THEN (SELECT jsonb_build_object('type',format_type(s.seqtypid,NULL),'start',s.seqstart::text,'increment',s.seqincrement::text,'max',s.seqmax::text,'min',s.seqmin::text,'cache',s.seqcache::text,'cycle',s.seqcycle,
   'links',COALESCE((SELECT jsonb_agg(jsonb_build_object('schema',pn.nspname,'table',pc.relname,'column',a.attname,'kind',d.deptype) ORDER BY pn.nspname COLLATE "C",pc.relname COLLATE "C",a.attname COLLATE "C") FROM pg_depend d JOIN pg_class pc ON pc.oid=d.refobjid JOIN pg_namespace pn ON pn.oid=pc.relnamespace JOIN pg_attribute a ON a.attrelid=pc.oid AND a.attnum=d.refobjsubid WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i')),'[]'::jsonb)) FROM pg_sequence s WHERE s.seqrelid=c.oid) ELSE NULL END
 ) ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C") FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[])),'[]'::jsonb),
 'functions',COALESCE((SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'name',p.proname,'arguments',pg_get_function_identity_arguments(p.oid),'returns',pg_get_function_result(p.oid),'owner',${ownerName('p.proowner')},'language',l.lanname,'securityDefiner',p.prosecdef,'strict',p.proisstrict,'leakproof',p.proleakproof,'volatility',p.provolatile,'parallel',p.proparallel,'config',p.proconfig,'definition',pg_get_functiondef(p.oid),'rawAcl',p.proacl::text,'acl',${aclSql('p.proacl', 'p.proowner', 'f')}) ORDER BY n.nspname COLLATE "C",p.proname COLLATE "C",pg_get_function_identity_arguments(p.oid) COLLATE "C") FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname=ANY($1::text[])),'[]'::jsonb),
 'extensions',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',e.extname,'version',e.extversion,'schema',n.nspname,'owner',${ownerName('e.extowner')},'members',COALESCE((SELECT jsonb_agg(jsonb_build_object('identity',pg_describe_object(d.classid,d.objid,d.objsubid),'owner',CASE WHEN d.classid='pg_proc'::regclass THEN (SELECT ${ownerName('p.proowner')} FROM pg_proc p WHERE p.oid=d.objid) WHEN d.classid='pg_class'::regclass THEN (SELECT ${ownerName('c.relowner')} FROM pg_class c WHERE c.oid=d.objid) WHEN d.classid='pg_type'::regclass THEN (SELECT ${ownerName('t.typowner')} FROM pg_type t WHERE t.oid=d.objid) ELSE NULL END,'definition',CASE WHEN d.classid='pg_proc'::regclass THEN (SELECT CASE WHEN p.prokind='f' THEN pg_get_functiondef(p.oid) ELSE pg_get_function_identity_arguments(p.oid) END FROM pg_proc p WHERE p.oid=d.objid) ELSE pg_describe_object(d.classid,d.objid,d.objsubid) END) ORDER BY pg_describe_object(d.classid,d.objid,d.objsubid) COLLATE "C") FROM pg_depend d WHERE d.refclassid='pg_extension'::regclass AND d.refobjid=e.oid AND d.deptype='e'),'[]'::jsonb)) ORDER BY e.extname COLLATE "C") FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace),'[]'::jsonb),
 'roles',(SELECT jsonb_agg(jsonb_build_object('tag',m.tag,'name',r.rolname,'oid',r.oid::text,'superuser',r.rolsuper,'bypassRls',r.rolbypassrls,'inherit',r.rolinherit,'createDb',r.rolcreatedb,'createRole',r.rolcreaterole,'login',r.rolcanlogin,'replication',r.rolreplication,'connectionLimit',r.rolconnlimit,'config',r.rolconfig,'memberships',COALESCE((SELECT jsonb_agg(jsonb_build_object('role',${ownerName('a.roleid')},'member',${ownerName('a.member')},'grantor',${ownerName('a.grantor')},'adminOption',a.admin_option,'inheritOption',to_jsonb(a)->'inherit_option','setOption',to_jsonb(a)->'set_option') ORDER BY a.roleid,a.member,a.grantor) FROM pg_auth_members a WHERE a.roleid=r.oid OR a.member=r.oid OR a.grantor=r.oid),'[]'::jsonb)) ORDER BY m.tag COLLATE "C") FROM role_map m JOIN pg_roles r ON r.rolname=m.name),
 'registry',(SELECT jsonb_agg(jsonb_build_object('version',version,'checksum',checksum) ORDER BY version) FROM public.schema_migrations)
 ) AS body)
`;
const unsupportedSql = `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[]) AND c.relkind NOT IN ('r','p','S','i','I')
 UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=ANY($1::text[]) AND p.prokind<>'f'
 UNION ALL SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=ANY($1::text[]) AND (t.typtype IN ('d','e','r','m') OR(t.typtype='c' AND t.typrelid=0)) AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_type'::regclass AND d.objid=t.oid AND d.deptype='e') LIMIT 1`;
const roleCoverageSql = `WITH acl_inputs AS (
 SELECT n.nspacl AS acl FROM pg_namespace n WHERE n.nspname=ANY($1::text[])
 UNION ALL SELECT c.relacl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[])
 UNION ALL SELECT a.attacl FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[])
 UNION ALL SELECT p.proacl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=ANY($1::text[])
 UNION ALL SELECT d.datacl FROM pg_database d WHERE d.datname=current_database()
 UNION ALL SELECT a.defaclacl FROM pg_default_acl a LEFT JOIN pg_namespace n ON n.oid=a.defaclnamespace WHERE a.defaclnamespace=0 OR n.nspname=ANY($1::text[])
 ), refs AS (
 SELECT n.nspowner AS oid FROM pg_namespace n WHERE n.nspname=ANY($1::text[])
 UNION SELECT c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[])
 UNION SELECT p.proowner FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=ANY($1::text[])
 UNION SELECT e.extowner FROM pg_extension e
 UNION SELECT d.datdba FROM pg_database d WHERE d.datname=current_database()
 UNION SELECT a.defaclrole FROM pg_default_acl a LEFT JOIN pg_namespace n ON n.oid=a.defaclnamespace WHERE a.defaclnamespace=0 OR n.nspname=ANY($1::text[])
 UNION SELECT unnest(p.polroles) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[])
 UNION SELECT a.grantee FROM acl_inputs i CROSS JOIN LATERAL aclexplode(i.acl) a
 UNION SELECT a.grantor FROM acl_inputs i CROSS JOIN LATERAL aclexplode(i.acl) a
 ) SELECT 1 FROM refs WHERE oid<>0 AND NOT(pg_get_userbyid(oid)=ANY($2::text[])) LIMIT 1`;
const fingerprintSchema = z.strictObject({ bytes: decimal, digest: hash });
async function fingerprint(tx: CurrentSourceCaptureTransaction, p: CurrentSourceCatalogProfile) {
  if ((await tx.query(roleCoverageSql, [p.schemas, p.roles.map((r) => r.name)])).rows.length)
    reject('CATALOG_MISMATCH');
  if ((await tx.query(unsupportedSql, [p.schemas])).rows.length) reject('CATALOG_UNSUPPORTED');
  const cap = await tx.query(
    `SELECT (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[])) AS relations,(SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=ANY($1::text[])) AS functions`,
    [p.schemas],
  );
  const count = z
    .strictObject({ relations: z.number().int().max(4096), functions: z.number().int().max(4096) })
    .safeParse(cap.rows[0]);
  if (!count.success) reject('CATALOG_LIMIT');
  const result = await tx.query(
    `${catalogSql} SELECT octet_length(body::text)::text AS bytes,encode(sha256(convert_to(body::text,'UTF8')),'hex') AS digest FROM payload`,
    [p.schemas, JSON.stringify(p.roles)],
  );
  const parsed = fingerprintSchema.safeParse(result.rows[0]);
  if (!parsed.success) reject('CATALOG_UNSUPPORTED');
  if (BigInt(parsed.data.bytes) > BigInt(limit)) reject('CATALOG_LIMIT');
  return parsed.data;
}
/** Independent provisioning reads only metadata scalar hash/bytes. It signs nothing and reads no product/credential row. */
export async function readCurrentSourceCatalogFingerprintIn(
  tx: CurrentSourceCaptureTransaction,
  unknownProfile: unknown,
) {
  const p = profile(unknownProfile);
  const snapshot = await context(tx, p);
  await visibility(tx, p);
  await sourceSystemIdentity(tx, p);
  const f = await fingerprint(tx, p);
  return {
    source: p.source,
    snapshot,
    catalogSha256: f.digest,
    catalogBytes: f.bytes,
    digestNamespace: 'sha256-pg-jsonb-catalog-v1' as const,
    authentication: 'not_captured' as const,
    authority: 'none' as const,
  };
}
/** Full metadata and all-table counts, including tombstones/private rows and global budget ledgers. No credential bodies. */
export async function captureCurrentSourceCatalogIn(
  tx: CurrentSourceCaptureTransaction,
  unknownExpected: unknown,
): Promise<CurrentSourceCatalogCapture> {
  boundedPlain(unknownExpected);
  const validated = currentSourceCatalogExpectedSchema.safeParse(unknownExpected);
  if (!validated.success) reject('INVALID_PROFILE');
  const { catalogSha256, ...base } = validated.data;
  const p = profile(base);
  const snapshot = await context(tx, p);
  await visibility(tx, p);
  await sourceSystemIdentity(tx, p);
  const f = await fingerprint(tx, p);
  if (f.digest !== catalogSha256) reject('CATALOG_MISMATCH');
  const payload = await tx.query(`${catalogSql} SELECT body AS catalog FROM payload`, [
    p.schemas,
    JSON.stringify(p.roles),
  ]);
  const raw = payload.rows[0]?.['catalog'];
  boundedPlain(raw);
  const parsed = catalogSchema.safeParse(raw);
  if (!parsed.success) reject('CATALOG_UNSUPPORTED');
  const catalog = parsed.data;
  if (
    JSON.stringify(catalog.registry) !== JSON.stringify(p.normalRegistry) ||
    JSON.stringify(catalog.roles.map((r) => ({ tag: r.tag, name: r.name }))) !==
      JSON.stringify(p.roles)
  )
    reject('CATALOG_MISMATCH');
  const census: z.infer<typeof censusSchema> = [];
  for (const r of p.relations) {
    // Independently pinned, discovered strict SQL identifiers only; never a caller-selected arbitrary table.
    const rows = await tx.query(
      `SELECT count(*)::text AS rows,COALESCE(sum(pg_column_size(t)),0)::text AS "rowStorageBytes" FROM ONLY "${r.schema}"."${r.name}" t`,
    );
    const count = z
      .strictObject({ rows: decimal, rowStorageBytes: decimal })
      .safeParse(rows.rows[0]);
    if (!count.success) reject('CENSUS_LIMIT');
    census.push({ schema: r.schema, relation: r.name, ...count.data });
  }
  const censusBytes = Buffer.byteLength(JSON.stringify(census), 'utf8');
  if (censusBytes > limit) reject('CENSUS_LIMIT');
  const finalSnapshot = await context(tx, p);
  if (JSON.stringify(finalSnapshot) !== JSON.stringify(snapshot)) reject('SOURCE_CONTEXT_MISMATCH');
  const finalFingerprint = await fingerprint(tx, p);
  if (finalFingerprint.digest !== f.digest || finalFingerprint.bytes !== f.bytes)
    reject('CATALOG_MISMATCH');
  const capture: CurrentSourceCatalogCapture = {
    source: p.source,
    snapshot,
    profile: { profileVersion: 1, normalSchemaVersion: 107, explicitPins: p.explicitPins },
    catalog,
    catalogSha256,
    census: censusSchema.parse(census),
    byteAccounting: {
      catalogBytes: f.bytes,
      censusBytes,
      rowStorageBytes: census.reduce((sum, r) => sum + BigInt(r.rowStorageBytes), 0n).toString(),
      meaning: 'pg_column_size_not_transport',
    },
    observation: 'actual_same_snapshot_metadata_and_counts',
    authentication: 'not_captured',
    authority: 'none',
    admissionAllowed: false,
    limits: {
      sequenceCurrentValues: 'not_captured_non_mvcc',
      sourceSignature: 'not_captured',
      archive: 'not_captured',
      tailBoundary: 'not_captured',
    },
  };
  boundedPlain(capture);
  return capture;
}
