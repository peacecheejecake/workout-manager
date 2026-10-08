import { z } from 'zod';
import { assertRaceManualPlainV2 } from './race-manual-review-consumed-use-v2.js';
import { raceManualReviewChainResultV2Schema } from './race-manual-review-chain-v2.js';
import {
  decodeRaceManualReviewPooledDatabaseEnvelopeV1,
  raceManualReviewPooledDatabaseEnvelopeV1Schema,
} from './race-manual-review-pooled-database-envelope-v1.js';
import { raceManualReviewMultiOwnedRetainedPayloadV3Schema } from './race-manual-review-retained-payload-v2.js';

type Json = z.infer<ReturnType<typeof z.json>>;
type DeltaNode =
  | { kind: 'same' }
  | { kind: 'literal'; value: Json }
  | { kind: 'object'; entries: { key: string; node: DeltaNode }[] }
  | { kind: 'array'; items: DeltaNode[] };
const node: z.ZodType<DeltaNode> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('same') }),
    z.strictObject({ kind: z.literal('literal'), value: z.json() }),
    z.strictObject({
      kind: z.literal('object'),
      entries: z.array(z.strictObject({ key: z.string(), node })).max(5000),
    }),
    z.strictObject({ kind: z.literal('array'), items: z.array(node).max(5000) }),
  ]),
);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const common = {
  readerVersion: z.literal(1),
  parentDeltaVersion: z.literal(1),
  schemaVersion: z.literal(2),
  result: z.lazy(() => raceManualReviewChainResultV2Schema),
};
const present = z.strictObject({
  ...common,
  payloadEncoding: z.enum(['legacy-retained-v2', 'pooled-database-envelope-v1']),
  baseDigestMethod: z.literal('postgres-jsonb-v1'),
  baseSqlDigest: hash,
  parentDigestMethod: z.literal('postgres-jsonb-v1'),
  parentSqlDigest: hash,
  delta: node,
  deltaNodes: z.number().int().min(1).max(5000),
  purgedAt: z.null(),
  purgedEventId: z.null(),
});
const purged = z.strictObject({
  ...common,
  payloadEncoding: z.null(),
  baseDigestMethod: z.null(),
  baseSqlDigest: z.null(),
  parentDigestMethod: z.null(),
  parentSqlDigest: z.null(),
  delta: z.null(),
  deltaNodes: z.literal(0),
  purgedAt: z.iso.datetime({ offset: true }),
  purgedEventId: z.uuid(),
});
function deltaQuota(raw: unknown, depth = 0): number {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || depth > 64) invalid();
  const kind = Object.getOwnPropertyDescriptor(raw, 'kind')?.value;
  if (kind === 'same' || kind === 'literal') return 1;
  const children = Object.getOwnPropertyDescriptor(
    raw,
    kind === 'object' ? 'entries' : 'items',
  )?.value;
  if ((kind !== 'object' && kind !== 'array') || !Array.isArray(children)) invalid();
  let count = 1;
  for (const child of children) {
    const nested: unknown =
      kind === 'object'
        ? child !== null && typeof child === 'object'
          ? Object.getOwnPropertyDescriptor(child, 'node')?.value
          : undefined
        : child;
    count += deltaQuota(nested, depth + 1);
    if (count > 5000) invalid();
  }
  return count;
}
const plain = z.unknown().superRefine((raw, ctx) => {
  try {
    assertRaceManualPlainV2(raw);
    if (raw !== null && typeof raw === 'object') {
      const delta: unknown = Object.getOwnPropertyDescriptor(raw, 'delta')?.value;
      if (delta !== null) deltaQuota(delta);
    }
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid bounded plain parent delta' });
  }
});
/** Structural wire only; SQLJSONB hashes are not Node digests or credentials. */
export const raceManualPooledParentDeltaV1Schema = plain.pipe(z.union([present, purged]));
const limits = {
  authority: 'none',
  permissionAuthority: 'none',
  sourceAuthentication: 'unverified',
  freshness: 'not_checked',
  approvalAllowed: false,
  planApplied: false,
} as const;
function invalid(): never {
  throw Error('POOLED_PARENT_DELTA_INVALID');
}
function object(value: Json): value is { [key: string]: Json } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
// Preflight exact compact escaped JSON contribution before cloning/assembling.
// Descriptor tree quotas and original plain caps remain independent constraints.
function reconstruct(base: Json, delta: DeltaNode, expectedNodes: number): Json {
  let bytes = 0;
  let nodes = 0;
  const charge = (value: number) => {
    bytes += value;
    if (bytes > 4194304) throw Error('POOLED_PARENT_DELTA_BOUND');
  };
  function jsonBytes(value: Json, depth: number): void {
    if (depth > 64) invalid();
    if (value === null || typeof value !== 'object') {
      charge(Buffer.byteLength(JSON.stringify(value), 'utf8'));
      return;
    }
    charge(2);
    if (Array.isArray(value)) {
      for (const [index, child] of value.entries()) {
        if (index) charge(1);
        jsonBytes(child, depth + 1);
      }
    } else {
      for (const [index, [key, child]] of Object.entries(value).entries()) {
        if (index) charge(1);
        charge(Buffer.byteLength(JSON.stringify(key), 'utf8') + 1);
        jsonBytes(child, depth + 1);
      }
    }
  }
  function preflight(value: Json, change: DeltaNode, depth: number): void {
    if (++nodes > 5000 || depth > 64) invalid();
    switch (change.kind) {
      case 'same':
        jsonBytes(value, depth);
        return;
      case 'literal':
        jsonBytes(change.value, depth);
        return;
      case 'array':
        if (!Array.isArray(value) || value.length !== change.items.length) invalid();
        charge(2);
        for (const [index, child] of change.items.entries()) {
          if (index) charge(1);
          const prior = value[index];
          if (prior === undefined) invalid();
          preflight(prior, child, depth + 1);
        }
        return;
      case 'object': {
        if (!object(value) || Object.keys(value).length !== change.entries.length) invalid();
        const seen = new Set<string>();
        charge(2);
        for (const [index, entry] of change.entries.entries()) {
          if (seen.has(entry.key) || !Object.hasOwn(value, entry.key)) invalid();
          seen.add(entry.key);
          if (index) charge(1);
          charge(Buffer.byteLength(JSON.stringify(entry.key), 'utf8') + 1);
          const prior = value[entry.key];
          if (prior === undefined) invalid();
          preflight(prior, entry.node, depth + 1);
        }
      }
    }
  }
  // No intermediate target tree exists until the complete bound is known.
  preflight(base, delta, 0);
  if (nodes !== expectedNodes) invalid();
  function build(value: Json, change: DeltaNode): Json {
    switch (change.kind) {
      case 'same':
        return structuredClone(value);
      case 'literal':
        return structuredClone(change.value);
      case 'array':
        if (!Array.isArray(value)) invalid();
        return change.items.map((entry, index) => {
          const prior = value[index];
          if (prior === undefined) invalid();
          return build(prior, entry);
        });
      case 'object':
        if (!object(value)) invalid();
        return Object.fromEntries(
          change.entries.map((entry) => {
            const prior = value[entry.key];
            if (prior === undefined) invalid();
            return [entry.key, build(prior, entry.node)];
          }),
        );
    }
  }
  const result = build(base, delta);
  assertRaceManualPlainV2(result);
  return result;
}
/** Fully reconstructs/validates the historical parent. Does not authenticate
 * DB ownership, current permission, same-xid or measured-budget correspondence;
 * the trusted transaction adapter must establish those separately. */
export function parseRaceManualPooledParentDeltaV1(unknownBase: unknown, unknownResponse: unknown) {
  assertRaceManualPlainV2(unknownBase);
  const base = raceManualReviewPooledDatabaseEnvelopeV1Schema.parse(unknownBase);
  if (unknownResponse === null) return null;
  const wire = raceManualPooledParentDeltaV1Schema.parse(unknownResponse);
  if (wire.payloadEncoding === null)
    return { ...wire, payload: null, bodyState: 'purged' as const, ...limits };
  const payload = reconstruct(z.json().parse(base), wire.delta, wire.deltaNodes);
  const logical =
    wire.payloadEncoding === 'pooled-database-envelope-v1'
      ? decodeRaceManualReviewPooledDatabaseEnvelopeV1(payload)
      : raceManualReviewMultiOwnedRetainedPayloadV3Schema.parse(payload);
  if (
    logical.state !== 'present' ||
    logical.status !== 'structurally_corresponding' ||
    logical.minimalAudit.candidateDigest !== wire.result.candidateDigest
  )
    invalid();
  const { delta: discardedDelta, deltaNodes: discardedCount, ...header } = wire;
  void discardedDelta;
  void discardedCount;
  return { ...header, payload: logical, bodyState: 'present' as const, ...limits };
}
