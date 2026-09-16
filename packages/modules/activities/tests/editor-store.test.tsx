import { expect, it } from 'vitest';
import { createEditorStore } from '../src/editor-store';
it('disposal clears private pending commands even while user reset is forbidden', () => {
  const store = createEditorStore('2026-09-15T00:00:00Z', 'Asia/Seoul');
  const actions = store.getState().actions;
  actions.change('note', 'private report');
  actions.preview({
    path: '/bff/v1/activities',
    method: 'POST',
    body: { note: 'private report' },
    idempotencyKey: 'private-command',
  });
  actions.phase('uncertain');
  actions.reset();
  expect(store.getState().fields.note).toBe('private report');
  expect(store.getState().command).not.toBeNull();
  actions.dispose();
  expect(store.getState().fields.note).toBe('');
  expect(store.getState().original).toBeNull();
  expect(store.getState().command).toBeNull();
  expect(store.getState().dirty).toBe(false);
});
