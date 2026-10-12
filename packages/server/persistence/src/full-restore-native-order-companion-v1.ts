import { createFullRestoreNativeRowProjectionV1 } from './full-restore-native-row-projection-v1.js';
import {
  createFullRestoreNativePacketCaptureV1,
  type FullRestoreNativePacketSnapshotPortV1,
} from './full-restore-native-packet-capture-v1.js';
import { createFullRestoreNativeCatalogCollectorV2 } from './full-restore-native-catalog-v2/collector.js';

export class NativeOrderCompanionErrorV1 extends Error {
  constructor(
    readonly code:
      | 'ORDER_ASSETS_INVALID'
      | 'ORDER_DESCRIPTOR_UNSUPPORTED'
      | 'ORDER_PORT_INVALID'
      | 'ORDER_REPLY_INVALID'
      | 'ORDER_KEY_MISMATCH'
      | 'ORDER_CANCELLED'
      | 'ORDER_LIFETIME_INVALID'
      | 'ORDER_IO_FAILED',
  ) {
    super(code);
    this.name = 'NativeOrderCompanionErrorV1';
  }
}
function fail(code: NativeOrderCompanionErrorV1['code']): never {
  throw new NativeOrderCompanionErrorV1(code);
}
function own(raw: unknown, key: string): unknown {
  try {
    if (!raw || typeof raw !== 'object') return fail('ORDER_REPLY_INVALID');
    const d = Object.getOwnPropertyDescriptor(raw, key);
    if (!d || !('value' in d)) return fail('ORDER_REPLY_INVALID');
    return d.value;
  } catch {
    return fail('ORDER_REPLY_INVALID');
  }
}
function record(raw: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      !raw ||
      typeof raw !== 'object' ||
      Object.getPrototypeOf(raw) !== Object.prototype ||
      Reflect.ownKeys(raw).length !== keys.length
    )
      return fail('ORDER_REPLY_INVALID');
    const copy: Record<string, unknown> = {};
    for (const key of keys) copy[key] = own(raw, key);
    return Object.freeze(copy);
  } catch {
    return fail('ORDER_REPLY_INVALID');
  }
}
function method(raw: unknown, key: string) {
  const value = own(raw, key);
  if (typeof value !== 'function') return fail('ORDER_PORT_INVALID');
  return (...args: unknown[]) => Reflect.apply(value, raw, args);
}
function copiedAssets(raw: unknown) {
  const r = record(raw, ['registration', 'catalog', 'fixedQuery', 'sourceOwnedRoster']);
  const copy = (v: unknown): Uint8Array => {
    try {
      if (!(v instanceof Uint8Array) || Object.getPrototypeOf(v) !== Uint8Array.prototype)
        return fail('ORDER_ASSETS_INVALID');
      const prototype = Object.getPrototypeOf(Uint8Array.prototype);
      const buffer: unknown = Object.getOwnPropertyDescriptor(prototype, 'buffer')?.get?.call(v);
      const size: unknown = Object.getOwnPropertyDescriptor(prototype, 'byteLength')?.get?.call(v);
      const offset: unknown = Object.getOwnPropertyDescriptor(prototype, 'byteOffset')?.get?.call(
        v,
      );
      if (
        !(buffer instanceof ArrayBuffer) ||
        Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype ||
        Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get?.call(buffer) !==
          false ||
        typeof size !== 'number' ||
        size < 1 ||
        size > 8388608 ||
        offset !== 0 ||
        size !== buffer.byteLength
      )
        return fail('ORDER_ASSETS_INVALID');
      const result = new Uint8Array(size);
      result.set(new Uint8Array(buffer));
      return result;
    } catch {
      return fail('ORDER_ASSETS_INVALID');
    }
  };
  return Object.freeze({
    registration: copy(r['registration']),
    catalog: copy(r['catalog']),
    fixedQuery: copy(r['fixedQuery']),
    sourceOwnedRoster: copy(r['sourceOwnedRoster']),
  });
}
const quoted = (identifier: string) => '"' + identifier.replaceAll('"', '""') + '"';
const counter = (raw: unknown) => {
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(raw))
    return fail('ORDER_REPLY_INVALID');
  const n = BigInt(raw);
  if (n > 5000n) return fail('ORDER_REPLY_INVALID');
  return Number(n);
};
const collatable = new Set(['text']);
function keyCast(type: string, path: string): string {
  switch (type) {
    case 'text':
      return `(${path}->>'value')::text`;
    case 'uuid':
      return `(${path}->>'value')::uuid`;
    case 'int32':
      return `(${path}->>'value')::integer`;
    case 'int64':
      return `(${path}->>'value')::bigint`;
    case 'boolean':
      return `(${path}->>'value')::boolean`;
    case 'bytea':
      return `pg_catalog.decode(${path}->>'hex','hex')`;
    case 'date':
      return `(${path}->>'value')::date`;
    case 'timestamptzUTC6':
      return `pg_catalog.replace(pg_catalog.replace(${path}->>'value','T',' '),'Z','+00')::timestamptz`;
    default:
      return fail('ORDER_DESCRIPTOR_UNSUPPORTED');
  }
}
/** Bounded companion: binds C2 to an independent native key/ordinal query on the same lease.
 * Never sorts rows in JS, changes physical bytes, or grants archive/restore authority. */
export function createNativeOrderCompanionV1(
  rawAssets: unknown,
  rawPins: unknown,
  port: FullRestoreNativePacketSnapshotPortV1,
) {
  const assets = copiedAssets(rawAssets);
  const pins = record(rawPins, [
    'registrationSha256',
    'catalogSha256',
    'querySha256',
    'rosterSha256',
  ]);
  const plans = createFullRestoreNativeRowProjectionV1(assets, pins);
  const observed = createFullRestoreNativeCatalogCollectorV2(
    {
      fixedQuery: assets.fixedQuery,
      sourceOwnedRoster: assets.sourceOwnedRoster,
    },
    { querySha256: pins['querySha256'], rosterSha256: pins['rosterSha256'] },
  ).receive(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(assets.catalog))).catalog;
  const collations = new Map(
    observed.pools.collations.map((entry) => {
      const raw: unknown = JSON.parse(entry.pgJsonbText);
      const schema = own(raw, 'schema'),
        name = own(raw, 'name');
      if (
        typeof schema !== 'string' ||
        typeof name !== 'string' ||
        schema.length > 63 ||
        name.length > 63 ||
        name.includes('\0')
      )
        return fail('ORDER_DESCRIPTOR_UNSUPPORTED');
      return [entry.oid, `${quoted(schema)}.${quoted(name)}`] as const;
    }),
  );
  const nativePlans = plans.allPlans.map((plan) => {
    const relation = observed.relations.find(
      (r) => r.schema === plan.schema && r.relation === plan.relation,
    );
    if (!relation) return fail('ORDER_DESCRIPTOR_UNSUPPORTED');
    const keys = relation.primaryKey.components.map((component, index) => {
      const column = plan.columns.find((c) => c.column === component.column);
      const position = plan.columns.findIndex((c) => c.column === component.column);
      const nativeColumn = relation.columns[position];
      if (
        !column ||
        !nativeColumn ||
        position < 0 ||
        component.position !== index + 1 ||
        component.sortOptions !== 0 ||
        component.collationOid !== nativeColumn.collationOid
      )
        return fail('ORDER_DESCRIPTOR_UNSUPPORTED');
      const suffix =
        collatable.has(column.pgType) && component.collationOid !== null
          ? ` COLLATE ${collations.get(component.collationOid) ?? fail('ORDER_DESCRIPTOR_UNSUPPORTED')}`
          : '';
      if (!collatable.has(column.pgType) && component.collationOid !== null)
        return fail('ORDER_DESCRIPTOR_UNSUPPORTED');
      const path = `entry.item->'columns'->${position}->'value'`;
      return Object.freeze({
        alias: `k${index}`,
        source: `t.${quoted(column.column)}${suffix}`,
        decoded: `(${keyCast(column.pgType, path)})${suffix}`,
      });
    });
    const order = keys.map((k) => `${k.source} ASC NULLS LAST`).join(',');
    const sql = `WITH context AS MATERIALIZED (SELECT current_setting('transaction_isolation')='repeatable read' AND current_setting('transaction_read_only')='on' AND current_setting('server_version_num')='170006' AND current_setting('DateStyle')='ISO, YMD' AND current_setting('client_encoding')='UTF8' AS session_ok),
 native_keys AS MATERIALIZED (SELECT row_number() OVER (ORDER BY ${order}) AS native_ordinal,${keys.map((k) => `${k.source} AS ${k.alias}`).join(',')} FROM ${quoted(plan.schema)}.${quoted(plan.relation)} t),
 supplied_keys AS MATERIALIZED (SELECT entry.ordinality AS supplied_ordinal,${keys.map((k) => `${k.decoded} AS ${k.alias}`).join(',')} FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS entry(item,ordinality)),
 paired AS MATERIALIZED (SELECT s.supplied_ordinal,n.native_ordinal FROM supplied_keys s LEFT JOIN native_keys n ON ${keys.map((k) => `s.${k.alias} IS NOT DISTINCT FROM n.${k.alias}`).join(' AND ')}),
 duplicates AS MATERIALIZED (SELECT ${keys.map((k) => k.alias).join(',')} FROM supplied_keys GROUP BY ${keys.map((k) => k.alias).join(',')} HAVING count(*)>1)
 SELECT context.session_ok,(SELECT count(*)::text FROM native_keys) AS source_count,(SELECT count(*)::text FROM supplied_keys) AS supplied_count,
 (SELECT count(*)::text FROM paired WHERE native_ordinal IS NULL) AS missing_keys,
 (SELECT count(*)::text FROM duplicates) AS duplicate_keys,
 (SELECT count(*)::text FROM paired WHERE native_ordinal<>supplied_ordinal) AS wrong_ordinal FROM context`;
    return Object.freeze({ schema: plan.schema, relation: plan.relation, sql });
  });
  const withLease = method(port, 'withRepeatableReadOnly');
  async function capture(signal?: AbortSignal) {
    const facts: Readonly<{
      schema: string;
      relation: string;
      rows: number;
    }>[] = [];
    let nativeFailure: NativeOrderCompanionErrorV1 | undefined;
    const snapshotPort: FullRestoreNativePacketSnapshotPortV1 = {
      withRepeatableReadOnly: async <T>(
        callback: (tx: {
          query: (sql: string, params: readonly unknown[]) => Promise<unknown>;
        }) => Promise<T>,
        cancellation?: AbortSignal,
      ): Promise<T> => {
        let completed: T | undefined;
        let called = 0;
        const result = await withLease(async (tx: unknown) => {
          const query = method(tx, 'query');
          const transaction = {
            query: async (sql: string, parameters: readonly unknown[]) =>
              await query(sql, parameters),
          };
          const captured = await callback(transaction);
          completed = captured;
          called++;
          // Callback is only C2's internal producer, never a caller-supplied packet object.
          const packetList = own(captured, 'packets');
          if (!Array.isArray(packetList) || packetList.length !== 239)
            fail('ORDER_LIFETIME_INVALID');
          try {
            for (let index = 0; index < 239; index++) {
              const rawPacket = own(packetList, String(index));
              const sourcePlan = plans.allPlans[index];
              if (!sourcePlan) fail('ORDER_LIFETIME_INVALID');
              if (cancellation?.aborted) fail('ORDER_CANCELLED');
              const plan = nativePlans[index];
              if (
                !plan ||
                plan.schema !== own(rawPacket, 'schema') ||
                plan.relation !== own(rawPacket, 'relation') ||
                own(rawPacket, 'kind') !== 'validated_full_restore_physical_row_packet_v2'
              )
                fail('ORDER_LIFETIME_INVALID');
              const original: unknown = method(rawPacket, 'copyOriginalUtf8')();
              if (!(original instanceof Uint8Array) || original.byteLength > 16777216)
                fail('ORDER_REPLY_INVALID');
              const body = new TextDecoder('utf-8', { fatal: true }).decode(original);
              const rowCount = own(rawPacket, 'rowCount');
              if (
                typeof rowCount !== 'number' ||
                !Number.isSafeInteger(rowCount) ||
                rowCount < 0 ||
                rowCount > 5000
              )
                fail('ORDER_REPLY_INVALID');
              // Revalidate the owned original bytes; no generic typed-result assertion.
              const packet = sourcePlan.receiveCarrier({
                session_ok: true,
                row_count: String(rowCount),
                invalid_rows: '0',
                max_row_bytes: rowCount === 0 ? '0' : String(sourcePlan.maxRowBytes),
                byte_length: String(original.byteLength),
                body,
              });
              if (
                packet.kind === 'rejected_native_row_carrier_v1' ||
                packet.rowsSha256 !== own(rawPacket, 'rowsSha256')
              )
                fail('ORDER_REPLY_INVALID');
              const reply: unknown = await query(plan.sql, [body]);
              if (cancellation?.aborted) fail('ORDER_CANCELLED');
              const rows = own(reply, 'rows');
              if (!Array.isArray(rows) || rows.length !== 1 || own(reply, 'rowCount') !== 1)
                fail('ORDER_REPLY_INVALID');
              const r = record(own(rows, '0'), [
                'session_ok',
                'source_count',
                'supplied_count',
                'missing_keys',
                'duplicate_keys',
                'wrong_ordinal',
              ]);
              const source = counter(r['source_count']),
                supplied = counter(r['supplied_count']);
              if (
                r['session_ok'] !== true ||
                source !== packet.rowCount ||
                supplied !== packet.rowCount ||
                counter(r['missing_keys']) !== 0 ||
                counter(r['duplicate_keys']) !== 0 ||
                counter(r['wrong_ordinal']) !== 0
              )
                fail('ORDER_KEY_MISMATCH');
              facts.push(
                Object.freeze({
                  schema: plan.schema,
                  relation: plan.relation,
                  rows: source,
                }),
              );
            }
            if (facts.length !== 239) fail('ORDER_LIFETIME_INVALID');
          } catch (error) {
            nativeFailure =
              error instanceof NativeOrderCompanionErrorV1
                ? error
                : new NativeOrderCompanionErrorV1('ORDER_IO_FAILED');
            throw nativeFailure;
          }
          return captured;
        }, cancellation);
        if (called !== 1 || completed === undefined || result !== completed)
          fail('ORDER_LIFETIME_INVALID');
        return completed;
      },
    };
    try {
      const captured = await createFullRestoreNativePacketCaptureV1(
        assets,
        pins,
        snapshotPort,
      ).capture(signal);
      if (facts.length !== 239) fail('ORDER_LIFETIME_INVALID');
      return Object.freeze({
        schemaVersion: 1 as const,
        kind: 'native-key-order-companion-v1' as const,
        captured,
        relations: Object.freeze(facts),
        orderEvidence: 'validated_port_native_key_ordinal_facts' as const,
        authority: 'none' as const,
        registryTrusted: false as const,
        admissionAllowed: false as const,
        domainValidation: 'not_checked' as const,
        sequenceHighWater: 'not_checked' as const,
        pgDumpCorrespondence: 'not_checked' as const,
      });
    } catch (error) {
      if (nativeFailure) throw nativeFailure;
      throw error;
    }
  }
  return Object.freeze({
    capture,
    authority: 'none' as const,
    registryTrusted: false as const,
    admissionAllowed: false as const,
  });
}
