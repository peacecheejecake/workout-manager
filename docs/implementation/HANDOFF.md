# 다음 세션 handoff · 2026-09-19

최신 상태는 [task-graph.json](task-graph.json), 요구·수용 기준은
[docs/.pre](../.pre/README.md), 작업 규칙은 [AGENTS.md](../../AGENTS.md)를 우선
확인한다. 이 문서는 M2-04a 구현 직전 기준 HEAD
`ee5d08c556873622e29ded4b4c73cbd94746b778`에서 시작한 결과를 설명한다. 재개할 때
`git log -1`, `git status --short`, 원격 동기화를 다시 확인한다.

## 사용자 결정과 작업 방식

- 브랜치는 `main`이다. 사용자는 본인 관리 원격 저장소로 task별 peer review,
  commit, `git push origin main`과 다음 ready 작업 계속 진행을 승인했다. 일반적인 push
  실패는 기록하고 다음 작업을 진행한다.
- AGENTS·skill 규칙은 명시적 규칙 변경 요청 없이 수정하지 않는다. 사용자 변경과
  untracked 파일을 보존한다.
- 구현 분해는 Codex native orchestration, 커밋 전 독립 검토는 같은 tab의 Herdr
  split pane을 사용한다. UI 검증은 Aside → Chrome → Playwright 순서를 지킨다.
- JavaScript workspace는 Node 24.12.0과 pnpm 10.34.5로 검증했다.

## 완료된 최신 작업

[M2-04a](progress/M2-04a.md)는 직접 입력 private text의 계약, PostgreSQL 원장,
Fastify API, web/mobile-web reader를 구현했다. Migration 027은 FORCE RLS, 불변
version chain, CAS/access revision, 안정적 멱등 receipt, atomic outbox, soft-delete
tombstone과 account erasure를 제공한다. 계정 export v12는 살아 있는 resource/version을
포함하며 v1~v11 읽기 호환성을 유지한다.

화면은 생성, 목록, 현재/정확한 과거 version reader, 새 version, 명시 삭제를 제공한다.
자료는 `private`, `unreviewed`, `includeForCoach=false`, `parsed/not_indexed`이며 AI 요약,
검색/RAG 또는 인용으로 표시하지 않는다. 실제 OIDC·격리 PostgreSQL E2E에서 두 tenant,
web/mobile-web, 320px reflow와 삭제 뒤 current/history 원문 차단을 확인했다.

M2-04 전체와 FUT-06은 미완료다. 파일/PDF upload, object storage, URL fetch/parser,
공유·coach ACL, 색인·검색·인용은 구현하지 않았다.

## 다음 ready 작업

**M2-04b 객체 저장 port·파일 upload**가 다음 직렬 작업이다. 기존 task graph 설명과
달리 M0-05 산출물에는 실제 공용 object-storage port가 없다. 서버 전용 port와 격리된
object key, 허용 MIME/확장자·크기, bounded streaming, 임시 object 후 원자적 확정,
hash, 실패 정리, raw 삭제와 account erasure를 먼저 구현한다. provider SDK나 credential은
browser contract에 노출하지 않는다. shared migration/manifest는 root가 직렬 통합한다.

그 뒤 M2-04c URL/redirect allowlist·SSRF 방어·bounded parser·파생 삭제, M2-04d ACL
revision·명시 공유/철회·reviewed/includeForCoach 전환·index/cache/citation 삭제 manifest를
진행한다. M2-05 RAG는 M2-04 전체와 M2-03이 완료될 때까지 ready가 아니다. M2-03
갤러리·media는 M2-04b와 별도로 ready지만 object storage 경계를 공유할 수 있으므로 중복
port를 만들지 않는다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 운영 provider 선택,
  OS 한글 IME/물리 touch/성능·배포 조건. Aside 업데이트는 `fetch failed`였고
  computer-use 상태에는 Chrome browser surface가 없었다.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/back 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 M2-04a commit이 원격에 있는지 확인하고, task graph에서 M2-04b의 선행
조건을 재확인한 뒤 storage port 계약과 실패/삭제 semantics부터 구현한다.
