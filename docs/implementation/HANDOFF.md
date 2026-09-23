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

[M2-01l](progress/M2-01l.md)을 완료했다. 코스 썸네일을 **저장한다**. M2-01j는 화면에서 그리기만
했고 아무것도 저장하지 않아 권한·삭제·export 표면이 늘지 않았는데, 저장하는 순간 그 표면이 전부
늘어나는 것이 이 노드였다.

**설계 결정 여섯 가지와 근거**는 진행 문서에 있다. 요지는: **SVG**(래스터라이저라는 새 네이티브
의존성을 피했고, 실제로 lockfile 변경은 workspace 링크뿐이다), **revision에 묶었다**(revision이
불변이므로 그림도 불변 — 낡은 선의 그림이 될 수 없고, 살아 있는 그림이 코스당 최대 1개라 quota가
구조적으로 bounded), **비동기**(트리거가 같은 transaction에서 작업을 걸고 전용 worker role이
렌더한다 — 표 권한 0, bounded 함수 EXECUTE만), **여섯 상태 구별**(`ready`가 아니면 화면은 항상
M2-01j의 즉석 렌더로 돌아가고, 렌더 실패가 코스 저장에 닿는 경로는 없다), **export v21은
메타데이터만**(썸네일은 revision 기하에서 바이트 단위로 재계산되는 파생물이고 그 기하는 GPX
export가 이미 준다 — 바이트를 넣으면 가장 민감한 산출물에 위치 데이터의 두 번째 사본이 생기고
복원 이득이 0이다. M2-01j가 보호 구역 중심을 **넣은** 근거와 같은 규칙의 반대쪽 답이다).

**privacy trim과의 관계가 이 노드에서 가장 위험한 지점이었다** — 썸네일은 좌표를 그림으로
인코딩한 것이고, trim의 취지는 좌표가 돌아다니는 것을 멈추는 것이다. 세 가지가 **trim 전용 특수
처리 없이** 성립한다: trim된 revision의 그림은 구성상 trim된 선이고(leasing이 그 행 자신의
revision geometry만 가져온다), trim 이전 그림은 같은 transaction에서 superseded되며 두 ref가
실제로 회수되고, 옛 그림에 닿는 표면이 0이다. 검토자가 end-to-end로 실측했다.
덧붙여 저장 SVG는 좌표를 **0–100 viewport로 정규화**해 담아 bbox·축척·기준점이 없으므로
**절대 위치가 복원되지 않고 형태만 남는다.** 다만 형태 자체가 위치 정보일 수 있으므로
**정규화는 완화이지 면제가 아니며**, 권한·삭제·export 정책은 그대로 원본 코스를 따른다.

**가드 하나를 삭제했고, 이번에는 그것이 옳았다.** `finalize`의 head 재확인이 `state='superseded'`
전이와 동등한지를 실제 PostgreSQL 경합 세 가지로 확인했다 — append transaction이 행을 잡고
미commit인 동안 `finalize`가 블록했다가 commit 후 `superseded`를 반환하고, 역순도 닫히며,
동시 실행 12회에서 "`ready`인데 head 불일치"인 행이 한 번도 나오지 않았다. **가드를 지우고
불변식에 의존하기로 했으면 그 불변식이 시험돼야 하므로** 그 경합을 시험으로 남겼다(되돌리면
그 시험만 실패한다). M2-01i에서 같은 추론이 틀렸던 것과 대비된다 — 그때는 삭제되는 행에 대해서는
맞고 **순서**에 대해 틀렸다.

**되돌리기 측정 자체가 틀릴 수 있다는 것을 배웠다.** 038에는 같은 `WHERE` 절 문자열이 두 번
나온다(`prepare`와 `release`). 그 문자열로 되돌리면 앞의 것이 바뀌어 뒤의 가드가 공허해 보인다.
이 오측정이 이 노드에서 **두 번** 났고, 두 번째는 root가 그것을 근거로 "표가 거짓"이라고 지적한
뒤 구현자가 유일 anchor로 다시 재어 바로잡았다. 함정을 문서에 적어 두었다.

검증(root가 통합 트리에서 직접 실행): typecheck 34/34, unit 272 files/3,193 tests, 실제 PostgreSQL
integration 48 files/507 tests, build 15 task, drill `{"outcome":"passed","checkCount":62}`,
**identity 156 passed/0 failed 2회**.

**7절 기준을 완전히 충족하지 않는다.** reconciliation 스윕이 없어, fence 경과 후 1시간을 넘겨
잠든 writer가 깨어나 publish하면 **고아 객체가 영구히 남는다**(검토자가 재현했다). 살아 있는
그림을 덮어쓰거나 회수된 key를 되살리지는 못하고 계정 말소는 fence 재장전으로 결국 회수되므로
노출 경로는 없지만, 계획 7절이 요구한 "기존 durable cleanup 패턴"에는 M2-01c의 영속 ref 색인 +
keyset 스윕이 포함된다. **[M2-01m]으로 분리해 추적하며, M2-01k가 그것에도 의존한다** — 알려진
공백을 둔 채 S13을 수용하지 않기 위해서다.

그 밖의 한계: 목록 행에 썸네일 상태 없음, renderer version 2 자동 재생성 경로 없음, 선 색이
테마를 따르지 않음(내용주소 독립 문서라는 선택의 필연), 동시 worker 다중 실행·렌더 성능 미측정,
스크린리더 낭독 미시험. worker에 실제 deadline은 없다(객체 port에 취소가 없어 흉내내지 않았다).
**`release` 경로만 재시도 바운드의 종류가 다르다** — 시도를 되돌려 주므로 5회 예산이 적용되지
않고(중단은 실패가 아니므로 의도된 것), 안전망은 벽시계 `expires_at`(1시간)이다.

## 다음 ready 작업

**M2-01m 썸네일 객체 reconciliation 스윕**이 ready다. 그 다음이 **M2-01k 지도·코스 통합 수용**이며
i·j·l·m을 모두 기다린다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 자체 운영 engine/data 선택·검증,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 working tree와 위 계획을 확인하고 M2-01a/d부터 진행한다. 실제 외부·실환경
증거가 필요한 gate를 문서 검토나 합성 fixture로 완료 처리하지 않는다.
