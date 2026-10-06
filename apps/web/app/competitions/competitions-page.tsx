'use client';

import type { ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import { CompetitionHost } from '@workout/modules-competitions/competition-host';

function CompetitionFrame({ children }: { children: ReactNode }) {
  const session = useAuthenticatedSession();
  const router = useRouter();
  const pathname = usePathname();
  const query = useSearchParams();
  const candidates = query.getAll('section');
  const candidate = candidates.length === 1 ? candidates[0] : null;
  const detail = pathname.startsWith('/races/');
  const section =
    pathname === '/records'
      ? candidate === 'training-bests'
        ? 'training-bests'
        : 'results'
      : pathname === '/competitions' && (candidate === 'results' || candidate === 'training-bests')
        ? candidate
        : 'events';
  return (
    <>
      {/* Keep the same module instance across page segments, never persist health drafts.
          The module's authenticated user/session key resets drafts and private queries. */}
      <div hidden={detail}>
        <CompetitionHost
          athleteId={session.athleteId}
          sessionId={session.sessionId}
          transport={session.transport}
          section={section}
          onSectionChange={(next) =>
            router.push(next === 'events' ? '/races' : `/records?section=${next}`, {
              scroll: false,
            })
          }
          onRaceOpen={(raceId) => router.push(`/races/${encodeURIComponent(raceId)}`)}
        />
      </div>
      <div hidden={!detail}>{children}</div>
    </>
  );
}

export function CompetitionShell({ children }: { children: ReactNode }) {
  return (
    <AuthenticatedWorkspace>
      <CompetitionFrame>{children}</CompetitionFrame>
    </AuthenticatedWorkspace>
  );
}
