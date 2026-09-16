'use client';
import { useEffect, useState } from 'react';
import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import { PlanningWorkspace } from '@workout/modules-planning/planning-workspace';
function Planner() {
  const session = useAuthenticatedSession();
  const [search, setSearch] = useState('');
  useEffect(() => {
    const update = () => setSearch(window.location.search);
    update();
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  return (
    <PlanningWorkspace
      {...session}
      activityHref={(id) => `/activities?${new URLSearchParams({ selected: id })}`}
      search={search}
      onSearchChange={(query) => {
        const normalized = query ? `?${query.replace(/^\?/, '')}` : '';
        window.history.pushState(null, '', `${window.location.pathname}${normalized}`);
        setSearch(normalized);
      }}
    />
  );
}
export function PlannerPage() {
  return (
    <AuthenticatedWorkspace>
      <Planner />
    </AuthenticatedWorkspace>
  );
}
