import { z } from 'zod';
import { raceResultSchema, type RaceResult } from '@workout/contracts/races';
import { raceCommandResultSchema, raceResultValuesSchema } from '@workout/contracts/race-commands';
import {
  raceResultCompatibleStorageLifecycleSchema,
  raceResultStorageLifecycleV2Schema,
  type RaceResultStorageLifecycleV2,
} from '@workout/contracts/race-result-v2';
const intentSchema = z.strictObject({
  prior: z.strictObject({
    id: z.uuid().refine((value) => value === value.toLowerCase()),
    revision: raceCommandResultSchema.shape.revision,
    values: z.record(z.string(), z.unknown()),
  }),
  nextValues: raceResultValuesSchema,
  nextRevision: raceCommandResultSchema.shape.revision,
});
export class RaceResultLegacyUpdateError extends Error {
  readonly code = 'INVALID_RACE_RESULT_LEGACY_SUCCESSOR';
  constructor() {
    super('INVALID_RACE_RESULT_LEGACY_SUCCESSOR');
  }
}
/** Pure shaping after caller's own live-head FOR UPDATE/CAS and reference checks.
 * This does NOT authorize copied descriptors/unavailable facts: successor SQL
 * must prove exact prior correspondence and source suppression in the same Tx.
 * No fresh proof resolution, latest repinning, V1 promotion or read-status copy.
 */
export function buildRaceResultLegacySuccessor(
  raw: unknown,
): RaceResult | RaceResultStorageLifecycleV2 {
  try {
    const json = JSON.stringify(raw);
    if (json === undefined || Buffer.byteLength(json, 'utf8') > 2 * 16384 + 512) throw new Error();
    const { prior, nextValues, nextRevision } = intentSchema.parse(raw);
    if (
      nextRevision !== prior.revision + 1 ||
      'id' in prior.values ||
      'revision' in prior.values ||
      Buffer.byteLength(JSON.stringify(prior.values), 'utf8') > 16384
    )
      throw new Error();
    const previous = raceResultCompatibleStorageLifecycleSchema.parse({
      ...prior.values,
      id: prior.id,
      revision: prior.revision,
    });
    if ('schemaVersion' in previous)
      return raceResultStorageLifecycleV2Schema.parse({
        ...nextValues,
        schemaVersion: 2,
        id: prior.id,
        revision: nextRevision,
        proofs: previous.proofs,
      });
    return raceResultSchema.parse({
      ...nextValues,
      id: prior.id,
      revision: nextRevision,
      source:
        nextValues.source.kind === 'official'
          ? { ...nextValues.source, verifiedAt: null }
          : nextValues.source,
    });
  } catch {
    throw new RaceResultLegacyUpdateError();
  }
}
