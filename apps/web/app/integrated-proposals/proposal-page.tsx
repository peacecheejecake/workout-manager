'use client';

import { IntegratedCandidateReviewWorkspace } from '@workout/modules-coaching/integrated-candidate-review-workspace';
import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';

function Review({ candidateId }: { candidateId: string }) {
  const session = useAuthenticatedSession();
  return <IntegratedCandidateReviewWorkspace {...session} candidateId={candidateId} />;
}

export function IntegratedProposalPage({ candidateId }: { candidateId: string }) {
  return (
    <AuthenticatedWorkspace>
      <Review candidateId={candidateId} />
    </AuthenticatedWorkspace>
  );
}
