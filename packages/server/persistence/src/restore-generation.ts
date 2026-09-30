import { restoreGenerationResponseSchema } from '@workout/contracts/restore-generation';
import type { Database, Transaction } from './database.js';

export class StaleRestoreGenerationError extends Error {
  readonly code = 'STALE_RESTORE_GENERATION';
  constructor() {
    super('STALE_RESTORE_GENERATION');
  }
}

export async function currentRestoreGeneration(tx: Transaction): Promise<string> {
  const result = await tx.query('SELECT public.current_restore_generation() AS generation_id');
  return restoreGenerationResponseSchema.parse({ generationId: result.rows[0]?.['generation_id'] })
    .generationId;
}

export async function requireCurrentRestoreGeneration(
  tx: Transaction,
  requestedGeneration: string,
): Promise<void> {
  if ((await currentRestoreGeneration(tx)) !== requestedGeneration)
    throw new StaleRestoreGenerationError();
}

export interface RestoreGenerationRepository {
  read(athleteId: string): Promise<{ generationId: string }>;
}

export function createRestoreGenerationRepository(database: Database): RestoreGenerationRepository {
  return {
    read: (athleteId) =>
      database.tenant(athleteId, async (tx) => ({
        generationId: await currentRestoreGeneration(tx),
      })),
  };
}
