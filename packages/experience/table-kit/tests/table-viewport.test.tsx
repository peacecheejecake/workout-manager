import '@testing-library/jest-dom/vitest';
import { StrictMode, useState } from 'react';
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTableViewport, type TableViewportState } from '../src/table-viewport';

type Row = { id: string; text: string; amount: number | null };
const roster: Row[] = Array.from({ length: 10_000 }, (_, index) => ({
  id: `row-${index}`,
  text: `행 ${index}\n한글 메모 ${'가'.repeat(index % 17)}`,
  amount: index % 2 === 0 ? null : 0,
}));
const getRowId = (row: Row) => row.id;
const disconnect = vi.fn();
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(960);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(480);
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
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  disconnect.mockClear();
});
function Host({
  rows = roster,
  mode = 'virtual',
  initialFocus = null,
  state = { scrollAnchor: null, scrollLeft: 0 },
  onAnchor = () => {},
}: {
  rows?: readonly Row[];
  mode?: 'virtual' | 'all';
  initialFocus?: string | null;
  state?: TableViewportState;
  onAnchor?: (anchor: TableViewportState['scrollAnchor']) => void;
}) {
  const [focusedRowId, onFocusedRowChange] = useState(initialFocus);
  const { viewport, body, rendered, virtual, virtualizer, rememberScroll, jump, setFocusedId } =
    useTableViewport({
      rows,
      mode,
      getRowId,
      focusedRowId,
      onFocusedRowChange,
      readState: () => state,
      onScrollAnchorChange: onAnchor,
      onScrollLeftChange: () => {},
      getFocusTarget: (viewport, id) =>
        [...viewport.querySelectorAll<HTMLButtonElement>('button')].find(
          (element) => element.dataset.rowId === id,
        ) ?? null,
    });
  return (
    <>
      <button onClick={() => jump('row-9999')}>마지막 행으로 이동</button>
      <div data-testid="viewport" ref={viewport} onScroll={rememberScroll}>
        <table aria-rowcount={rows.length + 1}>
          <caption>합성 전체 행</caption>
          <thead>
            <tr aria-rowindex={1}>
              <th scope="col">내용</th>
              <th scope="col">양</th>
            </tr>
          </thead>
          <tbody ref={body}>
            {rendered.map((item) => {
              const row = rows[item.index];
              if (!row) throw new Error('TEST_ROSTER_CORRESPONDENCE');
              return (
                <tr
                  key={item.key}
                  data-index={item.index}
                  aria-rowindex={item.index + 2}
                  ref={virtual ? virtualizer.measureElement : undefined}
                >
                  <td>
                    <button data-row-id={row.id} onFocus={() => setFocusedId(row.id)}>
                      {row.text}
                    </button>
                  </td>
                  <td>{row.amount === null ? '미정' : row.amount}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
describe('controlled table viewport preparation', () => {
  it('keeps all 10000 logical rows while mounting only a bounded window', async () => {
    const before = structuredClone(roster);
    const { container } = render(
      <StrictMode>
        <Host />
      </StrictMode>,
    );
    await waitFor(() => expect(container.querySelectorAll('tbody tr').length).toBeGreaterThan(0));
    expect(container.querySelectorAll('tbody tr').length).toBeLessThan(100);
    expect(screen.getByRole('table')).toHaveAttribute('aria-rowcount', '10001');
    expect(roster).toEqual(before);
  });
  it('keeps a focused offscreen row with its absolute index', async () => {
    render(<Host initialFocus="row-9999" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /행 9999/ })).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /행 9999/ }).closest('tr')).toHaveAttribute(
      'aria-rowindex',
      '10001',
    );
  });
  it('offers all mode without truncating the roster or collapsing null and zero', () => {
    const { result } = renderHook(() =>
      useTableViewport({
        rows: roster,
        mode: 'all',
        getRowId,
        focusedRowId: null,
        onFocusedRowChange: () => {},
        readState: () => ({ scrollAnchor: null, scrollLeft: 0 }),
        onScrollAnchorChange: () => {},
        onScrollLeftChange: () => {},
        getFocusTarget: () => null,
      }),
    );
    expect(result.current.virtual).toBe(false);
    expect(result.current.rendered).toHaveLength(10_000);
    expect(result.current.rendered.map((item) => item.key)).toEqual(roster.map(getRowId));
    expect(result.current.rendered.map((item) => item.index)).toEqual(
      roster.map((_, index) => index),
    );
    expect(roster[0]?.amount).toBeNull();
    expect(roster[1]?.amount).toBe(0);
  });
  it('reports stable identity after reorder instead of treating the index as identity', () => {
    const onAnchor = vi.fn();
    const rows = [roster[1], roster[0]].filter((row): row is Row => row !== undefined);
    render(<Host rows={rows} mode="all" onAnchor={onAnchor} />);
    fireEvent.scroll(screen.getByTestId('viewport'));
    expect(onAnchor).toHaveBeenCalledWith({ id: 'row-1', offset: 0 });
  });
  it('disconnects measurement observers when the instance lifetime ends', () => {
    const { unmount } = render(<Host />);
    unmount();
    expect(disconnect).toHaveBeenCalled();
  });
});
