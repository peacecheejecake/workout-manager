import { Writable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { routineSchedulePreviewSchema } from '@workout/contracts/routine-commands';
import {
  RoutineReferenceError,
  type RoutineRepository,
} from '@workout/server-persistence/routine-core';
import { createApi } from '../src/app.js';

const scheduleId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  versionId = 'bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb',
  routineId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  blueprintVersionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const headers = {
  cookie: 'session=fixture',
  origin: 'https://workout.example',
  'x-workout-session-id': 'session-current',
  'x-csrf-token': 'c'.repeat(43),
};
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
  occurrences: [],
  conflicts: [],
  previewDigest: 'f'.repeat(64),
});
const apps: ReturnType<typeof createApi>[] = [];
function setup(previewScheduleResume: RoutineRepository['previewScheduleResume']) {
  const routines = { previewScheduleResume: vi.fn(previewScheduleResume) };
  const app = createApi({
    allowedOrigins: ['https://workout.example'],
    auth: {
      authenticate: async () => ({
        athleteId: 'owner',
        sessionId: 'session-current',
        csrfToken: headers['x-csrf-token'],
        method: 'cookie' as const,
      }),
    },
    consent: { getConsent: vi.fn(), setConsent: vi.fn() },
    routines: routines as unknown as RoutineRepository,
    logStream: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });
  apps.push(app);
  return { app, routines };
}
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

it('serves the resume change preview for the owner and normalized path id only', async () => {
  const { app, routines } = setup(async () => preview);
  const response = await app.inject({
    method: 'POST',
    url: `/bff/v1/routine-schedules/${scheduleId.toUpperCase()}/change-previews`,
    headers,
    payload: { action: 'resume' },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(preview);
  expect(routines.previewScheduleResume).toHaveBeenCalledWith('owner', scheduleId);
});

it('rejects other change-preview actions and maps typed refusals', async () => {
  const { app, routines } = setup(async () => {
    throw new RoutineReferenceError('RESUME_REQUIRES_VERSIONED_OCCURRENCES');
  });
  for (const payload of [{ action: 'pause' }, { action: 'resume', extra: true }, {}]) {
    const response = await app.inject({
      method: 'POST',
      url: `/bff/v1/routine-schedules/${scheduleId}/change-previews`,
      headers,
      payload,
    });
    expect(response.statusCode).toBe(400);
  }
  expect(routines.previewScheduleResume).not.toHaveBeenCalled();
  const refused = await app.inject({
    method: 'POST',
    url: `/bff/v1/routine-schedules/${scheduleId}/change-previews`,
    headers,
    payload: { action: 'resume' },
  });
  expect(refused.statusCode).toBe(422);
  expect(refused.json()).toMatchObject({
    error: { code: 'RESUME_REQUIRES_VERSIONED_OCCURRENCES' },
  });
});
