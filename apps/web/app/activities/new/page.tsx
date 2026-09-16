import { ActivityEditorPage } from '../editor-page';

export default function Page() {
  return (
    <main className="wm-page">
      <h1>수동 활동 입력</h1>
      <ActivityEditorPage target={{ mode: 'create' }} />
    </main>
  );
}
