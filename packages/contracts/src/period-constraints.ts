import { z } from 'zod';
import { localDateSchema } from './primitives.js';

/** Per-local-date time quantities, not wall-clock availability windows. */
export const periodConstraintsSchema = z
  .strictObject({
    unavailableDates: z.array(localDateSchema).max(3660),
    dailyTimeLimits: z
      .array(
        z.strictObject({
          date: localDateSchema,
          availableSeconds: z.number().int().min(0).max(86400),
        }),
      )
      .max(3660),
  })
  .superRefine((value, context) => {
    if (new Set(value.unavailableDates).size !== value.unavailableDates.length)
      context.addIssue({
        code: 'custom',
        message: 'Duplicate unavailable dates',
        path: ['unavailableDates'],
      });
    if (
      new Set(value.dailyTimeLimits.map((limit) => limit.date)).size !==
      value.dailyTimeLimits.length
    )
      context.addIssue({
        code: 'custom',
        message: 'Duplicate daily time limit dates',
        path: ['dailyTimeLimits'],
      });
  });

export type PeriodConstraints = z.infer<typeof periodConstraintsSchema>;
