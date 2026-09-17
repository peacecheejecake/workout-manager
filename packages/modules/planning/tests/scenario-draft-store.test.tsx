import { expect, it } from 'vitest';
import type { PlanScenario } from '@workout/contracts/plan-scenarios';
import { createScenarioDraftStore } from '../src/scenario-draft-store';
const scenario: PlanScenario = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  basePlanVersionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  label: 'A',
  revision: 1,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
  draft: { title: 'Alternative', timezone: 'UTC', periods: [], sessions: [] },
};
it('isolates alternative drafts from their source and other authenticated workspace lifetimes', () => {
  const first = createScenarioDraftStore(),
    second = createScenarioDraftStore();
  first.getState().start(scenario);
  second.getState().start(scenario);
  expect(first.getState().draft).not.toBe(scenario.draft);
  first.getState().edit((draft) => ({ ...draft, title: 'Private unsaved change' }));
  expect(first.getState().draft?.title).toBe('Private unsaved change');
  expect(second.getState().draft?.title).toBe('Alternative');
  expect(scenario.draft.title).toBe('Alternative');
  first.getState().undoEdit();
  expect(first.getState().draft).toEqual(scenario.draft);
  expect(first.getState().undo).toEqual([]);
});
it('rebases only the revision reference while preserving unsaved draft and its undo history', () => {
  const store = createScenarioDraftStore();
  store.getState().start(scenario);
  store.getState().edit((draft) => ({ ...draft, title: 'Keep my text' }));
  const undo = store.getState().undo;
  store.getState().rebase({
    ...scenario,
    revision: 2,
    draft: { ...scenario.draft, title: 'Concurrent server title' },
  });
  expect(store.getState().source?.revision).toBe(2);
  expect(store.getState().draft?.title).toBe('Keep my text');
  expect(store.getState().undo).toEqual(undo);
  store.getState().undoEdit();
  expect(store.getState().draft?.title).toBe('Alternative');
});
it('draft reset does not silently dismiss an uncertain command; explicit owner reset clears its phase', () => {
  const store = createScenarioDraftStore();
  store.getState().start(scenario);
  store.getState().edit((draft) => ({ ...draft, title: 'Private' }));
  store.getState().setPhase('uncertain');
  store.getState().reset();
  expect(store.getState()).toMatchObject({
    source: null,
    draft: null,
    undo: [],
    phase: 'uncertain',
  });
  store.getState().setPhase('idle');
  expect(store.getState().phase).toBe('idle');
  // Auth lifetime replacement starts clean, even while the old workspace had an in-flight command.
  store.getState().setPhase('pending');
  expect(createScenarioDraftStore().getState()).toMatchObject({
    source: null,
    draft: null,
    undo: [],
    phase: 'idle',
  });
});
it('caps undo history at fifty edits and a new explicit start resets prior alternative drafts', () => {
  const store = createScenarioDraftStore();
  store.getState().start(scenario);
  for (let i = 0; i < 60; i++) store.getState().edit((draft) => ({ ...draft, title: `Edit ${i}` }));
  expect(store.getState().undo).toHaveLength(50);
  store.getState().undoEdit();
  expect(store.getState().draft?.title).toBe('Edit 58');
  store.getState().start({ ...scenario, label: 'B', revision: 3 });
  expect(store.getState().draft).toEqual(scenario.draft);
  expect(store.getState().source?.label).toBe('B');
  expect(store.getState().undo).toEqual([]);
});
