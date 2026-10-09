# M2-01k-v-a · S22 app 처리 공통 admission 경계

상태: completed — 공통 helper 수용. 기존 업무 caller 차단 전체는 v-b 이후다.

Transaction 전용 lockAppAdmission은 consent 변경과 같은 tenant advisory0을 domain lock과 receipt lookup 전에 확보한다. 성공 receipt 재반환 뒤 requireAppAdmission이 같은 lock을 재확보하고 현재 app 동의 granted true·revision positive int4를 runtime parse한다. 부재/false/invalid는 AppConsentRequiredError APP_CONSENT_REQUIRED로 fail closed다. Root는 public export와 ProductRequestError409 매핑을 통합했다. Database 전체·읽기/export/delete/cancel에 gate를 일괄 적용하지 않는다. generic provider는 호환 기록만 유지한다.

Native agent 실제 restricted-role PostgreSQL14 **8/8 passed**; 최초 sandbox shmget 실패를 보존하고 별도 Unix socket cluster에서 재실행했다. Root가 source/test를 읽고 격리 PG14 **8/8 passed** 재실행, 정상 종료 확인: `/private/tmp/wm-s22-app-admission-root-pg-20261006.log`. absent/false no new artifact/receipt, true revision3, tenant/kind 격리, fixture successful replay/conflict/read/export/delete, grant 후처리, 실제 두 연결 revoke/write 양쪽 순서의 advisory wait를 검증했다.

Root persistence/API 의존 forced typecheck **11/11, cache0**, exit0 `/private/tmp/wm-s22-admission-root-consumers-20261006.log`; 대상 lint0 `/private/tmp/wm-s22-admission-root-lint-20261006.log`. Agent 대상 format0, root diff0. 실제 PG 시험은 명시적인 helper command fixture이며 기존 제품 전체 gate나 실제 API 업무 수용으로 승격하지 않는다. 기존 saved evidence의 app revision을 현재 동의로 자동 업그레이드하지 않으며 v-c의 versioned basis가 별도 필요하다. 전체 phase gate/review/main 병합 전이다.
