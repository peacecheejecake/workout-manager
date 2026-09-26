# M2-01k · 계정 교체 뒤 전달된 옛 응답

기준: `phase/m2-01k` `dc97d4c`. `P5-logout-clear`와
`P8-ui-component`에서 남은 **브라우저에 실제 전달된** 옛 계정 응답 경계를
검증한다. 제품 동작 변경 없이 시험과 증거만 추가했다.

## 브라우저 경계

`course-account-switch.spec.ts`는 Alice가 `/courses/new`에서 초안을 작성한
다음 장소 검색을 요청한다. 브라우저의 원래 `fetch`가 실제 API의 HTTP 200
`Response`를 받은 뒤, 이를 전송 계층에 반환하기 전만 보류한다. 다른 탭에서
Bob으로 교체하고, 원래 탭의 focus·visibility 갱신 핸들러를 차단한 채 해당
탭을 보이게 한다. Alice의 작업 공간이 해제된 뒤 보류한 **같은 Response
객체를 전송 계층에 반환**한다. 시험은 반환 완료, `Response.json()`이 호출되지
않음, Alice 초안 부재, Bob의 private 값 유지까지 단언한다.

Next와 Vite 생산 빌드, fixture OIDC, 실제 API·격리 PostgreSQL에서 새
두 경우 **2/2**, 계정 교체 시험 전체 **4/4** 통과했다. 응답 이후·본문 이전의
`active()` 검사를 끈 변이를 두 shell에 빌드하자 **2/2 실패**했고,
두 실패 모두 옛 응답 본문이 읽힌 단언에서 났다. 원복·재빌드 후 4/4 통과했다.

## 본문 파싱 경계

`authenticated-workspace.test.tsx`는 옛 작업 공간 해제 뒤 응답이 도착하면
본문을 읽지 않고 거절하는 경우와, 본문 파싱이 시작된 뒤 해제되어 늦게
완료될 때 DTO를 반환하지 않는 경우를 별도로 검사한다. 해당 파일 **90/90
통과**. 본문 이후 `active()` 검사만 끄면 두 번째 시험이 Alice의 200 DTO를
반환하며 실패했고, 원복 후 90/90 통과했다.

이 증거는 장소 검색의 session-bound 응답과 공통 transport 경계다. 이전
M2-01k-d의 track 취소·제거 증거와 합쳐도 track 고유의 늦은 전달에 대한
독립적인 killing mutant는 아직 없다. `P5-logout-clear`와 이를 참조하는
`P8-ui-component`는 `partial`로 유지하고 다른 `not_executed`를 올리지
않았다. Aside `--update`는 `fetch failed`, subagent Chrome CUA는 root 전용
elicitation에 막혔으므로 실제 브라우저 확인은 Playwright Chromium으로 했다.
운영 IdP, native 기기 근거는 아니다.
