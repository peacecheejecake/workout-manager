import { z } from 'zod';

/** Injected repository availability only; no write, source or approval authority. */
export const raceResultCapabilitiesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  legacyResults: z.boolean(),
  proofResultsV2: z.boolean(),
});
export type RaceResultCapabilities = z.infer<typeof raceResultCapabilitiesSchema>;
