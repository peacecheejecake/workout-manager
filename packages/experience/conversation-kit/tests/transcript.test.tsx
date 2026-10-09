import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ConversationTranscript, type ConversationTranscriptProps } from '../src/transcript';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const message = (id: string) => ({ id, author: '사용자', content: `<b>${id}</b>\n본문` });
const base: ConversationTranscriptProps = {
  lifetimeKey: 'alice/thread1',
  label: '대화 기록',
  messages: [message('a'), message('b')],
  state: { kind: 'ready' },
  empty: <p>기록 없음</p>,
};
function viewport() {
  const element = screen.getByRole('region', { name: '대화 기록 스크롤 영역' });
  if (!(element instanceof HTMLDivElement)) throw new Error('missing viewport');
  return element;
}
function layout(element: HTMLDivElement) {
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, get: () => 1000 },
    clientHeight: { configurable: true, get: () => 200 },
  });
  vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() => ({
    top: 0,
    bottom: 200,
    left: 0,
    right: 200,
    width: 200,
    height: 200,
    x: 0,
    y: 0,
    toJSON: () => undefined,
  }));
}
it('renders text literally and distinguishes empty/error/loading with owner actions', () => {
  const load = vi.fn();
  const { rerender } = render(<ConversationTranscript {...base} onLoadOlder={load} />);
  expect(screen.getByText('<b>a</b> 본문')).toBeInTheDocument();
  expect(viewport().querySelector('b')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '이전 메시지 더 보기' }));
  expect(load).toHaveBeenCalledOnce();
  rerender(
    <ConversationTranscript
      {...base}
      messages={[]}
      state={{ kind: 'error', message: '조회 실패' }}
    />,
  );
  expect(screen.getByRole('alert')).toHaveTextContent('조회 실패');
  expect(screen.queryByText('기록 없음')).toBeNull();
  rerender(<ConversationTranscript {...base} messages={[]} />);
  expect(screen.getByText('기록 없음')).toBeInTheDocument();
});
it('does not pull a reading user down on append and follows only after explicit new-message action', () => {
  const { rerender } = render(<ConversationTranscript {...base} />);
  const element = viewport();
  layout(element);
  element.scrollTop = 100;
  fireEvent.scroll(element);
  rerender(<ConversationTranscript {...base} messages={[...base.messages, message('c')]} />);
  expect(element.scrollTop).toBe(100);
  fireEvent.click(screen.getByRole('button', { name: '새 메시지 보기' }));
  expect(element.scrollTop).toBe(1000);
  expect(screen.queryByRole('button', { name: '새 메시지 보기' })).toBeNull();
  element.scrollTop = 800;
  fireEvent.scroll(element);
  rerender(
    <ConversationTranscript {...base} messages={[...base.messages, message('c'), message('d')]} />,
  );
  expect(element.scrollTop).toBe(1000);
});
it('preserves a visible message offset when an older page is prepended', () => {
  const { rerender } = render(<ConversationTranscript {...base} />);
  const element = viewport();
  layout(element);
  const a = element.querySelector<HTMLElement>('[data-message-id="a"]');
  if (!a) throw new Error('missing message');
  let top = 25;
  vi.spyOn(a, 'getBoundingClientRect').mockImplementation(() => ({
    top,
    bottom: top + 50,
    left: 0,
    right: 100,
    width: 100,
    height: 50,
    x: 0,
    y: top,
    toJSON: () => undefined,
  }));
  element.scrollTop = 100;
  fireEvent.scroll(element);
  top = 125;
  rerender(<ConversationTranscript {...base} messages={[message('older'), ...base.messages]} />);
  expect(element.scrollTop).toBe(200);
});
it('replaces private transcript DOM and scroll state when its lifetime changes', () => {
  const { rerender } = render(<ConversationTranscript {...base} />);
  const old = viewport();
  rerender(
    <ConversationTranscript {...base} lifetimeKey="bob/thread2" messages={[message('bob')]} />,
  );
  expect(viewport()).not.toBe(old);
  expect(screen.queryByText('<b>a</b> 본문')).toBeNull();
  expect(screen.getByText('<b>bob</b> 본문')).toBeInTheDocument();
});
