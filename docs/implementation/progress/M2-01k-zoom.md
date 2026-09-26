# M2-01k · R-S09 차트·지도 확대 공유

기준: `phase/m2-01k` `9db3795`. `07_responsive_layout.md`의 S09 desktop
`linked split-pane, 선택·zoom 공유`에서 남았던 zoom 양방향 연결을 다룬다.
기존 mobile의 필요할 때 mount, tablet의 두 pane, 선택 공유 증거는
`M2-01k-d`와 `M2-01k-n`에 보존한다.

## 구현

- geo-kit 공개 `MapView`/adapter 계약에 명시적 부분 범위 fit 요청과 완료된
  viewport 보고를 추가했다. 보고는 지도 입력에 따른 `user`와 코드의 fit인
  `programmatic`을 구별한다. MapLibre의 완료 이벤트에 원래 입력 이벤트가
  유지되지 않는 경우가 있어 지도 표면의 wheel·pointer·touch·keyboard 입력도
  감지한다. 리스너는 renderer 해제 때 제거한다.
- S09의 경로 화면이 하나의 `zoomDomain`을 차트 두 개에 건넨다. `차트 확대`는
  보이는 시간 범위를 좁히고, 같은 시각의 **위치가 있는 원본 표본**으로 지도를
  fit한다. `차트 전체`와 기존 지도 전체 버튼은 확대를 해제한다. 지도에서 사용자가
  확대·이동하면 현재 viewport 안의 원본 표본 시각으로 차트 범위를 정한다.
  단일 표본도 한 시각으로 표시하고, 표본이 없으면 차트 범위를 만들어 내지 않는다.
  위치 표본이 없어 지도를 fit할 수 없는 활동도 차트 자체의 확대는 유지한다.
- 지도의 코드 fit 보고는 차트를 다시 바꾸지 않아 되먹임이 없다. 기존 선택과
  구간 선택은 별도 상태로 보존한다. 확대 동작은 API 쓰기를 하지 않는다.
  차트는 여전히 lazy load이며 Next/Vite shell별 지도 코드는 두지 않았다.

React 변경 전 Vercel upstream React Best Practices와 Composition Patterns의
`SKILL.md` 및 관련 규칙(derived state, functional updates, handler refs,
event handler logic, lifted/decoupled state)을 읽었다. 설치된 정확한 upstream
revision은 `063bee94c3f4df8453406c830b0a7df0f2860278`다
(`docs/implementation/react-skill-source.json`).

## 검증과 비공허성

- Playwright Chromium의 Next/Vite 두 shell, fixture OIDC, 실제 API·격리
  PostgreSQL에 저장한 합성 FIT을 사용했다. 새 E2E는 desktop split-pane에서
  차트 확대 후 **실제 지도 viewport bounds 변경**, 원본 선택 유지, 지도
  Ctrl+wheel 후 **실제 차트 시간 범위 변경**, 선택 구간 유지, viewport fit
  요청 번호 불변(되먹임 없음), API 쓰기 0회를 단언한다. 새 시험 **2/2 통과**;
  전체 `activity-range-link.spec.ts` **6/6 통과**.
- 차트에서 지도 fit 요청을 제거한 변이는 새 시험 **2/2 실패**했고, 두 실패가
  실제 지도 bounds 불변 단언에서 났다. 원복 후 지도의 user viewport 보고를
  차트에 반영하는 동작만 제거한 두 번째 변이도 **2/2 실패**했고, 두 실패가
  실제 차트 범위 불변 단언에서 났다. 둘 다 원복하고 두 shell을 다시 빌드해
  위 6/6 통과를 확인했다.
- geo-kit/활동 관련 단위 시험 **111/111 통과**. 단일 시각·경도 180°
  횡단·보이는 시간 범위의 위치 표본만 fit하는 순수 계산 시험을 포함한다.
- 최종 트리에서 `pnpm check:generated`, `pnpm format:check`, `pnpm lint`,
  `pnpm typecheck`(34 package와 root), Next/Vite 생산 빌드가 통과했다.
  마지막 예외 처리 후 관련 단위 시험 111/111과 위 새 브라우저 시험 2/2를
  다시 통과했다. 첫 브라우저 재시도에서 격리 PostgreSQL 시작이 sandbox에
  막혀 중단됐고, 승인된 실행에서는 fixture가 시작되어 2/2를 완료했다.
- Aside skill을 읽고 `aside --update`를 실행했으나 `fetch failed`로 사용할
  수 없었다. subagent Chrome CUA는 root만 허용되는 elicitation에서 거절됐다.
  root가 Chrome으로 fixture Alice의 Next S09 desktop 화면을 직접 확인했다:
  차트 확대 후 표시 시간 범위가 전체에서
  `1772323227500–1772323282500`으로 바뀌고 지도 선이 확대·잘려 보였으며
  `차트 전체`가 활성화됐다. Chrome에서 Ctrl+wheel은 실행하지 않았다.
  지도→차트는 위 Playwright 실제 브라우저 시험이 담당한다.

이 결과는 local fixture와 Chromium의 검증이며 운영 OIDC, 실제 기기
touch/IME, 배경 지도 배포 여부를 통과로 판정하지 않는다. `R-S09`만
**partial → passed**로 재판정하고 과거 round 기록과 외부 `not_executed`
행은 유지한다. M2-01k 부모와 phase 독립 검토는 아직 끝나지 않았다.

## 단계 독립 검토 지적 수정 · 2026-09-27

독립 검토 기준은 `main` `9ac6aa1` 대 phase `354cd5e`였다. 두 지적을
유효한 것으로 판정하고 이 phase branch에서 고쳤다. 이 변경을 포함한 새
HEAD는 다시 단계 독립 검토를 받아야 한다.

- **P1 FIXED:** 지도에서 얻은 시간 범위에 속하는 원본 관측을 먼저 선별한 뒤
  페이지당 최대 500개로 나눈다. 확대 전의 페이지 상태와 원본 선택은 유지하며,
  선택이 확대 범위 안에 있으면 해당 페이지를 보여 준다. 시각이 없거나 범위
  밖인 관측을 임의로 채우지 않는다. 합성 FIT 2,100개를 실제 API·격리
  PostgreSQL에 저장한 뒤, 사용자가 지도를 확대해 첫 500개 이후의
  시간으로 이동하는 Next/Vite 시험 **2/2 통과**. 예전 방식으로 첫 원본
  페이지를 자르는 변이는 양쪽 shell에서 차트가 사라지는 단언으로 **2/2
  실패**했다.
- **P2 FIXED:** `전체 보기`와 `차트 전체`가 이전 부분 viewport 요청을
  지우고 전체 경로 fit을 요청한다. geo-kit은 fit 요청 번호뿐 아니라 adapter
  identity도 확인해 새 adapter에 전체 경로를 다시 맞춘다. 실제 `MapView`
  계약을 통과하는 adapter probe 단위 시험에서 차트 확대 → 전체 보기 →
  배경 지도 변경으로 adapter 재생성 순서를 검증했다. 부분 요청 지우기를
  제거한 변이는 남은 request 단언에서, adapter identity를 제거한 변이는
  재생성 뒤 전체 fit 단언에서 각각 실패했다.

변이 원복 후 관련 단위 시험 **102/102**, `activity-range-link.spec.ts`
Next/Vite **8/8**, 생성물 검사·대상 파일 format/lint·전체 34 package와
root typecheck·두 shell 생산 빌드가 통과했다. Aside는 `aside --update`에서
`fetch failed`라 사용할 수 없었고, 이 검증의 직접 UI 증거는 Playwright
Chromium이다. 합성 FIT·fixture OIDC·로컬 PostgreSQL 조건이며 실제 기기와
운영 공급자 증거를 추가하지 않았다. `R-S09` passed 외의 매트릭스 판정과
과거 `not_executed`는 바꾸지 않았다.

## 두 번째 단계 독립 검토 지적 수정 · 2026-09-27

두 번째 독립 검토 기준은 `main` `9ac6aa1` 대 phase `f7644ee`였다. 검토자는
앞선 두 지적을 각각 **FIXED**로 확인했고, 새 지적 두 건을 제시했다.

- **새 P1 FIXED:** 부분 viewport 요청 번호를 nullable 요청의 직전 값에서
  계산하지 않고 S09 화면 수명 동안 단조 증가하는 ref에서 발급한다. 같은
  지도 adapter에서 차트 확대 → 차트 전체 → 차트 재확대를 검증했다. Next/Vite
  실제 브라우저 **2/2 통과**. 번호를 다시 `1`로 만드는 변이는 두 shell에서
  재확대 요청 `2` 단언에 **2/2 실패**했고 adapter probe 단위 시험에서도
  네 번째 fit 부재로 실패했다. 이전 선택·구간 상태는 손대지 않았다.
- **새 P2 FIXED:** MapLibre `fitBounds`가 생성한 movement event에는 adapter
  고유의 명시적 출처 토큰을 전달한다. fit 호출 중 이전 wheel 이동이 중단되는
  경우도 코드 fit으로 분류한다. wheel 시각은 직접 입력을 구분할 때만 사용한다.
  실제 wheel 직후 Playwright 자동 스크롤 지연 없이 전체 보기 버튼을 즉시
  누르는 Next/Vite 시험 **2/2 통과**. 토큰·fit 상태 판정을 제거하고 제스처
  시각만 쓰는 변이는 두 shell에서 차트 확대 재발생 또는 `user` 오분류로
  **2/2 실패**했고 adapter 단위 시험에서도 실패했다. 시험의 wheel은 실제
  브라우저 입력이며, 버튼은 800ms 창을 보장하기 위해 DOM click을 썼다.

원복한 최종 빌드에서 `activity-range-link.spec.ts` 전체 Next/Vite **12/12를
두 번 연속 통과**, 관련 단위 시험 **109/109 통과**했다. 생성물 검사, 대상
파일 lint/format, 34 package와 root typecheck, Next/Vite 생산 빌드가
통과했다. Aside `aside --update`는 다시 `fetch failed`였고 직접 UI 근거는
Playwright Chromium이다. 실제 기기·운영 공급자와 역사적 `not_executed`
상태는 변경하지 않았다. 변경 HEAD는 다시 전체 단계 독립 검토를 받아야 한다.

## 세 번째 단계 독립 검토 지적 수정 · 2026-09-27

세 번째 독립 검토 기준은 `main` `9ac6aa1` 대 phase `1ff03ba`였다. 검토자는
이전 네 지적을 모두 **FIXED**로 확인했다. 새 P2는 차트 확대 요청이 사용자
지도 조작 뒤에도 남아, adapter 재생성 시 이전 차트 범위를 다시 fit하는
문제였다.

- **새 P2 FIXED:** 지도에서 직접 이동이 완료되면 S09는 오래된 차트 fit
  요청을 지우고 실제 사용자 viewport bounds를 저장한다. 현재 adapter에는
  다시 fit하지 않는다. geo-kit 공개 `MapView`의 `restoreViewport` 계약은
  adapter identity가 바뀔 때만 이 범위를 full fit 뒤에 적용한다. 화면이
  다시 마운트되어 첫 adapter가 만들어지는 경우에도 저장된 범위를 복원한다.
  새 차트 확대·전체 보기는 사용자 복원 범위를 지워 명령 순서를 보존한다.
- 실제 `MapView`를 쓰는 adapter probe 시험에서 **차트 확대 → 사용자 지도
  viewport → 배경 지도 변경으로 adapter 재생성**을 확인했다. 사용자 이벤트
  직후 추가 fit은 0회이고, 새 adapter는 full fit 다음 사용자 범위를 fit하며
  차트의 사용자 시간 범위도 유지했다. 별도 geo-kit 시험은 remount 첫
  adapter에서의 복원과 같은 adapter의 prop 변경 시 fit 0회를 확인했다.
- Next/Vite 실제 브라우저의 차트 확대 → Ctrl+wheel 시험은 오래된 부분 fit
  요청 제거와 변경된 실제 지도 bounds·차트 시간 범위, 선택·구간 유지, API
  쓰기 0회를 단언한다. 전체 파일은 **12/12를 두 번 연속 통과**했다. 삭제
  로직을 제거한 변이는 활동 단위 시험과 두 shell 브라우저 **2/2에서 실패**.
  복원 fit을 제거한 변이는 adapter 재생성 단위 시험에서 실패했다.

변이 원복 후 활동/geo-kit 관련 단위 시험 **111/111**, 생성물 검사,
대상 파일 format/lint, 34 package와 root typecheck, Next/Vite 생산 빌드가
통과했다.

제품 UI에는 실행 중 배경 지도 prop을 바꾸는 조작이 없어 실제 브라우저로
adapter 재생성을 유도하지 않았다. 그 수명 순서는 위 component/geo-kit
시험으로 검증했다. Aside `aside --update`는 `fetch failed`였고 직접 UI
증거는 Playwright Chromium이다. 운영 공급자·실기기 및 과거
`not_executed` 판정은 변경하지 않았다. 수정된 HEAD는 전체 단계 독립
검토를 다시 받아야 한다.

## 네 번째 단계 독립 검토 지적 수정 · 2026-09-27

네 번째 독립 검토 기준은 `main` `9ac6aa1` 대 phase `11a6278`이었다.
검토자는 이전 다섯 지적을 모두 **FIXED**로 확인했다. 새 P2는 MapLibre
`resize()`가 wheel 직후 출처 표시 없는 `movestart`/`moveend`를 내고, 지도
adapter가 이를 사용자 이동으로 오분류하여 전체 보기 뒤 차트 확대를 되살릴
수 있다는 문제였다.

- **새 P2 FIXED:** adapter의 `resize(eventData)`에도 `fitBounds`와 같은
  adapter 고유 프로그램 출처 토큰과 동기 이동 guard를 전달한다. 코드가
  fit/resize를 실행할 때 직전 제스처 번호를 차단 경계로 저장하여, 이전 wheel의
  늦은 이동 보고도 새 사용자 입력으로 다시 분류하지 않는다. 이후 새 wheel
  입력은 번호가 증가하므로 사용자 이동으로 분류한다.
- MapLibre의 실제 `resize()`처럼 mock도 이동 시작·완료 이벤트를 낸다.
  wheel → resize의 출처 단위 시험과 wheel → 전체 fit → resize → 늦은
  이동 보고 → 새 wheel의 순서 단위 시험을 추가했다. resize 출처 전달을
  제거한 변이는 `user` 오분류로 실패했고, 제스처 차단 경계를 제거한 변이도
  늦은 이동 보고를 `user`로 분류해 실패했다. 각 변이는 원복했다.
- 실제 Playwright Chromium의 Next/Vite 두 shell에서 합성 FIT을 격리
  PostgreSQL/API에 저장하고, Ctrl+wheel → 빠른 전체 보기 → 1440px에서
  1279px로 전환했다. 같은 지도 adapter를 유지한 채 차트 범위 `전체`, 지도
  출처 `programmatic`, 변경된 실제 viewport를 확인했다. 차단 경계가 없던
  중간 구현은 두 shell 모두 차트 재확대로 실패했다. 최종 트리에서
  `activity-range-link.spec.ts` **14/14 통과**했다.

관련 단위 시험 **45/45**, `pnpm check:generated`, 전체 `pnpm format:check`·
`pnpm lint`·`pnpm typecheck`(34 package와 root), Next/Vite 생산 빌드가
통과했다. 첫 브라우저 실행의 격리 PostgreSQL은 sandbox 공유 메모리 제한으로
시작되지 않았으며, 승인된 로컬 실행에서 14/14를 완료했다. Aside
`aside --update`는 `fetch failed`였으므로 직접 UI 근거는 Playwright
Chromium이다. 실제 기기·운영 공급자 및 과거 `not_executed` 판정은
변경하지 않았다. 수정된 HEAD는 전체 단계 독립 검토를 다시 받아야 한다.
