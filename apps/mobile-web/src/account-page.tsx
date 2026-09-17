import { IdentityWorkspace } from '@workout/modules-identity/identity-workspace';
export function AccountPage() {
  return (
    <>
      <h1>계정과 개인정보</h1>
      <IdentityWorkspace />
      <nav aria-label="상담">
        <a href="/coach">상담 기록</a>
      </nav>
    </>
  );
}
