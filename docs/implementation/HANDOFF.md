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

[M2-01k-i](progress/M2-01k-i.md)를 완료했다. S14 경유점 목록에 pointer·keyboard drag를 더했다(집기·옮기기·놓기·취소, live
안내, IME 보호). drag와 "앞으로/뒤로" 버튼이 같은 draft 동작 `moveWaypoint`를 거치므로 drag 한 번이 되돌리기 한 번이고, 잠긴
경유점을 옮기거나 잠긴 이웃을 넘는 이동은 둘 다 거절한다. 같은 코스를 drag와 버튼으로 바꾼 결과의 엔진 요청·저장 순서와 역할이
두 shell에서 같다. 매트릭스 2행을 passed로 올렸다(passed 65 → 67). 지도 marker drag는 만들지 않았다(선택 사항).

직전 완료: [M2-01ah](progress/M2-01ah.md)(routing 여러 인스턴스 limiter, 엔진 전역 상한).

## 운영 메모

- 운영 API는 `WORKOUT_RELEASE`를 반드시 설정한다. 없으면 로그의 version이 `unreleased`로 남는다(M2-01k-c2).
- routing을 켠 API를 여러 인스턴스로 운영할 수 있다(M2-01ah). 모든 인스턴스는 같은 PostgreSQL과 같은 한도 설정을 쓰고, 047 적용
  뒤 `grantCourses`를 다시 실행한다. graph 교체는 인스턴스마다 전환하며 그동안 graph가 섞인다(runbook). 배포는 web을 API보다 먼저
  또는 함께 한다(옛 web bundle은 `timeout_may_be_no_route`를 해석하지 못한다).
- 후속(M2-01k-l 검토 비차단): 연결·해제 PATCH가 실패하면 keyboard focus가 body로 떨어진다. 활동 상세 재조회 중 미디어 panel을
  유지하는 gate에 시험이 없다.
- 신뢰할 수 없는 사용자의 track 업로드를 운영에서 받기 전에 M2-01ai(F1)를 끝낸다.

## 다음 ready 작업

task-graph에서 not_started인 ready 노드: M2-01k-a, M2-01k-b, M2-01k-d, M2-01k-j, M2-01k-m, M2-01k-n, M2-01af, M2-01ag, M2-01ai.
이 중 M2-01k-a·d, M2-01af, M2-01ai는 이 세션의 병렬 agent가 작업 중이며(task-graph 상태는 커밋할 때 completed로 바뀐다), 재개
시 각 worktree의 미커밋 상태를 먼저 확인한다. M2-01k-b·j와 M2-01ag는 M2-01k-i가 끝나 진행할 수 있다(코스 편집기는 이제
`moveWaypoint` 하나로 순서를 바꾼다). M2-01k-m·n은 같은 S09 화면을 바꾸는 M2-01k-d 뒤에 진행한다. `M2-01k-o`(공유)는 의존이
풀렸지만 코드 전에 사용자 승인이 필요하다. M2-01k는 이 gap 노드들과 외부 gate EXT-OIDC에 달려 있다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 자체 운영 engine/data 선택·검증,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 working tree와 위 계획을 확인하고 M2-01a/d부터 진행한다. 실제 외부·실환경
증거가 필요한 gate를 문서 검토나 합성 fixture로 완료 처리하지 않는다.
