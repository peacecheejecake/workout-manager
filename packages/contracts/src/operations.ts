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
// Existing v2/v3 artifacts remain readable without manufacturing absent collections.
export const accountExportSchema = z.discriminatedUnion('schemaVersion', [
  accountExportV2Schema,
  accountExportV3Schema,
  accountExportV3Schema.extend({
    schemaVersion: z.literal(4),
    data: accountExportV3Schema.shape.data.extend({
      planScenarios: rows,
      planScenarioRevisions: rows,
      planScenarioApplications: rows,
    }),
  }),
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
