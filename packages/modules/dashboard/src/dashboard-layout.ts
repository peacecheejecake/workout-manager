import { createStore } from 'zustand/vanilla';

export const dashboardWidgetIds = ['plan', 'check-in', 'period-summary', 'daily-distance'] as const;
export const dashboardLayoutModes = ['mobile', 'tablet', 'desktop'] as const;
export type DashboardWidgetId = (typeof dashboardWidgetIds)[number];
export type DashboardLayoutMode = (typeof dashboardLayoutModes)[number];
export type DashboardWidgetSize = 'standard' | 'wide';
type WidgetSizes = Record<DashboardWidgetId, DashboardWidgetSize>;
export interface DashboardLayoutPreference {
  version: 1;
  order: DashboardWidgetId[];
  sizes: Record<DashboardLayoutMode, WidgetSizes>;
}
export type DashboardStorageStatus = 'idle' | 'saved' | 'unavailable' | 'invalid';
export interface DashboardLayoutState {
  committed: DashboardLayoutPreference;
  draft: DashboardLayoutPreference | null;
  storageStatus: DashboardStorageStatus;
  actions: {
    beginEdit(): void;
    move(id: DashboardWidgetId, toIndex: number): void;
    setSize(mode: DashboardLayoutMode, id: DashboardWidgetId, size: DashboardWidgetSize): void;
    apply(): void;
    cancel(): void;
    resetDraft(): void;
    hydrate(value: unknown): boolean;
    setStorageStatus(status: DashboardStorageStatus): void;
  };
}
function defaults(): DashboardLayoutPreference {
  const sizes = (): WidgetSizes => ({
    plan: 'standard',
    'check-in': 'standard',
    'period-summary': 'standard',
    'daily-distance': 'standard',
  });
  return {
    version: 1,
    order: [...dashboardWidgetIds],
    sizes: { mobile: sizes(), tablet: sizes(), desktop: sizes() },
  };
}
function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function isWidget(value: unknown): value is DashboardWidgetId {
  return dashboardWidgetIds.some((id) => id === value);
}
function isSize(value: unknown): value is DashboardWidgetSize {
  return value === 'standard' || value === 'wide';
}
function parseSizes(value: unknown): WidgetSizes | null {
  if (!exactObject(value, dashboardWidgetIds)) return null;
  if (
    !isSize(value.plan) ||
    !isSize(value['check-in']) ||
    !isSize(value['period-summary']) ||
    !isSize(value['daily-distance'])
  )
    return null;
  return {
    plan: value.plan,
    'check-in': value['check-in'],
    'period-summary': value['period-summary'],
    'daily-distance': value['daily-distance'],
  };
}
/** Strict allowlist boundary: never carry unknown data into preferences. */
export function parseDashboardLayout(value: unknown): DashboardLayoutPreference | null {
  if (
    !exactObject(value, ['version', 'order', 'sizes']) ||
    value.version !== 1 ||
    !Array.isArray(value.order)
  )
    return null;
  const order = value.order;
  if (
    order.length !== dashboardWidgetIds.length ||
    !order.every(isWidget) ||
    new Set(order).size !== dashboardWidgetIds.length
  )
    return null;
  if (!exactObject(value.sizes, dashboardLayoutModes)) return null;
  const mobile = parseSizes(value.sizes.mobile);
  const tablet = parseSizes(value.sizes.tablet);
  const desktop = parseSizes(value.sizes.desktop);
  return mobile && tablet && desktop
    ? { version: 1, order: [...order], sizes: { mobile, tablet, desktop } }
    : null;
}
export function serializeDashboardLayout(value: DashboardLayoutPreference): string {
  const preference = parseDashboardLayout(value);
  if (!preference) throw new Error('INVALID_DASHBOARD_LAYOUT');
  return JSON.stringify(preference);
}

/** One user/workspace lifetime; browser persistence belongs to the owning provider. */
export function createDashboardLayoutStore() {
  let initialized = false;
  return createStore<DashboardLayoutState>()((set, get) => ({
    committed: defaults(),
    draft: null,
    storageStatus: 'idle',
    actions: {
      beginEdit: () => {
        initialized = true;
        if (!get().draft) set({ draft: structuredClone(get().committed) });
      },
      move: (id, toIndex) => {
        const draft = get().draft;
        if (
          !draft ||
          !isWidget(id) ||
          !Number.isInteger(toIndex) ||
          toIndex < 0 ||
          toIndex >= draft.order.length
        )
          return;
        const from = draft.order.indexOf(id);
        if (from === toIndex || from < 0) return;
        const order = draft.order.filter((item) => item !== id);
        order.splice(toIndex, 0, id);
        set({ draft: { ...draft, order } });
      },
      setSize: (mode, id, size) => {
        const draft = get().draft;
        if (
          !draft ||
          !dashboardLayoutModes.some((item) => item === mode) ||
          !isWidget(id) ||
          !isSize(size) ||
          draft.sizes[mode][id] === size
        )
          return;
        set({
          draft: {
            ...draft,
            sizes: { ...draft.sizes, [mode]: { ...draft.sizes[mode], [id]: size } },
          },
        });
      },
      apply: () => {
        const draft = get().draft;
        if (draft) set({ committed: structuredClone(draft), draft: null, storageStatus: 'idle' });
      },
      cancel: () => set({ draft: null }),
      resetDraft: () => {
        if (get().draft) set({ draft: defaults() });
      },
      hydrate: (value) => {
        if (initialized || get().draft) return false;
        initialized = true;
        const preference = parseDashboardLayout(value);
        if (!preference) {
          set({ storageStatus: 'invalid' });
          return false;
        }
        set({ committed: preference, storageStatus: 'saved' });
        return true;
      },
      setStorageStatus: (storageStatus) => set({ storageStatus }),
    },
  }));
}
export type DashboardLayoutStore = ReturnType<typeof createDashboardLayoutStore>;
