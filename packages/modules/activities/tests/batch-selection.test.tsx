import { describe, it, expect } from 'vitest';
import { createBatchSelectionStore, type BatchTarget } from '../src/batch-selection';
const target = (index: number, revision = 1): BatchTarget => ({
  id: String(index),
  revision,
  title: `Target${index}`,
  sourceKind: 'fixture',
});
describe('batch target selection', () => {
  it('preserves existing revisions/order and copies new targets independently', () => {
    const store = createBatchSelectionStore(),
      other = createBatchSelectionStore();
    const item = target(0);
    store.getState().toggle(item);
    item.revision = 5;
    store.getState().selectPage([target(0, 9), target(1), target(1, 2)]);
    expect(store.getState().targets).toEqual([target(0), target(1)]);
    expect(other.getState().targets).toEqual([]);
    store.getState().toggle(target(0, 100));
    expect(store.getState().targets).toEqual([target(1)]);
    store.getState().remove(['1']);
    expect(store.getState().targets).toEqual([]);
  });
  it('rejects overflow atomically and allows exactly 100 selected targets', () => {
    const store = createBatchSelectionStore();
    store.getState().toggle(target(0));
    const before = store.getState().targets;
    store.getState().selectPage(Array.from({ length: 101 }, (_, i) => target(i)));
    expect(store.getState().targets).toBe(before);
    expect(store.getState().limitExceeded).toBe(true);
    store.getState().selectPage(Array.from({ length: 100 }, (_, i) => target(i)));
    expect(store.getState().targets).toHaveLength(100);
    expect(store.getState().limitExceeded).toBe(false);
    store.getState().toggle(target(100));
    expect(store.getState().targets).toHaveLength(100);
    expect(store.getState().limitExceeded).toBe(true);
    store.getState().clear();
    expect(store.getState().targets).toEqual([]);
    expect(store.getState().limitExceeded).toBe(false);
  });
});

it('locks user selection mutations while permitting confirmed success removal', () => {
  const store = createBatchSelectionStore();
  store.getState().selectPage([target(0), target(1)]);
  store.getState().setLocked(true);
  store.getState().toggle(target(0));
  store.getState().selectPage([target(2)]);
  store.getState().clear();
  expect(store.getState().targets).toEqual([target(0), target(1)]);
  store.getState().remove(['0']);
  expect(store.getState().targets).toEqual([target(1)]);
  store.getState().setLocked(false);
  store.getState().clear();
  expect(store.getState().targets).toEqual([]);
});
