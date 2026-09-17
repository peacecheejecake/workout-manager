import { useEffect, useState } from 'react';
import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import { CoachingWorkspace } from '@workout/modules-coaching/coaching-workspace';

function Coaching() {
  const session = useAuthenticatedSession();
  const [search, setSearch] = useState('');
  useEffect(() => {
    const update = () => setSearch(window.location.search);
    update();
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  return (
    <CoachingWorkspace
      {...session}
      search={search}
      onSearchChange={(query) => {
        const normalized = query ? `?${query.replace(/^\?/, '')}` : '';
        window.history.pushState(null, '', `${window.location.pathname}${normalized}`);
        setSearch(normalized);
      }}
    />
  );
}
export function CoachingPage() {
  return (
    <AuthenticatedWorkspace>
      <Coaching />
    </AuthenticatedWorkspace>
  );
}
