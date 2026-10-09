# M0-06b overlay composition verification

로컬 web `/ui-spike`에 controlled modal, help tooltip 및 action menu의 합성 조합
소비자를 추가했다. 개인 자료·서버 mutation은 없으며 전체 제품 iPhone 수용을 대신하지 않는다.

## 실제 첫 실행 · 2026-10-09

전체 build는 exit 0: 15 tasks successful, 12 cache, 9.377s.
Agent의 ui-spike/spec typecheck, scoped lint 및 format은 exit 0이다.

Root Playwright 실행은 **failed**: 등록 14개, 10 passed, 4 failed, skip 0, flaky 0,
exit 1, 34.795s. Next의 clipping-count, reduced-motion, unsupported-native와 Vite의
clipping-count가 실패했다. 두 clipping-count는 30s timeout이었다. 원인은 아직 미확정이다.
타임아웃·수용 기준을 변경해 성공으로 처리하지 않는다.

고정 입력 1,863개와 build 1,149개는 실행 전후 동일했다. 이는 코드·설정·build
검증 범위이며 docs와 기존 untracked native 성능 WIP는 제외한다. 자체 서버 포트
3100/4200 및 임시 브라우저 artifact의 정리를 확인했다. Raw report·error body는 저장하지 않았다.

실제 결과: `/private/tmp/wm-m0-overlay-browser-actual-v1-20261009/result.json`, SHA-256
`f7b324ea688eade7c85f2f407ecd578e7546ee7500b4dfada698ecc3deec7fdf`.

Aside guide/repl 지침을 읽고 연결을 시도했으나 daemon auth challenge 실패와
browser not running으로 확인을 실행할 수 없었다. Chrome CUA로 실제 Next 화면에서
패널과 native 메뉴가 열리는 것을 별도로 관측했다. 이 탐색 관측은 자동 14개 시나리오의
통과 증거나 clipping·기기 성능 증거가 아니다. 자동 검증 도구는 Playwright였다.

위치 정보 수집만 추가한 두 번째 실행도 **10 passed / 4 failed**, skip/flaky 0,
exit 1이었다. 입력과 build 불변·자체 서버/artifact 정리를 확인했다. 실제 실패 위치는
비활성 항목 `.click`(41행), 시간 token의 문자열 비교(208행), 전역 alert locator(248행)다.
결과 SHA-256은 `d9ef933f43f8a6fbad1acaf35d82f1d16ad31b5616a043f5843444fcc1261733`이다.
오류 위치만으로 제품 결함이나 원인 해결을 확정하지 않는다. 시험 상호작용·시간값 의미·
영역 locator를 교정하고 원래 14개 수용을 다시 실행할 예정이다.

## 교정 후 실제 실행

Disabled locator의 enabled 대기 대신 실제 visible/in-viewport/hit-target를 확인한 포인터
클릭과 Enter/Space로 callback 0을 검증했다. Reduced-motion 시간값은 정확한 zero time
`0s` 또는 `0ms`만 인정하며, unavailable alert는 overlay region 안에서 찾는다.
Timeout/retry와 원래 7개 시나리오 및 두 프로젝트는 유지했다.

재실행은 실제 **14/14 passed**, 실패·skip·flaky 0, exit 0, 9.142s였다.
입력 1,863개와 build 1,149개는 불변, 서버 포트 및 자체 artifact 정리도 확인했다.
결과 `/private/tmp/wm-m0-overlay-browser-actual-specfix-20261009/result.json`의 SHA-256은
`f65204946a11e5efcb4b969e7d1dd531a80d462a68ecc343dd3b3571b24c9ed7`이다.
실패한 두 회차는 이 성공으로 덮어쓰지 않는다.

실제 검증은 320px reflow/native popover clipping, callback·keyboard focus/modal scope,
숨긴 launcher, emulated touch tooltip, reduced motion 및 unsupported-native 대안 범위다.
Emulated touch는 물리 iPhone 관측이 아니다. API/DB/OS IME 및 전체 제품 기능은 이 검증에 없다.
전체 M0 phase 검토와 마지막 실제 제품 기기 수용은 남아 있다.
