# 다음 세션 handoff · 2026-09-19

최신 상태는 [task-graph.json](task-graph.json), 요구·수용 기준은
[docs/.pre](../.pre/README.md), 작업 규칙은 [AGENTS.md](../../AGENTS.md)를 우선
확인한다. 이 문서는 M2-04b 구현 직전 기준 HEAD
`91801ae4ffbf2f50bddb4a42bc27984acd339ba4`에서 시작한 결과를 설명한다. 재개할 때
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

[M2-04b](progress/M2-04b.md)는 private PDF/Markdown의 bounded streaming upload,
인증 download, 불변 file version, 삭제·계정 말소 raw object 정리를 구현했다.
`@workout/server-media`는 tenant/resource/upload-scoped content-addressed key와 private local adapter를
제공한다. Migration 028은 text/file XOR, upload intent, immutable object metadata,
quota, FORCE RLS와 durable cleanup queue를 추가한다. API는 intent → raw PUT → finalize를
사용하되 temporary write와 publish 사이에 durable `prepared` 상태를 기록한다. 30분 expiry와
active count/byte quota를 적용하고, 전용 최소 권한 worker는 만료 intent를 회수한 뒤 queue를
lease하고 live reference 부재를 재승인받은 object만 삭제한다. worker가 보낸 절대 시각은 권한 판단에
쓰지 않고 DB 시각을 사용한다. failed intent는 tenant history cap과 7일 retention, 완료 cleanup은 30일
retention을 적용한다. 계정 export v13은 storage ref를 제외하며 v1~v12 읽기
호환성을 유지한다.

두 shell은 PDF/Markdown 생성·새 버전, 진행/오류/재시도, descriptor, 인증 download와
삭제를 제공한다. 파일은 `private`, `unreviewed`, `includeForCoach=false`,
`raw_stored/not_indexed`이며 파싱·검색 완료로 표시하지 않는다. 실제 OIDC·격리
PostgreSQL·Chromium E2E에서 두 tenant, web/mobile-web, 320px reflow와 삭제 뒤 다운로드
차단을 확인했다. PostgreSQL metadata와 private object archive의 합성 backup/restore도
함께 검증했다.

브라우저는 `prepared`를 정상 중간 상태로 파싱한다. 일시적 prepare/mark 오류는 같은 upload를
`UPLOAD_RESUME_REQUIRED`로 재개하고, publish 경합은 `UPLOAD_RETRY_REQUIRED`로 새 intent를 만든다.
terminal failed reservation을 다시 받으면 같은 사용자 동작 안에서 새 idempotency key로 재예약한다.

M2-04 전체와 FUT-06은 미완료다. URL fetch/parser, 공유·coach ACL, 색인·검색·인용은
구현하지 않았다.

## 다음 ready 작업

**M2-04c URL 수집·parser lifecycle**이 다음 직렬 작업이다. URL과 모든 redirect hop을
allowlist 및 공인 주소 기준으로 검증하고, DNS rebinding·사설/loopback/link-local 주소를
fail closed로 차단한다. fetch와 parser는 크기·시간·redirect·압축·문서 복잡도를 제한하며
출처와 실패 상태를 원장에 남긴다. raw/parsed 파생물은 삭제·계정 말소 manifest에 함께
연결하고 parser 결과를 reviewed 콘텐츠나 coach 근거로 자동 승격하지 않는다.

그 뒤 M2-04d ACL
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

다음 세션은 M2-04b commit이 원격에 있는지 확인하고, task graph에서 M2-04c의 선행
조건을 재확인한 뒤 URL fetch 보안 경계와 parser lifecycle 계약부터 구현한다.
