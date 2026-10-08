import { describe, expect, it, vi } from 'vitest';
import { planSnapshotSchema } from '@workout/contracts/planning';
import { sessionCompletionSchema } from '@workout/contracts/session-completion';
import { raceEventSchema } from '@workout/contracts/races';
import type { Transaction } from '../src/database.js';
import { captureRacePlanImpactCalendarRootsIn } from '../src/race-plan-impact-calendar-roots.js';
import type { SourceBudget } from '../src/race-plan-impact-nested-sources.js';
const id = '10000000-0000-4000-8000-000000000001';
const event = raceEventSchema.parse({
  id,
  revision: 1,
  title: 'Synthetic',
  localDate: '2026-01-01',
  localStartTime: null,
  timezone: 'Asia/Seoul',
  locationName: null,
  distance: { kind: 'standard', class: '10k' },
  priority: null,
  participation: 'registered',
  officialUrl: null,
  course: null,
  targetSeconds: 0,
  planVersionId: null,
});
function fixture(
  options: {
    scalar?: Record<string, unknown>;
    missing?: boolean;
    history?: unknown;
    event?: unknown;
    current?: Record<string, unknown>[];
    completions?: Record<string, unknown>[];
  } = {},
) {
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    expect(values?.[0]).toBe('athlete');
    if (sql.includes('WITH\n'))
      return {
        rows: [{ bytes: '4096', sources: '2', heads: '0', completions: '0', ...options.scalar }],
        rowCount: 1,
      };
    if (sql.includes('FROM race_event WHERE'))
      return {
        rows: options.missing ? [] : [{ id, revision: 1, values_json: options.event ?? event }],
        rowCount: 1,
      };
    if (sql.includes('FROM race_event_revision'))
      return { rows: [{ values_json: options.history ?? event }], rowCount: 1 };
    if (sql.includes('FROM plan_head')) return { rows: options.current ?? [], rowCount: 0 };
    if (sql.includes('FROM session_completion'))
      return { rows: options.completions ?? [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  });
  const tx: Transaction = { athleteId: 'athlete', query };
  return { tx, query, budget: { bytes: 0n, sources: 0 } satisfies SourceBudget };
}
const command = { eventId: id, expectedRevision: 1 };
describe('preliminary calendar roots', () => {
  it('returns exact root DTOs and debits every body visit into the same inherited budget', async () => {
    const f = fixture();
    f.budget.bytes = 10n;
    f.budget.sources = 3;
    expect(await captureRacePlanImpactCalendarRootsIn(f.tx, command, f.budget)).toEqual({
      event,
      currentTraining: null,
      completions: [],
    });
    expect(f.budget).toEqual({ bytes: 4618n, sources: 5 });
    expect(f.query.mock.calls.every(([, values]) => values?.[0] === 'athlete')).toBe(true);
  });
  it.each([
    { ...command, affected: [] },
    { ...command, eventId: 'opaque' },
    { ...command, expectedRevision: 0 },
  ])('rejects unknown/invalid command before SQL', async (raw) => {
    const f = fixture();
    await expect(captureRacePlanImpactCalendarRootsIn(f.tx, raw, f.budget)).rejects.toMatchObject({
      code: 'INVALID_CONTEXT',
    });
    expect(f.query).not.toHaveBeenCalled();
  });
  it.each([
    { bytes: -1n, sources: 0 },
    { bytes: 0n, sources: NaN },
    { bytes: 0n, sources: -1 },
  ])('rejects invalid inherited counters before SQL', async (budget) => {
    const f = fixture();
    await expect(captureRacePlanImpactCalendarRootsIn(f.tx, command, budget)).rejects.toMatchObject(
      { code: 'INVALID_CONTEXT' },
    );
    expect(f.query).not.toHaveBeenCalled();
  });
  it('reserves the bounded scalar response before querying a near-cap request', async () => {
    const f = fixture();
    f.budget.bytes = 4194303n;
    await expect(
      captureRacePlanImpactCalendarRootsIn(f.tx, command, f.budget),
    ).rejects.toMatchObject({ bound: 'decoded_bytes' });
    expect(f.query.mock.calls).toHaveLength(1);
    expect(f.query.mock.calls[0]?.[0]).toContain('pg_advisory');
  });
  it.each([
    { bytes: '4194304' },
    { sources: '5001' },
    { completions: '1001' },
    { heads: '2' },
    { bytes: '0' },
    { bytes: null },
  ])('rejects scalar overflow/malformed before a root body transfer', async (scalar) => {
    const f = fixture({ scalar });
    await expect(captureRacePlanImpactCalendarRootsIn(f.tx, command, f.budget)).rejects.toThrow();
    expect(f.query.mock.calls).toHaveLength(2);
  });
  it('refuses a positively under-reported source body rather than trusting its budget claim', async () => {
    const f = fixture({ scalar: { bytes: '512' }, event: { ...event, title: 'x'.repeat(1000) } });
    await expect(
      captureRacePlanImpactCalendarRootsIn(f.tx, command, f.budget),
    ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
  });
  it('preserves foreign/deleted absence and requested revision errors', async () => {
    const f = fixture({ missing: true });
    await expect(
      captureRacePlanImpactCalendarRootsIn(f.tx, command, f.budget),
    ).rejects.toMatchObject({ code: 'EVENT_UNAVAILABLE' });
    const g = fixture();
    await expect(
      captureRacePlanImpactCalendarRootsIn(g.tx, { ...command, expectedRevision: 2 }, g.budget),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  });
  it('refuses different immutable event history and orphan current head', async () => {
    const f = fixture({ history: { ...event, targetSeconds: null } });
    await expect(
      captureRacePlanImpactCalendarRootsIn(f.tx, command, f.budget),
    ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
    const g = fixture({
      scalar: { heads: '1', sources: '3' },
      current: [{ aggregate_id: id, id: null, version: null, created_at: null, draft: null }],
    });
    await expect(
      captureRacePlanImpactCalendarRootsIn(g.tx, command, g.budget),
    ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
  });
  it('preserves completed self-report tuple, zero/null and exact current Plan body without creating actuals', async () => {
    const levels = ['season', 'wave', 'phase', 'block'] as const;
    const plan = planSnapshotSchema.parse({
      id,
      version: 1,
      createdAt: '2026-01-01T00:00:00Z',
      draft: {
        title: 'Synthetic',
        timezone: 'Asia/Seoul',
        periods: levels.map((level, index) => ({
          id: level,
          parentId: index === 0 ? null : levels[index - 1],
          level,
          title: level,
          startDate: '2026-01-01',
          endDateExclusive: '2026-02-01',
          timezone: 'Asia/Seoul',
          intent: '',
          isPartial: false,
        })),
        sessions: [
          {
            id: 'session',
            blockId: 'block',
            date: '2026-01-01',
            localStartTime: null,
            title: 'Synthetic',
            sport: 'running',
            durationSeconds: 0,
            distanceMeters: null,
            targetRpe: null,
            purpose: '',
            notes: '',
            priority: 'normal',
            locks: { date: false, time: false, intensity: false },
            steps: [],
          },
        ],
      },
    });
    const report = sessionCompletionSchema.parse({
      sessionId: 'session',
      revision: 1,
      planVersionId: id,
      schedule: {
        blockId: 'block',
        date: '2026-01-01',
        localStartTime: null,
        timezone: 'Asia/Seoul',
      },
      status: 'completed',
      reportedAt: '2026-01-01T01:00:00Z',
      reason: null,
      source: 'user',
      method: 'self_report',
      definitionVersion: 'session-completion-v1',
    });
    const current = [
      {
        aggregate_id: id,
        id: plan.id,
        version: plan.version,
        created_at: plan.createdAt,
        draft: plan.draft,
      },
    ];
    const completions = [{ session_id: 'session', revision: 1, record_json: report }];
    const f = fixture({
      current,
      completions,
      scalar: { bytes: '10000', sources: '4', heads: '1', completions: '1' },
    });
    expect(await captureRacePlanImpactCalendarRootsIn(f.tx, command, f.budget)).toEqual({
      event,
      currentTraining: { aggregateId: id, snapshot: plan },
      completions: [report],
    });
    const g = fixture({
      current,
      completions: [{ ...completions[0], revision: 2 }],
      scalar: { bytes: '10000', sources: '4', heads: '1', completions: '1' },
    });
    await expect(
      captureRacePlanImpactCalendarRootsIn(g.tx, command, g.budget),
    ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
    const h = fixture({
      current,
      completions: [
        { session_id: 'other', revision: 1, record_json: { ...report, sessionId: 'other' } },
      ],
      scalar: { bytes: '10000', sources: '4', heads: '1', completions: '1' },
    });
    await expect(
      captureRacePlanImpactCalendarRootsIn(h.tx, command, h.budget),
    ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
  });
  it('does not catch SQL permission failures or infer unavailable capability', async () => {
    const error = Object.assign(new Error('query failed'), { code: '42501' });
    const query = vi.fn().mockRejectedValue(error);
    const tx = { athleteId: 'athlete', query };
    await expect(
      captureRacePlanImpactCalendarRootsIn(tx, command, { bytes: 0n, sources: 0 }),
    ).rejects.toBe(error);
  });
});
