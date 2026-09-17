import { z } from 'zod';
import { activitySchema } from './activity.js';
import { instantSchema } from './primitives.js';

/** A user-selected summary artifact, separate from FIT import commands and account exports. */
const exportFields = {
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
};
export const selectedActivityExportSchema = z.discriminatedUnion('schemaVersion', [
  z.strictObject({
    ...exportFields,
    schemaVersion: z.literal(1),
    activities: exportFields.activities.refine(
      (activities) => activities.every((activity) => activity.overlay.tags === undefined),
      'Local tags require summary export version 2',
    ),
  }),
  z.strictObject({ ...exportFields, schemaVersion: z.literal(2) }),
]);
export const selectedActivityExportMaxBytes = 8 * 1024 * 1024;
export type SelectedActivityExport = z.infer<typeof selectedActivityExportSchema>;
