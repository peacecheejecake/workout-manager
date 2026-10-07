import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  saveCheckInTemplateSchema,
  checkInTemplateVersionSchema,
  type CheckInTemplateVersion,
} from '@workout/contracts/check-in-templates';
import type { Database, Transaction } from './database.js';

const maximumBytes = 4 * 1024 * 1024;
const uuid = z.uuid().transform((value) => value.toLowerCase());
const listQuery = z.strictObject({
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().min(0).max(10000),
});
export class CheckInTemplateError extends Error {
  constructor(
    readonly code:
      | 'CHECK_IN_TEMPLATE_BOUND'
      | 'CHECK_IN_TEMPLATE_INVALID_RESPONSE'
      | 'CHECK_IN_TEMPLATE_VERSION_CONFLICT'
      | 'IDEMPOTENCY_CONFLICT'
      | 'APP_CONSENT_REQUIRED',
  ) {
    super(code);
  }
}
/** Plain JSON before schema decoding: never invoke caller accessors. */
function plain(value: unknown) {
  let bytes = 0,
    visits = 0;
  const seen = new Set<object>();
  const add = (text: string) => {
    bytes += Buffer.byteLength(text);
    if (bytes > maximumBytes) throw new CheckInTemplateError('CHECK_IN_TEMPLATE_BOUND');
  };
  const walk = (item: unknown, depth: number): void => {
    if (++visits > 20000 || depth > 16) throw new CheckInTemplateError('CHECK_IN_TEMPLATE_BOUND');
    if (typeof item === 'string') {
      add(item);
      return;
    }
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || seen.has(item))
      throw new CheckInTemplateError('CHECK_IN_TEMPLATE_BOUND');
    const prototype = Object.getPrototypeOf(item);
    if (Array.isArray(item) && (prototype !== Array.prototype || item.length > 20000))
      throw new CheckInTemplateError('CHECK_IN_TEMPLATE_BOUND');
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null)
      throw new CheckInTemplateError('CHECK_IN_TEMPLATE_BOUND');
    seen.add(item);
    let entries = 0;
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === 'length') continue;
      if (typeof key !== 'string') throw new CheckInTemplateError('CHECK_IN_TEMPLATE_BOUND');
      if (Array.isArray(item) && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length))
        throw new CheckInTemplateError('CHECK_IN_TEMPLATE_BOUND');
      entries++;
      add(key);
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
        throw new CheckInTemplateError('CHECK_IN_TEMPLATE_BOUND');
      walk(descriptor.value, depth + 1);
    }
    if (Array.isArray(item) && entries !== item.length)
      throw new CheckInTemplateError('CHECK_IN_TEMPLATE_BOUND');
    seen.delete(item);
  };
  walk(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > maximumBytes)
    throw new CheckInTemplateError('CHECK_IN_TEMPLATE_BOUND');
}
const sqlFailure = z.object({
  message: z.enum([
    'CHECKIN_TEMPLATE_STALE_VERSION',
    'CHECKIN_TEMPLATE_VERSION_CONFLICT',
    'CHECKIN_TEMPLATE_IDEMPOTENCY_CONFLICT',
    'APP_CONSENT_REQUIRED',
  ]),
});
async function query(tx: Transaction, sql: string, values: unknown[]) {
  try {
    return await tx.query(sql, values);
  } catch (error) {
    const known = sqlFailure.safeParse(error);
    if (error instanceof Error && known.success)
      throw new CheckInTemplateError(
        known.data.message === 'APP_CONSENT_REQUIRED'
          ? 'APP_CONSENT_REQUIRED'
          : known.data.message === 'CHECKIN_TEMPLATE_IDEMPOTENCY_CONFLICT'
            ? 'IDEMPOTENCY_CONFLICT'
            : 'CHECK_IN_TEMPLATE_VERSION_CONFLICT',
      );
    throw error;
  }
}
function version(raw: unknown): CheckInTemplateVersion {
  plain(raw);
  const result = checkInTemplateVersionSchema.safeParse(raw);
  if (!result.success) throw new CheckInTemplateError('CHECK_IN_TEMPLATE_INVALID_RESPONSE');
  return result.data;
}
const response = z.strictObject({
  bytes: z.string().regex(/^(0|[1-9][0-9]*)$/),
  value: z.unknown(),
});
function boundedResponse(rows: Record<string, unknown>[]) {
  if (rows.length !== 1) throw new CheckInTemplateError('CHECK_IN_TEMPLATE_INVALID_RESPONSE');
  const parsed = response.safeParse(rows[0]);
  if (!parsed.success) throw new CheckInTemplateError('CHECK_IN_TEMPLATE_INVALID_RESPONSE');
  const row = parsed.data;
  if (BigInt(row.bytes) > BigInt(maximumBytes))
    throw new CheckInTemplateError('CHECK_IN_TEMPLATE_BOUND');
  plain(row.value);
  return row.value;
}
async function call(tx: Transaction, expression: string, values: unknown[]) {
  return boundedResponse(
    (
      await query(
        tx,
        `WITH result AS MATERIALIZED (SELECT ${expression} AS value), sized AS (SELECT value,octet_length(coalesce(value::text,'null')) AS bytes FROM result) SELECT bytes::text,CASE WHEN bytes<=4194304 THEN value ELSE NULL END AS value FROM sized`,
        values,
      )
    ).rows,
  );
}
export interface CheckInTemplateRepository {
  save(athleteId: string, input: unknown): Promise<CheckInTemplateVersion>;
  readExact(
    athleteId: string,
    templateId: string,
    versionId: string,
  ): Promise<CheckInTemplateVersion | null>;
  readHead(athleteId: string, templateId: string): Promise<CheckInTemplateVersion | null>;
  list(athleteId: string, input: unknown): Promise<{ items: CheckInTemplateVersion[] }>;
}
export function createCheckInTemplateRepository(
  database: Database,
  options: { now?: () => Date; createId?: () => string } = {},
): CheckInTemplateRepository {
  const now = options.now ?? (() => new Date()),
    createId = options.createId ?? randomUUID;
  return {
    async save(athleteId, raw) {
      plain(raw);
      const command = saveCheckInTemplateSchema.parse(raw);
      return database.tenant(athleteId, async (tx) => {
        // SQL handles receipt-first, excluding these generated facts from the
        // stable request digest. A successful retry may return an older ID/time.
        const versionId = uuid.parse(createId()),
          createdAt = z.iso.datetime({ offset: true }).parse(now().toISOString());
        const saved = version(
          await call(tx, 'public.save_check_in_template_v1($1::jsonb)', [
            JSON.stringify({ ...command, versionId, createdAt }),
          ]),
        );
        if (
          saved.templateId !== command.templateId ||
          saved.version !== command.expectedVersion + 1 ||
          JSON.stringify(saved.content) !== JSON.stringify(command.content)
        )
          throw new CheckInTemplateError('CHECK_IN_TEMPLATE_INVALID_RESPONSE');
        return saved;
      });
    },
    async readExact(athleteId, rawTemplate, rawVersion) {
      const templateId = uuid.parse(rawTemplate),
        versionId = uuid.parse(rawVersion);
      return database.tenant(athleteId, async (tx) => {
        const raw = await call(tx, 'public.read_check_in_template_version_v1($1::uuid,$2::uuid)', [
          templateId,
          versionId,
        ]);
        if (raw === null) return null;
        const saved = version(raw);
        if (saved.templateId !== templateId || saved.versionId !== versionId)
          throw new CheckInTemplateError('CHECK_IN_TEMPLATE_INVALID_RESPONSE');
        return saved;
      });
    },
    async readHead(athleteId, rawTemplate) {
      const templateId = uuid.parse(rawTemplate);
      return database.tenant(athleteId, async (tx) => {
        const raw = await call(tx, 'public.read_check_in_template_head_v1($1::uuid)', [templateId]);
        if (raw === null) return null;
        const saved = version(raw);
        if (saved.templateId !== templateId)
          throw new CheckInTemplateError('CHECK_IN_TEMPLATE_INVALID_RESPONSE');
        return saved;
      });
    },
    async list(athleteId, raw) {
      plain(raw);
      const input = listQuery.parse(raw);
      return database.tenant(athleteId, async (tx) => {
        const decoded = await call(
          tx,
          'public.list_check_in_template_heads_v1($1::integer,$2::integer)',
          [input.limit, input.offset],
        );
        const parsed = z.array(checkInTemplateVersionSchema).max(input.limit).safeParse(decoded);
        if (!parsed.success) throw new CheckInTemplateError('CHECK_IN_TEMPLATE_INVALID_RESPONSE');
        const items = parsed.data;
        for (let i = 0; i < items.length; i++) {
          const item = items[i],
            prior = items[i - 1];
          if (!item || (prior && prior.templateId >= item.templateId))
            throw new CheckInTemplateError('CHECK_IN_TEMPLATE_INVALID_RESPONSE');
        }
        return { items };
      });
    },
  };
}
