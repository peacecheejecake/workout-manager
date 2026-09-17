import { describe, it, expect } from 'vitest';
import { createCoachingDraftStore, type CoachingPending } from '../src/draft-store';
const command: CoachingPending = {
  kind: 'append',
  threadId: 'thread',
  command: { expectedRevision: 1, message: 'Original', idempotencyKey: 'stable' },
};
describe('session-scoped coaching drafts', () => {
  it('isolates factories and preserves per-thread drafts without silently rebasing after reads', () => {
    const a = createCoachingDraftStore(),
      b = createCoachingDraftStore(),
      actions = a.getState().actions;
    actions.editMessage('one', 'first', 1);
    actions.editMessage('two', 'second', 2);
    actions.editMessage('one', 'changed', 9);
    expect(a.getState().messages).toEqual({
      one: { message: 'changed', expectedRevision: 1 },
      two: { message: 'second', expectedRevision: 2 },
    });
    expect(b.getState().messages).toEqual({});
    actions.review('one', 9);
    expect(a.getState().messages['one']).toEqual({ message: 'changed', expectedRevision: 9 });
  });
  it('freezes uncertain requests, locks edits, and retries the original key and body', () => {
    const store = createCoachingDraftStore(),
      actions = store.getState().actions,
      input = structuredClone(command);
    actions.editMessage('thread', 'Original', 1);
    expect(actions.begin(input)).toBe(true);
    input.command.message = 'mutated externally';
    actions.editMessage('thread', 'wrong', 8);
    actions.editNew('title', 'wrong');
    expect(actions.begin(command)).toBe(false);
    expect(store.getState().title).toBe('');
    actions.uncertain();
    expect(actions.retry()).toEqual(command);
    expect(actions.retry()).toBeNull();
    actions.succeeded();
    expect(store.getState().messages['thread']).toBeUndefined();
    expect(store.getState().pending).toBeNull();
  });
  it('keeps conflict drafts and only removes the successful target draft', () => {
    const store = createCoachingDraftStore(),
      actions = store.getState().actions;
    actions.editMessage('thread', 'Original', 1);
    actions.editMessage('other', 'untouched', 3);
    actions.begin(command);
    actions.reject('conflict', 'thread');
    expect(store.getState().messages['thread']?.message).toBe('Original');
    expect(store.getState().conflictThreadId).toBe('thread');
    actions.review('thread', 2);
    actions.begin({ ...command, command: { ...command.command, expectedRevision: 2 } });
    actions.succeeded();
    expect(store.getState().messages['other']?.message).toBe('untouched');
  });
});

it('explicit lifetime reset wipes all private drafts and pending command references', () => {
  const store = createCoachingDraftStore(),
    actions = store.getState().actions;
  actions.editNew('title', 'Private title');
  actions.editNew('firstMessage', 'Private message');
  actions.editMessage('thread', 'Private append', 1);
  actions.begin(command);
  actions.uncertain();
  actions.reset();
  expect(store.getState()).toMatchObject({
    title: '',
    firstMessage: '',
    messages: {},
    pending: null,
    phase: 'idle',
    feedback: null,
    conflictThreadId: null,
  });
});
