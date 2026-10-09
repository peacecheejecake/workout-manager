import { describe, expect, it, vi } from 'vitest';
import {
  createStreamPresentationStore,
  type StreamPresentationScope,
} from '../src/stream-presentation-store.js';
const scope: StreamPresentationScope = {
  account: 'alice',
  session: 'session',
  run: 'run',
  attempt: 'one',
};
const bounds = {
  maxScopeBytes: 32,
  maxTextBytes: 12,
  maxResultBytes: 12,
  maxToolEntries: 2,
  maxLabelBytes: 12,
  maxEvents: 10,
};
const text = (sequence: number, value: string, identity = scope) => ({
  scope: identity,
  sequence,
  kind: 'text' as const,
  text: value,
});
describe('invocation-local streaming presentation', () => {
  it('publishes immutable stable snapshots and plaintext provisional content', () => {
    const store = createStreamPresentationStore(scope, bounds);
    const first = store.getSnapshot();
    const notify = vi.fn();
    const unsubscribe = store.subscribe(notify);
    expect(store.getSnapshot()).toBe(first);
    expect(store.accept(text(1, '<b>한</b>'))).toEqual({ accepted: true });
    expect(first.provisionalText).toBe('');
    expect(store.getSnapshot().provisionalText).toBe('<b>한</b>');
    expect(Object.isFrozen(store.getSnapshot())).toBe(true);
    unsubscribe();
    store.accept(text(2, '!'));
    expect(notify).toHaveBeenCalledTimes(1);
  });
  it('rejects duplicate, reversed and gap events without advancing or notifying', () => {
    const store = createStreamPresentationStore(scope, bounds);
    const notify = vi.fn();
    store.subscribe(notify);
    store.accept(text(1, 'a'));
    const accepted = store.getSnapshot();
    for (const sequence of [1, 0, 3, 1.5, NaN])
      expect(store.accept(text(sequence, 'b'))).toEqual({ accepted: false, reason: 'sequence' });
    expect(store.getSnapshot()).toBe(accepted);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(store.accept(text(2, 'b')).accepted).toBe(true);
  });
  it('rejects late scope/session/run/attempt events and isolates another invocation', () => {
    const store = createStreamPresentationStore(scope, bounds);
    for (const field of ['account', 'session', 'run', 'attempt'] as const)
      expect(store.accept(text(1, 'old', { ...scope, [field]: 'other' }))).toEqual({
        accepted: false,
        reason: 'scope',
      });
    const next = createStreamPresentationStore({ ...scope, account: 'bob' }, bounds);
    store.dispose();
    expect(store.accept(text(1, 'late'))).toEqual({ accepted: false, reason: 'disposed' });
    expect(next.getSnapshot().sequence).toBe(0);
  });
  it('counts UTF8 cumulative bytes before appending and preserves state on rejection', () => {
    const store = createStreamPresentationStore(scope, { ...bounds, maxTextBytes: 6 });
    expect(store.accept(text(1, '한글')).accepted).toBe(true);
    const snapshot = store.getSnapshot();
    expect(store.accept(text(2, '!'))).toEqual({ accepted: false, reason: 'bounds' });
    expect(store.getSnapshot()).toBe(snapshot);
    for (const value of ['\ud800', '\udc00', '\0'])
      expect(createStreamPresentationStore(scope, bounds).accept(text(1, value)).accepted).toBe(
        false,
      );
    expect(createStreamPresentationStore(scope, bounds).accept(text(1, '😀\n')).accepted).toBe(
      true,
    );
  });
  it('replaces read-only progress in insertion order with bounded count and copied labels', () => {
    const store = createStreamPresentationStore(scope, bounds);
    const tool = { id: 'search', label: '검색', state: 'running' as const, resultText: null };
    store.accept({ scope, sequence: 1, kind: 'tool', tool });
    tool.label = 'changed';
    expect(store.getSnapshot().tools[0]?.label).toBe('검색');
    store.accept({
      scope,
      sequence: 2,
      kind: 'tool',
      tool: { id: 'check', label: '검사', state: 'running', resultText: null },
    });
    store.accept({
      scope,
      sequence: 3,
      kind: 'tool',
      tool: { id: 'search', label: '검색', state: 'completed', resultText: '완료' },
    });
    expect(store.getSnapshot().tools.map((value) => value.id)).toEqual(['search', 'check']);
    expect(
      store.accept({
        scope,
        sequence: 4,
        kind: 'tool',
        tool: { id: 'third', label: '추가', state: 'running', resultText: null },
      }),
    ).toEqual({ accepted: false, reason: 'bounds' });
    expect(Object.isFrozen(store.getSnapshot().tools)).toBe(true);
    expect(Object.isFrozen(store.getSnapshot().tools[0])).toBe(true);
    expect(store.getSnapshot().tools[0]?.label).toBe('검색');
  });
  it('rejects oversized label and event limit without making a terminal approval', () => {
    const store = createStreamPresentationStore(scope, { ...bounds, maxEvents: 1 });
    expect(
      store.accept({
        scope,
        sequence: 1,
        kind: 'tool',
        tool: { id: 'a', label: '한'.repeat(5), state: 'running', resultText: null },
      }).accepted,
    ).toBe(false);
    expect(store.accept(text(1, 'a')).accepted).toBe(true);
    expect(store.accept({ scope, sequence: 2, kind: 'terminal', state: 'completed' })).toEqual({
      accepted: false,
      reason: 'bounds',
    });
    expect(store.getSnapshot().phase).toBe('active');
  });
  it.each(['completed', 'cancelled', 'unavailable'] as const)(
    'terminal %s rejects all later events',
    (state) => {
      const store = createStreamPresentationStore(scope, bounds);
      store.accept(text(1, 'a'));
      store.accept({ scope, sequence: 2, kind: 'terminal', state });
      expect(store.getSnapshot()).toMatchObject({
        phase: 'terminal',
        terminal: state,
        provisionalText: 'a',
      });
      expect(store.accept(text(3, 'b'))).toEqual({ accepted: false, reason: 'terminal' });
      store.dispose();
      expect(store.getSnapshot()).toMatchObject({
        phase: 'disposed',
        provisionalText: '',
        tools: [],
        terminal: null,
      });
    },
  );
  it('notifies disposal once, clears listeners, and isolates observer failures', () => {
    const store = createStreamPresentationStore(scope, bounds);
    const notify = vi.fn();
    store.subscribe(() => {
      throw new Error('observer');
    });
    store.subscribe(notify);
    store.accept(text(1, 'a'));
    store.dispose();
    const disposed = store.getSnapshot();
    store.dispose();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toBe(disposed);
    store.subscribe(notify);
    store.accept(text(2, 'late'));
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('correlates immutable tool results with identity and terminal state', () => {
    const store = createStreamPresentationStore(scope, bounds);
    const send = (
      sequence: number,
      state: 'running' | 'completed' | 'unavailable',
      resultText: string | null,
      label = '검색',
    ) =>
      store.accept({
        scope,
        sequence,
        kind: 'tool',
        tool: { id: 'search', label, state, resultText },
      });
    expect(send(1, 'running', null).accepted).toBe(true);
    expect(send(2, 'completed', '한글').accepted).toBe(true);
    const completed = store.getSnapshot();
    expect(completed.tools[0]?.resultText).toBe('한글');
    for (const event of [
      () => send(3, 'running', null),
      () => send(3, 'unavailable', null),
      () => send(3, 'completed', '다름'),
      () => send(3, 'completed', '한글', '다른 이름'),
    ])
      expect(event()).toEqual({ accepted: false, reason: 'invalid' });
    expect(store.getSnapshot()).toBe(completed);
    expect(send(3, 'completed', '한글').accepted).toBe(true);
    store.dispose();
    expect(store.getSnapshot().tools).toEqual([]);
  });
  it('bounds all tool results in UTF8 independently from provisional text', () => {
    const store = createStreamPresentationStore(scope, {
      ...bounds,
      maxResultBytes: 6,
      maxToolEntries: 3,
    });
    const result = (sequence: number, id: string, resultText: string) =>
      store.accept({
        scope,
        sequence,
        kind: 'tool',
        tool: { id, label: id, state: 'completed', resultText },
      });
    expect(result(1, 'one', '한').accepted).toBe(true);
    expect(result(2, 'two', '글').accepted).toBe(true);
    expect(result(3, 'two', '글').accepted).toBe(true);
    const snapshot = store.getSnapshot();
    expect(result(4, 'three', '!')).toEqual({ accepted: false, reason: 'bounds' });
    expect(store.getSnapshot()).toBe(snapshot);
    expect(store.accept(text(4, 'abc')).accepted).toBe(true);
    expect(snapshot.provisionalText).toBe('');
  });
  it('retains plain result text without markup interpretation and rejects oversized or malformed text', () => {
    const store = createStreamPresentationStore(scope, { ...bounds, maxResultBytes: 32 });
    const resultText = '<b>결과</b>\n😀';
    expect(
      store.accept({
        scope,
        sequence: 1,
        kind: 'tool',
        tool: { id: 'one', label: 'one', state: 'completed', resultText },
      }).accepted,
    ).toBe(true);
    expect(store.getSnapshot().tools[0]?.resultText).toBe(resultText);
    for (const resultText of ['한'.repeat(11), '\ud800', '\0']) {
      const next = createStreamPresentationStore(scope, { ...bounds, maxResultBytes: 32 });
      expect(
        next.accept({
          scope,
          sequence: 1,
          kind: 'tool',
          tool: { id: 'one', label: 'one', state: 'completed', resultText },
        }),
      ).toEqual({ accepted: false, reason: 'bounds' });
      expect(next.getSnapshot().tools).toEqual([]);
    }
    expect(() => createStreamPresentationStore(scope, { ...bounds, maxResultBytes: NaN })).toThrow(
      'INVALID_PRESENTATION_CONFIGURATION',
    );
  });
  it('rejects invalid completion correlation, unavailable reversal and runtime kind deterministically', () => {
    const store = createStreamPresentationStore(scope, bounds);
    const send = (state: 'running' | 'completed' | 'unavailable', resultText: string | null) =>
      store.accept({
        scope,
        sequence: 1,
        kind: 'tool',
        tool: { id: 'a', label: 'a', state, resultText },
      });
    expect(send('running', 'result')).toEqual({ accepted: false, reason: 'invalid' });
    expect(send('unavailable', 'result')).toEqual({ accepted: false, reason: 'invalid' });
    expect(send('completed', null)).toEqual({ accepted: false, reason: 'invalid' });
    expect(
      Reflect.apply(store.accept, store, [{ scope, sequence: 1, kind: 'raw-provider-output' }]),
    ).toEqual({ accepted: false, reason: 'invalid' });
    expect(send('unavailable', null).accepted).toBe(true);
    expect(
      store.accept({
        scope,
        sequence: 2,
        kind: 'tool',
        tool: { id: 'a', label: 'a', state: 'completed', resultText: 'a' },
      }),
    ).toEqual({ accepted: false, reason: 'invalid' });
  });
  it('snapshots caller scope/bounds and rejects invalid configurations', () => {
    const identity = { ...scope };
    const limits = { ...bounds };
    const store = createStreamPresentationStore(identity, limits);
    identity.session = 'changed';
    limits.maxTextBytes = 1;
    expect(store.accept(text(1, 'hello')).accepted).toBe(true);
    for (const maxTextBytes of [0, -1, NaN, Infinity, 1.5])
      expect(() => createStreamPresentationStore(scope, { ...bounds, maxTextBytes })).toThrow(
        'INVALID_PRESENTATION_CONFIGURATION',
      );
    expect(() => createStreamPresentationStore({ ...scope, session: '' }, bounds)).toThrow(
      'INVALID_PRESENTATION_CONFIGURATION',
    );
  });
});
