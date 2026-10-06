import { z } from 'zod';
import {
  raceEventSchema,
  raceResultSchema,
  raceResultSourceSchema,
  trainingBestSchema,
} from './races.js';

const key = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
// Match existing PostgreSQL-backed command revisions; the next revision must fit int4.
const expectedRevision = z.number().int().min(1).max(2147483646);

/** An official claim is user input. Only server review can supply verifiedAt. */
export const raceResultSourceInputSchema = z.discriminatedUnion('kind', [
  raceResultSourceSchema.options[0].omit({ verifiedAt: true }),
  raceResultSourceSchema.options[1],
  raceResultSourceSchema.options[2],
]);

/** Full replacement values preserve explicit nulls and immutable Course revision references.
 * Saving an event does not update its linked Plan. Date-change impact preview and approval
 * belong to a separate application use case, not this storage command.
 */
export const raceEventValuesSchema = raceEventSchema.omit({ id: true, revision: true });
export const raceResultValuesSchema = raceResultSchema
  .omit({ id: true, revision: true })
  .extend({ source: raceResultSourceInputSchema });
export const trainingBestValuesSchema = trainingBestSchema.omit({ id: true, revision: true });

/** IDs/revisions are allocated by the server; athlete ownership comes from authentication. */
export const raceEventCreateCommandSchema = z.strictObject({
  idempotencyKey: key,
  values: raceEventValuesSchema,
});
export const raceEventUpdateCommandSchema = z.strictObject({
  idempotencyKey: key,
  expectedRevision,
  values: raceEventValuesSchema,
});
export const raceEventReadCommandSchema = z.strictObject({ id: raceEventSchema.shape.id });
export const raceEventReadSchema = raceEventSchema;

export const raceResultCreateCommandSchema = z.strictObject({
  idempotencyKey: key,
  values: raceResultValuesSchema,
});
export const raceResultUpdateCommandSchema = z.strictObject({
  idempotencyKey: key,
  expectedRevision,
  values: raceResultValuesSchema,
});
export const raceResultReadCommandSchema = z.strictObject({ id: raceResultSchema.shape.id });
/** Reads expose the server-owned verification fact without making it writable. */
export const raceResultReadSchema = raceResultSchema;

export const trainingBestCreateCommandSchema = z.strictObject({
  idempotencyKey: key,
  values: trainingBestValuesSchema,
});
export const trainingBestUpdateCommandSchema = z.strictObject({
  idempotencyKey: key,
  expectedRevision,
  values: trainingBestValuesSchema,
});
export const trainingBestReadCommandSchema = z.strictObject({ id: trainingBestSchema.shape.id });
export const trainingBestReadSchema = trainingBestSchema;

/** Minimal successful receipt: fetch current values through the read boundary.
 * This avoids keeping health values or official URLs in idempotency receipts.
 */
export const raceCommandResultSchema = z.strictObject({
  id: raceEventSchema.shape.id,
  revision: expectedRevision,
});

export type RaceResultSourceInput = z.infer<typeof raceResultSourceInputSchema>;
export type RaceEventValues = z.infer<typeof raceEventValuesSchema>;
export type RaceResultValues = z.infer<typeof raceResultValuesSchema>;
export type TrainingBestValues = z.infer<typeof trainingBestValuesSchema>;
export type RaceEventCreateCommand = z.infer<typeof raceEventCreateCommandSchema>;
export type RaceEventUpdateCommand = z.infer<typeof raceEventUpdateCommandSchema>;
export type RaceEventReadCommand = z.infer<typeof raceEventReadCommandSchema>;
export type RaceEventRead = z.infer<typeof raceEventReadSchema>;
export type RaceResultCreateCommand = z.infer<typeof raceResultCreateCommandSchema>;
export type RaceResultUpdateCommand = z.infer<typeof raceResultUpdateCommandSchema>;
export type RaceResultReadCommand = z.infer<typeof raceResultReadCommandSchema>;
export type RaceResultRead = z.infer<typeof raceResultReadSchema>;
export type TrainingBestCreateCommand = z.infer<typeof trainingBestCreateCommandSchema>;
export type TrainingBestUpdateCommand = z.infer<typeof trainingBestUpdateCommandSchema>;
export type TrainingBestReadCommand = z.infer<typeof trainingBestReadCommandSchema>;
export type TrainingBestRead = z.infer<typeof trainingBestReadSchema>;
export type RaceCommandResult = z.infer<typeof raceCommandResultSchema>;
