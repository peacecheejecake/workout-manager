import { test, expect } from 'vitest';
import {
  aiExecutionCatalogV1Schema,
  aiSettingsV1Schema,
  aiSettingsWriteV1Schema,
  aiSelectionV1Schema,
  inspectSavedAiSelectionV1,
  validateAiSettingsChoicesV1,
  validateAiCatalogExposureV1,
} from '../src/ai-settings.js';

const defaultSelection = { providerId: 'openai', modelId: 'gpt-6.1-sol' };
const comparisonSelection = { providerId: 'openai', modelId: 'gpt-6-luna' };
function catalog() {
  return aiExecutionCatalogV1Schema.parse({
    schemaVersion: 1,
    catalogRevision: 7,
    policyVersion: 'ai-policy:1',
    disclosureVersion: 'ai-recipient:1',
    approvedScopes: ['plan_summary', 'actual_summary', 'check_in', 'resource_excerpt'],
    providers: [
      {
        providerId: 'openai',
        displayName: 'OpenAI',
        selectable: true,
        availability: { kind: 'unavailable', reasonCode: 'unconfigured' },
        recipient: {
          recipientId: 'openai',
          displayName: 'OpenAI',
          disclosureVersion: 'ai-recipient:1',
        },
        models: [
          {
            modelId: 'gpt-6.1-sol',
            displayName: 'gpt-6.1-sol',
            selectable: true,
            availability: { kind: 'unavailable', reasonCode: 'unconfigured' },
            purposes: ['coaching'],
          },
          {
            modelId: 'gpt-6-luna',
            displayName: 'gpt-6-luna',
            selectable: true,
            availability: { kind: 'unavailable', reasonCode: 'unconfigured' },
            purposes: ['synthetic_comparison'],
          },
        ],
      },
    ],
    recommendedDefault: defaultSelection,
    recommendedSyntheticComparison: {
      kind: 'selected',
      selection: comparisonSelection,
    },
  });
}
function command() {
  return aiSettingsWriteV1Schema.parse({
    schemaVersion: 1,
    expectedRevision: 0,
    idempotencyKey: 'settings-first-save',
    catalogRevision: 7,
    policyVersion: 'ai-policy:1',
    disclosureVersion: 'ai-recipient:1',
    defaultSelection,
    syntheticComparison: { kind: 'off' },
  });
}
function provider() {
  const first = catalog().providers[0];
  if (!first) throw new Error('FIXTURE_PROVIDER_MISSING');
  return first;
}
function model() {
  const first = provider().models[0];
  if (!first) throw new Error('FIXTURE_MODEL_MISSING');
  return first;
}
const absent = {
  schemaVersion: 1,
  revision: 0,
  updatedAt: null,
  defaultSelection: null,
  syntheticComparison: { kind: 'off' },
};

test('absent head stays null/off and never receives recommended default', () => {
  const parsed = aiSettingsV1Schema.parse(absent);
  expect(parsed.defaultSelection).toBe(null);
  expect(parsed.syntheticComparison).toEqual({ kind: 'off' });
  expect(inspectSavedAiSelectionV1(catalog(), parsed.defaultSelection, 'coaching')).toEqual({
    kind: 'not_selected',
  });
});
test('revision zero rejects time, choice and comparison; positive revision requires timestamp', () => {
  for (const invalid of [
    { ...absent, updatedAt: '2026-10-06T00:00:00Z' },
    { ...absent, defaultSelection },
    {
      ...absent,
      syntheticComparison: { kind: 'selected', selection: comparisonSelection },
    },
    { ...absent, revision: 1 },
    { ...absent, revision: null },
    { ...absent, revision: -1 },
    { ...absent, revision: 2_147_483_648 },
  ])
    expect(aiSettingsV1Schema.safeParse(invalid).success).toBe(false);
  expect(
    aiSettingsV1Schema.safeParse({
      ...absent,
      revision: 1,
      updatedAt: '2026-10-06T09:00:00+09:00',
    }).success,
  ).toBe(true);
});
test('catalog duplicates and unapproved scopes/purposes fail', () => {
  for (const invalid of [
    { ...catalog(), providers: [provider(), provider()] },
    {
      ...catalog(),
      providers: [{ ...provider(), models: [model(), model()] }],
    },
    {
      ...catalog(),
      providers: [
        {
          ...provider(),
          models: [{ ...model(), purposes: ['coaching', 'coaching'] }],
        },
      ],
    },
    {
      ...catalog(),
      approvedScopes: ['plan_summary', 'actual_summary', 'check_in', 'check_in'],
    },
    {
      ...catalog(),
      approvedScopes: ['plan_summary', 'actual_summary', 'check_in', 'photos'],
    },
    {
      ...catalog(),
      providers: [{ ...provider(), models: [{ ...model(), purposes: [] }] }],
    },
  ])
    expect(aiExecutionCatalogV1Schema.safeParse(invalid).success).toBe(false);
});
test('recommended references must exist, be selectable and match purpose/disclosure', () => {
  for (const invalid of [
    {
      ...catalog(),
      recommendedDefault: { providerId: 'missing', modelId: 'gpt-6.1-sol' },
    },
    { ...catalog(), recommendedDefault: comparisonSelection },
    {
      ...catalog(),
      recommendedSyntheticComparison: {
        kind: 'selected',
        selection: defaultSelection,
      },
    },
    {
      ...catalog(),
      providers: [
        {
          ...provider(),
          recipient: {
            ...provider().recipient,
            disclosureVersion: 'different:1',
          },
        },
      ],
    },
  ])
    expect(aiExecutionCatalogV1Schema.safeParse(invalid).success).toBe(false);
});
test('prepared unconfigured selectable models can be saved but are not executable', () => {
  const selected = command();
  expect(validateAiSettingsChoicesV1(catalog(), selected)).toEqual({
    ok: true,
    command: selected,
  });
  expect(inspectSavedAiSelectionV1(catalog(), defaultSelection, 'coaching')).toEqual({
    kind: 'unavailable',
    selection: defaultSelection,
    reasonCode: 'unconfigured',
  });
  const comparison = {
    ...selected,
    syntheticComparison: { kind: 'selected', selection: comparisonSelection },
  };
  const parsed = aiSettingsWriteV1Schema.parse(comparison);
  expect(validateAiSettingsChoicesV1(catalog(), parsed).ok).toBe(true);
});
test('revoked and disabled entries cannot claim selectability', () => {
  for (const reasonCode of ['revoked', 'disabled']) {
    expect(
      aiExecutionCatalogV1Schema.safeParse({
        ...catalog(),
        providers: [{ ...provider(), availability: { kind: 'unavailable', reasonCode } }],
      }).success,
    ).toBe(false);
    expect(
      aiExecutionCatalogV1Schema.safeParse({
        ...catalog(),
        providers: [
          {
            ...provider(),
            models: [{ ...model(), availability: { kind: 'unavailable', reasonCode } }],
          },
        ],
      }).success,
    ).toBe(false);
  }
});
test('unselectable saved value remains readable and cannot be submitted as a new choice', () => {
  const revoked = aiExecutionCatalogV1Schema.parse({
    ...catalog(),
    recommendedDefault: null,
    providers: [
      {
        ...provider(),
        models: [
          {
            ...model(),
            selectable: false,
            availability: { kind: 'unavailable', reasonCode: 'revoked' },
          },
        ],
      },
    ],
    recommendedSyntheticComparison: { kind: 'off' },
  });
  expect(inspectSavedAiSelectionV1(revoked, defaultSelection, 'coaching')).toEqual({
    kind: 'not_selectable',
    selection: defaultSelection,
  });
  expect(validateAiSettingsChoicesV1(revoked, command())).toEqual({
    ok: false,
    code: 'DEFAULT_NOT_SELECTABLE',
  });
  const stored = aiSettingsV1Schema.parse({
    ...absent,
    revision: 2,
    updatedAt: '2026-10-06T00:00:00Z',
    defaultSelection,
  });
  expect(stored.defaultSelection).toEqual(defaultSelection);
});
test('removed selection is preserved without implicit fallback', () => {
  const empty = aiExecutionCatalogV1Schema.parse({
    ...catalog(),
    providers: [],
    recommendedDefault: null,
    recommendedSyntheticComparison: { kind: 'off' },
  });
  expect(inspectSavedAiSelectionV1(empty, defaultSelection, 'coaching')).toEqual({
    kind: 'removed',
    selection: defaultSelection,
  });
  expect(validateAiSettingsChoicesV1(empty, command())).toEqual({
    ok: false,
    code: 'DEFAULT_NOT_SELECTABLE',
  });
  expect(empty.recommendedDefault).toEqual(null);
});
test('server authoritative versions are checked independently', () => {
  expect(
    validateAiSettingsChoicesV1(catalog(), {
      ...command(),
      catalogRevision: 6,
    }),
  ).toEqual({ ok: false, code: 'STALE_CATALOG' });
  expect(
    validateAiSettingsChoicesV1(catalog(), {
      ...command(),
      policyVersion: 'ai-policy:0',
    }),
  ).toEqual({ ok: false, code: 'STALE_POLICY' });
  expect(
    validateAiSettingsChoicesV1(catalog(), {
      ...command(),
      disclosureVersion: 'ai-recipient:0',
    }),
  ).toEqual({ ok: false, code: 'STALE_DISCLOSURE' });
});
test('model purpose does not silently turn comparison into coaching', () => {
  expect(
    validateAiSettingsChoicesV1(catalog(), {
      ...command(),
      defaultSelection: comparisonSelection,
    }),
  ).toEqual({ ok: false, code: 'DEFAULT_NOT_SELECTABLE' });
  expect(
    validateAiSettingsChoicesV1(catalog(), {
      ...command(),
      syntheticComparison: { kind: 'selected', selection: defaultSelection },
    }),
  ).toEqual({ ok: false, code: 'COMPARISON_NOT_SELECTABLE' });
});
test('strict DTOs reject key, athlete, endpoint, price and activation/consent/call overrides', () => {
  for (const extra of [
    'apiKey',
    'athleteId',
    'endpoint',
    'monthlyLimitMinor',
    'priceOverride',
    'consentGranted',
    'enabled',
    'startRun',
  ]) {
    expect(aiSettingsWriteV1Schema.safeParse({ ...command(), [extra]: 'unexpected' }).success).toBe(
      false,
    );
    expect(aiSettingsV1Schema.safeParse({ ...absent, [extra]: 'unexpected' }).success).toBe(false);
    expect(
      aiExecutionCatalogV1Schema.safeParse({
        ...catalog(),
        [extra]: 'unexpected',
      }).success,
    ).toBe(false);
  }
});
test('IDs and labels reject injection-shaped/unsafe values', () => {
  for (const providerId of [
    '',
    ' openai',
    'OpenAI',
    'https://api.openai.com',
    '../openai',
    'openai\n',
    'x'.repeat(101),
  ]) {
    expect(aiSelectionV1Schema.safeParse({ providerId, modelId: 'gpt-6.1-sol' }).success).toBe(
      false,
    );
  }
  for (const displayName of [
    ' ',
    'OpenAI\n',
    '\u202eOpenAI',
    '\u061cOpenAI',
    '\u200fOpenAI',
    '\u0085OpenAI',
    '<OpenAI>',
    'x'.repeat(121),
  ]) {
    expect(
      aiExecutionCatalogV1Schema.safeParse({
        ...catalog(),
        providers: [{ ...provider(), displayName }],
      }).success,
    ).toBe(false);
  }
});
test('versions, revisions and missing fields are not coerced/defaulted', () => {
  for (const invalid of [
    { ...command(), schemaVersion: 2 },
    { ...command(), expectedRevision: 2_147_483_647 },
    { ...command(), expectedRevision: '0' },
    { ...command(), expectedRevision: null },
    { ...command(), catalogRevision: 0 },
    { ...command(), policyVersion: '../policy' },
    { ...command(), idempotencyKey: ' bad ' },
    { ...command(), syntheticComparison: undefined },
  ])
    expect(aiSettingsWriteV1Schema.safeParse(invalid).success).toBe(false);
});
test('general IDs do not authorize an additional provider exposure', () => {
  expect(validateAiCatalogExposureV1(catalog(), ['openai'])).toBe(true);
  const another = aiExecutionCatalogV1Schema.parse({
    ...catalog(),
    providers: [{ ...provider(), providerId: 'other-provider' }],
    recommendedDefault: null,
    recommendedSyntheticComparison: { kind: 'off' },
  });
  expect(validateAiCatalogExposureV1(another, ['openai'])).toBe(false);
  expect(validateAiCatalogExposureV1(catalog(), ['openai', 'openai'])).toBe(false);
});
