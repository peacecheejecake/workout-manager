import { describe, expect, it } from 'vitest';
import {
  dashboardQuerySchema,
  dashboardMetricSchema,
  dashboardActualSchema,
  dashboardReadModelSchema,
  shiftDashboardDate,
} from '../src/dashboard.js';

const missing = { value: null, knownCount: 0, missingCount: 0 };
const actual = {
  count: 0,
  distanceMeters: missing,
  durationSeconds: { timer: missing, elapsed: missing, moving: missing, unknown: missing },
  sources: { fit: 0, fixture: 0 },
  overlayCount: 0,
};
const planned = { count: 0, distanceMeters: missing, durationSeconds: missing };
const summary = { actual, planned, checkInCount: 0, checkInDays: 0 };
const emptyModel = () => ({
  definitionVersion: 'dashboard-v1',
  observedAt: '2026-03-09T12:00:00Z',
  period: {
    anchor: '2026-03-09',
    days: 3,
    timezone: 'America/New_York',
    timezoneSource: 'query',
    from: '2026-03-07',
    toExclusive: '2026-03-10',
    previousFrom: '2026-03-04',
    upcomingToExclusive: '2026-03-17',
  },
  planVersion: null,
  dataRevision: { activities: { count: 0, revisionSum: '0' }, checkIns: 0 },
  currentBlock: null,
  todaySessions: [],
  upcomingSessions: [],
  current: summary,
  previous: summary,
  days: ['2026-03-07', '2026-03-08', '2026-03-09'].map((date) => ({
    date,
    actual,
    planned,
    checkInCount: 0,
  })),
  unplacedActivityCount: 0,
  latestCheckIn: null,
  availability: {
    coverage: 'unknown',
    comparison: 'unavailable',
    actualLoad: 'unavailable',
    providerMetrics: 'unavailable',
  },
  proposalSummary: { status: 'unavailable', reason: 'not_implemented' },
  connectionFreshness: {
    status: 'unavailable',
    reason: 'activity_sync_not_implemented',
    lastSuccessfulSyncAt: null,
  },
});

describe('dashboard calendar and measurement contracts', () => {
  it('bounds query windows, timezone and calendar dates without accepting invented filters', () => {
    expect(
      dashboardQuerySchema.parse({ anchor: '2026-03-09', timezone: 'America/New_York' }).window,
    ).toBe(10);
    for (const input of [
      { window: 2 },
      { window: 91 },
      { window: 3.5 },
      { timezone: 'bad/zone' },
      { anchor: '2026-02-29' },
      { anchor: '0001-01-01' },
      { anchor: '9999-12-31' },
      { athleteId: 'other-user' },
    ])
      expect(
        dashboardQuerySchema.safeParse({ anchor: '2026-03-09', timezone: 'UTC', ...input }).success,
      ).toBe(false);
    expect(shiftDashboardDate('2024-03-01', -1)).toBe('2024-02-29');
    expect(shiftDashboardDate('2026-03-09', -2)).toBe('2026-03-07');
  });
  it('keeps missing metrics separate from explicit zero and enforces source/count agreement', () => {
    expect(dashboardMetricSchema.parse({ value: 0, knownCount: 1, missingCount: 1 }).value).toBe(0);
    expect(
      dashboardMetricSchema.safeParse({ value: 0, knownCount: 0, missingCount: 1 }).success,
    ).toBe(false);
    expect(
      dashboardMetricSchema.safeParse({ value: null, knownCount: 1, missingCount: 0 }).success,
    ).toBe(false);
    expect(dashboardActualSchema.safeParse({ ...actual, count: 1 }).success).toBe(false);
  });
  it('returns N consecutive calendar dates across DST and refuses coverage or sync claims', () => {
    const model = emptyModel();
    expect(dashboardReadModelSchema.parse(model).days).toHaveLength(3);
    expect(
      dashboardReadModelSchema.safeParse({ ...model, days: model.days.slice(1) }).success,
    ).toBe(false);
    expect(
      dashboardReadModelSchema.safeParse({ ...model, days: [...model.days].reverse() }).success,
    ).toBe(false);
    expect(
      dashboardReadModelSchema.safeParse({
        ...model,
        availability: { ...model.availability, coverage: 'complete' },
      }).success,
    ).toBe(false);
    expect(
      dashboardReadModelSchema.safeParse({
        ...model,
        connectionFreshness: {
          ...model.connectionFreshness,
          lastSuccessfulSyncAt: model.observedAt,
        },
      }).success,
    ).toBe(false);
  });
});
