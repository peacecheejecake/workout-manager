'use client';
import { useEffect, useState } from 'react';
import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import { WellbeingWorkspace } from '@workout/modules-wellbeing/wellbeing-workspace';

function Wellbeing() {
  const session = useAuthenticatedSession();
  const [search, setSearch] = useState('');
  // AuthenticatedWorkspace mounts this child only after browser session validation.
  const [initial] = useState(() => ({
    observedAt: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }));
  useEffect(() => {
    const update = () => setSearch(window.location.search);
    update();
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  return (
    <WellbeingWorkspace
      {...session}
      initialObservedAt={initial.observedAt}
      initialTimezone={initial.timezone}
      search={search}
      onSearchChange={(query) => {
        const normalized = query ? `?${query.replace(/^\?/, '')}` : '';
        window.history.pushState(null, '', `${window.location.pathname}${normalized}`);
        setSearch(normalized);
      }}
    />
  );
}
export function WellbeingPage() {
  return (
    <AuthenticatedWorkspace>
      <Wellbeing />
    </AuthenticatedWorkspace>
  );
}
