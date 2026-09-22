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

[M2-01f](progress/M2-01f.md)를 완료했다. 저장된 track의 명시 구간이 Course가 된다 — 자체 ID,
형상·경유지·생성 조건·출처 revision을 담은 불변 revision, GPX 내보내기, 그리고 private가
유일한 가시성이다(나중에 끌 공유 경로를 아예 만들지 않았다). Course 편집은 출처 Activity나
승인된 PlanVersion을 건드리지 않는다.

활동을 지우면 그 좌표에서 파생된 Course revision을 회수하므로 **삭제 확인이 믿을 수 있어야
한다.** 그렇지 않았다 — 영향 조회가 pending이거나 실패해도 확인 버튼이 눌렸고, 다른 탭에서
만든 코스는 Activity revision이 움직이지 않으므로 **목록에 없이도 회수**됐다. 지금은 조회
성공을 요구하고, 확인한 목록의 digest를 삭제 명령에 실어 **tombstone을 쓰는 같은 transaction
안에서** 재대조한다.

그 수정이 다시 한 겹을 불렀다. 미리보기가 목록과 digest를 **별도 select**로 읽어, 그 사이에
코스가 생기면 목록 1개 / digest 2개짜리 응답이 나오고 그 digest로 삭제가 성공해 **사용자가
보지 못한 코스까지 회수**됐다. 이제 SQL 함수 하나가 한 snapshot에서 둘을 함께 만들고 삭제
비교도 같은 정의를 쓴다. 동시 writer가 코스를 만드는 동안 미리보기를 40회 읽어 매번 digest가
실제 반환된 목록과 일치하는지 테스트가 SQL과 독립적으로 재계산해 확인한다.

멱등성도 같은 종류의 정정을 두 번 받았다. API가 receipt보다 head를 먼저 읽어 성공한 PATCH의
동일 재전송이 409가 됐고(기존 replay 시험은 repository를 직접 불러 이 경로를 못 봤다),
클라이언트는 클릭마다 새 key를 만들어 응답 유실 시 중복 코스를 만들었다. 모든 non-2xx를
실패로 보는 1차 수정은 **저장은 됐는데 프록시가 504를 준** 경우에 같은 구멍을 남겼다. 지금은
receipt를 먼저 보고, key는 확인된 성공이나 **아무것도 저장되지 않았음이 증명된 거절**에서만
버린다.

**실브라우저가 Playwright로는 볼 수 없던 결함을 잡았다**: GPX 내보내기가 409
`SESSION_CHANGED`로 실패했다. cookie session이 `x-workout-session-id` 헤더를 요구하는데
평범한 `<a href>` 이동은 그것을 붙일 수 없고, spec은 헤더를 붙이는 `page.request.get`을 쓰고
있었다. 클릭이 헤더를 붙인 읽기를 하도록 고쳤고, 다운로드는 본문을 다 읽고 세션이 그대로임을
확인한 뒤에만 넘긴다 — 이미 시작된 다운로드는 revoke로 되돌릴 수 없다.

검증은 typecheck 34/34, unit 253 files/2,819 tests, 실제 PostgreSQL integration
46 files/422 tests, build 15 task, **identity suite 148 passed/0 failed**, drill **54 checks**
(코스 회수·복원 포함)를 통과했다. 계정 export는 v19다. 가드 11개를 각각 되돌려 해당 시험이
실패하는 것을 확인했다.

**미충족으로 이월**: S13의 mobile sheet·tablet 접힘 목록·desktop 지도/목록 구성은 만들지
않았고 M2-01h로 넘긴다. 확인한 것은 320px 가로 스크롤 0·키보드 조작·합성 입력 보존이며,
마지막은 가드 증거이지 OS IME 증거가 아니다. 코스를 지도에 그리지 않고, lineage는 스키마상
다중이나 실제로는 1건이며, 형상은 DB jsonb로 대용량 성능 미측정이고, GPX import는 M2-01j다.

## 다음 ready 작업

**M2-01h 경유지 편집**이 다음 직렬 작업이다. M2-01f의 Course와 M2-01g의 routing adapter를
잇는다 — S14의 시작/경유/끝 편집·잠금·undo/redo와 drag 대안 목록, 그리고 결과를 **최신
draft에만** 적용하고 검토 후 명시 저장한다. M2-01f가 이월한 S13 레이아웃도 여기서 함께
처리한다. M2-01g의 `RouteComputationRecord` 저장도 이 노드 몫이다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 자체 운영 engine/data 선택·검증,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 working tree와 위 계획을 확인하고 M2-01a/d부터 진행한다. 실제 외부·실환경
증거가 필요한 gate를 문서 검토나 합성 fixture로 완료 처리하지 않는다.
