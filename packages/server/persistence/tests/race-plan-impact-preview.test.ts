import { beforeEach, describe, expect, it, vi } from 'vitest';
import { raceEventSchema } from '@workout/contracts/races';
import type * as ContextModule from '../src/race-plan-impact-context.js';
import type * as InputModule from '../src/race-plan-impact-projection-input.js';
import type * as AdmissionModule from '../src/app-admission.js';
import type { Transaction } from '../src/database.js';
const mocks = vi.hoisted(() => ({
  roots: vi.fn(),
  full: vi.fn(),
  build: vi.fn(),
  admission: vi.fn(),
}));
vi.mock('../src/race-plan-impact-calendar-roots.js', () => ({
  captureRacePlanImpactCalendarRootsIn: mocks.roots,
}));
vi.mock('../src/race-plan-impact-context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ContextModule>()),
  captureRacePlanImpactContext: mocks.full,
}));
vi.mock('../src/race-plan-impact-projection-input.js', async (importOriginal) => ({
  ...(await importOriginal<typeof InputModule>()),
  buildRacePlanImpactProjectionInput: mocks.build,
}));
vi.mock('../src/app-admission.js', async (importOriginal) => ({
  ...(await importOriginal<typeof AdmissionModule>()),
  requireAppAdmission: mocks.admission,
}));
import { previewRacePlanImpactTransaction } from '../src/race-plan-impact-preview.js';
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
const intent = {
  expectedEvent: { id, revision: 1 },
  newLocalDate: '2026-01-02',
  selection: { kind: 'keep_plan' },
  resolutions: { nutrition: [], routines: [] },
};
const tx: Transaction = { athleteId: 'athlete', query: vi.fn() };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.admission.mockResolvedValue(undefined);
  mocks.roots.mockResolvedValue({ event, currentTraining: null, completions: [] });
});
describe('bounded preliminary calendar then authoritative full preview', () => {
  it('uses one full collector on projected success and preserves its complete builder result', async () => {
    const context = { exact: 'full' },
      projection = {
        status: 'projected',
        collectorSelection: { kind: 'keep_plan' },
        missingFacts: [{ kind: 'unchanged' }],
      };
    mocks.full.mockResolvedValue(context);
    mocks.build.mockReturnValue(projection);
    const budget = { bytes: 10n, sources: 1 };
    expect(await previewRacePlanImpactTransaction(tx, intent, budget)).toEqual({
      context,
      projection,
    });
    expect(mocks.roots).toHaveBeenCalledWith(tx, { eventId: id, expectedRevision: 1 }, budget);
    expect(mocks.full).toHaveBeenCalledExactlyOnceWith(
      tx,
      {
        eventId: id,
        expectedRevision: 1,
        selection: { kind: 'keep_plan' },
        calendarIntent: expect.objectContaining(intent),
      },
      budget,
    );
    expect(mocks.build).toHaveBeenCalledWith(context, expect.objectContaining(intent));
  });
  it('calendar rejection retains the existing full keep-plan blocked result', async () => {
    const context = { originalDigest: 'keep' },
      projection = { status: 'blocked', reason: 'projection_bound' };
    mocks.full.mockResolvedValue(context);
    mocks.build.mockReturnValue(projection);
    const rejectedIntent = { ...intent, newLocalDate: '2040-01-02' };
    expect(await previewRacePlanImpactTransaction(tx, rejectedIntent)).toEqual({
      context,
      projection,
    });
    expect(mocks.full).toHaveBeenCalledTimes(1);
    expect(mocks.full.mock.calls[0]?.[1]).toEqual({
      eventId: id,
      expectedRevision: 1,
      selection: { kind: 'keep_plan' },
    });
  });
  it('full-source rejection without a collector selector re-reads the original keep DTO using the same budget', async () => {
    const derived = { digest: 'derived' },
      keep = { digest: 'old-keep' };
    const rejected = {
      status: 'blocked',
      reason: 'invalid_result',
      missingFacts: [{ kind: 'frozen_blueprint' }],
    };
    mocks.full.mockResolvedValueOnce(derived).mockResolvedValueOnce(keep);
    mocks.build.mockReturnValue(rejected);
    const budget = { bytes: 0n, sources: 0 };
    expect(await previewRacePlanImpactTransaction(tx, intent, budget)).toEqual({
      context: keep,
      projection: rejected,
    });
    expect(mocks.full).toHaveBeenCalledTimes(2);
    expect(mocks.full.mock.calls.every((call) => call[2] === budget)).toBe(true);
    expect(mocks.full.mock.calls[1]?.[1]).toEqual({
      eventId: id,
      expectedRevision: 1,
      selection: { kind: 'keep_plan' },
    });
    expect(mocks.build.mock.calls.map((call) => call[0])).toEqual([derived, keep]);
  });
  it('app failure and malformed input cannot read preliminary or full sources', async () => {
    await expect(
      previewRacePlanImpactTransaction(tx, { ...intent, capture: {} }),
    ).rejects.toMatchObject({ code: 'INVALID_INTENT' });
    expect(mocks.roots).not.toHaveBeenCalled();
    mocks.admission.mockRejectedValue(new Error('failure'));
    await expect(previewRacePlanImpactTransaction(tx, intent)).rejects.toMatchObject({
      code: 'CONTEXT_UNAVAILABLE',
    });
    expect(mocks.roots).not.toHaveBeenCalled();
    expect(mocks.full).not.toHaveBeenCalled();
  });
});
