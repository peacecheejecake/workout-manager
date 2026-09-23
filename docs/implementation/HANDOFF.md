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

[M2-01z](progress/M2-01z.md)를 완료했다. M2-01x tenant prefix purge의 운영 가시성과 처리량을 보강했다(migration 045,
grant 단계 불필요).

- 계정이 남아 있어 lease가 거절한 purge 행에 `INCONSISTENT_LEDGER:IDENTITY_ACCOUNT_PRESENT`를 한 번 적는다.
  lease·시도 차감·삭제는 없다. 운영자는 runbook의 조회로 찾는다.
- lease를 잃은 시도는 `LEASE_EXPIRED`, 100번째 시도의 lease 유실은 `DEAD_LETTER:LEASE_EXPIRED`로 끝난다. 표식 없는
  `attempts=100`은 CHECK가 막는다.
- worker 1회 실행이 purge를 최대 10회 차례로 돈다(각 run의 삭제 200개 예산·첫 오류 중단 유지). 분당 실행이면
  30일 창의 말소 tenant 약 600명까지 주기를 지킨다. 실패가 없다는 가정이며, 실행 시간은 벽시계로 묶여 있지 않다.
- worker JSON 결과 키가 `tenantPurge`(문자열)에서 `tenantPurges`(배열)로 바뀌었다(저장소 안 소비자 없음).

직전 완료: [M2-01aa](progress/M2-01aa.md)(실제 API 진입점이 `process.env`로 기동하지 못하던 결함).
분리한 후속: M2-01ac(여러 병합 검증에서 반복된 부하 간헐 실패 규명).

## 다음 ready 작업

M2-01q는 rebase 중, M2-01w는 2라운드 검토 중, M2-01y는 차단 지적(복원 후 재-import 억제) 수정 중, M2-01ab는
규명 중이다. M2-01ac는 ready다. **M2-01t는 사용자 결정이 먼저**다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 자체 운영 engine/data 선택·검증,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 working tree와 위 계획을 확인하고 M2-01a/d부터 진행한다. 실제 외부·실환경
증거가 필요한 gate를 문서 검토나 합성 fixture로 완료 처리하지 않는다.
