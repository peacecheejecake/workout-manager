import { recoveryStrategyVersionSchema } from '@workout/contracts/recovery-core';
import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import { RecoveryWorkspace } from '@workout/modules-recovery/recovery-workspace';

function Recovery({ strategyId }: { strategyId: string | null }) {
  const session = useAuthenticatedSession();
  return <RecoveryWorkspace {...session} strategyId={strategyId} />;
}

export function RecoveryPage({ path }: { path: string }) {
  const match = path.match(/^\/recovery(?:\/strategies\/([^/]+))?\/?$/);
  if (!match) return <p role="alert">회복 화면 주소가 올바르지 않습니다.</p>;
  let strategyId: string | null = null;
  if (match[1] !== undefined) {
    let decoded: string | null = null;
    try {
      decoded = decodeURIComponent(match[1]);
    } catch {
      decoded = null;
    }
    const parsed = recoveryStrategyVersionSchema.shape.strategyId.safeParse(decoded);
    if (!parsed.success) return <p role="alert">회복 전략 주소가 올바르지 않습니다.</p>;
    strategyId = parsed.data.toLowerCase();
  }
  return (
    <AuthenticatedWorkspace>
      <Recovery strategyId={strategyId} />
    </AuthenticatedWorkspace>
  );
}
