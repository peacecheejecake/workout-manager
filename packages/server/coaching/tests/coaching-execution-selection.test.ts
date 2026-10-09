import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import type { AiExecutionCatalogV1 } from '@workout/contracts/ai-settings';
import {
  digestExecutionCatalog,
  freezeCoachingExecutionSelection,
  inspectFrozenCoachingExecutionSelection,
} from '../src/coaching-execution-selection.js';

// Caller-owned synthetic facts: no approved vendor model, tokenizer, price or API evidence.
const permission = { revision: 1, digest: 'a'.repeat(64), enabled: true };
const defaultSelection = { providerId: 'openai', modelId: 'gpt-6.1-sol' };
const comparison = { providerId: 'openai', modelId: 'gpt-6-luna' };
function firstItem<T>(rows: readonly T[]): T {
  const value = rows[0];
  assert(value !== undefined);
  return value;
}
function input() {
  const catalog: AiExecutionCatalogV1 = {
    schemaVersion: 1,
    catalogRevision: 1,
    policyVersion: 'policy:1',
    disclosureVersion: 'disclosure:1',
    approvedScopes: ['plan_summary', 'actual_summary', 'check_in', 'resource_excerpt'],
    providers: [
      {
        providerId: 'openai',
        displayName: 'OpenAI',
        selectable: true,
        availability: { kind: 'available' },
        recipient: {
          recipientId: 'openai',
          displayName: 'OpenAI',
          disclosureVersion: 'disclosure:1',
        },
        models: [
          {
            modelId: 'gpt-6.1-sol',
            displayName: 'Sol',
            selectable: true,
            availability: { kind: 'available' },
            purposes: ['coaching'],
          },
          {
            modelId: 'gpt-6-luna',
            displayName: 'Luna',
            selectable: true,
            availability: { kind: 'available' },
            purposes: ['synthetic_comparison'],
          },
        ],
      },
    ],
    recommendedDefault: defaultSelection,
    recommendedSyntheticComparison: { kind: 'off' },
  };
  return {
    saved: {
      settings: {
        schemaVersion: 1,
        revision: 1,
        updatedAt: '2026-10-07T00:00:00Z',
        defaultSelection,
        syntheticComparison: { kind: 'selected', selection: comparison },
      },
      catalogRevision: 1,
      policyVersion: 'policy:1',
      disclosureVersion: 'disclosure:1',
    },
    purpose: 'coaching',
    payloadClassification: 'health',
    currentCatalog: catalog,
    catalogDigest: digestExecutionCatalog(catalog),
    pinnedPermissions: { app: { ...permission }, ai: { ...permission } },
    currentPermissions: { app: { ...permission }, ai: { ...permission } },
    registry: [
      {
        selection: defaultSelection,
        purpose: 'coaching',
        adapterBindingVersion: 'synthetic:1',
        vendorModelRef: 'synthetic-vendor-sol',
        priceModelRef: 'gpt-6.1-sol',
        priceVersion: 'synthetic-price:1',
        tokenizerVersion: 'synthetic-tokenizer:1',
      },
      {
        selection: comparison,
        purpose: 'synthetic_comparison',
        adapterBindingVersion: 'synthetic:1',
        vendorModelRef: 'synthetic-vendor-luna',
        priceModelRef: 'gpt-6-luna',
        priceVersion: 'synthetic-price:1',
        tokenizerVersion: 'synthetic-tokenizer:1',
      },
    ],
  };
}
function live(value: ReturnType<typeof input>, frozen: unknown) {
  return {
    frozen,
    currentCatalog: value.currentCatalog,
    catalogDigest: value.catalogDigest,
    currentPermissions: value.currentPermissions,
    registry: value.registry,
  };
}
function recalculate(value: ReturnType<typeof input>) {
  value.catalogDigest = digestExecutionCatalog(value.currentCatalog);
}
test('explicit saved selection produces immutable consistency draft, never admission', () => {
  const value = input();
  const before = JSON.stringify(value);
  const result = freezeCoachingExecutionSelection(value);
  assert(result.kind === 'ready');
  expect(result.admissionAllowed).toBe(false);
  expect(result.frozen.draft.settingsRevision).toBe(1);
  expect(result.frozen.draft.binding.selection).toEqual(defaultSelection);
  expect(Object.isFrozen(result.frozen.draft.binding.selection)).toBe(true);
  expect(JSON.stringify(value)).toBe(before);
  firstItem(value.registry).vendorModelRef = 'changed';
  expect(result.frozen.draft.binding.vendorModelRef).toBe('synthetic-vendor-sol');
});
test('absent/default-null never substitutes recommendation', () => {
  const value = input();
  expect(
    freezeCoachingExecutionSelection({
      ...value,
      saved: {
        ...value.saved,
        settings: {
          schemaVersion: 1,
          revision: 0,
          updatedAt: null,
          defaultSelection: null,
          syntheticComparison: { kind: 'off' },
        },
      },
    }),
  ).toMatchObject({ kind: 'blocked', code: 'SELECTION_REQUIRED', admissionAllowed: false });
  expect(
    freezeCoachingExecutionSelection({
      ...value,
      saved: { ...value.saved, settings: { ...value.saved.settings, defaultSelection: null } },
    }),
  ).toMatchObject({ code: 'SELECTION_REQUIRED' });
});
test.each(['unconfigured', 'temporarily_unavailable', 'model_unavailable'])(
  'saveable %s is not an execution draft',
  (reasonCode) => {
    const value = input();
    const model = firstItem(firstItem(value.currentCatalog.providers).models);
    const catalog = {
      ...value.currentCatalog,
      providers: [
        {
          ...value.currentCatalog.providers[0],
          models: [
            { ...model, availability: { kind: 'unavailable', reasonCode } },
            firstItem(value.currentCatalog.providers).models[1],
          ],
        },
      ],
    };
    expect(
      freezeCoachingExecutionSelection({
        ...value,
        currentCatalog: catalog,
        catalogDigest: digestExecutionCatalog(catalog),
      }),
    ).toMatchObject({ code: 'MODEL_UNAVAILABLE' });
  },
);
test('removed/revoked and wrong purpose reject without replacement', () => {
  const value = input();
  value.currentCatalog.recommendedDefault = null;
  firstItem(value.currentCatalog.providers).models.shift();
  recalculate(value);
  expect(freezeCoachingExecutionSelection(value)).toMatchObject({ code: 'MODEL_REMOVED' });
  const revoked = input();
  const provider = firstItem(revoked.currentCatalog.providers);
  const catalog = {
    ...revoked.currentCatalog,
    recommendedDefault: null,
    providers: [
      {
        ...provider,
        selectable: false,
        availability: { kind: 'unavailable', reasonCode: 'revoked' },
      },
    ],
  };
  expect(
    freezeCoachingExecutionSelection({
      ...revoked,
      currentCatalog: catalog,
      catalogDigest: digestExecutionCatalog(catalog),
    }),
  ).toMatchObject({ code: 'NOT_SELECTABLE' });
  const wrong = input();
  wrong.saved.settings.defaultSelection = comparison;
  expect(freezeCoachingExecutionSelection(wrong)).toMatchObject({ code: 'WRONG_PURPOSE' });
});
test('permission withdrawal/regrant and stale policy/digest fail closed', () => {
  const value = input();
  value.currentPermissions.ai.enabled = false;
  expect(freezeCoachingExecutionSelection(value)).toMatchObject({ code: 'PERMISSION_REQUIRED' });
  value.currentPermissions.ai.enabled = true;
  value.currentPermissions.ai.revision = 3;
  expect(freezeCoachingExecutionSelection(value)).toMatchObject({ code: 'PERMISSION_MISMATCH' });
  expect(
    freezeCoachingExecutionSelection({ ...input(), catalogDigest: 'b'.repeat(64) }),
  ).toMatchObject({ code: 'CATALOG_DIGEST_MISMATCH' });
  const stale = input();
  stale.saved.policyVersion = 'policy:old';
  expect(freezeCoachingExecutionSelection(stale)).toMatchObject({ code: 'STALE_METADATA' });
});
test('missing binding and wrong price model reject', () => {
  expect(freezeCoachingExecutionSelection({ ...input(), registry: [] })).toMatchObject({
    code: 'BINDING_REQUIRED',
  });
  const value = input();
  firstItem(value.registry).priceModelRef = 'gpt-6-luna';
  expect(freezeCoachingExecutionSelection(value)).toMatchObject({ code: 'BINDING_MISMATCH' });
});
test('Luna comparison requires synthetic-only classification; no health body admitted', () => {
  const value = input();
  value.purpose = 'synthetic_comparison';
  expect(freezeCoachingExecutionSelection(value)).toMatchObject({
    code: 'SYNTHETIC_PAYLOAD_REQUIRED',
  });
  value.payloadClassification = 'synthetic_only';
  const result = freezeCoachingExecutionSelection(value);
  assert(result.kind === 'ready');
  expect(result.frozen.draft.binding.selection).toEqual(comparison);
  expect(
    freezeCoachingExecutionSelection({ ...value, healthPayload: { record: 'synthetic' } }),
  ).toMatchObject({ code: 'INVALID_INPUT' });
});
test('digest ignores catalog and registry set ordering, without altering selected pins', () => {
  const first = input();
  const second = input();
  second.currentCatalog.approvedScopes.reverse();
  firstItem(second.currentCatalog.providers).models.reverse();
  second.registry.reverse();
  recalculate(second);
  expect(second.catalogDigest).toBe(first.catalogDigest);
  expect(freezeCoachingExecutionSelection(second)).toEqual(freezeCoachingExecutionSelection(first));
});
test('frozen inspection retains original model despite newer preference and blocks catalog/pin changes', () => {
  const value = input();
  const result = freezeCoachingExecutionSelection(value);
  assert(result.kind === 'ready');
  value.saved.settings.defaultSelection = comparison;
  value.saved.settings.revision = 2;
  expect(inspectFrozenCoachingExecutionSelection(live(value, result.frozen))).toEqual(result);
  firstItem(value.registry).adapterBindingVersion = 'synthetic:2';
  expect(inspectFrozenCoachingExecutionSelection(live(value, result.frozen))).toMatchObject({
    code: 'BINDING_MISMATCH',
  });
  firstItem(value.registry).adapterBindingVersion = 'synthetic:1';
  value.currentPermissions.app.revision = 3;
  expect(inspectFrozenCoachingExecutionSelection(live(value, result.frozen))).toMatchObject({
    code: 'PERMISSION_MISMATCH',
  });
  value.currentPermissions.app.revision = 1;
  value.currentCatalog.catalogRevision = 2;
  recalculate(value);
  expect(inspectFrozenCoachingExecutionSelection(live(value, result.frozen))).toMatchObject({
    code: 'STALE_METADATA',
  });
});
test('unknown fields, duplicate/oversize registry, int4 overflow and forged draft digest reject', () => {
  const value = input();
  for (const invalid of [
    { ...value, verified: true },
    { ...value, registry: [...value.registry, ...value.registry] },
    { ...value, registry: Array.from({ length: 41 }, () => value.registry[0]) },
    {
      ...value,
      pinnedPermissions: {
        ...value.pinnedPermissions,
        app: { ...permission, revision: 2147483648 },
      },
    },
  ])
    expect(freezeCoachingExecutionSelection(invalid)).toMatchObject({ code: 'INVALID_INPUT' });
  const result = freezeCoachingExecutionSelection(value);
  assert(result.kind === 'ready');
  expect(
    inspectFrozenCoachingExecutionSelection(
      live(value, { ...result.frozen, selectionDigest: 'c'.repeat(64) }),
    ),
  ).toMatchObject({ code: 'INVALID_INPUT' });
});
