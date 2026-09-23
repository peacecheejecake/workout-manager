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

[M2-01n](progress/M2-01n.md)을 완료했다. M2-01m 독립 검토가 분리한 두 건 — 공유 저장소 층의
디렉터리 경합과 reconciliation 스윕의 참조 단위 오류 격리 — 을 다뤘다. 둘 다 M2-01m이 들인 것이
아니다. M2-01k와 **별도 git worktree에서 병렬로** 구현했고, 포트는 scratchpad의 `mkdir` 원자적
잠금으로 직렬화했다.

**디렉터리 경합.** `pruneEmptyParents`가 공유 디렉터리를 비우는 동안 `prepareParents`의 `mkdir`·
`lstat`·`chmod`가 터졌다. 검토자가 제안한 봉쇄(tenant/course 층을 prune하지 않는다)를 구현자가
**측정해 거절했다** — 형제 임시 객체가 course 아래 `thumbnails/temporary/`에 나란히 있어 다중
프로세스 시험이 여전히 8/8 실패했다. 검토자도 직접 재현해 "구현자가 옳았다"고 판정했다. 택한 것은
**형제 write unit이 공유하는 디렉터리는 어느 것도 prune하지 않는다**이고, key 모양 10종의 깊이를
exhaustive switch로 선언하게 했다. `prepareParents`는 한 글자도 바뀌지 않았고 새로 흡수하는 `mkdir`
오류가 없다. macOS의 `mkdir` `EINVAL`을 C로 100만 회 측정해(동시 `rmdir` 있으면 123,845건, 없으면
0건) 의미를 확정했지만, **한 기계의 측정을 일반화하지 않으려고 흡수 자체를 피했다.**

**스윕 오류 격리.** 항상 실패하는 참조 하나가 커서를 영구히 멈추던 것을, `stat` 한 호출만 감싸고
오류를 참조 자신의 색인 행에 **기록**하는 방식으로 풀었다. 던져진 `stat`은 절대 답으로 읽히지 않으며
그 참조에 대해 settle·reclaim을 호출하지 않는다. dead-letter는 표식이지 탈출이 아니다. 이것은
M2-01m이 시험으로 고정한 "worker에 catch 없음"과 모순되지 않는다 — 오류가 "없었다"로 바뀌지 않고
DB에 기록된다.

**독립 검토 세 라운드에서 이 노드가 들인 회귀가 두 번 나왔다.** 첫째, 참조 단위 격리가 **저장소 전체
장애를 종료코드 0으로** 보고하게 만들었다(M2-01m이었다면 매 실행이 알람을 울렸을 상황). 둘째, 그것을
"창 전체가 실패하면 실행 실패"로 고치자 **장애 첫 실행만 실패하고 이후는 backoff 동안 다시 성공**으로
보고됐다 — 알람이 가장 필요한 지속 장애 동안 신호가 조용해졌다. 저장소 도달 가능성은 참조 단위가
아니라 **실행 단위 사실**이므로, 매 실행 port 뒤의 `assertReachable()`로 루트를 먼저 묻게 했다.
**루트 부재는 "비어 있음"이 아니라 실패**로 보며, 참조 단위의 "부재 → null" 헬퍼를 재사용하지 않았다.

그리고 runtime의 표 단위 INSERT가 새 fault 열까지 덮어 **100년 deferral로 참조를 스윕에서 영원히
숨길 수** 있었다. 040이 이를 세 열 INSERT로 좁히고 기존 부여분을 회수·재부여하며, grant 헬퍼가
스스로 REVOKE하므로 옛 헬퍼가 돌았더라도 새 헬퍼를 다시 돌리면 복구된다. 검토자가 **실제 DB에서
M2-01c의 실제 statement를 runtime으로** 돌려 열 단위 권한만으로 `ON CONFLICT DO NOTHING`이 실제
충돌까지 동작함을 확인했다.

검증(root가 worktree에서 직접 실행): typecheck 34/34, unit 272 files/3,224 tests, 실제 PostgreSQL
integration 539/539 **2회**, build 15 task, drill `{"outcome":"passed","checkCount":62}`, identity
**156 passed 2회**.

**남긴 것은 [M2-01o]로 분리했다**(전부 이 노드 이전부터 있던 성질): 참조 경로 검증이 루트 자체는
`lstat`하지 않아 실행 중 루트가 symlink로 바뀌면 참조가 부재로 읽힌다(DB settle 하한이 reclaim을 막아
결과는 삭제가 아닌 누수). grant 헬퍼의 REVOKE와 GRANT가 별도 autocommit이라 운영 DB에서 수 ms
`42501` 창이 있다.

## 다음 ready 작업

**M2-01k 지도·코스 통합 수용**이 검토 대기 중이다(아래). **M2-01o**는 ready이고 M2-01k와 독립이다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 자체 운영 engine/data 선택·검증,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 working tree와 위 계획을 확인하고 M2-01a/d부터 진행한다. 실제 외부·실환경
증거가 필요한 gate를 문서 검토나 합성 fixture로 완료 처리하지 않는다.
