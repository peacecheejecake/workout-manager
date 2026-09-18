'use client';

import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import { RecoveryWorkspace } from '@workout/modules-recovery/recovery-workspace';

function Recovery({ strategyId }: { strategyId: string | null }) {
  const session = useAuthenticatedSession();
  return <RecoveryWorkspace {...session} strategyId={strategyId} />;
}

export function RecoveryPage({ strategyId = null }: { strategyId?: string | null }) {
  return (
    <AuthenticatedWorkspace>
      <Recovery strategyId={strategyId} />
    </AuthenticatedWorkspace>
  );
}
