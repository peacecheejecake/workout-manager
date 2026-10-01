import pg from 'pg';

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const SYSTEM_IDENTIFIER = /^[1-9][0-9]{0,19}$/;
const LSN = /^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/i;
const SNAPSHOT = /^[0-9A-F]{8}-[0-9A-F]{8}-[1-9][0-9]*$/i;
const PROOF = /^[a-f0-9]{64}$/;
const PUBLISH_OPERATIONS = ['insert', 'update', 'delete', 'truncate'];
const PUBLICATION_FIELDS = [
  'oid',
  'pubname',
  'pubowner',
  'puballtables',
  'pubinsert',
  'pubupdate',
  'pubdelete',
  'pubtruncate',
  'pubviaroot',
];

function fail(code = 'PERSISTENT_SLOT_SNAPSHOT_FAILED') {
  throw new Error(code);
}

function one(result) {
  if (!result || !Array.isArray(result.rows) || result.rows.length !== 1) fail();
  return result.rows[0];
}

function validate(options) {
  if (!options || typeof options !== 'object') fail();
  const {
    connectionString,
    expectedDatabase,
    expectedSystemIdentifier,
    slotName,
    expectedPublication,
    expectedPublicationTables,
    expectedPublicationOperations,
    expectedCompletionMarker,
    capture,
  } = options;
  if (typeof connectionString !== 'string' || typeof capture !== 'function') fail();
  if (!IDENTIFIER.test(expectedDatabase) || !IDENTIFIER.test(slotName)) fail();
  if (
    !IDENTIFIER.test(expectedPublication) ||
    !Array.isArray(expectedPublicationTables) ||
    expectedPublicationTables.length === 0 ||
    expectedPublicationTables.some(
      (table) =>
        typeof table !== 'string' || !/^[a-z_][a-z0-9_]{0,62}\.[a-z_][a-z0-9_]{0,62}$/.test(table),
    ) ||
    new Set(expectedPublicationTables).size !== expectedPublicationTables.length
  )
    fail();
  if (
    !Array.isArray(expectedPublicationOperations) ||
    expectedPublicationOperations.length === 0 ||
    expectedPublicationOperations.some((operation) => !PUBLISH_OPERATIONS.includes(operation)) ||
    new Set(expectedPublicationOperations).size !== expectedPublicationOperations.length
  )
    fail();
  if (
    !SYSTEM_IDENTIFIER.test(expectedSystemIdentifier) ||
    BigInt(expectedSystemIdentifier) > 18_446_744_073_709_551_615n
  )
    fail();
  if (!PROOF.test(expectedCompletionMarker)) fail();
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    fail();
  }
  if (!['postgresql:', 'postgres:'].includes(url.protocol)) fail();
  if (url.pathname !== `/${expectedDatabase}`) fail();
}

async function slotState(client, slotName) {
  const result = await client.query(
    `SELECT slot_name, plugin, slot_type, database, temporary, active,
            confirmed_flush_lsn::text AS confirmed_flush_lsn
       FROM pg_replication_slots WHERE slot_name = $1`,
    [slotName],
  );
  if (result.rows.length > 1) fail();
  return result.rows[0] ?? null;
}

async function verifyDatabase(client, expectedDatabase, expectedSystemIdentifier) {
  const database = one(
    await client.query(
      'SELECT current_database() AS name, system_identifier::text AS systemid FROM pg_control_system()',
    ),
  );
  if (database.name !== expectedDatabase || database.systemid !== expectedSystemIdentifier) fail();
}

async function publicationState(client, name, expectedTables, expectedOperations) {
  const publication = one(
    await client.query('SELECT to_jsonb(p) AS detail FROM pg_publication p WHERE pubname = $1', [
      name,
    ]),
  ).detail;
  if (
    !publication ||
    JSON.stringify(Object.keys(publication).sort()) !==
      JSON.stringify([...PUBLICATION_FIELDS].sort()) ||
    publication.pubname !== name ||
    publication.puballtables !== false ||
    publication.pubviaroot !== false ||
    PUBLISH_OPERATIONS.some(
      (operation) => publication[`pub${operation}`] !== expectedOperations.includes(operation),
    )
  )
    fail('PERSISTENT_SLOT_PUBLICATION_MISMATCH');
  const result = await client.query(
    `SELECT to_jsonb(t) AS detail FROM pg_publication_tables t
      WHERE pubname = $1 ORDER BY schemaname, tablename`,
    [name],
  );
  const tables = result.rows.map(({ detail }) => `${detail.schemaname}.${detail.tablename}`);
  if (
    JSON.stringify([...tables].sort()) !== JSON.stringify([...expectedTables].sort()) ||
    result.rows.some(({ detail }) => detail.rowfilter != null)
  )
    fail('PERSISTENT_SLOT_PUBLICATION_MISMATCH');
  const relations = await client.query(
    'SELECT to_jsonb(pr) AS detail FROM pg_publication_rel pr WHERE prpubid = $1 ORDER BY prrelid',
    [publication.oid],
  );
  if (
    relations.rows.length !== expectedTables.length ||
    relations.rows.some(({ detail }) => detail.prattrs != null || detail.prqual != null)
  )
    fail('PERSISTENT_SLOT_PUBLICATION_MISMATCH');
  const namespaceCatalog = one(
    await client.query("SELECT to_regclass('pg_catalog.pg_publication_namespace') AS relation"),
  ).relation;
  if (namespaceCatalog) {
    const namespaces = one(
      await client.query(
        'SELECT count(*)::int AS count FROM pg_publication_namespace WHERE pnpubid = $1',
        [publication.oid],
      ),
    ).count;
    if (namespaces !== 0) fail('PERSISTENT_SLOT_PUBLICATION_MISMATCH');
  }
  return JSON.stringify({
    publication,
    tables: result.rows.map(({ detail }) => detail),
    relations: relations.rows.map(({ detail }) => detail),
  });
}

function uncertain(code, previous) {
  return new Error(code, previous ? { cause: previous } : undefined);
}

function verifySlot(row, { slotName, expectedDatabase, consistentPointLsn }) {
  if (
    !row ||
    row.slot_name !== slotName ||
    row.plugin !== 'pgoutput' ||
    row.slot_type !== 'logical' ||
    row.database !== expectedDatabase ||
    row.temporary !== false ||
    row.confirmed_flush_lsn?.toUpperCase() !== consistentPointLsn
  )
    fail();
}

/**
 * Opt-in preparation boundary only. The caller must supply a separately
 * chosen SHA-256-shaped completion marker. `capture` explicitly returns
 * `{ output, completionMarker }` after its own capture succeeds. The marker
 * is a caller-supplied assertion, not independent proof of durability,
 * coverage, a complete WAL tail, or restore readiness.
 * The expected publish operations, explicit table set, and absence of row
 * filters, column lists, and schema-wide rules are checked before slot creation.
 * The full catalog definition is compared again after capture. A separate write
 * fence remains necessary to prevent an intervening change from being reverted.
 *
 * A successful return leaves a persistent slot behind for a later owner.
 * The slot name must be exclusive to this invocation; existing slots are
 * rejected. If creation outcome is ambiguous, the slot is not touched and
 * the caller must investigate before retrying.
 */
export async function withPersistentExportedSlotSnapshot(options) {
  validate(options);
  const {
    connectionString,
    expectedDatabase,
    expectedSystemIdentifier,
    slotName,
    expectedPublication,
    expectedPublicationTables,
    expectedPublicationOperations,
    expectedCompletionMarker,
    capture,
  } = options;
  const replication = new pg.Client({ connectionString, replication: 'database' });
  let catalog;
  let replicationConnected = false;
  let catalogConnected = false;
  let created = false;
  let retain = false;
  let result;
  let failure;
  async function openCatalog() {
    if (catalogConnected) return;
    catalog = new pg.Client({ connectionString });
    try {
      await catalog.connect();
      catalogConnected = true;
      await verifyDatabase(catalog, expectedDatabase, expectedSystemIdentifier);
    } catch (error) {
      if (catalogConnected) await catalog.end().catch(() => {});
      catalogConnected = false;
      catalog = undefined;
      throw error;
    }
  }

  async function closeCatalog() {
    if (!catalogConnected) return;
    try {
      await catalog.end();
    } finally {
      catalogConnected = false;
      catalog = undefined;
    }
  }

  try {
    await openCatalog();
    // A pre-existing slot is never reused or dropped by this boundary.
    if (await slotState(catalog, slotName)) fail('PERSISTENT_SLOT_ALREADY_EXISTS');
    const publicationIdentity = await publicationState(
      catalog,
      expectedPublication,
      expectedPublicationTables,
      expectedPublicationOperations,
    );

    await replication.connect();
    replicationConnected = true;
    const identity = one(await replication.query('IDENTIFY_SYSTEM'));
    if (
      identity.dbname !== expectedDatabase ||
      identity.systemid !== expectedSystemIdentifier ||
      !LSN.test(identity.xlogpos)
    )
      fail();

    // A thrown or malformed CREATE result is ambiguous: the command may
    // have created a slot, so leave it untouched for manual investigation.
    let response;
    try {
      response = await replication.query(
        `CREATE_REPLICATION_SLOT ${slotName} LOGICAL pgoutput EXPORT_SNAPSHOT`,
      );
    } catch {
      fail('PERSISTENT_SLOT_CREATE_UNCERTAIN');
    }
    const slot = response?.rows?.length === 1 ? response.rows[0] : null;
    if (
      !slot ||
      slot.slot_name !== slotName ||
      slot.output_plugin !== 'pgoutput' ||
      !LSN.test(slot.consistent_point) ||
      !SNAPSHOT.test(slot.snapshot_name)
    )
      fail('PERSISTENT_SLOT_CREATE_UNCERTAIN');
    created = true;
    const snapshot = Object.freeze({
      snapshotName: slot.snapshot_name,
      consistentPointLsn: slot.consistent_point.toUpperCase(),
      postgresSystemIdentifier: expectedSystemIdentifier,
      replicationSlot: slotName,
    });
    const state = { slotName, expectedDatabase, consistentPointLsn: snapshot.consistentPointLsn };
    verifySlot(await slotState(catalog, slotName), state);
    // A host-side write fence requires zero ordinary client backends during capture.
    // Keep only the replication walsender alive so pg_dump can import its snapshot.
    await closeCatalog();
    // Do not send another replication command while the exported snapshot is in use.
    const captured = await capture(snapshot);
    if (
      !captured ||
      typeof captured !== 'object' ||
      captured.completionMarker !== expectedCompletionMarker
    )
      fail('PERSISTENT_SLOT_CAPTURE_PROOF_FAILED');
    await openCatalog();
    verifySlot(await slotState(catalog, slotName), state);
    if (
      (await publicationState(
        catalog,
        expectedPublication,
        expectedPublicationTables,
        expectedPublicationOperations,
      )) !== publicationIdentity
    )
      fail('PERSISTENT_SLOT_PUBLICATION_MISMATCH');
    result = { snapshot, output: captured.output };
    retain = true;
  } catch (error) {
    failure = error;
  }

  if (created && !retain) {
    try {
      // DROP is deliberately done on the original replication connection.
      // Failure leaves outcome uncertain and must remain visible to the caller.
      await replication.query(`DROP_REPLICATION_SLOT ${slotName}`);
      await openCatalog();
      if (await slotState(catalog, slotName)) fail('PERSISTENT_SLOT_CLEANUP_UNCERTAIN');
    } catch {
      failure = uncertain('PERSISTENT_SLOT_CLEANUP_UNCERTAIN', failure);
    }
  }
  try {
    if (replicationConnected) await replication.end();
  } catch {
    failure = uncertain('PERSISTENT_SLOT_STATE_UNCERTAIN', failure);
  }
  if (retain && !failure) {
    try {
      verifySlot(await slotState(catalog, slotName), {
        slotName,
        expectedDatabase,
        consistentPointLsn: result.snapshot.consistentPointLsn,
      });
    } catch {
      failure = uncertain('PERSISTENT_SLOT_STATE_UNCERTAIN', failure);
    }
  }
  try {
    await closeCatalog();
  } catch {
    failure = uncertain('PERSISTENT_SLOT_STATE_UNCERTAIN', failure);
  }
  if (failure) throw failure;
  return result;
}
