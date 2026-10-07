import { describe, expect, it } from 'vitest';
import { checkInValuesSchema } from '../src/check-ins.js';
import {
  checkInTemplateContentSchema,
  checkInTemplateVersionSchema,
  saveCheckInTemplateSchema,
} from '../src/check-in-templates.js';

const templateId = '00000000-0000-4000-8000-000000000001';
const versionId = '00000000-0000-4000-8000-000000000002';
const previousVersionId = '00000000-0000-4000-8000-000000000003';
const content = {
  definitionVersion: 'checkin-v1',
  source: 'user',
  method: 'self_report',
  title: '훈련 전 확인',
  instructions: null,
  fields: ['fatigue', 'discomfort'],
};
const initial = {
  templateId,
  versionId,
  version: 1,
  previousVersionId: null,
  previousVersion: null,
  createdAt: '2026-10-08T00:00:00.000Z',
  content,
};

describe('versioned report prompts', () => {
  it('preserves the selected report order without synthesizing observations', () => {
    expect(checkInTemplateContentSchema.parse(content)).toEqual(content);
    expect(
      saveCheckInTemplateSchema.parse({
        templateId,
        expectedVersion: 0,
        idempotencyKey: 'template_create_1',
        content,
      }).expectedVersion,
    ).toBe(0);
  });
  it.each([
    { fields: [] },
    { fields: ['fatigue', 'fatigue'] },
    { fields: ['heartRate'] },
    { fields: ['fatigue', 'discomfort', 'bodyLocation', 'note', 'fatigue'] },
  ])('rejects invalid or duplicate selected report fields: %j', ({ fields }) => {
    expect(checkInTemplateContentSchema.safeParse({ ...content, fields }).success).toBe(false);
  });
  it.each([
    { observedAt: '2026-10-08T00:00:00Z' },
    { fatigue: 0 },
    { provider: 'healthkit' },
    { diagnosticScore: 1 },
    { athleteId: templateId },
  ])('does not accept observations, authority or ownership inside content: %j', (extra) => {
    expect(checkInTemplateContentSchema.safeParse({ ...content, ...extra }).success).toBe(false);
  });
  it('does not relabel provider values or change the existing report definition', () => {
    for (const extra of [
      { source: 'device' },
      { method: 'measured' },
      { definitionVersion: 'checkin-v2' },
    ])
      expect(checkInTemplateContentSchema.safeParse({ ...content, ...extra }).success).toBe(false);
  });
  it('validates the exact initial and successor immutable version lineage', () => {
    expect(checkInTemplateVersionSchema.parse(initial)).toEqual(initial);
    expect(
      checkInTemplateVersionSchema.safeParse({
        ...initial,
        version: 2,
        previousVersion: 1,
        previousVersionId,
      }).success,
    ).toBe(true);
    for (const extra of [
      { previousVersionId },
      { version: 2 },
      { version: 3, previousVersion: 1, previousVersionId },
      { version: 2, previousVersion: 1, previousVersionId: versionId },
    ])
      expect(checkInTemplateVersionSchema.safeParse({ ...initial, ...extra }).success).toBe(false);
  });
  it('keeps zero reports and unknown reports distinct in the existing actual ledger', () => {
    const values = {
      observedAt: '2026-10-08T00:00:00Z',
      timezone: 'Asia/Seoul',
      fatigue: 0,
      discomfort: null,
      bodyLocation: null,
      note: null,
    };
    expect(checkInValuesSchema.parse(values)).toEqual(values);
    expect(checkInValuesSchema.safeParse({ ...values, fatigue: null }).success).toBe(false);
  });
  it('does not permit a self predecessor through alternate UUID spelling', () => {
    const mixedId = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
    expect(
      checkInTemplateVersionSchema.safeParse({
        ...initial,
        versionId: mixedId,
        version: 2,
        previousVersion: 1,
        previousVersionId: mixedId.toUpperCase(),
      }).success,
    ).toBe(false);
    expect(
      saveCheckInTemplateSchema.parse({
        templateId: mixedId.toUpperCase(),
        expectedVersion: 0,
        idempotencyKey: 'template_create_1',
        content,
      }).templateId,
    ).toBe(mixedId);
  });
  it('rejects authority overrides on save commands and invalid CAS/key values', () => {
    const command = {
      templateId,
      expectedVersion: 0,
      idempotencyKey: 'template_create_1',
      content,
    };
    for (const extra of [
      { expectedVersion: -1 },
      { expectedVersion: 0.5 },
      { athleteId: templateId },
      { versionId },
      { idempotencyKey: 'short' },
    ])
      expect(saveCheckInTemplateSchema.safeParse({ ...command, ...extra }).success).toBe(false);
  });
});
