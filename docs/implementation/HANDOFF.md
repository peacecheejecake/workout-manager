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

[M2-01j](progress/M2-01j.md)를 완료했다. GPX 파일을 코스로 가져오고(서버가 다시 파싱한다),
이름·즐겨찾기·마지막 사용을 남기고, 자체 장소 검색과 고도 출처를 붙이고, 보호 구역을 제거한
**파생 revision**을 덧붙인다. account export는 v19→v20으로 `coursePreferences`·
`coursePrivacyZones`를 싣는다 — **보호 구역 중심 좌표를 포함**하며, 그것이 파생물이 아니라
소유자가 입력한 자기 데이터라 빠지면 복원할 수 없다는 근거를 계약 주석·문서·시험에 적었다.

**검토 네 라운드에서 차단 6건이 나왔고 모두 재현한 뒤 고쳤다.** 첫 라운드의 여섯 건(정점만 보던
privacy trim, `Number('')===0`으로 저장되던 빈 좌표, 되살아나던 교체 전 파일, 알려진 0 m가 되던
빈 `ele`, 다른 transaction에서 확인하던 구역 집합, 상태 표기)에 이어 037 `erase_account`의
**잠금 역전(실제 `40P01` 재현)**, GPX `creator` 정제가 **기존 활동 트랙 업로드 경로를 깨뜨린 회귀**,
그리고 늦게 도착한 응답이 새 상태를 덮어쓰는 결함이 **import·장소 검색·zone 쓰기 세 자리에서**
차례로 나왔다.

**이 노드가 준 교훈은 두 가지다.**

첫째, **부분 수정은 수정이 아니다.** 늦은 응답 결함은 파일 *읽기*만 고치고 *응답*을 두었다가 다시
나왔고, 장소 검색에서 또 나왔고, zone 쓰기에서 "되살리지 않는다"는 맞췄으나 **"잃지 않는다"가
빠져** 성공한 추가가 버려졌다. 마지막 해법은 검사를 더 붙이는 것이 아니라 `setQueryData`를
**없애고** 순서 판정을 `useQuery`에 돌려준 것이다 — 늦은 응답이 들어설 자리 자체를 없앴다.
037 잠금도 같은 모양이었다: 그 함수만 고치지 않고 같은 테이블의 모든 writer를 훑자 `write()`가
tenant 잠금을 빠뜨려 약속된 `COURSE_NOT_FOUND` 대신 날것의 `23503`이 올라오던 것이 나왔다
(200회 동시 실행에서 198건).

둘째, **시험이 없는 변경에서는 근거가 유일한 방어선이다.** `geo-data.ts`의 bbox clamp는
"관측 가능한 동작 변화가 아니다"라는 근거로 되돌리기 시험 없이 제출됐는데, 그 근거가 거짓이었다 —
계약에 points ⊆ bbox refinement가 없고 빌더가 clip하지 않아 **이 제품의 실제 산출물에서 821점 중
232점이 선언된 bbox 밖**이었고, 알던 고도 1건이 조용히 "모름"이 됐다. 채워진 셀에서 경계를 뽑도록
고치자 주장이 **구성상 참**이 되고 정확도 변화가 0이 되었으며 비용은 오히려 줄었다(84°N·10 km
프로파일 43 ms → 2 ms). 같은 이유로 주석이 인용했던 수치(4→3)는 독립 측정에서 재현되지 않아
(8→7) **재현되는 부분만 남기고 고쳤다.**

**공허한 가드를 되돌려 잡는 방식이 이 노드에서 네 번 통했다.** `write()` 잠금, 재시도 제외 목록
`![408,425,429]`, `AbortController` 배선, 그리고 bbox clamp의 첫 비공허성 시험(점이 같은 셀에
떨어져 판별력이 없었다 — 구현자가 스스로 되돌려 발견했다)이 모두 "되돌려도 아무것도 실패하지
않는" 상태였다. 반대로 `import.ts`의 `runs.length===0`과 `NO_IMPORTABLE_ITEM`은 되돌려도 인접
가드가 **같은 오류 코드**를 내므로 실패할 시험이 없는 것이 정상이며, 이것을 공허한 가드로 몰지
않았다.

검증: typecheck 34/34, unit 269 files/3,151 tests, 실제 PostgreSQL integration 47 files/475 tests,
build 15 task, drill `{"outcome":"passed","checkCount":59}`, **identity 155 passed/0 failed 2회**
(모두 root가 통합 트리에서 직접 실행).

**저장되는 지도 썸네일은 [M2-01l]로 분리했다.** 화면에 그리는 쪽은 이 노드에 있고 **아무것도
저장하지 않으므로** 권한·삭제·export 표면이 늘지 않았다(검토자가 전수 grep으로 확인). 저장하는
순간 늘어나므로 소유권·삭제 연쇄·account export·백업 복원을 함께 다뤄야 한다.

## 다음 ready 작업

**M2-01l 저장되는 지도 썸네일**이 ready다. 그 다음이 **M2-01k 지도·코스 통합 수용**이며 i·j·l을
모두 기다린다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 자체 운영 engine/data 선택·검증,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 working tree와 위 계획을 확인하고 M2-01a/d부터 진행한다. 실제 외부·실환경
증거가 필요한 gate를 문서 검토나 합성 fixture로 완료 처리하지 않는다.
