import {
  AiSettingsRepositoryError,
  type AiSettingsRepository,
} from '@workout/server-persistence/ai-settings';
import { AiSettingsServiceError, type AiSettingsService } from './ai-settings-routes.js';

async function execute<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AiSettingsRepositoryError) throw new AiSettingsServiceError(error.code);
    throw error;
  }
}

/** Composition only: preference operations never authorize or enqueue AI execution. */
export function createAiSettingsService(repository: AiSettingsRepository): AiSettingsService {
  return {
    catalog: (athleteId) => execute(() => repository.catalog(athleteId)),
    read: (athleteId) => execute(() => repository.read(athleteId)),
    write: (athleteId, command) => execute(() => repository.write(athleteId, command)),
  };
}
