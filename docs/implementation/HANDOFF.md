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

[M2-01c](progress/M2-01c.md)를 완료했다. preview한 FIT/GPX가 저장된 track이 된다 — 원본
bytes·정규화 기록·지도 파생물이 불변 revision에 묶인 private 객체가 되고, 기존 reserve →
prepare → stage → finalize 수명주기와 tenant RLS·서버 생성 key·durable cleanup manifest를
그대로 쓴다. 서버는 클라이언트 preview를 신뢰하지 않고 같은 규칙으로 재파싱·재검증한다.

**이월 부채 두 건을 여기서 갚았다.**

실제 메모리 상한: M2-01a의 예산은 작업량 상한이었고 M2-01b는 브라우저에 per-worker heap
상한이 없어 닫지 못했다. Node worker는 걸 수 있지만 **실제로 적용됐을 때만**이다 — ceiling
32 MiB인데 부모가 `--max-old-space-size`로 뜨면 조용히 무력화되는 것을 재현했다. 옵션은
CLI·`NODE_OPTIONS`·wrapper·`setFlagsFromString` 어디로든 들어오므로 문자열 검사는 가드가
아니다. 그래서 **worker가 실제로 받은 heap 한도를 보고**하고 명시한 예산과 일치할 때만
bytes를 보낸다. 보장은 "요청한 ceiling이 적용됐다"가 아니라 **"worker 총 heap이 명시한 예산
이하"**로 적었다.

재파싱 = 새 revision: 주석으로만 있던 규칙을 강제했다. parser 신원과 각 sample의 id·index·
시각·좌표·detailLink를 묶은 대응 digest를 revision에 저장하고, revision은 append-only
trigger, head는 +1 전이만 허용한다.

**검토의 대부분은 한 질문에 쓰였다 — 객체가 그것을 회수할 기록보다 오래 살 수 있는가.**
네 가지 경로로 가능했고 전부 재현 후 고쳤다: fence를 통과한 writer가 삭제·cleanup 완료 후
publish / upload 만료로 receipt가 영구 종료된 뒤 재개한 writer의 publish / compaction이
intent를 지우면 참조가 모든 후보 원장에서 사라짐 / 중복 업로드가 bytes를 등록하지 않아
삭제-재시도 반복이 backlog 예산을 우회. 지금은 객체를 드러내기 직전마다 fence를 재확인하고,
writer가 재개 가능한 동안 cleanup이 receipt를 재무장하며, byte 원장이 객체와 intent를 참조
기준으로 합집합하고, **영속 per-reference 색인이 compaction보다 오래 남아** 대조 sweep이
늦은 write를 찾는다.

그 sweep 자체도 두 번 경계가 틀렸다. 객체 key 나열은 반환 key만 묶어 **예산 1에 빈 디렉터리
1,001개를 읽었고**, 원장으로 옮기자 순회는 사라졌지만 **1행을 돌려주려 498행을 스캔**했다.
지금은 참조 색인의 keyset window를 읽으며, 원장 테이블이 행을 하나도 내놓지 않는다는 것을
트랜잭션 통계로 측정해 시험으로 고정했다.

**늦은 publication은 막지 못한다** — 객체 저장소에 조건부 쓰기가 없다 — 회수로만 보장하며,
그 회수의 경계도 문서에 적었다: 1시간 grace는 절대 상한이 아니고, sweep은 즉시가 아니라 몇
번의 실행 안에 따라잡으며, 참조 감시 해제의 7일은 상한이 아닌 바닥값이고, 서버가 기록하지
않은 key는 범위 밖이다.

검증은 typecheck 32/32, unit 242 files/2,688 tests, 실제 PostgreSQL integration
44 files/403 tests(2회 동일), build 14 task, backup/restore drill **51 checks**를 통과했다.
drill은 백업 이후 활동을 삭제해 복원된 런타임이 read·download·export·재수입을 모두 거절하고
객체가 회수되는 것까지 검증하도록 확장했다. 계정 export는 v18이다.

## 다음 ready 작업

**M2-01e 저장 활동 지도·차트**가 다음 직렬 작업이다. M2-01c의 저장된 track과 M2-01d의
basemap을 S09 화면에 연결하고 chart·lap·sample 선택을 잇는다. 이 노드가 **저장된 track의
첫 실브라우저 증거**를 만든다 — M2-01c는 UI를 바꾸지 않아 브라우저 검증이 없고, M2-01b의
증거는 저장 전 preview에 대한 것이다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 자체 운영 engine/data 선택·검증,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 working tree와 위 계획을 확인하고 M2-01a/d부터 진행한다. 실제 외부·실환경
증거가 필요한 gate를 문서 검토나 합성 fixture로 완료 처리하지 않는다.
