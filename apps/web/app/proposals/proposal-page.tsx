'use client';

import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import { CandidateReviewWorkspace } from '@workout/modules-coaching/candidate-review-workspace';

function Review({ candidateId }: { candidateId: string }) {
  const session = useAuthenticatedSession();
  return <CandidateReviewWorkspace {...session} candidateId={candidateId} />;
}

export function ProposalPage({ candidateId }: { candidateId: string }) {
  return (
    <AuthenticatedWorkspace>
      <Review candidateId={candidateId} />
    </AuthenticatedWorkspace>
  );
}
