import { z } from 'zod';
import { instantSchema } from './primitives.js';
const uuid = z.uuid().transform((value) => value.toLowerCase());
const textId = z
  .string()
  .min(1)
  .max(200)
  .refine((v) => v.trim() === v && !v.includes('\0'));
const revision = z.number().int().min(1).max(2147483646);
const message = z
  .string()
  .max(8000)
  .refine((v) => v.trim().length > 0 && !v.includes('\0'));
const page = (max: number) => z.coerce.number().int().min(0).max(max);
export const coachingReviewScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session'), targetId: textId }),
  z.strictObject({ kind: z.literal('block'), targetId: textId }),
  z.strictObject({ kind: z.literal('phase'), targetId: textId }),
]);
export const coachingThreadSchema = z.strictObject({
  id: uuid,
  planVersionId: uuid,
  title: textId,
  scope: coachingReviewScopeSchema,
  revision,
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export const coachingUserMessageSchema = z.strictObject({
  id: uuid,
  threadId: uuid,
  revision,
  role: z.literal('user'),
  content: message,
  createdAt: instantSchema,
});
export const coachingThreadCreateSchema = z.strictObject({
  planVersionId: uuid,
  title: textId,
  scope: coachingReviewScopeSchema,
  message,
  idempotencyKey: textId,
});
export const coachingMessageAppendSchema = z.strictObject({
  expectedRevision: revision,
  message,
  idempotencyKey: textId,
});
export const coachingMessageResultSchema = z
  .strictObject({ thread: coachingThreadSchema, message: coachingUserMessageSchema })
  .refine(
    (v) => v.thread.id === v.message.threadId && v.thread.revision === v.message.revision,
    'Message must match thread revision',
  );
export const coachingThreadListQuerySchema = z.strictObject({
  limit: page(100).min(1).default(50),
  offset: page(10000).default(0),
});
export const coachingThreadListSchema = z
  .strictObject({
    items: z.array(coachingThreadSchema).max(100),
    total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .refine((v) => v.total >= v.items.length, 'Invalid total');
export const coachingMessagesQuerySchema = z.strictObject({
  afterRevision: page(2147483646).default(0),
  limit: page(100).min(1).default(50),
});
export const coachingMessagesSchema = z
  .strictObject({
    thread: coachingThreadSchema,
    messages: z.array(coachingUserMessageSchema).max(100),
    hasMore: z.boolean(),
  })
  .refine(
    (v) =>
      v.messages.every(
        (m, i) =>
          m.threadId === v.thread.id &&
          m.revision <= v.thread.revision &&
          (i === 0 || m.revision > (v.messages[i - 1]?.revision ?? 0)),
      ),
    'Messages must match thread and revision order',
  );
export type CoachingReviewScope = z.infer<typeof coachingReviewScopeSchema>;
export type CoachingThread = z.infer<typeof coachingThreadSchema>;
export type CoachingUserMessage = z.infer<typeof coachingUserMessageSchema>;
export type CoachingThreadCreate = z.infer<typeof coachingThreadCreateSchema>;
export type CoachingMessageAppend = z.infer<typeof coachingMessageAppendSchema>;
export type CoachingMessageResult = z.infer<typeof coachingMessageResultSchema>;
export type CoachingThreadListQuery = z.infer<typeof coachingThreadListQuerySchema>;
export type CoachingThreadList = z.infer<typeof coachingThreadListSchema>;
export type CoachingMessagesQuery = z.infer<typeof coachingMessagesQuerySchema>;
export type CoachingMessages = z.infer<typeof coachingMessagesSchema>;
