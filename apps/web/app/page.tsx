import { DemoWorkspace } from '@workout/modules-activities/demo-workspace';

export default function Page() {
  return (
    <main className="wm-page">
      <h1>Workout Manager · Web</h1>
      <p>개발 기반 확인 화면 · 서버 저장 및 실제 로그인이 연결되지 않았습니다.</p>
      <DemoWorkspace />
    </main>
  );
}
