import { z } from 'zod';
import { instantSchema, localDateSchema, timeZoneSchema } from './primitives.js';
import { coachingThreadSchema, coachingUserMessageSchema } from './coaching-threads.js';
import { planSnapshotSchema } from './planning.js';
import { coreEvidenceDependencyManifestSchema } from './evidence-dependencies.js';
import { activitySchema } from './activity.js';
import { checkInSchema } from './check-ins.js';
import { sessionCompletionSchema } from './session-completion.js';
export const coreEvidenceSnapshotDefinition = {
  scope: 'running-core-v1',
  excluded: [
    'activity_details',
    'provider_heads',
    'resource_passages',
    'global_preferences',
    'global_constraints',
    'coaching_policy',
    'model_output',
    'approval_authority',
  ],
} as const;
export const coreEvidenceWindowSchema = z
  .strictObject({ from: localDateSchema, toExclusive: localDateSchema, timezone: timeZoneSchema })
  .refine((v) => {
    const days =
      (Date.parse(`${v.toExclusive}T00:00:00Z`) - Date.parse(`${v.from}T00:00:00Z`)) / 86400000;
    return days >= 1 && days <= 90;
  }, 'Expected 1–90 local calendar days');
export const coreEvidenceCaptureSchema = z.strictObject({
  expectedConversationRevision: z.number().int().min(1).max(2147483646),
  window: coreEvidenceWindowSchema,
  idempotencyKey: z
    .string()
    .min(1)
    .max(200)
    .refine((v) => v === v.trim() && !v.includes('\0')),
});
function localDate(instant: string, timezone: string): string {
  if (!Number.isFinite(Date.parse(instant)) || !timeZoneSchema.safeParse(timezone).success)
    return 'invalid';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    era: 'short',
  }).formatToParts(new Date(instant));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  const year = Number(value('year'));
  return `${String(value('era') === 'BC' ? 1 - year : year).padStart(4, '0')}-${value('month')}-${value('day')}`;
}
export const coreEvidenceBodySchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    scope: z.literal('running-core-v1'),
    window: coreEvidenceWindowSchema,
    thread: coachingThreadSchema,
    plan: planSnapshotSchema,
    messages: z.array(coachingUserMessageSchema).max(100),
    dependencies: coreEvidenceDependencyManifestSchema,
    activities: z
      .array(z.strictObject({ localDate: localDateSchema.nullable(), record: activitySchema }))
      .max(500),
    checkIns: z
      .array(z.strictObject({ localDate: localDateSchema, record: checkInSchema }))
      .max(100),
    sessionCompletions: z.array(sessionCompletionSchema).max(1000),
  })
  .superRefine((v, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (v.plan.id !== v.thread.planVersionId) fail('Pinned plan mismatch');
    const scope = v.thread.scope;
    if (
      scope.kind === 'session'
        ? !v.plan.draft.sessions.some((s) => s.id === scope.targetId)
        : !v.plan.draft.periods.some((p) => p.id === scope.targetId && p.level === scope.kind)
    )
      fail('Scope not present in pinned plan');
    if (
      v.messages.length !== v.thread.revision ||
      v.messages.some((m, i) => m.threadId !== v.thread.id || m.revision !== i + 1)
    )
      fail('Entire ordered conversation required');
    const unique = (values: string[]) => new Set(values).size === values.length;
    if (
      !unique(v.messages.map((m) => m.id)) ||
      !unique(v.activities.map((a) => a.record.id)) ||
      !unique(v.checkIns.map((c) => c.record.id)) ||
      !unique(v.sessionCompletions.map((c) => c.sessionId))
    )
      fail('Duplicate evidence record');
    const within = (date: string) => date >= v.window.from && date < v.window.toExclusive;
    for (const a of v.activities) {
      const instant = a.record.effective.startedAt;
      const expected = instant === null ? null : localDate(instant, v.window.timezone);
      if (a.localDate !== expected || (a.localDate !== null && !within(a.localDate)))
        fail('Activity local date mismatch or outside window');
    }
    for (const c of v.checkIns)
      if (
        c.localDate !== localDate(c.record.values.observedAt, v.window.timezone) ||
        !within(c.localDate)
      )
        fail('Check-in local date mismatch or outside window');
    const ids = new Set(v.plan.draft.sessions.map((s) => s.id));
    if (v.sessionCompletions.some((c) => !ids.has(c.sessionId)))
      fail('Completion outside pinned plan');
    if (
      [
        ...v.activities.map((a) => a.record.revision),
        ...v.checkIns.map((c) => c.record.revision),
        ...v.sessionCompletions.map((c) => c.revision),
      ].some((n) => !Number.isSafeInteger(n) || n < 1)
    ) {
      fail('Invalid record revision');
      return;
    }
    const a = v.dependencies.activities;
    if (/^(0|[1-9][0-9]{0,39})$/.test(a.count) && /^(0|[1-9][0-9]{0,39})$/.test(a.revisionSum)) {
      if (
        BigInt(a.count) < BigInt(v.activities.length) ||
        BigInt(a.revisionSum) <
          v.activities.reduce((sum, item) => sum + BigInt(item.record.revision), 0n)
      )
        fail('Activity dependencies do not cover records');
    }
    const cover = (
      head: { kind: 'absent' } | { kind: 'exists'; revision: number },
      revisions: number[],
    ) =>
      revisions.length === 0 ||
      (head.kind === 'exists' &&
        Number.isSafeInteger(head.revision) &&
        BigInt(head.revision) >= revisions.reduce((sum, n) => sum + BigInt(n), 0n));
    if (
      !cover(
        v.dependencies.checkIns,
        v.checkIns.map((c) => c.record.revision),
      )
    )
      fail('Check-in dependencies do not cover records');
    if (
      !cover(
        v.dependencies.sessionCompletions,
        v.sessionCompletions.map((c) => c.revision),
      )
    )
      fail('Completion dependencies do not cover records');
  });
const metadata = { id: z.uuid(), threadId: z.uuid(), createdAt: instantSchema };
const purged = z.strictObject({
  ...metadata,
  status: z.literal('purged'),
  reason: z.enum(['source_deleted', 'consent_withdrawn']),
});
export const coreEvidenceSnapshotMetadataSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...metadata, status: z.literal('available') }),
  purged,
]);
export const coreEvidenceSnapshotSchema = z
  .discriminatedUnion('status', [
    z.strictObject({ ...metadata, status: z.literal('available'), body: coreEvidenceBodySchema }),
    purged,
  ])
  .superRefine((v, ctx) => {
    if (
      v.status === 'available' &&
      (v.body.thread.id !== v.threadId || v.body.dependencies.capturedAt !== v.createdAt)
    )
      ctx.addIssue({ code: 'custom', message: 'Snapshot identity or capture time mismatch' });
  });
export const coreEvidenceSnapshotListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(10000).default(0),
});
export const coreEvidenceSnapshotListSchema = z
  .strictObject({
    items: z.array(coreEvidenceSnapshotMetadataSchema).max(100),
    total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .refine(
    (v) => v.total >= v.items.length && new Set(v.items.map((i) => i.id)).size === v.items.length,
    'Invalid list total or duplicate IDs',
  );
export type CoreEvidenceCapture = z.infer<typeof coreEvidenceCaptureSchema>;
export type CoreEvidenceBody = z.infer<typeof coreEvidenceBodySchema>;
export type CoreEvidenceSnapshot = z.infer<typeof coreEvidenceSnapshotSchema>;
export type CoreEvidenceSnapshotList = z.infer<typeof coreEvidenceSnapshotListSchema>;
export type CoreEvidenceSnapshotListQuery = z.infer<typeof coreEvidenceSnapshotListQuerySchema>;
