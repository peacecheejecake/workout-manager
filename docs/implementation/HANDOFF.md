# 다음 세션 handoff · 2026-09-23

최신 상태는 [task-graph.json](task-graph.json), 요구·수용 기준은
[docs/.pre](../.pre/README.md), 작업 규칙은 [AGENTS.md](../../AGENTS.md)를 우선 확인한다.
재개할 때 `git log -1`, `git status --short`, 원격 동기화를 다시 확인한다.

## 사용자 결정과 작업 방식

- 브랜치는 `main`이다. 사용자는 본인 관리 원격 저장소로 task별 peer review, commit,
  `git push origin main`과 다음 ready 작업 계속 진행을 승인했다. 일반적인 push 실패는 기록하고
  다음 ready 작업을 진행한다.
- AGENTS·skill 규칙은 명시적 규칙 변경 요청 없이 수정하지 않는다. 사용자 변경과 untracked 파일을
  보존한다.
- 구현 분해는 Codex native orchestration, 커밋 전 독립 검토는 같은 tab의 Herdr split pane을 사용한다.
  UI 검증은 Aside → Chrome → Playwright 순서를 지킨다.
- JavaScript workspace는 Node 24.12.0과 pnpm 10.34.5로 검증했다.

## 완료된 최신 작업

[M2-01i](progress/M2-01i.md)를 완료했다. 저장된 코스의 초안에서 **목표 거리**를 근사 목표로 삼아
**상한이 걸린 탐색**으로 왕복 후보를 만들고, seed·평가 version·시도 기록을 남기며 중복을 제거하고
거리 오차를 보이고, **후보가 없으면 명시적으로 그렇게 답한다.** 사용자가 하나를 고르고 검토해
저장할 때만 새 revision이 생긴다.

엔진의 `algorithm=round_trip`은 **있는 것을 확인하고도 쓰지 않았다.** round_trip은 경유지를 엔진이
만들어 내므로 M2-01g 어댑터의 "형상이 요청한 경유지를 순서대로 지나는가" 검사가 대조할 대상을
잃는다 — 그 검사가 "fallback 직선을 성공으로 보고하지 않는다"를 지탱한다. 그래서 자체 bounded
탐색을 구현했고 **`packages/server/integrations/**`는 한 글자도 바뀌지 않았다.** 대가는 후보 모양이
원점을 한 꼭짓점으로 하는 삼각형 loop로 한정된다는 것이고, 진행 문서에 한계로 적었다.

**검토 세 라운드에서 이 저장소가 반복하는 모양이 또 나왔다.** 후보가 일반 제안 저장 경로로 소비돼
목표도 seed도 평가도 없이 저장될 수 있었고(후보 행은 035의 규칙을 물려받으면서 일반 저장까지
물려받았다), 한 탐색에서 형제 후보 둘이 저장됐다 — 가드가 **draft revision**을 보고 있었는데 그것은
저장된 값이라 코스가 움직여도 움직이지 않기 때문이다. 이제 소비 함수가 **탐색 행을 먼저 잠근다.**
정점 쌍 비교가 "같은 길의 다른 분할"을 다른 길로 보던 것은 선을 2 m 간격으로 걸어 cell로 비교하게
바꿨고, **닫힌 loop가 반복 0이 아니라 한 cell 남짓으로 나오는 부수 효과를 숨기지 않고 적었다.**
마지막 라운드는 `delete_course`·reaper와의 **실제 `40P01` deadlock**이었다. 세 writer가 순서를
달리 잡고 있었고, 036 안에서 `CREATE OR REPLACE`로 순서를 맞췄다 — 034·035 파일은 건드리지 않았고,
격리 DB에 035까지 적용한 뒤 업그레이드해 이전 함수의 권한 회수까지 검토자가 확인했다.

M2-01i와 M2-01j는 한 worktree에서 병렬로 진행했으므로, 커밋은 별도 worktree를 `b8fe714`에
만들어 **M2-01i 몫만 추려 구성한 뒤 그 트리에서 전부 실행해** 검증했다. 그 과정에서 합친 트리에서는
보이지 않던 결함이 하나 드러났다: `generationLabel`이 없던 트리에서 목표 거리 후보로 저장한
revision이 **'기록 구간 잘라내기'로 표시**됐다(HEAD의 인라인 삼항이 `routed-waypoints`가 아니면
전부 그 라벨로 떨어진다). **단위 시험은 이것을 잡지 못했고 identity가 잡았다.**

검증(M2-01i 단독 트리): typecheck 34/34, unit 260 files/2,994 tests, 실제 PostgreSQL integration
46 files/451 tests, build 15 task, drill `{"outcome":"passed","checkCount":57}`,
**identity 152 passed/0 failed를 2회.**

**운영 완료가 아니다**: `configured.ts`가 `walkingRoutes`를 구성하지 않으므로 운영 구성에서는 후보
생성 라우트가 **등록되지 않는다.** 이 노드의 end-to-end 증거는 fixture 엔진을 통한 탐색·선택
흐름이지 운영 구성에서 실제 엔진이 왕복 후보를 만든다는 증거가 아니다.

## 다음 ready 작업

**M2-01j S13/S14 잔여 기능**이 진행 중이다. 재검토에서 **차단 2건**이 남았다 — 037 `erase_account`의
잠금 역전(검토자가 실제 `40P01`을 재현했다. M2-01i에서 고친 것과 같은 부류가 037에서 다시 나왔다)과,
이전 import **응답**이 새로 고른 파일을 지우는 경합(파일 *읽기*에는 선택 번호 검사를 넣었으나
*응답*에는 없다). 비차단 3건은 삭제 잠금 회귀 시험 부재, export snapshot 시험의 판별력 부족,
그리고 아래 썸네일 노드 추적이다.

**저장되는 지도 썸네일(계획 5절)은 M2-01j에서 분리했다.** root가 별도 노드로 task-graph에 추가하고
M2-01j의 scope에서 빼야 한다 — 분리 결정과 실제 추적은 다르다.

M2-01j가 끝나면 **M2-01k 지도·코스 통합 수용**이 남는다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 자체 운영 engine/data 선택·검증,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 working tree와 위 계획을 확인하고 M2-01a/d부터 진행한다. 실제 외부·실환경
증거가 필요한 gate를 문서 검토나 합성 fixture로 완료 처리하지 않는다.
