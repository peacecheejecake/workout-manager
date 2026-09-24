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

[M2-01k-k](progress/M2-01k-k.md)를 완료했다(사용자 결정: S09 주소 별칭을 만든다). 두 shell에서
`/activities/:id?tab=<tab>`이 현재 주소(`/activities?selected=<id>&detailTab=<tab>`)로 넘어간다(Next 307, Vite
`history.replaceState`). 별칭은 주소만 바꾸고 조회하지 않아 존재 여부를 흘리지 않으며, 잘못된 tab·id·남의 활동은
화면의 기존 오류 상태가 판단한다. 독립 검토가 open redirect·header injection·형제 경로·뒤로 가기를 실측했다.
매트릭스 S09-address를 passed로 올렸다(passed 40 → 41).

직전 완료: [M2-01k-h](progress/M2-01k-h.md)(영속 수명주기 조건별 시험과 변이, P7·P8 passed).

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
