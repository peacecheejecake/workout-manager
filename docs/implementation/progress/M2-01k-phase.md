# M2-01k phase 통합 기록 · 2026-09-27

기준 `main`은 `9ac6aa1`. 이 phase의 실행 가능한 보강 작업은 `phase/m2-01k`에 개별 커밋했다. 부모 `M2-01k`는 외부 gate와 미수용 행 때문에 `in_progress`를 유지한다. phase 전체 독립 검토 1·2·3·4차의 지적을 수정했고 변경 HEAD의 재검토와 main 병합은 아직 수행하지 않았다.

## 이번 범위

- 반응형 전환 중 경유점 초안·선택·focus 보존, 코스 지도의 미계산/계산/오류/오래된 경로 상태, 활동 차트와 지도의 양방향 확대를 Next/Vite에서 검증하고 필요한 구현을 보강했다. 세부 근거는 [state retention](M2-01k-state-retention.md), [map states](M2-01k-map-states-closure.md), [zoom](M2-01k-zoom.md)에 있다.
- Alice→Bob 계정 교체에서 이전 탭의 작업 공간을 해제하도록 고쳤다. 실제 200 응답을 계정 교체 뒤 course/track 전송 계층에 전달해 본문을 읽지 않고 폐기하는지, 옛 draft·track panel·지도 source·worker 지도 상태가 돌아오지 않는지 확인했다. 관련 변형은 실패했다. [계정 전환](M2-01k-account-switch.md), [전달 후 응답](M2-01k-delivered-response.md), [track 응답](M2-01k-track-late-response.md).
- S13 카드는 저장된 v2 목표 거리 후보에 출처가 있는 GraphHopper 노면 기록이 있을 때만 이를 표시한다. 기존 strict 클라이언트가 쓰는 기본 응답은 `unknown`을 유지한다. 현장 확인이나 통행 안전을 뜻하지 않는다. [카드 노면](M2-01k-card-surface.md).
- S14의 routing·장소·고도·자체 basemap 공급자 분리를 실제 장애 격리 시험으로 확인했다. [공급자 분리](M2-01k-provider-isolation.md).

현재 [수용 매트릭스](../research/m2-01k-requirement-matrix.json)는 **passed 91 · partial 14 · failed 1 · not_executed 4**(110행)이다. 기존 `P8-coverage` failed와 모든 외부 `not_executed`를 보존했다. `P5-logout-clear`·`P8-ui-component`는 이번 계정 전환과 지연 응답의 직접 증거에도 제품 전체 수용 범위 때문에 partial로 남겼다. 호스팅·실기기·공식 Garmin·실제 GPU/IME/touch·Valhalla/고도 coverage 등 다른 partial의 범위도 매트릭스 사유대로 유지한다.

## 합친 브랜치 검증

- Node 24.12.0, pnpm 10.34.5: `pnpm check` 통과. 생성물·Prettier·ESLint·34개 패키지와 루트 TypeScript, Vitest **4,090 passed · 7 skipped**(338 files passed, 1 skipped).
- 격리 PostgreSQL `pnpm test:integration`: **804/804 passed**(81 files), 초기화 smoke 1 passed.
- `pnpm build`: **15/15 passed**. Vite의 기존 큰 chunk 경고와 Turbo의 no-output 경고는 남는다.
- `pnpm test:identity` 전체 296건: 지도·장소·고도 로컬 아티팩트를 연결한 1회차 **285 passed · 11 skipped**, 2회차 **284 passed · 11 skipped · 1 failed**, 3회차 **285 passed · 11 skipped**. 2회차의 유일한 실패는 기존에 알려진 `activity-track-map.spec.ts` Vite 경로 패널 5초 대기 초과였다. 실패 화면은 활동 상세를 아직 불러오는 중이었고, 같은 commit에서 그 사례만 **3/3 passed**로 재실행했다. 2회차 실패를 통과로 바꾸지 않는다.
- 보강된 각 기능의 집중 Next/Vite E2E, 실제 GraphHopper 카드, 공급자 격리·변형 시험은 위 개별 기록에 있다. Aside 갱신은 `fetch failed`였고 subagent의 Chrome 제어는 root 전용이어서, 브라우저 자동 검증은 Playwright Chromium을 사용했다. root는 차트↔지도 확대를 Chrome에서 직접 확인했다. 실기기/실제 호스팅 증거가 아니다.

첫 `pnpm check`는 이 셸의 기본 Node 20 때문에 시작 전에 거절됐고, Node 24로 재실행했다. 그다음 전체 단위 실행에서 카드 opt-in URL을 따르지 않는 두 MSW fixture, worktree의 미준비 `.venv`, sandbox의 로컬 시험 서버 접근이 드러났다. fixture는 `be602ff`에서 수정했고, `uv sync --offline`로 Python 환경을 준비했으며 로컬 서버 시험 66/66을 허용된 실행에서 확인한 뒤 위의 전체 검사도 통과했다. 첫 전체 identity 실행은 worktree의 `.geo-build` 연결이 없어 장소·고도가 `no_dataset`으로 실패해 중단했다. 연결 후 해당 13건과 위의 전체 실행을 다시 확인했다. 이 준비 실패를 제품 통과 증거로 사용하지 않는다.

## 남은 gate

`M2-01k` 부모와 외부 조건은 여전히 열려 있다. 본 기록은 phase 코드의 검토 준비 상태만 나타낸다. 독립 phase review가 findings를 내면 같은 브랜치에서 수정·재검토하고, 승인된 base/head를 별도로 기록한 뒤에만 main을 fast-forward한다. Push는 사용자 작업이다.

## 독립 검토 1차와 수정

Codex CLI `gpt-6-sol` high/read-only가 `main` `9ac6aa1f5af54a09497d7e50504840fb91aae8f5`부터 phase HEAD `354cd5ebd7175455fb045d635d6e68485615454a`까지 전체 diff를 검토하고 **CHANGES_REQUESTED**를 냈다. P1은 500개를 넘는 활동에서 지도 확대 범위가 첫 차트 페이지 밖이면 빈 차트가 되는 문제, P2는 `전체 보기` 뒤 지도 adapter 재생성 시 이전 부분 확대가 되살아나는 문제였다.

두 지적은 `f12c021`에서 수정했다. [확대 기록](M2-01k-zoom.md)의 2,100개 관측 Next/Vite 실행과 실패 변형, adapter 재생성 단위 시험에 따라 **P1 FIXED · P2 FIXED**로 평가한다. 수정 뒤 `pnpm check`는 생성물·포맷·lint·typecheck 및 Vitest **4,098/4,098 passed**(339 files)가 통과했다. `activity-range-link.spec.ts`의 Next/Vite 브라우저 사례를 2회씩 실행해 **16/16 passed**했다. 서버·DB 코드는 바뀌지 않아 앞선 PostgreSQL 804/804 근거를 유지한다. 변경된 HEAD 전체에 대한 독립 재검토는 아직 필요하다.

## 독립 검토 2차와 수정

같은 Codex CLI 설정의 전체 diff 재검토는 `main` `9ac6aa1` 대 HEAD `f7644ee`에서 앞선 두 지적을 **각각 FIXED**로 확인했지만 새 두 지적으로 **CHANGES_REQUESTED**를 냈다. 새 P1은 전체 보기 뒤 차트 재확대의 요청 번호가 재사용되는 문제, 새 P2는 지도 wheel 직후 코드의 fit이 사용자 이동으로 오분류되는 문제였다.

두 새 지적을 `9967344`에서 수정했다. viewport 요청 번호는 화면 수명 동안 단조 증가하고, MapLibre fit에는 명시적 출처가 따라간다. [확대 기록](M2-01k-zoom.md)의 같은 adapter 재확대와 wheel 직후 전체 보기 Next/Vite 시험은 각각 **2/2 통과**했고, 원래 결함을 되살린 변형은 각각 **2/2 실패**했다. 원복 후 `activity-range-link.spec.ts` 전체 **12/12를 두 번 통과**했고 관련 단위 시험 **109/109**, 생성물·포맷·lint·34개 패키지와 루트 타입 검사·두 shell 빌드가 통과했다. root의 변경 후 `pnpm check`도 Vitest **4,099/4,099 passed**(339 files)였다. 서버·DB 경계는 이 수정에서 변경되지 않았다.

## 독립 검토 3차와 수정

같은 Codex CLI 설정의 전체 diff 재검토는 `main` `9ac6aa1` 대 HEAD `1ff03ba`에서 앞선 네 지적을 **모두 FIXED**로 확인했지만 새 P2 지적으로 **CHANGES_REQUESTED**를 냈다. 차트 확대 후 사용자가 지도를 움직여도 오래된 차트 fit 요청이 남아, adapter 재생성 시 사용자 범위를 덮는 문제였다.

`da2e201`에서 사용자 지도 조작이 이전 차트 요청을 무효화하고 실제 viewport를 저장하도록 고쳤다. 새 adapter와 remount된 첫 adapter는 저장된 범위를 복원하며, 같은 adapter에는 중복 fit하지 않는다. [확대 기록](M2-01k-zoom.md)의 실제 adapter 시험과 Next/Vite 브라우저 시험은 **12/12를 두 번 통과**했고, 오래된 요청 제거와 복원 fit을 되돌린 변형은 각각 실패했다. 관련 단위 시험 **111/111**, 생성물·대상 format/lint·전체 타입 검사·두 shell 빌드가 통과했다. root의 전체 `pnpm check`도 생성물·format·lint·typecheck 및 Vitest **4,101/4,101 passed**(339 files)였다. 첫 실행은 샌드박스가 기존 로컬 fixture 서버 접속을 막아 중단했고, 로컬 접속을 허용한 재실행이 통과했다. 제품 UI에서 실행 중 배경 지도를 바꾸는 동작이 없어 adapter 재생성은 component 시험으로 검증했다. 변경 HEAD의 phase 전체 독립 재검토는 아직 필요하다.

## 독립 검토 4차와 수정

같은 Codex CLI 설정의 전체 diff 재검토는 `main` `9ac6aa1` 대 HEAD `11a6278`에서 앞선 다섯 지적을 **모두 FIXED**로 확인했지만 새 P2 지적으로 **CHANGES_REQUESTED**를 냈다. MapLibre `resize()`가 이동 이벤트를 내는데 직전 800ms의 wheel 입력 때문에 이를 사용자 이동으로 오분류할 수 있었다.

`c33091b`에서 fit과 resize 모두 adapter 고유 프로그램 출처 토큰 및 호출 중 guard를 사용하고, 이전 wheel의 늦은 이동 신호를 새 사용자 입력으로 처리하지 않도록 제스처 순서 경계를 추가했다. [확대 기록](M2-01k-zoom.md)의 Next/Vite 실제 브라우저 wheel→전체 보기→반응형 전환 시험을 포함해 **14/14 passed**, 관련 단위 **45/45 passed**였다. 출처 표식과 제스처 경계를 각각 제거한 변형은 관련 단위 시험에서 실패했다. root의 전체 `pnpm check`는 생성물·format·lint·typecheck와 Vitest **4,102/4,102 passed**(339 files)였다. 변경 HEAD의 phase 전체 독립 재검토는 아직 필요하다.
