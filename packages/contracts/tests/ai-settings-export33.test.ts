import { expect, it } from 'vitest';
import { accountExportSchema } from '../src/operations';
function artifact(version = 33) {
  const schema = accountExportSchema.options.find((s) => s.shape.schemaVersion.value === version);
  if (!schema) throw new Error('Missing historical schema');
  return {
    schemaVersion: version,
    athleteId: 'synthetic-settings-export',
    exportedAt: '2026-10-07T00:00:00Z',
    data: Object.fromEntries(schema.shape.data.keyof().options.map((k) => [k, []])),
  };
}
const selected = {
  revision: 1,
  updated_at: '2026-10-07T00:00:00+00:00',
  catalog_revision: 1,
  policy_version: 'policy:1',
  disclosure_version: 'disclosure:1',
  default_provider_id: 'openai',
  default_model_id: 'historically-removed-model',
  comparison_kind: 'selected',
  comparison_provider_id: 'openai',
  comparison_model_id: 'historically-removed-comparison',
};
function withRows(row: unknown = selected) {
  const a = artifact();
  return {
    ...a,
    data: { ...a.data, aiSettingsHeads: [{ revision: 1 }], aiSettingsRevisions: [row] },
  };
}
it('reads exact portable selection history without a live model catalog', () => {
  const a = withRows();
  expect(accountExportSchema.parse(a)).toEqual(a);
  expect(accountExportSchema.parse(artifact())).toEqual(artifact());
  expect(
    accountExportSchema.safeParse(
      withRows({
        ...selected,
        default_provider_id: null,
        default_model_id: null,
        comparison_kind: 'off',
        comparison_provider_id: null,
        comparison_model_id: null,
      }),
    ).success,
  ).toBe(true);
});
it('preserves every historical discriminator2 through32 without manufacturing new collections', () => {
  for (let version = 2; version <= 32; version++) {
    const a = artifact(version);
    expect(accountExportSchema.parse(a)).toEqual(a);
    expect(accountExportSchema.parse(a).data).not.toHaveProperty('aiSettingsHeads');
    expect(accountExportSchema.safeParse({ ...a, schemaVersion: 33 }).success).toBe(false);
  }
});
it('rejects unknown permission, command and secret fields on both strict rows', () => {
  for (const key of [
    'receipt_key',
    'request_digest',
    'api_key',
    'activepermission',
    'athlete_id',
  ]) {
    expect(
      accountExportSchema.safeParse(withRows({ ...selected, [key]: 'forbidden' })).success,
    ).toBe(false);
    const a = withRows();
    expect(
      accountExportSchema.safeParse({
        ...a,
        data: { ...a.data, aiSettingsHeads: [{ revision: 1, [key]: 'forbidden' }] },
      }).success,
    ).toBe(false);
  }
  const a = artifact();
  expect(
    accountExportSchema.safeParse({ ...a, data: { ...a.data, openaiBudgetJournal: [] } }).success,
  ).toBe(false);
});
it('rejects malformed revisions, dates, identifiers and absent mandatory fields', () => {
  for (const row of [
    { ...selected, revision: 0 },
    { ...selected, revision: 2147483648 },
    { ...selected, catalog_revision: 0 },
    { ...selected, updated_at: 'not-a-date' },
    { ...selected, policy_version: ' unsafe ' },
    { ...selected, default_provider_id: 'OpenAI' },
    { ...selected, default_model_id: undefined },
    { ...selected, disclosure_version: undefined },
  ])
    expect(accountExportSchema.safeParse(withRows(row)).success).toBe(false);
  const a = artifact();
  expect(
    accountExportSchema.safeParse({ ...a, data: { ...a.data, aiSettingsHeads: undefined } })
      .success,
  ).toBe(false);
  expect(
    accountExportSchema.safeParse({ ...a, data: { ...a.data, aiSettingsRevisions: undefined } })
      .success,
  ).toBe(false);
});
it('distinguishes null pairs from partial and invalid off/selected combinations', () => {
  for (const row of [
    { ...selected, default_provider_id: null },
    { ...selected, default_model_id: null },
    { ...selected, comparison_provider_id: null },
    { ...selected, comparison_model_id: null },
    { ...selected, comparison_kind: 'off' },
    { ...selected, comparison_kind: 'estimated' },
  ])
    expect(accountExportSchema.safeParse(withRows(row)).success).toBe(false);
  expect(
    accountExportSchema.safeParse(
      withRows({ ...selected, revision: 2147483647, catalog_revision: 2147483647 }),
    ).success,
  ).toBe(true);
});
it('enforces head max1 and history max1000 without silently truncating', () => {
  const a = withRows();
  expect(
    accountExportSchema.safeParse({
      ...a,
      data: { ...a.data, aiSettingsHeads: [{ revision: 1 }, { revision: 2 }] },
    }).success,
  ).toBe(false);
  expect(
    accountExportSchema.safeParse({ ...a, data: { ...a.data, aiSettingsHeads: [{ revision: 0 }] } })
      .success,
  ).toBe(false);
  expect(
    accountExportSchema.safeParse({
      ...a,
      data: {
        ...a.data,
        aiSettingsRevisions: Array.from({ length: 1000 }, (_, i) => ({
          ...selected,
          revision: i + 1,
        })),
      },
    }).success,
  ).toBe(true);
  expect(
    accountExportSchema.safeParse({
      ...a,
      data: {
        ...a.data,
        aiSettingsRevisions: Array.from({ length: 1001 }, (_, i) => ({
          ...selected,
          revision: i + 1,
        })),
      },
    }).success,
  ).toBe(false);
});
