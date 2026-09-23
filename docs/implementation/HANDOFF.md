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

[M2-01aa](progress/M2-01aa.md)를 완료했다. **실제 API 진입점(`apps/api/src/start.ts`)이 기동하지 못하던 결함**을
고쳤다. `configured.ts`의 `z.record(...).parse(environment)`가 zod 4에서 `process.env`를 거부했다(`eae0ee1`부터).
identity E2E harness는 `configured.ts`를 거치지 않아 잡지 못했고, 그동안은 기동 시 OIDC discovery 실패가
먼저 나서 가려졌다. 환경을 plain object로 복사한 뒤 검사하며 값 검증은 약해지지 않는다(`environmentSchema`가
원래 값에 먼저 돈다). 실제 `process.env`로 회귀 시험을 두었고 되돌리면 실패한다. M2-01w 구현 중 발견했다.

직전 완료: [M2-01x](progress/M2-01x.md)(말소 tenant prefix purge, migration 044). 배포 순서는 migrate →
`grantOperations`·`grantResourceObjectCleanupWorker` 재실행 → 새 worker.

## 다음 ready 작업

M2-01q는 rebase 중, M2-01w는 검토 대응 중, M2-01y는 진행 중, M2-01z는 검토 중, M2-01ab는 규명 중이다. **M2-01t는 사용자 결정이 먼저**다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 자체 운영 engine/data 선택·검증,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 working tree와 위 계획을 확인하고 M2-01a/d부터 진행한다. 실제 외부·실환경
증거가 필요한 gate를 문서 검토나 합성 fixture로 완료 처리하지 않는다.
