import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  verifyCurrentRuntimeInstalledIn,
  currentRuntimeMigrationMembers,
  type CurrentRuntimeInstallationTransaction,
} from './current-runtime-installation.js';
import { currentRuntimeRpcSourcePins } from './current-runtime-grants.js';

const MAX_BYTES = 16 * 1024 * 1024;
// Catalog names are PostgreSQL identifiers, not interpolated SQL tokens.
const name = z
  .string()
  .min(1)
  .refine((value) => !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= 63);
const runtimeRoleName = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);
const text = z.string().max(2 * 1024 * 1024);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const tag = z.string().min(1).max(256);
const nullable = text.nullable();
const acl = z
  .array(z.strictObject({ grantee: tag, grantor: tag, privilege: text, grantable: z.boolean() }))
  .max(256);
const column = z.strictObject({
  position: z.number().int().positive(),
  name,
  dropped: z.boolean(),
  type: text,
  typmod: z.number().int(),
  collation: nullable,
  notNull: z.boolean(),
  identity: text,
  generated: text,
  default: nullable,
  acl,
  runtimeSelect: z.boolean(),
  runtimeInsert: z.boolean(),
  runtimeUpdate: z.boolean(),
  runtimeReferences: z.boolean(),
});
const constraint = z.strictObject({
  name,
  kind: text,
  definition: text,
  validated: z.boolean(),
  deferrable: z.boolean(),
  deferred: z.boolean(),
});
const trigger = z.strictObject({
  name,
  definition: text,
  enabled: text,
  constraint: z.boolean(),
  deferrable: z.boolean(),
  deferred: z.boolean(),
  function: text,
});
const policy = z.strictObject({
  name,
  command: text,
  permissive: z.boolean(),
  roles: z.array(tag).max(256),
  qual: nullable,
  check: nullable,
});
const relation = z.strictObject({
  schema: name,
  name,
  owner: tag,
  kind: text,
  persistence: text,
  rls: z.boolean(),
  force: z.boolean(),
  partitionBound: nullable,
  acl,
  columns: z.array(column).max(512),
  constraints: z.array(constraint).max(512),
  triggers: z.array(trigger).max(512),
  policies: z.array(policy).max(512),
  index: nullable,
  sequence: z
    .strictObject({
      type: text,
      start: text,
      increment: text,
      minimum: text,
      maximum: text,
      cache: text,
      cycle: z.boolean(),
    })
    .nullable(),
  runtimePrivileges: z.strictObject({
    select: z.boolean(),
    insert: z.boolean(),
    update: z.boolean(),
    delete: z.boolean(),
    truncate: z.boolean(),
    references: z.boolean(),
    trigger: z.boolean(),
    usage: z.boolean(),
  }),
});
const fn = z.strictObject({
  schema: name,
  name,
  arguments: text,
  returns: text,
  owner: tag,
  kind: text,
  language: text,
  returnSet: z.boolean(),
  securityDefiner: z.boolean(),
  strict: z.boolean(),
  leakproof: z.boolean(),
  volatility: text,
  parallel: text,
  configuration: z.array(text).max(64).nullable(),
  sourceBytes: z
    .number()
    .int()
    .min(0)
    .max(2 * 1024 * 1024),
  sourceSha256: hash,
  binarySha256: hash.nullable(),
  acl,
  runtimeExecute: z.boolean(),
});
const membership = z.strictObject({
  role: tag,
  member: tag,
  grantor: tag,
  admin: z.boolean(),
  inherit: z.boolean().nullable(),
  set: z.boolean().nullable(),
});
const role = z.strictObject({
  tag,
  superuser: z.boolean(),
  bypassRls: z.boolean(),
  createRole: z.boolean(),
  createDb: z.boolean(),
  inherit: z.boolean(),
  login: z.boolean(),
  replication: z.boolean(),
  configurationSha256: hash.nullable(),
});
const metadataSchema = z.strictObject({
  serverVersion: z.string().regex(/^\d{5,6}$/),
  schemas: z
    .array(
      z.strictObject({
        name,
        owner: tag,
        acl,
        runtimeUsage: z.boolean(),
        runtimeCreate: z.boolean(),
      }),
    )
    .max(32),
  functions: z.array(fn).max(5000),
  relations: z.array(relation).max(5000),
  defaultPrivileges: z
    .array(z.strictObject({ owner: tag, schema: name.nullable(), kind: text, acl }))
    .max(1000),
  roles: z.array(role).min(2).max(1000),
  memberships: z.array(membership).max(5000),
  extensions: z
    .array(
      z.strictObject({
        name,
        version: text,
        schema: name,
        owner: tag,
        members: z.array(text).max(10000),
      }),
    )
    .max(64),
  types: z
    .array(z.strictObject({ schema: name, name, owner: tag, kind: text, definition: text }))
    .max(5000),
  collations: z
    .array(
      z.strictObject({
        schema: name,
        name,
        owner: tag,
        provider: text,
        encoding: z.number().int(),
        deterministic: z.boolean(),
        locale: nullable,
        ctype: nullable,
        version: nullable,
      }),
    )
    .max(5000),
  dependencies: z
    .array(z.strictObject({ dependent: text, referenced: text, kind: text }))
    .max(50000),
});
export type CurrentRuntimeCatalogMetadata = z.infer<typeof metadataSchema>;
const sectionNames = [
  'schemas',
  'functions',
  'relations',
  'defaultPrivileges',
  'roles',
  'memberships',
  'extensions',
  'types',
  'collations',
  'dependencies',
] as const;
export class CurrentRuntimeCatalogWitnessError extends Error {
  constructor(
    readonly code:
      | 'CATALOG_WITNESS_INVALID'
      | 'CATALOG_WITNESS_LIMIT'
      | 'CATALOG_WITNESS_OWNER_REQUIRED'
      | 'CATALOG_WITNESS_CONTEXT_REQUIRED',
  ) {
    super(code);
  }
}
function fail(code: CurrentRuntimeCatalogWitnessError['code']): never {
  throw new CurrentRuntimeCatalogWitnessError(code);
}
function digest(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
function boundedPlain(raw: unknown) {
  let bytes = 0,
    visits = 0;
  const active = new Set<object>();
  function string(value: string) {
    bytes += Buffer.byteLength(value, 'utf8');
    if (bytes > MAX_BYTES) fail('CATALOG_WITNESS_LIMIT');
  }
  function visit(value: unknown, depth: number): void {
    if (++visits > 250000 || depth > 32) fail('CATALOG_WITNESS_LIMIT');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'string') {
      string(value);
      return;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value !== 'object' || active.has(value)) fail('CATALOG_WITNESS_INVALID');
    const array = Array.isArray(value),
      proto: unknown = Object.getPrototypeOf(value);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null)
      fail('CATALOG_WITNESS_INVALID');
    active.add(value);
    const keys = Reflect.ownKeys(value);
    if (keys.length > 50000) fail('CATALOG_WITNESS_LIMIT');
    let count = 0;
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') fail('CATALOG_WITNESS_INVALID');
      string(key);
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d || !d.enumerable || !('value' in d) || (array && key !== String(count++)))
        fail('CATALOG_WITNESS_INVALID');
      visit(d.value, depth + 1);
    }
    if (array && count !== value.length) fail('CATALOG_WITNESS_INVALID');
    active.delete(value);
  }
  visit(raw, 0);
  if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > MAX_BYTES) fail('CATALOG_WITNESS_LIMIT');
}
function unique(keys: string[]) {
  if (new Set(keys).size !== keys.length) fail('CATALOG_WITNESS_INVALID');
}
/** Private observation decoder, not a caller-provided expected catalog or seal. */
export function parseCurrentRuntimeCatalogMetadata(raw: unknown): CurrentRuntimeCatalogMetadata {
  boundedPlain(raw);
  const parsed = metadataSchema.safeParse(raw);
  if (!parsed.success) fail('CATALOG_WITNESS_INVALID');
  const m = parsed.data;
  unique(m.schemas.map((s) => s.name));
  unique(m.roles.map((r) => r.tag));
  unique(m.relations.map((r) => `${r.schema}.${r.name}`));
  unique(m.functions.map((f) => `${f.schema}.${f.name}(${f.arguments})`));
  unique(m.extensions.map((e) => e.name));
  const roleTags = new Set(['PUBLIC', ...m.roles.map((r) => r.tag)]),
    schemas = new Set(m.schemas.map((s) => s.name));
  function known(t: string) {
    if (!roleTags.has(t)) fail('CATALOG_WITNESS_INVALID');
  }
  function checkAcl(values: z.infer<typeof acl>) {
    unique(values.map((a) => JSON.stringify([a.grantee, a.grantor, a.privilege])));
    for (const a of values) {
      known(a.grantee);
      known(a.grantor);
    }
  }
  for (const s of m.schemas) {
    known(s.owner);
    checkAcl(s.acl);
  }
  for (const r of m.relations) {
    if (!schemas.has(r.schema)) fail('CATALOG_WITNESS_INVALID');
    known(r.owner);
    checkAcl(r.acl);
    unique(r.columns.map((c) => String(c.position)));
    unique(r.constraints.map((c) => c.name));
    unique(r.triggers.map((t) => t.name));
    unique(r.policies.map((p) => p.name));
    for (const c of r.columns) checkAcl(c.acl);
    for (const p of r.policies) for (const t of p.roles) known(t);
  }
  for (const f of m.functions) {
    known(f.owner);
    checkAcl(f.acl);
  }
  for (const d of m.defaultPrivileges) {
    known(d.owner);
    checkAcl(d.acl);
  }
  for (const e of m.extensions) known(e.owner);
  for (const t of m.types) known(t.owner);
  for (const c of m.collations) known(c.owner);
  for (const edge of m.memberships) {
    known(edge.role);
    known(edge.member);
    known(edge.grantor);
  }
  if (!roleTags.has('owner') || !roleTags.has('runtime')) fail('CATALOG_WITNESS_INVALID');
  return m;
}
const knownNamespaces = new Set([
  'public',
  'identity_private',
  'garmin_private',
  'wm_app_load',
  'wm_check_in_templates_v1',
  'wm_runtime_installation',
]);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical); // Physical column/config order is semantic.
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, v]) => [key, canonical(v)]),
    );
  return value;
}
/** A faithful artifact never asserts a dynamic dependency fixed point, strict
 * JS wire or grant recipe merely because all observed metadata is present. */
export function buildCurrentRuntimeCatalogWitness(raw: unknown) {
  const metadata = parseCurrentRuntimeCatalogMetadata(raw);
  const sections = sectionNames.map((section) => {
    const body = JSON.stringify(canonical(metadata[section]));
    return {
      section,
      rowCount: metadata[section].length,
      bytes: Buffer.byteLength(body, 'utf8'),
      sha256: digest(body),
    };
  });
  const unknownNamespaces = metadata.schemas
    .filter((s) => !knownNamespaces.has(s.name))
    .map((s) => s.name);
  const unmappedRoleTags = metadata.roles
    .filter((r) => r.tag.startsWith('unmapped:'))
    .map((r) => r.tag);
  const artifact = {
    witnessVersion: 1 as const,
    metadataEncoding: 'pg-catalog-runtime-security-normalized-v1' as const,
    profile: {
      baselineSchemaVersion: 107 as const,
      runtimeSteps: currentRuntimeMigrationMembers.map((m) => ({ ...m })),
    },
    metadata,
    sections,
    unknownNamespaces,
    unmappedRoleTags,
    closure: {
      dynamicDependencies: 'not_verified' as const,
      strictCallerWire: 'not_verified' as const,
      effectiveRecipe: 'not_verified' as const,
      independentNormalization: 'not_verified' as const,
    },
    supported: false as const,
    processingAuthority: 'none' as const,
    restore: 'not_verified' as const,
  };
  boundedPlain(artifact);
  return { ...artifact, catalogSha256: digest(JSON.stringify(canonical(metadata))) };
}

// Compile-time expressions only; callers cannot choose namespaces/inventory.
function roleTag(expression: string) {
  return `coalesce((SELECT tag FROM role_tags WHERE oid=${expression}),'missing_role')`;
}
function normalizedAcl(expression: string, owner: string, kind: string) {
  const kindSql =
    kind === 'relation' ? `CASE WHEN c.relkind='S' THEN 's' ELSE 'r' END::"char"` : `'${kind}'`;
  return `coalesce((SELECT jsonb_agg(jsonb_build_object('grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE ${roleTag('a.grantee')} END,'grantor',${roleTag('a.grantor')},'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE ${roleTag('a.grantee')} END,${roleTag('a.grantor')},a.privilege_type,a.is_grantable) FROM pg_catalog.aclexplode(coalesce(${expression},pg_catalog.acldefault(${kindSql},${owner}))) a),'[]'::jsonb)`;
}
const userSchemas = `SELECT * FROM pg_catalog.pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema'`;
const catalogCtes = `WITH RECURSIVE ns AS (${userSchemas}),
 funcs AS (SELECT p.* FROM pg_catalog.pg_proc p WHERE p.pronamespace IN(SELECT oid FROM ns) OR EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.refclassid='pg_extension'::regclass AND d.deptype='e')),
 rels AS (SELECT c.* FROM pg_catalog.pg_class c WHERE c.relnamespace IN(SELECT oid FROM ns)),
 acl_inputs AS (
 SELECT nspacl acl,nspowner owner,'n' kind FROM ns
 UNION ALL SELECT relacl,relowner,CASE WHEN relkind='S' THEN 's' ELSE 'r' END FROM rels
 UNION ALL SELECT proacl,proowner,'f' FROM funcs
 UNION ALL SELECT a.attacl,c.relowner,'c' FROM pg_catalog.pg_attribute a JOIN rels c ON c.oid=a.attrelid WHERE a.attnum>0
 UNION ALL SELECT defaclacl,defaclrole,'r' FROM pg_catalog.pg_default_acl WHERE defaclnamespace=0 OR defaclnamespace IN(SELECT oid FROM ns)),
 seed_roles AS (
 SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN(session_user,$1)
 UNION SELECT nspowner FROM ns UNION SELECT relowner FROM rels UNION SELECT proowner FROM funcs
 UNION SELECT extowner FROM pg_catalog.pg_extension
 UNION SELECT typowner FROM pg_catalog.pg_type WHERE typnamespace IN(SELECT oid FROM ns)
 UNION SELECT collowner FROM pg_catalog.pg_collation WHERE collnamespace IN(SELECT oid FROM ns) OR oid IN(SELECT attcollation FROM pg_catalog.pg_attribute a JOIN rels c ON c.oid=a.attrelid)
 UNION SELECT r FROM pg_catalog.pg_policy p JOIN rels c ON c.oid=p.polrelid CROSS JOIN LATERAL unnest(p.polroles) r
 UNION SELECT owner FROM acl_inputs
 UNION SELECT a.grantee FROM acl_inputs i CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(i.acl,pg_catalog.acldefault(i.kind::"char",i.owner))) a
 UNION SELECT a.grantor FROM acl_inputs i CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(i.acl,pg_catalog.acldefault(i.kind::"char",i.owner))) a),
 edges AS (SELECT roleid a,member b FROM pg_catalog.pg_auth_members UNION SELECT member,roleid FROM pg_catalog.pg_auth_members UNION SELECT roleid,grantor FROM pg_catalog.pg_auth_members UNION SELECT grantor,roleid FROM pg_catalog.pg_auth_members),
 scope AS (SELECT oid FROM seed_roles WHERE oid<>0 UNION SELECT e.b FROM scope s JOIN edges e ON e.a=s.oid),
 role_tags AS (SELECT r.*,CASE WHEN rolname=session_user THEN 'owner' WHEN rolname=$1 THEN 'runtime'
 WHEN r.oid=(SELECT nspowner FROM pg_catalog.pg_namespace WHERE nspname='pg_catalog') THEN 'catalog_owner'
 WHEN rolname LIKE 'pg_%' THEN 'builtin:'||rolname
 WHEN EXISTS(SELECT 1 FROM pg_catalog.pg_extension e WHERE e.extowner=r.oid) THEN 'extension_owner:'||(SELECT string_agg(extname,',' ORDER BY extname COLLATE "C") FROM pg_catalog.pg_extension WHERE extowner=r.oid)
 ELSE 'unmapped:'||rolname END tag FROM pg_catalog.pg_roles r WHERE r.oid IN(SELECT oid FROM scope)),
 -- Only actual internal triggers tied to actual FK constraints receive an
 -- OID-independent identity. User triggers (including RI-name lookalikes) keep
 -- pg_describe_object unchanged. Keep type/args/qual/enabled/deferral semantics.
 internal_fk_trigger_identities AS MATERIALIZED (
 SELECT t.oid,'internal-fk-trigger:'||jsonb_build_object(
 'constraintRelation',format('%I.%I',kn.nspname,kc.relname),
 'constraintName',k.conname,'constraintDefinition',pg_catalog.pg_get_constraintdef(k.oid,true),
 'constraintValidated',k.convalidated,'referencedRelation',format('%I.%I',rn.nspname,rc.relname),
 'triggerRelation',format('%I.%I',tn.nspname,tc.relname),
 'function',format('%I.%I(%s)',fn.nspname,f.proname,pg_catalog.pg_get_function_identity_arguments(f.oid)),
 'type',t.tgtype,'enabled',t.tgenabled,'deferrable',t.tgdeferrable,'deferred',t.tginitdeferred,
 'arguments',encode(t.tgargs,'hex'),'columns',t.tgattr::text,'qual',pg_catalog.pg_get_expr(t.tgqual,t.tgrelid))::text AS description
 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_constraint k ON k.oid=t.tgconstraint
 JOIN pg_catalog.pg_class kc ON kc.oid=k.conrelid JOIN pg_catalog.pg_namespace kn ON kn.oid=kc.relnamespace
 JOIN pg_catalog.pg_class rc ON rc.oid=k.confrelid JOIN pg_catalog.pg_namespace rn ON rn.oid=rc.relnamespace
 JOIN pg_catalog.pg_class tc ON tc.oid=t.tgrelid JOIN pg_catalog.pg_namespace tn ON tn.oid=tc.relnamespace
 JOIN pg_catalog.pg_proc f ON f.oid=t.tgfoid JOIN pg_catalog.pg_namespace fn ON fn.oid=f.pronamespace
 WHERE t.tgisinternal AND k.contype='f' AND t.tgrelid IN(k.conrelid,k.confrelid)),
 dependency_descriptions AS MATERIALIZED (
 SELECT coalesce(dt.description,pg_catalog.pg_describe_object(d.classid,d.objid,d.objsubid)) AS dependent,
 coalesce(rt.description,pg_catalog.pg_describe_object(d.refclassid,d.refobjid,d.refobjsubid)) AS referenced,d.deptype AS kind
 FROM pg_catalog.pg_depend d
 LEFT JOIN internal_fk_trigger_identities dt ON d.classid='pg_trigger'::regclass AND dt.oid=d.objid AND d.objsubid=0
 LEFT JOIN internal_fk_trigger_identities rt ON d.refclassid='pg_trigger'::regclass AND rt.oid=d.refobjid AND d.refobjsubid=0
 WHERE (d.classid='pg_proc'::regclass AND d.objid IN(SELECT oid FROM funcs)) OR (d.classid='pg_class'::regclass AND d.objid IN(SELECT oid FROM rels)) OR (d.classid='pg_constraint'::regclass AND d.objid IN(SELECT oid FROM pg_catalog.pg_constraint WHERE conrelid IN(SELECT oid FROM rels))) OR (d.classid='pg_trigger'::regclass AND d.objid IN(SELECT oid FROM pg_catalog.pg_trigger WHERE tgrelid IN(SELECT oid FROM rels)))),
 payload AS (SELECT jsonb_build_object(
 'serverVersion',current_setting('server_version_num'),
 'schemas',coalesce((SELECT jsonb_agg(jsonb_build_object('name',n.nspname,'owner',${roleTag('n.nspowner')},'acl',${normalizedAcl('n.nspacl', 'n.nspowner', 'n')},'runtimeUsage',pg_catalog.has_schema_privilege($1,n.oid,'USAGE'),'runtimeCreate',pg_catalog.has_schema_privilege($1,n.oid,'CREATE')) ORDER BY n.nspname COLLATE "C") FROM ns n),'[]'::jsonb),
 'functions',coalesce((SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'name',p.proname,'arguments',pg_catalog.pg_get_function_identity_arguments(p.oid),'returns',pg_catalog.pg_get_function_result(p.oid),'owner',${roleTag('p.proowner')},'kind',p.prokind,'language',l.lanname,'returnSet',p.proretset,'securityDefiner',p.prosecdef,'strict',p.proisstrict,'leakproof',p.proleakproof,'volatility',p.provolatile,'parallel',p.proparallel,'configuration',p.proconfig,'sourceBytes',octet_length(p.prosrc),'sourceSha256',CASE WHEN octet_length(p.prosrc)<=2097152 THEN encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') END,'binarySha256',CASE WHEN octet_length(p.probin)<=2097152 THEN encode(sha256(convert_to(p.probin,'UTF8')),'hex') END,'acl',${normalizedAcl('p.proacl', 'p.proowner', 'f')},'runtimeExecute',pg_catalog.has_function_privilege($1,p.oid,'EXECUTE')) ORDER BY n.nspname COLLATE "C",p.proname COLLATE "C",pg_catalog.pg_get_function_identity_arguments(p.oid) COLLATE "C") FROM funcs p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang),'[]'::jsonb),
 'relations',coalesce((SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'name',c.relname,'owner',${roleTag('c.relowner')},'kind',c.relkind,'persistence',c.relpersistence,'rls',c.relrowsecurity,'force',c.relforcerowsecurity,'partitionBound',pg_catalog.pg_get_expr(c.relpartbound,c.oid),'acl',${normalizedAcl('c.relacl', 'c.relowner', 'relation')},
 'columns',coalesce((SELECT jsonb_agg(jsonb_build_object('position',a.attnum,'name',a.attname,'dropped',a.attisdropped,'type',coalesce(pg_catalog.format_type(a.atttypid,a.atttypmod),'dropped'),'typmod',a.atttypmod,'collation',CASE WHEN a.attcollation<>0 THEN a.attcollation::regcollation::text END,'notNull',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid),'acl',${normalizedAcl('a.attacl', 'c.relowner', 'c')},'runtimeSelect',CASE WHEN NOT a.attisdropped AND c.relkind IN('r','p','v','m','f') THEN pg_catalog.has_column_privilege($1,c.oid,a.attnum,'SELECT') ELSE false END,'runtimeInsert',CASE WHEN NOT a.attisdropped AND c.relkind IN('r','p','v','m','f') THEN pg_catalog.has_column_privilege($1,c.oid,a.attnum,'INSERT') ELSE false END,'runtimeUpdate',CASE WHEN NOT a.attisdropped AND c.relkind IN('r','p','v','m','f') THEN pg_catalog.has_column_privilege($1,c.oid,a.attnum,'UPDATE') ELSE false END,'runtimeReferences',CASE WHEN NOT a.attisdropped AND c.relkind IN('r','p','v','m','f') THEN pg_catalog.has_column_privilege($1,c.oid,a.attnum,'REFERENCES') ELSE false END) ORDER BY a.attnum) FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0),'[]'::jsonb),
 'constraints',coalesce((SELECT jsonb_agg(jsonb_build_object('name',x.conname,'kind',x.contype,'definition',pg_catalog.pg_get_constraintdef(x.oid,true),'validated',x.convalidated,'deferrable',x.condeferrable,'deferred',x.condeferred) ORDER BY x.conname COLLATE "C") FROM pg_catalog.pg_constraint x WHERE x.conrelid=c.oid),'[]'::jsonb),
 'triggers',coalesce((SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'definition',pg_catalog.pg_get_triggerdef(t.oid),'enabled',t.tgenabled,'constraint',t.tgconstraint<>0,'deferrable',t.tgdeferrable,'deferred',t.tginitdeferred,'function',t.tgfoid::regprocedure::text) ORDER BY t.tgname COLLATE "C") FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),'[]'::jsonb),
 'policies',coalesce((SELECT jsonb_agg(jsonb_build_object('name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,'roles',(SELECT jsonb_agg(CASE WHEN r=0 THEN 'PUBLIC' ELSE ${roleTag('r')} END ORDER BY CASE WHEN r=0 THEN 'PUBLIC' ELSE ${roleTag('r')} END) FROM unnest(p.polroles) r),'qual',pg_catalog.pg_get_expr(p.polqual,p.polrelid),'check',pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname COLLATE "C") FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid),'[]'::jsonb),
 'index',CASE WHEN c.relkind IN('i','I') THEN pg_catalog.pg_get_indexdef(c.oid) END,
 'sequence',CASE WHEN c.relkind='S' THEN (SELECT jsonb_build_object('type',pg_catalog.format_type(s.seqtypid,NULL),'start',s.seqstart::text,'increment',s.seqincrement::text,'minimum',s.seqmin::text,'maximum',s.seqmax::text,'cache',s.seqcache::text,'cycle',s.seqcycle) FROM pg_catalog.pg_sequence s WHERE s.seqrelid=c.oid) END,
 'runtimePrivileges',jsonb_build_object('select',CASE WHEN c.relkind IN('r','p','v','m','f') THEN pg_catalog.has_table_privilege($1,c.oid,'SELECT') WHEN c.relkind='S' THEN pg_catalog.has_sequence_privilege($1,c.oid,'SELECT') ELSE false END,'insert',CASE WHEN c.relkind IN('r','p','v','m','f') THEN pg_catalog.has_table_privilege($1,c.oid,'INSERT') ELSE false END,'update',CASE WHEN c.relkind IN('r','p','v','m','f') THEN pg_catalog.has_table_privilege($1,c.oid,'UPDATE') WHEN c.relkind='S' THEN pg_catalog.has_sequence_privilege($1,c.oid,'UPDATE') ELSE false END,'delete',CASE WHEN c.relkind IN('r','p','v','m','f') THEN pg_catalog.has_table_privilege($1,c.oid,'DELETE') ELSE false END,'truncate',CASE WHEN c.relkind IN('r','p','v','m','f') THEN pg_catalog.has_table_privilege($1,c.oid,'TRUNCATE') ELSE false END,'references',CASE WHEN c.relkind IN('r','p','v','m','f') THEN pg_catalog.has_table_privilege($1,c.oid,'REFERENCES') ELSE false END,'trigger',CASE WHEN c.relkind IN('r','p','v','m','f') THEN pg_catalog.has_table_privilege($1,c.oid,'TRIGGER') ELSE false END,'usage',CASE WHEN c.relkind='S' THEN pg_catalog.has_sequence_privilege($1,c.oid,'USAGE') ELSE false END)) ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C") FROM rels c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace),'[]'::jsonb),
 'defaultPrivileges',coalesce((SELECT jsonb_agg(jsonb_build_object('owner',${roleTag('d.defaclrole')},'schema',n.nspname,'kind',d.defaclobjtype,'acl',${normalizedAcl('d.defaclacl', 'd.defaclrole', 'r')}) ORDER BY ${roleTag('d.defaclrole')},coalesce(n.nspname,''),d.defaclobjtype) FROM pg_catalog.pg_default_acl d LEFT JOIN pg_catalog.pg_namespace n ON n.oid=d.defaclnamespace WHERE d.defaclnamespace=0 OR d.defaclnamespace IN(SELECT oid FROM ns)),'[]'::jsonb),
 'roles',coalesce((SELECT jsonb_agg(jsonb_build_object('tag',r.tag,'superuser',r.rolsuper,'bypassRls',r.rolbypassrls,'createRole',r.rolcreaterole,'createDb',r.rolcreatedb,'inherit',r.rolinherit,'login',r.rolcanlogin,'replication',r.rolreplication,'configurationSha256',CASE WHEN r.rolconfig IS NOT NULL THEN encode(sha256(convert_to(r.rolconfig::text,'UTF8')),'hex') END) ORDER BY r.tag COLLATE "C") FROM role_tags r),'[]'::jsonb),
 'memberships',coalesce((SELECT jsonb_agg(jsonb_build_object('role',${roleTag('a.roleid')},'member',${roleTag('a.member')},'grantor',${roleTag('a.grantor')},'admin',a.admin_option,'inherit',to_jsonb(a)->'inherit_option','set',to_jsonb(a)->'set_option') ORDER BY ${roleTag('a.roleid')},${roleTag('a.member')},${roleTag('a.grantor')}) FROM pg_catalog.pg_auth_members a WHERE a.roleid IN(SELECT oid FROM scope) OR a.member IN(SELECT oid FROM scope) OR a.grantor IN(SELECT oid FROM scope)),'[]'::jsonb),
 'extensions',coalesce((SELECT jsonb_agg(jsonb_build_object('name',e.extname,'version',e.extversion,'schema',n.nspname,'owner',${roleTag('e.extowner')},'members',coalesce((SELECT jsonb_agg(pg_catalog.pg_describe_object(d.classid,d.objid,d.objsubid) ORDER BY pg_catalog.pg_describe_object(d.classid,d.objid,d.objsubid) COLLATE "C") FROM pg_catalog.pg_depend d WHERE d.refclassid='pg_extension'::regclass AND d.refobjid=e.oid AND d.deptype='e'),'[]'::jsonb)) ORDER BY e.extname COLLATE "C") FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace),'[]'::jsonb),
 'types',coalesce((SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'name',t.typname,'owner',${roleTag('t.typowner')},'kind',t.typtype,'definition',jsonb_build_object('type',pg_catalog.format_type(t.oid,NULL),'notNull',t.typnotnull,'base',CASE WHEN t.typbasetype<>0 THEN pg_catalog.format_type(t.typbasetype,t.typtypmod) END,'default',t.typdefault,'labels',(SELECT jsonb_agg(enumlabel ORDER BY enumsortorder) FROM pg_catalog.pg_enum WHERE enumtypid=t.oid))::text) ORDER BY n.nspname COLLATE "C",t.typname COLLATE "C") FROM pg_catalog.pg_type t JOIN ns n ON n.oid=t.typnamespace),'[]'::jsonb),
 'collations',coalesce((SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'name',c.collname,'owner',${roleTag('c.collowner')},'provider',c.collprovider,'encoding',c.collencoding,'deterministic',c.collisdeterministic,'locale',coalesce(to_jsonb(c)->>'colllocale',c.collcollate),'ctype',c.collctype,'version',c.collversion) ORDER BY n.nspname COLLATE "C",c.collname COLLATE "C",c.collencoding) FROM pg_catalog.pg_collation c JOIN pg_catalog.pg_namespace n ON n.oid=c.collnamespace WHERE c.collnamespace IN(SELECT oid FROM ns) OR c.oid IN(SELECT attcollation FROM pg_catalog.pg_attribute a JOIN rels r ON r.oid=a.attrelid)),'[]'::jsonb),
 'dependencies',coalesce((SELECT jsonb_agg(jsonb_build_object('dependent',dependent,'referenced',referenced,'kind',kind) ORDER BY dependent COLLATE "C",referenced COLLATE "C",kind) FROM dependency_descriptions),'[]'::jsonb)
 ) AS body)`;

const contextSchema = z.strictObject({
  owner: z.literal(true),
  runtime: z.literal(true),
  readOnly: z.literal(true),
  isolation: z.enum(['repeatable read', 'serializable']),
  roleCount: z.number().int().min(2).max(10000),
});
const measuredSchema = z.strictObject({
  bytes: z.string().regex(/^(0|[1-9][0-9]*)$/),
  sha256: hash,
});
/** Owner-only deployment observation. Caller owns RR READ ONLY transaction,
 * fences and deadlines; SQL errors propagate so caller must rollback. No new
 * grants, user rows, pg_control_system, installer DDL or supported activation. */
export async function captureCurrentRuntimeCatalogWitnessIn(
  tx: CurrentRuntimeInstallationTransaction,
  unknownRuntimeRole: unknown,
) {
  const runtimeRole = runtimeRoleName.safeParse(unknownRuntimeRole);
  if (!runtimeRole.success) fail('CATALOG_WITNESS_INVALID');
  const context = await tx.query(
    `SELECT current_user=session_user AND NOT o.rolsuper AND NOT o.rolbypassrls AS owner,
 r.oid<>o.oid AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT pg_has_role(r.oid,o.oid,'MEMBER')
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles e WHERE (e.rolsuper OR e.rolbypassrls) AND pg_has_role(r.oid,e.oid,'MEMBER'))
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner=r.oid)
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspowner=r.oid)
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.proowner=r.oid) AS runtime,
 current_setting('transaction_read_only')='on' AS "readOnly",current_setting('transaction_isolation') AS isolation,(SELECT count(*)::int FROM pg_catalog.pg_roles) AS "roleCount"
 FROM pg_catalog.pg_roles o CROSS JOIN pg_catalog.pg_roles r WHERE o.rolname=session_user AND r.rolname=$1`,
    [runtimeRole.data],
  );
  const ctx = contextSchema.safeParse(context.rows[0]);
  if (context.rows.length !== 1 || !ctx.success) fail('CATALOG_WITNESS_CONTEXT_REQUIRED');
  await verifyCurrentRuntimeInstalledIn(tx);
  const counts =
    await tx.query(`SELECT (SELECT count(*)::int FROM pg_catalog.pg_proc WHERE pronamespace IN(SELECT oid FROM pg_catalog.pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema')) AS functions,
 (SELECT count(*)::int FROM pg_catalog.pg_class WHERE relnamespace IN(SELECT oid FROM pg_catalog.pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema')) AS relations,
 (SELECT coalesce(max(octet_length(prosrc)),0)::int FROM pg_catalog.pg_proc) AS "maxSourceBytes"`);
  const countSchema = z.strictObject({
    functions: z.number().int().min(26).max(5000),
    relations: z.number().int().min(23).max(5000),
    maxSourceBytes: z.number().int().min(0).max(2097152),
  });
  if (counts.rows.length !== 1 || !countSchema.safeParse(counts.rows[0]).success)
    fail('CATALOG_WITNESS_LIMIT');
  const measured = await tx.query(
    `${catalogCtes} SELECT octet_length(body::text)::text AS bytes,encode(sha256(convert_to(body::text,'UTF8')),'hex') AS sha256 FROM payload`,
    [runtimeRole.data],
  );
  const size = measuredSchema.safeParse(measured.rows[0]);
  if (measured.rows.length !== 1 || !size.success) fail('CATALOG_WITNESS_INVALID');
  if (BigInt(size.data.bytes) > BigInt(MAX_BYTES)) fail('CATALOG_WITNESS_LIMIT');
  const observed = await tx.query(
    `${catalogCtes} SELECT CASE WHEN octet_length(body::text)<=16777216 THEN body ELSE NULL END AS metadata,encode(sha256(convert_to(body::text,'UTF8')),'hex') AS sha256 FROM payload`,
    [runtimeRole.data],
  );
  if (observed.rows.length !== 1 || observed.rows[0]?.['sha256'] !== size.data.sha256)
    fail('CATALOG_WITNESS_INVALID');
  const witness = buildCurrentRuntimeCatalogWitness(observed.rows[0]?.['metadata']);
  return {
    ...witness,
    observation: {
      clusterRoleCount: ctx.data.roleCount,
      metadataBytes: size.data.bytes,
      sqlJsonbSha256: size.data.sha256,
      expectedRootCount: currentRuntimeRpcSourcePins.length,
    },
  };
}

const artifactSchema = z.strictObject({
  witnessVersion: z.literal(1),
  metadataEncoding: z.literal('pg-catalog-runtime-security-normalized-v1'),
  profile: z.strictObject({
    baselineSchemaVersion: z.literal(107),
    runtimeSteps: z
      .array(
        z.strictObject({
          step: z.number().int(),
          sourceDdlId: z.number().int(),
          filename: text,
          sha256: hash,
        }),
      )
      .length(17),
  }),
  metadata: metadataSchema,
  sections: z
    .array(
      z.strictObject({
        section: z.enum(sectionNames),
        rowCount: z.number().int().min(0),
        bytes: z.number().int().min(0).max(MAX_BYTES),
        sha256: hash,
      }),
    )
    .length(sectionNames.length),
  unknownNamespaces: z.array(name).max(32),
  unmappedRoleTags: z.array(tag).max(1000),
  closure: z.strictObject({
    dynamicDependencies: z.literal('not_verified'),
    strictCallerWire: z.literal('not_verified'),
    effectiveRecipe: z.literal('not_verified'),
    independentNormalization: z.literal('not_verified'),
  }),
  supported: z.literal(false),
  processingAuthority: z.literal('none'),
  restore: z.literal('not_verified'),
  catalogSha256: hash,
  observation: z
    .strictObject({
      clusterRoleCount: z.number().int().min(2).max(10000),
      metadataBytes: z
        .string()
        .regex(/^(0|[1-9][0-9]*)$/)
        .refine((v) => BigInt(v) <= BigInt(MAX_BYTES)),
      sqlJsonbSha256: hash,
      expectedRootCount: z.literal(26),
    })
    .optional(),
});
/** Integrity/shape check for a private stored observation, never actual
 * source permission or admission. Recomputing hashes cannot authenticate it. */
export function parseCurrentRuntimeCatalogWitness(raw: unknown) {
  boundedPlain(raw);
  const parsed = artifactSchema.safeParse(raw);
  if (!parsed.success) fail('CATALOG_WITNESS_INVALID');
  const { observation, ...body } = parsed.data;
  const expected = buildCurrentRuntimeCatalogWitness(body.metadata);
  if (JSON.stringify(canonical(body)) !== JSON.stringify(canonical(expected)))
    fail('CATALOG_WITNESS_INVALID');
  return observation === undefined ? expected : { ...expected, observation };
}
