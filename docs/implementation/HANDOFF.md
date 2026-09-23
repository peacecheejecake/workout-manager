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

[M2-01m](progress/M2-01m.md)을 완료했다. M2-01l이 저장하게 만든 썸네일 객체에 **reconciliation
스윕**을 붙였다. 독립 검토가 M2-01l에서 재현한 구멍 — fence 경과 후 1시간을 넘겨 잠든 writer가
깨어나 publish하면 고아 객체가 영구히 남는다 — 을 메웠고, 검토자가 **자기 재현을 한 글자도 바꾸지
않고** 이 트리에서 돌려 객체가 실제로 사라지는 것을 확인했다.

패턴은 M2-01c(033)를 그대로 옮겼다: 영속 ref 색인 + backfill + keyset window + "객체가 될 수 있는
모든 경로가 닫혔을 때만" settle. 달라진 곳 세 군데는 근거가 있다. 색인 유지를 **트리거**로 했다
(render worker는 표 권한이 0이므로 어떤 쓰기 경로도 잊을 수 없게). 그리고 **말소가 색인 행을
마지막에 지운다**(M2-01c는 먼저) — M2-01c 순서로 되돌리면 실제 `deadlock detected`가 재현된다.
render worker는 advisory lock 없이 `course_thumbnail` 행을 쥔 채 색인 행을 기다릴 수 있기 때문이다.

**과잉 삭제는 네 방향 공격에 모두 막혔다** — 살아 있는 그림의 색인을 400일 과거로 밀어도, reclaim을
직접 호출해도, 영수증을 손으로 밀어 넣어도(`authorize_resource_object_cleanup`이 거절), 진행 중
렌더의 임시 객체도 살아남았다.

**차단 1건이 이 노드의 게이트 시험 자체에서 나왔다.** 새 스윕이 cleanup drain이 동시에 지우는
namespace를 `stat`으로 훑는데, 공유 저장소 층 `local-filesystem.ts`의 `assertSafeExistingFile`이
`missing()`으로 ENOENT를 흡수한 뒤 **다시 `lstat`**을 불러 그 사이 삭제가 끼면 throw했다.
잠금순서 시험이 격리 8회 중 4회 실패했다. 구현자의 단발 초록은 운이었다. 검토자도 처음에는 로그의
`40P01`을 deadlock으로 읽었는데, 그 문자열은 **시험 자신의 소스 라인**이 컨텍스트로 출력된 것이었고
실제 실패는 전부 ENOENT였다. 수정은 가드를 덧대는 대신 **`missing()`+`lstat()` 쌍을 한 호출로 합쳐
창 자체를 없앴다.** ENOENT만 흡수하고 EACCES·ELOOP·symlink 거절은 그대로임을 권한 0 디렉터리·
symlink 루프를 실제로 만들어 확인했고, 이 층을 쓰는 다른 consumer(gallery·activity track·resource·
url ingestion) 통합 시험 67건이 통과했다. 같은 잠복 결함이 **기존 track 스윕에도** 있었으므로 저장소
층에서 고친 것이 맞다.

worker에 `catch`를 두지 않은 판단은 시험으로 고정했다 — 스윕 오류를 "스윕했는데 없었다"로 바꾸는
것이 곧 오류를 알려진 결과로 취급하는 것이고, 사용자 요청 삭제는 스윕보다 앞에서 이미 끝나며,
커서가 전진하지 않는 것은 같은 창을 다시 보는 올바른 재개다.

검증(root가 통합 트리에서 직접 실행): typecheck 34/34, unit 272 files/3,197 tests, 실제 PostgreSQL
integration **3회 연속** 524/524(ENOENT·deadlock 흔적 0건 — 이전 4/8 실패가 실제로 닫혔다), build
15 task, drill `{"outcome":"passed","checkCount":62}`, identity **156 passed 2회**.

**identity에서 무관한 flake 1건을 관측했고 규명하지 않았다.** 네 번 돌려 두 번 156 통과, 한 번은
harness가 포트 4300 충돌로 뜨지 못했고(시험 결과 아님, 다른 shell의 playwright 프로세스가 있었다),
한 번은 `tests/identity/oidc.spec.ts:55`가 `page.waitForResponse` 30초 타임아웃으로 실패했다. 그
시험은 `visibilitychange`가 유발하는 refetch의 409를 기다리는 **시험 쪽 타이밍 의존**이고 M2-01m이
건드린 경로와 무관하며, 격리 실행 4/4 통과(각 5~6초)했다. base HEAD worktree에서는 3/3 깨끗했으나
그쪽은 생성 산출물이 없어 155건이라 비교가 교란돼 있다. M2-01h에서도 무관한 spec의 부하성
타임아웃이 관측·미규명으로 기록됐으므로 같은 부류가 재발한 것으로 본다.

## 다음 ready 작업

**M2-01k 지도·코스 통합 수용**이 ready다(i·j·l·m 완료). **M2-01n 공유 저장소 디렉터리 경합과
스윕 dead-letter**도 ready이며 M2-01k와 독립이다 — 독립 검토가 M2-01l 시대 연산만으로
`prepareParents`/`pruneEmptyParents` 경합을 재현했고(800 연산 중 269건 실패), 스윕에 참조 단위
오류 격리가 없어 항상 실패하는 참조 하나가 커서를 영구히 멈출 수 있다. 둘 다 이 노드가 들인 것은
아니다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 자체 운영 engine/data 선택·검증,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 working tree와 위 계획을 확인하고 M2-01a/d부터 진행한다. 실제 외부·실환경
증거가 필요한 gate를 문서 검토나 합성 fixture로 완료 처리하지 않는다.
