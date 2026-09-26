# M2-01k · 계정 교체 후 활동 경로 응답 (2026-09-27)

`P5-logout-clear`와 `P8-ui-component`는 계속 `partial`이다. 이번 증거는 두 행의 활동 경로 지연 응답 부분을 닫지만, 제품 전체의 비공개 자료와 P8의 모든 항목을 한 번에 판정하지는 않는다. 제품 코드는 바꾸지 않았다.

## 검사

- Next·Vite production shell과 격리 PostgreSQL, 실제 API·OIDC fixture에서 Alice의 활동 A 경로가 지도에 그려진 것을 확인했다. 같은 문서에서 활동 B로 이동하고, B의 `normalized`와 `map_path` 자료에 대한 **실제 HTTP 200 Response 두 개**를 native `fetch` 완료 직후 브라우저 안에 보관했다.
- Alice 탭은 visible로 되돌렸지만 `focus`와 `visibilitychange` refresh listener를 막고, 다른 탭의 Bob 로그인에 따른 same-origin storage account-scope 신호로 Alice 작업공간을 무효화했다. 그 뒤 두 Response를 옛 transport에 전달했다. 두 응답 모두 `returned=true`, `Response.json`은 호출되지 않았다. 이전 경로 panel·map source·worker map state와 표본 내용은 돌아오지 않았다. 전환이 끝난 뒤 Bob이 기록한 private 값은 유지됐다. Next·Vite **2/2 통과**.
- `packages/modules/activities/tests/stored-track-queries.test.tsx`에서 metadata와 두 artifact의 지연 응답을 `AbortSignal` 중단 뒤 전달하면 `CANCELLED`로 거부됨을 단언했다. artifact 중단 검사를 제거한 임시 변이에서는 개인 경로 자료가 resolve되어 새 검사가 실패했다. 복구 뒤 해당 파일 **11/11**, 관련 session transport와 합쳐 **101/101** 통과.
- transport의 fetch 직후·본문 읽기 전 active guard를 제거한 임시 변이를 두 production shell에 빌드하자, 두 browser 검사가 모두 `normalized=true, map_path=true` 본문 읽기를 보고 실패했다. 복구·재빌드 뒤 두 shell **2/2 통과**. Build는 Next와 Vite 각각 변이·복구에 성공했다.
- 변경 테스트 파일 TypeScript, Prettier, ESLint와 JSON/차이 검사를 수행했다. 검사는 실제 브라우저의 fixture 계정이며 native 기기나 운영 IdP 증거는 아니다.

Aside `SKILL.md`는 앞선 UI 작업에서 읽었고 이번에도 `aside --update`를 시도했으나 `fetch failed`였다. 하위 에이전트의 Chrome CUA는 root 전용 elicitation으로 사용할 수 없어 Playwright Chromium을 사용했다. Vite의 새 Bob 작업공간이 설치하는 전역 listener는 새 계정의 정상 자원이다. 따라서 새 검사는 이전 지도의 WebGL/resize/blob/worker-map 자원 해제와 DOM map source 부재를 분리해 단언한다.
