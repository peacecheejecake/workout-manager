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
