import { z } from 'zod';
import type { Transaction } from './database.js';
import {
  raceImpactConsumedCaptureSchema,
  raceImpactConsumedScopeSchema,
} from './race-plan-impact-complete-manifest.js';
import { requireFreshRaceManualBasis } from './race-plan-impact-manual-basis.js';
import { requireCurrentRestoreGeneration } from './restore-generation.js';

// A finite projection of actual server capture. It is neither a full-manifest
// validator nor a public client-supplied evidence/admission credential.
export const raceManualReviewCurrentBindingCaptureV2Schema = raceImpactConsumedCaptureSchema.pick({
  athleteId: true,
  restoreGeneration: true,
  event: true,
  manualBasis: true,
  readSetDigest: true,
});
const policy = raceImpactConsumedScopeSchema.shape.expectedPolicy;
export const raceManualReviewCurrentBindingV2Schema = z.strictObject({
  status: z.literal('current_manual_basis_checked'),
  purpose: z.literal('manual_race_date_change'),
  appRevision: raceImpactConsumedScopeSchema.shape.expectedAppRevision,
  policy,
  restoreGeneration: raceImpactConsumedScopeSchema.shape.restoreGeneration,
  sourceAuthentication: z.literal('unverified'),
  permissionAuthority: z.literal('none'),
  authority: z.literal('none'),
  freshness: z.literal('not_checked'),
  storage: z.literal('not_persisted'),
  admissionAllowed: z.literal(false),
  approvalAllowed: z.literal(false),
});
export type RaceManualReviewCurrentBindingV2 = z.infer<
  typeof raceManualReviewCurrentBindingV2Schema
>;
export class RaceManualReviewCurrentBindingV2Error extends Error {
  constructor(
    readonly code: 'INVALID_MANUAL_BINDING' | 'MANUAL_SCOPE_MISMATCH' | 'MANUAL_BASIS_UNAVAILABLE',
  ) {
    super(code);
  }
}
// Guard unknown projections before Zod can inspect properties. The limit is
// local decoded JSON, not an assertion about physical database response bytes.
function boundedPlainJSON(value: unknown): boolean {
  const active = new WeakSet<object>();
  let visits = 0;
  function visit(v: unknown, depth: number): boolean {
    if (++visits > 4194305 || depth > 64) return false;
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
    if (typeof v === 'number') return Number.isFinite(v);
    if (typeof v !== 'object' || active.has(v)) return false;
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype) return false;
    if (Object.getOwnPropertySymbols(v).length !== 0) return false;
    const descriptors = Object.getOwnPropertyDescriptors(v);
    if (
      Array.isArray(v) &&
      (Object.keys(v).length !== v.length || Object.getOwnPropertyNames(v).length !== v.length + 1)
    )
      return false;
    active.add(v);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(v) && key === 'length') continue;
      if (
        descriptor.get ||
        descriptor.set ||
        !descriptor.enumerable ||
        !visit(descriptor.value, depth + 1)
      )
        return false;
    }
    active.delete(v);
    return true;
  }
  try {
    if (!visit(value, 0)) return false;
    const json = JSON.stringify(value);
    return json !== undefined && Buffer.byteLength(json, 'utf8') <= 4 * 1024 * 1024;
  } catch {
    return false;
  }
}
const sameUUID = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** Read-only processing gate in the caller's actual fenced transaction. No receipt
 * is created here; a later writer must return its successful receipt first. The
 * capture/scope comes from server preparation, never a caller permission boolean.
 * Current app/policy checking does not close full permission, semantic freshness,
 * immutable stored evidence binding, lifecycle, storage or atomic approval. */
export async function requireCurrentRaceManualReviewBindingV2In(
  tx: Transaction,
  unknownCapture: unknown,
  unknownScope: unknown,
): Promise<RaceManualReviewCurrentBindingV2> {
  if (!boundedPlainJSON(unknownCapture) || !boundedPlainJSON(unknownScope))
    throw new RaceManualReviewCurrentBindingV2Error('INVALID_MANUAL_BINDING');
  const capture = raceManualReviewCurrentBindingCaptureV2Schema.safeParse(unknownCapture);
  const scope = raceImpactConsumedScopeSchema.safeParse(unknownScope);
  if (!capture.success || !scope.success)
    throw new RaceManualReviewCurrentBindingV2Error('INVALID_MANUAL_BINDING');
  const c = capture.data,
    s = scope.data;
  if (
    c.athleteId !== tx.athleteId ||
    s.athleteId !== tx.athleteId ||
    !sameUUID(c.restoreGeneration, s.restoreGeneration) ||
    !sameUUID(c.event.id, s.expectedEvent.id) ||
    c.event.revision !== s.expectedEvent.revision ||
    c.manualBasis.purpose !== s.purpose ||
    c.manualBasis.policy.id !== s.expectedPolicy.id ||
    c.manualBasis.policy.version !== s.expectedPolicy.version ||
    c.manualBasis.policy.digest !== s.expectedPolicy.digest ||
    c.readSetDigest !== s.expectedReadSetDigest
  )
    throw new RaceManualReviewCurrentBindingV2Error('MANUAL_SCOPE_MISMATCH');
  if (c.manualBasis.app.state !== 'present' || !c.manualBasis.app.granted)
    throw new RaceManualReviewCurrentBindingV2Error('MANUAL_BASIS_UNAVAILABLE');
  if (c.manualBasis.app.revision !== s.expectedAppRevision)
    throw new RaceManualReviewCurrentBindingV2Error('MANUAL_SCOPE_MISMATCH');
  // Existing fixed policy and actual current app row under tenant0. Do not change
  // AI/provider/media policies or treat their unused metadata as manual permission.
  await requireFreshRaceManualBasis(tx, c.manualBasis);
  await requireCurrentRestoreGeneration(tx, c.restoreGeneration.toLowerCase());
  return raceManualReviewCurrentBindingV2Schema.parse({
    status: 'current_manual_basis_checked',
    purpose: s.purpose,
    appRevision: s.expectedAppRevision,
    policy: s.expectedPolicy,
    restoreGeneration: c.restoreGeneration,
    sourceAuthentication: 'unverified',
    permissionAuthority: 'none',
    authority: 'none',
    freshness: 'not_checked',
    storage: 'not_persisted',
    admissionAllowed: false,
    approvalAllowed: false,
  });
}
