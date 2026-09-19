import { z } from 'zod';
import { garminConnectionStateSchema } from './garmin.js';

const count = z.number().int().nonnegative();
const rows = z.array(z.record(z.string(), z.json())).max(1000);
/** Versioned download artifact, deliberately excludes authentication and command internals. */
const accountExportV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  athleteId: z.string().min(1).max(200),
  exportedAt: z.iso.datetime({ offset: true }),
  data: z.strictObject({
    consents: rows,
    planSnapshots: rows,
    planHead: rows,
    planHistory: rows,
    activities: rows,
    activitySources: rows,
    sourceRevisions: rows,
    overlays: rows,
    overlayRevisions: rows,
    suppressions: rows,
    checkIns: rows,
    checkInRevisions: rows,
  }),
});
const accountExportV3Schema = accountExportV2Schema.extend({
  schemaVersion: z.literal(3),
  data: accountExportV2Schema.shape.data.extend({
    sessionCompletions: rows,
    sessionCompletionRevisions: rows,
  }),
});
const accountExportV4Schema = accountExportV3Schema.extend({
  schemaVersion: z.literal(4),
  data: accountExportV3Schema.shape.data.extend({
    planScenarios: rows,
    planScenarioRevisions: rows,
    planScenarioApplications: rows,
  }),
});
const accountExportV5Schema = accountExportV4Schema.extend({
  schemaVersion: z.literal(5),
  data: accountExportV4Schema.shape.data.extend({
    coachingThreads: rows,
    coachingMessages: rows,
  }),
});
const accountExportV6Schema = accountExportV5Schema.extend({
  schemaVersion: z.literal(6),
  data: accountExportV5Schema.shape.data.extend({ evidenceSnapshots: rows }),
});
const accountExportV7Schema = accountExportV6Schema.extend({
  schemaVersion: z.literal(7),
  data: accountExportV6Schema.shape.data.extend({
    coachingConstraints: rows,
    coachingConstraintHeads: rows,
  }),
});
const accountExportV8Schema = accountExportV7Schema.extend({
  schemaVersion: z.literal(8),
  data: accountExportV7Schema.shape.data.extend({
    coachingRuns: rows,
    coachingAnalysisOutputs: rows,
  }),
});
const accountExportV9Schema = accountExportV8Schema.extend({
  schemaVersion: z.literal(9),
  data: accountExportV8Schema.shape.data.extend({
    coachingDecisions: rows,
    coachingProposals: rows,
    coachingCandidates: rows,
  }),
});
const accountExportV10Schema = accountExportV9Schema.extend({
  schemaVersion: z.literal(10),
  data: accountExportV9Schema.shape.data.extend({
    nutritionPlanVersions: rows,
    nutritionPlanHeads: rows,
    nutritionPlanHistory: rows,
    foodDefinitionVersions: rows,
    foodDefinitionHeads: rows,
    intakeEntries: rows,
    intakeEntryRevisions: rows,
  }),
});
const accountExportV11Schema = accountExportV10Schema.extend({
  schemaVersion: z.literal(11),
  data: accountExportV10Schema.shape.data.extend({
    supplementaryExerciseVersions: rows,
    supplementaryExerciseHeads: rows,
    supplementaryRoutineVersions: rows,
    supplementaryRoutineHeads: rows,
    supplementaryRoutineTargetRefs: rows,
    supplementarySessionLinks: rows,
    supplementarySessionTargetRefs: rows,
    supplementaryExecutions: rows,
    supplementarySetLogs: rows,
    supplementarySetLogRevisions: rows,
    supplementaryRestTimers: rows,
  }),
});
const accountExportV12Schema = accountExportV11Schema.extend({
  schemaVersion: z.literal(12),
  data: accountExportV11Schema.shape.data.extend({
    resources: rows,
    resourceVersions: rows,
  }),
});
// Read historical artifacts unchanged; never manufacture absent collections.
export const accountExportSchema = z.discriminatedUnion('schemaVersion', [
  accountExportV2Schema,
  accountExportV3Schema,
  accountExportV4Schema,
  accountExportV5Schema,
  accountExportV6Schema,
  accountExportV7Schema,
  accountExportV8Schema,
  accountExportV9Schema,
  accountExportV10Schema,
  accountExportV11Schema,
  accountExportV12Schema,
]);
export const operationsStatusSchema = z.strictObject({
  checkedAt: z.iso.datetime({ offset: true }),
  outbox: z.strictObject({ pending: count, leased: count, retrying: count, completed: count }),
  providers: z.strictObject({
    garmin: garminConnectionStateSchema,
    healthkit: z.literal('not_connected'),
  }),
  audit: z
    .array(
      z.strictObject({
        id: z.uuid(),
        action: z.enum(['export_requested', 'account_erased']),
        createdAt: z.iso.datetime({ offset: true }),
      }),
    )
    .max(10),
});
export const eraseAccountSchema = z.strictObject({ confirmation: z.literal('DELETE MY ACCOUNT') });
export const eraseAccountResultSchema = z.strictObject({ erased: z.literal(true) });
export type AccountExport = z.infer<typeof accountExportSchema>;
export type OperationsStatus = z.infer<typeof operationsStatusSchema>;
