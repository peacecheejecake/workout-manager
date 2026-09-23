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

[M2-01y](progress/M2-01y.md)를 완료했다. 살아 있는 계정에서 백업 뒤 삭제된 활동의 업로드가 DB dump와 객체 아카이브
복사 사이에 들어오면 복원 뒤 어떤 행도 가리키지 않는 객체가 남던 구멍을 닫았다(실제 PG·파일시스템 재현, drill 고정).

- migration 046이 활동·코스 단위 객체 purge를 무장한다(삭제 묘비 trigger, 코스 회수 trigger, 복원 재적용).
  worker가 그 디렉터리만 walk해 guarded delete로 지우며 실행당 최대 20건이다. 살아 있는 소유자의 purge 행은
  lease하지 않고 `INCONSISTENT_LEDGER:*`로 표시한다. lease 유실·dead letter 표식은 M2-01z와 같다.
- **복원 뒤 재-import 억제**: 복원 cluster에 없는 삭제 활동은 `replay_absent_activity_deletion`이 값 없는 삭제
  canonical 행·source head·suppression 행을 되살려, 기기 재동기화가 `suppressed`로 거절된다. 검증할 수 없는
  항목은 복원 전체를 rollback한다(조용히 건너뛰지 않는다). 첫 판은 이 경우를 조용히 넘겨 지운 활동이 되살아날 수
  있었고 독립 검토가 차단으로 잡았다.
- 삭제 표시를 되돌리는 UPDATE는 DB가 거절한다(`activity_tombstone_terminal`).
- **배포·복원**: migrate 046 → `grantResourceObjectCleanupWorker` 재실행 → worker. 활동 삭제 원장에 source
  revision·content hash가 있어야 하며, 재적용은 runtime 접근 전에 RLS 우회 복원 관리자 role로 하고 계정 원장을
  먼저 재적용한다(runbook).

직전 완료: [M2-01w](progress/M2-01w.md)(OIDC 운영 견고성, back-channel logout은 미구현).

## 다음 ready 작업

M2-01q는 3라운드 검토 승인되어 병합 대기, M2-01t는 사용자가 2026-09-23에 "현재 구현에 맞게 스펙을 고친다"로 결정했고 진행 중이다. M2-01ac는 ready다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 자체 운영 engine/data 선택·검증,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 working tree와 위 계획을 확인하고 M2-01a/d부터 진행한다. 실제 외부·실환경
증거가 필요한 gate를 문서 검토나 합성 fixture로 완료 처리하지 않는다.
