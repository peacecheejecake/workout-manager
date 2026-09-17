import { describe, expect, it } from 'vitest';
import {
  createDashboardLayoutStore,
  dashboardWidgetIds,
  parseDashboardLayout,
  serializeDashboardLayout,
} from '../src/dashboard-layout';

const preference = () => createDashboardLayoutStore().getState().committed;
describe('dashboard layout preferences', () => {
  it('isolates factories, nested mode values, and draft references', () => {
    const alice = createDashboardLayoutStore();
    const bob = createDashboardLayoutStore();
    const previous = alice.getState().committed;
    alice.getState().actions.beginEdit();
    alice.getState().actions.move('daily-distance', 0);
    alice.getState().actions.setSize('desktop', 'plan', 'wide');
    expect(alice.getState().committed).toBe(previous);
    expect(bob.getState().committed).toEqual(preference());
    expect(alice.getState().draft?.sizes.tablet.plan).toBe('standard');
    expect(alice.getState().draft?.sizes.mobile.plan).toBe('standard');
    const draft = alice.getState().draft;
    alice.getState().actions.apply();
    expect(alice.getState().draft).toBeNull();
    expect(alice.getState().committed).toEqual(draft);
    expect(alice.getState().committed).not.toBe(draft);
    expect(previous).toEqual(preference());
  });
  it('supports cancel and draft-only defaults without overwriting committed choices', () => {
    const store = createDashboardLayoutStore();
    const actions = store.getState().actions;
    actions.beginEdit();
    actions.move('plan', 3);
    actions.apply();
    const committed = store.getState().committed;
    actions.resetDraft();
    expect(store.getState().committed).toBe(committed);
    actions.beginEdit();
    actions.resetDraft();
    expect(store.getState().draft).toEqual(preference());
    actions.cancel();
    expect(store.getState().committed).toBe(committed);
    actions.beginEdit();
    actions.resetDraft();
    actions.apply();
    expect(store.getState().committed).toEqual(preference());
  });
  it('makes operations outside editing and invalid/no-op moves inert', () => {
    const store = createDashboardLayoutStore();
    const actions = store.getState().actions;
    actions.move('plan', 3);
    actions.setSize('mobile', 'plan', 'wide');
    actions.apply();
    expect(store.getState().committed).toEqual(preference());
    actions.beginEdit();
    const draft = store.getState().draft;
    actions.beginEdit();
    actions.move('plan', 0);
    for (const index of [-1, 4, 0.5, Number.NaN]) actions.move('plan', index);
    actions.setSize('mobile', 'plan', 'standard');
    expect(store.getState().draft).toBe(draft);
  });
  it('retains independent sizes and shared order through changes', () => {
    const store = createDashboardLayoutStore();
    const actions = store.getState().actions;
    actions.beginEdit();
    actions.setSize('mobile', 'check-in', 'wide');
    actions.setSize('desktop', 'daily-distance', 'wide');
    actions.move('period-summary', 0);
    actions.apply();
    expect(store.getState().committed.order).toEqual([
      'period-summary',
      'plan',
      'check-in',
      'daily-distance',
    ]);
    expect(store.getState().committed.sizes.mobile['check-in']).toBe('wide');
    expect(store.getState().committed.sizes.desktop['daily-distance']).toBe('wide');
    expect(store.getState().committed.sizes.tablet).toEqual(preference().sizes.tablet);
  });
  it.each([
    null,
    {},
    { ...preference(), version: 2 },
    { ...preference(), order: ['plan', 'plan', 'period-summary', 'daily-distance'] },
    { ...preference(), order: ['plan'] },
    { ...preference(), order: [...dashboardWidgetIds, 'unknown'] },
    { ...preference(), health: { note: 'private' } },
    { ...preference(), sizes: { ...preference().sizes, unknown: {} } },
    {
      ...preference(),
      sizes: { ...preference().sizes, mobile: { ...preference().sizes.mobile, token: 'secret' } },
    },
    {
      ...preference(),
      sizes: { ...preference().sizes, mobile: { ...preference().sizes.mobile, plan: 'huge' } },
    },
  ])('rejects malformed or extra payload %#', (value) => {
    expect(parseDashboardLayout(value)).toBeNull();
    const store = createDashboardLayoutStore();
    expect(store.getState().actions.hydrate(value)).toBe(false);
    expect(store.getState().committed).toEqual(preference());
    expect(store.getState().storageStatus).toBe('invalid');
  });
  it('hydrates only initially and detaches caller-owned objects', () => {
    const store = createDashboardLayoutStore();
    const stored = preference();
    stored.order.reverse();
    expect(store.getState().actions.hydrate(stored)).toBe(true);
    stored.order.reverse();
    stored.sizes.desktop.plan = 'wide';
    expect(store.getState().committed.order[0]).toBe('daily-distance');
    expect(store.getState().committed.sizes.desktop.plan).toBe('standard');
    expect(store.getState().actions.hydrate(preference())).toBe(false);
    expect(store.getState().storageStatus).toBe('saved');
  });
  it('never clobbers edits or a cancelled edit with delayed hydration', () => {
    const store = createDashboardLayoutStore();
    const actions = store.getState().actions;
    actions.beginEdit();
    actions.move('plan', 3);
    expect(actions.hydrate(preference())).toBe(false);
    expect(store.getState().draft?.order[3]).toBe('plan');
    actions.cancel();
    expect(actions.hydrate(preference())).toBe(false);
  });
  it('serializes only validated allowlisted values and never runtime state', () => {
    const store = createDashboardLayoutStore();
    const value = JSON.parse(serializeDashboardLayout(store.getState().committed));
    expect(Object.keys(value)).toEqual(['version', 'order', 'sizes']);
    expect(value).toEqual(preference());
    const contaminated = { ...preference(), health: 'secret' };
    expect(() => serializeDashboardLayout(contaminated)).toThrow('INVALID_DASHBOARD_LAYOUT');
    store.getState().actions.setStorageStatus('unavailable');
    expect(store.getState().storageStatus).toBe('unavailable');
    expect(JSON.parse(serializeDashboardLayout(store.getState().committed))).toEqual(preference());
  });
});
