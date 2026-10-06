import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import { RaceEventDetailHost } from '@workout/modules-competitions/race-detail-host';

function RaceDetail({ raceId }: { raceId: string }) {
  const session = useAuthenticatedSession();
  return (
    <RaceEventDetailHost
      athleteId={session.athleteId}
      sessionId={session.sessionId}
      transport={session.transport}
      raceId={raceId}
      onBack={() => window.location.assign('/races')}
    />
  );
}

export function RaceDetailPage({ raceId }: { raceId: string }) {
  return (
    <AuthenticatedWorkspace>
      <RaceDetail raceId={raceId} />
    </AuthenticatedWorkspace>
  );
}
