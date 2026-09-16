import { z } from 'zod';
import { instantSchema, localDateSchema, timeZoneSchema } from './primitives.js';

export const checkInDefinition = {
  version: 'checkin-v1',
  source: 'user',
  method: 'self_report',
  fatigue: {
    question: '관측 시점에 느낀 피로는 어느 정도인가요?',
    min: 0,
    max: 10,
    low: '피로 없음',
    high: '매우 심한 피로',
  },
  discomfort: {
    question: '관측 시점에 느낀 신체 불편감은 어느 정도인가요?',
    min: 0,
    max: 10,
    low: '불편감 없음',
    high: '매우 심한 불편감',
  },
  missing: '보고하지 않음',
  limitation: '사용자 보고이며 진단·운동 허가·session RPE를 의미하지 않습니다.',
} as const;
const scale = z.number().int().min(0).max(10).nullable();
const revision = z.number().int().min(1).max(2147483646);
const key = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const checkInValuesSchema = z
  .strictObject({
    observedAt: instantSchema,
    timezone: timeZoneSchema,
    fatigue: scale,
    discomfort: scale,
    bodyLocation: z.string().trim().min(1).max(200).nullable(),
    note: z.string().trim().min(1).max(2000).nullable(),
  })
  .refine(
    (v) =>
      v.fatigue !== null || v.discomfort !== null || v.bodyLocation !== null || v.note !== null,
    'At least one user report is required',
  );
export const checkInCreateSchema = z.strictObject({
  idempotencyKey: key,
  values: checkInValuesSchema,
});
export const checkInUpdateSchema = z.strictObject({
  idempotencyKey: key,
  expectedRevision: revision,
  reason: z.string().trim().min(1).max(500),
  values: checkInValuesSchema,
});
export const checkInDeleteSchema = z.strictObject({
  idempotencyKey: key,
  expectedRevision: revision,
});
export const checkInSchema = z.strictObject({
  id: z.uuid(),
  revision,
  values: checkInValuesSchema,
  localDate: localDateSchema,
  recordedAt: instantSchema,
  updatedAt: instantSchema,
  source: z.literal('user'),
  method: z.literal('self_report'),
  definitionVersion: z.literal('checkin-v1'),
});
export const checkInCommandResultSchema = z.strictObject({
  id: z.uuid(),
  revision,
  collectionRevision: revision,
  deleted: z.boolean(),
});
export const checkInListQuerySchema = z
  .strictObject({
    from: localDateSchema,
    toExclusive: localDateSchema,
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(10000).default(0),
  })
  .refine((v) => {
    const days = (Date.parse(v.toExclusive) - Date.parse(v.from)) / 86400000;
    return days > 0 && days <= 90;
  }, 'Expected a date window of 1 to 90 local calendar days');
export const checkInListSchema = z.strictObject({
  items: z.array(checkInSchema).max(100),
  total: z.number().int().nonnegative(),
  collectionRevision: z.number().int().min(0).max(2147483646),
});
export type CheckIn = z.infer<typeof checkInSchema>;
export type CheckInValues = z.infer<typeof checkInValuesSchema>;
export type CheckInCreate = z.infer<typeof checkInCreateSchema>;
export type CheckInUpdate = z.infer<typeof checkInUpdateSchema>;
export type CheckInDelete = z.infer<typeof checkInDeleteSchema>;
export type CheckInCommandResult = z.infer<typeof checkInCommandResultSchema>;
export type CheckInList = z.infer<typeof checkInListSchema>;
export type CheckInListQuery = z.infer<typeof checkInListQuerySchema>;
