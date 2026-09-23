import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { DataPanels } from '../src/data-panels';
import type { Editor } from '@tiptap/core';
import type * as TiptapReact from '@tiptap/react';

const capture = vi.hoisted<{ editor: Editor | null }>(() => ({ editor: null }));
vi.mock('@tiptap/react', async (importOriginal) => {
  const actual = await importOriginal<typeof TiptapReact>();
  return {
    ...actual,
    useEditor: (...args: Parameters<typeof actual.useEditor>) => {
      const editor = actual.useEditor(...args);
      capture.editor = editor;
      return editor;
    },
  };
});

const chart = vi.hoisted(() => ({
  setOption: vi.fn(),
  resize: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock('echarts/core', () => ({ use: vi.fn(), init: () => chart }));
const disconnect = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {
        disconnect();
      }
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('real table/editor with chart boundary stub', () => {
  it('keeps unknown and zero distinct while sorting/filtering both table and chart input', async () => {
    const user = userEvent.setup();
    render(<DataPanels />);
    const table = screen.getByRole('table', { name: '가상 활동 표' });
    expect(within(table).getByText('미확인')).toBeInTheDocument();
    expect(within(table).getByText('0 km')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '거리 정렬' }));
    // The default numeric sort starts descending; null remains last.
    expect(within(table).getAllByRole('rowheader').at(-1)).toHaveTextContent('가상 미확인 B');
    await user.type(screen.getByRole('textbox', { name: '활동 검색' }), '러닝');
    expect(within(table).getAllByRole('rowheader')).toHaveLength(2);
    expect(within(table).queryByText('미확인')).not.toBeInTheDocument();
    expect(chart.setOption.mock.lastCall?.[0]).toMatchObject({
      xAxis: { data: expect.arrayContaining(['가상 러닝 A', '가상 러닝 D']) },
    });
    await user.click(screen.getByRole('button', { name: '가상 러닝 A 선택' }));
    expect(screen.getByRole('button', { name: '가상 러닝 A 선택' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByText('표시 2개 · 선택 가상 러닝 A')).toBeInTheDocument();
  });
  it('supports bounded large data and non-drag chart zoom controls', async () => {
    const user = userEvent.setup();
    render(<DataPanels />);
    await user.click(screen.getByRole('button', { name: '대량 1000행' }));
    expect(screen.getByText('표시 1000개 · 선택 없음')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: '가상 활동 표' });
    // Counting 1000 row headers with the default visibility filter walks every header's
    // ancestors through jsdom's getComputedStyle — over a second of CPU on its own, which blew
    // the 5 s budget on a loaded machine. Nothing in this table is hidden, so `hidden: true`
    // counts the same rows (the filtered count below still uses the default).
    expect(within(table).getAllByRole('rowheader', { hidden: true })).toHaveLength(1000);
    fireEvent.change(screen.getByRole('textbox', { name: '활동 검색' }), {
      target: { value: '1000' },
    });
    expect(within(table).getAllByRole('rowheader')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: '차트 확대' }));
    const range = screen.getByRole('slider', { name: '차트 구간 시작 (%)' });
    fireEvent.change(range, { target: { value: '40' } });
    expect(chart.setOption.mock.lastCall?.[0]).toMatchObject({
      dataZoom: [{ start: 40, end: 60 }],
    });
    await user.click(screen.getByRole('button', { name: '차트 전체 보기' }));
    expect(screen.queryByRole('slider', { name: '차트 구간 시작 (%)' })).not.toBeInTheDocument();
    expect(chart.setOption.mock.lastCall?.[0]).toMatchObject({
      dataZoom: [{ start: 0, end: 100 }],
    });
  });
  it('reflects real bold transactions, cursor selection, shortcut and undo in the toolbar', async () => {
    const user = userEvent.setup();
    render(<DataPanels />);
    const input = await screen.findByRole('textbox', { name: '개발 메모 편집기' });
    const button = screen.getByRole('button', { name: '굵게 전환' });
    await waitFor(() => expect(button).toBeEnabled());
    const editor = capture.editor;
    if (!editor) throw new Error('Expected initialized editor');
    // JSDOM has no text-range geometry; only suppress its unsupported scroll measurement.
    editor.setOptions({
      editorProps: { ...editor.options.editorProps, handleScrollToSelection: () => true },
    });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 4 });
    });
    await user.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(input.querySelector('strong')).toHaveTextContent('개발용');
    act(() => {
      editor.commands.setTextSelection(7);
    });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    act(() => {
      editor.commands.setTextSelection(2);
    });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: '편집 실행 취소' }));
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(input.querySelector('strong')).toBeNull();
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 4 });
    });
    fireEvent.keyDown(input, { key: 'b', code: 'KeyB', ctrlKey: true });
    expect(button).toHaveAttribute('aria-pressed', 'true');
  });
  it('serializes editor state as escaped readonly text and releases chart resources on unmount', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<DataPanels />);
    await screen.findByRole('textbox', { name: '개발 메모 편집기' });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'JSON 초안 확인' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: 'JSON 초안 확인' }));
    const output = screen.getByRole('textbox', { name: '편집기 JSON 초안' });
    expect(output).toHaveAttribute('readonly');
    if (!(output instanceof HTMLTextAreaElement)) throw new Error('Expected textarea output');
    expect(output.value).toContain('개발용 메모 초안');
    unmount();
    expect(chart.dispose).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
