import { useEffect, useState } from 'react';
import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import { ActivityBrowser } from '@workout/modules-activities/activity-browser';
import { loadShellBasemap, type ShellBasemap } from './basemap';

/**
 * The same activity screen as the Next shell, composed for this shell.
 *
 * Both shells mount the same module and therefore the same lazy map leaf; what differs is
 * only how each one obtains its background-map descriptor and its routing.
 */
function Activities({
  search,
  onSearchChange,
}: {
  search: string;
  onSearchChange(query: string): void;
}) {
  const session = useAuthenticatedSession();
  const [timezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [basemap, setBasemap] = useState<ShellBasemap | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void loadShellBasemap(controller.signal).then((resolved) => {
      if (!controller.signal.aborted) setBasemap(resolved);
    });
    return () => controller.abort();
  }, []);
  return (
    <ActivityBrowser
      {...session}
      search={search}
      initialTimezone={timezone}
      basemap={basemap}
      mapWorkerUrl="/dist/maplibre/maplibre-gl-worker.mjs"
      importHref="/activities/import"
      onSearchChange={onSearchChange}
    />
  );
}

export function ActivitiesPage() {
  const [search, setSearch] = useState(() => window.location.search);
  useEffect(() => {
    const update = () => setSearch(window.location.search);
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  return (
    <>
      <h1>활동 목록</h1>
      <AuthenticatedWorkspace>
        <Activities
          search={search}
          onSearchChange={(query) => {
            const normalized = query ? `?${query.replace(/^\?/, '')}` : '';
            window.history.pushState(null, '', `${window.location.pathname}${normalized}`);
            setSearch(normalized);
          }}
        />
      </AuthenticatedWorkspace>
    </>
  );
}
