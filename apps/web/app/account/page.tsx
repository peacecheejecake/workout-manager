import { IdentityWorkspace } from '@workout/modules-identity/identity-workspace';
const configuredPort = (value: string | undefined): number | null => {
  if (value === undefined || !/^[0-9]{4,5}$/.test(value)) return null;
  const port = Number(value);
  return port >= 1024 && port <= 65535 ? port : null;
};
export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // A failed sign-in returns here with a fixed code (M2-01w); the workspace accepts only
  // its own codes and shows its own words.
  const { login_error: loginError } = await searchParams;
  const webPort = configuredPort(process.env.WORKOUT_IDENTITY_WEB_PORT);
  const garminPort = configuredPort(process.env.WORKOUT_IDENTITY_GARMIN_PORT);
  const localGarminFixturePorts =
    webPort !== null && garminPort !== null ? { web: webPort, garmin: garminPort } : undefined;
  return (
    <main className="wm-page">
      <h1>계정과 개인정보</h1>
      <IdentityWorkspace
        loginError={loginError}
        localGarminFixturePorts={localGarminFixturePorts}
      />
      <nav aria-label="훈련 작업">
        <a href="/dashboard">대시보드</a> · <a href="/planner">훈련 계획</a> ·{' '}
        <a href="/activities">가져온 활동</a> · <a href="/wellbeing">체크인</a>
        {' · '}
        <a href="/coach">상담 기록</a>
      </nav>
    </main>
  );
}
