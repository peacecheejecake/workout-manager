# M2-01k-v-e · S22 provider 실제 수집·worker app 처리 경계

상태: completed — server dispatch/import commit의 app 허가·epoch 검사와 기존 receipt/cleanup 로컬 수용 완료. 실제 provider/device/global admission은 별도 미수용이다.

HealthKit/Garmin의 개별 허가와 app 처리 허가를 실제 dispatch/import commit에서 검사; credentials와 disconnect/cancel/cleanup 유지. provider 호환 원장을 추가 상위 gate로 사용하지 않음.

## 실행 범위 · 2026-10-07

Root가 v-c 원본 family→105 수용을 실제 재실행하고 completed 커밋91957912를 확인해 v-e를 시작한다. Native agent 소유는 persistence의 healthkit-ingestion/healthkit-binding/healthkit-activity/garmin-unofficial과 integrations의 garmin/collection 및 관련 scoped tests다. Contracts/migrations/manifests/graph는 Root가 직렬화한다. HealthKit 개별 permission/claim과 exact receipt 보안 의미를 보존하며 delete-only cleanup은 허용하고 새 upsert/mixed 처리에 app gate를 검사한다. Garmin dispatch/lease/collected 신규처리를 검사하고 credential/refresh/disconnect/cleanup은 유지한다. 아직 실제 검증 전이며 completed로 바꾸지 않는다. 실기기·실제 provider·운영 dispatch는 NOT_EXECUTED다.

## 공통 API 오류 경계 통합 · 2026-10-07

Root가 raw repository 경계의 정확 AppConsentRequiredError/AppAdmissionBindingError 클래스만 shared API classifyError에서409로 변환한다. Command wrapper를 거치지 않는 unofficial Garmin 요청도 안전한 동일 공개code를 받는다. 같은 code를 임의 Error에 붙인 입력은500 INTERNAL_ERROR이며 원문 detail은 응답에 노출하지 않는다. Native agent의3 HK route command wrapper와 별도 통합이다.

Root Fastify inject 실제 전체 app.test **23/23·skip0·exit0**(/private/tmp/wm-s22-shared-api-gate-root-r2-20261007.log), scoped ESLint/Prettier/diff exit0. First18pass/5fail은 새 assertion이 기존 error.code envelope를 top-level code로 기대한 오류이며 최초로그를 보존한다. 응답형태 assertion만 맞추고 기존 계약/상태를 바꾸지 않았다. Repository port는 테스트에서 주입한 실패이므로 실제PG/provider/HTTP login 결과로 부르지 않는다. v-e runtime/수집 동시성 검증 및 consumer TS는 병렬 구현 이후 별도 수행한다.

## 수집 경계 실제 로컬 수용 종료 · 2026-10-07

HealthKit 새 upsert/mixed/bind/create는 기존 exact 성공 receipt 뒤에 app gate를 검사하고 delete-only·HK 보안/철회는 유지한다. Garmin acquire/holds가 현재 app epoch를 고정하고 Root의 ActivityRepository server-only optional execution context가 실제 import 거래의 동일 epoch를 검증한다. Browser DTO/command hash는 바꾸지 않는다. Check→철회/재동의→commit 경쟁에서도 canonical/receipt 쓰기 전에 STALE_APP_ADMISSION으로 거절한다. 이미 성공한 동일 import receipt는 철회 후 원응답을 반환한다. 별도 attribution 거래의 epoch 상실은 run을 cancel하되 이미 committed actual을 재작성하지 않는다. Credentials/refresh/disconnect/finish·configuration/read는 유지하고 generic provider gate는 도입하지 않았다.

최종 plain owner/runtime NOSUPERUSER/NOBYPASSRLS·normal105 PG14 **57/57·skip0·exit0**(신규9+기존48)을 Root가 test/source/log·최종SHA와 대조했다. /private/tmp/wm-v-e-provider-app-acceptance-20261007.md와 wm-v-e-regressions-pg-20261007-r3.log에 실제 잠금 양쪽 commit order·mixed rollback·cleanup·success receipt·epoch race가 기록돼 있다. Activity fixture ACL은 기존 ext-oidc-local/identity configured composition과 같은 좁은 명시권한이며 새 public grant helper로 부르지 않는다. 초기 resolution/sandbox/ACL/기존positivefixture app누락 실패를 보존했다. 자체 private Unix socket PG 중지·directory 제거를 확인했다.

Actor API/persistence/integrations consumer TS·소유lint/format exit0. Root는 HK3/Garmin/API boundary 5파일 **56/56·skip0**을 직접 재실행하고 Root-owned activities.ts lint/format/diff exit0을 확인했다. Root file SHA150cdcfb3ed784955ddce895ddf591fd734ac4ad485e7dd381aaea7fc6846c8b, collection4e0d2060675fcc9cdc22e596df6e7fd3cc1c22d52a4e2af03e581ca4fdf5d260, 새실제PG test770b7fbd954e40678549d239ea2c3d4ce33a96290f43b8d69fe1b23b65b48c0e. Root 단위로그 /private/tmp/wm-v-e-api-root-final-20261007.log.

Graph v-e의 server runtime 로컬 범위는 completed로 전환한다. Raw runtime DML에 새 SQL app enforcement를 추가한 것은 아니며 full global restore/admission·운영dispatch·실제 provider/device·PG17은 미완료/NOT_EXECUTED다. 이 결과는 실제 자동수집/공식Garmin 수용이 아니다. Native allowlist/두Host 목적고지·오류draft·계정수명주기는 다음 v-f에서 수용하고 wholephase gates/독립review/main은 아직 수행하지 않는다.
