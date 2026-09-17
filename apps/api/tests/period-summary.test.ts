import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PeriodSummary } from '@workout/contracts/period-summary';
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
  const periodSummary = {
    read: vi.fn<(_athlete: string, _query: unknown) => Promise<PeriodSummary | null>>(
      async () => null,
    ),
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
    periodSummary,
    allowedOrigins: ['https://workout.example'],
    logStream: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });
  instances.push(app);
  return { app, planning, periodSummary };
}
afterEach(async () => {
  await Promise.all(instances.splice(0).map((app) => app.close()));
});

describe('period summary protected route', () => {
  const version = 'ABCDEFAB-1234-4234-8234-123456789012';
  const url = `/bff/v1/plans/versions/${version}/periods/season/summary`;
  it('normalizes version and returns the same missing response without writes', async () => {
    const { app, planning, periodSummary } = setup();
    const response = await app.inject({ url, headers });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'PLAN_PERIOD_NOT_FOUND' } });
    expect(periodSummary.read).toHaveBeenCalledWith(athleteId, {
      planVersionId: version.toLowerCase(),
      periodId: 'season',
    });
    expect(planning.save).not.toHaveBeenCalled();
  });
  it.each([
    `${url}?athleteId=foreign`,
    url.replace(version, 'invalid'),
    url.replace('/season/', '/%20/'),
  ])('rejects malformed request %s', async (path) => {
    const { app, periodSummary } = setup();
    expect((await app.inject({ url: path, headers })).statusCode).toBe(400);
    expect(periodSummary.read).not.toHaveBeenCalled();
  });
  it('requires authentication and current session binding', async () => {
    const absent = setup(false);
    expect((await absent.app.inject({ url, headers })).statusCode).toBe(401);
    expect(absent.periodSummary.read).not.toHaveBeenCalled();
    const current = setup();
    expect(
      (await current.app.inject({ url, headers: { ...headers, 'x-workout-session-id': 'old' } }))
        .statusCode,
    ).toBe(409);
    expect(current.periodSummary.read).not.toHaveBeenCalled();
  });
});

it.each(['x'.repeat(200), '기간'.repeat(100)])(
  'accepts a full contract-length decoded period ID',
  async (periodId) => {
    const { app, periodSummary } = setup();
    const version = 'abcdefab-1234-4234-8234-123456789012';
    const response = await app.inject({
      url: `/bff/v1/plans/versions/${version}/periods/${encodeURIComponent(periodId)}/summary`,
      headers,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'PLAN_PERIOD_NOT_FOUND' } });
    expect(periodSummary.read).toHaveBeenCalledWith(athleteId, {
      planVersionId: version,
      periodId,
    });
  },
);

it('returns a validated summary without mutating the plan', async () => {
  const { app, planning, periodSummary } = setup();
  const id = 'abcdefab-1234-4234-8234-123456789012';
  const period = draft.periods[0];
  if (!period) throw new Error('Missing fixture');
  const missing = { value: null, knownCount: 0, missingCount: 0 };
  const summary: PeriodSummary = {
    definitionVersion: 'period-summary-v1',
    observedAt: '2026-01-01T00:00:00Z',
    planVersion: { id, version: 1, title: 'Plan' },
    currentPlanVersionId: id,
    period,
    planned: { count: 0, distanceMeters: missing, durationSeconds: missing },
    keySessions: [],
    actual: {
      status: 'available',
      totals: {
        count: 0,
        distanceMeters: missing,
        durationSeconds: { timer: missing, elapsed: missing, moving: missing, unknown: missing },
        sources: { fit: 0, fixture: 0, manual: 0 },
        overlayCount: 0,
      },
    },
    dataRevision: { activities: { count: 0, revisionSum: '0' } },
    unplacedActivityCount: 0,
    coverage: 'unknown',
  };
  periodSummary.read.mockResolvedValue(summary);
  const response = await app.inject({
    url: `/bff/v1/plans/versions/${id}/periods/season/summary`,
    headers,
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(summary);
  expect(planning.save).not.toHaveBeenCalled();
});
