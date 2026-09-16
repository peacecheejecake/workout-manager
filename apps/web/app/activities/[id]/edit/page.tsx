import { notFound } from 'next/navigation';
import { activitySchema } from '@workout/contracts/activity';
import { ActivityEditorPage } from '../../editor-page';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const id = activitySchema.shape.id.safeParse((await params).id);
  if (!id.success) notFound();
  return (
    <main className="wm-page">
      <h1>활동 정정</h1>
      <ActivityEditorPage target={{ mode: 'edit', activityId: id.data }} />
    </main>
  );
}
