# 다음 세션 handoff · 2026-09-24

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

[M2-01ad](progress/M2-01ad.md)를 완료했다(제품 코드 변경 없음, timeout 상향 없음).

- 선택형 진단 `IDENTITY_E2E_DIAGNOSTICS=1`: 실패 시 Playwright protocol·CPU/메모리 압박·trace를 남긴다. 세션 id·CSRF·cookie·
  authorization·OIDC 값은 Playwright 직렬화 형식을 포함해 가린다(실제 실패 probe에서 실제 값 0건). 독립 검토가 첫 판의
  redaction 누락(evaluate 인자의 `{"k","v"}` 형식)을 차단으로 잡아 고쳤다. renderer 정지 원인은 여전히 미해명이다.
- jsdom 시험에서 timeout된 시험 본문이 다음 시험 DOM에 event를 보내면 막고 파일을 실패시킨다(499/500 연쇄 차단).
- coaching-acceptance는 빈 계정에서 시작해 앞선 spec 순서에 의존하지 않는다. harness는 죽은 pid의 hand-off 파일을 안전하게 치운다.
- 기존부터 있던 문제: 실패 시 Playwright trace가 세션 값을 그대로 담고 CI가 public 저장소 artifact로 올린다(합성 계정·일회용
  runner라 실제 노출은 무시할 만함). M2-01ae로 분리했다.

직전 완료: [M2-01k](progress/M2-01k.md) 수용 2차 판정(passed 38, 새 gap 노드 16개, 사용자 결정 i–o).

## 다음 ready 작업

M2-01ae는 ready다. `M2-01k-i`는 같은 편집기 컴포넌트를 바꾸는 `M2-01k-c1` 뒤이고, 나머지 `M2-01k-a`…`M2-01k-n`은 ready이며, `M2-01k-o`(공유)는 `M2-01k-c2`
뒤이며 코드 전에 사용자 승인이 필요하다. M2-01k는 이 노드들과 외부 gate EXT-OIDC에 달려 있다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 자체 운영 engine/data 선택·검증,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 working tree와 위 계획을 확인하고 M2-01a/d부터 진행한다. 실제 외부·실환경
증거가 필요한 gate를 문서 검토나 합성 fixture로 완료 처리하지 않는다.
