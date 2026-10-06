import { createHash } from 'node:crypto';
import { z } from 'zod';
import { assembleRaceManualReviewCandidate } from './race-manual-review-candidate.js';
import type { RaceScheduleCalculationPorts } from './race-relative-schedule-impact.js';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const eventRefSchema = z.strictObject({
  id: z.uuid(),
  revision: z.number().int().min(1).max(2147483647),
});
const bindingSchema = z.strictObject({
  athleteId: z.string().min(1).max(200),
  event: eventRefSchema,
  readSetDigest: digestSchema,
});
const inputSchema = z.strictObject({
  candidate: z.strictObject({
    kind: z.literal('manual-race-review-draft'),
    status: z.literal('assembled'),
    storage: z.literal('not_persisted'),
    approval: z.strictObject({
      status: z.literal('blocked'),
      reasons: z.array(z.string()).length(4),
    }),
    digest: digestSchema,
    body: z.unknown(),
  }),
  sourceInput: z.unknown(),
  capturedBinding: bindingSchema,
  expectedBinding: bindingSchema,
});
// Only extract this subset after the existing producer has validated sourceInput.
const sourceIdentitySchema = z.object({
  athleteId: z.string(),
  projectionInput: z.object({ event: z.object(eventRefSchema.shape) }),
});
const bodyPartsSchema = z.object({
  retainedActualManifest: z.unknown(),
  pinIntents: z.unknown(),
  resolution: z.unknown(),
});
const maxBytes = 4 * 1024 * 1024;
// Source input and producer output each retain their existing 4MiB bound.
const envelopeMaxBytes = 2 * maxBytes + 4096;

/** A canonical JSON encoder with bounded depth, plain data only, and semantic
 * array order preserved. Object keys use the producer's codepoint ordering. */
function canonical(value: unknown, depth = 0, parents = new Set<object>()): string {
  if (depth > 64) throw new Error('INVALID_JSON');
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('INVALID_JSON');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object' || parents.has(value)) throw new Error('INVALID_JSON');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error('INVALID_JSON');
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error('INVALID_JSON');
  parents.add(value);
  try {
    if (Array.isArray(value)) {
      const entries: string[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (!descriptor || !('value' in descriptor)) throw new Error('INVALID_JSON');
        entries.push(canonical(descriptor.value, depth + 1, parents));
      }
      if (
        Object.keys(value).length !== value.length ||
        Object.getOwnPropertyNames(value).length !== value.length + 1
      )
        throw new Error('INVALID_JSON');
      return `[${entries.join(',')}]`;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length > 0) throw new Error('INVALID_JSON');
    return `{${Object.keys(descriptors)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((key) => {
        const descriptor = descriptors[key];
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
          throw new Error('INVALID_JSON');
        return `${JSON.stringify(key)}:${canonical(descriptor.value, depth + 1, parents)}`;
      })
      .join(',')}}`;
  } finally {
    parents.delete(value);
  }
}
function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}
const reject = (
  reason:
    | 'invalid_input'
    | 'input_bound'
    | 'context_mismatch'
    | 'source_rejected'
    | 'digest_mismatch'
    | 'retained_actual_mismatch'
    | 'pin_mismatch'
    | 'resolution_mismatch'
    | 'candidate_mismatch',
) => ({ status: 'rejected' as const, reason, admissionAllowed: false as const });

/** Pure storage integrity check against independently supplied server capture.
 * It authenticates neither capture nor owner, and checks no live DB freshness.
 * sourceInput must come from the repository capture, never browser source facts.
 * Rebuilding repeats bounded projection/calculation work once per verification;
 * injected calculation ports must be deterministic and perform no I/O.
 * Rebuilding with the existing strict producer validates every candidate body
 * field by exact equality; bodyPartsSchema is only for stable error diagnosis.
 */
export function verifyRaceManualReviewIntegrity(raw: unknown, ports: RaceScheduleCalculationPorts) {
  try {
    // Validate plain JSON before schemas or producer code can inspect accessors.
    if (Buffer.byteLength(canonical(raw), 'utf8') > envelopeMaxBytes) return reject('input_bound');
    const input = inputSchema.safeParse(raw);
    if (!input.success) return reject('invalid_input');
    const { candidate, capturedBinding, expectedBinding } = input.data;
    if (
      Buffer.byteLength(canonical(candidate.body), 'utf8') > maxBytes ||
      Buffer.byteLength(canonical(input.data.sourceInput), 'utf8') > maxBytes
    )
      return reject('input_bound');
    if (!same(capturedBinding, expectedBinding)) return reject('context_mismatch');
    const rebuilt = assembleRaceManualReviewCandidate(input.data.sourceInput, ports);
    if (rebuilt.status !== 'assembled') return reject('source_rejected');
    const source = sourceIdentitySchema.parse(input.data.sourceInput);
    if (
      source.athleteId !== expectedBinding.athleteId ||
      !same(source.projectionInput.event, expectedBinding.event)
    )
      return reject('context_mismatch');
    const calculatedDigest = createHash('sha256').update(canonical(candidate.body)).digest('hex');
    if (calculatedDigest !== candidate.digest) return reject('digest_mismatch');
    const body = bodyPartsSchema.safeParse(candidate.body);
    if (!body.success) return reject('candidate_mismatch');
    if (!same(body.data.retainedActualManifest, rebuilt.body.retainedActualManifest))
      return reject('retained_actual_mismatch');
    if (!same(body.data.pinIntents, rebuilt.body.pinIntents)) return reject('pin_mismatch');
    if (!same(body.data.resolution, rebuilt.body.resolution)) return reject('resolution_mismatch');
    if (!same(candidate, rebuilt)) return reject('candidate_mismatch');
    return {
      status: 'consistent' as const,
      candidate: rebuilt,
      readSetDigest: expectedBinding.readSetDigest,
      resolution: rebuilt.body.resolution.requiresResolution
        ? ('requires_resolution' as const)
        : ('resolved' as const),
      sourceCompleteness: 'unverified' as const,
      admissionAllowed: false as const,
    };
  } catch {
    return reject('invalid_input');
  }
}
