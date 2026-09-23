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

[M2-01x](progress/M2-01x.md)를 완료했다. 말소 완결성의 구멍을 닫았다. drill 순서가 DB dump → 객체 아카이브
복사라서, 그 사이 업로드된 객체는 복원 DB에 어떤 행도 없어 말소 재생·큐·두 스윕이 모두 지나쳤다(실제
PostgreSQL·파일시스템에서 재현, drill 검사로 고정).

- migration 044가 `erase_account`에 새 outermost 링크를 달아 tenant prefix purge를 durable하게 무장한다.
  worker가 DB와 무관하게 `private/v1/tenants/<id>/`를 디렉터리 단위로 걷고, 삭제는 기존 guarded `delete`로만
  한다. lease는 identity 계정이 없는 말소 tenant만 받는다. 복원 재생도 같은 경로로 다시 무장한다.
- 과잉 삭제 가드는 anchor를 하나씩 빼 실패를 확인했고, 빼도 실패하지 않는 중복 방어는 주장하지 않는다.
  독립 검토가 살아 있는 tenant·이웃 UUID·root swap 경로를 추적해 과잉 삭제 경로를 찾지 못했다. root swap
  잔여 위험(한 번의 한 방향 swap에 최대 1건)은 M2-01o에서 물려받는다.
- **배포 순서**: migrate → `grantOperations`와 `grantResourceObjectCleanupWorker` 둘 다 다시 실행 → 새 worker.
  그 전에는 말소가 `42501`로 실패하고 worker 실행도 매번 실패한다.
- 분리한 후속: M2-01y(살아 있는 계정의 활동 단위 suppression에 같은 공백), M2-01z(purge 운영 가시성·처리량).

## 다음 ready 작업

M2-01q는 검토 대응 중, M2-01w는 진행 중이다. M2-01y·z는 ready다. **M2-01t는 사용자 결정이 먼저**다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 자체 운영 engine/data 선택·검증,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 working tree와 위 계획을 확인하고 M2-01a/d부터 진행한다. 실제 외부·실환경
증거가 필요한 gate를 문서 검토나 합성 fixture로 완료 처리하지 않는다.
