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

[지도 구현 계획](map-implementation-plan.md)의 첫 두 노드를 병렬로 구현하고 각각 커밋했다.

[M2-01a](progress/M2-01a.md)는 버전 있는 track 계약과 의존성 없는 FIT/GPX parser를 추가한다.
상세 v1~v3 payload와 hash는 그대로 두고 단방향으로만 연결한다. provenance union으로 로컬
preview가 Activity ID를 만들 수 없게 했다. 결손은 0으로 채우지 않으며, 빈 좌표는 거절하고
좌표 없는 sample도 측정 관계를 유지한다. segment는 GPX trkseg와 FIT stop을 **message 순서**로
분할해 같은 초의 stop도 선을 끊는다. 기기 보고 거리·GPS 재계산 거리·표시 선 길이·routing
예상은 네 값으로 분리했고, 단순화가 집계를 바꾸지 않음을 시험으로 고정했다. 각 한도에 경계·
초과 시험이 있다. **예산은 작업량 상한이며 계획 §7의 실제 메모리 상한은 충족하지 않는다** —
재파싱 시 새 revision 강제와 함께 M2-01b/c 배선으로 이월한다.

[M2-01d](progress/M2-01d.md)는 geo-kit과 자체 basemap 빌드·엔진 실측을 추가한다. 외부 요청
차단은 hook이 아니라 **transport**에서 해결했다. 모든 자산 URL을 `geokit-self` protocol로
재작성하고 등록된 loader 한 곳에서만 fetch한다. hook만으로는 부족했는데, 최초 URL만 검사하는
동안 MapLibre가 redirect를 따라가고, TileJSON의 attribution을 source에 합쳐 HTML로 렌더하기
때문이다(설치된 sanitizer는 script만 제거하고 img는 남긴다). 게시는 매번 새 deployment
디렉터리 + 포인터 전환이며 publish·포인터·prune을 하나의 배타 잠금에서 직렬화한다.

엔진은 문서 비교가 아니라 실제 빌드·질의로 **GraphHopper 10.0**을 선정했다. `round_trip`이
실재하고(목표 5,000 m에 4,428.763 m), 서해 음성 대조군에서 **OSRM은 HTTP 200 `Ok`·0 m를 조용히
반환**한 반면 GraphHopper는 400으로 거절했다. 포기한 비용(질의 2 ms 대 7–67 ms, graph 43 MB 대
455 MB)도 기록했다. Valhalla는 빌드하지 않았고 열등하다고 주장하지 않는다.

검증은 typecheck 30/30, unit 226 files/2,489 tests(5회 연속 통과), 실제 PostgreSQL integration
42 files/373 tests, build 12 task, backup drill 44 checks, ruff·pytest 229를 통과했다. 측정은
초기화 통지 285 ms와 **track·basemap 실제 렌더 2,281 ms**를 분리한다. 이전 단일 수치는 빈
source 기준이었다. 브라우저 probe는 11개 조건과 실패 시 비정상 종료를 갖추고, redirect를
허용한 permissive 대조군이 외부 시도 6건을 관측하는 것으로 공허하지 않음을 증명한다.

과거 관측되던 `activity-workbench` 5초 timeout은 이번 5회 연속 실행에서 재현되지 않았다.
원인은 규명하지 않았다.

## 다음 ready 작업

**M2-01b 로컬 파일 viewer**와 **M2-01g 자체 보행 routing**이 ready다. 두 작업은 서로 독립이다.
b는 M2-01a의 parser로 파일 1개를 메모리에서 읽어 표시하며 자동 upload를 하지 않는다.
g는 M2-01d가 선정한 GraphHopper 위에 내부 adapter와 한국 보행 coverage 독립 검토를 올린다.
coverage는 계속 `not_reviewed`이며 HTTP 200만으로 통과 처리하지 않는다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 자체 운영 engine/data 선택·검증,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 working tree와 위 계획을 확인하고 M2-01a/d부터 진행한다. 실제 외부·실환경
증거가 필요한 gate를 문서 검토나 합성 fixture로 완료 처리하지 않는다.
