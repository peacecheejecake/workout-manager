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

[M2-01k-c1](progress/M2-01k-c1.md)를 완료했다. 태블릿에서 경유점 목록을 접을 수 있게 하고 지도 옆에 두었다. 사용자가
2026-09-24에 새 배치(코스 목록 위·높이 제한·내부 스크롤, 아래에 지도와 편집기 나란히)를 수용했다. 이미 구현되어 있었지만
단언이 없던 되돌리기·다시 실행의 경유점 내용, 안전 비보장 문구, 늦은 옛 응답이 새 경로를 덮지 않음, 저장 실패(결과 불명 뒤
같은 idempotency key 재시도)를 두 shell E2E와 변이로 단언했다. 독립 검토 1차가 코스가 많을 때 지도가 첫 화면 밖으로 밀리는
회귀를 잡아 고쳤다. 매트릭스 6행을 passed로 올렸다(passed 42 → 48). 남은 사용성 공백은 M2-01ag로 분리했다.

직전 완료: [M2-01k-c2](progress/M2-01k-c2.md)(로그에서 waypoint 제거, routing 엔진 access log 누출 수정).

## 다음 ready 작업

`M2-01k-i`는 이제 ready다(M2-01k-c1 완료). M2-01ag는 ready다. 나머지 `M2-01k-a`…`M2-01k-n`은 ready이며, `M2-01k-o`(공유)는 이제 의존이 풀렸지만 코드 전에 사용자 승인이 필요하다. M2-01af는 M2-01k-e 뒤다. M2-01k는 이 노드들과 외부 gate EXT-OIDC에 달려 있다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 자체 운영 engine/data 선택·검증,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 working tree와 위 계획을 확인하고 M2-01a/d부터 진행한다. 실제 외부·실환경
증거가 필요한 gate를 문서 검토나 합성 fixture로 완료 처리하지 않는다.
