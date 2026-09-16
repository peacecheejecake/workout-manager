import { DemoWorkspace } from '@workout/modules-activities/demo-workspace';

export default function Page() {
  return (
    <main className="wm-page">
      <h1>Workout Manager · Web</h1>
      <p>개발용 가상 활동 화면입니다. 로그인과 AI 동의는 계정 화면에서 확인하세요.</p>
      <p>
        <a href="/account">계정과 AI 동의</a>
      </p>
      <DemoWorkspace />
    </main>
  );
}
