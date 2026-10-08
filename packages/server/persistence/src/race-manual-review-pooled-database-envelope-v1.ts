import { z } from 'zod';
import { impactDependencyDigest as digest } from './race-plan-impact-dependencies.js';
import { raceManualReviewMultiOwnedRetainedPayloadV3Schema } from './race-manual-review-retained-payload-v2.js';
import {
  raceManualReviewPooledRetainedPayloadV1Schema,
  parseRaceManualReviewPooledRetainedPairV1,
  type RaceManualReviewPooledRetainedPayloadV1,
} from './race-manual-review-pooled-retained-payload-v1.js';

const MAX_BYTES = 4 * 1024 * 1024;
/** A local JSON boundary only. Does not authorize direct DB storage. */
function bounded(value: unknown): void {
  const active = new WeakSet<object>();
  let nodes = 0;
  let primitiveBytes = 0;
  function visit(raw: unknown, depth: number): void {
    if (++nodes > MAX_BYTES + 1 || depth > 64) throw Error('POOLED_DATABASE_BOUND');
    if (typeof raw === 'string') primitiveBytes += Buffer.byteLength(raw, 'utf8');
    else if (raw === null || typeof raw === 'boolean') {
      // Finite JSON scalars.
    } else if (typeof raw === 'number' && Number.isFinite(raw)) {
      // Finite JSON scalars.
    } else {
      if (typeof raw !== 'object' || active.has(raw)) throw Error('POOLED_DATABASE_PLAIN');
      const array = Array.isArray(raw);
      if (
        Object.getPrototypeOf(raw) !== (array ? Array.prototype : Object.prototype) ||
        Object.getOwnPropertySymbols(raw).length
      )
        throw Error('POOLED_DATABASE_PLAIN');
      const descriptors = Object.getOwnPropertyDescriptors(raw);
      if (array && Object.keys(descriptors).length !== raw.length + 1)
        throw Error('POOLED_DATABASE_PLAIN');
      active.add(raw);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (array && key === 'length') continue;
        if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= raw.length))
          throw Error('POOLED_DATABASE_PLAIN');
        if (!descriptor.enumerable || !('value' in descriptor))
          throw Error('POOLED_DATABASE_PLAIN');
        primitiveBytes += Buffer.byteLength(key, 'utf8');
        if (primitiveBytes > MAX_BYTES) throw Error('POOLED_DATABASE_BOUND');
        visit(descriptor.value, depth + 1);
      }
      active.delete(raw);
    }
    if (primitiveBytes > MAX_BYTES) throw Error('POOLED_DATABASE_BOUND');
  }
  visit(value, 0);
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json, 'utf8') > MAX_BYTES)
    throw Error('POOLED_DATABASE_BOUND');
}
const plain = z.unknown().superRefine((value, ctx) => {
  try {
    bounded(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid bounded plain database envelope' });
  }
});
const oldPresent = raceManualReviewMultiOwnedRetainedPayloadV3Schema.out.options[0];
const oldPayload = oldPresent.shape.payload;
const privateShape = raceManualReviewPooledRetainedPayloadV1Schema.out;
const preparationSkeleton = z.strictObject({
  context: z.json(),
  sourceInput: z.json(),
  candidate: z.json(),
});
const encodedPreparation = privateShape
  .omit({ skeleton: true })
  .extend({ skeleton: preparationSkeleton });
const { preparation: logicalPreparationSchema, ...payloadFields } = oldPayload.shape;
const { payload: logicalPayloadSchema, ...headerFields } = oldPresent.shape;
void logicalPreparationSchema;
void logicalPayloadSchema;
const body = z.strictObject({ ...payloadFields, preparation: encodedPreparation });
const envelope = z.strictObject({ ...headerFields, payload: body });
// Reuse every old field validator; placeholder-containing preparation is only
// validated through the frozen private codec after the bijection reconstructs it.
const skeletonFrame = z.strictObject({
  ...headerFields,
  payload: z.strictObject({ ...payloadFields, preparation: preparationSkeleton }),
});
type Envelope = z.infer<typeof envelope>;
function privateValue(parsed: Envelope) {
  const { preparation, ...restPayload } = parsed.payload;
  const { skeleton, ...metadata } = preparation;
  const { payload: discarded, ...rest } = parsed;
  void discarded;
  return {
    ...metadata,
    skeleton: { ...rest, payload: { ...restPayload, preparation: skeleton } },
  };
}
/** Keeps state/status/audit and inventory/observations at their historical paths.
 * This structural bijection is neither a storage seal nor source authentication. */
export function toRaceManualReviewPooledDatabaseEnvelopeV1(raw: unknown): Envelope {
  const { pooled } = parseRaceManualReviewPooledRetainedPairV1(raw);
  const frame = skeletonFrame.parse(pooled.skeleton);
  const { skeleton: discarded, ...metadata } = pooled;
  void discarded;
  const value = {
    ...frame,
    payload: {
      ...frame.payload,
      preparation: { ...metadata, skeleton: frame.payload.preparation },
    },
  };
  bounded(value);
  const parsed = envelope.parse(value);
  if (digest(privateValue(parsed)) !== digest(pooled))
    throw Error('POOLED_DATABASE_CORRESPONDENCE');
  return parsed;
}
function refineDatabasePair(value: Envelope, ctx: z.RefinementCtx) {
  try {
    return parseRaceManualReviewPooledRetainedPairV1(privateValue(value));
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid database envelope correspondence' });
    return undefined;
  }
}
export const raceManualReviewPooledDatabaseEnvelopeV1Schema = plain
  .pipe(envelope)
  .superRefine((value, ctx) => {
    refineDatabasePair(value, ctx);
  });
export type RaceManualReviewPooledDatabaseEnvelopeV1 = z.infer<
  typeof raceManualReviewPooledDatabaseEnvelopeV1Schema
>;
export function fromRaceManualReviewPooledDatabaseEnvelopeV1(
  raw: unknown,
): RaceManualReviewPooledRetainedPayloadV1 {
  return parseDatabasePair(raw).pooled;
}
function parseDatabasePair(raw: unknown) {
  let pair: ReturnType<typeof parseRaceManualReviewPooledRetainedPairV1> | undefined;
  plain
    .pipe(envelope)
    .superRefine((value, ctx) => {
      pair = refineDatabasePair(value, ctx);
    })
    .parse(raw);
  if (pair === undefined) throw Error('POOLED_DATABASE_CORRESPONDENCE');
  return pair;
}
export function decodeRaceManualReviewPooledDatabaseEnvelopeV1(raw: unknown) {
  return parseDatabasePair(raw).retained;
}
