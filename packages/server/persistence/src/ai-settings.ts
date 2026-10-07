// Preference storage only; saving does not grant consent or dispatch a provider.
// Requires the catalog/preferences schema. Migration registration, authenticated
// restore and production composition are separate integration gates.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  aiExecutionCatalogV1Schema,
  aiSettingsV1Schema,
  aiSettingsWriteV1Schema,
  validateAiCatalogExposureV1,
  validateAiSettingsChoicesV1,
  type AiExecutionCatalogV1,
  type AiSettingsV1,
  type AiSettingsWriteV1,
} from '@workout/contracts/ai-settings';
import type { Database, Transaction } from './database.js';

export type AiSettingsRepositoryErrorCode =
  | 'REVISION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'STALE_CATALOG'
  | 'STALE_POLICY'
  | 'STALE_DISCLOSURE'
  | 'DEFAULT_NOT_SELECTABLE'
  | 'COMPARISON_NOT_SELECTABLE'
  | 'UNAVAILABLE';
export class AiSettingsRepositoryError extends Error {
  constructor(readonly code: AiSettingsRepositoryErrorCode) {
    super(code);
    this.name = 'AiSettingsRepositoryError';
  }
}
export interface AiSettingsRepository {
  catalog(athleteId: string): Promise<AiExecutionCatalogV1>;
  read(athleteId: string): Promise<AiSettingsV1>;
  write(athleteId: string, input: unknown): Promise<AiSettingsV1>;
}
const rowSchema = z.strictObject({
  revision: z.number().int().min(1).max(2147483647),
  updated_at: z.union([z.date(), z.string()]),
  default_provider_id: z.string().nullable(),
  default_model_id: z.string().nullable(),
  comparison_kind: z.enum(['off', 'selected']),
  comparison_provider_id: z.string().nullable(),
  comparison_model_id: z.string().nullable(),
});
const absent = (): AiSettingsV1 => ({
  schemaVersion: 1,
  revision: 0,
  updatedAt: null,
  defaultSelection: null,
  syntheticComparison: { kind: 'off' },
});
function projection(value: unknown): AiSettingsV1 {
  const row = rowSchema.parse(value);
  const time = row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at;
  return aiSettingsV1Schema.parse({
    schemaVersion: 1,
    revision: row.revision,
    updatedAt: time,
    defaultSelection:
      row.default_provider_id === null
        ? null
        : {
            providerId: row.default_provider_id,
            modelId: row.default_model_id,
          },
    syntheticComparison:
      row.comparison_kind === 'off'
        ? { kind: 'off' }
        : {
            kind: 'selected',
            selection: {
              providerId: row.comparison_provider_id,
              modelId: row.comparison_model_id,
            },
          },
  });
}
function canonical(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const entries = z.record(z.string(), z.unknown()).parse(value);
    return `{${Object.keys(entries)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(entries[key])}`)
      .join(',')}}`;
  }
  throw new Error('AI_SETTINGS_CANONICAL_VALUE_INVALID');
}
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
async function tenantLock(transaction: Transaction) {
  await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    transaction.athleteId,
  ]);
}
export async function readCurrentAiCatalogIn(
  transaction: Transaction,
): Promise<AiExecutionCatalogV1> {
  // Held through transaction commit, even while CAS/receipt writes happen. No network fetch.
  await transaction.query(
    "SELECT pg_advisory_xact_lock_shared(hashtextextended('ai-settings-catalog',77212))",
  );
  const result = await transaction.query(`SELECT d.definition,
    d.definition_digest=encode(sha256(convert_to(d.definition::text,'UTF8')),'hex') AS digest_matches
    FROM public.ai_settings_catalog_head h JOIN public.ai_settings_catalog_definition d USING(catalog_revision)
    WHERE h.singleton=true`);
  if (result.rows.length !== 1) throw new AiSettingsRepositoryError('UNAVAILABLE');
  const row = z
    .strictObject({ definition: z.unknown(), digest_matches: z.literal(true) })
    .parse(result.rows[0]);
  const parsed = aiExecutionCatalogV1Schema.parse(row.definition);
  if (
    !validateAiCatalogExposureV1(parsed, ['openai']) ||
    parsed.providers.some((provider) =>
      provider.models.some(
        (model) =>
          (model.modelId !== 'gpt-6.1-sol' && model.modelId !== 'gpt-6-luna') ||
          (model.modelId === 'gpt-6.1-sol' &&
            canonical(model.purposes) !== canonical(['coaching'])) ||
          (model.modelId === 'gpt-6-luna' &&
            canonical(model.purposes) !== canonical(['synthetic_comparison'])),
      ),
    )
  )
    throw new AiSettingsRepositoryError('UNAVAILABLE');
  return parsed;
}
async function requireWriteTarget(transaction: Transaction): Promise<void> {
  try {
    await transaction.query('SELECT public.assert_ai_settings_write_target()');
  } catch (error) {
    const closed = z
      .object({
        code: z.literal('P0001'),
        message: z.enum([
          'AI_SETTINGS_RESTORE_TARGET_CLOSED',
          'RESTORE_PROCESSING_CONTROL_MISSING',
        ]),
      })
      .safeParse(error);
    if (closed.success) throw new AiSettingsRepositoryError('UNAVAILABLE');
    throw error;
  }
}
async function settingsIn(transaction: Transaction): Promise<AiSettingsV1> {
  const result = await transaction.query(
    `SELECT r.revision,r.updated_at,r.default_provider_id,r.default_model_id,
    r.comparison_kind,r.comparison_provider_id,r.comparison_model_id
    FROM public.ai_settings_head h JOIN public.ai_settings_revision r USING(athlete_id,revision)
    WHERE h.athlete_id=$1`,
    [transaction.athleteId],
  );
  if (result.rows.length === 0) return absent();
  if (result.rows.length !== 1) throw new Error('AI_SETTINGS_HEAD_INVALID');
  return projection(result.rows[0]);
}
function sameChoices(left: AiSettingsV1, right: AiSettingsWriteV1) {
  return (
    canonical(left.defaultSelection) === canonical(right.defaultSelection) &&
    canonical(left.syntheticComparison) === canonical(right.syntheticComparison)
  );
}
export function createAiSettingsRepository(database: Database): AiSettingsRepository {
  return {
    catalog: (athleteId) =>
      database.tenant(athleteId, async (transaction) => {
        await tenantLock(transaction);
        return readCurrentAiCatalogIn(transaction);
      }),
    read: (athleteId) =>
      database.tenant(athleteId, async (transaction) => {
        await tenantLock(transaction);
        return settingsIn(transaction);
      }),
    write(athleteId, input) {
      const command = aiSettingsWriteV1Schema.parse(input);
      const { idempotencyKey, ...body } = command;
      const receiptKey = `ai-settings:write:${sha256(idempotencyKey)}`;
      const request = {
        version: 1,
        sha256: sha256(canonical({ action: 'ai-settings:write', ...body })),
      };
      return database.tenant(athleteId, async (transaction) => {
        // Database already owns shared lifecycle77206 and rejects erased tenant.
        await tenantLock(transaction);
        const receipt = await transaction.query(
          `SELECT request=$3::jsonb AS matches,result
          FROM public.command_receipt WHERE athlete_id=$1 AND idempotency_key=$2`,
          [athleteId, receiptKey, JSON.stringify(request)],
        );
        if (receipt.rows.length > 0) {
          const previous = z
            .strictObject({ matches: z.boolean(), result: z.unknown() })
            .parse(receipt.rows[0]);
          if (!previous.matches) throw new AiSettingsRepositoryError('IDEMPOTENCY_CONFLICT');
          const result = aiSettingsV1Schema.parse(previous.result);
          if (result.revision !== command.expectedRevision + 1 || !sameChoices(result, command))
            throw new Error('AI_SETTINGS_RECEIPT_INVALID');
          return result; // Exact successful replay BEFORE catalog head/policy/model availability checks.
        }
        // Replay above remains readable on a CLOSED restore target. New writes are fenced.
        await requireWriteTarget(transaction);
        const catalog = await readCurrentAiCatalogIn(transaction);
        const validation = validateAiSettingsChoicesV1(catalog, command);
        if (!validation.ok) throw new AiSettingsRepositoryError(validation.code);
        const current = await settingsIn(transaction);
        if (current.revision !== command.expectedRevision)
          throw new AiSettingsRepositoryError('REVISION_CONFLICT');
        const now = await transaction.query('SELECT clock_timestamp() AS updated_at');
        const instant = z.union([z.date(), z.string()]).parse(now.rows[0]?.['updated_at']);
        const result = aiSettingsV1Schema.parse({
          schemaVersion: 1,
          revision: command.expectedRevision + 1,
          updatedAt: instant instanceof Date ? instant.toISOString() : instant,
          defaultSelection: command.defaultSelection,
          syntheticComparison: command.syntheticComparison,
        });
        const comparison =
          command.syntheticComparison.kind === 'selected'
            ? command.syntheticComparison.selection
            : null;
        await transaction.query(
          `INSERT INTO public.ai_settings_revision
          (athlete_id,revision,updated_at,catalog_revision,policy_version,disclosure_version,
           default_provider_id,default_model_id,comparison_kind,comparison_provider_id,comparison_model_id,receipt_key,request_digest)
          VALUES($1,$2,$3::timestamptz,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            athleteId,
            result.revision,
            result.updatedAt,
            command.catalogRevision,
            command.policyVersion,
            command.disclosureVersion,
            command.defaultSelection?.providerId ?? null,
            command.defaultSelection?.modelId ?? null,
            command.syntheticComparison.kind,
            comparison?.providerId ?? null,
            comparison?.modelId ?? null,
            receiptKey,
            request.sha256,
          ],
        );
        const head =
          command.expectedRevision === 0
            ? await transaction.query(
                `INSERT INTO public.ai_settings_head(athlete_id,revision) VALUES($1,1) ON CONFLICT(athlete_id) DO NOTHING`,
                [athleteId],
              )
            : await transaction.query(
                `UPDATE public.ai_settings_head SET revision=$3 WHERE athlete_id=$1 AND revision=$2`,
                [athleteId, command.expectedRevision, result.revision],
              );
        if (head.rowCount !== 1) throw new AiSettingsRepositoryError('REVISION_CONFLICT');
        await transaction.query(
          `INSERT INTO public.command_receipt(athlete_id,idempotency_key,request,result)
          VALUES($1,$2,$3::jsonb,$4::jsonb)`,
          [athleteId, receiptKey, JSON.stringify(request), JSON.stringify(result)],
        );
        return result; // Database.tenant returns only after confirmed COMMIT; no outbox/provider/consent writes.
      });
    },
  };
}
