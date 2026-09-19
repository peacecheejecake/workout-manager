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

it('requires evidence snapshots in v6 and preserves historical v5 exports unchanged', () => {
  const previous = {
    ...legacy,
    schemaVersion: 5,
    data: {
      ...legacy.data,
      sessionCompletions: [],
      sessionCompletionRevisions: [],
      planScenarios: [],
      planScenarioRevisions: [],
      planScenarioApplications: [],
      coachingThreads: [],
      coachingMessages: [],
    },
  };
  const artifact = {
    ...previous,
    schemaVersion: 6,
    data: {
      ...previous.data,
      evidenceSnapshots: [
        { id: 'synthetic-snapshot', body: null, purged_reason: 'source_deleted' },
      ],
    },
  };
  expect(accountExportSchema.parse(artifact)).toEqual(artifact);
  expect(accountExportSchema.parse(previous)).toEqual(previous);
  expect(accountExportSchema.parse(previous).data).not.toHaveProperty('evidenceSnapshots');
  expect(accountExportSchema.safeParse({ ...previous, schemaVersion: 6 }).success).toBe(false);
  expect(accountExportSchema.safeParse({ ...artifact, schemaVersion: 5 }).success).toBe(false);
});

it('requires both constraint collections in v7 without manufacturing them in v6', () => {
  const previous = {
    ...legacy,
    schemaVersion: 6,
    data: {
      ...legacy.data,
      sessionCompletions: [],
      sessionCompletionRevisions: [],
      planScenarios: [],
      planScenarioRevisions: [],
      planScenarioApplications: [],
      coachingThreads: [],
      coachingMessages: [],
      evidenceSnapshots: [],
    },
  };
  const artifact = {
    ...previous,
    schemaVersion: 7,
    data: {
      ...previous.data,
      coachingConstraints: [{ id: 'constraint', revision: 2, text: null, deleted: true }],
      coachingConstraintHeads: [{ revision: 2 }],
    },
  };
  expect(accountExportSchema.parse(artifact)).toEqual(artifact);
  expect(accountExportSchema.parse(previous)).toEqual(previous);
  expect(accountExportSchema.parse(previous).data).not.toHaveProperty('coachingConstraints');
  expect(accountExportSchema.safeParse({ ...previous, schemaVersion: 7 }).success).toBe(false);
  expect(accountExportSchema.safeParse({ ...artifact, schemaVersion: 6 }).success).toBe(false);
  for (const key of ['coachingConstraints', 'coachingConstraintHeads']) {
    expect(
      accountExportSchema.safeParse({ ...artifact, data: { ...artifact.data, [key]: undefined } })
        .success,
    ).toBe(false);
  }
});

it('requires coaching run and output collections in v8 while preserving historical v7', () => {
  const previous = {
    ...legacy,
    schemaVersion: 7,
    data: {
      ...legacy.data,
      sessionCompletions: [],
      sessionCompletionRevisions: [],
      planScenarios: [],
      planScenarioRevisions: [],
      planScenarioApplications: [],
      coachingThreads: [],
      coachingMessages: [],
      evidenceSnapshots: [],
      coachingConstraints: [],
      coachingConstraintHeads: [],
    },
  };
  const artifact = {
    ...previous,
    schemaVersion: 8,
    data: {
      ...previous.data,
      coachingRuns: [{ id: 'synthetic-run', basis: { schemaVersion: 1 } }],
      coachingAnalysisOutputs: [
        {
          id: 'synthetic-output',
          run_id: 'synthetic-run',
          body: null,
          purged_reason: 'source_deleted',
        },
      ],
    },
  };
  expect(accountExportSchema.parse(previous)).toEqual(previous);
  expect(accountExportSchema.parse(previous).data).not.toHaveProperty('coachingRuns');
  expect(accountExportSchema.parse(artifact)).toEqual(artifact);
  expect(accountExportSchema.safeParse({ ...previous, schemaVersion: 8 }).success).toBe(false);
  expect(accountExportSchema.safeParse({ ...artifact, schemaVersion: 7 }).success).toBe(false);
  for (const key of ['coachingRuns', 'coachingAnalysisOutputs']) {
    expect(
      accountExportSchema.safeParse({ ...artifact, data: { ...artifact.data, [key]: undefined } })
        .success,
    ).toBe(false);
  }
});

it('requires immutable coaching collections in v9 while preserving historical v8', () => {
  const previous = {
    ...legacy,
    schemaVersion: 8,
    data: {
      ...legacy.data,
      sessionCompletions: [],
      sessionCompletionRevisions: [],
      planScenarios: [],
      planScenarioRevisions: [],
      planScenarioApplications: [],
      coachingThreads: [],
      coachingMessages: [],
      evidenceSnapshots: [],
      coachingConstraints: [],
      coachingConstraintHeads: [],
      coachingRuns: [],
      coachingAnalysisOutputs: [],
    },
  };
  const artifact = {
    ...previous,
    schemaVersion: 9,
    data: {
      ...previous.data,
      coachingDecisions: [{ id: 'synthetic-decision', body: null }],
      coachingProposals: [{ id: 'synthetic-proposal', body: null }],
      coachingCandidates: [{ id: 'synthetic-candidate', digest: null, body: null }],
    },
  };
  expect(accountExportSchema.parse(previous)).toEqual(previous);
  expect(accountExportSchema.parse(previous).data).not.toHaveProperty('coachingCandidates');
  expect(accountExportSchema.parse(artifact)).toEqual(artifact);
  expect(accountExportSchema.safeParse({ ...previous, schemaVersion: 9 }).success).toBe(false);
  expect(accountExportSchema.safeParse({ ...artifact, schemaVersion: 8 }).success).toBe(false);
  for (const key of ['coachingDecisions', 'coachingProposals', 'coachingCandidates']) {
    expect(
      accountExportSchema.safeParse({ ...artifact, data: { ...artifact.data, [key]: undefined } })
        .success,
    ).toBe(false);
  }
});

it('requires nutrition collections in v10 while preserving v9 artifacts', () => {
  const historical = accountExportSchema.parse({
    schemaVersion: 9,
    athleteId: 'athlete-1',
    exportedAt: '2026-09-18T00:00:00.000Z',
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
      sessionCompletions: [],
      sessionCompletionRevisions: [],
      planScenarios: [],
      planScenarioRevisions: [],
      planScenarioApplications: [],
      coachingThreads: [],
      coachingMessages: [],
      evidenceSnapshots: [],
      coachingConstraints: [],
      coachingConstraintHeads: [],
      coachingRuns: [],
      coachingAnalysisOutputs: [],
      coachingDecisions: [],
      coachingProposals: [],
      coachingCandidates: [],
    },
  });
  const nutrition = {
    nutritionPlanVersions: [],
    nutritionPlanHeads: [],
    nutritionPlanHistory: [],
    foodDefinitionVersions: [],
    foodDefinitionHeads: [],
    intakeEntries: [],
    intakeEntryRevisions: [],
  };
  const current = { ...historical, schemaVersion: 10, data: { ...historical.data, ...nutrition } };
  expect(accountExportSchema.parse(current)).toEqual(current);
  expect(accountExportSchema.safeParse({ ...historical, schemaVersion: 10 }).success).toBe(false);
  expect(accountExportSchema.parse(historical).data).not.toHaveProperty('intakeEntries');
});

it('requires supplementary collections in v11 while preserving v10 artifacts', () => {
  const v10 = accountExportSchema.parse({
    schemaVersion: 10,
    athleteId: legacy.athleteId,
    exportedAt: legacy.exportedAt,
    data: {
      ...legacy.data,
      sessionCompletions: [],
      sessionCompletionRevisions: [],
      planScenarios: [],
      planScenarioRevisions: [],
      planScenarioApplications: [],
      coachingThreads: [],
      coachingMessages: [],
      evidenceSnapshots: [],
      coachingConstraints: [],
      coachingConstraintHeads: [],
      coachingRuns: [],
      coachingAnalysisOutputs: [],
      coachingDecisions: [],
      coachingProposals: [],
      coachingCandidates: [],
      nutritionPlanVersions: [],
      nutritionPlanHeads: [],
      nutritionPlanHistory: [],
      foodDefinitionVersions: [],
      foodDefinitionHeads: [],
      intakeEntries: [],
      intakeEntryRevisions: [],
    },
  });
  const supplementary = {
    supplementaryExerciseVersions: [],
    supplementaryExerciseHeads: [],
    supplementaryRoutineVersions: [],
    supplementaryRoutineHeads: [],
    supplementaryRoutineTargetRefs: [],
    supplementarySessionLinks: [],
    supplementarySessionTargetRefs: [],
    supplementaryExecutions: [],
    supplementarySetLogs: [],
    supplementarySetLogRevisions: [],
    supplementaryRestTimers: [],
  };
  const v11 = { ...v10, schemaVersion: 11, data: { ...v10.data, ...supplementary } };
  expect(accountExportSchema.parse(v11)).toEqual(v11);
  expect(accountExportSchema.safeParse({ ...v10, schemaVersion: 11 }).success).toBe(false);
  expect(accountExportSchema.parse(v10).data).not.toHaveProperty('supplementaryExecutions');
});

it('requires private resource collections in v12 while preserving v11 artifacts', () => {
  const v11 = accountExportSchema.parse({
    schemaVersion: 11,
    athleteId: legacy.athleteId,
    exportedAt: legacy.exportedAt,
    data: {
      ...legacy.data,
      sessionCompletions: [],
      sessionCompletionRevisions: [],
      planScenarios: [],
      planScenarioRevisions: [],
      planScenarioApplications: [],
      coachingThreads: [],
      coachingMessages: [],
      evidenceSnapshots: [],
      coachingConstraints: [],
      coachingConstraintHeads: [],
      coachingRuns: [],
      coachingAnalysisOutputs: [],
      coachingDecisions: [],
      coachingProposals: [],
      coachingCandidates: [],
      nutritionPlanVersions: [],
      nutritionPlanHeads: [],
      nutritionPlanHistory: [],
      foodDefinitionVersions: [],
      foodDefinitionHeads: [],
      intakeEntries: [],
      intakeEntryRevisions: [],
      supplementaryExerciseVersions: [],
      supplementaryExerciseHeads: [],
      supplementaryRoutineVersions: [],
      supplementaryRoutineHeads: [],
      supplementaryRoutineTargetRefs: [],
      supplementarySessionLinks: [],
      supplementarySessionTargetRefs: [],
      supplementaryExecutions: [],
      supplementarySetLogs: [],
      supplementarySetLogRevisions: [],
      supplementaryRestTimers: [],
    },
  });
  const v12 = {
    ...v11,
    schemaVersion: 12,
    data: { ...v11.data, resources: [], resourceVersions: [] },
  };
  expect(accountExportSchema.parse(v12)).toEqual(v12);
  expect(accountExportSchema.safeParse({ ...v11, schemaVersion: 12 }).success).toBe(false);
  expect(accountExportSchema.parse(v11).data).not.toHaveProperty('resources');
});

it('reads file-safe resource exports in v13 while preserving v12 artifacts', () => {
  const v12 = accountExportSchema.parse({
    schemaVersion: 12,
    athleteId: legacy.athleteId,
    exportedAt: legacy.exportedAt,
    data: {
      ...legacy.data,
      sessionCompletions: [],
      sessionCompletionRevisions: [],
      planScenarios: [],
      planScenarioRevisions: [],
      planScenarioApplications: [],
      coachingThreads: [],
      coachingMessages: [],
      evidenceSnapshots: [],
      coachingConstraints: [],
      coachingConstraintHeads: [],
      coachingRuns: [],
      coachingAnalysisOutputs: [],
      coachingDecisions: [],
      coachingProposals: [],
      coachingCandidates: [],
      nutritionPlanVersions: [],
      nutritionPlanHeads: [],
      nutritionPlanHistory: [],
      foodDefinitionVersions: [],
      foodDefinitionHeads: [],
      intakeEntries: [],
      intakeEntryRevisions: [],
      supplementaryExerciseVersions: [],
      supplementaryExerciseHeads: [],
      supplementaryRoutineVersions: [],
      supplementaryRoutineHeads: [],
      supplementaryRoutineTargetRefs: [],
      supplementarySessionLinks: [],
      supplementarySessionTargetRefs: [],
      supplementaryExecutions: [],
      supplementarySetLogs: [],
      supplementarySetLogRevisions: [],
      supplementaryRestTimers: [],
      resources: [],
      resourceVersions: [],
    },
  });
  const v13 = { ...v12, schemaVersion: 13 };
  expect(accountExportSchema.parse(v13)).toEqual(v13);
  expect(accountExportSchema.parse(v12)).toEqual(v12);
});
