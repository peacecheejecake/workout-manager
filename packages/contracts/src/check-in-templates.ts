import { z } from 'zod';
import { checkInDefinition } from './check-ins.js';
import { instantSchema } from './primitives.js';

const revision = z.number().int().min(1).max(2147483646);
const uuid = z.uuid().transform((value) => value.toLowerCase());
const key = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
export const checkInTemplateFieldSchema = z.enum(['fatigue', 'discomfort', 'bodyLocation', 'note']);
/** Reusable report prompts, distinct from dated CheckIn observations. */
export const checkInTemplateContentSchema = z.strictObject({
  definitionVersion: z.literal(checkInDefinition.version),
  source: z.literal(checkInDefinition.source),
  method: z.literal(checkInDefinition.method),
  title: z.string().trim().min(1).max(200),
  instructions: z.string().trim().min(1).max(2000).nullable(),
  fields: z
    .array(checkInTemplateFieldSchema)
    .min(1)
    .max(4)
    .refine((fields) => new Set(fields).size === fields.length, 'Duplicate report fields'),
});
export const saveCheckInTemplateSchema = z.strictObject({
  idempotencyKey: key,
  templateId: uuid,
  expectedVersion: z.number().int().min(0).max(2147483645),
  content: checkInTemplateContentSchema,
});
export const checkInTemplateVersionSchema = z
  .strictObject({
    templateId: uuid,
    versionId: uuid,
    version: revision,
    previousVersionId: uuid.nullable(),
    previousVersion: revision.nullable(),
    createdAt: instantSchema,
    content: checkInTemplateContentSchema,
  })
  .refine(
    (value) =>
      value.version === 1
        ? value.previousVersionId === null && value.previousVersion === null
        : value.previousVersionId !== null &&
          value.previousVersionId !== value.versionId &&
          value.previousVersion === value.version - 1,
    'Expected an exact previous immutable version',
  );

export type CheckInTemplateField = z.infer<typeof checkInTemplateFieldSchema>;
export type CheckInTemplateContent = z.infer<typeof checkInTemplateContentSchema>;
export type SaveCheckInTemplate = z.infer<typeof saveCheckInTemplateSchema>;
export type CheckInTemplateVersion = z.infer<typeof checkInTemplateVersionSchema>;
