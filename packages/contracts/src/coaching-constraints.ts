import { z } from 'zod';
import { instantSchema } from './primitives.js';

const uuid = z.uuid().refine((value) => value === value.toLowerCase(), 'Expected lowercase UUID');
const revision = z.number().int().min(1).max(2147483646);
const text = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((value) => !value.includes('\0'));
const idempotencyKey = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value === value.trim() && !value.includes('\0'));
export const coachingConstraintDefinition = {
  source: 'user',
  meaning:
    '사용자가 직접 확인한 제약 문장입니다. 추론이나 의료적 판단이 아니며 일정을 자동으로 변경하지 않습니다.',
  absent: '사용자 제약을 아직 확인하지 않았습니다.',
  cleared: '현재 저장된 사용자 제약 문장이 없습니다.',
} as const;
export const coachingConstraintSchema = z.strictObject({
  id: uuid,
  revision,
  text,
  confirmedAt: instantSchema,
  updatedAt: instantSchema,
});
export const coachingConstraintListSchema = z
  .strictObject({
    headRevision: revision.nullable(),
    items: z.array(coachingConstraintSchema).max(50),
  })
  .refine(
    (value) =>
      (value.headRevision !== null || value.items.length === 0) &&
      new Set(value.items.map((item) => item.id)).size === value.items.length,
    'Absent head must be empty and IDs must be unique',
  );
export const coachingConstraintCreateSchema = z.strictObject({
  expectedHeadRevision: revision.nullable(),
  confirmed: z.literal(true),
  text,
  idempotencyKey,
});
export const coachingConstraintUpdateSchema = z.strictObject({
  expectedHeadRevision: revision,
  expectedRevision: revision,
  confirmed: z.literal(true),
  text,
  idempotencyKey,
});
export const coachingConstraintDeleteSchema = z.strictObject({
  expectedHeadRevision: revision,
  expectedRevision: revision,
  confirmed: z.literal(true),
  idempotencyKey,
});
export const coachingConstraintCommandResultSchema = z.strictObject({
  id: uuid,
  revision,
  headRevision: revision,
  deleted: z.boolean(),
});
export type CoachingConstraint = z.infer<typeof coachingConstraintSchema>;
export type CoachingConstraintList = z.infer<typeof coachingConstraintListSchema>;
export type CoachingConstraintCreate = z.infer<typeof coachingConstraintCreateSchema>;
export type CoachingConstraintUpdate = z.infer<typeof coachingConstraintUpdateSchema>;
export type CoachingConstraintDelete = z.infer<typeof coachingConstraintDeleteSchema>;
export type CoachingConstraintCommandResult = z.infer<typeof coachingConstraintCommandResultSchema>;
