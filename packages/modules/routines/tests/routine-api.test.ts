import { expect, it, vi } from 'vitest';
import { type AuthenticatedTransport, transportReplySchema } from '@workout/contracts/core';
import { routineSchedulePreviewSchema } from '@workout/contracts/routine-commands';
import { createRoutineApi, RoutineRequestError } from '../src/routine-api.js';

const scheduleId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  versionId = 'bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb',
  routineId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  blueprintVersionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  occurrenceId = 'eeeeeeee-eeee-5eee-8eee-eeeeeeeeeeee';
const preview = routineSchedulePreviewSchema.parse({
  schedule: {
    schemaVersion: 4,
    id: scheduleId,
    versionId,
    blueprint: { id: routineId, versionId: blueprintVersionId },
    window: {
      startDate: '2026-11-01',
      endDateExclusive: '2026-11-03',
      timezone: 'UTC',
      maxOccurrences: 2,
    },
    rule: { kind: 'dates', dates: ['2026-11-02'], localTime: '07:00' },
    state: 'active',
  },
  sourcePlanVersionId: null,
  occurrences: [
    {
      id: occurrenceId,
      schedule: { id: scheduleId, versionId },
      blueprint: { id: routineId, versionId: blueprintVersionId },
      anchorKey: '2026-11-02',
      scheduledAt: '2026-11-02T07:00:00.000Z',
      timingStatus: 'resolved',
      stepBindings: [],
      selectedChoices: {},
    },
  ],
  conflicts: [],
  previewDigest: 'f'.repeat(64),
});
function fixture(body: unknown = preview, status = 200) {
  const request = vi.fn<AuthenticatedTransport['request']>(async () =>
    transportReplySchema.parse({ status, body, traceId: null }),
  );
  return { request, api: createRoutineApi({ request }) };
}

it('requests the resume change preview without an idempotency key', async () => {
  const f = fixture();
  expect(await f.api.previewScheduleResume(scheduleId.toUpperCase())).toEqual(preview);
  expect(f.request).toHaveBeenCalledWith({
    path: `/bff/v1/routine-schedules/${scheduleId.toUpperCase()}/change-previews`,
    method: 'POST',
    body: { action: 'resume' },
    idempotencyKey: null,
  });
});

it('surfaces the typed refusal code', async () => {
  const f = fixture({ error: { code: 'RESUME_REQUIRES_VERSIONED_OCCURRENCES' } }, 422);
  const failure = f.api.previewScheduleResume(scheduleId);
  await expect(failure).rejects.toBeInstanceOf(RoutineRequestError);
  await expect(failure).rejects.toMatchObject({
    status: 422,
    code: 'RESUME_REQUIRES_VERSIONED_OCCURRENCES',
  });
});
