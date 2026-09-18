import { describe, expect, it } from 'vitest';
import fixture from '../../../tests/fixtures/fit-activity-bout-export.json';
import { activityDetailsV3Schema } from '../src/activity-details.js';
import { activityExportSchema, importActivitySchema } from '../src/activity.js';

const exported: unknown = fixture;
const command = fixture.imports[0];
if (!command) throw new Error('Missing synthetic FIT parent');

describe('V022-A29 FIT parent and bounded bouts', () => {
  it('accepts one canonical parent and a complete non-overlapping elapsed partition', () => {
    const parsed = activityExportSchema.parse(exported);
    expect(parsed).toEqual(fixture);
    expect(parsed.schemaVersion).toBe(4);
    expect(parsed.imports).toHaveLength(1);
    expect(command.activity.durationSeconds).toBe(3600);
    expect(command.details.allocation.bouts.map((bout) => bout.kind)).toEqual([
      'running',
      'strength',
      'mixed_unallocated',
    ]);
    const elapsed = command.details.allocation.bouts.map(
      (bout) => (Date.parse(bout.endedAtExclusive) - Date.parse(bout.startedAt)) / 1000,
    );
    expect(elapsed).toEqual([2400, 600, 600]);
    expect(elapsed.reduce((sum, value) => sum + value, 0)).toBe(3600);
  });

  it('rejects overlap, gaps, out-of-parent and invented sport or lap attribution', () => {
    const details = activityDetailsV3Schema.parse(command.details);
    const original = details.allocation.bouts;
    const bad: unknown[] = [
      {
        ...details,
        allocation: { ...details.allocation, bouts: [original[1], original[0], original[2]] },
      },
      { ...details, allocation: { ...details.allocation, bouts: original.slice(0, 2) } },
      {
        ...details,
        allocation: {
          ...details.allocation,
          bouts: original.map((bout, index) =>
            index === 1 ? { ...bout, endedAtExclusive: '2026-09-19T00:00:00Z' } : bout,
          ),
        },
      },
      {
        ...details,
        allocation: {
          ...details.allocation,
          bouts: original.map((bout, index) =>
            index === 2 ? { ...bout, kind: 'strength' } : bout,
          ),
        },
      },
      {
        ...details,
        allocation: {
          ...details.allocation,
          bouts: original.map((bout, index) =>
            index === 0 ? { ...bout, sourceLapIndex: 2 } : bout,
          ),
        },
      },
      {
        ...details,
        allocation: {
          ...details.allocation,
          bouts: original.map((bout, index) => (index === 1 ? { ...bout, kind: 'running' } : bout)),
        },
      },
      {
        ...details,
        allocation: {
          ...details.allocation,
          parent: { ...details.allocation.parent, endedAtExclusive: '2026-09-18T00:00:00Z' },
        },
      },
    ];
    for (const value of bad) expect(activityDetailsV3Schema.safeParse(value).success).toBe(false);
  });

  it('keeps the parent Activity timing tied to V3 detail and excludes V3 from old envelopes', () => {
    expect(importActivitySchema.parse(command)).toEqual(command);
    expect(
      importActivitySchema.safeParse({
        ...command,
        activity: { ...command.activity, durationSeconds: 3700 },
      }).success,
    ).toBe(false);
    expect(
      importActivitySchema.safeParse({
        ...command,
        activity: { ...command.activity, startedAt: '2026-09-18T00:00:00Z' },
      }).success,
    ).toBe(false);
    expect(
      importActivitySchema.safeParse({
        ...command,
        activity: { ...command.activity, kind: 'running' },
      }).success,
    ).toBe(false);
    for (const schemaVersion of [1, 2, 3])
      expect(activityExportSchema.safeParse({ schemaVersion, imports: [command] }).success).toBe(
        false,
      );
  });
});
