import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  digestExecutionCatalog,
  freezeCoachingExecutionSelection,
} from '@workout/server-coaching/coaching-execution-selection';
import { digestFrozenExecutionDraft } from '../src/ai-execution-jobs.js';

// Pure check that the stored-row digest reconstruction equals the selection helper.
// The SQL guard's canonical text is proved equal by the real-PG integration test.
const selection = { providerId: 'openai', modelId: 'gpt-6.1-sol' };
const catalog = {
  schemaVersion: 1,
  catalogRevision: 3,
  policyVersion: 'policy:3',
  disclosureVersion: 'disclosure:3',
  approvedScopes: ['plan_summary', 'actual_summary', 'check_in', 'resource_excerpt'],
  providers: [
    {
      providerId: 'openai',
      displayName: 'Synthetic OpenAI',
      selectable: true,
      availability: { kind: 'available' },
      recipient: {
        recipientId: 'openai',
        displayName: 'Synthetic',
        disclosureVersion: 'disclosure:3',
      },
      models: [
        {
          modelId: 'gpt-6.1-sol',
          displayName: 'Synthetic Sol',
          selectable: true,
          availability: { kind: 'available' },
          purposes: ['coaching'],
        },
      ],
    },
  ],
  recommendedDefault: null,
  recommendedSyntheticComparison: { kind: 'off' },
};
const permission = (revision: number) => ({ revision, digest: 'f'.repeat(64), enabled: true });
function frozen() {
  const catalogDigest = digestExecutionCatalog(catalog);
  const result = freezeCoachingExecutionSelection({
    saved: {
      settings: {
        schemaVersion: 1,
        revision: 2,
        updatedAt: '2026-10-13T00:00:00.000Z',
        defaultSelection: selection,
        syntheticComparison: { kind: 'off' },
      },
      catalogRevision: 3,
      policyVersion: 'policy:3',
      disclosureVersion: 'disclosure:3',
    },
    purpose: 'coaching',
    payloadClassification: 'health',
    pinnedPermissions: { app: permission(1), ai: permission(4) },
    currentPermissions: { app: permission(1), ai: permission(4) },
    currentCatalog: catalog,
    catalogDigest,
    registry: [
      {
        selection,
        purpose: 'coaching',
        adapterBindingVersion: 'synthetic:1',
        vendorModelRef: 'synthetic:sol',
        priceModelRef: 'gpt-6.1-sol',
        priceVersion: 'synthetic:price:1',
        tokenizerVersion: 'synthetic:tokenizer:1',
      },
    ],
  });
  if (result.kind !== 'ready') throw new Error(result.code);
  return result.frozen;
}

describe('AI execution job selection digest', () => {
  it('reconstructs the helper digest exactly, independent of member order', () => {
    const value = frozen();
    expect(digestFrozenExecutionDraft(value.draft)).toBe(value.selectionDigest);
    const reordered = JSON.parse(
      JSON.stringify(value.draft, Object.keys(value.draft).reverse()),
    ) as typeof value.draft;
    expect(digestFrozenExecutionDraft({ ...reordered, ...value.draft })).toBe(
      value.selectionDigest,
    );
  });
  it('changes for any substituted model, price or consent fact', () => {
    const { draft, selectionDigest } = frozen();
    for (const changed of [
      {
        ...draft,
        binding: { ...draft.binding, selection: { ...selection, modelId: 'gpt-6-luna' } },
      },
      { ...draft, binding: { ...draft.binding, priceVersion: 'synthetic:price:2' } },
      { ...draft, permissions: { ...draft.permissions, ai: permission(5) } },
      { ...draft, settingsRevision: 3 },
    ])
      expect(digestFrozenExecutionDraft(changed)).not.toBe(selectionDigest);
  });
  it('matches the SQL guard canonical text layout for the stored columns', () => {
    const { draft, selectionDigest } = frozen();
    const j = JSON.stringify;
    const text = `{"definitionVersion":"execution-selection-v1","draft":{"binding":{"adapterBindingVersion":${j(draft.binding.adapterBindingVersion)},"priceModelRef":${j(draft.binding.priceModelRef)},"priceVersion":${j(draft.binding.priceVersion)},"purpose":${j(draft.binding.purpose)},"selection":{"modelId":${j(draft.binding.selection.modelId)},"providerId":${j(draft.binding.selection.providerId)}},"tokenizerVersion":${j(draft.binding.tokenizerVersion)},"vendorModelRef":${j(draft.binding.vendorModelRef)}},"catalogDigest":${j(draft.catalogDigest)},"catalogRevision":${draft.catalogRevision},"disclosureVersion":${j(draft.disclosureVersion)},"payloadClassification":${j(draft.payloadClassification)},"permissions":{"ai":{"digest":${j(draft.permissions.ai.digest)},"enabled":true,"revision":${draft.permissions.ai.revision}},"app":{"digest":${j(draft.permissions.app.digest)},"enabled":true,"revision":${draft.permissions.app.revision}}},"policyVersion":${j(draft.policyVersion)},"recipientDisclosureVersion":${j(draft.recipientDisclosureVersion)},"recipientId":${j(draft.recipientId)},"schemaVersion":1,"settingsRevision":${draft.settingsRevision}}}`;
    expect(createHash('sha256').update(text, 'utf8').digest('hex')).toBe(selectionDigest);
  });
});
