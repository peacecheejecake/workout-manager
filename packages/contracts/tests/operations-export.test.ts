import { describe, expect, it } from 'vitest';
import { accountExportSchema } from '../src/operations';

const legacy = {
  schemaVersion: 2,
  athleteId: 'synthetic-athlete',
  exportedAt: '2026-09-17T00:00:00Z',
  data: {
    consents: [],
    planSnapshots: [],
    planHead: [],
    planHistory: [],
    activities: [],
    activitySources: [],
    sourceRevisions: [],
    overlays: [],
    overlayRevisions: [],
    suppressions: [],
    checkIns: [],
    checkInRevisions: [],
  },
};
describe('account export completion-ledger compatibility', () => {
  it('reads old v2 artifacts without manufacturing absent completion collections', () => {
    expect(accountExportSchema.parse(legacy)).toEqual(legacy);
    expect(accountExportSchema.parse(legacy).data).not.toHaveProperty('sessionCompletions');
  });
  it('requires both completion collections in v3 and preserves their records', () => {
    const artifact = {
      ...legacy,
      schemaVersion: 3,
      data: {
        ...legacy.data,
        sessionCompletions: [
          { session_id: 'session', revision: 1, record_json: { status: 'completed' } },
        ],
        sessionCompletionRevisions: [
          { session_id: 'session', revision: 1, record_json: { status: 'completed' } },
        ],
      },
    };
    expect(accountExportSchema.parse(artifact)).toEqual(artifact);
    expect(accountExportSchema.safeParse({ ...legacy, schemaVersion: 3 }).success).toBe(false);
    expect(accountExportSchema.safeParse({ ...artifact, schemaVersion: 2 }).success).toBe(false);
    expect(
      accountExportSchema.safeParse({
        ...artifact,
        data: { ...artifact.data, sessionCompletions: undefined },
      }).success,
    ).toBe(false);
  });
});
