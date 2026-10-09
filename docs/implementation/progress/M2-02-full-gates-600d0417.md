# M2-02 전체 검증 갱신 · 2026-10-09

검증 대상 HEAD는 `600d04179e753f64ada31501802a15b137eb9920`이다. main은 `1d55735865c827f3870e6fa4b2effd418ed63677`이며 독립 phase review와 병합은 미완료다. 보호된 EXT-HOSTING WIP는 이번 기록에 포함하지 않는다.

## 전체 정적·단위 검증

Node 24.12.0, pnpm 10.34.5에서 frozen/offline install, generated check, lint, typecheck, build, format을 실제 실행해 여섯 명령 모두 exit 0을 확인했다. 결과 SHA-256: `a7d565c670a03f46c2decab77a5034fb12bb722c524cb401dab28d577eb2f252`.

빌드 이후 전체 단위 시험 R9는 588개 파일, 9,509 통과·5 skip·실패 0/9,514 등록, exit 0이다. 소스·런타임·별도 geo 입력의 전후 drift는 0이다. 결과 SHA-256: `0594457a2b2395f4699e6d4b7ca87c5da6d6e9920bc4ed4cbc1c6f1c0446f4f5`. 기존 실패·skip을 소급 변경하지 않는다.

## 전체 normal PostgreSQL 17.6 · FAILED

새 소유 Docker tmpfs 클러스터에서 원 `pnpm test:integration`과 원 config/시간 제한/등록 roster를 실행했다. 업그레이드 선행은 1/1 통과다. 일반 모음은 304개 파일 중 297 통과·4 실패·3 skip이며, 시험은 **3,063 통과·7 실패·14 skip/3,084 등록**이다. 실제 terminal exit 1, 소요 약 36.9분이다. 입력 1,093개 전후 불변과 normal registry 107·FORCE RLS 확인은 전체 시험 성공을 뜻하지 않는다.

실패 위치는 `manual-pooled-dense-application`, `restore-check-in-exact-replay`, `restore-gallery-media-exact-replay`, `restore-resource-exact-replay` 네 파일이다. stack 위치 수를 실패 case 수로 세지 않는다. 현재 유한 오류 기록만으로 timeout·시계 정밀도 등 원인을 확정하지 않는다. 네 원본 전체 파일의 실제 진단과 근거에 따른 수정 후 전체 모음 갱신이 필요하다.

시험 뒤 DB 1·역할 17·slot 0이었다. 역할 잔존을 0으로 기록하지 않는다. 정확한 소유 container만 제거했고 정체를 모르는 역할을 개별 삭제하지 않았다. finite-terminal SHA-256 `25a295f74765e3127b23bff897b6b9a017f7845617a10a1a5ecc17ac13ded765`, lifecycle SHA-256 `14a5816dd8d3be782d45d959cea168f2475ea3bd24363e4d2b8e00ea79a76e4d`. 원본 오류/SQL/개인 자료는 보존하지 않고 스트림 해시·유한 결과만 기록했다.

## 별도 로컬 PostgreSQL 17.11 계약 검증

원 harness/config로 logical 1/1, pgoutput 24/24, foundation 13/13을 실제 확인했다. 세 실행 모두 입력 불변·exit 0·소유 scratch 정리 및 잔존 0이다. 이는 별도 계약 범위이며 위 17.6 전체 normal 실패를 해결하지 않는다.

logical 첫 v3 실행에서는 시험 1/1이 통과했지만 Node/tsx 캐시 두 디렉터리 잔존으로 wrapper exit 1이었다. 원 기록과 scratch는 보존한다. v4는 컴파일 캐시만 비활성화했고 시험·timeout·동작을 변경하지 않았다. 이 후속 성공을 첫 wrapper 실패의 삭제로 취급하지 않는다.

## 남은 gate

현재 whole normal은 failed이며 whole identity 두 회차, 독립 phase review, main 통합은 미완료다. 운영 백업·복원·HTTPS와 provider 수용도 별도다. 사용자 결정대로 모든 구현 후 실제 제품 앱으로 최종 iPhone 시험을 진행하며 미실행 기기 행은 not_executed로 유지한다.

## 네 원본 파일 실제 후속 진단

고정된 원본 소스/시간 제한으로 새 PostgreSQL 17.6에서 네 실패 파일 전체를 실행했다. **24/24 통과·실패/skip 0**, 네 module 전부 관측, 실제 exit 0, 약 122초였다. 유한 reporter SHA-256 `cb16df8fb90418b08916efb9b8744acd596ec23738e09e4a580c3b71f53e066b`. 소스 입력 전후 불변과 DB 1·역할 1·slot 0, pool 종료·정확 소유 container 제거를 확인했다.

이 실행에는 canonical preinstall/upgrade와 나머지 300파일의 선행 상태가 없다. 전체 모음 실패를 해결하거나 시계/timeout을 원인으로 확정하지 않는다. allowlisted dense 이벤트 1,030개에서 query error는 관측되지 않았으며 일부 workflow 약 41.7초·review 약 41.2초였다. 좁은 성공에 맞춰 guard·timeout·SQL·fixture를 변경하지 않는다. 원 전체 모음 재실행과 유한 관측을 통해 차이를 조사한다.

## 전체 normal 후속 v6 · FAILED

동일 원 `pnpm test:integration`과 등록 roster·config·시간 제한으로 새 소유 PostgreSQL 17.6 클러스터에서 실제 재실행했다. 업그레이드 1/1 통과 후 일반 모음은 **300파일 통과·1파일 실패·3파일 skip**, **3,069통과·1실패·14skip/3,084등록**이었다. 약 34.6분, terminal exit 1이다. 실패 위치는 `global-openai-budget.integration.test.ts:693:5`의 REASSIGN/retarget 시험이며 원인은 아직 확정하지 않는다. 이전 v5의 네 파일 실패와 별도 24/24 좁은 진단 성공은 그대로 보존한다.

소스 1,093개 freeze SHA `3ac2e0d5e2a0510446acdc6a9a434c5c7511974d5b33511664cb573998fa0497`는 전후 동일했다. normal registry 107/FORCE RLS 확인, 시험 뒤 역할 17·DB 1·slot 0, pool 종료와 정확 소유 container 제거를 확인했다. 원 오류 메시지·SQL·payload는 저장하지 않았고 유한 결과와 스트림 SHA만 보존했다. finite-terminal SHA `82f678a1c48062cb7d6f1511d04424bafc3fc95116cecb00d0063889e3110364`, lifecycle SHA `115ddd9df067c46f39b939ce389a57f3f032715caaf7cc23aa739e803c44e9ab`. 두 스트림은 drain 완료이며 dense/restore/timeout allowlisted marker는 0이다. 해당 marker 부재가 원인 부재나 실패 해결을 증명하지 않는다. 전체 normal·identity 두 회차·독립 phase review/main·운영/최종 제품 실기기 gate는 여전히 미완료다.

## 원본 budget 17개 시험 실제 좁은 진단

동일 1,093개 입력을 고정한 새 소유 PostgreSQL 17.6에서 `global-openai-budget.integration.test.ts`의 **17개 전체**를 원 config/시간 제한으로 실행했다. **17/17, 실패/skip 0, exit 0**이며 unhandled 0, 단일 모듈을 관측했다. 소스 전후 동일, pool 종료·정확 소유 container 제거와 poststate 역할 1·DB 1·slot 0을 확인했다. finite reporter SHA `1cdc5981fbc2262afa340672f64ad14d80848c016ab49d6012e71d5d57e8bb6a`, terminal SHA `a9be16386719a4727755b54d47a8fcdf14199f51dfbf2847aea2e15568b5969a`, lifecycle SHA `cabbc00a61da13b7bc6aed1265bcd475814e7d6ece2179953bffd3ad7c6cbf85`.

이 시험에는 전체 normal의 선행 300개 파일·canonical 설치/upgrade 상태가 없다. 좁은 성공은 v6의 REASSIGN 실패를 해결하지 않으며 SQLSTATE·원인과 full normal 성공은 미확정이다. 전체 실패 원인을 관측하기 위한 유한 stage/elapsed/code 증거를 준비한다. 제품 권한·시간 제한을 완화하지 않는다.

## 소유권 이전 유한 관측 추가 및 실제 검증

원 17개 case와 68개 query 표현, SQL/grant/단언/시간 제한/기존 finally 동작을 유지하고 REASSIGN 및 REVOKE의 terminal stage·outcome·elapsed와 허용 SQLSTATE/name만 기록하는 test-only 관측을 추가했다. 원 오류 객체는 그대로 throw하며 logging 오류가 SQL 결과를 바꾸지 않는다. raw message/role ID/query/payload는 출력하지 않는다. Root가 diff와 원 fixture 단독 변경을 확인했고 scoped persistence TypeScript·lint·format은 실제 exit 0이다.

갱신 source freeze1,093개 SHA `ba67c301a4bc9207a48840dc230b87aa3506fba5895c65ea439cf4295a59ad97`에서 같은 17개 원본 시험을 새 PG17.6으로 다시 실행해 **17/17, 실패/skip0, exit0**을 확인했다. 실제 terminal 관측은 REASSIGN 성공36ms·REVOKE 성공0ms이며 오류 SQLSTATE를 제조하지 않았다. source 전후 동일, post역할1/DB1/slot0·pool종료·소유container제거, unhandled/관측overflow0이었다. finite reporter SHA `4292c4d7943d5bda8fa2b7778aea4dba1306f0d690a5493ec38689bb7176eb6e`, terminal SHA `7d535378a0f656275fb3d04a47f3959f8ea79224bf3bd5dfc9fccb3db45e4610`, lifecycle SHA `9b198dfb089583072e21553ac3c9c01902c65687d0fd4a9fa2f3aa52e10991a8`.

전체 normal v7은 동일 관측 projector를 원 default reporter stream에 연결하여 다음 실행을 준비했다. 이 준비와 두 좁은 17/17 결과는 v6의 whole 실패를 해결하지 않는다. full normal·identity x2·phase 독립 검토/main은 여전히 미완료다.

## 전체 normal 후속 v7 · FAILED

원 normal registry107·config·시간 제한을 유지한 새 소유 PostgreSQL17.6의 전체 실행은 terminal exit1이었다. 업그레이드1/1 통과, 일반 모음300파일 통과·1파일 실패·3파일 skip, 3,069통과·1실패·14skip/3,084등록이며 elapsed2,088,597.879417ms였다. 실패 위치는 `course-share-revoke-exact-replay.integration.test.ts:49:20` 및 `:337:5`, 허용된 marker는 `RESTORE_REPLAY_INVALID_ENTRY`다. 원인은 아직 확정하지 않는다. 이전 v5/v6 실패와 좁은 진단 결과는 보존한다.

고정 소스1,093개 SHA `ba67c301a4bc9207a48840dc230b87aa3506fba5895c65ea439cf4295a59ad97`는 전후 동일했다. normalregistry107/FORCE RLS 확인, poststate 역할17·DB1·slot0, pool종료·정확 소유container제거를 확인했다. stdout/stderr 모두 drain 완료이며 원 오류 메시지·SQL·payload는 저장하지 않았다. finite-terminal SHA `13cc593e99b6640d651f1d023823bc4cb310ba1e0ffd7042c38362bd7102dc7b`, lifecycle SHA `d0a0e696714c021a07d86fb45157ae70a5a6a71bfcc98e692286f61dc417a27c`다. whole normal·최신 identity 두 회차·phase 독립 검토/main·운영 및 최종 제품 실기기 수용은 미완료다.

## course-share 시계 의존 제거 및 미래 시각 거절

먼저 원 fixture5개를 변경 없이 새 소유 PG17.6에서 실행해5/5·skip0·exit0을 확인했다. source1,093개 전후동일, post역할1/DB1/slot0·pool종료·소유container제거였다. finite reporter SHA `02d784347927faee30a5e7abba78c3c58a732b38abe5d2b3805be0e147b6d0d2`, terminal SHA `714b48c060311a1b74460f44bf5a9477a726b7a560f38390bb2fb5a1e2f7b55f`, lifecycle SHA `2dbc4cb8092a4e24cd20a65a7975ea092b0da92e81c4604cb628f591eb45e80c`다. 원 v7 failure의 정확 OR 분기·호스트/DB 시계차는 여전히 미확정이다.

양성 exact-erasure fixture는 호스트 `new Date()` 대신 동일 DB `clock_timestamp()`를 사용하도록 고쳤다. 이 시험은 호스트 시계 동기화를 검증하는 시험이 아니며 기존 liveShare도 DB 시각을 사용한다. 원5case 단언은 보존했다. 새6번째case는 DB 시각+1시간 입력을 실제 거절하고 account/course/share 보존·erasure/event/receipt 부재·상태 동일성 및 이후 정상 revoke/retry를 확인한다. 제품SQL·권한·시간 제한·오류 guard는 변경하지 않았다.

갱신 fixture SHA `aed03bb672c2779f0a1fee287c640b65b687531cbfec730889cbc3dc46cf349a`와 원1,093개의 새freeze SHA `9fc74fdf6e2ceb197843e3baa2b689b40c566b50811b1e82dac106b5cb15c496`에서 실제 원파일전체6/6·skip0·unhandled0·exit0,1,793.421375ms였다. 이전freeze와 비교해 변경입력은 정확 fixture한파일이며 sourceproof333/asset은 불변이다. 최종 persistence TS·scoped lint/format exit0이다. source전후동일·post역할1/DB1/slot0·pool종료·소유container제거도 확인했다. finite reporter SHA `9e8e805af6ce56c2db2393bc00007ed40280a82c70d4af2b03990853564f31f9`, terminal SHA `4b6cf65754a4532d716020f7e97cb03f402e97b85feb626aece53d53af020f3e`, lifecycle SHA `d33f7da001ce9204ab6e0bfa7078f333b3d0e9782e537d9faf76cf074a711298`다.

이 좁은 검증은 전체 normal v7 실패를 passed로 변경하지 않는다. 갱신입력 whole normal·최신 identity 두 회차·fullphase·독립검토/main·운영/최종실기기 수용은 별도다.

## 전체 normal 후속 v8 · FAILED

동일 normal registry107/config/시간 제한과 freeze1,093개 SHA `9fc74fdf6e2ceb197843e3baa2b689b40c566b50811b1e82dac106b5cb15c496`의 실제 전체 실행은 terminal exit1이었다. upgrade1/1, 일반300파일 통과·1실패·3skip, 3,070통과·1실패·14skip/3,085등록, error1이다. elapsed2,155,832.279125ms, 실행 구간은2026-10-09 06:28:57.003Z~07:04:52.841Z다. 실패 위치는 `race-source-deletion.integration.test.ts:665:24`, `:45:20`, `:662:5`, marker는 `RESTORE_REPLAY_INVALID_ENTRY`이며 정확 내부 OR 분기는 미관측이다. 이전 course-share 실패와 좁은6/6을 보존한다.

source 전후동일·normal registry107/FORCE RLS 확인, poststate 역할17/DB1/slot0·pool종료·소유container제거·stdout/stderr drain 완료를 확인했다. artifact `/private/tmp/wm-fullnormal176-v8-9d25ac3b-d5ef-47c5-a115-79c2e0b91135`, finite-terminal SHA `e31384ec213817d4d193b20ed37b3a1ccfc1191c7938ad6adb5a2cb77f9e30dc`, lifecycle SHA `b249f503aaf3513627f6b40759e31ab4ba3bebe59f7cf9937733c33a1e994927`다. handle72423은 terminal이며 다시 poll하거나 timeout 재시작 대상으로 취급하지 않는다. 최신 whole/identity×2·fullphase·독립review/main은 미완료다.
