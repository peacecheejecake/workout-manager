import { notFound } from 'next/navigation';
import { jointCandidateV3Schema } from '@workout/contracts/joint-coaching';
import { JointProposalPage } from '../proposal-page';

export default async function Page({ params }: { params: Promise<{ candidateId: string }> }) {
  const candidateId = jointCandidateV3Schema.shape.id.safeParse((await params).candidateId);
  if (!candidateId.success) notFound();
  return (
    <main className="wm-page">
      <nav aria-label="주요 화면">
        <a href="/coach">코치</a> · <a href="/planner">훈련 계획</a> ·{' '}
        <a href="/dashboard">대시보드</a>
      </nav>
      <JointProposalPage candidateId={candidateId.data.toLowerCase()} />
    </main>
  );
}
