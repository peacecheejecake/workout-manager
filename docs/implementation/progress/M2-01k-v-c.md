# M2-01k-v-c · S22 app revision과 evidence·승인 basis 호환

상태: in_progress — 아래 draft SQL 및 실제 source 수용은 진행했으나 정식 migration·fulltail/restore·처리 재개 수용은 미완료.

strict v1/v2를 파괴하지 않는 versioned app admission binding, capture/worker/candidate/v3/v4 승인 freshness와 철회→재동의의 구형 basis 거절; export/restore 이전 자료 읽기 유지.

2026-10-06: native agent가 evidence·run·candidate·v3/v4 approval 처리 지점의 runtime 연결을 준비한다. root가 migration 100·restore v5·공통 계약을 직렬화한다. 설계 초안은 `/private/tmp/wm-s22-app-basis-design-20261006.md`, SQL은 `/private/tmp/wm-s22-app-binding-100-draft-20261006.sql`이며 SQL_NOT_EXECUTED다. 현재 app true를 과거 basis에 다시 붙이는 backfill은 허용하지 않는다. 별도 실제 DB concurrency/restore/lease 수용 전 completed로 바꾸지 않는다.

## 2026-10-06 후속 준비 증거

Evidence/run/candidate/joint/v4 처리 지점의 runtime 연결을 준비했다. 원본 artifact INSERT에서만 binding을 생성하고, 성공한 receipt 반환 전에 새로운 live gate를 넣지 않는다. worker는 lease 우선순위를 유지하고 savepoint로 예상 SQL app conflict를 복구한 뒤 stale cancel/ACK를 처리한다. 공개 API는 제한된 SQL P0001 app 오류를 안정된409로 매핑하며 다른 SQL 오류를 숨겨 성공 처리하지 않는다. 현재 runtime 연결은 등록된 migration 및 repository acceptance 전이므로 **verified 아님**이다.

SQL100 v1 frozen probe는 실제 plain owner PG14에서 설치 후16pass/1fail이었다. 정상 production app event가 이미 있되 restore receipt가 없으면 exact replay가 거절되는 결함을 발견했다. v2는 원본 event 전체 identity, 현재 head까지 연속 epoch/previous state, timestamp와 선택적인 기존 receipt 전체 identity를 검증한 뒤 최소 current receipt를 만든다. 존재하는 event만으로 완료 처리하지 않는다.

실제 일회용 PG14 v2 probe **22/22**, owner/runtime NOSUPER/NOBYPASS, cluster 정리 exit0. 순서는 S22 001–097 → 별도 phase/m2-02 HEAD4258037f의098/099 → draft100 v2이다. SQL100을 index98로 등록해 version100이라 부르지 않았다. hash `b2a7b3db8823de6fa0b3224345bda47eefce60532f759321a12e64d3bf2b181a`. 로그 `/private/tmp/wm-s22-app-pg-probe-20261006-v2-run1.log`, 전체 source hashes `/private/tmp/wm-s22-app-pg-source-checksums-20261006-v2.json`; v1 실패 로그를 보존한다. Evidence는 최소 DB-valid SQL body fixture라 repository DTO acceptance가 아니다.

남음: 정식100 등록/grants·직접 producer fixture 호환·real repository worker/candidate/v3/v4 동시성·v5 record/pgoutput/segment/replay/coverage 소비자·generation readiness 및 독립 complete backup/tail 재생. 실제 external model/운영 restore는 **not_executed**다.

## API 오류 경계 로컬 검증

Root는 SQL `P0001`의 정확한 세 app binding 오류만 `AppAdmissionBindingError`로 변환하도록 공통 helper를 연결했다. 다른 SQL 오류·권한 오류·비정상 입력은 성공 또는 동의 충돌로 바꾸지 않는다. 공개 API의 안정된409 매핑 시험 **3/3**, SQL 오류 분류·bound parameter helper 시험 **10/10**, forced persistence/API 소비자 typecheck **11/11 cache0**가 실제 통과했다. 로그 `/private/tmp/wm-s22-v-c-boundary-tests.log`, `/private/tmp/wm-s22-v-c-sql-error-classification.log`, `/private/tmp/wm-s22-v-c-mapping-consumers.log`.

오류 helper의 10개 시험은 주입한 SQL port를 사용한 로컬 시험이다. 파일 이름의 integration 표시는 실제 DB 실행 증거가 아니며 위 PG14 draft probe 및 아직 남은 repository acceptance와 구분한다. 이 결과로 task를 completed로 변경하지 않는다.

## 실제 source producer·ownership 회귀 수용 · 2026-10-07

Root는 실제 source 보고와 gate 순서·최종 source 해시 및 PG cleanup을 확인했다. draft100v2 입력으로 실제 source evidence capture→run→synthetic worker→candidate/approval 경로를 실행했다. Run/candidate **53/53** (`/private/tmp/wm-s22-source-final-run-candidate-r7-20261007.log`), 별도 joint/v4 **24/24** (`/private/tmp/wm-s22-source-final-joint-v4-r9-20261007.log`)다. 이전 SQL22/22를 이 source 수용으로 이름붙이거나 결과를 합산하지 않는다. source ownership/preflight를 apptrue 상태에서 먼저 확인한 뒤 owned binding을 검사하여 원래 THREAD_NOT_FOUND/EVIDENCE_UNAVAILABLE/CANDIDATE_UNAVAILABLE/STALE_BASIS 계약을 보존했다. appfalse 신규 처리 거절·regrant old basis stale·성공 receipt 유지·실제 lease/revoke 및 atomic rollback도 검증했다.

실제 input은 phase/m2-01k001..097 + 별도 phase/m2-02 authoritative098/099 + draft100v2이며 정식 registry/grants 구현 완료가 아니다. owner/runtime/worker는 NOSUPERUSER/NOBYPASSRLS, 임시 source helper version metadata에는 실제 설치 SQL hash만 기록했다. 보고서는 `/private/tmp/wm-s22-source-acceptance-report-20261007.md`와 v4 후속 `/private/tmp/wm-s22-v4-final-source-acceptance-20261007.md`이며 후자가 앞선21/22 실패를 수정한 결과다. 기존 assertions를 새 오류에 맞춰 약화하지 않았다. 최초 fixture metadata/GUC/column·ownership 실패 및 outbox 전체 count 잘못된 기대 실패는 별도 로그로 보존한다. persistence/API/worker TS·변경3source lint/format exit0, PG shutdown/socket/data 정리 확인.

추가 실제 source 감사에서는 app만 철회/regrant했을 때 저장된 coaching output이 DB/export에는 남으나 GET output은 null/404로 숨겨지는 read policy 충돌을 재현했다. AI철회에 따른 purge/접근차단과 구분해 historical read의 app gate만 분리하는 수정·actualPG 회귀를 진행한다. 위53/24 증거는 해당 추가 수정 이전 고정 source의 결과이며 최신 read policy 수용을 대신하지 않는다.

정식100 registry·grants·export/erase, encrypted/fulltail suppression codec·generation admission ACK·복원/reopen 및 운영/provider 검증은 계속 미완료다. C를 completed로 올리지 않는다.

## App 철회 뒤 historical coaching output 조회 수정 · 2026-10-07

실제 DB에서 확인한 read policy 충돌을 수정했다. internal currentRunEvidence는 명시 processing/historical_read 목적을 받고 historical read에서만 app binding 처리 gate를 생략한다. worker prepare/finish의 app epoch gate, 모든 기존 AI/evidence/policy/retrieval ACL·삭제 검사는 유지한다. OutputV1의 untrusted_fixture/unvalidated 표시도 그대로여서 읽을 수 있다는 사실을 신규 처리·계획 승인 권한으로 승격하지 않는다.

Root는 `/private/tmp/wm-s22-read-audit-and-fix-20261007.md`를 읽고 최종 coaching-runs.ts SHA `bc8798eaa88126419e5db7231e9d8e1ef3baf21b59df2611745f698fa7a29c72`를 직접 대조했다. 현재 source actualPG **56/56**은 기존53+추가read3 회차다. 별도 기존53/53(추가3 filter skip) 및 grounded resource ACL1/1(나머지20 filter skip)은 각각 독립 증거이며 합산하지 않는다. appfalse/regrant/missing-binding fixture의 기존 output 조회·export 유지, stale worker/candidate 처리 거절, AI withdrawal 실제 purge·자료 ACL 철회 read 거절을 검증했다. missing-binding fixture는 owner scope DELETE 상태이며 pre100 restore loader 검증이 아니다.

최종 persistence/API/worker 및 tmpconsumer TS·source ESLint·format exit0. 두 privatePG cluster stop0/status3/isready2 및 socket/data 제거를 직접 확인했다. 신규 회귀는 현재 private/tmp source consumer tests에만 있으며 정식100 migration·test 등록 전 완료로 승격하지 않는다. 이전56와53 회차 로그와 fixture/Node20 lint·import 실패도 보존한다. C/fulltail/운영 restore는 계속 in_progress다.
