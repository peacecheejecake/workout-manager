import { z } from 'zod';
import { activitySchema } from './activity.js';
import { instantSchema } from './primitives.js';

/** A user-selected summary artifact, separate from FIT import commands and account exports. */
export const selectedActivityExportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  format: z.literal('workout-manager-activity-summary'),
  generatedAt: instantSchema,
  consistency: z.literal('per-activity-revision'),
  activities: z
    .array(activitySchema)
    .min(1)
    .max(100)
    .superRefine((activities, context) => {
      if (
        new Set(activities.map((activity) => activity.id.toLowerCase())).size !== activities.length
      )
        context.addIssue({ code: 'custom', message: 'Duplicate exported activity IDs' });
    }),
});
export const selectedActivityExportMaxBytes = 8 * 1024 * 1024;
export type SelectedActivityExport = z.infer<typeof selectedActivityExportSchema>;
