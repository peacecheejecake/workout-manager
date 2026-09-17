import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanDraft, PlanSnapshot } from '@workout/contracts/planning';
import { createApi } from '../src/app.js';
const athleteId = 'athlete-from-auth';
const csrfToken = 'c'.repeat(43);
const headers = {
  cookie: 'session=verified-by-port',
  origin: 'https://workout.example',
  'x-csrf-token': csrfToken,
  'x-workout-session-id': 'session-current',
  'idempotency-key': 'plan-save-0001',
};
const draft: PlanDraft = {
  title: 'Plan',
  timezone: 'UTC',
  periods: [
    {
      id: 'season',
      parentId: null,
      level: 'season',
      title: 'Season',
      startDate: '2026-01-01',
      endDateExclusive: '2026-02-01',
      timezone: 'UTC',
      intent: 'Base',
      isPartial: false,
    },
  ],
  sessions: [],
};
const root = draft.periods[0];
if (!root) throw new Error('Missing synthetic root');
draft.periods.push(
  { ...root, id: 'wave', parentId: 'season', level: 'wave' },
  { ...root, id: 'phase', parentId: 'wave', level: 'phase' },
  { ...root, id: 'block', parentId: 'phase', level: 'block' },
);
draft.sessions = [
  {
    id: 'run',
    blockId: 'block',
    date: '2026-01-02',
    localStartTime: null,
    title: 'Synthetic run',
    sport: 'running',
    durationSeconds: null,
    distanceMeters: 0,
    targetRpe: null,
    purpose: '',
    notes: '',
    priority: 'normal',
    locks: { date: false, time: false, intensity: false },
    steps: [],
  },
];
const body = { source: 'manual', confirmed: true, expectedVersionId: null, draft };
const saved = { id: 'version-one', version: 1, createdAt: '2026-01-01T00:00:00Z', draft };
const instances: ReturnType<typeof createApi>[] = [];
function setup(authenticated = true) {
  const planning = {
    readVersion: vi.fn<(_athlete: string, _id: string) => Promise<PlanSnapshot | null>>(
      async () => saved,
    ),
    read: vi.fn(async () => ({
      head: saved,
      history: [{ id: saved.id, version: 1, createdAt: saved.createdAt, title: draft.title }],
    })),
    save: vi.fn(async () => saved),
  };
  const app = createApi({
    auth: {
      authenticate: async () =>
        authenticated
          ? { athleteId, sessionId: 'session-current', csrfToken, method: 'cookie' }
          : null,
    },
    consent: { getConsent: vi.fn(), setConsent: vi.fn() },
    planning,
    allowedOrigins: ['https://workout.example'],
    logStream: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });
  instances.push(app);
  return { app, planning };
}
afterEach(async () => {
  await Promise.all(instances.splice(0).map((app) => app.close()));
});

describe('session quantity ranges wire boundaries', () => {
  it.each([
    { durationRange: { minSeconds: -1, maxSeconds: 30 } },
    { durationRange: { minSeconds: 31, maxSeconds: 30 } },
    { durationRange: { minSeconds: 0, maxSeconds: 604801 } },
    { durationRange: { minSeconds: 0 } },
    { durationRange: { minSeconds: 0, maxSeconds: 30, unit: 'minutes' } },
    { durationSeconds: 10, durationRange: { minSeconds: 0, maxSeconds: 30 } },
    { distanceRange: { minMeters: 0, maxMeters: 10000001 } },
    { distanceRange: { minMeters: 10, maxMeters: 9 } },
    { distanceRange: { minMeters: 0, maxMeters: 100 } }, // Existing fixture scalar distance=0 conflicts even with zero boundary.
  ])('rejects invalid or ambiguous ranges %#', async (patch) => {
    const { app, planning } = setup();
    const payload = {
      ...body,
      draft: { ...draft, sessions: draft.sessions.map((session) => ({ ...session, ...patch })) },
    };
    expect(
      (await app.inject({ method: 'PUT', url: '/bff/v1/plans/current', headers, payload }))
        .statusCode,
    ).toBe(400);
    expect(planning.save).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { durationRange: null, distanceRange: null },
    {
      durationSeconds: null,
      distanceMeters: null,
      durationRange: { minSeconds: 0, maxSeconds: 12.5 },
      distanceRange: { minMeters: 0, maxMeters: 0 },
    },
  ])('preserves legacy and explicit ranges without normalization %#', async (patch) => {
    const { app, planning } = setup();
    const payload = {
      ...body,
      draft: { ...draft, sessions: draft.sessions.map((session) => ({ ...session, ...patch })) },
    };
    expect(
      (await app.inject({ method: 'PUT', url: '/bff/v1/plans/current', headers, payload }))
        .statusCode,
    ).toBe(200);
    expect(planning.save).toHaveBeenCalledExactlyOnceWith(athleteId, {
      ...payload,
      idempotencyKey: headers['idempotency-key'],
    });
  });
});
