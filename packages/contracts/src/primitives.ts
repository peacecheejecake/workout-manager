import { z } from 'zod';

/** Preserve wire values: validate instead of coercing, trimming or supplying defaults. */
export const nonEmptyStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, 'Required text');
export const idSchema = nonEmptyStringSchema.refine(
  (value) => value === value.trim(),
  'ID cannot have surrounding whitespace',
);
export const revisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const positiveIntegerSchema = revisionSchema.min(1);
export const nonNegativeNumberSchema = z.number().finite().nonnegative();
export const localDateSchema = z.iso.date().refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Invalid calendar date');
/** Offset-qualified instants are accepted without losing the original offset. */
export const instantSchema = z.iso
  .datetime({ offset: true })
  .refine((value) => Number.isFinite(Date.parse(value)), 'Invalid instant');
export const localTimeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/, 'Expected HH:mm or HH:mm:ss');
export const timeZoneSchema = nonEmptyStringSchema.refine((value) => {
  if (value.startsWith('+') || value.startsWith('-')) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}, 'Expected a recognized IANA time zone');
export const uniqueIdsSchema = z
  .array(idSchema)
  .refine((ids) => new Set(ids).size === ids.length, 'Duplicate IDs');
export const httpsUrlSchema = z.url({ protocol: /^https$/ });
export type Id = z.infer<typeof idSchema>;
export type LocalDate = z.infer<typeof localDateSchema>;
export type Instant = z.infer<typeof instantSchema>;
