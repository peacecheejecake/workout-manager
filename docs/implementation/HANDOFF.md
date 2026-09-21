# 다음 세션 handoff · 2026-09-21

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

[지도 구현 계획](map-implementation-plan.md)의 b·g 두 노드를 병렬로 구현하고 각각 커밋했다.

[M2-01b](progress/M2-01b.md)는 로컬 FIT/GPX 파일 1개를 worker에서 메모리 parse해 표시한다.
서버 actual을 만들지 않고 Activity ID를 지어내지 않으며 자동 upload가 없다. 이를 위해 parser를
`packages/server/track-ingestion`에서 `packages/track-parsing`으로 **옮겼다** — 경계 lint가
브라우저의 server 패키지 import를 정당하게 막고 있었고, 규칙을 완화하는 대신 `node:crypto`
의존을 제거했다. digest는 동기 core에 주입하고 비동기 진입점이 Web Crypto로 공급한다.

해시는 **실제로 parse된 bytes**를 기술해야 한다. 진입점과 공개 helper 모두 입력의 정확한 범위를
먼저 복사한다 — `Buffer.slice`가 view를 반환해 `.buffer`를 해시하면 파일이 아니라 8 KiB 풀
전체가 해시됐고, 호출 직후 buffer를 바꾸면 parse된 것과 다른 bytes의 digest가 나왔다. 두 경우
모두 fixture가 실제로 pooled·mutated인지 먼저 단언하는 테스트로 고정했다.

parse는 worker 전용이다. 이전의 조용한 메인 스레드 강등은 브라우저 쪽 완화책인 격리·강제 종료를
그대로 버리는 것이라 제거했다. 다중 기록 파일은 **명시 선택 전까지 아무것도 보여주지 않는다**.
지도는 error boundary 뒤의 lazy leaf이고, kit의 200개 목록 너머 표본은 페이지 목록으로 도달한다.

[M2-01g](progress/M2-01g.md)는 M2-01d가 선정한 GraphHopper 위에 내부 adapter를 올린다. tenant별
rate·동시성·waypoint·거리·응답점·deadline 상한을 두고 NoRoute·coverage 밖·과도한 snap·timeout·
과부하를 구분하며 실패해도 미계산 초안을 보존한다.

직선을 성공으로 보고하지 않는 규칙은 **형상이 아니라 edge 기준**이다. 첫 시도는 형상으로 판단했고
실제 graph에 대보니 양방향으로 틀렸다 — 정점이 자기 chord에서 0.742 m 떨어진 552 m cycleway와
정점 2개로 반환된 실제 주택가 도로를 거절했다. 둘 다 이제 "계산되어야 한다"는 fixture다. 대신
모든 요청이 `road_class` 상세를 받아 interval이 geometry를 연속으로 덮고, geometry가 snap된
waypoint에서 시작·종료하며 순서대로 경유하는지 확인한다. **일관되게 거짓말하는 엔진은 통과한다**는
한계를 adapter·문서·테스트가 같은 말로 명시한다.

graph 신원은 설정이 아니라 **빌드 시점에 결속**한다. import 후 graph·jar·profile을 해시한 manifest를
쓰고 로드 시 디스크에서 재검증하며, 매 계산마다 `/info`를 읽어 교체를 mismatch로 잡는다.
이 보장을 세우는 데 peer review가 다섯 라운드 걸렸고, 매번 guard 자체는 건전했으나 **그것이
신뢰하는 무언가가 도달 가능**했다 — 미검증 생성자 → 무방비 소비 → lint 규칙을 달래려 넣은 getter가
노출한 생성 키 → 교체 가능한 공개 predicate 순이었다. 지금은 신뢰 경로가 module-private이고
클래스가 frozen이며, 유효 인스턴스에서 얻을 수 있는 모든 값으로 생성을 시도해 전부 거절되는지
단언하는 테스트가 있다.

검증은 typecheck 31/31, unit 239 files/2,655 tests(3회 연속), 실제 PostgreSQL integration
42 files/373 tests, build 13 task, ruff·pytest 229, identity E2E 3건을 통과했다. root가 배포 신원
우회 5종(평범한 객체, 공개 static 교체, `Object.create(prototype)`, 수확한 심볼, prototype
pollution)을 직접 시도해 전부 거절되는 것을 확인했다.

한국 보행 coverage는 **`not_reviewed` 그대로**다. 서울 표본 6건이 모두 계산되고 대조군 9건이 사전
기대와 일치했으나, 독립 검토자·ground truth·서울 밖 표본·시간대 및 단차 모델이 없고 횡단보도
경유 여부를 판정할 수 없으며 표본이 6개뿐이다.

## 다음 ready 작업

**M2-01c private track 저장**이 다음 직렬 작업이다. M2-01b의 preview를 기존 ingestion에 연결해
원본·정규화·파생 object와 revision을 묶고 tenant·중복·suppression·삭제/export/복원을 처리한다.
M2-01a가 이월한 **실제 메모리 상한과 초과 시험**, 그리고 재파싱 시 새 revision 강제도 여기서
해결한다 — 서버 worker에는 `resourceLimits`와 cgroup이 있어 브라우저와 달리 실제 상한을 걸 수 있다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 자체 운영 engine/data 선택·검증,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 working tree와 위 계획을 확인하고 M2-01a/d부터 진행한다. 실제 외부·실환경
증거가 필요한 gate를 문서 검토나 합성 fixture로 완료 처리하지 않는다.
