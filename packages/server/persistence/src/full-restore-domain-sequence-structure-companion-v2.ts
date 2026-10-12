import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createBoundedPlainJsonSchema } from '@workout/contracts/bounded-plain-json';
import { createNativeOrderCompanionV1 } from './full-restore-native-order-companion-v1.js';
import { createFullRestoreNativeRowProjectionV1 } from './full-restore-native-row-projection-v1.js';
import { createFullRestoreNativeCatalogCollectorV2 } from './full-restore-native-catalog-v2/collector.js';
import type { FullRestoreNativePacketSnapshotPortV1 } from './full-restore-native-packet-capture-v1.js';

export class DomainSequenceStructureErrorV2 extends Error {
  constructor(
    readonly code:
      | 'STRUCTURE_ASSETS_INVALID'
      | 'STRUCTURE_REPLY_INVALID'
      | 'STRUCTURE_UNSUPPORTED'
      | 'STRUCTURE_MISMATCH'
      | 'STRUCTURE_LIFETIME_INVALID'
      | 'STRUCTURE_CANCELLED'
      | 'STRUCTURE_IO_FAILED',
  ) {
    super(code);
    this.name = 'DomainSequenceStructureErrorV2';
  }
}
const fail = (code: DomainSequenceStructureErrorV2['code']): never => {
  throw new DomainSequenceStructureErrorV2(code);
};
const sha = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
const LIMIT = 8388608;
// Literal source-owned query checksum, not caller-selected SQL.
const QUERY_SHA = '9b8874f39acc2af63ab3e0b2d896f09af4e1bfa0155c371b3bc6efcf50952b9e';
const id = z
  .string()
  .min(1)
  .max(63)
  .refine((v) => !v.includes('\0'));
const oid = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,9})$/)
  .refine((v) => /^(0|[1-9][0-9]{0,9})$/.test(v) && BigInt(v) <= 4294967295n);
const signed = z
  .string()
  .regex(/^(0|-?[1-9][0-9]{0,18})$/)
  .refine(
    (v) =>
      /^(0|-?[1-9][0-9]{0,18})$/.test(v) &&
      BigInt(v) >= -9223372036854775808n &&
      BigInt(v) <= 9223372036854775807n,
  );
const text = z.string().max(65536);
const dependency = z.strictObject({
  class: z.enum(['pg_class', 'pg_proc', 'pg_type', 'pg_operator', 'pg_collation', 'pg_trigger']),
  oid,
  subid: z.number().int().min(0).max(1600),
  kind: z.string().length(1),
  description: text,
  metadataSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
});
const column = z.strictObject({
  position: z.number().int().min(1).max(1600),
  name: id,
  typeOid: oid,
  typeSchema: id,
  typeKind: z.string().length(1),
  baseOid: oid,
  typmod: z.number().int(),
  nullable: z.boolean(),
  identity: z.enum(['', 'a', 'd']),
  generated: z.enum(['', 's']),
  defaultExpression: text.nullable(),
});
const constraint = z.strictObject({
  oid,
  name: id,
  kind: z.enum(['c', 'f', 'p', 'u', 'x', 't']),
  definition: text,
  validated: z.boolean(),
  deferrable: z.boolean(),
  deferred: z.boolean(),
  key: z.array(z.number().int().min(1).max(1600)).max(1600),
  foreignOid: oid,
  foreignKey: z.array(z.number().int().min(1).max(1600)).max(1600),
  updateAction: z.string().max(1),
  deleteAction: z.string().max(1),
  match: z.string().max(1),
  indexOid: oid,
  dependencies: z.array(dependency).max(4096),
});
const sequenceDependency = z.strictObject({
  class: text,
  objid: oid,
  objsubid: z.number().int().min(0).max(1600),
  refclass: text,
  refobjid: oid,
  refsubid: z.number().int().min(0).max(1600),
  kind: z.string().length(1),
  schema: id.nullable(),
  relation: id.nullable(),
  column: id.nullable(),
  identity: z.enum(['', 'a', 'd']).nullable(),
  dropped: z.boolean().nullable(),
});
const structureSchema = createBoundedPlainJsonSchema(LIMIT).pipe(
  z.strictObject({
    schemaVersion: z.literal(1),
    relations: z
      .array(
        z.strictObject({
          schema: id,
          relation: id,
          oid,
          columns: z.array(column).min(1).max(1600),
          constraints: z.array(constraint).max(4096),
        }),
      )
      .length(239),
    domains: z.array(oid).max(4096),
    sequences: z
      .array(
        z.strictObject({
          schema: id,
          relation: id,
          oid,
          owner: id,
          acl: text.nullable(),
          persistence: z.enum(['p', 'u', 't']),
          typeOid: oid,
          start: signed,
          increment: signed,
          minimum: signed,
          maximum: signed,
          cache: signed,
          cycle: z.boolean(),
          dependencies: z.array(sequenceDependency).max(32),
        }),
      )
      .length(1),
  }),
);
type Structure = z.infer<typeof structureSchema>;
function own(raw: unknown, key: string): unknown {
  if (!raw || typeof raw !== 'object') return fail('STRUCTURE_REPLY_INVALID');
  const d = Object.getOwnPropertyDescriptor(raw, key);
  if (!d || !('value' in d)) return fail('STRUCTURE_REPLY_INVALID');
  return d.value;
}
function exact(raw: unknown, keys: readonly string[]) {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Object.getPrototypeOf(raw) !== Object.prototype ||
    Reflect.ownKeys(raw).length !== keys.length
  )
    return fail('STRUCTURE_REPLY_INVALID');
  return Object.fromEntries(keys.map((k) => [k, own(raw, k)]));
}
function method(raw: unknown, key: string) {
  const fn = own(raw, key);
  if (typeof fn !== 'function') return fail('STRUCTURE_REPLY_INVALID');
  return (...args: unknown[]) => Reflect.apply(fn, raw, args);
}
function copy(raw: unknown): Uint8Array {
  if (!(raw instanceof Uint8Array) || Object.getPrototypeOf(raw) !== Uint8Array.prototype)
    return fail('STRUCTURE_ASSETS_INVALID');
  const proto = Object.getPrototypeOf(Uint8Array.prototype);
  const buffer: unknown = Object.getOwnPropertyDescriptor(proto, 'buffer')?.get?.call(raw);
  const size: unknown = Object.getOwnPropertyDescriptor(proto, 'byteLength')?.get?.call(raw);
  const offset: unknown = Object.getOwnPropertyDescriptor(proto, 'byteOffset')?.get?.call(raw);
  if (
    !(buffer instanceof ArrayBuffer) ||
    Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype ||
    Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get?.call(buffer) !==
      false ||
    typeof size !== 'number' ||
    size < 1 ||
    size > LIMIT ||
    offset !== 0 ||
    buffer.byteLength !== size
  )
    return fail('STRUCTURE_ASSETS_INVALID');
  return new Uint8Array(new Uint8Array(buffer));
}
function parse(text: string): Structure {
  if (Buffer.byteLength(text) > LIMIT) return fail('STRUCTURE_REPLY_INVALID');
  const value: unknown = JSON.parse(text);
  // JSON.parse accepts duplicate keys; inspect key tokens before trusting the parsed value.
  const stack: (Set<string> | null)[] = [];
  let prior = '',
    visits = 0;
  for (const match of text.matchAll(
    /"(?:\\.|[^"\\])*"|[{}[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g,
  )) {
    if (++visits > 250000) return fail('STRUCTURE_REPLY_INVALID');
    const token = match[0];
    if (token === '{' || token === '[') {
      stack.push(token === '{' ? new Set<string>() : null);
      if (stack.length > 32) return fail('STRUCTURE_REPLY_INVALID');
    } else if (token === '}' || token === ']') stack.pop();
    else if (token === ':') {
      const keys = stack.at(-1);
      const key: unknown = JSON.parse(prior);
      if (!keys || typeof key !== 'string' || keys.has(key)) return fail('STRUCTURE_REPLY_INVALID');
      keys.add(key);
    }
    prior = token;
  }
  const r = structureSchema.safeParse(value);
  if (!r.success) return fail('STRUCTURE_REPLY_INVALID');
  return r.data;
}
const IDENTITY_SQL = `SELECT current_database() AS database_name,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,current_user AS current_role,session_user AS session_role,(SELECT oid::text FROM pg_roles WHERE rolname=current_user) AS role_oid,txid_current_snapshot()::text AS snapshot,current_setting('server_version_num') AS server_version,current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only,current_setting('DateStyle') AS date_style,current_setting('client_encoding') AS encoding`;
function row(raw: unknown) {
  const rows = own(raw, 'rows');
  if (!Array.isArray(rows) || rows.length !== 1 || own(raw, 'rowCount') !== 1)
    return fail('STRUCTURE_REPLY_INVALID');
  return own(rows, '0');
}
function identity(raw: unknown) {
  const r = exact(row(raw), [
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
  ]);
  const p = createBoundedPlainJsonSchema(4096)
    .pipe(
      z.strictObject({
        database_name: id,
        database_oid: oid,
        current_role: id,
        session_role: id,
        role_oid: oid,
        snapshot: z.string().regex(/^[0-9]+:[0-9]+:(?:[0-9]+(?:,[0-9]+)*)?$/),
        server_version: z.literal('170006'),
        isolation: z.literal('repeatable read'),
        read_only: z.literal('on'),
        date_style: z.literal('ISO, YMD'),
        encoding: z.literal('UTF8'),
      }),
    )
    .safeParse(r);
  if (!p.success) return fail('STRUCTURE_LIFETIME_INVALID');
  return p.data;
}
function validate(
  value: Structure,
  plans: ReturnType<typeof createFullRestoreNativeRowProjectionV1>['allPlans'],
) {
  if (value.domains.length !== 0) return fail('STRUCTURE_UNSUPPORTED');
  const seen = new Set<string>();
  const relationOids = new Map<string, Structure['relations'][number]>();
  for (const [i, r] of value.relations.entries()) {
    const plan = plans[i];
    const key = r.schema + '.' + r.relation;
    if (
      !plan ||
      plan.schema !== r.schema ||
      plan.relation !== r.relation ||
      seen.has(key) ||
      r.oid === '0' ||
      relationOids.has(r.oid)
    )
      return fail('STRUCTURE_MISMATCH');
    seen.add(key);
    relationOids.set(r.oid, r);
    if (
      r.columns.length !== plan.columns.length ||
      new Set(r.columns.map((c) => c.position)).size !== r.columns.length ||
      new Set(r.columns.map((c) => c.name)).size !== r.columns.length
    )
      return fail('STRUCTURE_MISMATCH');
    for (const [j, c] of r.columns.entries())
      if (
        c.name !== plan.columns[j]?.column ||
        c.typeSchema !== 'pg_catalog' ||
        c.typeKind !== 'b' ||
        c.baseOid !== '0' ||
        c.typeOid === '0'
      )
        return fail('STRUCTURE_UNSUPPORTED');
    if (
      new Set(r.constraints.map((c) => c.name)).size !== r.constraints.length ||
      new Set(r.constraints.map((c) => c.oid)).size !== r.constraints.length
    )
      return fail('STRUCTURE_MISMATCH');
    for (const c of r.constraints)
      if (c.key.some((k) => !r.columns.some((col) => col.position === k)))
        return fail('STRUCTURE_MISMATCH');
  }
  for (const r of value.relations)
    for (const c of r.constraints) {
      if (c.kind === 'f') {
        const foreign = relationOids.get(c.foreignOid);
        if (
          !foreign ||
          c.key.length === 0 ||
          c.key.length !== c.foreignKey.length ||
          c.foreignKey.some((k) => !foreign.columns.some((col) => col.position === k))
        )
          return fail('STRUCTURE_UNSUPPORTED');
      }
      if (c.dependencies.some((d) => d.class === 'pg_trigger' && (c.kind !== 't' || d.subid !== 0)))
        return fail('STRUCTURE_UNSUPPORTED');
      if (
        new Set(c.dependencies.map((d) => `${d.class}:${d.oid}:${d.subid}:${d.kind}`)).size !==
        c.dependencies.length
      )
        return fail('STRUCTURE_MISMATCH');
      if (c.dependencies.some((d) => d.oid === '0' || !d.description || d.metadataSha256 === null))
        return fail('STRUCTURE_MISMATCH');
    }
  const s = value.sequences[0];
  if (
    !s ||
    s.schema !== 'public' ||
    s.relation !== 'openai_budget_journal_sequence_id_seq' ||
    s.typeOid !== '20' ||
    s.oid === '0'
  )
    return fail('STRUCTURE_UNSUPPORTED');
  const start = BigInt(s.start),
    inc = BigInt(s.increment),
    min = BigInt(s.minimum),
    max = BigInt(s.maximum),
    cache = BigInt(s.cache);
  if (inc === 0n || min >= max || start < min || start > max || cache < 1n)
    return fail('STRUCTURE_MISMATCH');
  const ownership = s.dependencies.filter((d) => d.kind === 'a' || d.kind === 'i');
  const d = ownership[0];
  if (
    ownership.length !== 1 ||
    !d ||
    d.class !== 'pg_class' ||
    d.objid !== s.oid ||
    d.objsubid !== 0 ||
    d.refclass !== 'pg_class' ||
    d.kind !== 'i' ||
    d.schema !== 'public' ||
    d.relation !== 'openai_budget_journal' ||
    d.column !== 'sequence_id' ||
    d.identity !== 'a' ||
    d.dropped !== false
  )
    return fail('STRUCTURE_MISMATCH');
  const journal = relationOids.get(d.refobjid);
  const c = journal?.columns.find((c) => c.position === d.refsubid);
  if (
    journal?.schema !== d.schema ||
    journal.relation !== d.relation ||
    c?.name !== d.column ||
    c.identity !== 'a' ||
    c.typeOid !== '20'
  )
    return fail('STRUCTURE_MISMATCH');
  if (
    new Set(s.dependencies.map((d) => JSON.stringify(d))).size !== s.dependencies.length ||
    s.dependencies.some((d) => d.class !== 'pg_class' || d.objid !== s.oid || d.objsubid !== 0)
  )
    return fail('STRUCTURE_MISMATCH');
}
/** Structure facts only. Expected metadata is independently pinned by Root, never inferred from a reply. */
export function createDomainSequenceStructureCompanionV2(
  rawAssets: unknown,
  rawPins: unknown,
  port: FullRestoreNativePacketSnapshotPortV1,
) {
  try {
    const assets = exact(rawAssets, [
      'registration',
      'catalog',
      'fixedQuery',
      'sourceOwnedRoster',
      'structureQuery',
      'expectedStructure',
    ]);
    const pins = exact(rawPins, [
      'registrationSha256',
      'catalogSha256',
      'querySha256',
      'rosterSha256',
      'structureQuerySha256',
      'expectedStructureSha256',
    ]);
    const c3 = {
      registration: copy(assets['registration']),
      catalog: copy(assets['catalog']),
      fixedQuery: copy(assets['fixedQuery']),
      sourceOwnedRoster: copy(assets['sourceOwnedRoster']),
    };
    const c3Pins = {
      registrationSha256: pins['registrationSha256'],
      catalogSha256: pins['catalogSha256'],
      querySha256: pins['querySha256'],
      rosterSha256: pins['rosterSha256'],
    };
    const expectedPin = pins['expectedStructureSha256'];
    const queryBytes = copy(assets['structureQuery']),
      expectedBytes = copy(assets['expectedStructure']);
    if (
      pins['structureQuerySha256'] !== QUERY_SHA ||
      sha(queryBytes) !== QUERY_SHA ||
      typeof expectedPin !== 'string' ||
      !/^[a-f0-9]{64}$/.test(expectedPin) ||
      sha(expectedBytes) !== expectedPin
    )
      return fail('STRUCTURE_ASSETS_INVALID');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const sql = decoder.decode(queryBytes),
      expected = parse(decoder.decode(expectedBytes));
    const plans = createFullRestoreNativeRowProjectionV1(c3, c3Pins).allPlans;
    const nativeCatalog = createFullRestoreNativeCatalogCollectorV2(
      { fixedQuery: c3.fixedQuery, sourceOwnedRoster: c3.sourceOwnedRoster },
      { querySha256: c3Pins.querySha256, rosterSha256: c3Pins.rosterSha256 },
    ).receive(JSON.parse(decoder.decode(c3.catalog))).catalog;
    const matchesCatalog = (value: Structure) => {
      for (const [i, r] of value.relations.entries()) {
        const native = nativeCatalog.relations[i];
        if (
          !native ||
          String(native.oid) !== r.oid ||
          r.columns.some((c, j) => {
            const n = native.columns[j];
            return (
              !n ||
              n.position !== c.position ||
              n.name !== c.name ||
              String(n.physicalTypeOid) !== c.typeOid ||
              n.typmod !== c.typmod ||
              n.nullable !== c.nullable ||
              n.identity !== c.identity ||
              n.generated !== c.generated ||
              n.defaultExpression !== c.defaultExpression
            );
          })
        )
          return fail('STRUCTURE_MISMATCH');
      }
    };
    validate(expected, plans);
    matchesCatalog(expected);
    const expectedJson = JSON.stringify(expected),
      schemas = [...new Set(plans.map((p) => p.schema))];
    const withLease = method(port, 'withRepeatableReadOnly');
    async function capture(signal?: AbortSignal) {
      let called = 0,
        active = true;
      let completed:
        Awaited<ReturnType<ReturnType<typeof createNativeOrderCompanionV1>['capture']>> | undefined;
      let firstIdentity: ReturnType<typeof identity> | undefined;
      let structure: Structure | undefined;
      let nativeFailure: DomainSequenceStructureErrorV2 | undefined;
      const cancelled = () => {
        if (signal?.aborted) return fail('STRUCTURE_CANCELLED');
      };
      const wrapped: FullRestoreNativePacketSnapshotPortV1 = {
        withRepeatableReadOnly: async <T>(
          callback: (tx: {
            query: (sql: string, parameters: readonly unknown[]) => Promise<unknown>;
          }) => Promise<T>,
          cancellation?: AbortSignal,
        ): Promise<T> => {
          let resultValue: T | undefined;
          const result = await withLease(async (tx: unknown) => {
            if (!active || ++called !== 1) return fail('STRUCTURE_LIFETIME_INVALID');
            const invoke = method(tx, 'query');
            const query = async (sql: string, params: readonly unknown[]) => {
              cancelled();
              if (!active) return fail('STRUCTURE_LIFETIME_INVALID');
              const value: unknown = await invoke(sql, params);
              cancelled();
              if (!active) return fail('STRUCTURE_LIFETIME_INVALID');
              return value;
            };
            try {
              firstIdentity = identity(await query(IDENTITY_SQL, []));
              if (firstIdentity.database_oid !== String(nativeCatalog.database.oid))
                return fail('STRUCTURE_LIFETIME_INVALID');
              resultValue = await callback({ query });
              const raw = exact(row(await query(sql, [schemas])), ['byte_length', 'body']);
              if (
                typeof raw['body'] !== 'string' ||
                typeof raw['byte_length'] !== 'string' ||
                !/^(0|[1-9][0-9]{0,7})$/.test(raw['byte_length']) ||
                Buffer.byteLength(raw['body']) !== Number(raw['byte_length'])
              )
                return fail('STRUCTURE_REPLY_INVALID');
              structure = parse(raw['body']);
              validate(structure, plans);
              matchesCatalog(structure);
              if (JSON.stringify(structure) !== expectedJson) return fail('STRUCTURE_MISMATCH');
              if (
                JSON.stringify(identity(await query(IDENTITY_SQL, []))) !==
                JSON.stringify(firstIdentity)
              )
                return fail('STRUCTURE_LIFETIME_INVALID');
              return resultValue;
            } catch (error) {
              nativeFailure =
                error instanceof DomainSequenceStructureErrorV2
                  ? error
                  : new DomainSequenceStructureErrorV2('STRUCTURE_IO_FAILED');
              throw nativeFailure;
            } finally {
              active = false;
            }
          }, cancellation);
          cancelled();
          if (called !== 1 || resultValue === undefined || result !== resultValue)
            return fail('STRUCTURE_LIFETIME_INVALID');
          return resultValue;
        },
      };
      try {
        cancelled();
        completed = await createNativeOrderCompanionV1(c3, c3Pins, wrapped).capture(signal);
        cancelled();
        if (called !== 1 || !completed || !structure || !firstIdentity)
          return fail('STRUCTURE_LIFETIME_INVALID');
        return Object.freeze({
          schemaVersion: 1 as const,
          kind: 'domain-sequence-structure-companion-v1' as const,
          captured: completed,
          structureEvidence: 'validated_port_domain_sequence_structure_facts' as const,
          structureSha256: sha(expectedJson),
          expectedStructureSha256: expectedPin,
          catalogSha256: sha(c3.catalog),
          registrationSha256: sha(c3.registration),
          structureQuerySha256: QUERY_SHA,
          snapshotIdentitySha256: sha(JSON.stringify(firstIdentity)),
          relationCount: 239 as const,
          sequenceCount: 1 as const,
          domainCount: 0 as const,
          constraintCount: structure.relations.reduce((n, r) => n + r.constraints.length, 0),
          authority: 'none' as const,
          registryTrusted: false as const,
          productionRegistry: false as const,
          admissionAllowed: false as const,
          domainValidation: 'not_checked' as const,
          sequenceHighWater: 'not_checked' as const,
          pgDumpCorrespondence: 'not_checked' as const,
          wholeInverseLoader: 'not_checked' as const,
        });
      } catch (error) {
        if (nativeFailure) throw nativeFailure;
        if (error instanceof DomainSequenceStructureErrorV2) throw error;
        return fail('STRUCTURE_IO_FAILED');
      } finally {
        active = false;
      }
    }
    return Object.freeze({
      capture,
      authority: 'none' as const,
      registryTrusted: false as const,
      admissionAllowed: false as const,
    });
  } catch (error) {
    if (error instanceof DomainSequenceStructureErrorV2) throw error;
    return fail('STRUCTURE_ASSETS_INVALID');
  }
}
