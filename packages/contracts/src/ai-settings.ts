import { z } from 'zod';
import { hasUnsafeCharacter, trackTextSchema } from './tracks.js';
import { instantSchema } from './primitives.js';

const int4Revision = z.number().int().min(1).max(2_147_483_647);
const writableRevision = z.number().int().min(0).max(2_147_483_646);
const identifier = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z][a-z0-9._-]*$/);
const definitionVersion = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const label = z
  .string()
  .min(1)
  .max(120)
  .pipe(trackTextSchema)
  .refine((value) => value === value.trim(), 'Display label must be trimmed');
const instant = instantSchema;
const idempotencyKey = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value === value.trim() && !hasUnsafeCharacter(value));
const hasUniqueValues = (values: readonly string[]) => new Set(values).size === values.length;

export const aiTransmissionScopeV1Schema = z.enum([
  'plan_summary',
  'actual_summary',
  'check_in',
  'resource_excerpt',
]);
export const aiModelPurposeV1Schema = z.enum(['coaching', 'synthetic_comparison']);
export const aiSelectionV1Schema = z.strictObject({
  providerId: identifier,
  modelId: identifier,
});
export const aiSyntheticComparisonV1Schema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('off') }),
  z.strictObject({
    kind: z.literal('selected'),
    selection: aiSelectionV1Schema,
  }),
]);
export const aiAvailabilityV1Schema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('available') }),
  z.strictObject({
    kind: z.literal('unavailable'),
    reasonCode: z.enum([
      'unconfigured',
      'temporarily_unavailable',
      'disabled',
      'revoked',
      'model_unavailable',
    ]),
  }),
]);
function validateSelectability(
  value: {
    selectable: boolean;
    availability: z.infer<typeof aiAvailabilityV1Schema>;
  },
  context: z.RefinementCtx,
) {
  if (
    value.availability.kind === 'unavailable' &&
    (value.availability.reasonCode === 'revoked' || value.availability.reasonCode === 'disabled') &&
    value.selectable
  ) {
    context.addIssue({
      code: 'custom',
      path: ['selectable'],
      message: 'Revoked or disabled entries cannot be selectable',
    });
  }
}
export const aiModelCatalogEntryV1Schema = z
  .strictObject({
    modelId: identifier,
    displayName: label,
    selectable: z.boolean(),
    availability: aiAvailabilityV1Schema,
    purposes: z
      .array(aiModelPurposeV1Schema)
      .min(1)
      .max(2)
      .refine(hasUniqueValues, 'Duplicate purpose'),
  })
  .superRefine(validateSelectability);
export const aiProviderCatalogEntryV1Schema = z
  .strictObject({
    providerId: identifier,
    displayName: label,
    selectable: z.boolean(),
    availability: aiAvailabilityV1Schema,
    recipient: z.strictObject({
      recipientId: identifier,
      displayName: label,
      disclosureVersion: definitionVersion,
    }),
    models: z
      .array(aiModelCatalogEntryV1Schema)
      .max(20)
      .refine(
        (models) => hasUniqueValues(models.map((model) => model.modelId)),
        'Duplicate model ID',
      ),
  })
  .superRefine(validateSelectability);
const catalogBase = z.strictObject({
  schemaVersion: z.literal(1),
  catalogRevision: int4Revision,
  policyVersion: definitionVersion,
  disclosureVersion: definitionVersion,
  // These are the four approved vocabulary scopes; selecting settings sends none.
  approvedScopes: z
    .array(aiTransmissionScopeV1Schema)
    .length(4)
    .refine(hasUniqueValues, 'Duplicate scope'),
  providers: z
    .array(aiProviderCatalogEntryV1Schema)
    .max(8)
    .refine(
      (providers) => hasUniqueValues(providers.map((provider) => provider.providerId)),
      'Duplicate provider ID',
    ),
  recommendedDefault: aiSelectionV1Schema.nullable(),
  recommendedSyntheticComparison: aiSyntheticComparisonV1Schema,
});
type CatalogBase = z.infer<typeof catalogBase>;
type Selection = z.infer<typeof aiSelectionV1Schema>;
type Purpose = z.infer<typeof aiModelPurposeV1Schema>;
function findSelection(catalog: CatalogBase, selection: Selection) {
  const provider = catalog.providers.find((entry) => entry.providerId === selection.providerId);
  if (!provider) return null;
  const model = provider.models.find((entry) => entry.modelId === selection.modelId);
  return model ? { provider, model } : null;
}
function selectionIsSelectable(
  catalog: CatalogBase,
  selection: Selection,
  purpose: Purpose,
): boolean {
  const found = findSelection(catalog, selection);
  return (
    found !== null &&
    found.provider.selectable &&
    found.model.selectable &&
    found.model.purposes.includes(purpose)
  );
}
export const aiExecutionCatalogV1Schema = catalogBase.superRefine((catalog, context) => {
  for (const [index, provider] of catalog.providers.entries()) {
    if (provider.recipient.disclosureVersion !== catalog.disclosureVersion) {
      context.addIssue({
        code: 'custom',
        path: ['providers', index, 'recipient', 'disclosureVersion'],
        message: 'Recipient disclosure must match catalog disclosure',
      });
    }
  }
  if (
    catalog.recommendedDefault !== null &&
    !selectionIsSelectable(catalog, catalog.recommendedDefault, 'coaching')
  ) {
    context.addIssue({
      code: 'custom',
      path: ['recommendedDefault'],
      message: 'Recommended default must reference a selectable coaching model',
    });
  }
  if (
    catalog.recommendedSyntheticComparison.kind === 'selected' &&
    !selectionIsSelectable(
      catalog,
      catalog.recommendedSyntheticComparison.selection,
      'synthetic_comparison',
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['recommendedSyntheticComparison'],
      message: 'Recommended comparison must reference a selectable comparison model',
    });
  }
});

export const aiSettingsV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    revision: z.number().int().min(0).max(2_147_483_647),
    updatedAt: instant.nullable(),
    defaultSelection: aiSelectionV1Schema.nullable(),
    syntheticComparison: aiSyntheticComparisonV1Schema,
  })
  .superRefine((settings, context) => {
    if (settings.revision === 0) {
      if (
        settings.updatedAt !== null ||
        settings.defaultSelection !== null ||
        settings.syntheticComparison.kind !== 'off'
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Absent head must have null timestamp/default and comparison off',
        });
      }
    } else if (settings.updatedAt === null) {
      context.addIssue({
        code: 'custom',
        path: ['updatedAt'],
        message: 'Existing head requires an update timestamp',
      });
    }
  });
export const aiSettingsWriteV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  expectedRevision: writableRevision,
  idempotencyKey,
  catalogRevision: int4Revision,
  policyVersion: definitionVersion,
  disclosureVersion: definitionVersion,
  defaultSelection: aiSelectionV1Schema.nullable(),
  syntheticComparison: aiSyntheticComparisonV1Schema,
});
export type AiExecutionCatalogV1 = z.infer<typeof aiExecutionCatalogV1Schema>;
export type AiSettingsV1 = z.infer<typeof aiSettingsV1Schema>;
export type AiSettingsWriteV1 = z.infer<typeof aiSettingsWriteV1Schema>;
export type AiSelectionV1 = Selection;

export type AiSavedSelectionStatusV1 =
  | { kind: 'not_selected' }
  | { kind: 'removed'; selection: Selection }
  | { kind: 'unsupported_purpose'; selection: Selection }
  | { kind: 'not_selectable'; selection: Selection }
  | {
      kind: 'unavailable';
      selection: Selection;
      reasonCode: Extract<
        z.infer<typeof aiAvailabilityV1Schema>,
        { kind: 'unavailable' }
      >['reasonCode'];
    }
  | { kind: 'available'; selection: Selection };

/** Read projection preserves a stored selection. Availability is not consent or execution permission. */
export function inspectSavedAiSelectionV1(
  catalog: AiExecutionCatalogV1,
  selection: Selection | null,
  purpose: Purpose,
): AiSavedSelectionStatusV1 {
  if (selection === null) return { kind: 'not_selected' };
  const found = findSelection(catalog, selection);
  if (found === null) return { kind: 'removed', selection };
  if (!found.model.purposes.includes(purpose)) return { kind: 'unsupported_purpose', selection };
  if (!found.provider.selectable || !found.model.selectable)
    return { kind: 'not_selectable', selection };
  if (found.provider.availability.kind === 'unavailable')
    return {
      kind: 'unavailable',
      selection,
      reasonCode: found.provider.availability.reasonCode,
    };
  if (found.model.availability.kind === 'unavailable')
    return {
      kind: 'unavailable',
      selection,
      reasonCode: found.model.availability.reasonCode,
    };
  return { kind: 'available', selection };
}
export type AiSettingsChoiceValidationV1 =
  | { ok: true; command: AiSettingsWriteV1 }
  | {
      ok: false;
      code:
        | 'STALE_CATALOG'
        | 'STALE_POLICY'
        | 'STALE_DISCLOSURE'
        | 'DEFAULT_NOT_SELECTABLE'
        | 'COMPARISON_NOT_SELECTABLE';
    };

/** A prepared/unconfigured but selectable model may be saved. This function
 * neither grants consent nor activates providers, starts jobs or reserves money. */
export function validateAiSettingsChoicesV1(
  catalog: AiExecutionCatalogV1,
  command: AiSettingsWriteV1,
): AiSettingsChoiceValidationV1 {
  if (command.catalogRevision !== catalog.catalogRevision)
    return { ok: false, code: 'STALE_CATALOG' };
  if (command.policyVersion !== catalog.policyVersion) return { ok: false, code: 'STALE_POLICY' };
  if (command.disclosureVersion !== catalog.disclosureVersion)
    return { ok: false, code: 'STALE_DISCLOSURE' };
  if (
    command.defaultSelection !== null &&
    !selectionIsSelectable(catalog, command.defaultSelection, 'coaching')
  )
    return { ok: false, code: 'DEFAULT_NOT_SELECTABLE' };
  if (
    command.syntheticComparison.kind === 'selected' &&
    !selectionIsSelectable(catalog, command.syntheticComparison.selection, 'synthetic_comparison')
  )
    return { ok: false, code: 'COMPARISON_NOT_SELECTABLE' };
  return { ok: true, command };
}

/** General DTO identifiers never authorize additional providers. The server
 * supplies its user-approved exposure allowlist (initially exactly ['openai']). */
export function validateAiCatalogExposureV1(
  catalog: AiExecutionCatalogV1,
  allowedProviderIds: readonly string[],
): boolean {
  return (
    hasUniqueValues(allowedProviderIds) &&
    catalog.providers.every((provider) => allowedProviderIds.includes(provider.providerId))
  );
}
