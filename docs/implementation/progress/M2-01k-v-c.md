# M2-01k-v-c · S22 app revision과 evidence·승인 basis 호환

상태: in_progress — 정식 migration100·runtime grants·source/export 수용을 진행했으나 fulltail/restore·처리 재개 수용은 미완료.

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

## 정식 migration·source·export 등록 · 2026-10-07

Root가 ordered001..100 registry와 목적별 최소 public grant helper를 연결했다. SQL100 SHA `4d08a67aa44ffa0961e7b1023a420f854c3bfd0a3023811b98cc626fbd3209fd`를 실제 설치한 정식5 source suites **97/97**(기존80+신규17)이 통과했다. evidence15/run33/candidate26/joint11/v412이며 실제 PostgreSQL14.15, plain owner/restricted runtime/worker에서 수행했다. tmp metadata나 app binding 권한을 덧붙이지 않았다. root가 보고서·15개 source/test 해시·cleanup(stop0/status3/isready2 및 data/socket 제거)를 직접 대조했다. `/private/tmp/wm-s22-registered-source-acceptance-20261007.md`, `wm-s22-registered-final-r3-20261007.log`가 증거다. 최초94pass/3fail은 stale export 기대값과 신규 SQL 오류 기대값으로 남겨두었으며, 원래 ownership/AI assertions를 변경하지 않았다.

Binding은 원본 evidence/run/candidate/approval에서 immutable lineage로 캡처하고 현재 app epoch에 자동 backfill하지 않는다. worker prepare/finish는 철회·재동의 후 구형 basis를 거절하며 historical output read는 기존 AI·자료 ACL·삭제 검사를 유지한다. 성공 receipt는 새 processing gate 전에 반환한다. persistence/API/worker typecheck, 변경 test lint/format/diff check 모두 실제 exit0다. 정식 source suite가 합성 평가·SQL fixture를 포함한다는 한계를 유지하며 실제 외부 AI 호출로 부르지 않는다.

Export producer는 race v31을 유지한 strict **v32**로 다섯 binding fact 배열을 추가했다. command receipt key와 owner restore receipt는 내보내지 않는다. contract **26/26** 및 실제 PG export/erase **24/24**(원래15+신규9)가 통과했다. false/regrant 상태의 기존 fact 보존, tenant 분리, cap+1 거절·audit rollback, erasure binding 제거와 exact receipt 보존을 확인했다. `/private/tmp/wm-app-export32-contract-root-20261007.log`, `wm-app-binding-export-pg-20261007-run2.log`. export32는 backup loader나 처리 권한 증거가 아니다. grant matrix의 별도 actual13/13은 이전 migrate/SQL 입력 회차의 증거로 보존하며 현재97/24 결과와 같은 input으로 합산하지 않는다.

098/099 및 race export31 baseline은 아직 독립 phase 검토 전인 `phase/m2-02`의 **caaa428c**에서 가져온 준비 의존성이다. 이 의존성의 M2-02 phase 승인 전에 C를 main으로 병합하지 않는다. SQL100 파일 첫 줄의 draft/NOT EXECUTED 문구는 작성 당시 원본 hash를 보존한 것이며 현재 설치 증거는 위 별도 회차로 기록한다. source 및 registry 등록은 live 배포 또는 processing reopening 승인이 아니다.

별도 v5 codec/local exact replay 회차는 **66/66 = 실제PG27 + codec/preflight39**로 구분한다. 당시 root는14개 입력 해시와 cleanup을 대조했다. `/private/tmp/wm-s22-fulltail-v5-implementation-20261007.md`. 이후 root의 replay transaction composition port 변경은 새 검증 회차로 관리한다. 완전한 독립 baseline/final-tail witness, historical owner loader, generation/admission 원자적 전환·동일 host rollback 차단, budget101, 운영 restore/provider는 미완료이며 C는 계속 in_progress다.

## v5 exact replay와 owner transaction 조합 · 2026-10-07

App transition record5는 허용 field·연속 int4 epoch·nullable prior pair·timestamp를 엄격하게 검사한다. 기존1..4 decoder와 암호화 envelope format1을 유지하고 전체 chain 인증은 DB 연결 전에 끝낸다. Root는 후속 generation/postcondition과 같은 owner transaction에 조합할 internal port를 추출했다. process-local WeakMap에 인증한 handle을 보관하며 복사·재구성·직렬화한 handle은 SQL 전에 거절한다. port는 BEGIN/COMMIT/ROLLBACK·generation rotation·admission을 실행하지 않으며 caller가 lock 순서와 실패 rollback을 관리한다. 기존 public wrapper의 전체 chain1transaction 및 commit 불확실 시 connection 폐기는 유지한다.

현재 port의 실제 PG **11/11**(기존 appchain8+신규3)은 normal001..100 migrations/plain owner로 통과했다. caller BEGIN→replay→후속 SQL22012→전체 ROLLBACK, 같은 인증 handle의 재시도 COMMIT, 별도 connection에서 uncommitted 자료 비노출, 위조 handle 무변경 거절을 확인했다. Root가 `/private/tmp/wm-s22-replaytx-acceptance-20261007.md`와108개 입력 해시, stop0/status3/isready2·data/socket 제거를 직접 확인했다. root boundary13/13은 mocked SQL port이며 실제 DB11에 합산하지 않는다. 최초 root 시험은 존재하지 않는 Vitest project 이름으로 startup 실패했고 실제 integration config로 재실행한 기록을 보존한다.

현재 source SHA `eb2d3285f5192c36a647667da9c4bbc5f612834d04647ec663d691f9fa639c82`는 앞선66/66의 source와 구분한다. persistence typecheck·변경 source/test lint/format/diff check exit0. 합성 anchor/key는 local replay의 검증이며 독립적인 운영 tail completeness가 아니다. owner historical loader·독립 proof·처리 재개는 미완료이고 C를 완료 처리하지 않는다.
