import { describe, expect, it } from 'vitest';
import {
  activityTagSchema,
  activityTagsSchema,
  activityOverlaySchema,
  activityOverlayWriteSchema,
  activityListQuerySchema,
  activitySchema,
  importActivitySchema,
} from '../src/activity.js';
import { selectedActivityExportSchema } from '../src/activity-export.js';

const values = {
  title: '원본',
  kind: 'running',
  startedAt: null,
  timezone: null,
  distanceMeters: 0,
  durationSeconds: null,
  durationKind: 'unknown',
};
const source = {
  kind: 'fixture',
  sourceId: 'tag-contract',
  revision: 1,
  contentHash: 'a'.repeat(64),
};
const write = { expectedRevision: 1, idempotencyKey: 'tag-contract-command', reason: '로컬 분류' };
const activity = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  revision: 1,
  source,
  original: values,
  effective: values,
  overlay: {},
};

describe('local activity tags', () => {
  it('normalizes outer whitespace and Unicode, retaining case and literal punctuation', () => {
    expect(
      activityTagsSchema.parse([' cafe\u0301 ', 'Run', 'run', '100%_trail', '공원 달리기']),
    ).toEqual(['café', 'Run', 'run', '100%_trail', '공원 달리기']);
    expect(activityListQuerySchema.parse({ tag: ' cafe\u0301 ' })).toEqual({
      limit: 50,
      offset: 0,
      tag: 'café',
    });
  });
  it('rejects empty, duplicate normalized, oversized and control-containing labels', () => {
    for (const tags of [
      null,
      [' '],
      ['x'.repeat(41)],
      ['café', 'cafe\u0301'],
      ['run', ' run '],
      ['a\nb'],
      ['a\u0000b'],
      ['a\u200bb'],
      ['a\u2028b'],
      Array.from({ length: 21 }, (_, i) => String(i)),
    ])
      expect(activityTagsSchema.safeParse(tags).success).toBe(false);
    expect(activityTagSchema.safeParse('x'.repeat(40)).success).toBe(true);
    expect(activityTagsSchema.parse(Array.from({ length: 20 }, (_, i) => String(i)))).toHaveLength(
      20,
    );
  });
  it('preserves omission and explicit empty sets without injecting tags into measurements', () => {
    expect(activityOverlaySchema.parse({})).not.toHaveProperty('tags');
    expect(activityOverlaySchema.parse({ tags: [] })).toEqual({ tags: [] });
    const tagged = activitySchema.parse({ ...activity, overlay: { tags: ['run'] } });
    expect(tagged.original).toEqual(values);
    expect(tagged.effective).toEqual(values);
    expect(tagged).not.toHaveProperty('userReport');
    for (const field of ['original', 'effective'])
      expect(
        activitySchema.safeParse({ ...activity, [field]: { ...values, tags: ['run'] } }).success,
      ).toBe(false);
    expect(
      importActivitySchema.safeParse({
        idempotencyKey: 'import-tag-command',
        source,
        activity: { ...values, tags: ['run'] },
      }).success,
    ).toBe(false);
  });
  it('requires explicit correction authority and preserves other patches when omitted', () => {
    expect(activityOverlayWriteSchema.parse({ ...write, tags: [] })).toEqual({
      ...write,
      tags: [],
    });
    expect(activityOverlayWriteSchema.parse({ ...write, tags: [' run '] }).tags).toEqual(['run']);
    expect(activityOverlayWriteSchema.parse({ ...write, title: 'edited' })).not.toHaveProperty(
      'tags',
    );
    for (const invalid of [
      { ...write },
      { ...write, tags: null },
      { ...write, tags: ['run'], reason: '' },
      { ...write, tags: ['run'], expectedRevision: 0 },
      { ...write, tags: ['run'], idempotencyKey: '' },
    ])
      expect(activityOverlayWriteSchema.safeParse(invalid).success).toBe(false);
  });
  it('versions tagged summary artifacts and keeps untagged v1 artifacts readable', () => {
    const artifact = {
      schemaVersion: 1,
      format: 'workout-manager-activity-summary',
      generatedAt: '2026-09-17T00:00:00Z',
      consistency: 'per-activity-revision',
      activities: [activity],
    };
    expect(selectedActivityExportSchema.parse(artifact).activities[0]?.overlay).not.toHaveProperty(
      'tags',
    );
    for (const tags of [[], ['café', 'run']]) {
      const activities = [{ ...activity, overlay: { tags } }];
      expect(selectedActivityExportSchema.safeParse({ ...artifact, activities }).success).toBe(
        false,
      );
      expect(
        selectedActivityExportSchema.parse({ ...artifact, schemaVersion: 2, activities })
          .activities[0]?.overlay.tags,
      ).toEqual(tags);
    }
  });
});
