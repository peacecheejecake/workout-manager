import { z } from 'zod';

const count = z.number().int().nonnegative();
const rows = z.array(z.record(z.string(), z.json())).max(1000);
/** Versioned download artifact, deliberately excludes authentication and command internals. */
export const accountExportSchema = z.strictObject({
  schemaVersion: z.literal(1),
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
  }),
});
export const operationsStatusSchema = z.strictObject({
  checkedAt: z.iso.datetime({ offset: true }),
  outbox: z.strictObject({ pending: count, leased: count, retrying: count, completed: count }),
  providers: z.strictObject({
    garmin: z.literal('not_connected'),
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
