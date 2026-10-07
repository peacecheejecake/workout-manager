import { raceManualPublicPrepareSchema } from '@workout/contracts/race-manual-public';
import { raceManualPublicImpactSchema } from '@workout/contracts/race-manual-public-impact';

export class RaceManualImpactResolutionError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'IMPACT_MISMATCH' | 'RESOLUTION_MISMATCH') {
    super(code);
    this.name = 'RaceManualImpactResolutionError';
  }
}
/** JSON input only. Inspect descriptors without invoking getters before schema traversal. */
function plain(raw: unknown): void {
  const active = new Set<object>();
  let bytes = 0,
    visits = 0;
  function charge(text: string) {
    if (text.length > 4194304 - bytes) throw Error('bound');
    bytes += new TextEncoder().encode(text).byteLength;
    if (bytes > 4194304) throw Error('bound');
  }
  function walk(value: unknown, depth: number): void {
    if (++visits > 50000 || depth > 64) throw Error('bound');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'string') {
      charge(value);
      return;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value !== 'object' || active.has(value)) throw Error('plain');
    const array = Array.isArray(value);
    if (
      array
        ? Object.getPrototypeOf(value) !== Array.prototype
        : ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
      throw Error('plain');
    const keys = Reflect.ownKeys(value);
    if (keys.length > 50001) throw Error('bound');
    active.add(value);
    let count = 0;
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') throw Error('plain');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) throw Error('plain');
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))
        throw Error('dense');
      charge(key);
      count++;
      walk(descriptor.value, depth + 1);
    }
    if (array && count !== value.length) throw Error('dense');
    active.delete(value);
  }
  try {
    walk(raw, 0);
    if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > 4194304) throw Error('bound');
  } catch {
    throw new RaceManualImpactResolutionError('INVALID_INPUT');
  }
}
const uuidKey = (id: string) => id.toLowerCase();
/** Builds user input for another fresh diagnostic/review. It does not resolve
 * timing itself, confirm recovery, reconnect a deleted race or authorize approval. */
export function prepareRaceManualImpactResolutions(
  unknownPrepare: unknown,
  unknownImpact: unknown,
  unknownResolutions: unknown,
) {
  plain(unknownPrepare);
  plain(unknownResolutions);
  const input = raceManualPublicPrepareSchema.safeParse(unknownPrepare);
  const impact = raceManualPublicImpactSchema.safeParse(unknownImpact);
  if (!input.success || !impact.success) throw new RaceManualImpactResolutionError('INVALID_INPUT');
  if (impact.data.status !== 'projected')
    throw new RaceManualImpactResolutionError('IMPACT_MISMATCH');
  const initial = input.data.intent,
    observed = impact.data;
  if (
    uuidKey(initial.expectedEvent.id) !== observed.expectedEvent.id ||
    initial.expectedEvent.revision !== observed.expectedEvent.revision ||
    initial.newLocalDate !== observed.intent.newLocalDate ||
    JSON.stringify(initial.selection) !== JSON.stringify(observed.intent.selection) ||
    JSON.stringify(initial.resolutions) !== JSON.stringify(observed.intent.resolutions)
  )
    throw new RaceManualImpactResolutionError('IMPACT_MISMATCH');
  const next = raceManualPublicPrepareSchema.safeParse({
    ...input.data,
    intent: { ...initial, resolutions: unknownResolutions },
  });
  if (!next.success) throw new RaceManualImpactResolutionError('INVALID_INPUT');
  plain(next.data); // The assembled outgoing command retains the same independent ingress cap.
  const used = new Set<string>();
  for (const resolution of next.data.intent.resolutions.nutrition) {
    const key = JSON.stringify(['nutrition', uuidKey(resolution.planVersionId), resolution.itemId]);
    if (
      used.has(key) ||
      !observed.resolutionRequirements.some(
        (r) =>
          r.domain === 'nutrition' &&
          uuidKey(r.planVersionId) === uuidKey(resolution.planVersionId) &&
          r.itemId === resolution.itemId,
      )
    )
      throw new RaceManualImpactResolutionError('RESOLUTION_MISMATCH');
    used.add(key);
  }
  for (const resolution of next.data.intent.resolutions.routines) {
    const key = JSON.stringify(['routine_schedule', resolution.scheduleVersionId]);
    if (
      used.has(key) ||
      !observed.resolutionRequirements.some(
        (r) =>
          r.domain === 'routine_schedule' &&
          r.editor === 'replace_rule' &&
          r.scheduleVersionId === resolution.scheduleVersionId,
      )
    )
      throw new RaceManualImpactResolutionError('RESOLUTION_MISMATCH');
    used.add(key);
  }
  const outstanding = observed.resolutionRequirements.filter((r) => {
    if (r.domain === 'nutrition')
      return !used.has(JSON.stringify(['nutrition', uuidKey(r.planVersionId), r.itemId]));
    if (r.domain === 'routine_schedule')
      return !used.has(JSON.stringify(['routine_schedule', r.scheduleVersionId]));
    return true; // Recovery confirmation requires its genuine separate public producer.
  });
  return {
    status: 'input_prepared' as const,
    prepare: next.data,
    outstandingRequirements: outstanding,
    replacementValidation: 'structure_and_frozen_reference_only' as const,
    timingResolution: 'not_checked' as const,
    approvalAllowed: false as const,
    persistence: 'not_stored' as const,
    freshness: 'not_checked' as const,
  };
}
