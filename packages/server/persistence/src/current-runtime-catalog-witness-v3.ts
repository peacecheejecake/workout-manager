import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  currentRuntimeCatalogBaseMetadataSchema as baseSchema,
  parseCurrentRuntimeCatalogMetadata,
  catalogCtes,
  roleTag,
  normalizedAcl,
  boundedPlain,
  canonical,
  CurrentRuntimeCatalogWitnessError,
} from './current-runtime-catalog-witness.js';
import {
  currentRuntimeMigrationMembers,
  type CurrentRuntimeInstallationTransaction,
} from './current-runtime-installation.js';
import { currentRuntimeV2ExtensionMember } from './current-runtime-installation-v2.js';
import {
  verifyCurrentRuntimeV3InstalledIn,
  currentRuntimeV3ExtensionMember,
} from './current-runtime-installation-v3.js';
import { currentRuntimeV3RpcSourcePins } from './current-runtime-grants-v3.js';

const MAX_BYTES = 16 * 1024 * 1024;
const name = z
  .string()
  .min(1)
  .refine((v) => !v.includes('\0') && Buffer.byteLength(v, 'utf8') <= 63);
const text = z.string().max(2 * 1024 * 1024);
const nullable = text.nullable();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const tag = z.string().min(1).max(256);
const acl = z
  .array(z.strictObject({ grantee: tag, grantor: tag, privilege: text, grantable: z.boolean() }))
  .max(256);
const identity = { schema: name, name };
const constraint = baseSchema.shape.relations.element.shape.constraints.element;
const edge = z.strictObject({ dependent: text, referenced: text, kind: text });
const typeDetail = z.strictObject({
  ...identity,
  owner: tag,
  acl,
  runtimeUsage: z.boolean(),
  kind: text,
  length: z.number().int(),
  byValue: z.boolean(),
  category: text,
  preferred: z.boolean(),
  defined: z.boolean(),
  delimiter: text,
  alignment: text,
  storage: text,
  notNull: z.boolean(),
  dimensions: z.number().int(),
  element: nullable,
  array: nullable,
  base: nullable,
  typmod: z.number().int(),
  collation: nullable,
  input: text,
  output: text,
  receive: nullable,
  send: nullable,
  typmodIn: nullable,
  typmodOut: nullable,
  analyze: nullable,
  subscript: nullable,
  default: nullable,
  enumLabels: z.array(text).max(5000),
  domainConstraints: z.array(constraint).max(512),
  attributes: z
    .array(
      z.strictObject({
        position: z.number().int().positive(),
        name,
        dropped: z.boolean(),
        type: text,
        typmod: z.number().int(),
        collation: nullable,
        notNull: z.boolean(),
      }),
    )
    .max(512),
  range: z
    .strictObject({
      subtype: text,
      collation: nullable,
      operatorClass: text,
      canonical: nullable,
      difference: nullable,
      multirange: text,
    })
    .nullable(),
});
const relationDetail = z.strictObject({
  ...identity,
  replicaIdentity: text,
  accessMethod: nullable,
  options: z.array(text).max(256).nullable(),
  viewDefinition: nullable,
  rules: z
    .array(
      z.strictObject({ name, event: text, instead: z.boolean(), enabled: text, definition: text }),
    )
    .max(512),
  inheritance: z
    .array(
      z.strictObject({
        parent: text,
        sequence: z.number().int().positive(),
        detachPending: z.boolean(),
      }),
    )
    .max(512),
  indexState: z
    .strictObject({
      table: text,
      unique: z.boolean(),
      primary: z.boolean(),
      exclusion: z.boolean(),
      immediate: z.boolean(),
      clustered: z.boolean(),
      valid: z.boolean(),
      ready: z.boolean(),
      live: z.boolean(),
      replicaIdentity: z.boolean(),
      nullsNotDistinct: z.boolean(),
      keyCount: z.number().int(),
      attributeCount: z.number().int(),
      attributes: text,
      collations: z.array(nullable).max(512),
      operatorClasses: z.array(text).max(512),
      options: text,
      expressions: nullable,
      predicate: nullable,
    })
    .nullable(),
});
const extrasSchema = z.strictObject({
  typeDetails: z.array(typeDetail).max(5000),
  functionDetails: z
    .array(
      z.strictObject({
        ...identity,
        arguments: text,
        cost: z.number().finite(),
        rows: z.number().finite(),
        variadic: nullable,
        support: nullable,
        argumentTypes: z.array(text).max(512),
        allArgumentTypes: z.array(text).max(512).nullable(),
        argumentModes: z.array(text).max(512).nullable(),
        argumentNames: z.array(text).max(512).nullable(),
        defaultsSha256: hash.nullable(),
        sqlBodySha256: hash.nullable(),
        transforms: z.array(text).max(512).nullable(),
      }),
    )
    .max(5000),
  relationDetails: z.array(relationDetail).max(5000),
  operators: z
    .array(
      z.strictObject({
        ...identity,
        owner: tag,
        kind: text,
        left: nullable,
        right: nullable,
        result: text,
        procedure: text,
        commutator: nullable,
        negator: nullable,
        restrict: nullable,
        join: nullable,
        hashes: z.boolean(),
        merges: z.boolean(),
      }),
    )
    .max(5000),
  casts: z
    .array(
      z.strictObject({
        source: text,
        target: text,
        function: nullable,
        context: text,
        method: text,
      }),
    )
    .max(5000),
  languages: z
    .array(
      z.strictObject({
        name,
        owner: tag,
        procedural: z.boolean(),
        trusted: z.boolean(),
        handler: nullable,
        inline: nullable,
        validator: nullable,
        acl,
        runtimeUsage: z.boolean(),
      }),
    )
    .max(256),
  accessMethods: z.array(z.strictObject({ name, kind: text, handler: text })).max(256),
  eventTriggers: z
    .array(
      z.strictObject({
        name,
        owner: tag,
        event: text,
        function: text,
        enabled: text,
        tags: z.array(text).max(256).nullable(),
      }),
    )
    .max(512),
  foreignWrappers: z
    .array(
      z.strictObject({
        name,
        owner: tag,
        handler: nullable,
        validator: nullable,
        optionsSha256: hash.nullable(),
        acl,
        runtimeUsage: z.boolean(),
      }),
    )
    .max(512),
  foreignServers: z
    .array(
      z.strictObject({
        name,
        owner: tag,
        wrapper: text,
        type: nullable,
        version: nullable,
        optionsSha256: hash.nullable(),
        acl,
        runtimeUsage: z.boolean(),
      }),
    )
    .max(512),
  foreignTables: z
    .array(z.strictObject({ ...identity, server: text, optionsSha256: hash.nullable() }))
    .max(5000),
  userMappings: z
    .array(
      z.strictObject({
        user: tag,
        server: text,
        optionsSha256: hash.nullable(),
        optionsVisibility: z.enum(['owned_visible', 'not_verified']),
      }),
    )
    .max(1000),
  operatorClasses: z
    .array(
      z.strictObject({
        ...identity,
        owner: tag,
        method: text,
        family: text,
        input: text,
        storage: nullable,
        default: z.boolean(),
      }),
    )
    .max(5000),
  operatorFamilies: z
    .array(
      z.strictObject({
        ...identity,
        owner: tag,
        method: text,
        operators: z
          .array(
            z.strictObject({
              strategy: z.number().int(),
              purpose: text,
              operator: text,
              left: text,
              right: text,
              sortFamily: nullable,
            }),
          )
          .max(5000),
        procedures: z
          .array(
            z.strictObject({ number: z.number().int(), function: text, left: text, right: text }),
          )
          .max(5000),
      }),
    )
    .max(5000),
  aggregates: z
    .array(
      z.strictObject({
        function: text,
        kind: text,
        directArguments: z.number().int(),
        transition: text,
        final: nullable,
        combine: nullable,
        serialize: nullable,
        deserialize: nullable,
        movingTransition: nullable,
        movingInverse: nullable,
        movingFinal: nullable,
        finalExtra: z.boolean(),
        movingFinalExtra: z.boolean(),
        finalModify: text,
        movingFinalModify: text,
        sortOperator: nullable,
        transitionType: text,
        transitionSpace: z.number().int(),
        movingTransitionType: nullable,
        movingTransitionSpace: z.number().int(),
        initial: nullable,
        movingInitial: nullable,
      }),
    )
    .max(5000),
  transforms: z
    .array(z.strictObject({ type: text, language: name, fromSql: nullable, toSql: nullable }))
    .max(5000),
  additionalDependencies: z.array(edge).max(50000),
  sharedDependencies: z.array(edge).max(50000),
});
export const currentRuntimeCatalogMetadataV3Schema = baseSchema.extend(extrasSchema.shape);
export type CurrentRuntimeCatalogMetadataV3 = z.infer<typeof currentRuntimeCatalogMetadataV3Schema>;
function fail(code: CurrentRuntimeCatalogWitnessError['code']): never {
  throw new CurrentRuntimeCatalogWitnessError(code);
}
function sha(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
function unique(values: string[]) {
  if (new Set(values).size !== values.length) fail('CATALOG_WITNESS_INVALID');
}
export function parseCurrentRuntimeCatalogMetadataV3(
  raw: unknown,
): CurrentRuntimeCatalogMetadataV3 {
  boundedPlain(raw);
  const parsed = currentRuntimeCatalogMetadataV3Schema.safeParse(raw);
  if (!parsed.success) fail('CATALOG_WITNESS_INVALID');
  const m = parsed.data;
  const base = Object.fromEntries(
    Object.keys(baseSchema.shape).map((key) => [key, Reflect.get(m, key)]),
  );
  parseCurrentRuntimeCatalogMetadata(base);
  const roles = new Set(['PUBLIC', ...m.roles.map((r) => r.tag)]);
  const known = (owner: string) => {
    if (!roles.has(owner)) fail('CATALOG_WITNESS_INVALID');
  };
  const checkAcl = (a: z.infer<typeof acl>) => {
    unique(a.map((v) => JSON.stringify([v.grantee, v.grantor, v.privilege])));
    for (const v of a) {
      known(v.grantee);
      known(v.grantor);
    }
  };
  for (const values of [m.typeDetails, m.relationDetails, m.foreignTables])
    unique(values.map((v) => JSON.stringify([v.schema, v.name])));
  for (const values of [
    m.languages,
    m.accessMethods,
    m.eventTriggers,
    m.foreignWrappers,
    m.foreignServers,
  ])
    unique(values.map((v) => v.name));
  unique(m.functionDetails.map((v) => JSON.stringify([v.schema, v.name, v.arguments])));
  unique(m.operators.map((v) => JSON.stringify([v.schema, v.name, v.left, v.right])));
  unique(m.operatorClasses.map((v) => JSON.stringify([v.schema, v.name, v.method])));
  unique(m.operatorFamilies.map((v) => JSON.stringify([v.schema, v.name, v.method])));
  unique(m.aggregates.map((v) => v.function));
  unique(m.transforms.map((v) => JSON.stringify([v.type, v.language])));
  unique(m.casts.map((v) => JSON.stringify([v.source, v.target])));
  unique(m.userMappings.map((v) => JSON.stringify([v.user, v.server])));
  for (const values of [
    m.typeDetails,
    m.operators,
    m.operatorClasses,
    m.operatorFamilies,
    m.languages,
    m.eventTriggers,
    m.foreignWrappers,
    m.foreignServers,
  ])
    for (const v of values) known(v.owner);
  for (const values of [m.typeDetails, m.languages, m.foreignWrappers, m.foreignServers])
    for (const v of values) checkAcl(v.acl);
  for (const v of m.userMappings) known(v.user);
  const exactRoster = (a: string[], b: string[]) => {
    if (JSON.stringify([...a].sort()) !== JSON.stringify([...b].sort()))
      fail('CATALOG_WITNESS_INVALID');
  };
  exactRoster(
    m.functions.map((v) => JSON.stringify([v.schema, v.name, v.arguments])),
    m.functionDetails.map((v) => JSON.stringify([v.schema, v.name, v.arguments])),
  );
  exactRoster(
    m.types.map((v) => JSON.stringify([v.schema, v.name])),
    m.typeDetails.map((v) => JSON.stringify([v.schema, v.name])),
  );
  exactRoster(
    m.relations.map((v) => JSON.stringify([v.schema, v.name])),
    m.relationDetails.map((v) => JSON.stringify([v.schema, v.name])),
  );
  for (const t of m.typeDetails) {
    unique(t.domainConstraints.map((c) => c.name));
    unique(t.attributes.map((a) => String(a.position)));
  }
  for (const r of m.relationDetails) {
    const original = m.relations.find((v) => v.schema === r.schema && v.name === r.name);
    if (
      !original ||
      ['i', 'I'].includes(original.kind) !== (r.indexState !== null) ||
      ['v', 'm'].includes(original.kind) !== (r.viewDefinition !== null)
    )
      fail('CATALOG_WITNESS_INVALID');
    unique(r.rules.map((v) => v.name));
    unique(r.inheritance.map((v) => String(v.sequence)));
  }
  for (const values of [m.additionalDependencies, m.sharedDependencies])
    unique(values.map((v) => JSON.stringify(v)));
  return m;
}
const sections = Object.keys(currentRuntimeCatalogMetadataV3Schema.shape).filter(
  (k) => k !== 'serverVersion',
);
/** Profile19 whole catalog observation, not a dynamic/wire/recipe admission seal. */
export function buildCurrentRuntimeCatalogWitnessV3(raw: unknown) {
  const metadata = parseCurrentRuntimeCatalogMetadataV3(raw);
  const artifact = {
    witnessVersion: 3 as const,
    metadataEncoding: 'pg-catalog-runtime-security-normalized-v3' as const,
    profile: {
      profileVersion: 3 as const,
      baselineSchemaVersion: 107 as const,
      runtimeStep: 19 as const,
      sourceDdlTip: 129 as const,
      runtimeSteps: [
        ...currentRuntimeMigrationMembers,
        ...[currentRuntimeV2ExtensionMember, currentRuntimeV3ExtensionMember].map((v, i) => ({
          step: 18 + i,
          sourceDdlId: v.sourceDdlId,
          filename: v.filename,
          sha256: v.sha256,
        })),
      ],
    },
    metadata,
    sections: sections.map((section) => {
      const value: unknown = Reflect.get(metadata, section);
      if (!Array.isArray(value)) fail('CATALOG_WITNESS_INVALID');
      const body = JSON.stringify(canonical(value));
      return {
        section,
        rowCount: value.length,
        bytes: Buffer.byteLength(body, 'utf8'),
        sha256: sha(body),
      };
    }),
    closure: {
      catalogObservation: 'enumerated' as const,
      dynamicDependencies: 'not_verified' as const,
      strictCallerWire: 'not_verified' as const,
      effectiveRecipe: 'not_verified' as const,
      independentNormalization: 'not_verified' as const,
    },
    supported: false as const,
    processingAuthority: 'none' as const,
    restore: 'not_verified' as const,
    unknownNamespaces: metadata.schemas
      .filter(
        (v) =>
          !new Set([
            'public',
            'identity_private',
            'garmin_private',
            'wm_app_load',
            'wm_check_in_templates_v1',
            'wm_runtime_installation',
          ]).has(v.name),
      )
      .map((v) => v.name),
    unmappedRoleTags: metadata.roles.filter((v) => v.tag.startsWith('unmapped:')).map((v) => v.tag),
    catalogSha256: sha(JSON.stringify(canonical(metadata))),
  };
  boundedPlain(artifact);
  return artifact;
}

// Compile-time SQL only. The parent SQL is reused unchanged, including real FK
// trigger normalization. Additional roles are actual catalog/ACL principals;
// unrelated cluster roles are not inserted into profile authority.
// PostgreSQL's reserved prefix is literal pg_; LIKE 'pg_%' would also hide
// genuine quoted user names such as pgXObserved. Parent17 SQL remains unchanged.
const baseCtes = catalogCtes
  .replaceAll('role_tags', 'base_role_tags')
  .replaceAll("nspname NOT LIKE 'pg_%'", "left(nspname,3)<>'pg_'")
  .replaceAll("rolname LIKE 'pg_%'", "left(rolname,3)='pg_'");
const reg = (v: string) => `CASE WHEN ${v}=0 THEN NULL ELSE ${v}::regprocedure::text END`;
const optionHash = (v: string) =>
  `CASE WHEN ${v} IS NULL THEN NULL ELSE encode(sha256(convert_to(${v}::text,'UTF8')),'hex') END`;
const qualify = (n: string, v: string) => `format('%I.%I',${n},${v})`;
const aggregate = (query: string, order: string) =>
  `coalesce((SELECT jsonb_agg(value ORDER BY ${order}) FROM (${query}) entries),'[]'::jsonb)`;
const opIdentity = (v: string) => `CASE WHEN ${v}=0 THEN NULL ELSE ${v}::regoperator::text END`;
const extraCtes = `,
 user_types AS (SELECT t.* FROM pg_catalog.pg_type t JOIN ns n ON n.oid=t.typnamespace),
 user_ops AS (SELECT o.* FROM pg_catalog.pg_operator o JOIN ns n ON n.oid=o.oprnamespace),
 user_opclasses AS (SELECT o.* FROM pg_catalog.pg_opclass o JOIN ns n ON n.oid=o.opcnamespace),
 user_opfamilies AS (SELECT o.* FROM pg_catalog.pg_opfamily o JOIN ns n ON n.oid=o.opfnamespace),
 user_casts AS (SELECT c.* FROM pg_catalog.pg_cast c WHERE c.castsource IN(SELECT oid FROM user_types) OR c.casttarget IN(SELECT oid FROM user_types) OR c.castfunc IN(SELECT oid FROM funcs)),
 extra_acl AS (SELECT typacl acl,typowner owner,'T'::"char" kind FROM user_types
 UNION ALL SELECT lanacl,lanowner,'l' FROM pg_catalog.pg_language
 UNION ALL SELECT fdwacl,fdwowner,'F' FROM pg_catalog.pg_foreign_data_wrapper
 UNION ALL SELECT srvacl,srvowner,'S' FROM pg_catalog.pg_foreign_server),
 extra_seed AS (SELECT oid FROM base_role_tags UNION SELECT owner FROM extra_acl
 UNION SELECT oprowner FROM user_ops UNION SELECT opcowner FROM user_opclasses UNION SELECT opfowner FROM user_opfamilies
 UNION SELECT evtowner FROM pg_catalog.pg_event_trigger UNION SELECT umuser FROM pg_catalog.pg_user_mappings
 UNION SELECT a.grantee FROM extra_acl i CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(i.acl,pg_catalog.acldefault(i.kind,i.owner))) a
 UNION SELECT a.grantor FROM extra_acl i CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(i.acl,pg_catalog.acldefault(i.kind,i.owner))) a),
 extra_scope AS (SELECT oid FROM extra_seed WHERE oid<>0 UNION SELECT e.b FROM extra_scope s JOIN edges e ON e.a=s.oid),
 role_tags AS (SELECT r.*,coalesce(b.tag,CASE WHEN r.oid=(SELECT nspowner FROM pg_catalog.pg_namespace WHERE nspname='pg_catalog') THEN 'catalog_owner' WHEN left(r.rolname,3)='pg_' THEN 'builtin:'||r.rolname ELSE 'unmapped:'||r.rolname END) tag FROM pg_catalog.pg_roles r LEFT JOIN base_role_tags b ON b.oid=r.oid WHERE r.oid IN(SELECT oid FROM extra_scope)),
 extra_objects AS (
 SELECT 'pg_type'::regclass classid,oid objid FROM user_types UNION SELECT 'pg_operator'::regclass,oid FROM user_ops
 UNION SELECT 'pg_opclass'::regclass,oid FROM user_opclasses UNION SELECT 'pg_opfamily'::regclass,oid FROM user_opfamilies
 UNION SELECT 'pg_cast'::regclass,oid FROM user_casts UNION SELECT 'pg_transform'::regclass,oid FROM pg_catalog.pg_transform WHERE trftype IN(SELECT oid FROM user_types) OR trffromsql IN(SELECT oid FROM funcs) OR trftosql IN(SELECT oid FROM funcs) UNION SELECT 'pg_language'::regclass,oid FROM pg_catalog.pg_language
 UNION SELECT 'pg_am'::regclass,oid FROM pg_catalog.pg_am UNION SELECT 'pg_event_trigger'::regclass,oid FROM pg_catalog.pg_event_trigger
 UNION SELECT 'pg_foreign_data_wrapper'::regclass,oid FROM pg_catalog.pg_foreign_data_wrapper UNION SELECT 'pg_foreign_server'::regclass,oid FROM pg_catalog.pg_foreign_server
 UNION SELECT 'pg_user_mapping'::regclass,umid FROM pg_catalog.pg_user_mappings
 UNION SELECT 'pg_rewrite'::regclass,oid FROM pg_catalog.pg_rewrite WHERE ev_class IN(SELECT oid FROM rels)
 UNION SELECT 'pg_constraint'::regclass,oid FROM pg_catalog.pg_constraint WHERE contypid IN(SELECT oid FROM user_types)),
 all_objects AS (SELECT * FROM extra_objects UNION SELECT 'pg_proc'::regclass,oid FROM funcs UNION SELECT 'pg_class'::regclass,oid FROM rels
 UNION SELECT 'pg_constraint'::regclass,oid FROM pg_catalog.pg_constraint WHERE conrelid IN(SELECT oid FROM rels)
 UNION SELECT 'pg_trigger'::regclass,oid FROM pg_catalog.pg_trigger WHERE tgrelid IN(SELECT oid FROM rels)),
 mapping_ids AS (SELECT m.umid oid,'user-mapping:'||jsonb_build_object('user',CASE WHEN m.umuser=0 THEN 'PUBLIC' ELSE ${roleTag('m.umuser')} END,'server',s.srvname)::text identity FROM pg_catalog.pg_user_mappings m JOIN pg_catalog.pg_foreign_server s ON s.oid=m.srvid),
 additional_edges AS (SELECT DISTINCT
 coalesce(dt.description,dm.identity,pg_catalog.pg_describe_object(d.classid,d.objid,d.objsubid)) dependent,
 coalesce(rt.description,rm.identity,pg_catalog.pg_describe_object(d.refclassid,d.refobjid,d.refobjsubid)) referenced,d.deptype::text kind
 FROM pg_catalog.pg_depend d JOIN extra_objects o ON o.classid=d.classid AND o.objid=d.objid
 LEFT JOIN internal_fk_trigger_identities dt ON d.classid='pg_trigger'::regclass AND dt.oid=d.objid AND d.objsubid=0
 LEFT JOIN internal_fk_trigger_identities rt ON d.refclassid='pg_trigger'::regclass AND rt.oid=d.refobjid AND d.refobjsubid=0
 LEFT JOIN mapping_ids dm ON d.classid='pg_user_mapping'::regclass AND dm.oid=d.objid
 LEFT JOIN mapping_ids rm ON d.refclassid='pg_user_mapping'::regclass AND rm.oid=d.refobjid),
 shared_edges AS (SELECT DISTINCT coalesce(t.description,m.identity,pg_catalog.pg_describe_object(d.classid,d.objid,d.objsubid)) dependent,
 CASE WHEN d.refclassid='pg_authid'::regclass THEN ${roleTag('d.refobjid')} ELSE pg_catalog.pg_describe_object(d.refclassid,d.refobjid,0) END referenced,d.deptype::text kind
 FROM pg_catalog.pg_shdepend d JOIN all_objects o ON o.classid=d.classid AND o.objid=d.objid
 LEFT JOIN internal_fk_trigger_identities t ON d.classid='pg_trigger'::regclass AND t.oid=d.objid AND d.objsubid=0
 LEFT JOIN mapping_ids m ON d.classid='pg_user_mapping'::regclass AND m.oid=d.objid
 WHERE d.dbid=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())),
 enriched AS MATERIALIZED (SELECT body || jsonb_build_object(
 'roles',${aggregate(`SELECT tag ordering,jsonb_build_object('tag',tag,'superuser',rolsuper,'bypassRls',rolbypassrls,'createRole',rolcreaterole,'createDb',rolcreatedb,'inherit',rolinherit,'login',rolcanlogin,'replication',rolreplication,'configurationSha256',${optionHash('rolconfig')}) value FROM role_tags`, 'ordering COLLATE "C"')},
 'memberships',${aggregate(`SELECT ${roleTag('a.roleid')} r,${roleTag('a.member')} m,${roleTag('a.grantor')} g,jsonb_build_object('role',${roleTag('a.roleid')},'member',${roleTag('a.member')},'grantor',${roleTag('a.grantor')},'admin',a.admin_option,'inherit',(to_jsonb(a)->>'inherit_option')::boolean,'set',(to_jsonb(a)->>'set_option')::boolean) value FROM pg_catalog.pg_auth_members a WHERE a.roleid IN(SELECT oid FROM extra_scope) AND a.member IN(SELECT oid FROM extra_scope) AND a.grantor IN(SELECT oid FROM extra_scope)`, 'r COLLATE "C",m COLLATE "C",g COLLATE "C"')},
 'functionDetails',${aggregate(`SELECT n.nspname s,p.proname n,pg_catalog.pg_get_function_identity_arguments(p.oid) a,jsonb_build_object('schema',n.nspname,'name',p.proname,'arguments',pg_catalog.pg_get_function_identity_arguments(p.oid),'cost',p.procost,'rows',p.prorows,'variadic',CASE WHEN p.provariadic<>0 THEN p.provariadic::regtype::text END,'support',${reg('p.prosupport')},'argumentTypes',coalesce((SELECT jsonb_agg(v::regtype::text ORDER BY ord) FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY u(v,ord)),'[]'::jsonb),'allArgumentTypes',CASE WHEN p.proallargtypes IS NOT NULL THEN (SELECT jsonb_agg(v::regtype::text ORDER BY ord) FROM unnest(p.proallargtypes) WITH ORDINALITY u(v,ord)) END,'argumentModes',p.proargmodes,'argumentNames',p.proargnames,'defaultsSha256',${optionHash('pg_catalog.pg_get_expr(p.proargdefaults,0)')},'sqlBodySha256',CASE WHEN p.prosqlbody IS NOT NULL AND p.prokind IN('f','p') THEN encode(sha256(convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8')),'hex') END,'transforms',CASE WHEN p.protrftypes IS NOT NULL THEN (SELECT jsonb_agg(v::regtype::text ORDER BY ord) FROM unnest(p.protrftypes) WITH ORDINALITY u(v,ord)) END) value FROM funcs p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace`, 's COLLATE "C",n COLLATE "C",a COLLATE "C"')},
 'typeDetails',${aggregate(
   `SELECT n.nspname s,t.typname n,jsonb_build_object('schema',n.nspname,'name',t.typname,'owner',${roleTag('t.typowner')},'acl',${normalizedAcl('t.typacl', 't.typowner', 'T')},'runtimeUsage',pg_catalog.has_type_privilege($1,t.oid,'USAGE'),'kind',t.typtype,'length',t.typlen,'byValue',t.typbyval,'category',t.typcategory,'preferred',t.typispreferred,'defined',t.typisdefined,'delimiter',t.typdelim,'alignment',t.typalign,'storage',t.typstorage,'notNull',t.typnotnull,'dimensions',t.typndims,'element',CASE WHEN t.typelem<>0 THEN t.typelem::regtype::text END,'array',CASE WHEN t.typarray<>0 THEN t.typarray::regtype::text END,'base',CASE WHEN t.typbasetype<>0 THEN t.typbasetype::regtype::text END,'typmod',t.typtypmod,'collation',CASE WHEN t.typcollation<>0 THEN t.typcollation::regcollation::text END,'input',t.typinput::regprocedure::text,'output',t.typoutput::regprocedure::text,'receive',${reg('t.typreceive')},'send',${reg('t.typsend')},'typmodIn',${reg('t.typmodin')},'typmodOut',${reg('t.typmodout')},'analyze',${reg('t.typanalyze')},'subscript',${reg('t.typsubscript')},'default',t.typdefault,
 'enumLabels',coalesce((SELECT jsonb_agg(enumlabel ORDER BY enumsortorder) FROM pg_catalog.pg_enum WHERE enumtypid=t.oid),'[]'::jsonb),
 'domainConstraints',coalesce((SELECT jsonb_agg(jsonb_build_object('name',k.conname,'kind',k.contype,'definition',pg_catalog.pg_get_constraintdef(k.oid,true),'validated',k.convalidated,'deferrable',k.condeferrable,'deferred',k.condeferred) ORDER BY k.conname COLLATE "C") FROM pg_catalog.pg_constraint k WHERE k.contypid=t.oid),'[]'::jsonb),
 'attributes',coalesce((SELECT jsonb_agg(jsonb_build_object('position',a.attnum,'name',a.attname,'dropped',a.attisdropped,'type',coalesce(pg_catalog.format_type(a.atttypid,a.atttypmod),'dropped'),'typmod',a.atttypmod,'collation',CASE WHEN a.attcollation<>0 THEN a.attcollation::regcollation::text END,'notNull',a.attnotnull) ORDER BY a.attnum) FROM pg_catalog.pg_attribute a WHERE a.attrelid=t.typrelid AND a.attnum>0),'[]'::jsonb),
 'range',(SELECT jsonb_build_object('subtype',r.rngsubtype::regtype::text,'collation',CASE WHEN r.rngcollation<>0 THEN r.rngcollation::regcollation::text END,'operatorClass',${qualify('onsp.nspname', 'oc.opcname')},'canonical',${reg('r.rngcanonical')},'difference',${reg('r.rngsubdiff')},'multirange',r.rngmultitypid::regtype::text) FROM pg_catalog.pg_range r JOIN pg_catalog.pg_opclass oc ON oc.oid=r.rngsubopc JOIN pg_catalog.pg_namespace onsp ON onsp.oid=oc.opcnamespace WHERE r.rngtypid=t.oid OR r.rngmultitypid=t.oid)) value FROM user_types t JOIN ns n ON n.oid=t.typnamespace`,
   's COLLATE "C",n COLLATE "C"',
 )},
 'relationDetails',${aggregate(
   `SELECT n.nspname s,c.relname n,jsonb_build_object('schema',n.nspname,'name',c.relname,'replicaIdentity',c.relreplident,'accessMethod',am.amname,'options',c.reloptions,'viewDefinition',CASE WHEN c.relkind IN('v','m') THEN pg_catalog.pg_get_viewdef(c.oid,true) END,
 'rules',coalesce((SELECT jsonb_agg(jsonb_build_object('name',r.rulename,'event',r.ev_type,'instead',r.is_instead,'enabled',r.ev_enabled,'definition',pg_catalog.pg_get_ruledef(r.oid,true)) ORDER BY r.rulename COLLATE "C") FROM pg_catalog.pg_rewrite r WHERE r.ev_class=c.oid),'[]'::jsonb),
 'inheritance',coalesce((SELECT jsonb_agg(jsonb_build_object('parent',${qualify('pn.nspname', 'pc.relname')},'sequence',i.inhseqno,'detachPending',i.inhdetachpending) ORDER BY i.inhseqno) FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class pc ON pc.oid=i.inhparent JOIN pg_catalog.pg_namespace pn ON pn.oid=pc.relnamespace WHERE i.inhrelid=c.oid),'[]'::jsonb),
 'indexState',(SELECT jsonb_build_object('table',${qualify('tn.nspname', 'tc.relname')},'unique',i.indisunique,'primary',i.indisprimary,'exclusion',i.indisexclusion,'immediate',i.indimmediate,'clustered',i.indisclustered,'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,'replicaIdentity',i.indisreplident,'nullsNotDistinct',i.indnullsnotdistinct,'keyCount',i.indnkeyatts,'attributeCount',i.indnatts,'attributes',i.indkey::text,'collations',(SELECT jsonb_agg(CASE WHEN v=0 THEN NULL ELSE v::regcollation::text END ORDER BY ord) FROM unnest(i.indcollation::oid[]) WITH ORDINALITY u(v,ord)),'operatorClasses',(SELECT jsonb_agg(${qualify('opn.nspname', 'oc.opcname')} ORDER BY ord) FROM unnest(i.indclass::oid[]) WITH ORDINALITY u(v,ord) JOIN pg_catalog.pg_opclass oc ON oc.oid=u.v JOIN pg_catalog.pg_namespace opn ON opn.oid=oc.opcnamespace),'options',i.indoption::text,'expressions',pg_catalog.pg_get_expr(i.indexprs,i.indrelid),'predicate',pg_catalog.pg_get_expr(i.indpred,i.indrelid)) FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class tc ON tc.oid=i.indrelid JOIN pg_catalog.pg_namespace tn ON tn.oid=tc.relnamespace WHERE i.indexrelid=c.oid)) value FROM rels c JOIN ns n ON n.oid=c.relnamespace LEFT JOIN pg_catalog.pg_am am ON am.oid=c.relam`,
   's COLLATE "C",n COLLATE "C"',
 )},
 'operators',${aggregate(`SELECT n.nspname s,o.oprname n,o.oprleft::regtype::text l,o.oprright::regtype::text r,jsonb_build_object('schema',n.nspname,'name',o.oprname,'owner',${roleTag('o.oprowner')},'kind',o.oprkind,'left',CASE WHEN o.oprleft<>0 THEN o.oprleft::regtype::text END,'right',CASE WHEN o.oprright<>0 THEN o.oprright::regtype::text END,'result',o.oprresult::regtype::text,'procedure',o.oprcode::regprocedure::text,'commutator',${opIdentity('o.oprcom')},'negator',${opIdentity('o.oprnegate')},'restrict',${reg('o.oprrest')},'join',${reg('o.oprjoin')},'hashes',o.oprcanhash,'merges',o.oprcanmerge) value FROM user_ops o JOIN ns n ON n.oid=o.oprnamespace`, 's COLLATE "C",n COLLATE "C",l COLLATE "C",r COLLATE "C"')},
 'casts',${aggregate(`SELECT c.castsource::regtype::text s,c.casttarget::regtype::text t,jsonb_build_object('source',c.castsource::regtype::text,'target',c.casttarget::regtype::text,'function',${reg('c.castfunc')},'context',c.castcontext,'method',c.castmethod) value FROM user_casts c`, 's COLLATE "C",t COLLATE "C"')},
 'languages',${aggregate(`SELECT l.lanname n,jsonb_build_object('name',l.lanname,'owner',${roleTag('l.lanowner')},'procedural',l.lanispl,'trusted',l.lanpltrusted,'handler',${reg('l.lanplcallfoid')},'inline',${reg('l.laninline')},'validator',${reg('l.lanvalidator')},'acl',${normalizedAcl('l.lanacl', 'l.lanowner', 'l')},'runtimeUsage',pg_catalog.has_language_privilege($1,l.oid,'USAGE')) value FROM pg_catalog.pg_language l`, 'n COLLATE "C"')},
 'accessMethods',${aggregate(`SELECT a.amname n,jsonb_build_object('name',a.amname,'kind',a.amtype,'handler',a.amhandler::regprocedure::text) value FROM pg_catalog.pg_am a`, 'n COLLATE "C"')},
 'eventTriggers',${aggregate(`SELECT e.evtname n,jsonb_build_object('name',e.evtname,'owner',${roleTag('e.evtowner')},'event',e.evtevent,'function',e.evtfoid::regprocedure::text,'enabled',e.evtenabled,'tags',e.evttags) value FROM pg_catalog.pg_event_trigger e`, 'n COLLATE "C"')},
 'foreignWrappers',${aggregate(`SELECT f.fdwname n,jsonb_build_object('name',f.fdwname,'owner',${roleTag('f.fdwowner')},'handler',${reg('f.fdwhandler')},'validator',${reg('f.fdwvalidator')},'optionsSha256',${optionHash('f.fdwoptions')},'acl',${normalizedAcl('f.fdwacl', 'f.fdwowner', 'F')},'runtimeUsage',pg_catalog.has_foreign_data_wrapper_privilege($1,f.oid,'USAGE')) value FROM pg_catalog.pg_foreign_data_wrapper f`, 'n COLLATE "C"')},
 'foreignServers',${aggregate(`SELECT s.srvname n,jsonb_build_object('name',s.srvname,'owner',${roleTag('s.srvowner')},'wrapper',f.fdwname,'type',s.srvtype,'version',s.srvversion,'optionsSha256',${optionHash('s.srvoptions')},'acl',${normalizedAcl('s.srvacl', 's.srvowner', 'S')},'runtimeUsage',pg_catalog.has_server_privilege($1,s.oid,'USAGE')) value FROM pg_catalog.pg_foreign_server s JOIN pg_catalog.pg_foreign_data_wrapper f ON f.oid=s.srvfdw`, 'n COLLATE "C"')},
 'foreignTables',${aggregate(`SELECT n.nspname s,c.relname n,jsonb_build_object('schema',n.nspname,'name',c.relname,'server',s.srvname,'optionsSha256',${optionHash('f.ftoptions')}) value FROM pg_catalog.pg_foreign_table f JOIN rels c ON c.oid=f.ftrelid JOIN ns n ON n.oid=c.relnamespace JOIN pg_catalog.pg_foreign_server s ON s.oid=f.ftserver`, 's COLLATE "C",n COLLATE "C"')},
 'userMappings',${aggregate(`SELECT CASE WHEN m.umuser=0 THEN 'PUBLIC' ELSE ${roleTag('m.umuser')} END u,s.srvname s,jsonb_build_object('user',CASE WHEN m.umuser=0 THEN 'PUBLIC' ELSE ${roleTag('m.umuser')} END,'server',s.srvname,'optionsSha256',${optionHash('m.umoptions')},'optionsVisibility',CASE WHEN s.srvowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) AND (m.umuser=0 OR m.umuser=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)) THEN 'owned_visible' ELSE 'not_verified' END) value FROM pg_catalog.pg_user_mappings m JOIN pg_catalog.pg_foreign_server s ON s.oid=m.srvid`, 'u COLLATE "C",s COLLATE "C"')},
 'operatorClasses',${aggregate(`SELECT n.nspname s,o.opcname n,a.amname method,jsonb_build_object('schema',n.nspname,'name',o.opcname,'owner',${roleTag('o.opcowner')},'method',a.amname,'family',${qualify('fn.nspname', 'f.opfname')},'input',o.opcintype::regtype::text,'storage',CASE WHEN o.opckeytype<>0 THEN o.opckeytype::regtype::text END,'default',o.opcdefault) value FROM user_opclasses o JOIN ns n ON n.oid=o.opcnamespace JOIN pg_catalog.pg_am a ON a.oid=o.opcmethod JOIN pg_catalog.pg_opfamily f ON f.oid=o.opcfamily JOIN pg_catalog.pg_namespace fn ON fn.oid=f.opfnamespace`, 's COLLATE "C",n COLLATE "C",method COLLATE "C"')},
 'operatorFamilies',${aggregate(
   `SELECT n.nspname s,o.opfname n,a.amname method,jsonb_build_object('schema',n.nspname,'name',o.opfname,'owner',${roleTag('o.opfowner')},'method',a.amname,
 'operators',coalesce((SELECT jsonb_agg(jsonb_build_object('strategy',x.amopstrategy,'purpose',x.amoppurpose,'operator',x.amopopr::regoperator::text,'left',x.amoplefttype::regtype::text,'right',x.amoprighttype::regtype::text,'sortFamily',CASE WHEN x.amopsortfamily<>0 THEN (SELECT ${qualify('sn.nspname', 'sf.opfname')} FROM pg_catalog.pg_opfamily sf JOIN pg_catalog.pg_namespace sn ON sn.oid=sf.opfnamespace WHERE sf.oid=x.amopsortfamily) END) ORDER BY x.amopstrategy,x.amoppurpose,x.amoplefttype::regtype::text COLLATE "C",x.amoprighttype::regtype::text COLLATE "C") FROM pg_catalog.pg_amop x WHERE x.amopfamily=o.oid),'[]'::jsonb),
 'procedures',coalesce((SELECT jsonb_agg(jsonb_build_object('number',x.amprocnum,'function',x.amproc::regprocedure::text,'left',x.amproclefttype::regtype::text,'right',x.amprocrighttype::regtype::text) ORDER BY x.amprocnum,x.amproclefttype::regtype::text COLLATE "C",x.amprocrighttype::regtype::text COLLATE "C") FROM pg_catalog.pg_amproc x WHERE x.amprocfamily=o.oid),'[]'::jsonb)) value FROM user_opfamilies o JOIN ns n ON n.oid=o.opfnamespace JOIN pg_catalog.pg_am a ON a.oid=o.opfmethod`,
   's COLLATE "C",n COLLATE "C"',
 )},
 'aggregates',${aggregate(`SELECT p.oid::regprocedure::text f,jsonb_build_object('function',p.oid::regprocedure::text,'kind',a.aggkind,'directArguments',a.aggnumdirectargs,'transition',a.aggtransfn::regprocedure::text,'final',${reg('a.aggfinalfn')},'combine',${reg('a.aggcombinefn')},'serialize',${reg('a.aggserialfn')},'deserialize',${reg('a.aggdeserialfn')},'movingTransition',${reg('a.aggmtransfn')},'movingInverse',${reg('a.aggminvtransfn')},'movingFinal',${reg('a.aggmfinalfn')},'finalExtra',a.aggfinalextra,'movingFinalExtra',a.aggmfinalextra,'finalModify',a.aggfinalmodify,'movingFinalModify',a.aggmfinalmodify,'sortOperator',${opIdentity('a.aggsortop')},'transitionType',a.aggtranstype::regtype::text,'transitionSpace',a.aggtransspace,'movingTransitionType',CASE WHEN a.aggmtranstype<>0 THEN a.aggmtranstype::regtype::text END,'movingTransitionSpace',a.aggmtransspace,'initial',a.agginitval,'movingInitial',a.aggminitval) value FROM pg_catalog.pg_aggregate a JOIN funcs p ON p.oid=a.aggfnoid`, 'f COLLATE "C"')},
 'transforms',${aggregate(`SELECT t.trftype::regtype::text t,l.lanname l,jsonb_build_object('type',t.trftype::regtype::text,'language',l.lanname,'fromSql',${reg('t.trffromsql')},'toSql',${reg('t.trftosql')}) value FROM pg_catalog.pg_transform t JOIN pg_catalog.pg_language l ON l.oid=t.trflang WHERE t.trftype IN(SELECT oid FROM user_types) OR t.trffromsql IN(SELECT oid FROM funcs) OR t.trftosql IN(SELECT oid FROM funcs)`, 't COLLATE "C",l COLLATE "C"')},
 'additionalDependencies',${aggregate('SELECT dependent d,referenced r,kind k,to_jsonb(e) value FROM additional_edges e', 'd COLLATE "C",r COLLATE "C",k COLLATE "C"')},
 'sharedDependencies',${aggregate('SELECT dependent d,referenced r,kind k,to_jsonb(e) value FROM shared_edges e', 'd COLLATE "C",r COLLATE "C",k COLLATE "C"')}
 ) AS body FROM payload)
`;
const sql = baseCtes + extraCtes;
/** Owner RR READ ONLY observation only; no body text, health rows or private RPC. */
export async function captureCurrentRuntimeCatalogWitnessV3In(
  tx: CurrentRuntimeInstallationTransaction,
  unknownRuntimeRole: unknown,
) {
  const runtimeRole = z
    .string()
    .regex(/^[a-z_][a-z0-9_]{0,62}$/)
    .safeParse(unknownRuntimeRole);
  if (!runtimeRole.success) fail('CATALOG_WITNESS_INVALID');
  const context = await tx.query(
    `SELECT current_user=session_user AND NOT o.rolsuper AND NOT o.rolbypassrls AS owner,
 r.oid<>o.oid AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication
 AND NOT pg_has_role(r.oid,o.oid,'MEMBER') AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles e WHERE (e.rolsuper OR e.rolbypassrls) AND pg_has_role(r.oid,e.oid,'MEMBER'))
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner=r.oid) AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspowner=r.oid) AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.proowner=r.oid) AS runtime,
 current_setting('transaction_read_only')='on' AS "readOnly",current_setting('search_path') IN('pg_catalog,pg_temp','pg_catalog, pg_temp') AS "pathSafe",current_setting('transaction_isolation') AS isolation,(SELECT count(*)::int FROM pg_catalog.pg_roles) AS "roleCount"
 FROM pg_catalog.pg_roles o CROSS JOIN pg_catalog.pg_roles r WHERE o.rolname=session_user AND r.rolname=$1`,
    [runtimeRole.data],
  );
  boundedPlain(context.rows);
  const ctx = z
    .strictObject({
      owner: z.literal(true),
      runtime: z.literal(true),
      readOnly: z.literal(true),
      pathSafe: z.literal(true),
      isolation: z.enum(['repeatable read', 'serializable']),
      roleCount: z.number().int().min(2).max(10000),
    })
    .safeParse(context.rows[0]);
  if (context.rows.length !== 1 || !ctx.success) fail('CATALOG_WITNESS_CONTEXT_REQUIRED');
  await verifyCurrentRuntimeV3InstalledIn(tx);
  const counts = await tx.query(`SELECT
 (SELECT count(*)::int FROM pg_catalog.pg_proc WHERE pronamespace IN(SELECT oid FROM pg_catalog.pg_namespace WHERE left(nspname,3)<>'pg_' AND nspname<>'information_schema')) functions,
 (SELECT count(*)::int FROM pg_catalog.pg_class WHERE relnamespace IN(SELECT oid FROM pg_catalog.pg_namespace WHERE left(nspname,3)<>'pg_' AND nspname<>'information_schema')) relations,
 (SELECT count(*)::int FROM pg_catalog.pg_type WHERE typnamespace IN(SELECT oid FROM pg_catalog.pg_namespace WHERE left(nspname,3)<>'pg_' AND nspname<>'information_schema')) types,
 (SELECT coalesce(max(octet_length(prosrc)),0)::int FROM pg_catalog.pg_proc) "maxSourceBytes"`);
  boundedPlain(counts.rows);
  const countSchema = z.strictObject({
    functions: z.number().int().min(29).max(5000),
    relations: z.number().int().min(23).max(5000),
    types: z.number().int().min(0).max(5000),
    maxSourceBytes: z.number().int().min(0).max(2097152),
  });
  if (counts.rows.length !== 1 || !countSchema.safeParse(counts.rows[0]).success)
    fail('CATALOG_WITNESS_LIMIT');
  // One materialized catalog body per capture. SQL computes scalar evidence
  // before conditionally returning metadata; oversized bodies never leave PG.
  const observed = await tx.query(
    `${sql}, measured AS MATERIALIZED (SELECT body,octet_length(body::text) bytes,encode(sha256(convert_to(body::text,'UTF8')),'hex') sha256 FROM enriched)
 SELECT bytes::text bytes,sha256,CASE WHEN bytes<=16777216 THEN body ELSE NULL END metadata FROM measured`,
    [runtimeRole.data],
  );
  boundedPlain(observed.rows);
  const envelope = z
    .strictObject({
      bytes: z.string().regex(/^(0|[1-9][0-9]*)$/),
      metadata: z.unknown(),
      sha256: hash,
    })
    .safeParse(observed.rows[0]);
  if (observed.rows.length !== 1 || !envelope.success) fail('CATALOG_WITNESS_INVALID');
  if (BigInt(envelope.data.bytes) > BigInt(MAX_BYTES)) fail('CATALOG_WITNESS_LIMIT');
  const raw = envelope.data.metadata;
  boundedPlain(raw);
  if (BigInt(Buffer.byteLength(JSON.stringify(raw), 'utf8')) > BigInt(envelope.data.bytes))
    fail('CATALOG_WITNESS_INVALID');
  const witness = buildCurrentRuntimeCatalogWitnessV3(raw);
  return {
    ...witness,
    observation: {
      clusterRoleCount: ctx.data.roleCount,
      metadataBytes: envelope.data.bytes,
      sqlJsonbSha256: envelope.data.sha256,
      expectedRootCount: currentRuntimeV3RpcSourcePins.length,
    },
  };
}

const observationSchema = z.strictObject({
  clusterRoleCount: z.number().int().min(2).max(10000),
  metadataBytes: z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/)
    .refine((v) => BigInt(v) <= BigInt(MAX_BYTES)),
  sqlJsonbSha256: hash,
  expectedRootCount: z.literal(29),
});
export type CurrentRuntimeCatalogWitnessV3 = ReturnType<typeof buildCurrentRuntimeCatalogWitnessV3>;
/** Recomputing an observed checksum validates shape only, never authenticates a
 * caller-provided expectation or closes dynamic/caller-wire/recipe evidence. */
export function parseCurrentRuntimeCatalogWitnessV3(
  raw: unknown,
): CurrentRuntimeCatalogWitnessV3 & { observation?: z.infer<typeof observationSchema> } {
  boundedPlain(raw);
  const shell = z
    .strictObject({
      witnessVersion: z.literal(3),
      metadataEncoding: z.literal('pg-catalog-runtime-security-normalized-v3'),
      profile: z.strictObject({
        profileVersion: z.literal(3),
        baselineSchemaVersion: z.literal(107),
        runtimeStep: z.literal(19),
        sourceDdlTip: z.literal(129),
        runtimeSteps: z
          .array(
            z.strictObject({
              step: z.number().int(),
              sourceDdlId: z.number().int(),
              filename: text,
              sha256: hash,
            }),
          )
          .length(19),
      }),
      metadata: currentRuntimeCatalogMetadataV3Schema,
      sections: z
        .array(
          z.strictObject({
            section: text,
            rowCount: z.number().int().min(0),
            bytes: z.number().int().min(0).max(MAX_BYTES),
            sha256: hash,
          }),
        )
        .length(sections.length),
      closure: z.strictObject({
        catalogObservation: z.literal('enumerated'),
        dynamicDependencies: z.literal('not_verified'),
        strictCallerWire: z.literal('not_verified'),
        effectiveRecipe: z.literal('not_verified'),
        independentNormalization: z.literal('not_verified'),
      }),
      supported: z.literal(false),
      processingAuthority: z.literal('none'),
      restore: z.literal('not_verified'),
      unknownNamespaces: z.array(name).max(32),
      unmappedRoleTags: z.array(tag).max(1000),
      catalogSha256: hash,
      observation: observationSchema.optional(),
    })
    .safeParse(raw);
  if (!shell.success) fail('CATALOG_WITNESS_INVALID');
  const expected = buildCurrentRuntimeCatalogWitnessV3(shell.data.metadata);
  const { observation, ...body } = shell.data;
  if (JSON.stringify(canonical(body)) !== JSON.stringify(canonical(expected)))
    fail('CATALOG_WITNESS_INVALID');
  return observation === undefined ? expected : { ...expected, observation };
}

// Shared metadata query only. Profile-specific installation/context verification
// and observation counts remain in each named successor; this export is no seal.
export { sql as currentRuntimeCatalogMetadataQueryV3 };
