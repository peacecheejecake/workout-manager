import { z } from 'zod';

import { nutritionPlanDraftSchema } from './nutrition-core.js';
import { planDraftSchema } from './planning.js';
import { instantSchema, nonEmptyStringSchema } from './primitives.js';
import { recoveryStrategyDraftSchema } from './recovery-core.js';
import {
  integratedCoachingBasisV023Schema,
  planDomainSchema,
  routineOccurrenceSchema,
  routineScheduleVersionSchema,
} from './routines.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const key = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);

export const integratedWriteV4Schema = z.discriminatedUnion('domain', [
  z.strictObject({ domain: z.literal('training'), aggregateId: uuid, proposed: planDraftSchema }),
  z.strictObject({
    domain: z.literal('nutrition'),
    aggregateId: uuid,
    proposed: nutritionPlanDraftSchema,
  }),
  z.strictObject({
    domain: z.literal('recovery'),
    aggregateId: uuid,
    proposed: recoveryStrategyDraftSchema,
    selectedOptionId: uuid,
  }),
  z.strictObject({
    domain: z.literal('routine_schedule'),
    aggregateId: uuid,
    proposed: routineScheduleVersionSchema,
    sourcePlanVersionId: uuid.nullable(),
    occurrences: z.array(routineOccurrenceSchema).max(100),
  }),
]);

const uniqueWrites = z
  .array(integratedWriteV4Schema)
  .min(1)
  .max(100)
  .refine(
    (writes) =>
      new Set(writes.map((write) => `${write.domain}:${write.aggregateId}`)).size === writes.length,
    'Duplicate domain/aggregate write',
  );

export const integratedCandidateV4Schema = z
  .strictObject({
    schemaVersion: z.literal(4),
    id: uuid,
    proposalId: uuid,
    digest,
    basis: integratedCoachingBasisV023Schema,
    writes: uniqueWrites,
    summary: nonEmptyStringSchema.max(2_000),
    validation: z.strictObject({
      status: z.enum(['checked', 'blocked']),
      errors: z.array(nonEmptyStringSchema.max(500)).max(100),
      unknowns: z.array(nonEmptyStringSchema.max(500)).max(100),
    }),
    createdAt: instantSchema,
  })
  .superRefine((candidate, context) => {
    if (candidate.writes.filter((write) => write.domain === 'training').length > 1) {
      context.addIssue({
        code: 'custom',
        path: ['writes'],
        message: 'Only one current training aggregate is supported',
      });
    }
    if (candidate.basis.planHeads.filter((head) => head.domain === 'training').length > 1) {
      context.addIssue({
        code: 'custom',
        path: ['basis', 'planHeads'],
        message: 'Only one current training head is supported',
      });
    }
    const heads = new Set(
      candidate.basis.planHeads.map((head) => `${head.domain}:${head.aggregateId}`),
    );
    for (const write of candidate.writes) {
      if (!heads.has(`${write.domain}:${write.aggregateId}`)) {
        context.addIssue({
          code: 'custom',
          path: ['basis', 'planHeads'],
          message: 'Missing write head',
        });
      }
      if (write.domain === 'routine_schedule' && write.proposed.id !== write.aggregateId) {
        context.addIssue({
          code: 'custom',
          path: ['writes'],
          message: 'Schedule identity mismatch',
        });
      }
      if (
        write.domain === 'recovery' &&
        !write.proposed.options.some((option) => option.id === write.selectedOptionId)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['writes'],
          message: 'Recovery option is missing',
        });
      }
    }
  });

export const integratedCandidatePrepareV4Schema = z.strictObject({
  proposalId: uuid,
  basis: integratedCoachingBasisV023Schema,
  writes: uniqueWrites,
  summary: nonEmptyStringSchema.max(2_000),
  validation: z.strictObject({
    status: z.enum(['checked', 'blocked']),
    errors: z.array(nonEmptyStringSchema.max(500)).max(100),
    unknowns: z.array(nonEmptyStringSchema.max(500)).max(100),
  }),
  idempotencyKey: key,
});

export const integratedApprovalResultV4Schema = z.strictObject({
  schemaVersion: z.literal(4),
  approvalId: uuid,
  candidateId: uuid,
  versions: z
    .array(z.strictObject({ domain: planDomainSchema, aggregateId: uuid, versionId: uuid }))
    .max(100),
  occurrenceIds: z.array(uuid).max(100),
  approvedAt: instantSchema,
});

export type IntegratedWriteV4 = z.infer<typeof integratedWriteV4Schema>;
export type IntegratedCandidateV4 = z.infer<typeof integratedCandidateV4Schema>;
export type IntegratedCandidatePrepareV4 = z.infer<typeof integratedCandidatePrepareV4Schema>;
export type IntegratedApprovalResultV4 = z.infer<typeof integratedApprovalResultV4Schema>;
