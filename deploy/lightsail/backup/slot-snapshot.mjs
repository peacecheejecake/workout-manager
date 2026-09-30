import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, sep } from 'node:path';
import pg from 'pg';

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const SYSTEM_IDENTIFIER = /^[1-9][0-9]{0,19}$/;
const LSN = /^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/i;
const SNAPSHOT = /^[0-9A-F]{8}-[0-9A-F]{8}-[1-9][0-9]*$/i;

function reject() {
  throw new Error('LOCAL_SLOT_SNAPSHOT_PROOF_FAILED');
}

function singleRow(result) {
  if (!result || !Array.isArray(result.rows) || result.rows.length !== 1) reject();
  return result.rows[0];
}

function validateLocalInput({
  connectionString,
  socketDir,
  expectedDatabase,
  expectedSystemIdentifier,
  slotName,
  capture,
  disposableTest,
}) {
  if (disposableTest !== true || typeof capture !== 'function') reject();
  if (!IDENTIFIER.test(expectedDatabase) || !IDENTIFIER.test(slotName)) reject();
  if (
    !SYSTEM_IDENTIFIER.test(expectedSystemIdentifier) ||
    BigInt(expectedSystemIdentifier) > 18_446_744_073_709_551_615n
  )
    reject();
  if (typeof socketDir !== 'string' || !isAbsolute(socketDir)) reject();
  let url;
  let socket;
  let temporaryRoot;
  try {
    url = new URL(connectionString);
    socket = realpathSync(socketDir);
    temporaryRoot = realpathSync(tmpdir());
  } catch {
    reject();
  }
  if (
    url.protocol !== 'postgresql:' ||
    url.hostname !== 'localhost' ||
    url.pathname !== `/${expectedDatabase}` ||
    url.searchParams.get('host') !== socketDir ||
    !socket.startsWith(`${temporaryRoot}${sep}`)
  )
    reject();
}

/**
 * Disposable local proof only: hold the replication connection from slot
 * creation through the snapshot consumer, then drop the test slot. No live
 * collector invokes this module and it never persists a slot for tailing.
 */
export async function withLocalExportedSlotSnapshot(options) {
  validateLocalInput(options);
  const { connectionString, expectedDatabase, expectedSystemIdentifier, slotName, capture } =
    options;
  const client = new pg.Client({ connectionString, replication: 'database' });
  let connected = false;
  let slotCreated = false;
  try {
    await client.connect();
    connected = true;
    const identity = singleRow(await client.query('IDENTIFY_SYSTEM'));
    if (
      identity.dbname !== expectedDatabase ||
      identity.systemid !== expectedSystemIdentifier ||
      !LSN.test(identity.xlogpos)
    )
      reject();

    const result = await client.query(
      `CREATE_REPLICATION_SLOT ${slotName} LOGICAL pgoutput EXPORT_SNAPSHOT`,
    );
    slotCreated = true;
    const slot = singleRow(result);
    if (
      slot.slot_name !== slotName ||
      slot.output_plugin !== 'pgoutput' ||
      !LSN.test(slot.consistent_point) ||
      !SNAPSHOT.test(slot.snapshot_name)
    )
      reject();

    const snapshot = Object.freeze({
      snapshotName: slot.snapshot_name,
      consistentPointLsn: slot.consistent_point.toUpperCase(),
      postgresSystemIdentifier: expectedSystemIdentifier,
      replicationSlot: slotName,
    });
    // A command on this connection before capture finishes would invalidate
    // the exported snapshot. DROP is deliberately deferred until afterward.
    const output = await capture(snapshot);
    return { snapshot, output };
  } finally {
    try {
      if (slotCreated) await client.query(`DROP_REPLICATION_SLOT ${slotName}`);
    } finally {
      if (connected) await client.end();
    }
  }
}
