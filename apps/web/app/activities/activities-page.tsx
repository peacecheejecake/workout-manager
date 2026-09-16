'use client';
import { useEffect, useState } from 'react';
import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import { ActivityBrowser } from '@workout/modules-activities/activity-browser';
function Activities() {
  const session = useAuthenticatedSession();
  const [search, setSearch] = useState(() => window.location.search);
  const [timezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  useEffect(() => {
    const update = () => setSearch(window.location.search);
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  return (
    <ActivityBrowser
      {...session}
      search={search}
      initialTimezone={timezone}
      importHref="/activities/import"
      onSearchChange={(query) => {
        const normalized = query ? `?${query.replace(/^\?/, '')}` : '';
        window.history.pushState(null, '', `${window.location.pathname}${normalized}`);
        setSearch(normalized);
      }}
    />
  );
}
export function ActivitiesPage() {
  return (
    <AuthenticatedWorkspace>
      <Activities />
    </AuthenticatedWorkspace>
  );
}
