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

describe('session pace and heart-rate target wire validation', () => {
  it.each([
    { paceTarget: { minSecondsPerKm: 0, maxSecondsPerKm: 300 } },
    { paceTarget: { minSecondsPerKm: 301, maxSecondsPerKm: 300 } },
    { paceTarget: { minSecondsPerKm: 300, maxSecondsPerKm: 86401 } },
    { paceTarget: { minSecondsPerKm: 300 } },
    { paceTarget: { minSecondsPerKm: null, maxSecondsPerKm: 300 } },
    { paceTarget: { minSecondsPerKm: 300, maxSecondsPerKm: 300, unit: 'km/h' } },
    { heartRateTarget: { minBpm: 0, maxBpm: 130 } },
    { heartRateTarget: { minBpm: 130, maxBpm: 129 } },
    { heartRateTarget: { minBpm: 130.5, maxBpm: 140 } },
    { heartRateTarget: { minBpm: 130, maxBpm: 1001 } },
    { heartRateTarget: { minBpm: 130, maxBpm: 140, source: 'device' } },
  ])('rejects malformed target %# before persistence', async (patch) => {
    const { app, planning } = setup();
    const response = await app.inject({
      method: 'PUT',
      url: '/bff/v1/plans/current',
      headers,
      payload: {
        ...body,
        draft: { ...draft, sessions: draft.sessions.map((session) => ({ ...session, ...patch })) },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(planning.save).not.toHaveBeenCalled();
  });
  it('rejects non-finite JSON numbers at the boundary rather than converting them into unknown', async () => {
    const { app, planning } = setup();
    const payload = JSON.stringify({
      ...body,
      draft: {
        ...draft,
        sessions: draft.sessions.map((session) => ({
          ...session,
          paceTarget: { minSecondsPerKm: 300, maxSecondsPerKm: 999 },
        })),
      },
    }).replace('"maxSecondsPerKm":999', '"maxSecondsPerKm":1e999');
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/bff/v1/plans/current',
          headers: { ...headers, 'content-type': 'application/json' },
          payload,
        })
      ).statusCode,
    ).toBe(400);
    expect(planning.save).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { paceTarget: null, heartRateTarget: null },
    {
      paceTarget: { minSecondsPerKm: 300.5, maxSecondsPerKm: 300.5 },
      heartRateTarget: { minBpm: 120, maxBpm: 150 },
    },
  ])(
    'passes exact validated targets, absent fields and nulls to the authenticated repository %#',
    async (patch) => {
      const { app, planning } = setup();
      const payload = {
        ...body,
        draft: { ...draft, sessions: draft.sessions.map((session) => ({ ...session, ...patch })) },
      };
      const response = await app.inject({
        method: 'PUT',
        url: '/bff/v1/plans/current',
        headers,
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(planning.save).toHaveBeenCalledExactlyOnceWith(athleteId, {
        ...payload,
        idempotencyKey: headers['idempotency-key'],
      });
    },
  );
});
