# M2-01k-v-e · S22 provider 실제 수집·worker app 처리 경계

상태: in_progress — 선행 v-b/v-c 로컬 수용 후 native agent가 수집 경계를 구현한다.

HealthKit/Garmin의 개별 허가와 app 처리 허가를 실제 dispatch/import commit에서 검사; credentials와 disconnect/cancel/cleanup 유지. provider 호환 원장을 추가 상위 gate로 사용하지 않음.

## 실행 범위 · 2026-10-07

Root가 v-c 원본 family→105 수용을 실제 재실행하고 completed 커밋91957912를 확인해 v-e를 시작한다. Native agent 소유는 persistence의 healthkit-ingestion/healthkit-binding/healthkit-activity/garmin-unofficial과 integrations의 garmin/collection 및 관련 scoped tests다. Contracts/migrations/manifests/graph는 Root가 직렬화한다. HealthKit 개별 permission/claim과 exact receipt 보안 의미를 보존하며 delete-only cleanup은 허용하고 새 upsert/mixed 처리에 app gate를 검사한다. Garmin dispatch/lease/collected 신규처리를 검사하고 credential/refresh/disconnect/cleanup은 유지한다. 아직 실제 검증 전이며 completed로 바꾸지 않는다. 실기기·실제 provider·운영 dispatch는 NOT_EXECUTED다.

## 공통 API 오류 경계 통합 · 2026-10-07

Root가 raw repository 경계의 정확 AppConsentRequiredError/AppAdmissionBindingError 클래스만 shared API classifyError에서409로 변환한다. Command wrapper를 거치지 않는 unofficial Garmin 요청도 안전한 동일 공개code를 받는다. 같은 code를 임의 Error에 붙인 입력은500 INTERNAL_ERROR이며 원문 detail은 응답에 노출하지 않는다. Native agent의3 HK route command wrapper와 별도 통합이다.

Root Fastify inject 실제 전체 app.test **23/23·skip0·exit0**(/private/tmp/wm-s22-shared-api-gate-root-r2-20261007.log), scoped ESLint/Prettier/diff exit0. First18pass/5fail은 새 assertion이 기존 error.code envelope를 top-level code로 기대한 오류이며 최초로그를 보존한다. 응답형태 assertion만 맞추고 기존 계약/상태를 바꾸지 않았다. Repository port는 테스트에서 주입한 실패이므로 실제PG/provider/HTTP login 결과로 부르지 않는다. v-e runtime/수집 동시성 검증 및 consumer TS는 병렬 구현 이후 별도 수행한다.
