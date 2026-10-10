# M2-02 source-build1 등록과 최신 로컬 검증 · 2026-10-10

새 compiler/verifier는 strict bounded manifest와 source/import closure를 검사하며, 이전 V9 asset/pin과 source_drift 거절을 그대로 보존한다. 새 readiness는 실제 catalog 읽기와 COMMIT·정리가 끝난 뒤 source build를 검증한다. profile25 선택은 Root 등록 함수의 고정 import로 결정되며 요청/env로 증거나 fallback을 선택하지 않는다. 개별 command의 admission 검증은 유지한다. configured host·영양 actual HTTP·identity E2E host를 같은 등록 함수로 연결했다.

Root는 전체 source/test 후보와 역사 호환을 읽고 집중136/136 단위 검증을 확인했다. 최종 identity dependency 두줄 변경을 포함해 R5 stage415/current347/runtime340/역사268/entrypoint13/closure185를 독립 대조하고 compiler를 정확1회 실행했다. Asset SHA `b770b9131aa9ba0415ee4f52b1691114263856df219c9b0d610524106c3abf7d`, pin SHA `6b7f4b3ef63148fe5941abe13ed4bd41af44318b5dbfe63e0969df1f955f5718`. 실제 no-args verifier는 verified_build_evidence지만 asset currentFunctionalExecution은 not_executed, configuredWholeExternalAst는 not_verified, authority/restoreAuthority none·approvalAllowed false다. 실제 suite 결과는 별도 증거로 기록하며 역사268을 새 실행으로 바꾸지 않는다.

## 실제 검증

- Full static7: frozen offline install/generated/lint/typecheck/build/format/unit 모두 exit0. Unit601파일·9703통과·5skip·실패0; skip는 통과가 아니다. Source2989 전후동일, jar 동일, build1302→1330 변경을 관측해 PG와 이후 identity용 fresh freeze를 다시 만들었다.
- Actual configured5: 원5개·원시간 제한을 실제 PostgreSQL17.6 normal107/namedV9에서 실행, 5/5통과·skip0·exit0. 초기 성공 cold gate 및 오류/권한 경계의 원 단언 유지.
- Actual nutrition HTTP1: 원1case/90s·setup180s/cleanup30s, 실제 HTTP/CSRF/등록 factory와 DB의 긴 ID·zero/unknown·승인/Intake 보존 단언이 통과, skip0·exit0. 인증만 합성이고 실제 OIDC/proxy 수용이 아니다.
- 두 실제 PG 실행의 source/build/geo 전후동일, DB1/role1/slot0/otherclients0·fixture TMP 잔존0, pool 종료·정확 소유 container 제거를 확인했다. 원 source와 빌드를 시험 중 변경하지 않았다.

- `/private/tmp/wm-source-build1-static-seven-actual-r4-20261010-terminal.json`: SHA `7a271de98aa1f790290f09a2d7866c75d060b1c78138fc02b8a7affb43f10f1c`.
- `/private/tmp/wm-source-build1-configured5-d347ed79-89ee-4285-8b01-c98d41403dbf/finite-command-result.json`: SHA `6f827c3567a2dc00d9ebe5ea617c06643e5ce3890f24c916715d42d687f3b5c2`.
- `/private/tmp/wm-source-build1-nutrition_http1-3f80ff24-fc72-4273-8f93-9dd57a54286f/finite-command-result.json`: SHA `38e7c5c3b54ab1f8ce3ad4d6cde997014a9128d2dccd245d1c4f69478666dfcb`.

## 보존한 실패와 관측 한계

Static 첫 R3는 install exit1·원인 unknown으로 중단했고 이후6명령은 미실행이다. 같은 frozen 소스의 R4 실행만 위 성공이다. PG5 초기 R3는 Docker가 명시 PATH에 없어 ENOENT·실제DB시험0, R4는 unquoted otherClients alias가 실제 otherclients와 달라 시험 전에 중단했다. R4 정리 관측의 containerRemoved false도 원문 유지하고, Root 별도 정확ID inspect로 실제 부재를 확인했다. PATH/field name/No such container 또는 object+empty[] 관측을 고친 R5 실행만 실제5개 성공이다. 시험 단언·시간·scope를 완화하지 않았다. 이전 static/unit/integration/identity 실패·skip와 external 미실행은 모두 보존했다.

전체 integration·canonical identity 두 회차·적용 drill·독립 whole-phase review는 아직 새 source/build에 대해 미완료다. main/push/운영 backup·restore/HTTPS 공개/외부 OIDC/실제 제품 iPhone 수용을 승격하지 않는다. 보호 EXT-HOSTING4줄과 각 stash는 유지한다.

## 2026-10-10 R7 dense 통합 및 실제 전체·좁은 검증

Dense 입력을 invocation마다 bounded plain/strict V3로 한 번 해석해 logical/pooled 형태에 재사용하는 source4·test1을 검증했다. unknown wire 검증·역변환·SQL·권한·원 시간 제한은 유지한다. 순수37/37, persistence typecheck/lint/format exit0, 별도 원 dense8 실제 PG17.6 시험8passed/failed0/skip0이었다. actual `/private/tmp/wm-densediagnostic176-29bf2c15-eec1-4a7b-885e-c7a087e472d5`, finite SHA `6bcdd2b355da12d6c15f2903f16b506e9faef9537791bc7522f6e2544c23670f`; Root 평가 SHA `8065dac29245b4370004915eca89538e2102865f0e73596d50106e85e6e080ff`. first prepare34727ms/public review34187ms는 단일 실행 관측이며 일반 성능 보장은 아니다.

R6 raw asset/pin은 새 역사 archive2에 보존했다. R7 runtime342/history268/closure185/current fixtures10의 새 asset SHA `b202a629313a2823f16d0beccccf0eb96a32b3b5c8ad779c927a12727f696bde`, pin SHA `f5508eb6294b748636511e90093745250cd13824cabfd4143dc470bde59a04a7`. `currentFunctionalExecution:not_executed`, authority/restoreAuthority none, approvalAllowed false는 그대로이며 아래 실제 시험은 별도 증거다.

R7 로컬 static7은 모두 terminal0, unit603파일9719passed/failed0/skip5였다. 첫 install exit1의 원인 unknown 기록은 보존하며 후속 동일 offline install 성공으로 삭제하지 않는다. Root 평가 `/private/tmp/wm-central-r7-static-root-assessment-20261010.json`, SHA `cb32a2605ddd7182606f4f2c74f246e217053b6d0709c11890d7de866088ef53`.

**R7 whole canonical integration은 실패**했다. actual `/private/tmp/wm-source-build1-fullnormalr7-176-d0795906-8e67-4faf-adaf-d1f8324b9143`: upgrade1pass; normal304files 중298pass/3fail/3skip, cases3068pass/4fail/14skip, unhandled1, exit1. 원3파일(check-in/resource exact replay, manual-source personal export)의 실패와 RESTORE 표식은 보존한다. 성공시에만 실행하는 역할 정리가 SUITE_ROLE_CANONICAL_NOT_SUCCESSFUL로 거절됐고 제거 전 roles17/DB1/slot0이었다. 이는 시험 원인으로 단정하지 않는다. source/build4326 전후 동일·poolclose·소유 container 제거는 실제 확인했다. Root 평가 SHA `34eb8ffc2b74bd626338aa2c1b3b56f0f6c985e3d31e7acd658d162a6b85c155`.

같은 원3파일의 후속 좁은 baseline은 실제25cases 중23pass/2fail/skip0였다. manual12와 resource6은 모두 통과했고 check-in7 중 absent233/erasure292가 INVALID_ENTRY로 실패했다. runner의 선언21=실제cases21 가정은 it.each 확장을 누락해 BASELINE_ORIGINAL_21CASES_NOT_OBSERVED를 추가로 발생시켰다. 이 harness 오류와 실제2fail을 분리한다. clock bracket before0..3ms/after-6..0ms만 관측했으며 실패 시각 guard의 원인은 미확정이다. actual `/private/tmp/wm-failedthree176-c013b9f9-8bbc-4877-bfe1-d6c83bc19f10`; Root 평가 SHA `a46697f5575ac53c6ce4efa7ed72933e2e90e4b952446763ebb6c55eebd30c30`. 원본 source 전후동일, 제거 전 roles1/DB1/slot0, poolclose·소유 container 제거를 확인했다. 개인 내보내기 원 broad 실패는 이번에 재현되지 않았다는 의미이며 소급 통과하지 않는다.

HANDOFF의 이전 dense804 위치 설명도 정정한다:804는 원 시험 호출 위치이고 cleanup pending drain은439다. 원 역사 문구는 보존하며 cleanup을804의 원 실패라고 취급하지 않는다. 현재 source에 대한 identity 두 회차·전체 integration 통과·독립 phase review·main 병합은 미완료다. 보호 EXT-HOSTING4줄은 이 작업에 포함하지 않는다. 운영 backup/restore·HTTPS·외부 수용·실제 제품 iPhone·출시 선행조건은 유지한다. 사용자의 주간 잔여량 제한 해제 결정에 따라 로컬 작업을 계속한다.

## 2026-10-10 PostgreSQL 시각 fixture 수정과 좁은 실제 수용

추가 SELECT 진단 actual `/private/tmp/wm-checkin-guard176-db25a450-75c5-4551-ab18-004c603dd003`은 원25 중24pass/1fail(resource erasure)이었다. check-in erasure의 호출 직전 future/guardRejects true를 관측했지만 SELECT 지연 뒤 원 함수는 통과했다. 이 관측은 원 전체 실패의 원인 증명이 아니며 진단이 경합을 가릴 수 있다. Root 평가 SHA `0976522ea79b37b9490f1ffc831caa48547cf3ab172a19dbf58c8497af29bb79`.

두 exact-replay fixture의 생성 시각을 기존 tenant owner의 `clock_timestamp()::text`로 취득하도록 수정했다. JS Date의 밀리초 반올림과 DB 시각 차이를 제거하고 원 microsecond 문자열을 보존한다. 제품 SQL의 future guard·권한·단언·25개 제목·timeout은 변경하지 않았다. manual-source fixture는 그대로다. 후보 source SHA check-in `3a2b7f44f2182d9142c4ddc16d93608d637d58a3c08ffed4963e9177d6683774`, resource `2b1717f0aa8fc2819b3bb992f218cc315ce68f953026c2c515a2e6e6b8cb7b12`.

원 source/build4326을 복사하고 이2파일만 교체한 후보 clone의 실제 PG17.6 원3파일 시험은25passed/failed0/skip0, module/suite error0·unhandled0·exit0이었다. actual `/private/tmp/wm-dbclocktwo176-f1e085d7-655a-403a-bfc5-27769eae5274`, finite SHA `f7653c2361d6f31cd8bde3a6cfc1eb3f9df7d61614960b37f2188d023c382903`, Root 평가 SHA `67570ac2809e714a0312c2d312b3c05553a60857c9ff761be02e68bc27ac043b`. 실행 source/clone 전후동일, post roles1/DB1/slots0, poolclose·정확 소유 container 제거를 확인했다. 독립 신규 install clone은 아니며 고정 원 dependency bytes를 읽기 전용 링크로 사용했다.

이 실제 결과 뒤 정확한 두 fixture를 phase tree에 적용했다. 전체 persistence TS·두 파일 ESLint/Prettier exit0. 적용 후 전체 canonical integration과 identity 두 회차는 아직 미실행이다. 이전 whole4fail/14skip·baseline2fail·진단1fail과 harness의21개 가정 오류를 모두 보존한다. sourceproof의 authority none·admission false, main/운영/실기기 출시 gate는 그대로다.

## DB-clock fixture2 이후 canonical 전체 actual · 2026-10-10

중앙 `6b145056`의 fresh source/build4326 freeze `f824781e09784a5531d414d6d18fad3f640cf56ad5a708162bd7ad514d4102f9`를 Root가 독립 재해시하고 canonical `pnpm test:integration`을 그대로 실행했다. 실제 2026-10-09T19:38:25.560Z→20:12:57.641Z, 2072083.56ms: upgrade 1file/1case passed; normal 304files 중 300passed/1failed/3skipped, 3086cases 중 3071passed/1failed/14skipped, exit1. 원 clock fixture의 이전3파일 실패 위치는 이번 전체 결과에 없으며 새 실패 위치는 `restore-app-family-loader.integration.test.ts:1124:5`의 REASSIGN OWNED 호출이다. 정확 원인은 raw 오류가 보존되지 않아 아직 unknown이며 기존 실패를 통과로 덮어쓰지 않는다.

실제 디렉터리는 `/private/tmp/wm-source-build1-fullnormalr7-176-4940a5dc-66b6-4e57-8a5d-abcf4c30a68a`다. source/build 전후 동일, stream complete, signal null, pool close와 정확 소유 컨테이너 제거를 Root가 확인했다. canonical 실패 때문에 성공 전용 role cleanup은 실행하지 않았다. 삭제 전 roles17/DB1/slots0/otherclients0와 `SUITE_ROLE_CANONICAL_NOT_SUCCESSFUL` 및 secondary `POSTSTATE_NOT_CLEAN`을 그대로 보존한다. 전체 컨테이너 제거가 실제 시험 실패나 성공 전용 정리 실패를 통과로 바꾸지 않는다. Root 평가 SHA `3f46a31beebffa42591b0fcca312858b98827c335c482d6051d87d13924bc5a8`.

다음은 원 실패 파일의 실제 ownedPG baseline과 유한 오류 진단이다. 원 SQL·단언·timeout·권한을 완화하지 않는다. identity 새 두 회차·phase 독립 검토·main·운영 수용은 아직 미완료다. 이 기록 이후 문서가 변경되므로 후속 source/build freeze는 새로 수집한다.

### 원 restore-family18 focused baseline · 2026-10-10

전체 normal3071pass/1fail/14skip의 REASSIGN 위치 실패 원인을 구분하기 위해 원 restore-app-family-loader 파일18개를 그대로 별도 PostgreSQL17.6에 실행했다. 원 SQL·roles·assertions·개별 timeout을 변경하지 않았다. 실제18passed/0failed/0skip·terminal0이며 module/case/unhandled 오류0이다. pre/post roles1/DB1/slots0/otherclients0, source/build 입력 전후 동일, pool 종료 및 정확 소유 컨테이너 제거를 확인했다.

실제 `/private/tmp/wm-restorefamily176-4b115ae1-3eec-4fa0-bbf1-b3686360fb92`, finite reporter SHA `3d5323de895d3c24512d1bbf05a14a42aef62d7dd1c0c6d7f5df35016f5ee718`, 새 source2996/build1330 전체4326 입력 freeze SHA `3262076b404b1d0f4359c1beff4e700f357916a7e0905b9e45f52cc296926e49`다. Root가 전체 입력 SHA를 별도 대조해 mismatch0을 확인했다. 원 fixture SHA `b05d20d86e1c7ab0d29cb5b23af5f20898524abbd6ec7565ea1bf561ad7d08a8`와 원18 제목 allowlist를 유지했다.

이 focused 성공은 전체 실패 원인이나 수정 완료 증거가 아니다. 원 canonical failure와 성공 시만 허용되는 role cleanup 거절 기록은 보존한다. 전체 실행의 유한 SQLSTATE/timeout 관측을 보완한 별도 진단 준비를 계속한다. 전체 gate·독립 phase 검토·운영 복원/출시 및 identity x2는 이 결과로 통과시키지 않는다.

## Whole normal finite diagnostic r2 · 실제 FAILED 보존

실제 `/private/tmp/wm-wholenormal-finite176-6de1a720-a599-4581-b98e-296e64f0d2c3`는 2026-10-09T20:36:57.468Z→21:11:27.679Z, 2070199.924958ms 후 exit1이었다. default 요약은 upgrade1passed, normal301filespassed/3skipped·3072casespassed/14skipped였으나 `finite-normal-reporter.json`이 없었다. 따라서 이 결과는 전체 gate 통과가 아니다. source/build4326 전후 동일, pool 종료·child group 부재·정확 소유 container 제거를 확인했다. 성공 전용 역할 정리는 실행하지 않았고 제거 전 roles17/DB1/slots0/otherclients0 및 SUITE_ROLE_CANONICAL_NOT_SUCCESSFUL/POSTSTATE_NOT_CLEAN을 보존한다.

Root 평가 `/private/tmp/wm-whole-normal-diagnostic-r2-root-actual-assessment-20261010.json` SHA `43ef772e13b24a81a287ebdac321f6ff744a60d7aeb5c59f2e16a2244de54f84`. 원 harness의 args.includes(upgradeFile)는 normal --exclude 값도 upgrade로 오분류한다. 별도 TMP r3 pure17/17은 원 argv의 이 오분류와 unchanged reporter의 REPORTER_UPGRADE_SCOPE_REJECTED를 재현했다. 실제 discard된 오류 본문을 복원했다고 주장하지 않는다. r3는 exact argv selector만 수정하며 원 SQL·assertions·timeout·roster·cleanup을 유지한다. 이 reporter 진단은 literal canonical pnpm test:integration, identity×2, 전체 phase 검토를 대체하지 않는다. 과거 REASSIGN 실패의 정확 원인 unknown과 원 실패 이력도 유지한다.

### 2026-10-10 whole diagnostic r3 실패 · Handoff

원 reporter/SQL/assertions/timeouts를 보존하고 normal exclude argv의 upgrade 오판만 새 selector로 수정했다. Root pure17/17 후 current `58601cb7` source/build4326의 actual r3는 upgrade1pass, normal3070pass/2fail/14skip·exit1이었다. selected restore-family 원18은 passed지만 전체 gate가 아니다. global-openai-budget(SQLSTATE42501)과 restore-resource-share-exact-replay(P0001)의 raw cause는 unknown이다. original literal canonical과 identityx2/phase 통과는 아직 없다.

actual `/private/tmp/wm-wholenormal-finite176-e9fc8282-a36e-4f29-a311-429123af5fe8`; normal finite SHA `a4986ec1294debadac815701a748595613d596869524f634c206e5b728c7594c`, lifecycle SHA `a1a212922be7d9e01e61ed4d3e5dc5f07a66a23138de5f91ddbe2dfd2bbe636a`, Root 평가 SHA `dc9ed0bfdd107e7bd9bfd841ad1fa73d1393b4495124bfae49c984e024b9328b`. source 동일·poolclose·childgroupabsent·정확 ownedcontainer 제거를 확인했다. 실패로 성공전용 rolecleanup이 실행되지 않아 post17roles/1DB/0slots/0clients 및 POSTSTATE_NOT_CLEAN을 별도 보존한다. 사용자 현재작업 마무리 지시로 추가진단/후속DB는 실행하지 않고 HANDOFF의 정확 queue에 남겼다.

### 2026-10-10 r3 실패2 원인 재현 · fixture 수정

Handoff 큐1을 재개했다. r3 실패 title SHA 2개는 각각 `REASSIGN and existing retarget preserve live-owner accounting while old owner loses mutation access`와 `owner-only standalone resource share revocation replay > accepts retry after later resource deletion and exact tenant erasure`에 정확히 일치한다.

- global-openai-budget 42501: `REASSIGN OWNED`는 `pg_shdepend`의 물리 순서(ctid)대로 객체를 넘긴다. 다른 suite의 drop/vacuum으로 앞 페이지가 비면 함수 항목이 그 schema·database 항목보다 앞에 놓이고, 아직 해당 schema(`public`은 database 소유 전) CREATE가 없는 next로의 소유 변경이 `permission denied for schema`가 된다. 로컬 PG17.11 scratch 최소재현에서 순차 배치는 성공, churn 배치(함수 ctid (0,1) < database (22,14))는 42501이었다. 원 HEAD 시험 파일을 동시 churn loop 아래 6회 실행해 5회 실패·분류 `schema_privilege_denied`, 1회 통과를 관측했다. focused 단독 통과·whole 간헐 실패 이력과 일치한다.
- 수정(사용자 결정: plain owner 사전 GRANT): REASSIGN 직전 같은 old owner client가 소유 schema와 `public`에 next CREATE를 부여하고, REASSIGN 뒤 `public`의 잔여 grant를 REVOKE한다. preflight 관측·REASSIGN 주체·retarget·old owner 거부 단언·timeout은 그대로다. 같은 churn 아래 수정본 8/8 실행 모두 17/17 통과.
- restore-resource-share-exact-replay P0001: erasure 호출이 호스트 `new Date()`를 넘겨 제품 guard `$3>clock_timestamp()`(079)에 container 시계 차이로 걸린다(`RESTORE_REPLAY_INVALID_ENTRY`). 이전 DB-clock fixture 수정에서 빠진 호출이다. 인자를 DB `clock_timestamp()`로 바꿨고 제품 SQL guard는 그대로다. focused 7/7 통과. container-host 시계 차이는 docker exec 25회 표본에서 [-6.4, +49.0]ms로 음수 구간을 배제하지 못했다.
- 정적: 변경2 prettier/eslint exit0, persistence tsc exit0. scratch cluster·socket 제거.

이 결과는 whole/canonical gate가 아니다. 같은 REASSIGN 순서 의존이 다른 plain-owner REASSIGN 시험(restore-app-family-loader 과거 실패 포함)과 운영 runbook의 비superuser REASSIGN에도 잠재한다는 점은 미검증이다. `restore-gallery-media-exact-replay`의 `occurredAt: new Date()`도 같은 guard 노출 여부를 미확인이다. 다음은 fresh source/build freeze 후 literal canonical `pnpm test:integration`과 identity×2다.

### 2026-10-10 fresh freeze canonical r9 · 부하 중 실패

중앙 `b6647b9e`의 fresh source2996/build1330 freeze SHA `da63a57f69d1869d170e73cecc51549d29ce27fb23c96f2a40fb521e3b00bd47`(독립 재해시 mismatch0)로 r7 runner의 freeze 경로·SHA·출력 경로 3줄만 바꾼 successor를 만들어 literal `pnpm test:integration`을 실행했다. 실제 2026-10-09T23:32:03Z→2026-10-10T00:21:18Z(약 49분), upgrade 1/1 passed, normal 296files passed/5failed/3skipped, 3061passed/11failed/14skipped, exit1. 직전 수정한 global-openai-budget·restore-resource-share-exact-replay는 실패 목록에 없다. container 제거 확인, 실패로 성공 전용 정리는 미실행(POSTSTATE_NOT_CLEAN). 출력 `/private/tmp/wm-canonical-r9-fullnormal-176-68b64129-f06b-4303-b848-390c63d60fd3`.

이 실행은 병렬 native agent 5개(브라우저 build·GraphHopper·여러 PG)와 겹쳤고 dense 관측에 publicstore 3007ms·ack 2010ms·applicationprepare 5010ms query 오류와 test_timeout 표식이 있다. 실패 5파일(course-sharing, generic-recovery-export, manual-pooled-dense-application, restore-current-source-catalog, restore-gallery-media-exact-replay)은 부하가 없는 상태에서 focused 재실행 시 모두 통과(4파일 26/26, course-sharing harness owner 절차 39/39)했다. 단, restore-gallery-media-exact-replay:220의 `RESTORE_GALLERY_INVALID_ENTRY`는 부하가 아닌 호스트 `new Date()`와 082 guard `$4>clock_timestamp()`의 시계 결함이므로 DB 시계로 수정했다(`4bf0230e`, focused 3회 3/3). 나머지 4파일 실패는 부하 의심이며 원인 확정이 아니다. canonical gate는 미통과이며 조용한 기기에서 fresh freeze로 재실행한다.

### 2026-10-10 static7 · 중앙 `1b9a25b2`

중앙 `1b9a25b2`에서 install/generated/lint/typecheck/build/format/unit을 순서대로 실제 실행했다: install·generated·lint(35s)·typecheck(81s)·build(53s)·format(40s) exit0. 최초 unit은 exit1(603파일 중 2 실패: garmin-unofficial-worker가 worktree `.venv` python 부재로 setup 실패, race-manual-review-source-inventory-v2 1건이 병렬 agent 부하 중 5s timeout)이었다. 이전 static gate와 같은 조건(`WORKOUT_PYTHON`=main `.venv` python)으로 재실행한 unit r2는 **603파일 · 9719 passed · 5 skipped · exit0**이다. 최초 실패는 보존하며 skip은 통과가 아니다. 로그 `/private/tmp/wm-static7-1b9a25b2-20261010/`.

### 2026-10-10 canonical r10 · publication 순서 의존

중앙 `d18c97d8` fresh freeze source3001/build1330 SHA `f9b35326bb5d25de187661580715429e32013942a5a0ffd0028e440487acb8ff`(재해시 일치)로 부하 없는 상태에서 literal canonical을 실행했다. 2026-10-10T02:31:48Z→03:07:50Z, upgrade 1/1, normal 300files passed/1failed/3skipped, **3071 passed/1 failed/14 skipped**, exit1. 유일한 실패는 global-openai-budget의 REASSIGN 문장(905:28)이며 runner는 오류 본문을 보존하지 않는다. 출력 `/private/tmp/wm-canonical-r10-fullnormal-176-e634f0ee-28e7-48fa-a6dd-15de25e03c30`.

원인 후보를 source로 좁혔다: normal 경로의 078은 old owner 소유 publication을 만들고, PG17 publication 소유 변경은 새 owner의 database CREATE를 요구한다. scratch PG17.11에서 publication 항목 ctid(0,1)이 database 항목(22,9)보다 앞선 배치는 `permission denied for database`(42501)였고, 같은 배치에 next database CREATE를 부여하면 성공했으며 database 이전 후 ACL은 `nb=CTc/nb`로 합쳐져 별도 잔여 grant가 없었다. 이전 수정의 schema CREATE에 database CREATE 부여를 추가했고 churn 동시 10회 17/17 통과. 같은 plain-owner REASSIGN을 하는 restore-app-family-loader(과거 r7 실패 위치 1124)와 ai-settings-operations에도 같은 사전 GRANT·public REVOKE를 적용해 churn 동시 4회 25/25 통과했다. superuser 연결로 REASSIGN하는 5개 시험은 해당 검사가 없어 변경하지 않았다. 이 r10 실패의 실제 SQLSTATE는 관측되지 않았으므로 원인은 재현 기반 추정이다.

### 2026-10-10 canonical r11 통과 · identity 1회차 current-manual 기동 실패

중앙 `45e9137e` fresh freeze source3001/build1330 SHA `c171580f8ba83eea87d825ae815e8d9d45bdfd84f1e098752a8a942f773f5f13`(재해시 일치)의 literal canonical `pnpm test:integration`이 2026-10-10T03:12:41Z→03:46:46Z에 **upgrade 1/1, normal 301files passed/3skipped, 3072 passed/14 skipped/0 failed, exit0**으로 끝났다. post roles1/DB1/slots0/clients0, 소유 container 제거, cleanupFailure null. 출력 `/private/tmp/wm-canonical-r11-fullnormal-176-6a017f0c-653f-4b3f-a259-f09f58f030c8`. skip은 통과가 아니다.

같은 HEAD의 identity r8 도구로 list(358등록·129파일, source/geo 전후 동일)→postbuild manifest `173716e4…`→owned 17.6 provision→canonical full을 실행했다. 1회차 general 320 passed/11 skipped, app-consent 4, ai-settings-lifecycle 1 뒤 current-manual이 `webserver_startup`으로 0건 실행·exit1, 2회차 미실행, accepted false. 사후 owned PG는 DB0·고정 role5(`workout_owner/runtime/coaching_worker/garmin_worker/course_thumbnail_worker`)이고 해당 role의 shared dependency·membership·설정은 0이었다. 같은 환경에서 current-manual harness만 기동하면 `IDENTITY_DISPOSABLE_PG_RESOURCE_COLLISION`이 재현됐다. 즉 앞 suite의 harness 정리가 `DROP DATABASE … WITH (FORCE)` 뒤 role DROP 전에 끝나지 못했다. 이전 기록(M2-02-branch-state)의 원인 미확정 current-manual 기동 실패와 같은 표식이다. Playwright `gracefulShutdown` 10s 후 강제 종료가 이 창에 떨어진다는 것은 추정이며 직접 관측하지 못했다. lifecycle `--cleanup`은 `ACTOR_CLEANUP_INCOMPLETE`로 거절했으므로(설계대로) owned 기록의 containerId·이름·label 일치를 확인한 뒤 진단(잔여 role 제거 후 AI suite 단독: role 정리 정상, spec1 실패는 환경 차이로 판정 제외)을 마치고 그 container만 제거했다. 수정: identity harness webServer의 gracefulShutdown을 60s로 늘렸다(정리 query는 기존 statement 10s 상한). 새 HEAD에서 fresh identity×2로 검증한다.

### 2026-10-10 pool error 수정·proof r8 · phase gate 통과(`9a62d989`)

identity current-manual 간헐 기동 실패의 원인을 native agent가 재현으로 확정했다: harness 정리의 `DROP DATABASE … WITH (FORCE)`가 끊은 idle backend의 `57P01`이 'error' listener 없는 장수 pg Pool에서 unhandled로 프로세스를 종료시켜, DB drop 뒤 role drop 전에 정리가 끊기고 고정 role 5개가 남아 다음 suite가 `IDENTITY_DISPOSABLE_PG_RESOURCE_COLLISION`으로 거부됐다(격리 race 수정 전 4/100→후 0/100, 실제 AI suite 1/20→0/30). 앞선 gracefulShutdown 가설은 원인이 아니었다. 사용자 결정으로 5개 pool(database/identity/garmin/course-thumbnails/course-sharing)에 listener를 추가하고, source-build proof 고정 `database.ts` 때문에 proof를 재컴파일했다(R7 stage 사본에서 database.ts만 교체, manifest `ae5fa068…`, asset `8f2e9c44…`, 이전 asset/pin은 `r7-20261010` 보존; 차이는 manifest SHA 2개와 database.ts SHA 1개). 외부 도구는 asset/pin literal만 바꾼 successor(static-seven-r8 SHA `1e5c71e3…`: R6→R8 승인 delta 5개, R7 archive 결속)를 썼다.

`9a62d989` 실제 결과: static7 install/generated/lint/typecheck/build/format exit0, unit 603파일 9719 passed/5 skipped. canonical r12(freeze `e7d4b44c…`)는 3069 passed/3 failed(모두 manual-pooled-dense-application, `applicationbegin` 5016ms statement 5s 초과와 그 의존 시험)로 exit1이었고 동시에 읽기 전용 native agent 3개가 실행 중이었다. 조용한 상태의 canonical r13(같은 freeze)은 **upgrade 1/1, normal 301 passed/3 skipped, 3072 passed/14 skipped/0 failed, exit0**, post 정리 정상. identity×2(seed `e5f46157…`, postbuild `69d9f8a7…`)는 두 회차 모두 accepted: general 320/11 skip, app-consent 4, ai-settings-lifecycle 1, current-manual 22, unexpected/flaky 0, owned container 정상 제거. r12 dense 실패와 기존 dense 성능 한계는 보존하며 skip은 통과가 아니다. 다음은 독립 phase 검토다.
