import { createHash, createHmac } from 'node:crypto';

// Private app-binding preparation, not a complete backup or an admission authority.
const FAILURE = 'SCHEMA100_ROW_INVENTORY_UNAVAILABLE';
const LIMIT = 1000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
const scopes = new WeakMap();
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const tables = [
  'evidence_app_admission_binding',
  'run_app_admission_binding',
  'candidate_app_admission_binding',
  'integrated_candidate_app_admission_binding',
  'approval_app_admission_binding',
  'command_receipt',
  'restore_app_consent_replay_receipt',
  'restore_suppression_event',
  'tenant_erasure',
];
const fail = () => {
  throw new Error(FAILURE);
};
const rows = (answer) => {
  if (!Array.isArray(answer?.rows)) fail();
  return answer.rows;
};
const one = (answer) => {
  const found = rows(answer);
  if (found.length !== 1) fail();
  return found[0];
};
const integer = (value) => {
  if (!/^(0|[1-9][0-9]*)$/.test(String(value)) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER))
    fail();
  return Number(value);
};
const validId = (value) => typeof value === 'string' && value.length >= 1 && value.length <= 200;
const tag = (key, purpose, ...parts) => {
  const hmac = createHmac('sha256', key);
  for (const part of [purpose, ...parts]) {
    const bytes = Buffer.from(part, 'utf8');
    hmac.update(String(bytes.length)).update(':').update(bytes);
  }
  return hmac.digest('hex');
};

/** Export/import on distinct live connections. No caller string or boolean grants this context. */
export async function withSchema100InventorySnapshot({ exporter, importer }, capture) {
  if (
    !exporter?.query ||
    !importer?.query ||
    exporter === importer ||
    typeof capture !== 'function'
  )
    fail();
  let handle;
  try {
    await exporter.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const exporterRole = one(
      await exporter.query(
        `SELECT current_user AS role,session_user AS session_role,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`,
      ),
    );
    if (
      exporterRole.role !== exporterRole.session_role ||
      exporterRole.rolsuper !== false ||
      exporterRole.rolbypassrls !== false
    )
      fail();
    const { name } = one(await exporter.query('SELECT pg_export_snapshot() AS name'));
    if (typeof name !== 'string' || !/^[0-9A-F]{8}-[0-9A-F]{8}-[1-9][0-9]*$/i.test(name)) fail();
    await importer.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await importer.query(`SET TRANSACTION SNAPSHOT '${name}'`);
    const { id } = one(await importer.query('SELECT txid_current_snapshot()::text AS id'));
    handle = Object.freeze({ kind: 'schema100_imported_snapshot' });
    scopes.set(handle, { client: importer, snapshotId: id, exporterRole: exporterRole.role });
    return await capture(handle);
  } catch {
    fail();
  } finally {
    if (handle) scopes.delete(handle);
    await Promise.allSettled([importer.query('ROLLBACK'), exporter.query('ROLLBACK')]);
  }
}

const catalogQueries = {
  namespaces:
    "SELECT nspname AS name,pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname<>'information_schema' AND nspname!~'^pg_' ORDER BY nspname LIMIT 65",
  relations:
    "SELECT n.nspname AS schema,c.relname AS name,c.relkind AS kind,c.relpersistence AS persistence,pg_get_userbyid(c.relowner) AS owner,c.relrowsecurity AS rls,c.relforcerowsecurity AS force_rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname<>'information_schema' AND n.nspname!~'^pg_' ORDER BY n.nspname,c.relname LIMIT 2049",
  columns:
    "SELECT n.nspname AS schema,c.relname AS relation,a.attnum AS position,a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname<>'information_schema' AND n.nspname!~'^pg_' AND a.attnum>0 AND NOT a.attisdropped ORDER BY n.nspname,c.relname,a.attnum LIMIT 30001",
  functions:
    "SELECT n.nspname AS schema,p.proname AS name,pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_function_result(p.oid) AS result,pg_get_userbyid(p.proowner) AS owner,p.prosecdef AS security_definer,p.proconfig AS config,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname<>'information_schema' AND n.nspname!~'^pg_' AND p.prokind='f' ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) LIMIT 2001",
  triggers:
    "SELECT n.nspname AS schema,c.relname AS relation,t.tgname AS name,t.tgenabled AS enabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname<>'information_schema' AND n.nspname!~'^pg_' AND NOT t.tgisinternal ORDER BY n.nspname,c.relname,t.tgname LIMIT 2001",
  policies:
    "SELECT schemaname AS schema,tablename AS relation,policyname AS name,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname<>'information_schema' AND schemaname!~'^pg_' ORDER BY schemaname,tablename,policyname LIMIT 2001",
  constraints:
    "SELECT n.nspname AS schema,c.relname AS relation,k.conname AS name,k.contype AS type,k.condeferrable AS deferrable,k.condeferred AS deferred,k.convalidated AS validated,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname<>'information_schema' AND n.nspname!~'^pg_' ORDER BY n.nspname,c.relname,k.conname LIMIT 4001",
  indexes:
    "SELECT schemaname AS schema,tablename AS relation,indexname AS name,indexdef AS definition FROM pg_indexes WHERE schemaname<>'information_schema' AND schemaname!~'^pg_' ORDER BY schemaname,tablename,indexname LIMIT 2001",
  views:
    "SELECT n.nspname AS schema,c.relname AS name,pg_get_viewdef(c.oid,false) AS definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname<>'information_schema' AND n.nspname!~'^pg_' AND c.relkind IN ('v','m') ORDER BY n.nspname,c.relname LIMIT 1001",
  privileges:
    "SELECT 'relation' AS kind,n.nspname AS schema,c.relname AS name,c.relacl::text AS acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname<>'information_schema' AND n.nspname!~'^pg_' UNION ALL SELECT 'function',n.nspname,p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',p.proacl::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname<>'information_schema' AND n.nspname!~'^pg_' ORDER BY kind,schema,name LIMIT 4001",
};

async function catalog(client, role) {
  const result = {};
  let catalogBytes = 0;
  for (const sql of Object.values(catalogQueries)) {
    // Catalog definition bodies are bounded in SQL before they enter JavaScript.
    const pre = one(
      await client.query(
        `SELECT count(*)::text AS count,coalesce(sum(octet_length(to_jsonb(x)::text)),0)::text AS bytes FROM (${sql}) x`,
      ),
    );
    catalogBytes += integer(pre.bytes);
    if (catalogBytes > MAX_CATALOG_BYTES) fail();
  }
  for (const [name, sql] of Object.entries(catalogQueries)) {
    result[name] = rows(await client.query(sql));
  }
  const limits = {
    namespaces: 64,
    relations: 2048,
    columns: 30000,
    functions: 2000,
    triggers: 2000,
    policies: 2000,
    constraints: 4000,
    indexes: 2000,
    views: 1000,
    privileges: 4000,
  };
  for (const [name, limit] of Object.entries(limits)) if (result[name].length > limit) fail();
  result.namespaces = result.namespaces.map((x) => ({
    ...x,
    owner: x.owner === role ? '$snapshot_owner' : x.owner,
  }));
  result.relations = result.relations.map((x) => ({
    ...x,
    owner: x.owner === role ? '$snapshot_owner' : x.owner,
  }));
  result.functions = result.functions.map(({ definition, ...x }) => ({
    ...x,
    owner: x.owner === role ? '$snapshot_owner' : x.owner,
    definition_sha256: sha(definition),
  }));
  for (const name of ['triggers', 'constraints', 'indexes', 'views'])
    result[name] = result[name].map(({ definition, ...x }) => ({
      ...x,
      definition_sha256: sha(definition),
    }));
  result.privileges = result.privileges.map((x) => ({
    ...x,
    acl: x.acl?.replaceAll(role, '$snapshot_owner') ?? null,
  }));
  result.migrations = rows(
    await client.query(
      'SELECT version,checksum FROM public.schema_migrations ORDER BY version LIMIT 101',
    ),
  );
  return result;
}

/** Candidate bytes and expected hashes must come from outside the source DB. Candidate remains unreviewed. */
export async function captureSchema100RowInventory({
  snapshotContext,
  candidateBytes,
  expectedCandidateSha256,
  expectedCatalogSha256,
  candidateOwnerRole,
  expectedOwners,
  hmacKey,
}) {
  const scope = scopes.get(snapshotContext);
  if (
    typeof candidateOwnerRole !== 'string' ||
    !/^[a-z_][a-z0-9_]{0,62}$/.test(candidateOwnerRole) ||
    !scope ||
    !Buffer.isBuffer(candidateBytes) ||
    candidateBytes.length > 4 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(expectedCandidateSha256) ||
    sha(candidateBytes) !== expectedCandidateSha256 ||
    !/^[a-f0-9]{64}$/.test(expectedCatalogSha256) ||
    !Buffer.isBuffer(hmacKey) ||
    hmacKey.length !== 32 ||
    !Array.isArray(expectedOwners) ||
    expectedOwners.length > LIMIT ||
    expectedOwners.some((x) => !validId(x)) ||
    new Set(expectedOwners).size !== expectedOwners.length
  )
    fail();
  try {
    const candidate = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(candidateBytes));
    if (
      candidate.schemaVersion !== 1 ||
      candidate.pinStatus !== 'candidate_migrations_001_100_pg14_unreviewed' ||
      candidate.complete !== false ||
      candidate.restoreAccessAllowed !== false ||
      candidate.catalogSha256 !== expectedCatalogSha256 ||
      sha(JSON.stringify(candidate.catalog)) !== expectedCatalogSha256
    )
      fail();
    const client = scope.client;
    const state = one(
      await client.query(
        `SELECT current_user AS role,session_user AS session_role,current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only,txid_current_snapshot()::text AS snapshot_id,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS super,(SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypass`,
      ),
    );
    if (
      state.role !== scope.exporterRole ||
      state.role !== state.session_role ||
      state.super !== false ||
      state.bypass !== false ||
      state.isolation !== 'repeatable read' ||
      state.read_only !== 'on' ||
      state.snapshot_id !== scope.snapshotId
    )
      fail();
    await client.query("SELECT set_config('TimeZone','UTC',true)");
    const actual = await catalog(client, state.role);
    if (actual.migrations.length !== 100 || actual.migrations.some((x, i) => x.version !== i + 1))
      fail();
    // Runtime grants legitimately differ from an empty candidate. They are observed,
    // never silently adopted as an operational pin or compatibility proof.
    const { privileges: observedPrivileges, ...structure } = actual;
    const { privileges: candidatePrivileges, ...expectedStructure } = candidate.catalog;
    const normalizePolicies = (policies, role) =>
      policies.map((row) => ({
        ...row,
        roles: row.roles === `{${role}}` ? '{$snapshot_owner}' : row.roles,
      }));
    structure.policies = normalizePolicies(structure.policies, state.role);
    expectedStructure.policies = normalizePolicies(expectedStructure.policies, candidateOwnerRole);
    if (
      !Array.isArray(candidatePrivileges) ||
      Object.keys(expectedStructure).length !== Object.keys(structure).length ||
      Object.keys(expectedStructure).some(
        (name) => JSON.stringify(structure[name]) !== JSON.stringify(expectedStructure[name]),
      )
    )
      fail();
    const owned = actual.relations.filter(
      (x) => x.schema === 'public' && [...tables, 'consent'].includes(x.name),
    );
    if (
      owned.length !== tables.length + 1 ||
      owned.some((x) => x.owner !== '$snapshot_owner' || x.rls !== true || x.force_rls !== true)
    )
      fail();
    const rosterSql = `SELECT athlete_id FROM (SELECT athlete_id::text FROM identity_private.account UNION SELECT athlete_id FROM public.restore_suppression_event UNION SELECT athlete_id FROM public.restore_app_consent_replay_receipt) x`;
    const rosterPre = one(
      await client.query(
        `SELECT count(*)::text AS count,coalesce(sum(octet_length(athlete_id)),0)::text AS bytes FROM (${rosterSql} LIMIT 1001) x`,
      ),
    );
    if (integer(rosterPre.count) > LIMIT || integer(rosterPre.bytes) > 200 * LIMIT) fail();
    const roster = rows(
      await client.query(`${rosterSql} ORDER BY athlete_id COLLATE "C" LIMIT 1001`),
    ).map((x) => x.athlete_id);
    if (
      roster.length !== expectedOwners.length ||
      roster.some((x) => !validId(x) || !expectedOwners.includes(x))
    )
      fail();
    let totalBytes = 0;
    const budgets = [];
    for (const owner of roster) {
      await client.query("SELECT set_config('app.athlete_id',$1,true)", [owner]);
      for (const table of [...tables, 'consent']) {
        const predicate = table === 'consent' ? "athlete_id=$1 AND kind='app'" : 'athlete_id=$1';
        // Global receipt/event tables use their session-owner policy; all other
        // queries require explicit tenant FORCE RLS plus the identical predicate.
        const pre = one(
          await client.query(
            `SELECT count(*)::text AS count,coalesce(sum(octet_length(to_jsonb(t)::text)),0)::text AS bytes,coalesce(max(octet_length(to_jsonb(t)::text)),0)::text AS max_bytes FROM (SELECT * FROM public.${table} WHERE ${predicate} LIMIT 1001) t`,
            [owner],
          ),
        );
        const size = integer(pre.bytes),
          n = integer(pre.count);
        totalBytes += size;
        if (
          n > LIMIT ||
          integer(pre.max_bytes) > 1024 * 1024 ||
          totalBytes > MAX_BYTES ||
          (table === 'consent' && n > 1)
        )
          fail();
        budgets.push({ owner, table, predicate, count: n });
      }
    }
    const output = [];
    for (const owner of roster) {
      await client.query("SELECT set_config('app.athlete_id',$1,true)", [owner]);
      const inventories = {};
      let app = { state: 'absent' };
      for (const budget of budgets.filter((x) => x.owner === owner)) {
        const data = rows(
          await client.query(
            `SELECT to_jsonb(t)::text AS row_json FROM public.${budget.table} t WHERE ${budget.predicate} ORDER BY to_jsonb(t)::text COLLATE "C" LIMIT 1001`,
            [owner],
          ),
        );
        if (data.length !== budget.count || data.some((x) => typeof x.row_json !== 'string'))
          fail();
        const leaves = data.map((x) =>
          tag(hmacKey, 'schema100-private-row-v1', owner, budget.table, x.row_json),
        );
        inventories[budget.table] = {
          count: data.length,
          digest: tag(hmacKey, 'schema100-private-set-v1', owner, budget.table, ...leaves),
        };
        if (budget.table === 'consent' && data.length === 1) {
          const value = JSON.parse(data[0].row_json);
          if (
            !Number.isInteger(value.revision) ||
            value.revision < 1 ||
            value.revision > 2147483647 ||
            typeof value.granted !== 'boolean'
          )
            fail();
          app = { state: 'present', revision: value.revision, granted: value.granted };
        }
      }
      const active = one(
        await client.query(
          'SELECT count(*)::text AS count FROM identity_private.account WHERE athlete_id::text=$1',
          [owner],
        ),
      );
      output.push({
        ownerTag: tag(hmacKey, 'owner-v1', owner),
        accountPresent: integer(active.count) === 1,
        app,
        inventories,
      });
    }
    return {
      version: 1,
      complete: false,
      admissionAllowed: false,
      candidatePinStatus: candidate.pinStatus,
      candidateSha256: expectedCandidateSha256,
      catalogSha256: expectedCatalogSha256,
      observedPrivilegesSha256: sha(JSON.stringify(observedPrivileges)),
      snapshotId: scope.snapshotId,
      ownerCount: output.length,
      totalBytes,
      owners: output,
      gaps: [
        'WHOLE_DOMAIN_ROW_SETS_NOT_CAPTURED',
        'SIGNED_BASELINE_PRIVATE_OBJECTS_NOT_ATTESTED',
        'FILESYSTEM_PROVIDER_ARTIFACTS_NOT_CAPTURED',
        'SLOT_SNAPSHOT_ORIGIN_AND_FINAL_FENCE_NOT_ATTESTED',
        'CLOSED_STATE_REVISION_AND_LOADER_POSTCONDITIONS_NOT_ATTESTED',
        'INDEPENDENT_TARGET_AND_PRODUCTION_PROVISIONER_NOT_ATTESTED',
        'RUNTIME_GRANTS_AND_ROLE_MEMBERSHIP_NOT_PINNED',
        'SCHEMA100_CANDIDATE_UNREVIEWED',
        'PRE_EVENT_ERASURE_ROSTER_NOT_GLOBALLY_DISCOVERABLE',
      ],
    };
  } catch {
    fail();
  }
}
