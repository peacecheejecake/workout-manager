import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  aiExecutionCatalogV1Schema,
  aiSettingsV1Schema,
  aiModelPurposeV1Schema,
  aiSelectionV1Schema,
  inspectSavedAiSelectionV1,
  validateAiCatalogExposureV1,
} from '@workout/contracts/ai-settings';

const revision = z.number().int().min(1).max(2_147_483_647);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const version = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const permission = z.strictObject({ revision, digest, enabled: z.boolean() });
const permissions = z.strictObject({ app: permission, ai: permission });
const binding = z.strictObject({
  selection: aiSelectionV1Schema,
  purpose: aiModelPurposeV1Schema,
  adapterBindingVersion: version,
  vendorModelRef: version,
  priceModelRef: version,
  priceVersion: version,
  tokenizerVersion: version,
});
const registry = z
  .array(binding)
  .max(40)
  .superRefine((rows, context) => {
    const keys = rows.map((row) =>
      JSON.stringify([row.selection.providerId, row.selection.modelId, row.purpose]),
    );
    if (new Set(keys).size !== keys.length)
      context.addIssue({ code: 'custom', message: 'Duplicate registry binding' });
  });
const liveShape = {
  currentCatalog: aiExecutionCatalogV1Schema,
  catalogDigest: digest,
  currentPermissions: permissions,
  registry,
};
const freezeSchema = z.strictObject({
  saved: z.strictObject({
    settings: aiSettingsV1Schema,
    catalogRevision: revision.nullable(),
    policyVersion: version.nullable(),
    disclosureVersion: version.nullable(),
  }),
  purpose: aiModelPurposeV1Schema,
  payloadClassification: z.enum(['health', 'synthetic_only']),
  pinnedPermissions: permissions,
  ...liveShape,
});
const draftSchema = z.strictObject({
  schemaVersion: z.literal(1),
  settingsRevision: revision,
  catalogRevision: revision,
  catalogDigest: digest,
  policyVersion: version,
  disclosureVersion: version,
  recipientId: version,
  recipientDisclosureVersion: version,
  payloadClassification: z.enum(['health', 'synthetic_only']),
  permissions,
  binding,
});
const frozenSchema = z.strictObject({ draft: draftSchema, selectionDigest: digest });
const inspectSchema = z.strictObject({ frozen: frozenSchema, ...liveShape });
export type ExecutionSelectionBlockedCode =
  | 'INVALID_INPUT'
  | 'CATALOG_DIGEST_MISMATCH'
  | 'SELECTION_REQUIRED'
  | 'STALE_METADATA'
  | 'PERMISSION_REQUIRED'
  | 'PERMISSION_MISMATCH'
  | 'MODEL_REMOVED'
  | 'WRONG_PURPOSE'
  | 'NOT_SELECTABLE'
  | 'MODEL_UNAVAILABLE'
  | 'SYNTHETIC_PAYLOAD_REQUIRED'
  | 'BINDING_REQUIRED'
  | 'BINDING_MISMATCH';
type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type FrozenExecutionSelection = DeepReadonly<z.infer<typeof frozenSchema>>;
export type ExecutionSelectionResult =
  | {
      readonly kind: 'ready';
      readonly admissionAllowed: false;
      readonly frozen: FrozenExecutionSelection;
    }
  | {
      readonly kind: 'blocked';
      readonly admissionAllowed: false;
      readonly code: ExecutionSelectionBlockedCode;
    };
function blocked(code: ExecutionSelectionBlockedCode): ExecutionSelectionResult {
  return { kind: 'blocked', admissionAllowed: false, code };
}
// Exact object key order, array order preserved except documented catalog sets.
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`;
}
function sha(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
/** Canonical catalog identity: providers/models/scopes/purposes are unordered sets. */
export function digestExecutionCatalog(input: unknown): string | null {
  const parsed = aiExecutionCatalogV1Schema.safeParse(input);
  if (!parsed.success) return null;
  const catalog = parsed.data;
  return sha({
    definitionVersion: 'execution-catalog-v1',
    catalog: {
      ...catalog,
      approvedScopes: [...catalog.approvedScopes].sort(),
      providers: catalog.providers
        .map((provider) => ({
          ...provider,
          models: provider.models
            .map((model) => ({ ...model, purposes: [...model.purposes].sort() }))
            .sort((a, b) => (a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0)),
        }))
        .sort((a, b) => (a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0)),
    },
  });
}
function freezeObjects<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeObjects(child);
    Object.freeze(value);
  }
  return value;
}
function ready(draft: z.infer<typeof draftSchema>): ExecutionSelectionResult {
  return freezeObjects({
    kind: 'ready',
    admissionAllowed: false,
    frozen: { draft, selectionDigest: sha({ definitionVersion: 'execution-selection-v1', draft }) },
  });
}
function liveCheck(
  live: z.infer<typeof inspectSchema>,
  draft: z.infer<typeof draftSchema>,
): ExecutionSelectionBlockedCode | null {
  const catalog = live.currentCatalog;
  if (
    !validateAiCatalogExposureV1(catalog, ['openai']) ||
    digestExecutionCatalog(catalog) !== live.catalogDigest
  )
    return 'CATALOG_DIGEST_MISMATCH';
  if (
    draft.catalogRevision !== catalog.catalogRevision ||
    draft.catalogDigest !== live.catalogDigest ||
    draft.policyVersion !== catalog.policyVersion ||
    draft.disclosureVersion !== catalog.disclosureVersion
  )
    return 'STALE_METADATA';
  if (!live.currentPermissions.app.enabled || !live.currentPermissions.ai.enabled)
    return 'PERMISSION_REQUIRED';
  if (canonical(draft.permissions) !== canonical(live.currentPermissions))
    return 'PERMISSION_MISMATCH';
  if (
    draft.binding.purpose === 'synthetic_comparison' &&
    draft.payloadClassification !== 'synthetic_only'
  )
    return 'SYNTHETIC_PAYLOAD_REQUIRED';
  const status = inspectSavedAiSelectionV1(catalog, draft.binding.selection, draft.binding.purpose);
  switch (status.kind) {
    case 'not_selected':
      return 'SELECTION_REQUIRED';
    case 'removed':
      return 'MODEL_REMOVED';
    case 'unsupported_purpose':
      return 'WRONG_PURPOSE';
    case 'not_selectable':
      return 'NOT_SELECTABLE';
    case 'unavailable':
      return 'MODEL_UNAVAILABLE';
    case 'available':
      break;
  }
  const current = live.registry.find(
    (row) =>
      canonical(row.selection) === canonical(draft.binding.selection) &&
      row.purpose === draft.binding.purpose,
  );
  if (!current) return 'BINDING_REQUIRED';
  if (
    current.priceModelRef !== current.selection.modelId ||
    canonical(current) !== canonical(draft.binding)
  )
    return 'BINDING_MISMATCH';
  const provider = catalog.providers.find(
    (row) => row.providerId === draft.binding.selection.providerId,
  );
  if (
    !provider ||
    provider.recipient.recipientId !== draft.recipientId ||
    provider.recipient.disclosureVersion !== draft.recipientDisclosureVersion
  )
    return 'STALE_METADATA';
  return null;
}
/** Consistency draft only. Caller facts never prove live vendor availability,
 * approved prices, full freshness, app admission, budget or dispatch authority. */
export function freezeCoachingExecutionSelection(input: unknown): ExecutionSelectionResult {
  const parsed = freezeSchema.safeParse(input);
  if (!parsed.success) return blocked('INVALID_INPUT');
  const value = parsed.data;
  const { settings } = value.saved;
  const selection =
    value.purpose === 'coaching'
      ? settings.defaultSelection
      : settings.syntheticComparison.kind === 'selected'
        ? settings.syntheticComparison.selection
        : null;
  if (settings.revision === 0 || selection === null) return blocked('SELECTION_REQUIRED');
  const catalog = value.currentCatalog;
  if (
    value.saved.catalogRevision !== catalog.catalogRevision ||
    value.saved.policyVersion !== catalog.policyVersion ||
    value.saved.disclosureVersion !== catalog.disclosureVersion
  )
    return blocked('STALE_METADATA');
  const selected = value.registry.find(
    (row) => canonical(row.selection) === canonical(selection) && row.purpose === value.purpose,
  );
  // Inspect selected catalog first so removal/wrong-purpose cannot be obscured by absent registry.
  const status = inspectSavedAiSelectionV1(catalog, selection, value.purpose);
  if (status.kind === 'removed') return blocked('MODEL_REMOVED');
  if (status.kind === 'unsupported_purpose') return blocked('WRONG_PURPOSE');
  if (status.kind === 'not_selectable') return blocked('NOT_SELECTABLE');
  if (status.kind === 'unavailable') return blocked('MODEL_UNAVAILABLE');
  if (!selected) return blocked('BINDING_REQUIRED');
  const provider = catalog.providers.find((row) => row.providerId === selection.providerId);
  if (!provider) return blocked('MODEL_REMOVED');
  const draft = draftSchema.parse({
    schemaVersion: 1,
    settingsRevision: settings.revision,
    catalogRevision: catalog.catalogRevision,
    catalogDigest: value.catalogDigest,
    policyVersion: catalog.policyVersion,
    disclosureVersion: catalog.disclosureVersion,
    recipientId: provider.recipient.recipientId,
    recipientDisclosureVersion: provider.recipient.disclosureVersion,
    payloadClassification: value.payloadClassification,
    permissions: value.pinnedPermissions,
    binding: selected,
  });
  const result = ready(draft);
  if (result.kind !== 'ready') return result;
  const failure = liveCheck({ ...value, frozen: result.frozen }, draft);
  return failure ? blocked(failure) : result;
}
/** Does not consult newer preferences: a frozen job never switches model automatically. */
export function inspectFrozenCoachingExecutionSelection(input: unknown): ExecutionSelectionResult {
  const parsed = inspectSchema.safeParse(input);
  if (!parsed.success) return blocked('INVALID_INPUT');
  const value = parsed.data;
  if (
    sha({ definitionVersion: 'execution-selection-v1', draft: value.frozen.draft }) !==
    value.frozen.selectionDigest
  )
    return blocked('INVALID_INPUT');
  const failure = liveCheck(value, value.frozen.draft);
  return failure ? blocked(failure) : ready(value.frozen.draft);
}
