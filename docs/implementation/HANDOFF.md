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

[M2-01v](progress/M2-01v.md)를 완료했다. identity·통합 스위트의 간헐 실패를 규명했다.

- `oidc.spec.ts:55`의 30초 타임아웃은 **시험 쪽 경쟁 조건**이다. 계정 전환 뒤 세 읽기(동의·Garmin·ops)가
  모두 409를 받는데, 먼저 도착한 409가 계정 트리를 해체하며 나머지를 abort해 동의 409가 브라우저에 오지
  않았다. 61회 기록에서 Alice 세션 동의 읽기가 409 외의 응답을 받은 적은 없어 **보안 결함이 아니다.**
  두 패널 읽기도 해제 시점까지 붙잡도록 시험만 고쳤다. 독립 검토가 실제 브라우저에서 수정 시험 3/3 통과,
  세션 검사를 통과시키는 변이에서 2/2 실패를 확인했다.
- 통합 스위트의 "전부 통과, exit 1"(57P01)은 격리 DB drop의 teardown 경쟁이었다. backend가 나갈 때까지
  기다린 뒤 지우는 helper(`drop-isolated-database.ts`)를 upgrade 시험 다섯 파일에 적용했다(두 파일은 rebase 뒤 독립 검토가 찾음).
- poller 가설은 기각했다(이벤트 루프 지연 최대 41 ms). 기계 포화 때의 브라우저 정지 2건은 분류만 했고,
  `planned-completion-status.spec.ts:184`와 `activity-tags.spec.ts:104`는 재현되지 않아 **미분류**로 남는다.

## 다음 ready 작업

M2-01q는 검토 대응 중, M2-01r·w·x는 진행 중이다. **M2-01t는 사용자 결정이 먼저**다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 자체 운영 engine/data 선택·검증,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 working tree와 위 계획을 확인하고 M2-01a/d부터 진행한다. 실제 외부·실환경
증거가 필요한 gate를 문서 검토나 합성 fixture로 완료 처리하지 않는다.
