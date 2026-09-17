import { describe, it, expect } from 'vitest';
import {
  createPlannedTableInteractionStore,
  visibleRangeIds,
} from '../src/planned-table-interaction';

describe('planned table interaction lifetime', () => {
  it('selects inclusive reversed ranges against current visible order', () => {
    const store = createPlannedTableInteractionStore(),
      actions = store.getState().actions;
    actions.startRange('d');
    actions.endRange('b', ['a', 'b', 'c', 'd']);
    expect(store.getState().state).toMatchObject({ anchorId: 'd', rangeIds: ['b', 'c', 'd'] });
    actions.endRange('a', ['d', 'c', 'b', 'a']);
    expect(store.getState().state.rangeIds).toEqual(['d', 'c', 'b', 'a']);
    expect(store.getState().state.anchorId).toBe('d');
  });
  it('retains selected IDs when display order changes and derives only visible members', () => {
    const store = createPlannedTableInteractionStore(),
      actions = store.getState().actions;
    actions.startRange('a');
    actions.endRange('c', ['a', 'b', 'c']);
    const previous = store.getState().state;
    expect(visibleRangeIds(previous.rangeIds, ['c', 'a', 'other'])).toEqual(['c', 'a']);
    expect(store.getState().state).toBe(previous);
    expect(previous.rangeIds).toEqual(['a', 'b', 'c']);
    actions.endRange('other', ['c', 'a', 'other']);
    expect(store.getState().state.rangeIds).toEqual(['a', 'other']);
  });
  it('uses a new anchor when old anchor is absent and ignores an absent target', () => {
    const store = createPlannedTableInteractionStore(),
      actions = store.getState().actions;
    actions.endRange('b', ['a', 'b']);
    expect(store.getState().state).toMatchObject({ anchorId: 'b', rangeIds: ['b'] });
    actions.startRange('hidden');
    actions.endRange('a', ['a', 'b']);
    expect(store.getState().state).toMatchObject({ anchorId: 'a', rangeIds: ['a'] });
    const previous = store.getState().state;
    actions.endRange('missing', ['a', 'b']);
    expect(store.getState().state).toBe(previous);
  });
  it('supports independent checkbox membership and moves the anchor only when necessary', () => {
    const store = createPlannedTableInteractionStore(),
      actions = store.getState().actions;
    actions.toggleRange('b');
    actions.toggleRange('d');
    actions.toggleRange('a');
    expect(store.getState().state).toMatchObject({ anchorId: 'b', rangeIds: ['b', 'd', 'a'] });
    actions.toggleRange('d');
    expect(store.getState().state.anchorId).toBe('b');
    actions.toggleRange('b');
    expect(store.getState().state).toMatchObject({ anchorId: 'a', rangeIds: ['a'] });
    actions.toggleRange('a');
    expect(store.getState().state).toMatchObject({ anchorId: null, rangeIds: [] });
  });
  it('does not mutate input arrays, previous snapshots or passed scroll anchors', () => {
    const store = createPlannedTableInteractionStore(),
      actions = store.getState().actions,
      order = Object.freeze(['a', 'b', 'c']);
    actions.startRange('a');
    const previous = store.getState().state;
    actions.endRange('c', order);
    expect(previous.rangeIds).toEqual(['a']);
    expect(order).toEqual(['a', 'b', 'c']);
    const scroll = { id: 'b', offset: 7 };
    actions.setScrollAnchor(scroll);
    scroll.offset = 99;
    expect(store.getState().state.scrollAnchor).toEqual({ id: 'b', offset: 7 });
  });
  it('scopes factories independently and keeps scroll/mode through selection clear', () => {
    const first = createPlannedTableInteractionStore(),
      second = createPlannedTableInteractionStore(),
      actions = first.getState().actions;
    actions.startRange('row');
    actions.setRowMode('all');
    actions.setScrollLeft(42);
    actions.setScrollAnchor({ id: 'row', offset: 12 });
    actions.clearRange();
    expect(first.getState().state).toEqual({
      anchorId: null,
      rangeIds: [],
      rowMode: 'all',
      scrollLeft: 42,
      scrollAnchor: { id: 'row', offset: 12 },
    });
    expect(second.getState().state).toEqual({
      anchorId: null,
      rangeIds: [],
      rowMode: 'virtual',
      scrollLeft: 0,
      scrollAnchor: null,
    });
    actions.setRowMode('virtual');
    actions.setScrollAnchor(null);
    actions.setScrollLeft(0);
    expect(first.getState().state).toEqual(second.getState().state);
  });
});
