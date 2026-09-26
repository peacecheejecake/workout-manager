# M2-01k · 반응형 코스 초안·선택 유지 수용 보완

기준: `main` `c3455868fcc70b50b3f1e35c4bfd262fcd6a970f`. 이 문서는
`M2-01k.md`와 요구 매트릭스의 기존 판정을 덮어쓰지 않는 추가 검증 기록이다.

## 범위와 판정 기준

`R-state-retention`의 남은 반쪽인 코스 초안과 선택의 반응형 전환을 다룬다.
`tests/identity/course-responsive-retention.spec.ts`는 Next(3100)와 Vite(4200)에서
각각 실제 화면, fixture OIDC 세션, API, 격리 PostgreSQL을 사용한다. 코스를 저장한 다음
경유점 하나의 좌표와 이름을 **초안에만** 추가하고 목록·지도에서 같은 경유점을 선택한다.
같은 문서에서 767→768→1279→1280→1279→767 CSS px로 크기를 바꾸며 아래를 단언한다.

- layout mode가 경계마다 바뀌고, 초안 경유점 전체 내용과 draft revision은 그대로다.
- 목록의 선택과 지도의 선택이 동일하며, 편집 중인 경유점 이름 입력의 focus가 유지된다.
- 전환 중 코스 본문 쓰기 요청은 0회다. 주소로 코스를 연 직후의 마지막 사용 preference
  갱신은 정상 동작이므로 이 집계에서 제외한다.
- 서버의 head revision과 저장된 경유점은 변화가 없다. 새 문서로 reload하면 메모리
  초안과 선택이 사라진다.

이 시험은 실제 기기의 회전·touch·OS IME를 대신하지 않는다. `R-state-retention`의
SDK/worker/listener/요청/blob URL 수명 정리는 기존 `M2-01k-d` 증거를 따른다.

## 검증 기록

- `aside --update`: **실패** `fetch failed`. 지침에 따라 Chrome으로 화면을 살펴본 뒤
  Playwright의 연속 viewport 검사를 실행한다. 도구를 섞어 결과를 대체하지 않는다.
- `pnpm install --frozen-lockfile`: Node 20에서는 엔진 거절. Node 24.12.0, `CI=true`,
  잠금 파일 그대로 재실행해 성공(763 패키지 재사용, 다운로드 0).
- `pnpm check:generated`, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`:
  모두 통과. typecheck는 34/34 package와 root TypeScript 검사다. `git diff --check`도 통과.
- `pnpm build`: 15/15 통과. Vite의 큰 chunk 경고와 Turbo의 출력 선언 경고는
  기존 경고이며 이 시험의 판정을 바꾸지 않는다.
- Chrome: 로컬 fixture Alice로 로그인해 Next `:3100/courses/new`와 Vite
  `:4200/courses/new`의 지도 좌표 대안·경유지 편집·초안 변경 번호를 실제 화면에서 확인했다.
  Chrome에서는 viewport 전환을 실행하지 않았다.
- Playwright Chromium: 처음 sandbox에서는 격리 PostgreSQL 기동이 거절됐다.
  허용된 로컬 실행으로 다시 돌려 **2/2 통과**(Next 3.2초, Vite 3.6초; 전체 13.7초).
  두 shell에서 연속 경계 전환, 초안·선택·focus, 코스 본문 쓰기 0회, 서버 head 불변,
  reload 뒤 메모리 초안 소멸을 실제로 단언했다. fixture OIDC와 routing의 실행이지
  운영 공급자 또는 실기기 증거가 아니다.

## 남은 범위

기존 매트릭스의 `R-state-retention`은 이 문서만으로 판정을 바꾸지 않는다. 실행된
두 shell 결과와 기존 cleanup 증거를 root가 대조하고 phase 독립 검토를 받아야 한다. 실제 기기
`R-touch-ime`, `P5-gesture-escape`와 native HealthKit/WKWebView 검증은 별도 gate다.
