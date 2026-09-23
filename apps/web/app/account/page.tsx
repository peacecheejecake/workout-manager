import { IdentityWorkspace } from '@workout/modules-identity/identity-workspace';
export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // A failed sign-in returns here with a fixed code (M2-01w); the workspace accepts only
  // its own codes and shows its own words.
  const { login_error: loginError } = await searchParams;
  return (
    <main className="wm-page">
      <h1>계정과 개인정보</h1>
      <IdentityWorkspace loginError={loginError} />
      <nav aria-label="훈련 작업">
        <a href="/dashboard">대시보드</a> · <a href="/planner">훈련 계획</a> ·{' '}
        <a href="/activities">가져온 활동</a> · <a href="/wellbeing">체크인</a>
        {' · '}
        <a href="/coach">상담 기록</a>
      </nav>
    </main>
  );
}
