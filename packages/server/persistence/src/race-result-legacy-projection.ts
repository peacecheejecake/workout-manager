import { z } from 'zod';
import { raceCommandResultSchema } from '@workout/contracts/race-commands';
import {
  RACE_RESULT_V2_MAX_BYTES,
  raceResultCompatibleReadSchema,
  raceResultCompatibleStorageLifecycleSchema,
  type RaceResultCompatibleRead,
  type RaceResultCompatibleStorageLifecycle,
} from '@workout/contracts/race-result-v2';
import { raceResultSchema, type RaceResult } from '@workout/contracts/races';

// SQL098 bounds the stored values body, not its relational identity envelope.
const LEGACY_ROW_MAX_BYTES = RACE_RESULT_V2_MAX_BYTES + 256;

export class RaceResultLegacyProjectionError extends Error {
  readonly code = 'INVALID_RACE_RESULT_LEGACY_PROJECTION';
  constructor() {
    super('INVALID_RACE_RESULT_LEGACY_PROJECTION');
  }
}

/** Explicit legacy HTTP wire projection, NOT a stored schema migration, source
 * permission proof or official verification. Caller obtains an owned record via
 * its authenticated repository. This pure function cannot establish ownership.
 * V1 historical facts are preserved. V2 proof metadata is omitted, and its
 * reported official source never manufactures a legacy verification timestamp.
 */
export function projectRaceResultLegacyRead(raw: unknown): RaceResult {
  try {
    const encoded = JSON.stringify(raw);
    if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > LEGACY_ROW_MAX_BYTES)
      throw new RaceResultLegacyProjectionError();
    const record = raceResultCompatibleReadSchema.parse(raw);
    return legacyWire(record);
  } catch {
    throw new RaceResultLegacyProjectionError();
  }
}

function legacyWire(
  record: RaceResultCompatibleRead | RaceResultCompatibleStorageLifecycle,
): RaceResult {
  if (!('schemaVersion' in record)) return record;
  const { schemaVersion: _schemaVersion, proofs: _proofs, source, ...actual } = record;
  return raceResultSchema.parse({
    ...actual,
    source: source.kind === 'official' ? { ...source, verifiedAt: null } : source,
  });
}
const storedRow = z.strictObject({
  id: z.uuid().refine((value) => value === value.toLowerCase()),
  revision: raceCommandResultSchema.shape.revision,
  values: z.record(z.string(), z.unknown()),
});
/** Separate relational storage boundary. The caller supplies an owned original
 * row tuple; this does NOT establish tenant ownership or source authenticity.
 * Descriptor lifecycle is validated as stored, never fabricated as available.
 * Identity aliases in values are rejected rather than overridden by row fields.
 * No stored schema is mutated or migrated by this legacy wire projection.
 */
export function projectStoredRaceResultLegacyRead(raw: unknown): RaceResult {
  try {
    const encoded = JSON.stringify(raw);
    if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > LEGACY_ROW_MAX_BYTES)
      throw new RaceResultLegacyProjectionError();
    const row = storedRow.parse(raw);
    if (Buffer.byteLength(JSON.stringify(row.values), 'utf8') > RACE_RESULT_V2_MAX_BYTES)
      throw new RaceResultLegacyProjectionError();
    if ('id' in row.values || 'revision' in row.values) throw new RaceResultLegacyProjectionError();
    const record = raceResultCompatibleStorageLifecycleSchema.parse({
      ...row.values,
      id: row.id,
      revision: row.revision,
    });
    return legacyWire(record);
  } catch {
    throw new RaceResultLegacyProjectionError();
  }
}
