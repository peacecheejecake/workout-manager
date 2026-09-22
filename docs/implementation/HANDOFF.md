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

[M2-01h](progress/M2-01h.md)를 완료했다. 시작·경유·끝 경유점을 목록과 지도 양쪽에서 추가·정렬·
잠금·undo할 수 있어 필수 조작에 drag가 필요 없다. 계산된 경로는 **서버에 저장되는 제안**이고
코스를 전혀 바꾸지 않는다. 검토 후 저장할 때 revision을 쓰는 같은 transaction 안에서 소비되며,
저장 요청에는 proposal id·draft revision·승인한 graph만 실려 **한 draft의 선에 다른 draft의
경유점을 붙이는 것이 구조적으로 불가능**하다.

이월 부채 두 건을 여기서 갚았다. S13의 mobile sheet·tablet 접힘 목록·desktop 지도/목록을 만들고
320·767·768·1279·1280px와 420px pane에서 실측했다. `RouteComputationRecord`는 좌표 없이
revision에 저장되고, "옛 graph를 새 graph로 조용히 덮어쓰지 않는다"가 승인한 previous/next graph를
CAS로 잠근 head와 대조하는 **검사 가능한 규칙**이 되었다(자동 재계산 경로 없음).

**검토 다섯 라운드에서 같은 결함이 다섯 번 나왔다 — 모두 "자기가 속한 것보다 오래 사는 동작"이다.**
draft revision에만 묶인 검토 확인이 다른 graph의 새 proposal로 승계돼 재검토 없이 저장될 수 있었고,
취소한 계산의 늦은 성공이 적용됐으며(취소 테스트가 transport를 reject시켜 resolve 경로를 못 봤다),
geometry를 막은 뒤에도 그 정리 경로가 새 계산의 상태를 끝냈고, 저장 대기 중 추가한 편집이
revision만 보고 draft를 보지 않는 own-save 처리로 사라졌으며, 캐시된 코스로 전환하면 abort가
unmount에만 묶인 탓에 이전 editor 전체가 살아남았다.

마지막 것의 해법은 또 하나의 검사가 아니라 **구조 변경**이었다 — 지도 pane과 editor를 코스 id로
key해 각 동작이 매번 확인하는 대신 **소유자가 코스에 묶이게** 했다. 그래서 후속 sweep이 여섯 번째
editor 내부 사례가 아니라 화면 수준 2건을 찾았다(다른 코스를 연 뒤 도착한 rename이 그 코스 아래
성공을 보고, 삭제 완료가 열려 있던 코스를 닫음). 삭제·내보내기 **실패** 경로도 같은 대조를 받는다.

**가드 두 개가 공허했던 것을 주장 전에 잡았다**: catch 경로 소유권 검사는 거부 테스트가 생기기
전까지 되돌려도 아무것도 실패하지 않았고, 지도 pane key는 "vertex 인덱스가 다른 코스에서는 다른
의미"를 검증하는 테스트가 생기기 전까지 마찬가지였다.

검증은 typecheck 34/34, unit 256 files/2,901 tests, 실제 PostgreSQL integration 46 files/433 tests,
build 15 task, drill 56 checks, **identity 151 passed/0 failed**(여기서 2회, 전 라운드 누적 13회
clean)를 통과했다. 무관한 spec에서 부하성 click timeout 2회가 관측됐고 재현되지 않았으며
**규명하지 않았다**.

**운영 완료가 아니다**: `configured.ts`가 `walkingRoutes`를 구성하지 않으므로 end-to-end 증거는
결정적 fixture를 통한 제안·편집 흐름이지 운영 설정의 계산이 아니다. 2·3라운드 경합은 fixture가
즉시 답하고 harness에 코스가 하나뿐이라 **브라우저 증거가 없고** 컴포넌트 테스트로 지탱된다.
빈 지도에서 새 코스 생성 없음, GPX `via` 왕복 미확인, privacy trim 없음.

## 다음 ready 작업

**M2-01i 목표 거리 후보**와 **M2-01j S13/S14 잔여 기능**이 ready이고 서로 독립이라 병렬 진행한다.
i는 M2-01h의 제안·검토 구조 위에 bounded loop/왕복 후보 생성·seed·평가·중복 제거·거리 오차·후보
없음을 올린다(사용자 선택 전 저장·승인 금지). j는 GPX import/round-trip, 이름·즐겨찾기·마지막 사용,
자체 장소 검색·고도 출처, privacy trim, 버전 참조를 맡는다. 둘 다 끝나면 M2-01k 통합 수용이 남는다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 자체 운영 engine/data 선택·검증,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 working tree와 위 계획을 확인하고 M2-01a/d부터 진행한다. 실제 외부·실환경
증거가 필요한 gate를 문서 검토나 합성 fixture로 완료 처리하지 않는다.
