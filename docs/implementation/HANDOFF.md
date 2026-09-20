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

[M2-04d](progress/M2-04d.md)와 [M2-03](progress/M2-03.md)을 병렬로 구현하고 각각 커밋했다.
M2-04d로 M2-04 자료 생명주기 전체를 마쳤다.

M2-04d는 access revision, 명시 공유/철회, reviewed와 `includeForCoach`의 분리 전환,
derived cleanup manifest를 구현한다. Migration 030은 tenant RLS 공유 원장과 audit,
head trigger, derived cleanup queue를 추가한다. 철회는 RLS policy 자체가 강제하고,
coach 사용 manifest는 tenant에 묶인 digest로 고정되며 초과 시 잘리지 않고 실패한다.
실행기가 없는 cleanup target은 manifest를 완료하지도 attempt 예산을 쓰지도 않으므로
coach 사용이 fail-closed로 유지된다. 공유 파일은 요청마다 공유를 재검증하는 서버
streaming 경로로 읽는다. 이미 시작된 전송은 중단하지 않으며 계약·route·UI 문구가 그
경계를 명시한다.

M2-03은 tenant 소유 갤러리 원장, 기존 media object port를 재사용하는 upload lifecycle,
사진·동영상 allowlist와 magic byte 검증, tombstone 삭제와 기존 durable cleanup manifest
재사용을 구현한다. preview finalize는 예약 시 관측한 access revision을 transaction 안에서
CAS 재확인한다. 목록·상세는 query가 성공 상태가 아니면 미디어를 렌더하지 않는다.

검증은 typecheck 28/28, unit 207 files/2,198 tests, 실제 PostgreSQL integration
40 files/357 tests, build 11 tasks, gallery Playwright 3/3을 통과했다. 각 task는 독립
peer review를 5라운드까지 반복해 차단 findings을 모두 해소한 뒤 커밋했다. 계정 export는
v15(공유·audit)를 거쳐 v16(갤러리)으로 올렸다.

미구현으로 남은 범위: 검색 색인·retrieval cache·인용 저장소의 실제 삭제 실행기(M2-05),
S17의 viewer·앨범 관리·filter·EXIF 위치 제거·서버 thumbnail/transcoding, 안정 cursor
pagination 계약, 원격 object provider와 운영 scheduler 검증.

## 다음 ready 작업

**M2-05 RAG·검토 자료·코치**가 다음 직렬 작업이다. M2-04와 M2-03이 모두 완료되어 ready다.
M2-04d가 남긴 derived cleanup 실행기(색인·cache·인용)를 실제로 구현해야 하며, 열린
manifest가 있는 동안 coach 사용이 차단된다는 fail-closed 경계를 유지해야 한다. 검토된
콘텐츠만 retrieval에 사용하고, 삭제된 발췌가 재시도나 retrieval로 부활하지 않아야 한다.
`packages/contracts/src/evidence-dependencies.ts`에 `resource-access-v1` manifest를
통합하는 작업도 M2-05에서 함께 처리한다.

M2-01 코스·도로 routing은 M0-06b 지도 spike에 막혀 있고, M3-01은 M0-06c에 막혀 있다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 운영 provider 선택,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 M2-04c commit이 원격에 있는지 확인하고 M2-04d의 접근 revision과 전환 command 계약부터
구현한다.
