import { notFound } from 'next/navigation';
import { trainingCandidateStatusV1Schema } from '@workout/contracts/coaching-candidates';
import { ProposalPage } from '../proposal-page';

export default async function Page({ params }: { params: Promise<{ candidateId: string }> }) {
  const candidateId = trainingCandidateStatusV1Schema.shape.candidateId.safeParse(
    (await params).candidateId,
  );
  if (!candidateId.success) notFound();
  return (
    <main className="wm-page">
      <nav aria-label="주요 화면">
        <a href="/coach">코치</a> · <a href="/planner">훈련 계획</a> ·{' '}
        <a href="/dashboard">대시보드</a>
      </nav>
      <ProposalPage candidateId={candidateId.data.toLowerCase()} />
    </main>
  );
}
