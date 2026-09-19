import { integratedCandidateV4Schema } from '@workout/contracts/integrated-coaching';
import { notFound } from 'next/navigation';

import { IntegratedProposalPage } from '../proposal-page';

export default async function Page({ params }: { params: Promise<{ candidateId: string }> }) {
  const candidateId = integratedCandidateV4Schema.shape.id.safeParse((await params).candidateId);
  if (!candidateId.success) notFound();
  return (
    <main className="wm-page">
      <nav aria-label="주요 화면">
        <a href="/coach">코치</a> · <a href="/planner">통합 계획</a> · <a href="/recovery">회복</a>
      </nav>
      <IntegratedProposalPage candidateId={candidateId.data.toLowerCase()} />
    </main>
  );
}
