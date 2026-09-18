import { notFound } from 'next/navigation';
import { recoveryStrategyVersionSchema } from '@workout/contracts/recovery-core';
import { RecoveryPage } from '../../recovery-page';

export default async function Page({ params }: { params: Promise<{ strategyId: string }> }) {
  const { strategyId } = await params;
  const parsed = recoveryStrategyVersionSchema.shape.strategyId.safeParse(strategyId);
  if (!parsed.success) notFound();
  return (
    <main className="wm-page">
      <nav aria-label="주요 화면">
        <a href="/recovery">회복 전략</a> · <a href="/wellbeing">체크인</a> ·{' '}
        <a href="/account">계정</a>
      </nav>
      <RecoveryPage strategyId={parsed.data.toLowerCase()} />
    </main>
  );
}
