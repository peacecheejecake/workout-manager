# M2-01k · 계정 교체 시 초안·브라우저 개인 값 정리

기준: `phase/m2-01k` `72f3eeb` (main `7d54934` 위로 rebase).
`P5-logout-clear`와 `P8-ui-component`의 직접 초안·private cache 증거를
보강한다. 제품 코드는 변경하지 않았다.

## 실행

- `course-account-switch.spec.ts`는 Alice의 `/courses/new`에서 좌표 두 개와
  비공개 이름을 입력하고 `workout:private:` 값을 둔다. 다른 탭에서 fixture OIDC의
  **직접 Alice→Bob 계정 교체**를 거친다. 원래 탭이 Bob 세션을 읽은 뒤
  경유지 목록이 비고, 기존 이름이 사라지고, 새 초안의 변경 번호가 낮아지며,
  Alice의 private 값이 지워졌는지 확인한다. Next/Vite production shell,
  실제 API·격리 PostgreSQL에서 **2/2 통과**했다.
- `bindPrivateBrowserStorageAccount`의 계정 교체 정리만 끈 임시 변이를 두
  shell에 다시 빌드하자 **2/2 실패**했다. 두 실패 모두 남은 Alice private 값의
  단언에서 났다. 코드를 원복하고 두 shell을 다시 빌드해 **2/2 통과**했다.
- 코드 변경은 시험과 이 기록뿐이다. `pnpm check:generated`와
  `pnpm typecheck`(34 package와 root)가 통과했다. `pnpm format:check`와
  `pnpm lint` 첫 실행은 새 시험의 서식과 사용하지 않은 import로 실패했다.
  이를 고친 뒤 전체 `pnpm format:check`와 `pnpm lint`를 다시 통과시켰다.

## 남은 범위

이 시험은 계정 교체 뒤 **도착한** 옛 네트워크 응답의 재유입과, 화면이
가시성 갱신을 전혀 하지 않는 경우를 직접 만들지 않았다. 기존 M2-01k-d의
track 취소·제거 증거도 그 조건은 닫지 못한다. 그래서 두 행은 `partial`로
유지한다. fixture OIDC와 Chromium 결과는 운영 IdP나 native 기기 근거가
아니다.
