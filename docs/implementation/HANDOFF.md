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

[M2-01k](progress/M2-01k.md) 지도·코스 통합 수용을 **부분 수용(partial)으로 커밋했다. 상태는
`in_progress`다.** 요구 한 건이 실패하고 세 건이 누락됐으므로 완료로 표시하지 않았다. 드러난 공백을
노드로 분리했고 M2-01k가 그것들에 의존한다 — 공백이 닫히면 수용을 다시 돌려 partial 72행도 다시
판정한다.

**운영 routing을 실제 엔진으로 배선했다.** 그전까지 `configured.ts`가 `walkingRoutes`를 구성하지
않아 운영 설정에서는 경로 제안·후보 라우트가 아예 등록되지 않았고, 모든 경로 E2E가 fixture 엔진을
통한 것이었다. 새 `apps/api/src/routing-deployment.ts`가 `loadRoutingDeployment`만 거쳐 포트를
만든다 — 환경 변수가 전부 없으면 라우트 미등록, 일부만 있거나 검증에 실패하면 **기동 거절**("기능
꺼짐"으로 숨기지 않음), endpoint는 loopback 기본. 설정 함정: `ROUTING_GRAPH_DIRECTORY`는
`routing-graph/foot`이어야 한다(`operations-runbook.md`). graph 교체·rollback은 **같은 extract의
재import**로만 확인했고 두 단계라 원자적이지 않다(partial).

**요구 추적 매트릭스**(`docs/implementation/research/m2-01k-requirement-matrix.json`, 110행, 요구
원문 인용 포함): **passed 27 · partial 72 · not_executed 6 · missing 3 · failed 2.** 처음 판은
passed 45였는데, 그중 99행을 별도 agent가 **코드와 시험 이름을 읽고** 판정했고 매트릭스가 저장소에
없어 감사할 수 없었다. AGENTS.md는 문서 검토로 통과시키지 않는다. passed의 기준을 **"이 노드에서
실행해 통과했고, 요구의 핵심을 단언하며, 기능이 없으면 실패하는 증거"**로 다시 세웠고, 독립 검토가
passed 행을 전수 감사했다(변이 12건 포함). "배포 안 됨"을 성공으로 받는 장소 검색·고도 E2E처럼
**기능이 없어도 통과하는 시험**은 증거에서 뺐다.

**이 노드는 이 저장소가 반복해 온 대리 지표를 한 번 더 잡았다.** Next 코스 지도에 `mapWorkerUrl`이
빠져 **빈 canvas인데 "지도 표시 중"**을 표시하고 있었다(M2-01h부터). M2-01h의 "픽셀 측정"은
레이아웃 폭만 잰 것이었고, 그 원인은 geo-kit이 style `load`에서 `ready`를 내기 때문이다 — `MapView`를
쓰는 다섯 화면 모두에 해당한다. 수정 후 첫 가드도 worker 파일 **요청**만 기다려 같은 대리 지표였다.
최종 증거는 idle 뒤 코스 source layer의 `queryRenderedFeatures` 수 > 0이고, 수정을 되돌리면
`Expected > 0, Received 0`으로 실패한다(실제 엔진에서 독립 재현).

**정직하게 남긴 것**: OIDC는 **fixture provider**였다 — 계획의 "실제 OIDC"는 충족되지 않았다
(not_executed). 성능은 "데스크톱, 이 기계, 단일 호출자, inject, 예산 판정 없음"으로 라벨했다.
한국 보행 coverage와 실기기는 M0-06b 외부 gate로 통과 처리하지 않았다.

**분리한 노드**: M2-01p(**수용 실패** — 저장하지 않은 제안 상한이 쓸 수 없는 옛 draft까지 세서 30분
안의 6번째 재계산이 막힌다. 사용자는 한도에 걸렸다는 사실도 모른다), M2-01q(지도 상태 신호와 두
shell 렌더 증명), M2-01r(누락 기능: `/courses/new`·편집 라우트, 접근성 메모, 미계산 초안 표시),
M2-01s(**복원 후 말소 계정의 코스·썸네일이 되살아나지 않는다는 증거가 없다** — drill의 코스 7개가
전부 유지 tenant 소유라 볼 수 없다. 실제 결함일 수 있다), M2-01t(S09 실내 경로 탭 — 사양은
비활성화, 구현은 활성 + 설명. **사용자 결정 필요**), M2-01u(실제 OIDC), M2-01v(identity 스위트
간헐 실패 — 서로 다른 두 spec이 전체 스위트에서만 실패).

검토 과정의 교훈 하나: 매트릭스 인용 검사 스크립트가 원문 quote만 확인하고 **증거 줄 번호는 확인하지
않아**, 시험 하나를 끼워 넣자 인용 두 건의 줄 번호가 조용히 밀렸다. 독립 검토가 잡았다.

## 다음 ready 작업

M2-01k의 공백 노드 **M2-01p·q·r·s·u**는 서로 독립이라 병렬로 착수할 수 있다. **M2-01t는 사용자
결정이 먼저**다. **M2-01o**(공유 저장소 루트 경로 가드)는 진행 중이다. M2-01v는 시험 인프라다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 자체 운영 engine/data 선택·검증,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 working tree와 위 계획을 확인하고 M2-01a/d부터 진행한다. 실제 외부·실환경
증거가 필요한 gate를 문서 검토나 합성 fixture로 완료 처리하지 않는다.
