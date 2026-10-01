import { readFileSync } from 'node:fs';

const FAILURE = 'BACKUP_SOURCE_INVENTORY_UNVERIFIED';
const MAX_SCHEMAS = 64;
const MAX_RELATIONS = 2048;
const MAX_COLUMNS = 30000;
const KINDS = new Set(['r', 'p', 'm', 'S', 'v', 'f', 'i', 'I']);
const CLASSES = new Set(['row_hmac', 'summary_only', 'uncovered']);
const PIN = JSON.parse(readFileSync(new URL('./source-registry.json', import.meta.url), 'utf8'));

function reject() {
  throw new Error(FAILURE);
}

function rows(value) {
  if (!value || !Array.isArray(value.rows)) reject();
  return value.rows;
}

function one(value) {
  const found = rows(value);
  if (found.length !== 1) reject();
  return found[0];
}

function safeName(value) {
  return typeof value === 'string' && /^[a-z_][a-z0-9_]{0,62}$/.test(value);
}

function normalizeOwner(value, role, databaseOwner, expectedOwner) {
  // The snapshot role may also own the database. Resolve that overlap using the
  // independently pinned owner class, while still checking the actual catalog owner.
  if (expectedOwner === '$snapshot_owner' && value === role) return '$snapshot_owner';
  if (
    expectedOwner === '$database_owner' &&
    (value === databaseOwner || value === 'pg_database_owner')
  )
    return '$database_owner';
  return value;
}

/** Exact shape and independent registry comparison; never learns a new pin from the source DB. */
export function compareSourceCatalog({
  namespaces,
  relations,
  columns,
  migrations,
  registry,
  role,
  databaseOwner,
}) {
  if (
    !registry ||
    registry.version !== 1 ||
    registry.pinStatus !== 'candidate_migrations_001_093_pg14' ||
    !Array.isArray(registry.namespaces) ||
    !Array.isArray(registry.relations) ||
    !Array.isArray(registry.migrationChecksums) ||
    !safeName(role) ||
    !safeName(databaseOwner) ||
    !Array.isArray(namespaces) ||
    !Array.isArray(relations) ||
    !Array.isArray(columns) ||
    !Array.isArray(migrations) ||
    namespaces.length > MAX_SCHEMAS ||
    relations.length > MAX_RELATIONS ||
    columns.length > MAX_COLUMNS ||
    migrations.length > 93
  )
    reject();
  const normalizedNamespaces = namespaces
    .map((row) => {
      if (!safeName(row.name) || !safeName(row.owner)) reject();
      const pinned = registry.namespaces.find((entry) => entry.name === row.name);
      return {
        name: row.name,
        owner: normalizeOwner(row.owner, role, databaseOwner, pinned?.owner),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const normalizedRelations = relations
    .map((row) => {
      if (
        !safeName(row.schema) ||
        !safeName(row.name) ||
        !safeName(row.owner) ||
        !KINDS.has(row.kind) ||
        !['p', 'u'].includes(row.persistence) ||
        typeof row.rls !== 'boolean' ||
        typeof row.forceRls !== 'boolean' ||
        !['row_hmac', 'summary_only', 'uncovered'].includes(row.classification ?? 'uncovered')
      )
        reject();
      const pinned = registry.relations.find(
        (entry) => entry.schema === row.schema && entry.name === row.name,
      );
      return {
        schema: row.schema,
        name: row.name,
        kind: row.kind,
        persistence: row.persistence,
        owner: normalizeOwner(row.owner, role, databaseOwner, pinned?.owner),
        rls: row.rls,
        forceRls: row.forceRls,
        classification: pinned?.classification ?? 'uncovered',
        columns: columns
          .filter((column) => column.schema === row.schema && column.relation === row.name)
          .map((column) => {
            if (
              !safeName(column.name) ||
              !Number.isInteger(column.position) ||
              column.position < 1 ||
              column.position > MAX_COLUMNS ||
              typeof column.type !== 'string' ||
              column.type.length > 256 ||
              typeof column.notNull !== 'boolean'
            )
              reject();
            return [column.position, column.name, column.type, column.notNull];
          })
          .sort((a, b) => a[0] - b[0]),
      };
    })
    .sort((a, b) => `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`));
  if (
    new Set(normalizedNamespaces.map((row) => row.name)).size !== normalizedNamespaces.length ||
    new Set(normalizedRelations.map((row) => `${row.schema}.${row.name}`)).size !==
      normalizedRelations.length ||
    normalizedRelations.some((row) => !normalizedNamespaces.some((ns) => ns.name === row.schema)) ||
    normalizedRelations.some(
      (row) => new Set(row.columns.map((col) => col[0])).size !== row.columns.length,
    ) ||
    normalizedRelations.some(
      (row) => new Set(row.columns.map((col) => col[1])).size !== row.columns.length,
    ) ||
    columns.length !== normalizedRelations.reduce((sum, row) => sum + row.columns.length, 0) ||
    JSON.stringify(migrations) !== JSON.stringify(registry.migrationChecksums) ||
    JSON.stringify(normalizedNamespaces) !== JSON.stringify(registry.namespaces) ||
    JSON.stringify(normalizedRelations) !== JSON.stringify(registry.relations)
  )
    reject();
  for (const entry of registry.relations) {
    if (
      !CLASSES.has(entry.classification) ||
      (entry.classification === 'row_hmac' && entry.kind !== 'r')
    )
      reject();
  }
  return Object.freeze({
    namespaceCount: normalizedNamespaces.length,
    relationCount: normalizedRelations.length,
    columnCount: columns.length,
    migrationCount: migrations.length,
    classifications: Object.freeze({
      rowHmac: normalizedRelations.filter((row) => row.classification === 'row_hmac').length,
      summaryOnly: normalizedRelations.filter((row) => row.classification === 'summary_only')
        .length,
      uncovered: normalizedRelations.filter((row) => row.classification === 'uncovered').length,
    }),
    uncoveredKinds: Object.freeze({
      sequence: normalizedRelations.filter((row) => row.kind === 'S').length,
      materializedView: normalizedRelations.filter((row) => row.kind === 'm').length,
      partitionedTable: normalizedRelations.filter((row) => row.kind === 'p').length,
      foreignTable: normalizedRelations.filter((row) => row.kind === 'f').length,
      index: normalizedRelations.filter((row) => row.kind === 'i' || row.kind === 'I').length,
    }),
  });
}

/** Called inside the same already imported, read-only repeatable-read snapshot transaction. */
export async function buildSourceInventory({ client, expectedSnapshotId }) {
  if (
    !client ||
    typeof client.query !== 'function' ||
    typeof expectedSnapshotId !== 'string' ||
    expectedSnapshotId.length > 1024 ||
    !/^[0-9]+:[0-9]+:(?:[0-9]+(?:,[0-9]+)*)?$/.test(expectedSnapshotId)
  )
    reject();
  try {
    const state = one(
      await client.query(`SELECT current_user AS role, session_user AS session_role,
      current_setting('transaction_isolation') AS isolation,
      current_setting('transaction_read_only') AS read_only,
      txid_current_snapshot()::text AS snapshot_id,
      (SELECT pg_catalog.pg_get_userbyid(datdba) FROM pg_catalog.pg_database
       WHERE datname=current_database()) AS database_owner`),
    );
    const role = one(
      await client.query(
        'SELECT rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=current_user',
      ),
    );
    if (
      state.role !== state.session_role ||
      state.isolation !== 'repeatable read' ||
      state.read_only !== 'on' ||
      state.snapshot_id !== expectedSnapshotId ||
      role.rolsuper !== false ||
      role.rolbypassrls !== false
    )
      reject();
    const namespaces = rows(
      await client.query(
        `SELECT n.nspname AS name,
      pg_catalog.pg_get_userbyid(n.nspowner) AS owner
      FROM pg_catalog.pg_namespace n
      WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
      ORDER BY n.nspname LIMIT $1`,
        [MAX_SCHEMAS + 1],
      ),
    );
    const relations = rows(
      await client.query(
        `SELECT n.nspname AS schema, c.relname AS name,
      c.relkind AS kind, c.relpersistence AS persistence,
      pg_catalog.pg_get_userbyid(c.relowner) AS owner,
      c.relrowsecurity AS rls, c.relforcerowsecurity AS "forceRls"
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
      ORDER BY n.nspname,c.relname LIMIT $1`,
        [MAX_RELATIONS + 1],
      ),
    );
    const columns = rows(
      await client.query(
        `SELECT n.nspname AS schema, c.relname AS relation,
      a.attnum AS position, a.attname AS name,
      pg_catalog.format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull AS "notNull"
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
        AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY n.nspname,c.relname,a.attnum LIMIT $1`,
        [MAX_COLUMNS + 1],
      ),
    );
    const migrations = rows(
      await client.query(
        'SELECT version,checksum FROM public.schema_migrations ORDER BY version LIMIT 94',
      ),
    );
    const counts = compareSourceCatalog({
      namespaces,
      relations,
      columns,
      migrations,
      registry: PIN,
      role: state.role,
      databaseOwner: state.database_owner,
    });
    // Large objects live in pg_catalog, outside the ordinary namespace filter.
    // No object data or OIDs leave this transaction. A nonzero count remains an uncovered gap.
    const largeObjects = one(
      await client.query('SELECT count(*)::text AS count FROM pg_catalog.pg_largeobject_metadata'),
    );
    if (
      !/^(0|[1-9][0-9]*)$/.test(largeObjects.count) ||
      BigInt(largeObjects.count) > BigInt(Number.MAX_SAFE_INTEGER)
    )
      reject();
    return {
      complete: false,
      registryPinStatus: PIN.pinStatus,
      snapshotId: expectedSnapshotId,
      ...counts,
      largeObjectCount: Number(largeObjects.count),
      gaps: [
        'SUMMARY_ONLY_RELATIONS_NOT_ROW_COVERED',
        'UNCOVERED_RELATIONS_NOT_ROW_COVERED',
        'LARGE_OBJECTS_NOT_ROW_COVERED',
        'SEQUENCE_MATERIALIZED_PARTITIONED_AND_FOREIGN_STORAGE_NOT_ROW_COVERED',
        'HOST_FILESYSTEM_AND_EXTERNAL_STORES_NOT_ENUMERATED',
        'IMPORTED_SNAPSHOT_ORIGIN_NOT_ATTESTED',
        'POST_SNAPSHOT_WAL_TAIL_NOT_PROVEN',
      ],
    };
  } catch {
    reject();
  }
}
