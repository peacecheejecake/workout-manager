import { useSyncExternalStore } from 'react';
import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import { CompetitionHost } from '@workout/modules-competitions/competition-host';

function subscribe(listener: () => void) {
  window.addEventListener('popstate', listener);
  return () => window.removeEventListener('popstate', listener);
}
const urlSnapshot = () => `${window.location.pathname}${window.location.search}`;
const serverSnapshot = () => '';

function Competitions() {
  const session = useAuthenticatedSession();
  const address = useSyncExternalStore(subscribe, urlSnapshot, serverSnapshot);
  const url = new URL(address || '/races', 'https://shell.invalid');
  const candidates = url.searchParams.getAll('section');
  const candidate = candidates.length === 1 ? candidates[0] : null;
  const path = url.pathname.replace(/\/$/, '');
  const section =
    path === '/records'
      ? candidate === 'training-bests'
        ? 'training-bests'
        : 'results'
      : path === '/races'
        ? 'events'
        : candidate === 'results' || candidate === 'training-bests'
          ? candidate
          : 'events';
  return (
    <CompetitionHost
      athleteId={session.athleteId}
      sessionId={session.sessionId}
      transport={session.transport}
      section={section}
      onSectionChange={(next) => {
        // Only this finite view belongs in the address; health drafts remain in the module.
        history.pushState(
          history.state,
          '',
          next === 'events' ? '/races' : `/records?section=${next}`,
        );
        window.dispatchEvent(new PopStateEvent('popstate'));
      }}
      onRaceOpen={(raceId) => window.location.assign(`/races/${encodeURIComponent(raceId)}`)}
    />
  );
}

export function CompetitionsPage() {
  return (
    <AuthenticatedWorkspace>
      <Competitions />
    </AuthenticatedWorkspace>
  );
}
