# 다음 세션 handoff · 2026-09-25

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

[M2-01k-g](progress/M2-01k-g.md)를 완료했다. S09 머리글(출처·관측 시각·정정 여부), 공유 cursor store, 요약 전용 활동의 경로
부재, LOD, parser 날짜 경계와 구버전 replay, 코스 쓰기 전반(원 코스 삭제 포함) 뒤 원본 track의 byte 불변을 변이와 함께
단언했다. geo-kit 경계 lint 규칙이 실제로는 경계를 강제하지 않던 결함을 고쳤다(지도 SDK는 adapter만 import, 재export
금지, UI 층의 track-parsing import 금지). 매트릭스 8행을 passed로 올렸다(passed 55 → 63). S09-cursor-store는 제품에 hover
cursor가 없다는 한계, V2-A17은 CSV importer가 없어 요약 전용 활동으로 대신했다는 대체를 적었다.

직전 완료: [M2-01k-f](progress/M2-01k-f.md)(장기 track 성능 예산, F1은 M2-01ai).

## 운영 메모

- 운영 API는 `WORKOUT_RELEASE`를 반드시 설정한다. 없으면 로그의 version이 `unreleased`로 남는다(M2-01k-c2).
- routing을 켠 API는 한 인스턴스로 운영한다. 두 번째 인스턴스는 M2-01ah가 끝난 뒤에 띄운다.
- 신뢰할 수 없는 사용자의 track 업로드를 운영에서 받기 전에 M2-01ai(F1)를 끝낸다.

## 다음 ready 작업

task-graph에서 not_started인 ready 노드: M2-01k-a, M2-01k-b, M2-01k-d, M2-01k-i, M2-01k-j, M2-01k-l, M2-01k-m,
M2-01k-n, M2-01af, M2-01ag, M2-01ah, M2-01ai. 이 중 M2-01k-d·i·l, M2-01af, M2-01ah, M2-01ai는 이 세션의 병렬 agent가 작업 중이며
(task-graph 상태는 커밋할 때 completed로 바뀐다), 재개 시 각 worktree의 미커밋 상태를 먼저 확인한다. M2-01ag는
M2-01k-i와 동시에 진행하지 않는다. `M2-01k-o`(공유)는 의존이 풀렸지만 코드 전에 사용자 승인이 필요하다. M2-01k는 이
gap 노드들과 외부 gate EXT-OIDC에 달려 있다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 자체 운영 engine/data 선택·검증,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 working tree와 위 계획을 확인하고 M2-01a/d부터 진행한다. 실제 외부·실환경
증거가 필요한 gate를 문서 검토나 합성 fixture로 완료 처리하지 않는다.
