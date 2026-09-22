import { describe, expect, it } from 'vitest';
import { createDetailSelectionStore } from '../src/detail-selection';
describe('scoped detail selection', () => {
  it('keeps factories independent and makes record/lap/range selection exclusive', () => {
    const first = createDetailSelectionStore(),
      second = createDetailSelectionStore();
    first.getState().selectRecord(0, 0);
    expect(first.getState()).toMatchObject({
      recordIndex: 0,
      lapIndex: null,
      range: { start: 0, end: 0 },
    });
    first.getState().selectLap(0, { start: 0, end: 10 });
    expect(first.getState()).toMatchObject({
      recordIndex: null,
      lapIndex: 0,
      range: { start: 0, end: 10 },
    });
    first.getState().selectRange({ start: 2, end: 5 });
    expect(first.getState()).toMatchObject({
      recordIndex: null,
      lapIndex: null,
      range: { start: 2, end: 5 },
    });
    expect(second.getState()).toMatchObject({ recordIndex: null, lapIndex: null, range: null });
    first.getState().clear();
    expect(first.getState()).toMatchObject({ recordIndex: null, lapIndex: null, range: null });
  });
  it('keeps a picked track sample, and drops it whenever an observation is selected instead', () => {
    const store = createDetailSelectionStore();
    const sample = { trackRevision: 'activity:1', sampleId: '0:4' };
    // No definite observation: the sample stands on its own and nothing else is selected.
    store.getState().selectSample(sample, null, null);
    expect(store.getState()).toMatchObject({
      sample,
      recordIndex: null,
      lapIndex: null,
      range: null,
    });
    // A definite link selects the observation too, in one update.
    store.getState().selectSample(sample, 4, 40);
    expect(store.getState()).toMatchObject({
      sample,
      recordIndex: 4,
      range: { start: 40, end: 40 },
    });
    // Selecting an observation names an observation, not a sample.
    store.getState().selectRecord(1, 10);
    expect(store.getState().sample).toBeNull();
    store.getState().selectSample(sample, null, null);
    store.getState().selectLap(0, { start: 0, end: 10 });
    expect(store.getState().sample).toBeNull();
    store.getState().selectSample(sample, null, null);
    store.getState().selectRange({ start: 0, end: 10 });
    expect(store.getState().sample).toBeNull();
    store.getState().selectSample(sample, null, null);
    store.getState().clear();
    expect(store.getState().sample).toBeNull();
  });
  it('copies the picked sample so a caller cannot mutate stored state', () => {
    const store = createDetailSelectionStore();
    const sample = { trackRevision: 'activity:1', sampleId: '0:4' };
    store.getState().selectSample(sample, null, null);
    const stored = store.getState().sample;
    expect(stored).not.toBe(sample);
    expect(stored).toEqual(sample);
  });
  it('preserves unknown time, copies incoming ranges, and never mutates prior state', () => {
    const store = createDetailSelectionStore();
    const range = { start: 0, end: 1 };
    store.getState().selectLap(3, range);
    const previous = store.getState();
    range.end = 5;
    expect(previous.range?.end).toBe(1);
    store.getState().selectRecord(4, null);
    expect(previous).toMatchObject({ recordIndex: null, lapIndex: 3, range: { start: 0, end: 1 } });
    expect(store.getState()).toMatchObject({ recordIndex: 4, lapIndex: null, range: null });
    store.getState().selectLap(5, null);
    expect(store.getState()).toMatchObject({ recordIndex: null, lapIndex: 5, range: null });
    store.getState().selectRange(range);
    range.start = -1;
    expect(store.getState().range?.start).toBe(0);
    store.getState().selectRange(null);
    expect(store.getState().range).toBeNull();
  });
});
