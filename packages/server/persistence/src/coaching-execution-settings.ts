import { z } from 'zod';
import {
  aiSettingsV1Schema,
  aiExecutionCatalogV1Schema,
  validateAiCatalogExposureV1,
  inspectSavedAiSelectionV1,
} from '@workout/contracts/ai-settings';
import type { Transaction } from './database.js';

const revision = z.number().int().min(1).max(2147483647);
const version = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const requestSchema = z.strictObject({
  revision,
  catalogRevision: revision,
  policyVersion: version,
  disclosureVersion: version,
});
const rowSchema = z.strictObject({
  revision,
  head_revision: revision,
  head_matches: z.literal(true),
  updated_at: z.date(),
  catalog_revision: revision,
  policy_version: version,
  disclosure_version: version,
  default_provider_id: z.string().nullable(),
  default_model_id: z.string().nullable(),
  comparison_kind: z.enum(['off', 'selected']),
  comparison_provider_id: z.string().nullable(),
  comparison_model_id: z.string().nullable(),
  definition: aiExecutionCatalogV1Schema,
  digest_matches: z.literal(true),
});
export type ExecutionSettingsReadResult =
  | {
      kind: 'read';
      admissionAllowed: false;
      saved: {
        settings: z.infer<typeof aiSettingsV1Schema>;
        catalogRevision: number;
        policyVersion: string;
        disclosureVersion: string;
      };
    }
  | {
      kind: 'blocked';
      admissionAllowed: false;
      code: 'INVALID_REQUEST' | 'NOT_FOUND' | 'METADATA_MISMATCH' | 'INVALID_STORED_BASIS';
    };
const blocked = (
  code: Extract<ExecutionSettingsReadResult, { kind: 'blocked' }>['code'],
): ExecutionSettingsReadResult => ({ kind: 'blocked', admissionAllowed: false, code });
/** Caller owns the authenticated tenant transaction and global→lifecycle→tenant
 * locks. No BEGIN/COMMIT, nested tenant, permission grant or provider call here.
 * Reading retained settings never asserts current app/AI consent or dispatch
 * readiness. Requested immutable history is never replaced by the current head.
 */
export async function readCoachingExecutionSettingsIn(
  transaction: Transaction,
  input: unknown,
): Promise<ExecutionSettingsReadResult> {
  const requested = requestSchema.safeParse(input);
  const subject = z
    .string()
    .min(1)
    .max(200)
    .refine((value) => value === value.trim())
    .safeParse(transaction.athleteId);
  if (!requested.success || !subject.success) return blocked('INVALID_REQUEST');
  const result = await transaction.query(
    `SELECT r.revision,h.revision AS head_revision,
    EXISTS(SELECT 1 FROM public.ai_settings_revision current_row WHERE current_row.athlete_id=h.athlete_id AND current_row.revision=h.revision) AS head_matches,r.updated_at,
    r.catalog_revision,r.policy_version,r.disclosure_version,
    r.default_provider_id,r.default_model_id,r.comparison_kind,r.comparison_provider_id,r.comparison_model_id,
    d.definition,d.definition_digest=encode(sha256(convert_to(d.definition::text,'UTF8')),'hex') AS digest_matches
    FROM public.ai_settings_revision r
    LEFT JOIN public.ai_settings_head h ON h.athlete_id=r.athlete_id
    LEFT JOIN public.ai_settings_catalog_definition d ON d.catalog_revision=r.catalog_revision
    WHERE r.athlete_id=$1 AND r.revision=$2 LIMIT 2`,
    [subject.data, requested.data.revision],
  );
  if (result.rows.length === 0) return blocked('NOT_FOUND');
  if (result.rows.length !== 1) return blocked('INVALID_STORED_BASIS');
  const decoded = rowSchema.safeParse(result.rows[0]);
  if (!decoded.success) return blocked('INVALID_STORED_BASIS');
  const row = decoded.data;
  if (
    row.head_revision < row.revision ||
    !validateAiCatalogExposureV1(row.definition, ['openai']) ||
    row.definition.catalogRevision !== row.catalog_revision ||
    row.definition.policyVersion !== row.policy_version ||
    row.definition.disclosureVersion !== row.disclosure_version
  )
    return blocked('INVALID_STORED_BASIS');
  if (
    row.revision !== requested.data.revision ||
    row.catalog_revision !== requested.data.catalogRevision ||
    row.policy_version !== requested.data.policyVersion ||
    row.disclosure_version !== requested.data.disclosureVersion
  )
    return blocked('METADATA_MISMATCH');
  if (
    (row.default_provider_id === null) !== (row.default_model_id === null) ||
    (row.comparison_kind === 'off' &&
      (row.comparison_provider_id !== null || row.comparison_model_id !== null))
  )
    return blocked('INVALID_STORED_BASIS');
  const settings = aiSettingsV1Schema.safeParse({
    schemaVersion: 1,
    revision: row.revision,
    updatedAt: row.updated_at.toISOString(),
    defaultSelection:
      row.default_provider_id === null
        ? null
        : { providerId: row.default_provider_id, modelId: row.default_model_id },
    syntheticComparison:
      row.comparison_kind === 'off'
        ? { kind: 'off' }
        : {
            kind: 'selected',
            selection: { providerId: row.comparison_provider_id, modelId: row.comparison_model_id },
          },
  });
  if (!settings.success) return blocked('INVALID_STORED_BASIS');
  for (const [selection, purpose] of [
    [settings.data.defaultSelection, 'coaching'],
    [
      settings.data.syntheticComparison.kind === 'selected'
        ? settings.data.syntheticComparison.selection
        : null,
      'synthetic_comparison',
    ],
  ] as const) {
    if (selection === null) continue;
    const status = inspectSavedAiSelectionV1(row.definition, selection, purpose);
    if (
      status.kind === 'removed' ||
      status.kind === 'unsupported_purpose' ||
      status.kind === 'not_selectable'
    )
      return blocked('INVALID_STORED_BASIS');
  }
  return {
    kind: 'read',
    admissionAllowed: false,
    saved: {
      settings: settings.data,
      catalogRevision: row.catalog_revision,
      policyVersion: row.policy_version,
      disclosureVersion: row.disclosure_version,
    },
  };
}
