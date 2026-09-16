import { DemoWorkspace } from '@workout/modules-activities/demo-workspace';

export default function Page() {
  return (
    <main className="wm-page">
      <h1>Workout Manager · Web</h1>
      <p>개발용 가상 활동 화면입니다. 로그인과 AI 동의는 계정 화면에서 확인하세요.</p>
      <p>
        <a href="/account">계정과 AI 동의</a>
      </p>
      <p>
        <a href="/dashboard">대시보드</a> · <a href="/planner">훈련 계획</a> ·{' '}
        <a href="/activities">가져온 활동</a> · <a href="/wellbeing">체크인</a>
      </p>
      <DemoWorkspace />
    </main>
  );
}
