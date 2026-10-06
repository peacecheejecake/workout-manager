'use client';

import { useRouter } from 'next/navigation';
import { useAuthenticatedSession } from '@workout/platform/authenticated-workspace';
import { RaceEventDetailHost } from '@workout/modules-competitions/race-detail-host';

export function RaceDetailPage({ raceId }: { raceId: string }) {
  const session = useAuthenticatedSession();
  const router = useRouter();
  return (
    <RaceEventDetailHost
      athleteId={session.athleteId}
      sessionId={session.sessionId}
      transport={session.transport}
      raceId={raceId}
      onBack={() => router.push('/races')}
    />
  );
}
