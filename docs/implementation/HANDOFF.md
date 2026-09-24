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

[M2-01k-c2](progress/M2-01k-c2.md)를 완료했다. 코스·routing·track API와 썸네일 worker의 실제 로그 stream을 버리지 않고
검사하는 `@workout/server-courses/log-audit` helper를 만들어, 좌표·waypoint·객체 key·토큰·본문이 없고 trace id·version이
모든 줄에 있음을 변이로 보였다. **독립 검토가 실제 누출을 찾았다**: routing 엔진(GraphHopper)의 기본 access log가
`GET /route?...&point=lat,lon`으로 정확한 waypoint를 stdout에 썼다. 저장소 안의 모든 엔진 실행을 한 helper로 모아
`-Ddw.server.request_log.type=external`을 넘기고, 실제 엔진에서 0건임을 보였다. 보호는 이 override와 모든 appender의
WARN threshold 두 가지에 기대며(GraphHopper RouteResource INFO 줄에 waypoint가 있음), guard 시험이 엄격한 profile 문법으로
두 조건을 지킨다(검토가 찾은 profile YAML 우회 7가지와 실행 우회 1가지 모두 거절). profile 파일 자체의 강화는 graph 재구축이 필요해 M2-01af로 분리했다.
매트릭스 P7-no-coordinates-in-logs를 한계와 함께 passed로 올렸다(passed 41 → 42). 운영에서는 `WORKOUT_RELEASE`를
설정해야 로그의 version이 `unreleased`가 아니다.

직전 완료: [M2-01ae](progress/M2-01ae.md)(공개 CI artifact에서 세션 값 제거).

## 다음 ready 작업

`M2-01k-i`는 같은 편집기 컴포넌트를 바꾸는 `M2-01k-c1` 뒤이고, 나머지 `M2-01k-a`…`M2-01k-n`은 ready이며, `M2-01k-o`(공유)는 이제 의존이 풀렸지만 코드 전에 사용자 승인이 필요하다. M2-01af는 M2-01k-e 뒤다. M2-01k는 이 노드들과 외부 gate EXT-OIDC에 달려 있다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 자체 운영 engine/data 선택·검증,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 working tree와 위 계획을 확인하고 M2-01a/d부터 진행한다. 실제 외부·실환경
증거가 필요한 gate를 문서 검토나 합성 fixture로 완료 처리하지 않는다.
