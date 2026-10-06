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

## 기존93 backup pin과 현재100 schema 구분 회귀 · 2026-10-07

기존 source-registry candidate93 및 coverage2/complete:false를 변경하지 않았다. 정식 registry가100으로 확장된 뒤에도 과거 pin checksum 시험은 명시001..093 원본 prefix를 검사하고, 별도 신규 시험은 현재001..100을 과거 pin으로 허용하지 않는다고 단언한다. historical coverage PG fixture도 migrate(...,93)를 명시해 해당 증거의 범위를 고정한다. 현재 schema를93으로 잘라 운영 준비 완료라고 판단하는 경로는 추가하지 않았다.

Root unit boundary **6/6**, 별도 실제 PG source inventory **1/1** 및 historical snapshot coverage **2/2** 통과. Source inventory의 같은 시험 안에서 실제93 positive 뒤 normal migration100으로 upgrade하고 candidate93 거절을 검증했다. `/private/tmp/wm-source-inventory-legacy100-boundary-20261007.log`, `wm-source-inventory-actual100-boundary-r2-20261007.log`, `wm-snapshot-legacy93-pg-r2-20261007.log`. 최초 sandbox의 shmget EPERM 초기화 실패 로그는 보존했고 승인된 일회용 PG 시험으로 재실행했다. scope별 임시data/socket parent가 없음을 직접 확인했다. 이 시험은 schema100 독립 registry/완전 coverage의 성공 증거가 아니라 아직 재개할 수 없다는 거절 회귀다.

## 독립 witness 검증 adapter 준비와 schema100 catalog 후보 · 2026-10-07

새 private restore-processing-proof는 purpose fresh_bootstrap/live_upgrade/full_restore를 구분하고 HMAC domain·canonical signed bytes, 별도 독립 witness key/version, target nonce·checkpoint·lease·fence 및 owner별 zero/absence를 검증한다. 기존 signed head/AEAD ciphertext/version·replay preflight를 재사용하고 복사한 handle은 process-local WeakMap으로 거절한다. 모든 결과의 admissionAllowed는 false다. full_restore라는 목적 이름도 현재 app-binding/replay witness 준비 범위를 뜻하며 전체 복원 admission 검증 완료를 뜻하지 않는다.

Root는 두 frozen source/test hash와 구현 경계를 읽고 정식 integration config에서 **29/29 crypto/protocol 단위 시험**을 재실행했다(`/private/tmp/wm-restore-processing-proof-root-20261007.log`). 실제 PG 수용으로 세지 않는다. Agent의 persistence TS·두 파일 lint/format/diff check exit0 및 최초 TS 오류 로그는 별도 증거다. 파일 이름에 integration이 붙어도 synthetic signer/remote witness/target callback 시험이라는 범위를 유지한다. 실제 독립 provisioner·전체 source rowsets·signed baseline/private object 증거·CLOSED revision·snapshot/slot origin·loader postconditions는 미구현이고 현재 handle을 처리 재개 권한으로 사용할 수 없다.

Root는 normal001..100 migration checksum 전부를 직접 비교하는 별도 plain NOSUPER/NOBYPASS owner PG에서 schema100 catalog를 수집했다. 후보 v2에는554relations/2335columns/423functions/252triggers/180policies/1318constraints/367indexes/977privilege entries가 있다. `/private/tmp/wm-schema100-candidate-v2-20261007.json` artifact SHA `6217fda6118b7919c8db07b7cba3cd642daf9dcf0c0bff6c29a152f75821a231`, catalog SHA `e37b164b4ef427f81f247f6e956511e51b8b633ced6c4522497b28411e32e526`. 이는 빈 synthetic schema의 unreviewed candidate이며 complete:false/restoreAccessAllowed:false다. 운영 source에서 기대 pin을 학습하지 않았고, normal-empty ACL을 실제 runtime grants 기준으로 오인하지 않는다. Sequence values/enums·role membership·모든 private rows·파일/외부 저장소·PG17 compatibility가 미검증이다. PG 종료·parent 제거를 직접 확인했다. v1의 제약/ACL 누락과 해당 hash도 별도 보존했다.

Private owner-loader v2 probe의 실제 PG **31/31** 보고·input hashes·cleanup을 root가 확인했다. appfalse2/true3에서도 original evidence binding1/captured_at 및 명시 legacy absence를 유지하는 evidence trigger seam이며, schema100은 변경하지 않았다. `/private/tmp/wm-s22-ownerload-acceptance-20261007.md`, SQL `/private/tmp/wm-s22-owner-loader-draft-20261007-v2.sql` SHA `2223393e33074053320321d6164ef8cfa36a124a92eb4d7893526363afc7c77e`. XID·nonce·state·rowset digest·소유권·cap·rollback·REASSIGN 거절/성공을 분리 검증했고 초기 UUID/text·timezone canonicalization 실패는 보존했다. 최소 SQL body fixture이며 실제 제품 source artifact/full dump 복원 증거가 아니다. loader CLOSED는 global runtime admission이 아니며 나머지4 binding/command receipts·완전 import·최종 tail/generation은 계속 남아 있다. 이후 확장 v3는 별도 입력·검증 회차다.

## Schema100의 동의·불변 binding inventory 준비 · 2026-10-07

새 private `schema100-row-inventory.mjs`는 서로 다른 plain owner connection의 exported/imported repeatable-read readonly snapshot에서 active/erased owner roster와 app 동의의 존재·부재, 다섯 불변 binding 및 원본 command/replay receipt를 purpose별 HMAC count/digest로 캡처한다. 기대 candidate/hash/owner 목록은 외부 입력이며 source catalog 변화를 새 pin으로 학습하지 않는다. 정상 migration001–100과 FORCE RLS를 유지한다. owner/row1000, row1MiB, 전체8MiB, catalog16MiB 상한은 본문 fetch 전 SQL로 검사한다. Runtime ACL은 관측 hash와 미해결 gap으로 따로 남긴다.

Root는 두 파일을 직접 읽고 frozen SHA를 대조한 뒤 실제 PG14 시험을 재실행했다. **13/13 passed, skip0**(12개 시나리오와 상위 시험), `/private/tmp/wm-schema100-row-inventory-root-20261007.log`. app absent, false2→true3에서도 original binding1·receipt digest 유지, erased roster, runtime의 global receipt 접근 거절, 독립 snapshot isolation, forged/expired context, row/owner cap+1·byte 초과의 fetch 전 거절 및 catalog drift를 검증했다. 시험 자체의 finally에서 클러스터 중지·자체 parent 삭제·부재를 확인한다. Agent의 최초 candidate 정책 role 정규화 실패 로그는 보존한다. 정상 configured grantOperations를 사용하며 synthetic source SQL fixture와 실제 제품 저장 경로를 구분한다.

Source SHA `7aadd45323c2c85bb34393fed97193c6b651e6403f962ce61b04b7137fb2e197`, test SHA `b1563d20d906268ec76dcf3f2d58997453c224ea77426104e11f34eb7e5693b5`. Agent lint/format/syntax와 root diff 검사는 exit0이다. 이는 기존 registry93/coverage2를 교체하지 않는 candidate adapter이며 반환은 항상 complete:false/admissionAllowed:false다. 모든 domain row set·private object/provider artifact·slot/fence/final tail·target proof·loader postcondition·pre-event erasure 발견·운영 PG17 호환성은 미완료다. C 완료·전체 복원 가능·운영 admission 증거로 사용하지 않는다.

## 전역 처리 차단과 복원 재개 연결 설계 · 2026-10-07

Root가 readonly 설계 `/private/tmp/wm-s22-global-admission-design-20261007.md`를 읽고 최종 SHA `1a6dba82fb6bab3b736b4fedff38bd953a27ba26f9e3ddad6319ccb11208ac23`를 확인했다. 현재076 generation UUID와 app true만으로 전역 CLOSED·복사된 이전 DB의 처리 재개를 막을 수 없다. Global shared/exclusive lock은 lifecycle77206→tenant0보다 먼저, 신규 처리 거절은 기존 성공 receipt 조회 뒤여야 한다. Retained read/export/delete/cancel/동의 철회·cleanup은 유지한다. 기존 create의 generation-before-receipt 부활 차단 순서는 따로 보존한다. 직접 Pool URL/thumbnail worker 및 retrieval cache/index 쓰기도 별도 통합이 필요하다.

Complete row sets·불변 private object·owner loader·final fenced tail·독립 target/witness가 없으면 reopen을 허용하지 않는다. DB 외부 monotonic authority 및 target별 credential/network binding·processing lease drain이 필요하며, DB commit 뒤 외부 activation CAS는 별도 단계다. DB만 ADMITTED이고 외부 PENDING이면 계속 처리 거절한다. SQL boolean/GUC·새 UUID·같은 호스트 관측을 외부 최신성으로 승격하지 않는다. 전체 설계 수용 행렬은 NOT_EXECUTED이며 운영 authority/provisioner는 아직 없다.

REASSIGN 뒤 사건 정책의42501을 피하는 기존066 `retarget_definer_policies()` maintenance가 이미 있다. 새 owner의 기존 재지정·table/function ownership/grants pin을 검증하고 정책을 임의 확장하지 않는다. 이 설계로 SQL100을 수정하지 않으며 새 migration 번호는 기존 private budget101/settings102 후보와 충돌을 root가 직렬화한 뒤 확정한다. Default CLOSED primitive의 별도 actual PG 준비를 native agent에 배정했지만 정식 설치·전체 runtime 연결·reopen 검증으로 표시하지 않는다. C는 in_progress다.

## 등록할 복원 마이그레이션 번호와 CLOSED 제어 준비 · 2026-10-07

Root는 정식 registry101에 `101_restore_processing_closed_control.sql`을 등록했다. 전역 두 정수 advisory namespace `(77210,1)`을 이 제어에 예약하며, CLOSED-only 상태·bigint 문자열 revision·target nonce/incarnation·immutable exact close receipt를 제공한다. 정상 `grantOperations`는 migration101이 있을 때 lock/read/require 함수만 runtime에 허용한다. owner close/assert 및 제어/receipt 테이블은 runtime에 허용하지 않는다. 기존 Database.tenant 및 writer/provider/outbox 경로는 아직 연결하지 않았으므로 전역 처리 차단 완료를 뜻하지 않는다. global shared/exclusive는 lifecycle77206/tenant0보다 먼저 취득해야 한다.

후속 번호는102 owner family loader,103 AI budget,104 AI settings로 배정한다. 기존 private budget101/settings102 draft와 과거 입력 hash·결과는 보존하고, 후속 정식 source를 별도로 작성한다. candidate100 inventory의 positive fixture는 migrate(...,100)을 명시해 schema101의 수용 증거로 세지 않는다. 기존 SQL100 bytes는 변경하지 않았다.

Private owner family v3의 별도 실제 PG source19/19와 boundary regression31/31 보고·입력331개·cleanup을 root가 확인했다. 당시 입력 중 migrate.ts만 이번 registry101 등록으로 달라졌으며, 나머지330개는 frozen SHA와 일치한다. PG58653 stop0/status3/isready2 및 실제 base/socket 부재를 확인했다. SQL SHA `e5cab380a6cfc22c265eebd9f8596f913d395232fd42347ee325f2e6ee1ba095`, `/private/tmp/wm-s22-ownerloadv3-acceptance-20261007.md`. 이 결과는 private synthetic trust probe이며 정식102 설치·독립 source proof·전체 account restore·admission의 성공 증거가 아니다. 정식102는 전역 CLOSED의 exact revision/nonce/incarnation에 결합하고 새 입력으로 실제 검증해야 한다.

Root의 schema100 명시 pin 변경 회귀는 실제 PostgreSQL **13/13, skip0**로 통과했다(`/private/tmp/wm-schema100-pin-after101-root-20261007.log`). 후보100·원본 migration100·정상 grant를 유지한 historical 시험이다. 초기 persistence typecheck는 병렬 작업 중 미export 계약 import TS2724로 실패했고 담당 agent가 수정 중이므로 아직 최종 typecheck 통과를 기록하지 않는다.

정식101 정상 upgrade001–100→101·checksum101개와 정상 grantOperations/grantResources/grantNutritionCore의 실제 PostgreSQL 수용 **13/13, skip0**를 root가 코드·로그·frozen 입력4개와 대조했다(`/private/tmp/wm-registered-admission-pg-20261007-run1.log`). PUBLIC/runtime 직접 DML·owner 명령 거절, 성공 receipt 조회 보존과 새 처리 CLOSED 거절, bool/GUC reopen 거절, exact close/CAS/retry/rollback/bigint overflow/missing control, 실제 양방향 pg_locks(global→77206→tenant0), REASSIGN·기존 retarget·이전 owner 거절을 포함한다. source/tests의 남은 reader factory·전체 writer 연결·외부 authority·reopen은 미구현이다.

Root 최종 persistence typecheck exit0(`/private/tmp/wm-processing101-root-ts-20261007.log`), migrate.ts 및 담당 두 파일 ESLint·Prettier/diff check exit0. 초기 병렬 계약 import 오류와 담당 unused-import lint 실패는 보존한다. 시험 cluster stop·private parent 제거 및 현재 해당 prefix 디렉터리0을 확인했다. 정식101 설치는 로컬 실제 fixture이며 운영 적용·처리 재개·C 완료·phase 승인과 구분한다.

## 정식102 signed family loader·same-transaction tail 수용 · 2026-10-07

Root는 `102_restore_app_family_loader.sql`을 정식 등록했다. Private v3와 별도로 descriptor purpose=owner_restore_app_family, global exact controlRevision(bigint)/nonce/incarnation/currentgeneration을 검증하고 globalexclusive→target metadata→lifecycle77206→tenant0 순서를 유지한다. 별도 target metadata는 CLOSED-only schema/local-state pin이며 전역 처리 권한이 아니다. 기존 SQL100 runtime capture 분기는 유지하고 owner staged branch에만 원본 불변 bindings/approval receipt를 삽입한다. runtime에 새 loader schema/function grant는 없다. 정상 core 배포의 consent/plan/receipt/outbox DML을 public grantCorePlanning으로 모았고 plan_snapshot/history는 SELECT+INSERT만 허용한다.

새 signed artifact boundary는 purpose·source key/version·source100/target102·owner·schema/proof/control/target/count/digest를 independently supplied expected tuple과 비교한다. HMAC canonical bytes·bounded parser·strict original SQL columns·parent lineage/history/receipt witness·WeakMap opaque handle을 검사한다. Stage adapter는 caller plain liveowner transaction을 요구하며 autocommit·foreign scope·erased/missing account·stale generation/control을 거절한다. HMAC canonical row digest와 실제 SQL typed JSONB row/tuple/inventory digest는 별도로 검증한다. BEGIN/COMMIT·admission/reopen을 수행하지 않으며 caller가 family와 인증한 app tail을 같은 transaction으로 묶는다.

Root 실제 정식 config 3파일 combined **68/68, skip0 = 암호/parser unit29 + 실제 PG39(101 역사13,102 최소SQL8,102 공개producer family18)** 통과(`/private/tmp/wm-root-loader102-combined-20261007.log`). normal101→102 checksum·공개 grant helpers/NOSUPER/NOBYPASS source producer/worker·training approval family와 integrated4domain family의 exact original rows·receipt/history/5bindings, sameTx app1→false2→true3에서 binding1 보존·기존성공 receipt replay·새key stale 거절, family후 및 tail후 SQL22012 rollback을 확인했다. global 양방향 pg_locks, 실제 REASSIGN OWNED→기존retarget→새owner family+tail 성공/rollback·oldowner42501도 확인했다. 새로운 회차 입력6개 SHA를 root가 대조했고 자체 cluster 종료·parent0을 확인했다.

정식102 SQL SHA `9676c73c0e0e514cfb05166e00633363c642a3ac4b1b8faa0dd6305353d22ca5`, signed source `66e94fd77c66b7e8fa1f6b39fa04068a27ee7bb5d7050b6ca9b86a909bcaaf94`, stage `7101d91f9a3bad2e32c99452144b178bfb6dbd8f150a83ec4c9aa6f8a36ee397`. Root consumer TS·관련6파일 ESLint exit0와 scoped format을 별도 확인한다. 101 positive fixture는 registry102 이후 migrate(...,101)을 명시해 역사 수용 범위를 유지한다.

초기102 family 회차 run1=9pass/6fail(fixture timezone·존재하지 않는 binding revision 조회), run2=10/5(actual SQL100 run/candidate/integrated binding에 없는 created_at을 새 validator가 요구), run3=12/5(수정 전 shared UUID/text parameter inference)를 보존했다. 원본 timestamp를 만들거나 정상 schema를 완화하지 않았다. 새 validator의 잘못된 created_at3키를 제거하고 실제 column roster 회귀를 추가했으며 stage의 erasure parameter만 explicit text cast로 수정했다. run4의17과run5의18 및 stage r4의37은 각 입력/수용 범위가 다르므로 과거 private50이나 다른 source hash 결과로 합산하지 않는다.

이 시험의 source signer/nonce/schema/proof는 합성 independently supplied 입력이다. 전체 account baseline/consent baseline/private receipts·outbox·HK/resources/AI budget tail 및 파일·독립 provisioner/witness·processing checkpoint/외부 authority/모든writer 연결·reopen/운영 복원은 아직 미구현 또는 미수용이다. 현재 admissionAllowed:false, complete:false이며 C는 in_progress다. Phase 전체 gate·독립 검토·main 병합·운영 적용 증거가 아니다.

## Target102 registry 검사와 정식103 예산 회계 준비 · 2026-10-07

Signed family stage는 global CLOSED exact revision/nonce/incarnation·generation 검사 다음 actual max(schema_migrations.version)이 독립 입력 targetSchemaVersion102와 같은지 검사한다. 이후 target이면 metadata/row staging 전에 APP_FAMILY_TARGET_SCHEMA_MISMATCH로 거절한다. Agent normal registry102 시험38/38(unit29 + actual PG9)은 기존37과 구분한다. 신규 metadata103 삽입 negative는 실제103 설치 증거가 아니다. 정식103 등록 뒤 기존 loader102 시험은 migrate(...,102)를 명시해 historical target 수용을 유지하며 latest103 loader 호환성을 주장하지 않는다.

새 `103_global_openai_budget.sql`을 normal registry에 등록했다. 원본 private budget101 v3 bytes·역사 증거는 보존한다. FX/가격 정의·기본 disabled activation·Seoul 월5만원 합산 counter·reservation·append journal은 owner-only FORCE RLS다. worker grant는 reserve/begin/settle EXECUTE뿐이다. 새 reservation/dispatch는 정식101 CLOSED gate에서 거절되며 기존 terminal accounting receipt replay와 retained liability settlement는 가능하다. 처리가 재개됐다는 뜻은 아니다. 실제 vendor 가격·FX·키는 seed하지 않았다.

Database transaction은 timeout/search_path 설정 뒤 global shared (77210,1)을 lifecycle/tenant/domain lock 전에 획득한다. native lock은 historical schema93에도 사용 가능하지만 processing permission은 아니다. critical owner-role 거절 roster에 control/budget table을 추가했다. 세 budget SQL entry도 global-first이며 plain function-owner와 여섯 table owner 일치를 검사한다. account erase는 기존 wrapper의 direct grantee ACL까지 제거한 뒤 global-first wrapper에서 athlete/run 연결만 scrub하고 금액·journal을 환급하지 않는다.

Typed v2 port는 strict flat replay/settlement DTO, tx-injected reserve/begin/settle, request/output digest 비교를 제공한다. completeFreshness는 아직 실제 production full-manifest comparator가 아닌 same-transaction injection seam이다. begin 결과는 caller의 confirmed COMMIT 전에 HTTP 허가로 사용할 수 없다. provider/network 호출은 없다.

Agent actual103 수용17/17(skip0)은 actual PG16 + DTO unit1이다. 정상 fresh001→103/upgrade102→103 checksum, CLOSED 새처리 거절·zero newhold/journal, retained receipt/unknown full debit/release 제한·rollback·counter 보존·foreign 거절, erase/no refund/inner privilege 거절, actual pg_locks 양방향 및 owner REASSIGN/retarget를 검증했다. 로그 `/private/tmp/wm-registered-global-budget-pg-20261007-run1.log`.

Root 현재 source의 네 시험 파일 combined86/86(skip0): crypto/parser29 + budget DTO1 + actual PG56. 로그 `/private/tmp/wm-root-budget103-combined-20261007.log`; 전용 socket cluster는 stopped/removed. 이전 root loader 회귀69/69는 별도 로그 `/private/tmp/wm-root-loader102-after103-allowed-20261007.log`로 보존한다. 최초 sandbox initdb 공유 메모리 거절(exit1)도 `/private/tmp/wm-root-loader102-after103-20261007.log`에 남는다. 최초 format exit1은 Database query format만 수정했다. 병렬104 test 준비 파일의 아직 없는 import/helper로 consumer TS exit2가 발생해 그 준비 파일은 bytes/hash를 보존하여 private tmp 대기로 옮겼으며 실패 로그를 보존한다. 최종 consumer TS/lint/format 결과는 아래에서 별도로 기록한다.

전체 source103 inventory·authenticated baseline/full budget tail·외부 monotonic witness·generation ACK·processing reopening·production same-tx freshness·실제 usage/price/FX/키/provider 시험은 미완료다. 기존 coverage minimum93과 schema100 candidate를 latest103 complete proof로 승격하지 않는다. C status는 in_progress이고 admissionAllowed:false/CLOSED를 유지한다. phase 검토/main 병합은 수행하지 않았다.

최종 current persistence consumer TS·7개 TS 파일 ESLint·변경 파일 Prettier·git diff check는 exit0이다. 로그는 `/private/tmp/wm-budget103-root-ts-clean-20261007.log`, `wm-budget103-root-lint-clean-20261007.log`, `wm-budget103-root-format-clean-20261007.log`이며, 문서 format 최초 실패도 보존했다. Full phase gates와 독립 phase review는 이 회차의 범위가 아니다.

## 정식104 AI 제공자·모델 설정 저장/API·삭제 연결 · 2026-10-07

`104_ai_settings.sql`과 기존 RAG 준비 DTO/repository를 현재 phase source에 호환 통합했다. Catalog definition/history는 불변·live plainowner publication·FORCE RLS이며 runtime은 nonsecret catalog를 읽고 개인 선택을 tenant CAS/receipt로 저장한다. Private head/history와 receipt의 deferred exact request/result 검사를 유지했다. Absent default는 null, comparison은 off이며 추천을 자동 저장하지 않는다. Selectable but unconfigured Sol/Luna를 명시 저장할 수 있지만 provider/동의/코칭 job을 생성하지 않는다.

Nonhealth write fence는 native global shared→control target 검사다. Fresh targetNonce/incarnation NULL이면 preference writer가 동의 없이 저장할 수 있고, restore target pin이 있으면 새 저장/publication을 차단한다. 이는 health processing admission이 아니다. 기존 조회/catalog/성공 receipt replay는 보존하며 새 write의 CLOSED error는 public UNAVAILABLE로 sanitize한다. SQL/direct publication에는 원래 literal을 유지한다. 새 table-owner는 runtime Database factory에서 거절된다. 104 erase는 최신103 wrapper를 위임해 head/history/receipt를 삭제하고 global catalog와 budget hold/journal을 환급하지 않는다. Rename된 inner 함수의 기존 direct ACL도 제거했다.

Configured API는 실제 repository/service를 주입하며 기존 authenticated `/bff/v1` plugin 아래 catalog/settings GET와 settings PUT을 등록했다. Principal ownership·session/CSRF·strict query/body/header·16KiB·no-store·409/422/503을 사용한다. 설정에는 key/price/endpoint/athlete override를 받지 않는다. Deployment bootstrap feature grant 목록에 grantAiSettings만 추가했으며 서버에서 실행하지 않았다. syntax check exit0은 배포 증거가 아니다.

Agent 실제 PG settings12/12와 삭제7/7, 실제 repository+Fastify inject API7/7은 각각 분리된 로그/격리 cluster의 결과다. Cookie/bearer 인증은 명시 synthetic fixture이며 실제 OIDC가 아니다. 103→104 upgrade의 기존 erase EXECUTE가 renamed inner에서 사라지는지, scrub 실패의 전체 rollback과 owner REASSIGN/retarget도 실제 PG로 검증했다. Root 현재7파일 combined112/112(skip0)=crypto/parser29+budget DTO1+actual PG82, `/private/tmp/wm-root-settings104-api-combined-20261007.log`; 이전6파일105 결과도 보존한다. 자체 socket cluster는 stopped/removed. Root 계약 시험14/14와 기존 API unit/configured 회귀24/24는 각각 별도이며 actual PG112로 합산하지 않는다. Contract build/TS·persistence/API consumer TS·scoped lint·변경 파일 format/diff exit0. 초기 settings12 회차의 r2 기대 오류(11pass/1fail)는 raw SQL literal을 public UNAVAILABLE로 바꾼 동시 통합에 따라 수정한 fixture이며 기존 로그와 bytes를 보존했다.

SQL104 SHA0df82f1f79487c7ed15d5c0e3f49f197aee2cd1f61c8c8be2e7151bb3015b9c4, repository267921373f68b1ff100e1a4bf9e2afe63d41090cbfde4129e06c0f090bf26356. Root는 source/API 전체 변경과 세 agent 보고·hash·actual cleanup을 직접 대조했다. 기존103 positive suite는 migrate(...,103)로 pin해 latest104 설치 증거로 바꾸지 않았다. Signed owner loader의 target102 protocol은 latest104를 지원한다고 주장하지 않는다.

S23 web/mobile 화면 통합·실제 authenticated browser 저장·portable export33·catalog/preferences complete authenticated archive/restore·global inventory/full budget tail/재개·선택 모델의 frozen job binding/전송 동의·실제 provider/가격/FX/key·운영 배포는 미완료다. C in_progress, admissionAllowed:false/CLOSED와 과거 not_executed를 유지한다. Full phase gates/독립 phase review/main 병합/push는 수행하지 않았다.

## 2026-10-07 S23 portable export33 and plain-owner regression follow-up

Export33은 개인 AI 설정 head와 immutable revision의 명시된 열만 추가하며 기존2–32 artifact를 그대로 읽는다. Catalog·global budget·키·권한·명령 receipt를 내보내지 않는다. grantOperations는 설치104 확인 후 두 개인 table의 SELECT만 부여한다. 저장·실행 허가나 restore admission으로 간주하지 않는다. Shape spread로 새 schema의 TypeScript Extend 깊이 오류를 해결했으며 strict field/runtime validation을 유지했다. Root 계약 회귀32/32, contracts build/TS·persistence/API consumer TS·scoped lint exit0. Agent 실제 PG export8/8(skip0), 이전7/7 로그 별도 보존. 실제1001행/8MiB 거절·audit rollback, 삭제된 catalog 모델의 개인 과거 선택 보존, AI/app 철회 후 retained export와 foreign isolation을 확인했다.

Root는 기존 super-owned latest104 설치에서 operations15 중 삭제7개가 OPENAI_BUDGET_OWNER_REQUIRED로 실패함을 실제 재현했다(`/private/tmp/wm-root-legacy-super-probe-20261007.log`); 보호 조건을 완화하지 않는다. Plain latest104 선설치 뒤 기존 consumer6파일 회귀는89pass/5fail/9skip 및 app-binding suite setup failure였다(`/private/tmp/wm-root-export33-plain-20261007.log`). 실패는 legacy fixture의 owner maintenance 연결 및 migration100 기대값이다. 이 회차는 통과가 아니며 기존 로그를 보존한다. 일반 migration owner와 관리자 검사 port를 분리하고 historical28→latest fixture를 별도 DB에서 유지하는 harness/fixture 수정·재검증 중이다. 운영 서버·실제 provider·브라우저 수용 증거는 이 결과에 포함되지 않는다.

위 실패를 수정한 최종 plain-owner consumer 회차는 실제 PG **6파일103/103, fail0/skip0**다(`/private/tmp/wm-export33-regression-pg-20261007-run1.log`). Source-derived purge와 binding maintenance의 제한된 owner 연결만 일반 migration owner URL로 바꾸고 관리자 fixture/검사는 유지했다. 최신 app-binding export fixture는104 설치/104개 checksum 기대값을 명시했다. Root가 실제 로그·최종 diff·source SHA를 대조했으며 보호 trigger/SQL bypass는 추가하지 않았다. 초기 실패/skip 회차는 별도로 보존한다. Harness normal foundation13/13과 historical URL upgrade1/1+normal foundation/operations28/28, 별도 routing046→047/latest erase2/2는 서로 별도 회차다. Identity harness의 plain owner 설치 문법은 통과했지만 실제 identity/browser는 미실행이고 TS는 기존 oidc-provider declaration 누락과 동일하게 실패했다. Full integration/phase gate 및 운영 archive/restore 수용을 이 집중 검증으로 대체하지 않는다.

Root 최종 normal 전체 통합 runner는 **실패**했다: historical URL upgrade1/1 이후 본153파일62fail/90pass/1skip, 테스트336fail/1099pass/16skip, exit1(`/private/tmp/wm-c-plainowner-full-integration-20261007.log`). 실제 cluster는 stopped/전용 tmp 제거되었다. 주된 오류272개는 APP_CONSENT_REQUIRED이며 기존 fixture의 명시 app 허가 누락 여부를 조사 중이다. 그 밖에 export30 기대값과 최신33 producer 불일치, pinned historical migration 뒤 race_event 누락, 일부 자체 DB privileged owner/불변 maintenance 문제가 남아 있다. 제품 동의/owner 보호를 완화하거나 실패·skip을 통과로 변경하지 않는다. 집중 검증이 완료된 export33/owner harness 변경을 phase commit으로 기록하되 C는 in_progress이고 full phase review/main 조건은 충족하지 않는다.

Full runner의 historical race_event setup 오류는 grantOperations가98 이전 schema에서 새 race table SELECT를 무조건 부여한 문제였다. 설치98 확인 조건으로 권한 부여를 제한했으며 최신 grant 내용은 동일하다. 별도8 historical upgrade 파일 최종 실제 PG12/12(skip0), `/private/tmp/wm-root-historical-grants-20261007-r3.log`. 첫 회차10pass/2fail, 두번째11pass/1fail도 보존한다. CheckIn의 명시 합성 app head는 해당 positive historical fixture의 owner tenant transaction에서만 준비하고 신규 runtime 권한은 추가하지 않았다. Course revocation fixture는 latest migration 후 새 공개 erase wrapper의 grant helper를 다시 적용한다. 원래 backfill 금지·FORCE RLS·기존 이력 검증은 유지한다.

별도 watched refs/Garmin/tenant purge ownDB upgrade3파일은 일반 소유자로 설치·최신 six budget table 소유자를 확인하고 실제 삭제를 수행해 최종7/7(skip0) 통과했다(`/private/tmp/wm-plainowner-three-actual-r2-20261007.log`). 관리자는 계속 synthetic seed/검사를 담당한다. 역사 checksum/body/ACL 수용을 유지했으며 production SQL 보호는 바꾸지 않았다. Root가 report·source diff·exact migration helper SHA와 실행 로그를 대조했다. 모든 해당 cluster stopped/removed. 전체336 실패 결과를 이19개의 별도 통과로 덮어쓰지 않으며 나머지 legacy app consent/export/owner fixture 수정은 병렬 진행 중이다.

## 2026-10-07 export33 consumer assertions and erasure-chain fixture alignment

개인 AI 설정 portable export33의 저장 원본 투영·수용은 위 실제8/8와 consumer103/103으로 확인됐다. 과거 'portable export33 미완료' 표기는104 최초 통합 시점의 상태이며 현재 남은 gate는 authenticated archive/restore, 실제 S23 화면 저장/선택 모델의 frozen job·전송 동의 연결, 전체 phase·운영·provider 수용이다.

최신 exporter를 호출하는 추가13파일의 producer version 기대값/좁히기를33으로 맞췄으며 기존 artifact2–32를 변경하지 않았다. 최신 app binding fixture는 registry104와 실제100 파일 ID를 함께 확인한다. Course sharing의 protected 유지 작업은 실제 plain owner·tenant·global shared lock으로 수행하고 admin 검사와 runtime 권한은 유지했다. 단일 Activity positive scenario만 synthetic app consent를 명시 준비한다. 삭제 chain104/103/100/98 prefix와 원래059–048 suffix, live plain owner·inner EXECUTE 금지·103 global→delegate→budget scrub 및 원래 lifecycle→command→DELETE 순서 검증을 유지했다.

최종 실제 PG13파일155/155, fail0/skip0(`/private/tmp/wm-export33-drift-pg-20261007-run3.log`), persistence/API TS·변경 lint/format/diff exit0. 이전154/1 두 회차(권한 없는 consent repo 호출, 과거 chain 파서)도 별도 보존한다. Root가 최종 source diff·SHA·실제 로그와 cleanup을 대조했다. 생산 SQL/보호 조건·실제 제공자는 바꾸거나 호출하지 않았다. 다른 fixture의 명시 app consent와 owner 작업은 별도 검증 중이며 전체 통합의 기존 실패를 이 집중 통과로 대체하지 않는다.

## 2026-10-07 protected maintenance and synthetic collection fixture regression

HealthKit historical receipt v1/v2 owner seed·nutrition/recovery restore-generation rotation만 실제 plain owner 연결로 이동했다. Admin 검사와 기존 runtime 거절·unknown receipt·idempotency/generation/rollback 수용은 유지한다. 실제 PG3파일19/19(skip0), `/private/tmp/wm-owner-maintenance-actual-r2-20261007.log`; 첫18/1 회차도 보존한다. 역할은 live restore_generation table owner·non-super/non-bypass를 실제 확인했고 source SQL/정책은 변경하지 않았다.

별도 PG3파일31/31(skip0), `/private/tmp/wm-c-bounded-fixtures-pg-20261007-run1.log`: Garmin scripted collector의 양성 import fixture3개만 명시 합성 app head를 준비해 개별 provider 동의와 구분했다. 공식 Garmin/실환경 호출 증거가 아니다. Purge 권한 함수의 정확한10개 roster에서099의 renamed implementation 식별자를 갱신하고 owner/ACL 조건을 유지했다. Suppression event FK child096/099 두 개를 정확하게 확인하며 불완전 TRUNCATE의 FK 거절과 전체 FK roster/CASCADE에서 실제 immutable guard 거절을 별도 검증했다. Constraint/trigger bypass를 사용하지 않았다.

Root는 두 실제 로그·source diff·SHA·cleanup과 집중 TS/lint/format을 확인했다. 최신 export 소비자·owner maintenance의 이 집중 수용은 이전 전체1099pass/336fail/16skip을 대체하지 않는다. Plain-owner window의 행 읽기 bound는 실제 원인/성능 조사 중이며 작은 통과 기준으로 바꾸지 않는다.

## 2026-10-07 explicit synthetic app purpose and legacy owner fixture alignment

31파일의 positive Plan/Activity/CheckIn/dialogue/constraint fixture에 실제 named synthetic athlete의 app=true/revision1을 명시 준비했다. 공유 harness의 자동 허가가 아니다. Global shared77210→tenant0 lock을 먼저 잡고 fresh erasure/consent 상태를 확인한 뒤 INSERT하며 기존 false/revision은 덮어쓰지 않고 erased tenant는 생성하지 않는다. 기존 원장 trigger는 실행된다. Anonymous foreign actor는 명시 허가된 foreign tenant로 바꿔 원래 소유권404 검증에 도달한다. Runtime missing/withdrawn gate나 개별 AI/HealthKit/가민 허가는 바꾸지 않았다.

보호된 routing/course/thumbnail 유지 작업만 실제 migration owner/tenant 연결을 사용하고 admin 검사·runtime deny를 유지했다. 내부 권한 검사는 기존 하드코딩된 admin 대신 실제 relowner만 제외하므로 다른 non-owner 권한은 계속 거절한다. 최신 export producer 기대값만33으로 정렬하고 실제 과거 artifact는 보존했다. Root가31개 frozen SHA를 모두 직접 대조하고 source diff·보고/실제 로그를 확인했다.

최종 실제 PG104 baseline: 별도 historical URL1/1 이후 선택354시험 **352pass/2fail/skip0**, `/private/tmp/wm-c-fixture-final-bounded-20261007.log`. 남은 두 실패는 activity tracks699행·course thumbnails599행 읽기(기준≤1)이고 기존 assertion을 유지한다. 이는 전체1451 수용이 아니다. 명시 app/owner/export/foreign 오류는 해소됐지만 행 읽기 수용은 완료되지 않았다. 초기 object scope 동시성의 immutable app revision collision은 fixture absence snapshot 전에 lock0을 잡지 않은 문제였다; canonical lock 순서를 맞춘 최종 회차는 collision0이고 이전 실패 로그를 보존한다. TS/API TS/lint/format exit0·9개 실제 cluster stopped/removed. Whole phase/main readiness는 주장하지 않는다.

별도 격리 EXPLAIN 실험에서 tenant-leading index는 직접 쿼리를 개선했지만 실제 security-definer cached/generic 함수의93행 scan 및 worker50개 요청/150행 방문을 해결하지 못했다. Index-only 변경을105에 등록하거나 exactN 통과로 처리하지 않았다. 실제 함수와 캐시 재사용에 대한 bounded query 수정 실험을 계속한다. C in_progress/운영·제공자·restore의 기존 미실행 조건은 유지한다.

## 2026-10-07 canonical105 tenant reconciliation bounds

104의 plain-owner FORCE RLS 함수는 global storage index의 foreign rows를 필터링해 작은 요청에서도 많은 행을 읽었다. Tenant-leading partial index만 추가한 실험은 실제 cached 함수의93행/worker50요청150행을 해결하지 못했다. 새105는 원래 global index·RLS·owner/ACL·public tenant wrapper·정렬·1..1000 cap·backoff를 보존하고, 두 namespace의 private 후보/window 함수에서 captured tenant와 bound scalar parameters를 사용한 constant SQL을 호출별로 계획한다. search_path와 seq/bitmap planner preferences는 함수 내부에만 적용하며 반환 후 복원된다. 과거 bypass-owner global branch를 보존하며 새로운 privileged runtime grant는 없다. SQL105 SHA256 `f92c41eaacf0aada2dafca672473fd030d38827df77873bb8ab2615d740864af`.

정식105 기존5파일 실제PG14 최종116/116(skip0), 별도 historical URL1/1; 첫115/1 실패도 보존한다(`/private/tmp/wm-c-canonical105-bounds-20261007.log`, `wm-c-canonical105-bounds-r2-20261007.log`). Thumbnail cap 시험은 tenant transaction 종료 후 admin query에서 tenant 없이 최소1을 기대했다. 동일 plain owner/tenant transaction 안에서 cap을 검증하도록 수정했으며 absent tenant의0건 동작은 유지한다. 기존 두 transaction-counter 시험은 PL/pgSQL nested query의0 통계를 물리 scan 증거로 부르지 않도록 제목·설명을 바로잡고 assertions는 유지했다.

신규 `reconcile-tenant-bounds.integration.test.ts`는 정상104→105 migration의 이전 checksum/owner/ACL/FORCE RLS, restricted worker/direct-table/PUBLIC42501, absence/foreign/null cursor/clamp, caller tenant/planner GUC 복원을 실제 확인한다. Disposable instrumentation admin이 auto_explain만 준비한 뒤 session authorization을 plain non-super/non-bypass owner/worker로 바꿔 nested 실행을 측정한다. Namespace별 private helper7회 반복의 scan 합계7·foreign filtered0, worker N1/2/10/50의 실제 scan 합계1/2/10/50를 검사한다. pg_stat0은 증거로 쓰지 않는다. 최종7/7(skip0), `/private/tmp/wm-canonical105-new-test-20261007-r2.log`; test SHA256 `1231575e0c40011e26bf9b12f2cb4cae136bad6332ea01c0025509af92266b30`. 초기 lint/TS 오류와 수정 회차는 보존한다. PG17과 운영 실행은 NOT_EXECUTED이며 auto_explain 확장이 없는 환경의 실행 제한을 숨기지 않는다.

기존153파일 전체 실제PG105 회차는 URL1/1 이후 **1445pass/2fail/4skip**, exit1(`/private/tmp/wm-c-canonical105-full-20261007.log`). 두 실패는 최신105를 설치하면서 settings의104개 registry와 historical039 upgrade의 교체된 후보 함수 proconfig를 과거 값으로 기대한 것이다. Registry 전체 checksum 비교와105의 정확한 local proconfig 기대값을 반영한 별도2파일15/15(skip0), URL1/1 통과(`/private/tmp/wm-c-canonical105-consumers-20261007.log`). 전체 회차를 통과로 덮어쓰지 않으며 병렬 작성 중이던 신규7개는 전체 실행에서 제외됐다. Root는 최종 diff·source SHA·실제 로그·disposable cluster stop/remove를 확인했다. Persistence TS·변경 ESLint/format/diff 검증을 통과했다. C는 in_progress이며 full phase gates·identity/browser·운영 archive/restore·provider·독립 phase review/main 수용은 남아 있다.

## 2026-10-07 AI execution selection 순수 경계 준비

설정 선택의 후속 코칭 연결을 위해 `coaching-execution-selection.ts`의 strict unknown 입력·bounded adapter registry·canonical catalog digest·immutable 선택 draft를 준비했다. 현재 catalog/recipient/purpose/가격·adapter/tokenizer version 및 app/AI permission revision/digest 변화는 거절하며 기존 frozen job을 새 preference로 자동 교체하지 않는다. 추천값은 저장값이 아니며 unconfigured·revoked 모델은 실행 draft로 허용하지 않는다. 합성 비교는 synthetic_only 분류가 필요하다. **모든 ready/blocked 결과는 admissionAllowed:false**이며 실제 실행 권한을 주지 않는다.

Root는 source/계약/테스트 diff와 frozen SHA를 직접 확인하고 단위12/12를 재실행했다. 함께 identity private context sweep 회귀11/11을 실행하여 총2파일23/23,skip0(`/private/tmp/wm-execution-selection-root-20261007.log`). Agent coaching TS·lint·format exit0, 초기 실패는 `/private/tmp/wm-execution-selection-report-20261007.md`에 보존한다. Source SHA256 `e102d3376980b78aaba8a33edbb86dfd7f4cb18f6732644f6e1e920707c8c65f`, test `b634fb2bce809d7a9b8a0a89172104e7a8db43c142a88528713cb064aa830dd3`.

Registry 및 합성 availability/classification은 caller facts이며 실제 OpenAI API model/pricing·환율·key·건강자료 분류 증거가 아니다. DB frozen job 저장·full freshness manifest·budget reservation·실제 dispatcher는 미연결/NOT_EXECUTED다. C와 실제 제공자 코칭 작업의 완료를 선언하지 않는다.
