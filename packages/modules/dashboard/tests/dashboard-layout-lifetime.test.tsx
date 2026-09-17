import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useStore } from 'zustand';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDashboardLayoutStore } from '../src/dashboard-layout';
import {
  DashboardLayoutLifetime,
  dashboardLayoutStorageKey,
  useDashboardLayout,
} from '../src/dashboard-layout-lifetime';

function Controls() {
  const { store, mode, onApply } = useDashboardLayout();
  const { committed, draft, storageStatus, actions } = useStore(store);
  return (
    <>
      <output aria-label="committed">{committed.order.join(',')}</output>
      <output aria-label="draft">{draft?.order.join(',') ?? 'none'}</output>
      <output aria-label="storage">{storageStatus}</output>
      <output aria-label="mode">{mode}</output>
      <button
        onClick={() => {
          actions.beginEdit();
          actions.move('daily-distance', 0);
        }}
      >
        Edit
      </button>
      <button
        onClick={() => {
          actions.apply();
          onApply(store.getState().committed);
        }}
      >
        Apply
      </button>
    </>
  );
}
function view(athleteId = 'alice', sessionId = 'session-1') {
  return (
    <DashboardLayoutLifetime key={`${athleteId}:${sessionId}`} athleteId={athleteId}>
      <Controls />
    </DashboardLayoutLifetime>
  );
}
const defaultOrder = 'plan,check-in,period-summary,daily-distance';
const changedOrder = 'daily-distance,plan,check-in,period-summary';
let records: Map<string, string>;
let getItem: ReturnType<typeof vi.fn<(key: string) => string | null>>;
let setItem: ReturnType<typeof vi.fn<(key: string, value: string) => void>>;
beforeEach(() => {
  records = new Map();
  getItem = vi.fn((key: string) => records.get(key) ?? null);
  setItem = vi.fn((key: string, value: string) => {
    records.set(key, value);
  });
  vi.stubGlobal('localStorage', { getItem, setItem });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('dashboard scoped preference persistence', () => {
  it('reads only the encoded user key and writes only after explicit apply', async () => {
    const user = userEvent.setup();
    const saved = createDashboardLayoutStore().getState().committed;
    saved.order.reverse();
    records.set(dashboardLayoutStorageKey('alice/a'), JSON.stringify(saved));
    records.set(dashboardLayoutStorageKey('bob'), '{bad json');
    render(view('alice/a'));
    expect(getItem).toHaveBeenCalledWith('workout:dashboard-layout:v1:alice%2Fa');
    expect(getItem).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('committed')).toHaveTextContent(saved.order.join(','));
    expect(setItem).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(setItem).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(setItem).toHaveBeenCalledTimes(1);
    const raw = records.get(dashboardLayoutStorageKey('alice/a'));
    if (!raw) throw new Error('Expected saved preference');
    expect(Object.keys(JSON.parse(raw))).toEqual(['version', 'order', 'sizes']);
    expect(screen.getByLabelText('storage')).toHaveTextContent('saved');
  });
  it.each([
    '{broken',
    JSON.stringify({ ...createDashboardLayoutStore().getState().committed, health: 'private' }),
  ])('falls back safely for invalid stored input %#', (raw) => {
    records.set(dashboardLayoutStorageKey('alice'), raw);
    render(view());
    expect(screen.getByLabelText('committed')).toHaveTextContent(defaultOrder);
    expect(screen.getByLabelText('storage')).toHaveTextContent('invalid');
    expect(setItem).not.toHaveBeenCalled();
  });
  it('handles denied storage reads without losing editable memory state', async () => {
    getItem.mockImplementation(() => {
      throw new DOMException('Denied', 'SecurityError');
    });
    render(view());
    expect(screen.getByLabelText('storage')).toHaveTextContent('unavailable');
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('draft')).toHaveTextContent(changedOrder);
    expect(screen.getByLabelText('committed')).toHaveTextContent(defaultOrder);
  });
  it('retains the applied layout when storage quota rejects the write', async () => {
    setItem.mockImplementation(() => {
      throw new DOMException('Full', 'QuotaExceededError');
    });
    render(view());
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByLabelText('committed')).toHaveTextContent(changedOrder);
    expect(screen.getByLabelText('draft')).toHaveTextContent('none');
    expect(screen.getByLabelText('storage')).toHaveTextContent('unavailable');
    expect(records.size).toBe(0);
  });
  it('drops session drafts and restores only each user’s own committed preference', async () => {
    const { rerender } = render(view());
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    rerender(view('alice', 'session-2'));
    expect(screen.getByLabelText('draft')).toHaveTextContent('none');
    expect(screen.getByLabelText('committed')).toHaveTextContent(defaultOrder);
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    rerender(view('bob', 'session-3'));
    expect(screen.getByLabelText('committed')).toHaveTextContent(defaultOrder);
    expect(screen.getByLabelText('draft')).toHaveTextContent('none');
    rerender(view('alice', 'session-4'));
    expect(screen.getByLabelText('committed')).toHaveTextContent(changedOrder);
    expect(screen.getByLabelText('draft')).toHaveTextContent('none');
    expect(setItem).toHaveBeenCalledTimes(1);
  });
  it('preserves an editing draft through viewport mode changes without persistence writes', async () => {
    vi.stubGlobal('innerWidth', 1920);
    render(view());
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    for (const [width, mode] of [
      [320, 'mobile'],
      [900, 'tablet'],
      [1920, 'desktop'],
    ] as const) {
      act(() => {
        vi.stubGlobal('innerWidth', width);
        window.dispatchEvent(new Event('resize'));
      });
      expect(screen.getByLabelText('mode')).toHaveTextContent(mode);
      expect(screen.getByLabelText('draft')).toHaveTextContent(changedOrder);
    }
    expect(getItem).toHaveBeenCalledTimes(1);
    expect(setItem).not.toHaveBeenCalled();
  });
});
