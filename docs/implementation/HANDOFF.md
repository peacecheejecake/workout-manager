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

[M2-01k-e](progress/M2-01k-e.md)를 완료했다. routing graph를 blue/green 엔진 두 벌과 API 신원 한 번의 전환으로 교체·rollback한다.
다른 extract로 만든 graph C로 부하 중 교체·rollback을 실제 엔진 probe로 실행했다(실패 0, 전환 뒤 옛 graph 답 0). 엔진 탐색은
요청마다 보낸 `timeout_ms`로 deadline 안에서 멈추고, no_route·outside_coverage·snap_too_far·timeout을 실제 엔진에서 각각
관측했다. 전환 파일은 프로세스 uid 소유의 일반 파일이고 group·world 쓰기 불가일 때만 읽는다(FIFO도 막히지 않고 거절).
매트릭스 5행을 passed로 올렸다(passed 48 → 53). **K-graph-rollback·P6-tenant-limits는 routing API 단일 인스턴스 전제**이며
runbook에 적었다. 여러 인스턴스 limiter(PostgreSQL lease)·전역 엔진 상한·다중 leg timeout warning은 M2-01ah로 분리했다.

직전 완료: [M2-01k-c1](progress/M2-01k-c1.md)(태블릿 접히는 경유점 목록, 편집 단언 공백).

## 운영 메모

- 운영 API는 `WORKOUT_RELEASE`를 반드시 설정한다. 없으면 로그의 version이 `unreleased`로 남는다(M2-01k-c2).
- routing을 켠 API는 한 인스턴스로 운영한다. 두 번째 인스턴스는 M2-01ah가 끝난 뒤에 띄운다.

## 다음 ready 작업

진행 중: M2-01k-d, M2-01k-f, M2-01k-g, M2-01k-i, M2-01k-l. 아직 시작하지 않은 ready 노드: M2-01k-a, M2-01k-b, M2-01k-j,
M2-01k-m, M2-01k-n, M2-01ag(M2-01k-i와 동시에 진행하지 않음), M2-01af(M2-01k-e 완료로 ready), M2-01ah. `M2-01k-o`(공유)는
의존이 풀렸지만 코드 전에 사용자 승인이 필요하다. M2-01k는 이 gap 노드들과 외부 gate EXT-OIDC에 달려 있다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 자체 운영 engine/data 선택·검증,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 working tree와 위 계획을 확인하고 M2-01a/d부터 진행한다. 실제 외부·실환경
증거가 필요한 gate를 문서 검토나 합성 fixture로 완료 처리하지 않는다.
