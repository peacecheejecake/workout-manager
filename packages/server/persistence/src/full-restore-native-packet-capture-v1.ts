import { createHash } from 'node:crypto';
import { createFullRestoreNativeRowProjectionV1 } from './full-restore-native-row-projection-v1.js';

type Query = (sql: string, parameters: readonly unknown[]) => Promise<unknown>;
export interface FullRestoreNativePacketSnapshotPortV1 {
  /** Own one leased RR READ ONLY transaction; honor cancellation and resolve only after cleanup. */
  withRepeatableReadOnly<T>(
    callback: (transaction: { query: Query }) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}
const ROWS = 5000;
const BYTES = 16777216;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const IDENTITY_SQL = `SELECT current_database() AS database_name,
 (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,
 current_user AS current_role, session_user AS session_role,
 (SELECT oid::text FROM pg_roles WHERE rolname=current_user) AS role_oid,
 txid_current_snapshot()::text AS snapshot,
 current_setting('server_version_num') AS server_version,
 current_setting('transaction_isolation') AS isolation,
 current_setting('transaction_read_only') AS read_only,
 current_setting('DateStyle') AS date_style,
 current_setting('client_encoding') AS encoding`;
const VISIBILITY_SQL = `SELECT n.nspname AS schema, c.relname AS relation,
 has_table_privilege(c.oid,'SELECT') AS readable, row_security_active(c.oid) AS filtered
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','p')
 ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C"`;
export class FullRestoreNativePacketCaptureErrorV1 extends Error {
  constructor(
    readonly code:
      | 'CAPTURE_PORT_INVALID'
      | 'CAPTURE_SNAPSHOT_INVALID'
      | 'CAPTURE_VISIBILITY_INVALID'
      | 'CAPTURE_REPLY_INVALID'
      | 'CAPTURE_BUDGET_EXCEEDED'
      | 'CAPTURE_CARRIER_REJECTED'
      | 'CAPTURE_CANCELLED'
      | 'CAPTURE_IO_FAILED'
      | 'CAPTURE_LIFETIME_INVALID',
  ) {
    super(code);
    this.name = 'FullRestoreNativePacketCaptureErrorV1';
  }
}
function fail(code: FullRestoreNativePacketCaptureErrorV1['code']): never {
  throw new FullRestoreNativePacketCaptureErrorV1(code);
}
function data(raw: unknown, key: string): unknown {
  if (!raw || typeof raw !== 'object') return fail('CAPTURE_REPLY_INVALID');
  try {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !('value' in descriptor)) return fail('CAPTURE_REPLY_INVALID');
    return descriptor.value;
  } catch {
    return fail('CAPTURE_REPLY_INVALID');
  }
}
function exact(raw: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      !raw ||
      typeof raw !== 'object' ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) ||
      Reflect.ownKeys(raw).length !== keys.length
    )
      return fail('CAPTURE_REPLY_INVALID');
    const result: Record<string, unknown> = {};
    for (const key of keys) result[key] = data(raw, key);
    return Object.freeze(result);
  } catch {
    fail('CAPTURE_REPLY_INVALID');
  }
}
function reply(raw: unknown, expected?: number): readonly unknown[] {
  // pg QueryResult has additional driver metadata. Never read those fields/getters.
  const rows = data(raw, 'rows');
  const count = data(raw, 'rowCount');
  if (
    !Array.isArray(rows) ||
    rows.length > 239 ||
    count !== rows.length ||
    (expected !== undefined && rows.length !== expected)
  )
    return fail('CAPTURE_REPLY_INVALID');
  const values: unknown[] = [];
  for (let index = 0; index < rows.length; index++) values.push(data(rows, String(index)));
  return values;
}
const identityKeys = [
  'database_name',
  'database_oid',
  'current_role',
  'session_role',
  'role_oid',
  'snapshot',
  'server_version',
  'isolation',
  'read_only',
  'date_style',
  'encoding',
] as const;
function identity(raw: unknown): readonly string[] {
  const captured = exact(raw, identityKeys);
  const values = identityKeys.map((key) => captured[key]);
  if (
    !values.every(
      (value): value is string =>
        typeof value === 'string' && value.length > 0 && value.length <= 1024,
    )
  )
    return fail('CAPTURE_SNAPSHOT_INVALID');
  if (
    captured['server_version'] !== '170006' ||
    captured['isolation'] !== 'repeatable read' ||
    captured['read_only'] !== 'on' ||
    captured['date_style'] !== 'ISO, YMD' ||
    captured['encoding'] !== 'UTF8' ||
    !/^[1-9][0-9]{0,9}$/.test(String(captured['database_oid'])) ||
    !/^[1-9][0-9]{0,9}$/.test(String(captured['role_oid'])) ||
    !/^[0-9]+:[0-9]+:(?:[0-9]+(?:,[0-9]+)*)?$/.test(String(captured['snapshot']))
  ) {
    return fail('CAPTURE_SNAPSHOT_INVALID');
  }
  return Object.freeze(values);
}
function decimal(raw: unknown): bigint {
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(raw)) {
    return fail('CAPTURE_REPLY_INVALID');
  }
  return BigInt(raw);
}
function method(raw: unknown, key: string): (...args: unknown[]) => unknown {
  const value = data(raw, key);
  if (typeof value !== 'function') return fail('CAPTURE_PORT_INVALID');
  return (...args) => Reflect.apply(value, raw, args);
}

/** Infrastructure observation only. The I/O port owns transaction/cleanup, never archive authority. */
export function createFullRestoreNativePacketCaptureV1(
  assets: unknown,
  independentPins: unknown,
  snapshotPort: FullRestoreNativePacketSnapshotPortV1,
) {
  const plans = createFullRestoreNativeRowProjectionV1(assets, independentPins);
  const withSnapshot = method(snapshotPort, 'withRepeatableReadOnly');
  const schemas = Object.freeze([...new Set(plans.allPlans.map((plan) => plan.schema))]);
  const relationKeys = new Set(plans.allPlans.map((plan) => `${plan.schema}.${plan.relation}`));
  const capture = async (signal?: AbortSignal) => {
    const cancelled = () => {
      if (signal?.aborted) fail('CAPTURE_CANCELLED');
    };
    type Packet = Exclude<
      ReturnType<(typeof plans.allPlans)[number]['receiveCarrier']>,
      { kind: 'rejected_native_row_carrier_v1' }
    >;
    const packets: Packet[] = [];
    let remainingRows = ROWS;
    let remainingBytes = BYTES;
    let callbackCount = 0;
    let active = true;
    let completed:
      | Readonly<{
          schemaVersion: 1;
          kind: 'native-packet-census-v1';
          authority: 'none';
          registryTrusted: false;
          admissionAllowed: false;
          relationCount: 239;
          rowCount: number;
          byteLength: number;
          snapshotIdentitySha256: string;
          catalogSha256: string;
          registrationSha256: string;
          packets: readonly Packet[];
          domainValidation: 'not_checked';
          nativeWholeOrder: 'not_checked';
          sequenceHighWater: 'not_checked';
          pgDumpCorrespondence: 'not_checked';
        }>
      | undefined;
    try {
      cancelled();
      const result = await withSnapshot(async (transaction: { query: Query }) => {
        if (!active || ++callbackCount !== 1) return fail('CAPTURE_LIFETIME_INVALID');
        const queryMethod = method(transaction, 'query');
        const query = async (sql: string, parameters: readonly unknown[]) => {
          cancelled();
          const result = await queryMethod(sql, parameters);
          cancelled();
          if (!active) fail('CAPTURE_LIFETIME_INVALID');
          return result;
        };
        const first = identity(reply(await query(IDENTITY_SQL, []), 1)[0]);
        const visibility = reply(await query(VISIBILITY_SQL, [schemas]), 239);
        const seen = new Set<string>();
        for (const item of visibility) {
          const captured = exact(item, ['schema', 'relation', 'readable', 'filtered']);
          const schema = captured['schema'];
          const relation = captured['relation'];
          if (
            typeof schema !== 'string' ||
            typeof relation !== 'string' ||
            schema.length > 63 ||
            relation.length > 63
          )
            fail('CAPTURE_VISIBILITY_INVALID');
          const key = `${schema}.${relation}`;
          if (
            !relationKeys.has(key) ||
            seen.has(key) ||
            captured['readable'] !== true ||
            captured['filtered'] !== false
          )
            fail('CAPTURE_VISIBILITY_INVALID');
          seen.add(key);
        }
        for (const plan of plans.allPlans) {
          // Fixed internal plan plus remaining counters; never accept caller SQL or a subset.
          const sql = `WITH native_carrier AS MATERIALIZED (${plan.sql})
 SELECT session_ok,row_count,invalid_rows,max_row_bytes,byte_length,
 CASE WHEN row_count::numeric <= $1::numeric AND byte_length::numeric <= $2::numeric
 THEN body ELSE NULL END AS body FROM native_carrier`;
          const raw = exact(reply(await query(sql, [remainingRows, remainingBytes]), 1)[0], [
            'session_ok',
            'row_count',
            'invalid_rows',
            'max_row_bytes',
            'byte_length',
            'body',
          ]);
          const count = decimal(data(raw, 'row_count'));
          const length = decimal(data(raw, 'byte_length'));
          if (count > BigInt(remainingRows) || length > BigInt(remainingBytes)) {
            if (data(raw, 'body') !== null) fail('CAPTURE_REPLY_INVALID');
            fail('CAPTURE_BUDGET_EXCEEDED');
          }
          const packet = plan.receiveCarrier(raw);
          if (packet.kind === 'rejected_native_row_carrier_v1') fail('CAPTURE_CARRIER_REJECTED');
          remainingRows -= packet.rowCount;
          remainingBytes -= packet.byteLength;
          packets.push(packet);
        }
        const last = identity(reply(await query(IDENTITY_SQL, []), 1)[0]);
        if (first.some((value, index) => value !== last[index])) fail('CAPTURE_SNAPSHOT_INVALID');
        completed = Object.freeze({
          schemaVersion: 1,
          kind: 'native-packet-census-v1',
          authority: 'none',
          registryTrusted: false,
          admissionAllowed: false,
          relationCount: 239,
          rowCount: ROWS - remainingRows,
          byteLength: BYTES - remainingBytes,
          snapshotIdentitySha256: hash(JSON.stringify(first)),
          catalogSha256: plans.catalogSha256,
          registrationSha256: plans.registrationSha256,
          packets: Object.freeze(packets),
          domainValidation: 'not_checked',
          nativeWholeOrder: 'not_checked',
          sequenceHighWater: 'not_checked',
          pgDumpCorrespondence: 'not_checked',
        });
        return completed;
      }, signal);
      cancelled();
      if (callbackCount !== 1 || !completed || result !== completed)
        fail('CAPTURE_LIFETIME_INVALID');
      return completed;
    } catch (error) {
      if (error instanceof FullRestoreNativePacketCaptureErrorV1) throw error;
      fail('CAPTURE_IO_FAILED');
    } finally {
      active = false;
    }
  };
  return Object.freeze({
    capture,
    authority: 'none' as const,
    registryTrusted: false as const,
    admissionAllowed: false as const,
  });
}
