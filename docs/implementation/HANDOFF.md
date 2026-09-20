# 다음 세션 handoff · 2026-09-20

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

[M2-04c](progress/M2-04c.md)는 private HTTPS URL 예약부터 raw capture, bounded parse, immutable
provenance/locator, failure/bookmark, 삭제·계정 말소까지 구현했다. Migration 029는 tenant RLS URL 원장,
DB-clock lease/retry/CAS, object lifecycle와 outbox를 추가한다. 전용 worker는 exact-host allowlist,
hop별 DNS와 실제 TLS socket 주소 검증, redirect·body·parser 상한을 적용한다. API와 계정 export v14는
query, storage ref, 주소, credential과 내부 오류를 노출하지 않는다.

자료실은 URL 생성, 진행 상태 polling, 취소, finalized/bookmark/failure 상태와 URL reader를 제공한다.
fetch·parse 성공은 reviewed, 검색 색인 또는 coach 사용으로 승격하지 않는다. URL raw/parsed object는
resource quota와 기존 durable cleanup manifest에 포함한다.

검증은 typecheck 27/27, unit 202 files/2,146 tests, 실제 PostgreSQL integration 39 files/325 tests,
backup/restore 37 checks를 통과했다. Aside session `1jIg55RE9pcqbeme`에서 1440px와 320px label/focus/reflow,
query 포함 URL의 `parsing → finalized`, 목록 갱신과 query 비노출을 확인했다. 허가된 운영 외부 host에
대한 실제 TLS fetch, 원격 object provider와 운영 scheduler/RPO/RTO는 별도 배포 검증 대상이다.

M2-04 전체와 FUT-06은 아직 미완료다. 공유·reviewed/coach ACL과 index/cache/citation 삭제 manifest는
구현하지 않았다.

## 다음 ready 작업

**M2-04d 자료 접근·공유·coach 사용 경계**가 다음 직렬 작업이다. M2-04b/c의 object와 URL lifecycle을
재사용해 ACL revision, 명시 공유/철회, reviewed 전환과 `includeForCoach` 활성화 조건을 구현한다.
access/consent/policy 변화는 cache/index/citation dependency manifest를 통해 삭제·재생성 경계를
보장해야 한다. parse 성공이나 공유 요청만으로 reviewed 또는 coach 사용을 자동 활성화하지 않는다.

M2-03 갤러리·media도 ready지만 object storage port를 중복 구현하지 않는다. M2-05 RAG는 M2-04 전체와
M2-03이 완료될 때까지 ready가 아니다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 운영 provider 선택,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 M2-04c commit이 원격에 있는지 확인하고 M2-04d의 접근 revision과 전환 command 계약부터
구현한다.
