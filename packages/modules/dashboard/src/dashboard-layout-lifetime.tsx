import {
  createContext,
  use,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { getLayoutMode } from '@workout/ui-foundation/responsive';
import {
  createDashboardLayoutStore,
  serializeDashboardLayout,
  type DashboardLayoutMode,
  type DashboardLayoutPreference,
  type DashboardLayoutStore,
} from './dashboard-layout';

interface DashboardLayoutContextValue {
  store: DashboardLayoutStore;
  mode: DashboardLayoutMode;
  onApply(preference: DashboardLayoutPreference): void;
}
const LayoutContext = createContext<DashboardLayoutContextValue | null>(null);
const subscribeViewport = (notify: () => void) => {
  window.addEventListener('resize', notify);
  return () => window.removeEventListener('resize', notify);
};
const readMode = () => getLayoutMode(window.innerWidth);
const serverMode = (): DashboardLayoutMode => 'mobile';
export function dashboardLayoutStorageKey(athleteId: string) {
  return `workout:dashboard-layout:v1:${encodeURIComponent(athleteId)}`;
}
/** Mount inside the authenticated user/session lifetime. Persist only explicitly applied preferences. */
export function DashboardLayoutLifetime({
  athleteId,
  children,
}: {
  athleteId: string;
  children: ReactNode;
}) {
  const [store] = useState(createDashboardLayoutStore);
  const mode = useSyncExternalStore(subscribeViewport, readMode, serverMode);
  useEffect(() => {
    const actions = store.getState().actions;
    let raw: string | null;
    try {
      raw = window.localStorage.getItem(dashboardLayoutStorageKey(athleteId));
    } catch {
      actions.setStorageStatus('unavailable');
      return;
    }
    if (raw === null) return;
    try {
      const preference: unknown = JSON.parse(raw);
      actions.hydrate(preference);
    } catch {
      actions.setStorageStatus('invalid');
    }
  }, [athleteId, store]);
  function onApply(preference: DashboardLayoutPreference) {
    try {
      window.localStorage.setItem(
        dashboardLayoutStorageKey(athleteId),
        serializeDashboardLayout(preference),
      );
      store.getState().actions.setStorageStatus('saved');
    } catch {
      store.getState().actions.setStorageStatus('unavailable');
    }
  }
  return <LayoutContext value={{ store, mode, onApply }}>{children}</LayoutContext>;
}
export function useDashboardLayout() {
  const value = use(LayoutContext);
  if (!value) throw new Error('Dashboard layout lifetime is required');
  return value;
}
