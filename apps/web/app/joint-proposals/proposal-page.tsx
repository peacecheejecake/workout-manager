'use client';

import {
  AuthenticatedWorkspace,
  useAuthenticatedSession,
} from '@workout/platform/authenticated-workspace';
import { JointCandidateReviewWorkspace } from '@workout/modules-coaching/joint-candidate-review-workspace';

function Review({ candidateId }: { candidateId: string }) {
  const session = useAuthenticatedSession();
  return <JointCandidateReviewWorkspace {...session} candidateId={candidateId} />;
}

export function JointProposalPage({ candidateId }: { candidateId: string }) {
  return (
    <AuthenticatedWorkspace>
      <Review candidateId={candidateId} />
    </AuthenticatedWorkspace>
  );
}
