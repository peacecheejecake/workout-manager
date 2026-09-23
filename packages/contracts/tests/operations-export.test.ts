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

it('requires URL ingestion collections in v14 while preserving v13 artifacts', () => {
  const v13 = accountExportSchema.parse({
    schemaVersion: 13,
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
  const urlCollections = {
    resourceUrlIngestions: [],
    resourceUrlAttempts: [],
    resourceUrlFetchHops: [],
    resourceUrlArtifacts: [],
    resourceUrlProvenance: [],
    resourceUrlLocators: [],
  };
  const v14 = { ...v13, schemaVersion: 14, data: { ...v13.data, ...urlCollections } };
  expect(accountExportSchema.parse(v14)).toEqual(v14);
  expect(accountExportSchema.safeParse({ ...v13, schemaVersion: 14 }).success).toBe(false);
  expect(accountExportSchema.parse(v13).data).not.toHaveProperty('resourceUrlIngestions');
});

it('requires resource access collections in v15 while preserving v14 artifacts', () => {
  const v14 = accountExportSchema.parse({
    schemaVersion: 14,
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
      resourceUrlIngestions: [],
      resourceUrlAttempts: [],
      resourceUrlFetchHops: [],
      resourceUrlArtifacts: [],
      resourceUrlProvenance: [],
      resourceUrlLocators: [],
    },
  });
  const accessCollections = {
    resourceShares: [
      {
        share_id: '11111111-1111-4111-8111-111111111111',
        resource_id: '22222222-2222-4222-8222-222222222222',
        grantee_kind: 'coach',
        grantee_principal_id: 'coach-1',
        state: 'active',
        granted_access_revision: 2,
        revoked_access_revision: null,
        granted_at: '2026-09-20T00:00:00.000Z',
        revoked_at: null,
        updated_at: '2026-09-20T00:00:00.000Z',
      },
    ],
    resourceAccessAudit: [
      {
        event_id: '33333333-3333-4333-8333-333333333333',
        resource_id: '22222222-2222-4222-8222-222222222222',
        action: 'share_granted',
        access_revision: 2,
        share_id: '11111111-1111-4111-8111-111111111111',
        grantee_kind: 'coach',
        grantee_principal_id: 'coach-1',
        occurred_at: '2026-09-20T00:00:00.000Z',
      },
    ],
  };
  const v15 = { ...v14, schemaVersion: 15, data: { ...v14.data, ...accessCollections } };
  expect(accountExportSchema.parse(v15)).toEqual(v15);
  // v15 requires both new collections and never manufactures them for v14.
  expect(accountExportSchema.safeParse({ ...v14, schemaVersion: 15 }).success).toBe(false);
  expect(
    accountExportSchema.safeParse({
      ...v14,
      schemaVersion: 15,
      data: { ...v14.data, resourceShares: [] },
    }).success,
  ).toBe(false);
  expect(accountExportSchema.parse(v14).data).not.toHaveProperty('resourceShares');
  // Every collection v14 carried is still required by v15.
  expect(
    accountExportSchema.safeParse({
      ...v15,
      data: { ...v15.data, resourceUrlLocators: undefined },
    }).success,
  ).toBe(false);
});

it('parses the currently integrated export version without dropping access facts', () => {
  const current = accountExportSchema.parse({
    schemaVersion: 21,
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
      resourceUrlIngestions: [],
      resourceUrlAttempts: [],
      resourceUrlFetchHops: [],
      resourceUrlArtifacts: [],
      resourceUrlProvenance: [],
      resourceUrlLocators: [],
      resourceShares: [],
      resourceAccessAudit: [],
      galleryMediaItems: [],
      galleryMediaDerivatives: [],
      resourcePassages: [],
      resourceGroundings: [],
      resourceGroundingExcerpts: [],
      resourceCitations: [],
      activityTracks: [],
      activityTrackRevisions: [],
      courses: [],
      courseRevisions: [],
      coursePreferences: [],
      coursePrivacyZones: [],
      courseThumbnails: [],
    },
  });
  if (current.schemaVersion !== 21) throw new Error('Expected the integrated export version');
  expect(current.data.resourceShares).toEqual([]);
  expect(current.data.resourceAccessAudit).toEqual([]);
  expect(current.data.resourcePassages).toEqual([]);
  expect(current.data.resourceCitations).toEqual([]);
  expect(current.data.activityTracks).toEqual([]);
  expect(current.data.activityTrackRevisions).toEqual([]);
  expect(current.data.courses).toEqual([]);
  expect(current.data.courseRevisions).toEqual([]);
  expect(current.data.coursePreferences).toEqual([]);
  expect(current.data.coursePrivacyZones).toEqual([]);
  // v20 requires every retrieval, track, course and preference collection: an absent one
  // is not an empty one.
  for (const missing of [
    'resourcePassages',
    'resourceGroundings',
    'resourceGroundingExcerpts',
    'resourceCitations',
    'activityTracks',
    'activityTrackRevisions',
    'courses',
    'courseRevisions',
    'coursePreferences',
    'coursePrivacyZones',
    'courseThumbnails',
  ] as const)
    expect(
      accountExportSchema.safeParse({
        ...current,
        data: { ...current.data, [missing]: undefined },
      }).success,
    ).toBe(false);
  // A v20 artifact is still read unchanged and never gains a manufactured thumbnail
  // collection (M2-01l, export v21).
  const twenty = accountExportSchema.parse({
    ...current,
    schemaVersion: 20,
    data: Object.fromEntries(
      Object.entries(current.data).filter(([key]) => key !== 'courseThumbnails'),
    ),
  });
  expect(twenty.schemaVersion).toBe(20);
  expect(twenty.data).not.toHaveProperty('courseThumbnails');
  // And v20's `data` is strict: an artifact that CLAIMS to be v20 while carrying the v21
  // collection is refused rather than read with an unvalidated extra field.
  expect(
    accountExportSchema.safeParse({
      ...current,
      schemaVersion: 20,
      data: { ...twenty.data, courseThumbnails: [] },
    }).success,
  ).toBe(false);
  // A v21 artifact that claims to be one version older is refused in the other direction
  // too: the collection is required, not optional.
  expect(accountExportSchema.safeParse({ ...current, schemaVersion: 20 }).success).toBe(false);
  if (twenty.schemaVersion !== 20) throw new Error('Expected the previous export version');
  expect(twenty.data.coursePreferences).toEqual([]);

  // A v19 artifact is still read unchanged and never gains manufactured preference rows.
  const nineteen = accountExportSchema.parse({
    ...current,
    schemaVersion: 19,
    data: Object.fromEntries(
      Object.entries(current.data).filter(
        ([key]) => !['coursePreferences', 'coursePrivacyZones', 'courseThumbnails'].includes(key),
      ),
    ),
  });
  expect(nineteen.schemaVersion).toBe(19);
  expect(nineteen.data).not.toHaveProperty('coursePreferences');
  expect(nineteen.data).not.toHaveProperty('coursePrivacyZones');
  // The two assertions above are about an object this test already built without those
  // keys, so on their own they fix nothing. The fact worth fixing is that v19's `data` is
  // a strict object: an artifact that CLAIMS to be v19 and carries a v20 collection is
  // **refused**, rather than read as a v19 artifact with an extra field nobody validates.
  for (const added of ['coursePreferences', 'coursePrivacyZones'] as const)
    expect(
      accountExportSchema.safeParse({
        ...current,
        schemaVersion: 19,
        data: { ...nineteen.data, [added]: [] },
      }).success,
    ).toBe(false);
  // The collections v19 did carry are still read, unchanged.
  if (nineteen.schemaVersion !== 19) throw new Error('Expected the previous export version');
  expect(nineteen.data.courses).toEqual([]);
  expect(nineteen.data.courseRevisions).toEqual([]);
  // A v18 artifact is still read unchanged and never gains manufactured course rows.
  const eighteen = accountExportSchema.parse({
    ...current,
    schemaVersion: 18,
    data: Object.fromEntries(
      Object.entries(current.data).filter(
        ([key]) =>
          ![
            'courses',
            'courseRevisions',
            'coursePreferences',
            'coursePrivacyZones',
            'courseThumbnails',
          ].includes(key),
      ),
    ),
  });
  expect(eighteen.schemaVersion).toBe(18);
  expect(eighteen.data).not.toHaveProperty('courses');
  // A v17 artifact is still read unchanged and never gains manufactured track rows.
  const seventeen = accountExportSchema.parse({
    ...current,
    schemaVersion: 17,
    data: Object.fromEntries(
      Object.entries(current.data).filter(
        ([key]) =>
          ![
            'activityTracks',
            'activityTrackRevisions',
            'courses',
            'courseRevisions',
            'coursePreferences',
            'coursePrivacyZones',
            'courseThumbnails',
          ].includes(key),
      ),
    ),
  });
  expect(seventeen.schemaVersion).toBe(17);
  expect(seventeen.data).not.toHaveProperty('activityTracks');
  // A v16 artifact is still read unchanged and never gains manufactured rows.
  const previous = accountExportSchema.parse({
    ...current,
    schemaVersion: 16,
    data: Object.fromEntries(
      Object.entries(current.data).filter(
        ([key]) =>
          ![
            'resourcePassages',
            'resourceGroundings',
            'resourceGroundingExcerpts',
            'resourceCitations',
            'activityTracks',
            'activityTrackRevisions',
            'courses',
            'courseRevisions',
            'coursePreferences',
            'coursePrivacyZones',
            'courseThumbnails',
          ].includes(key),
      ),
    ),
  });
  expect(previous.schemaVersion).toBe(16);
  expect(previous.data).not.toHaveProperty('resourcePassages');
});
