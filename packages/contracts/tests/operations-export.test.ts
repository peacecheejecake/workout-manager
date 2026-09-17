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
  it('requires all scenario collections in v4 while leaving v2/v3 artifacts unchanged', () => {
    const previous = {
      ...legacy,
      schemaVersion: 3,
      data: { ...legacy.data, sessionCompletions: [], sessionCompletionRevisions: [] },
    };
    const artifact = {
      ...previous,
      schemaVersion: 4,
      data: {
        ...previous.data,
        planScenarios: [{ id: 'synthetic-scenario', revision: 2 }],
        planScenarioRevisions: [{ scenario_id: 'synthetic-scenario', revision: 1 }],
        planScenarioApplications: [{ scenario_id: 'synthetic-scenario', scenario_revision: 2 }],
      },
    };
    expect(accountExportSchema.parse(artifact)).toEqual(artifact);
    expect(accountExportSchema.parse(previous)).toEqual(previous);
    expect(accountExportSchema.parse(previous).data).not.toHaveProperty('planScenarios');
    expect(accountExportSchema.safeParse({ ...previous, schemaVersion: 4 }).success).toBe(false);
    expect(accountExportSchema.safeParse({ ...artifact, schemaVersion: 3 }).success).toBe(false);
    for (const key of ['planScenarios', 'planScenarioRevisions', 'planScenarioApplications']) {
      expect(
        accountExportSchema.safeParse({ ...artifact, data: { ...artifact.data, [key]: undefined } })
          .success,
      ).toBe(false);
    }
  });
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

it('requires conversation collections in v5 without changing v4 artifacts', () => {
  const previous = {
    ...legacy,
    schemaVersion: 4,
    data: {
      ...legacy.data,
      sessionCompletions: [],
      sessionCompletionRevisions: [],
      planScenarios: [],
      planScenarioRevisions: [],
      planScenarioApplications: [],
    },
  };
  const artifact = {
    ...previous,
    schemaVersion: 5,
    data: {
      ...previous.data,
      coachingThreads: [{ id: 'synthetic-thread', revision: 2 }],
      coachingMessages: [{ thread_id: 'synthetic-thread', revision: 1, content: 'User report' }],
    },
  };
  expect(accountExportSchema.parse(artifact)).toEqual(artifact);
  expect(accountExportSchema.parse(previous)).toEqual(previous);
  expect(accountExportSchema.parse(previous).data).not.toHaveProperty('coachingThreads');
  expect(accountExportSchema.safeParse({ ...previous, schemaVersion: 5 }).success).toBe(false);
  expect(accountExportSchema.safeParse({ ...artifact, schemaVersion: 4 }).success).toBe(false);
  for (const key of ['coachingThreads', 'coachingMessages']) {
    expect(
      accountExportSchema.safeParse({ ...artifact, data: { ...artifact.data, [key]: undefined } })
        .success,
    ).toBe(false);
  }
});
