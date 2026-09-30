import pg from 'pg';

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const SYSTEM_IDENTIFIER = /^[1-9][0-9]{0,19}$/;
const LSN = /^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/i;
const SNAPSHOT = /^[0-9A-F]{8}-[0-9A-F]{8}-[1-9][0-9]*$/i;
const PROOF = /^[a-f0-9]{64}$/;

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
    expectedCompletionMarker,
    capture,
  } = options;
  if (typeof connectionString !== 'string' || typeof capture !== 'function') fail();
  if (!IDENTIFIER.test(expectedDatabase) || !IDENTIFIER.test(slotName)) fail();
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
    expectedCompletionMarker,
    capture,
  } = options;
  const replication = new pg.Client({ connectionString, replication: 'database' });
  const catalog = new pg.Client({ connectionString });
  let replicationConnected = false;
  let catalogConnected = false;
  let created = false;
  let retain = false;
  let result;
  let failure;
  try {
    await catalog.connect();
    catalogConnected = true;
    const database = one(await catalog.query('SELECT current_database() AS name'));
    if (database.name !== expectedDatabase) fail();
    // A pre-existing slot is never reused or dropped by this boundary.
    if (await slotState(catalog, slotName)) fail('PERSISTENT_SLOT_ALREADY_EXISTS');

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
    // Do not send another replication command while the exported snapshot is in use.
    const captured = await capture(snapshot);
    if (
      !captured ||
      typeof captured !== 'object' ||
      captured.completionMarker !== expectedCompletionMarker
    )
      fail('PERSISTENT_SLOT_CAPTURE_PROOF_FAILED');
    verifySlot(await slotState(catalog, slotName), state);
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
      if (await slotState(catalog, slotName)) fail('PERSISTENT_SLOT_CLEANUP_UNCERTAIN');
    } catch {
      failure = new Error('PERSISTENT_SLOT_CLEANUP_UNCERTAIN');
    }
  }
  try {
    if (replicationConnected) await replication.end();
  } catch {
    failure = new Error('PERSISTENT_SLOT_STATE_UNCERTAIN');
  }
  if (retain && !failure) {
    try {
      verifySlot(await slotState(catalog, slotName), {
        slotName,
        expectedDatabase,
        consistentPointLsn: result.snapshot.consistentPointLsn,
      });
    } catch {
      failure = new Error('PERSISTENT_SLOT_STATE_UNCERTAIN');
    }
  }
  try {
    if (catalogConnected) await catalog.end();
  } catch {
    failure = new Error('PERSISTENT_SLOT_STATE_UNCERTAIN');
  }
  if (failure) throw failure;
  return result;
}
