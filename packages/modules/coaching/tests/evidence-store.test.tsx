import { describe, it, expect } from 'vitest';
import { createEvidenceDraftStore } from '../src/evidence-store';
const pending = {
  threadId: 'thread',
  command: {
    expectedConversationRevision: 1,
    window: { from: '2026-09-01', toExclusive: '2026-09-02', timezone: 'UTC' },
    idempotencyKey: 'stable',
  },
};
describe('evidence draft lifetime', () => {
  it('isolates drafts with blank defaults, preserves them on success and rejection', () => {
    const a = createEvidenceDraftStore(),
      b = createEvidenceDraftStore();
    a.getState().actions.edit('one', 'from', '2026-09-01');
    a.getState().actions.edit('two', 'timezone', 'Asia/Seoul');
    expect(a.getState().drafts.one).toEqual({ from: '2026-09-01', toExclusive: '', timezone: '' });
    expect(b.getState().drafts).toEqual({});
    a.getState().actions.begin(pending);
    a.getState().actions.succeeded();
    expect(a.getState().drafts.one?.from).toBe('2026-09-01');
    a.getState().actions.begin(pending);
    a.getState().actions.reject('conflict');
    expect(a.getState().drafts.two?.timezone).toBe('Asia/Seoul');
    expect(a.getState().pending).toBeNull();
  });
  it('freezes command across uncertain retries and blocks every thread edit', () => {
    const s = createEvidenceDraftStore(),
      input = structuredClone(pending);
    expect(s.getState().actions.begin(input)).toBe(true);
    input.command.window.from = 'changed';
    expect(s.getState().actions.begin(input)).toBe(false);
    s.getState().actions.edit('other', 'from', 'changed');
    expect(s.getState().drafts).toEqual({});
    expect(s.getState().actions.retry()).toBeNull();
    s.getState().actions.uncertain();
    const retry = s.getState().actions.retry();
    expect(retry).toEqual(pending);
    if (retry) retry.command.idempotencyKey = 'changed';
    expect(s.getState().pending).toEqual(pending);
  });
  it('clears all sensitive drafts and command state on lifetime reset', () => {
    const s = createEvidenceDraftStore();
    s.getState().actions.edit('one', 'timezone', 'UTC');
    s.getState().actions.begin(pending);
    s.getState().actions.uncertain();
    s.getState().actions.reset();
    expect(s.getState()).toMatchObject({
      drafts: {},
      pending: null,
      phase: 'idle',
      feedback: null,
    });
    s.getState().actions.uncertain();
    expect(s.getState().phase).toBe('idle');
  });
});
