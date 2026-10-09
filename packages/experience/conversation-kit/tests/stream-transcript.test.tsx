import { useState } from 'react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { StreamTranscript } from '../src/stream-transcript.js';
import { ConversationComposer } from '../src/composer.js';
import {
  createStreamPresentationStore,
  type StreamPresentationStore,
} from '../src/stream-presentation-store.js';
const scope = { account: 'alice', session: 'one', run: 'run', attempt: 'one' };
const bounds = {
  maxScopeBytes: 100,
  maxTextBytes: 1000,
  maxResultBytes: 1000,
  maxToolEntries: 4,
  maxLabelBytes: 100,
  maxEvents: 20,
};
const create = () => createStreamPresentationStore(scope, bounds);
function append(store: StreamPresentationStore, sequence: number, text: string) {
  store.accept({ scope, sequence, kind: 'text', text });
}
it('keeps stable empty SSR snapshots separate for two factory lifetimes', () => {
  const alice = create();
  const bob = createStreamPresentationStore({ ...scope, account: 'bob' }, bounds);
  const initial = alice.getServerSnapshot();
  append(alice, 1, 'private');
  expect(alice.getServerSnapshot()).toBe(initial);
  expect(bob.getServerSnapshot()).not.toBe(initial);
  expect(Object.isFrozen(initial)).toBe(true);
  expect(initial.provisionalText).toBe('');
  const html = renderToString(
    <>
      <StreamTranscript store={alice} label="Alice" />
      <StreamTranscript store={bob} label="Bob" />
    </>,
  );
  expect(html).not.toContain('private');
  expect(html).toContain('Alice');
  expect(html).toContain('Bob');
});
it('hydrates the empty server view then receives the live snapshot and later updates', async () => {
  const store = create();
  append(store, 1, '초기 live');
  const element = document.createElement('div');
  document.body.append(element);
  element.innerHTML = renderToString(<StreamTranscript store={store} label="hydrate" />);
  expect(element.textContent).not.toContain('초기 live');
  const recover = vi.fn();
  const root = hydrateRoot(element, <StreamTranscript store={store} label="hydrate" />, {
    onRecoverableError: recover,
  });
  try {
    await act(async () => {});
    expect(element.textContent).toContain('초기 live');
    act(() => append(store, 2, ' 업데이트'));
    expect(element.textContent).toContain('초기 live 업데이트');
    expect(recover).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    element.remove();
  }
});
it('renders plaintext tool results and terminal presentation without approval controls', () => {
  const store = create();
  render(<StreamTranscript store={store} label="실행" />);
  act(() => {
    append(store, 1, '<b>내용</b>');
    store.accept({
      scope,
      sequence: 2,
      kind: 'tool',
      tool: { id: 'search', label: '자료 검색', state: 'running', resultText: null },
    });
  });
  expect(screen.getByText('자료 검색 · 진행 중')).toBeInTheDocument();
  act(() =>
    store.accept({
      scope,
      sequence: 3,
      kind: 'tool',
      tool: {
        id: 'search',
        label: '자료 검색',
        state: 'completed',
        resultText: '<script>결과</script>\n한글',
      },
    }),
  );
  expect(screen.getByText('<b>내용</b>')).toBeInTheDocument();
  expect(screen.getByText('<script>결과</script> 한글')).toBeInTheDocument();
  expect(document.querySelector('script')).toBeNull();
  act(() => store.accept({ scope, sequence: 4, kind: 'terminal', state: 'completed' }));
  expect(screen.getByRole('status')).toHaveTextContent('검증과 승인은 별도로');
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
it('changes stores without retaining old events and clears on controller disposal', () => {
  const old = create();
  const fresh = createStreamPresentationStore({ ...scope, session: 'two' }, bounds);
  const view = render(<StreamTranscript store={old} label="실행" />);
  act(() => append(old, 1, 'old private'));
  expect(screen.getByText('old private')).toBeInTheDocument();
  view.rerender(<StreamTranscript store={fresh} label="실행" />);
  act(() => append(old, 2, ' late'));
  expect(screen.queryByText(/old private/)).toBeNull();
  act(() =>
    fresh.accept({
      scope: { ...scope, session: 'two' },
      sequence: 1,
      kind: 'text',
      text: 'new private',
    }),
  );
  expect(screen.getByText('new private')).toBeInTheDocument();
  act(() => fresh.dispose());
  expect(screen.queryByText('new private')).toBeNull();
  expect(screen.getByText('표시할 실행 정보가 없습니다.')).toBeInTheDocument();
});
it('unsubscribes on unmount without disposing the caller-owned store', () => {
  const store = create();
  const unsubscribe = vi.fn();
  const subscribe = vi.fn((listener: () => void) => {
    const stop = store.subscribe(listener);
    return () => {
      unsubscribe();
      stop();
    };
  });
  const view = render(<StreamTranscript store={{ ...store, subscribe }} label="실행" />);
  expect(subscribe).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  expect(store.getSnapshot().phase).toBe('active');
  expect(store.accept({ scope, sequence: 1, kind: 'text', text: 'later' }).accepted).toBe(true);
});
it('preserves adjacent controlled composer draft and focus during stream updates', async () => {
  const store = create();
  const submit = vi.fn();
  const user = userEvent.setup();
  function Owner() {
    const [value, setValue] = useState('');
    return (
      <>
        <StreamTranscript store={store} label="실행" />
        <ConversationComposer
          label="메시지"
          value={value}
          onChange={setValue}
          onSubmit={submit}
          submitLabel="저장"
          state={{ kind: 'idle' }}
          maxLength={100}
        />
      </>
    );
  }
  render(<Owner />);
  const input = screen.getByRole('textbox', { name: '메시지' });
  await user.type(input, '한글{Enter}draft');
  act(() => {
    append(store, 1, '생성 중');
    store.accept({ scope, sequence: 2, kind: 'terminal', state: 'completed' });
  });
  expect(input).toHaveValue('한글\ndraft');
  expect(input).toHaveFocus();
  expect(submit).not.toHaveBeenCalled();
});
