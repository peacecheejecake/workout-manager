import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  createCurrentSourceReceiver,
  type CurrentSourceReceiverConfiguration,
  type VerifiedCurrentSourceRead,
} from './restore-current-source-receiver.js';
import {
  parseCurrentSourceExtraPhysicalRows,
  type CurrentSourceExtraPhysicalRow,
} from './restore-current-source-partitions.js';

const relations = [
  'identity_private.login_attempt',
  'identity_private.logout_token_replay',
  'identity_private.native_exchange_code',
  'identity_private.native_login_attempt',
  'identity_private.session',
] as const;
export class CurrentIdentityTargetError extends Error {
  constructor(
    readonly code:
      | 'INVALID_CONFIGURATION'
      | 'KEY_UNAVAILABLE'
      | 'INVALID_HANDLE'
      | 'SOURCE_CORRESPONDENCE_FAILED',
  ) {
    super(code);
  }
}
function fail(code: CurrentIdentityTargetError['code']): never {
  throw new CurrentIdentityTargetError(code);
}
const cloneBytes = 4 * 1024 * 1024;
/** Exact JSON UTF8 size is charged before serialization or cloning. The global
 * node/key bounds derive from this byte ceiling, not the 5000 source-ref cap.
 * Dense arrays need at least one byte per value; object property syntax costs
 * more. Counting array length keys permits at most twice the byte ceiling.
 */
function clone<T>(value: T): T {
  const active = new Set<object>();
  let bytes = 0,
    nodes = 0,
    ownKeys = 0;
  function charge(amount: number) {
    bytes += amount;
    if (bytes > cloneBytes) fail('INVALID_CONFIGURATION');
  }
  function stringBytes(text: string) {
    // One UTF16 code unit needs at least one JSON byte; fail before UTF8 scan.
    if (text.length > cloneBytes - bytes - 2) fail('INVALID_CONFIGURATION');
    charge(2 + Buffer.byteLength(text, 'utf8'));
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (
        code === 34 ||
        code === 92 ||
        code === 8 ||
        code === 9 ||
        code === 10 ||
        code === 12 ||
        code === 13
      )
        charge(1);
      else if (code < 32) charge(5);
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) i++;
        else charge(3); // JSON escapes lone surrogate (6), UTF8 replacement was 3.
      } else if (code >= 0xdc00 && code <= 0xdfff) charge(3);
    }
  }
  function walk(item: unknown, depth: number): void {
    if (depth > 64 || ++nodes > cloneBytes + 1) fail('INVALID_CONFIGURATION');
    if (item === null) {
      charge(4);
      return;
    }
    if (typeof item === 'string') {
      stringBytes(item);
      return;
    }
    if (typeof item === 'boolean') {
      charge(item ? 4 : 5);
      return;
    }
    if (typeof item === 'number' && Number.isFinite(item)) {
      charge(JSON.stringify(item).length);
      return;
    }
    if (typeof item !== 'object' || active.has(item)) fail('INVALID_CONFIGURATION');
    const array = Array.isArray(item);
    const proto = Object.getPrototypeOf(item);
    if (proto !== (array ? Array.prototype : Object.prototype) && proto !== null)
      fail('INVALID_CONFIGURATION');
    if (array && item.length > cloneBytes) fail('INVALID_CONFIGURATION');
    active.add(item);
    const keys = Reflect.ownKeys(item);
    ownKeys += keys.length;
    if (ownKeys > cloneBytes * 2) fail('INVALID_CONFIGURATION');
    if (
      array &&
      (keys.length !== item.length + 1 ||
        keys.some(
          (key) =>
            key !== 'length' &&
            (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length),
        ))
    )
      fail('INVALID_CONFIGURATION');
    charge(2);
    let entries = 0;
    for (const key of keys) {
      if (array && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (
        typeof key !== 'string' ||
        !descriptor ||
        !('value' in descriptor) ||
        !descriptor.enumerable
      )
        fail('INVALID_CONFIGURATION');
      if (entries++) charge(1);
      if (!array) {
        stringBytes(key);
        charge(1);
      }
      walk(descriptor.value, depth + 1);
    }
    active.delete(item);
  }
  walk(value, 0);
  // At most 4MiB is allocated now; all JSON values/properties were inspected.
  if (Buffer.byteLength(JSON.stringify(value)) !== bytes) fail('INVALID_CONFIGURATION');
  return structuredClone(value);
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const count = z.string().regex(/^(0|[1-9]\d*)$/);
const limits = Object.freeze({
  authority: 'none' as const,
  admissionAllowed: false as const,
  sqlApply: 'not_executed' as const,
  scope: 'identity_private_five_relations_only' as const,
  keyFreshness: 'configured_active_keys_rechecked' as const,
  sourceFreshness: 'fixed_manifest_bytes_only' as const,
  latestTail: 'not_checked' as const,
  archiveRowCorrespondence: 'not_verified' as const,
  operationalKeyProvenance: 'external_gate' as const,
});
export type CurrentIdentityTargetConfiguration = Readonly<{
  source: Omit<CurrentSourceReceiverConfiguration, 'encryptionKey' | 'sourceAuthenticationKey'>;
  /** Trusted server key registry; null means revoked/unavailable. Keys remain private. */
  resolveKeys(
    ids: Readonly<{ encryptionKeyId: string; sourceKeyId: string }>,
  ): Promise<Readonly<{ encryptionKey: Uint8Array; sourceAuthenticationKey: Uint8Array }> | null>;
}>;
function transform(read: VerifiedCurrentSourceRead) {
  if (read.manifest.profile !== 'normal107-explicit108-116' || read.packets.length !== 3)
    fail('SOURCE_CORRESPONDENCE_FAILED');
  const packet = read.packets.find((p) => p.partition.kind === 'extra');
  if (!packet) fail('SOURCE_CORRESPONDENCE_FAILED');
  const original = parseCurrentSourceExtraPhysicalRows(packet.partition.rows);
  const selected = original.filter((row) =>
    relations.some((relation) => row.relation === relation),
  );
  const census = relations.map((relation) => {
    const manifestRows = read.manifest.census.filter(
      (r) => `${r.schema}.${r.relation}` === relation,
    );
    const packetRows = packet.partition.census.filter((r) => r.relation === relation);
    if (manifestRows.length !== 1 || packetRows.length !== 1) fail('SOURCE_CORRESPONDENCE_FAILED');
    const declared = count.safeParse(packetRows[0]?.count);
    const manifested = count.safeParse(manifestRows[0]?.rows);
    const present = selected.filter((row) => row.relation === relation).length;
    if (
      !declared.success ||
      !manifested.success ||
      BigInt(declared.data) !== BigInt(present) ||
      declared.data !== manifested.data
    )
      fail('SOURCE_CORRESPONDENCE_FAILED');
    return {
      relation,
      sourceCount: declared.data,
      targetCount: relation === 'identity_private.logout_token_replay' ? declared.data : '0',
      disposition:
        relation === 'identity_private.logout_token_replay'
          ? ('retain_replay_deny_audit' as const)
          : ('invalidate_archived_credentials' as const),
    };
  });
  // Exact replay-deny audit survives. Token/CSRF/verifier/session rows do not.
  // Preserve original source partition ordinals as correspondence metadata.
  // This subset is not a serialized complete extra partition; a later target
  // loader must assign any destination packet ordinals independently.
  const rows = selected.filter((row) => row.relation === 'identity_private.logout_token_replay');
  return { census, rows };
}
/** Fixed source116 authentication is an input to target preparation, never a
 * restore release. Every prepare/consume resolves active keys and re-reads the
 * same pinned immutable objects through the existing bounded crypto receiver.
 * No SQL, session mint, current DB tail check or new source profile is implied.
 */
export function createCurrentIdentityTargetPreparation(
  configuration: CurrentIdentityTargetConfiguration,
) {
  const resolveKeys = configuration.resolveKeys;
  if (typeof resolveKeys !== 'function' || typeof configuration.source.store.read !== 'function')
    fail('INVALID_CONFIGURATION');
  const readObject = configuration.source.store.read.bind(configuration.source.store);
  const { store: _store, ...metadata } = configuration.source;
  const pinned = clone(metadata);
  const handles = new WeakMap<object, string>();
  async function fresh() {
    let keys;
    try {
      keys = await resolveKeys(
        Object.freeze({ encryptionKeyId: pinned.encryptionKeyId, sourceKeyId: pinned.sourceKeyId }),
      );
    } catch {
      fail('KEY_UNAVAILABLE');
    }
    if (!keys) fail('KEY_UNAVAILABLE');
    const receiver = createCurrentSourceReceiver({
      ...clone(pinned),
      store: { read: readObject },
      encryptionKey: new Uint8Array(keys.encryptionKey),
      sourceAuthenticationKey: new Uint8Array(keys.sourceAuthenticationKey),
    });
    const received = await receiver.receive(clone(pinned.expectedManifest));
    return receiver.withVerifiedCurrentSource(received, transform);
  }
  return {
    async prepare() {
      const prepared = await fresh();
      const handle = Object.freeze({});
      handles.set(handle, digest(prepared));
      return {
        status: 'prepared_identity_partition' as const,
        handle,
        census: clone(prepared.census),
        limits,
      };
    },
    async withPreparedIdentityTarget<T>(
      handle: unknown,
      consume: (
        target: Readonly<{
          rows: readonly CurrentSourceExtraPhysicalRow[];
          census: ReturnType<typeof transform>['census'];
          limits: typeof limits;
        }>,
      ) => T,
    ): Promise<Awaited<T>> {
      if (!handle || typeof handle !== 'object' || typeof consume !== 'function')
        fail('INVALID_HANDLE');
      const prior = handles.get(handle);
      if (!prior) fail('INVALID_HANDLE');
      const prepared = await fresh();
      if (digest(prepared) !== prior) fail('SOURCE_CORRESPONDENCE_FAILED');
      return await consume({ ...clone(prepared), limits });
    },
  };
}
