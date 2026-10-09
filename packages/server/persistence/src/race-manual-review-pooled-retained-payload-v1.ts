import { z } from 'zod';
import { impactDependencyDigest as digest } from './race-plan-impact-dependencies.js';
import { raceManualReviewFullCopiedInventoryV2Schema } from './race-manual-review-full-copied-inventory-v2.js';
import { raceManualReviewMultiOwnedRetainedPayloadV3Schema } from './race-manual-review-retained-payload-v2.js';

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_REFS = 5000;
/** Node JSON boundary, not a PostgreSQL JSONB byte estimate or source permission. */
function bounded(raw: unknown): void {
  const active = new WeakSet<object>();
  let visits = 0;
  let primitiveBytes = 0;
  function visit(value: unknown, depth: number): void {
    if (++visits > MAX_BYTES + 1 || depth > 64) throw Error('POOLED_RETAINED_BOUND');
    if (typeof value === 'string') primitiveBytes += Buffer.byteLength(value, 'utf8');
    else if (value === null || typeof value === 'boolean') {
      // Finite JSON scalars.
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      // Finite JSON scalars.
    } else {
      if (typeof value !== 'object' || active.has(value)) throw Error('POOLED_RETAINED_PLAIN');
      const array = Array.isArray(value);
      if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype))
        throw Error('POOLED_RETAINED_PLAIN');
      if (Object.getOwnPropertySymbols(value).length) throw Error('POOLED_RETAINED_PLAIN');
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (array && Object.keys(descriptors).length !== value.length + 1)
        throw Error('POOLED_RETAINED_PLAIN');
      active.add(value);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (array && key === 'length') continue;
        if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))
          throw Error('POOLED_RETAINED_PLAIN');
        if (!descriptor.enumerable || !('value' in descriptor))
          throw Error('POOLED_RETAINED_PLAIN');
        primitiveBytes += Buffer.byteLength(key, 'utf8');
        if (primitiveBytes > MAX_BYTES) throw Error('POOLED_RETAINED_BOUND');
        visit(descriptor.value, depth + 1);
      }
      active.delete(value);
    }
    if (primitiveBytes > MAX_BYTES) throw Error('POOLED_RETAINED_BOUND');
  }
  visit(raw, 0);
  const json = JSON.stringify(raw);
  if (json === undefined || Buffer.byteLength(json, 'utf8') > MAX_BYTES)
    throw Error('POOLED_RETAINED_BOUND');
}
const plain = z.unknown().superRefine((raw, ctx) => {
  try {
    bounded(raw);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid bounded plain pooled retained payload' });
  }
});
const ref = raceManualReviewFullCopiedInventoryV2Schema.out.shape.refs.element;
const location = z
  .string()
  .min(1)
  .max(MAX_BYTES)
  .refine((value) => {
    return (
      /^(context|sourceInput|candidate)(?:\.[A-Za-z][A-Za-z0-9]*|\[(?:0|[1-9][0-9]*)\])+$/.test(
        value,
      ) &&
      !value
        .replace(/\[/g, '.')
        .replace(/\]/g, '')
        .split('.')
        .some((part) =>
          ['__proto__', 'prototype', 'constructor', 'proposed', 'after'].includes(part),
        )
    );
  });
const wire = z.strictObject({
  encodingVersion: z.literal(1),
  encoding: z.literal('typed-immutable-source-pool-v1'),
  logicalValidationProfile: z.literal('multi-owned-v3'),
  logicalDigestMethod: z.literal('dto-object-key-canonical-sha256-v1'),
  logicalDigest: z.string().regex(/^[a-f0-9]{64}$/),
  authority: z.literal('none'),
  permissionAuthority: z.literal('none'),
  freshness: z.literal('not_checked'),
  approvalAllowed: z.literal(false),
  skeleton: z.json(),
  sourcePool: z
    .array(
      z.strictObject({
        ordinal: z
          .number()
          .int()
          .min(0)
          .max(MAX_REFS - 1),
        identity: ref.shape.identity,
        representation: z.literal('immutable_body'),
        dtoDigest: ref.shape.dtoDigest,
        digestMethod: ref.shape.digestMethod,
        body: z.json(),
      }),
    )
    .max(MAX_REFS),
  substitutions: z
    .array(
      z.strictObject({
        location,
        sourceOrdinal: z
          .number()
          .int()
          .min(0)
          .max(MAX_REFS - 1),
      }),
    )
    .max(MAX_REFS),
});
type Wire = z.infer<typeof wire>;
type Retained = z.infer<typeof raceManualReviewMultiOwnedRetainedPayloadV3Schema>;
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
function keys(path: string): string[] {
  return location
    .parse(path)
    .replace(/\[([0-9]+)\]/g, '.$1')
    .split('.');
}
function member(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') throw Error('POOLED_RETAINED_SLOT');
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !('value' in descriptor)) throw Error('POOLED_RETAINED_SLOT');
  return descriptor.value;
}
function at(root: unknown, path: string): unknown {
  return keys(path).reduce(member, root);
}
function replace(root: unknown, path: string, body: unknown): void {
  const parts = keys(path);
  const key = parts.pop();
  if (key === undefined) throw Error('POOLED_RETAINED_SLOT');
  const parent = parts.reduce(member, root);
  member(parent, key);
  if (parent === null || typeof parent !== 'object') throw Error('POOLED_RETAINED_SLOT');
  Object.defineProperty(parent, key, {
    value: body,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}
function preparation(root: unknown): unknown {
  return member(member(root, 'payload'), 'preparation');
}
function encodeParsed(retained: Retained): Wire {
  if (retained.state !== 'present' || retained.status !== 'structurally_corresponding')
    throw Error('POOLED_RETAINED_NOT_CORRESPONDING');
  const refs = retained.payload.inventory.refs;
  if (refs.reduce((count, row) => count + row.copiedLocations.length, 0) > MAX_REFS)
    throw Error('POOLED_RETAINED_BOUND');
  const candidates = refs.flatMap((row, index) =>
    row.representation === 'immutable_body'
      ? row.copiedLocations.map((path) => ({ path: location.parse(path), index }))
      : [],
  );
  const outer = candidates.filter(
    ({ path }) =>
      !candidates.some(
        (other) =>
          path !== other.path &&
          (path.startsWith(other.path + '.') || path.startsWith(other.path + '[')),
      ),
  );
  const skeleton = clone(retained);
  const sourcePool: Wire['sourcePool'] = [];
  const substitutions: Wire['substitutions'] = [];
  refs.forEach((row, index) => {
    const paths = outer.filter((entry) => entry.index === index).map((entry) => entry.path);
    if (paths.length < 2) return;
    const ordinal = sourcePool.length;
    const body = at(retained.payload.preparation, paths[0] ?? '');
    const parsedBody = z.json().parse(body);
    if (digest(body) !== row.dtoDigest) throw Error('POOLED_RETAINED_BODY');
    sourcePool.push({
      ordinal,
      identity: row.identity,
      representation: 'immutable_body',
      dtoDigest: row.dtoDigest,
      digestMethod: row.digestMethod,
      body: parsedBody,
    });
    for (const path of paths) {
      if (digest(at(retained.payload.preparation, path)) !== row.dtoDigest)
        throw Error('POOLED_RETAINED_DIVERGENT_BODY');
      replace(preparation(skeleton), path, null);
      substitutions.push({ location: path, sourceOrdinal: ordinal });
    }
  });
  const encoded = {
    encodingVersion: 1 as const,
    encoding: 'typed-immutable-source-pool-v1' as const,
    logicalValidationProfile: 'multi-owned-v3' as const,
    logicalDigestMethod: 'dto-object-key-canonical-sha256-v1' as const,
    logicalDigest: digest(retained),
    authority: 'none' as const,
    permissionAuthority: 'none' as const,
    freshness: 'not_checked' as const,
    approvalAllowed: false as const,
    skeleton: z.json().parse(skeleton),
    sourcePool,
    substitutions,
  };
  bounded(encoded);
  return wire.parse(encoded);
}
/** Pure encoding only: the original strict V3 codec proves logical correspondence,
 * never DB ownership, processing permission, lifecycle or approval authority. */
export function encodeRaceManualReviewPooledRetainedPayloadV1(raw: unknown): Wire {
  return encodeRaceManualReviewPooledRetainedFromLogicalPairV1(raw).pooled;
}
/** Invocation-local construction pair only, never an authentication/cache token.
 * Every call validates unknown logical ingress; no caller-supplied parsed marker. */
export type RaceManualReviewPooledLogicalPairV1 = { pooled: Wire; retained: Retained };
export function encodeRaceManualReviewPooledRetainedFromLogicalPairV1(
  raw: unknown,
): RaceManualReviewPooledLogicalPairV1 {
  bounded(raw);
  const retained = raceManualReviewMultiOwnedRetainedPayloadV3Schema.parse(raw);
  const pooled = encodeParsed(retained);
  return { pooled, retained };
}
function decodeWire(encoded: Wire): Retained {
  const decoded = clone(encoded.skeleton);
  let expandedBytes = Buffer.byteLength(JSON.stringify(decoded), 'utf8');
  const seen = new Set<string>();
  for (const slot of encoded.substitutions) {
    if (seen.has(slot.location)) throw Error('POOLED_RETAINED_SLOT');
    for (const previous of seen) {
      if (
        slot.location.startsWith(previous + '.') ||
        slot.location.startsWith(previous + '[') ||
        previous.startsWith(slot.location + '.') ||
        previous.startsWith(slot.location + '[')
      )
        throw Error('POOLED_RETAINED_SLOT');
    }
    seen.add(slot.location);
    const source = encoded.sourcePool[slot.sourceOrdinal];
    if (
      !source ||
      source.ordinal !== slot.sourceOrdinal ||
      at(preparation(decoded), slot.location) !== null ||
      digest(source.body) !== source.dtoDigest
    )
      throw Error('POOLED_RETAINED_SLOT');
    expandedBytes += Buffer.byteLength(JSON.stringify(source.body), 'utf8') - 4;
    if (expandedBytes > MAX_BYTES) throw Error('POOLED_RETAINED_BOUND');
    replace(preparation(decoded), slot.location, clone(source.body));
  }
  bounded(decoded);
  const retained = raceManualReviewMultiOwnedRetainedPayloadV3Schema.parse(decoded);
  if (
    digest(retained) !== encoded.logicalDigest ||
    digest(encodeParsed(retained)) !== digest(encoded)
  )
    throw Error('POOLED_RETAINED_CORRESPONDENCE');
  return retained;
}
function refineDecoded(value: Wire, ctx: z.RefinementCtx): Retained | undefined {
  try {
    return decodeWire(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid pooled retained correspondence' });
    return undefined;
  }
}
export const raceManualReviewPooledRetainedPayloadV1Schema = plain
  .pipe(wire)
  .superRefine((value, ctx) => {
    refineDecoded(value, ctx);
  });
export type RaceManualReviewPooledRetainedPayloadV1 = z.infer<
  typeof raceManualReviewPooledRetainedPayloadV1Schema
>;
/** Validates every unknown invocation and returns its strict wire/logical pair.
 * The pair is structural correspondence only, never a permission or cache token.
 * Shared internally by the database bijection; no unchecked typed entry exists. */
export function parseRaceManualReviewPooledRetainedPairV1(raw: unknown) {
  // Invocation-local state preserves Zod's continuable-issue refinement order.
  // Nothing survives this call or accepts a previously validated caller object.
  let retained: Retained | undefined;
  const pooled = plain
    .pipe(wire)
    .superRefine((value, ctx) => {
      retained = refineDecoded(value, ctx);
    })
    .parse(raw);
  if (retained === undefined) throw Error('POOLED_RETAINED_CORRESPONDENCE');
  return { pooled, retained };
}
export function decodeRaceManualReviewPooledRetainedPayloadV1(raw: unknown): Retained {
  return parseRaceManualReviewPooledRetainedPairV1(raw).retained;
}
