import { expect, it } from 'vitest';
import { checkInDefinition } from '../src/check-ins.js';
import { checkInTemplateVersionSchema } from '../src/check-in-templates.js';
import {
  checkInTemplateExportDataSchema,
  checkInTemplateExportVersionRowSchema,
} from '../src/check-in-template-export.js';
const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const at = '2026-10-08T00:00:00.123456Z';
function row(version = 1, templateId = id(1), versionId = id(version + 10)) {
  const body = checkInTemplateVersionSchema.parse({
    templateId,
    versionId,
    version,
    previousVersionId: version === 1 ? null : id(version + 9),
    previousVersion: version === 1 ? null : version - 1,
    createdAt: at,
    content: {
      definitionVersion: checkInDefinition.version,
      source: checkInDefinition.source,
      method: checkInDefinition.method,
      title: '직접 보고 질문',
      instructions: null,
      fields: ['note', 'fatigue', 'bodyLocation', 'discomfort'],
    },
  });
  return {
    template_id: templateId,
    version_id: versionId,
    version,
    previous_version_id: body.previousVersionId,
    previous_version: body.previousVersion,
    created_at: at,
    record_json: body,
  };
}
function data() {
  return {
    checkInTemplateVersions: [row(2), row(1)],
    checkInTemplateHeads: [{ template_id: id(1), version_id: id(12), version: 2 }],
  };
}
it('retains original row/field order, nullable instructions and the full historical chain', () => {
  const input = data();
  expect(checkInTemplateExportDataSchema.parse(input)).toEqual(input);
});
it('normalizes UUID identity case consistently without reordering semantic arrays', () => {
  const input = data();
  input.checkInTemplateHeads[0] = {
    template_id: id(1).toUpperCase(),
    version_id: id(12).toUpperCase(),
    version: 2,
  };
  expect(checkInTemplateExportDataSchema.parse(input)).toEqual(data());
});
it('accepts exact equivalent offsets but rejects microsecond truncation and extra precision', () => {
  const input = row();
  expect(
    checkInTemplateExportVersionRowSchema.safeParse({
      ...input,
      created_at: '2026-10-08T09:00:00.123456+09:00',
    }).success,
  ).toBe(true);
  for (const created_at of ['2026-10-08T00:00:00.123Z', '2026-10-08T00:00:00.1234567Z'])
    expect(checkInTemplateExportVersionRowSchema.safeParse({ ...input, created_at }).success).toBe(
      false,
    );
});
it('requires both collections rather than fabricating unsupported/absent data', () => {
  expect(
    checkInTemplateExportDataSchema.parse({
      checkInTemplateVersions: [],
      checkInTemplateHeads: [],
    }),
  ).toEqual({ checkInTemplateVersions: [], checkInTemplateHeads: [] });
  for (const input of [
    {},
    { checkInTemplateVersions: [] },
    { checkInTemplateHeads: [] },
    null,
    { profile: 'unsupported' },
  ])
    expect(checkInTemplateExportDataSchema.safeParse(input).success).toBe(false);
});
it('rejects physical/body identity, revision and previous tuple mismatches', () => {
  const input = row(2);
  for (const change of [
    { template_id: id(2) },
    { version_id: id(20) },
    { version: 3 },
    { previous_version_id: id(40) },
    { previous_version: 5 },
  ])
    expect(checkInTemplateExportVersionRowSchema.safeParse({ ...input, ...change }).success).toBe(
      false,
    );
});
it('requires exact newest head and every previous version, never substitutes another template', () => {
  const input = data();
  const foreign = row(1, id(2));
  for (const change of [
    { checkInTemplateHeads: [] },
    { checkInTemplateHeads: [{ template_id: id(1), version_id: id(11), version: 1 }] },
    { checkInTemplateHeads: [{ template_id: id(2), version_id: id(12), version: 2 }] },
    { checkInTemplateVersions: [row(2)] },
    { checkInTemplateVersions: [row(2), foreign] },
  ])
    expect(checkInTemplateExportDataSchema.safeParse({ ...input, ...change }).success).toBe(false);
});
it('rejects version UUID, template-number and head duplicates including case variants', () => {
  const input = data();
  for (const extra of [
    row(1),
    { ...row(1), version_id: id(11).toUpperCase() },
    { ...row(1), version_id: id(99), record_json: { ...row(1).record_json, versionId: id(99) } },
  ])
    expect(
      checkInTemplateExportDataSchema.safeParse({
        ...input,
        checkInTemplateVersions: [...input.checkInTemplateVersions, extra],
      }).success,
    ).toBe(false);
  expect(
    checkInTemplateExportDataSchema.safeParse({
      ...input,
      checkInTemplateHeads: [...input.checkInTemplateHeads, input.checkInTemplateHeads[0]],
    }).success,
  ).toBe(false);
});
it('rejects foreign extra facts, unknown keys, executable receipt metadata and missing physical nulls', () => {
  const input = row();
  const { previous_version_id, ...missing } = input;
  expect(previous_version_id).toBeNull();
  for (const change of [
    { ...input, request_digest: 'a'.repeat(64) },
    { ...input, athlete_id: 'foreign' },
    missing,
    { ...input, record_json: { ...input.record_json, authority: true } },
  ])
    expect(checkInTemplateExportVersionRowSchema.safeParse(change).success).toBe(false);
  expect(
    checkInTemplateExportDataSchema.safeParse({ ...data(), checkInTemplateReceipts: [] }).success,
  ).toBe(false);
});
it('does not convert zero/unknown fields, duplicate prompts or null body into valid template content', () => {
  for (const fields of [['note', 'note'], [0], [null], [], ['actualPerformance']])
    expect(
      checkInTemplateExportVersionRowSchema.safeParse({
        ...row(),
        record_json: { ...row().record_json, content: { ...row().record_json.content, fields } },
      }).success,
    ).toBe(false);
  expect(
    checkInTemplateExportVersionRowSchema.safeParse({ ...row(), record_json: null }).success,
  ).toBe(false);
});
it('bounds collection count and individual original record before decoding', () => {
  expect(
    checkInTemplateExportDataSchema.safeParse({
      ...data(),
      checkInTemplateVersions: Array.from({ length: 1001 }, () => row()),
    }).success,
  ).toBe(false);
  expect(
    checkInTemplateExportVersionRowSchema.safeParse({
      ...row(),
      record_json: { ...row().record_json, padding: 'x'.repeat(16384) },
    }).success,
  ).toBe(false);
});
it('rejects getters without invoking them, cycles, sparse arrays and nonfinite JSON', () => {
  let reads = 0;
  const input = {
    get checkInTemplateVersions() {
      reads++;
      return [];
    },
    checkInTemplateHeads: [],
  };
  expect(checkInTemplateExportDataSchema.safeParse(input).success).toBe(false);
  expect(reads).toBe(0);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const value of [
    cycle,
    { ...data(), other: Infinity },
    { checkInTemplateVersions: Array(2), checkInTemplateHeads: [] },
  ])
    expect(checkInTemplateExportDataSchema.safeParse(value).success).toBe(false);
});
it('accepts the full 1000-row closed chain with its exact head', () => {
  const versions = Array.from({ length: 1000 }, (_, index) => row(index + 1));
  const input = {
    checkInTemplateVersions: versions,
    checkInTemplateHeads: [{ template_id: id(1), version_id: id(1010), version: 1000 }],
  };
  expect(checkInTemplateExportDataSchema.parse(input)).toEqual(input);
});
it('rejects retained whitespace mutations instead of silently trimming the original content', () => {
  for (const content of [
    { ...row().record_json.content, title: ' 제목 ' },
    { ...row().record_json.content, instructions: ' 안내 ' },
  ])
    expect(
      checkInTemplateExportVersionRowSchema.safeParse({
        ...row(),
        record_json: { ...row().record_json, content },
      }).success,
    ).toBe(false);
});
it('rejects oversized standalone raw JSON before parsing collections', () => {
  expect(
    checkInTemplateExportDataSchema.safeParse({ ...data(), body: '한'.repeat(3 * 1024 * 1024) })
      .success,
  ).toBe(false);
});
it('converts throwing reflection/serialization traps into finite safeParse issues', () => {
  const throwTrap = () => {
    throw Error('UNTRUSTED_TRAP');
  };
  const values = [
    new Proxy(data(), { getPrototypeOf: throwTrap }),
    new Proxy(data(), { ownKeys: throwTrap }),
    new Proxy(data(), { getOwnPropertyDescriptor: throwTrap }),
    new Proxy(data(), { get: throwTrap }),
  ];
  for (const value of values) {
    const schema = checkInTemplateExportDataSchema;
    expect(() => schema.safeParse(value)).not.toThrow();
    const result = schema.safeParse(value);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.some((issue) => issue.code === 'custom')).toBe(true);
  }
  const body = { ...row(), record_json: new Proxy(row().record_json, { ownKeys: throwTrap }) };
  expect(() => checkInTemplateExportVersionRowSchema.safeParse(body)).not.toThrow();
  expect(checkInTemplateExportVersionRowSchema.safeParse(body).success).toBe(false);
});
it('rejects array subclasses and throwing accessors without invoking getters', () => {
  class UnexpectedArray extends Array<unknown> {}
  const input = { checkInTemplateVersions: new UnexpectedArray(), checkInTemplateHeads: [] };
  expect(checkInTemplateExportDataSchema.safeParse(input).success).toBe(false);
  let calls = 0;
  const getter = {
    get checkInTemplateVersions() {
      calls++;
      throw Error('GETTER');
    },
    checkInTemplateHeads: [],
  };
  expect(() => checkInTemplateExportDataSchema.safeParse(getter)).not.toThrow();
  expect(checkInTemplateExportDataSchema.safeParse(getter).success).toBe(false);
  expect(calls).toBe(0);
});
