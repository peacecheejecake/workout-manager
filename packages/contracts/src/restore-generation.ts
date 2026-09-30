import { z } from 'zod';

export const restoreGenerationSchema = z.uuid().transform((value) => value.toLowerCase());
export const restoreGenerationResponseSchema = z.strictObject({
  generationId: restoreGenerationSchema,
});
export type RestoreGenerationResponse = z.infer<typeof restoreGenerationResponseSchema>;
