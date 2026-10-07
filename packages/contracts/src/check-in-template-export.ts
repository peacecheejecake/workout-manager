import { z } from 'zod';
import {
  checkInTemplateContentSchema,
  checkInTemplateVersionSchema,
} from './check-in-templates.js';

/** Personal retained facts only; neither installed-profile evidence nor restore authority.
 * These are standalone decoded JSON bounds, not physical SQL JSONB transfer measurements.
 * The account producer must independently enforce its aggregate 8 MiB/SQL row limits. */
export const CHECK_IN_TEMPLATE_EXPORT_MAX_BYTES = 8 * 1024 * 1024;
const uuid = z.uuid().transform((value) => value.toLowerCase());
const revision = z.number().int().min(1).max(2147483646);
const instant = z.iso.datetime({ offset: true });
function boundedJson(maximum: number) {
  return z.unknown().superRefine((raw, ctx) => {
    let bytes = 0,
      nodes = 0;
    const seen = new Set<object>();
    function visit(value: unknown, depth: number): boolean {
      if (depth > 64 || ++nodes > maximum) return false;
      if (typeof value === 'string') {
        if (value.length > maximum) return false;
        bytes += new TextEncoder().encode(value).byteLength;
        return bytes <= maximum;
      }
      if (value === null || typeof value === 'boolean') return true;
      if (typeof value === 'number') return Number.isFinite(value);
      if (typeof value !== 'object' || seen.has(value)) return false;
      const proto: unknown = Object.getPrototypeOf(value);
      if (
        Array.isArray(value)
          ? proto !== Array.prototype
          : proto !== Object.prototype && proto !== null
      )
        return false;
      seen.add(value);
      const keys = Reflect.ownKeys(value);
      if (keys.length > maximum) return false;
      if (Array.isArray(value) && keys.length !== value.length + 1) return false;
      for (const key of keys) {
        if (Array.isArray(value) && key === 'length') continue;
        if (
          Array.isArray(value) &&
          (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)
        )
          return false;
        if (typeof key !== 'string' || key.length > maximum) return false;
        bytes += new TextEncoder().encode(key).byteLength;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          bytes > maximum ||
          !descriptor?.enumerable ||
          !Object.hasOwn(descriptor, 'value') ||
          !visit(descriptor.value, depth + 1)
        )
          return false;
      }
      seen.delete(value);
      return true;
    }
    let valid = false;
    try {
      valid = visit(raw, 0) && new TextEncoder().encode(JSON.stringify(raw)).byteLength <= maximum;
    } catch {
      // Reflection or serialization traps are untrusted input failures, not codec exceptions.
    }
    if (!valid)
      ctx.addIssue({ code: 'custom', message: 'Invalid or oversized plain retained JSON' });
  });
}
// Compare complete fractional instants without dropping PostgreSQL microseconds.
function preciseInstant(value: string): string | null {
  const match = /^(.*:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match?.[1] || !match[3]) return null;
  const seconds = Date.parse(match[1] + match[3]);
  return Number.isSafeInteger(seconds) ? `${seconds}:${(match[2] ?? '').padEnd(6, '0')}` : null;
}
const originalVersion = checkInTemplateVersionSchema.safeExtend({
  content: checkInTemplateContentSchema.safeExtend({
    title: z
      .string()
      .refine((value) => value === value.trim(), 'Retained title must be unchanged')
      .pipe(checkInTemplateContentSchema.shape.title),
    instructions: z
      .string()
      .refine((value) => value === value.trim(), 'Retained instructions must be unchanged')
      .nullable()
      .pipe(checkInTemplateContentSchema.shape.instructions),
  }),
});
export const checkInTemplateExportVersionRowSchema = z
  .strictObject({
    template_id: uuid,
    version_id: uuid,
    version: revision,
    previous_version_id: uuid.nullable(),
    previous_version: revision.nullable(),
    created_at: instant,
    record_json: boundedJson(16384).pipe(originalVersion),
  })
  .superRefine((row, ctx) => {
    const body = row.record_json;
    if (
      row.template_id !== body.templateId ||
      row.version_id !== body.versionId ||
      row.version !== body.version ||
      row.previous_version_id !== body.previousVersionId ||
      row.previous_version !== body.previousVersion ||
      preciseInstant(row.created_at) === null ||
      preciseInstant(row.created_at) !== preciseInstant(body.createdAt)
    )
      ctx.addIssue({ code: 'custom', message: 'Template physical/body tuple mismatch' });
  });
export const checkInTemplateExportHeadRowSchema = z.strictObject({
  template_id: uuid,
  version_id: uuid,
  version: revision,
});
export const checkInTemplateExportFields = {
  checkInTemplateVersions: z.array(checkInTemplateExportVersionRowSchema).max(1000),
  checkInTemplateHeads: z.array(checkInTemplateExportHeadRowSchema).max(1000),
};
type Data = z.infer<z.ZodObject<typeof checkInTemplateExportFields>>;
export function validateCheckInTemplateExportTuples(data: Data, ctx: z.RefinementCtx): void {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  const versions = new Map<string, Data['checkInTemplateVersions'][number]>();
  const numbers = new Set<string>();
  const heads = new Map<string, Data['checkInTemplateHeads'][number]>();
  for (const row of data.checkInTemplateVersions) {
    const tuple = JSON.stringify([row.template_id, row.version]);
    if (versions.has(row.version_id) || numbers.has(tuple)) fail('Duplicate template version');
    versions.set(row.version_id, row);
    numbers.add(tuple);
  }
  for (const head of data.checkInTemplateHeads) {
    if (heads.has(head.template_id)) fail('Duplicate template head');
    heads.set(head.template_id, head);
    const row = versions.get(head.version_id);
    if (!row || row.template_id !== head.template_id || row.version !== head.version)
      fail('Template head requires its exact version');
  }
  for (const row of data.checkInTemplateVersions) {
    const head = heads.get(row.template_id);
    if (!head || head.version < row.version) fail('Missing or older template head');
    if (row.previous_version_id !== null) {
      const previous = versions.get(row.previous_version_id);
      if (
        !previous ||
        previous.template_id !== row.template_id ||
        previous.version !== row.previous_version ||
        previous.version !== row.version - 1
      )
        fail('Missing or foreign exact previous template version');
    }
  }
}
/** Both required collections may genuinely be empty. Missing/unsupported profiles
 * must be handled by the producer, never converted to fabricated empty arrays here. */
export const checkInTemplateExportDataSchema = boundedJson(CHECK_IN_TEMPLATE_EXPORT_MAX_BYTES).pipe(
  z.strictObject(checkInTemplateExportFields).superRefine(validateCheckInTemplateExportTuples),
);
export type CheckInTemplateExportData = z.infer<typeof checkInTemplateExportDataSchema>;
