# M2-01k-v-d · S22 영양·회복·운동·루틴 처리 gate

상태: completed (이 노드의 core 저장 경로). 전체 S22/phase 수용은 미완료.

영양 plan/intake, 회복 strategy/action, supplementary execution/set, stretching actual, routine schedule processing·승인·run시작·선택·step 기록을 app gate에 연결한다. 성공 replay와 기존 privacy/restore 검사 순서를 유지한다. pure pause/stop/end/cancel와 timer suspension/finish/clear는 새 actual/report가 없으면 철회 후 허용하고 start/resume은 gate한다. recordStep stopped는 새 progress/reason/actualRefs 저장이므로 gate한다.

독립 food/exercise/method/template/blueprint catalog 저작은 핵심 계획·실제기록·대화 허가로 자동 확대하지 않는다. 기존 owner fixture는 tenant isolation 증거가 아니므로 신규 restricted runtime role 실제 PostgreSQL matrix로 별도 검증한다. 아래 scoped 실제 PG 수용을 실행했다.

## 실제 구현·검증 · 2026-10-06

Production5 repository, 기존 nutrition/supplementary fixture2와 새 actuals-app-admission.integration.test.ts를 변경했다. 명령 성공 receipt와 기존 삭제/restore/source 검사 뒤 app gate를 실행한다. routine helper는 core_processing/catalog/retained_lifecycle을 명시한다. Root는 최종 diff·정책 분류·락/receipt 순서와 보고된8파일 SHA256 일치를 대조했다.

- actual disposable PG14 restricted runtime role: **3files/92passed**, cleanup0. 신규76은 absent/false 46개·성공과 철회 후 replay22개·catalog/기존 조회/delete/pure lifecycle/RLS 및 IntakeEntry create와 routine.recordStep(stopped)의 실제 양방향 revoke/write 경쟁이다. 기존 nutrition8/supplementary8도 통과했다.
- persistence src/tests typecheck·owned8 ESLint/Prettier exit0, Root diffcheck0.
- 로그 `/private/tmp/wm-s22-v-d-pg-final.log`, `/private/tmp/wm-s22-v-d-{typecheck-final,lint-final,format-final}.log`, hashes `/private/tmp/wm-s22-v-d-hashes.txt`; actualPG harness `/private/tmp/wm-s22-v-d-postgres.mjs`.
- 초기 pg/-r2/-r3 로그의 fixture reassessment/digest/중복 Activity 연결/기대 상태 오류와 owner grant 누락은 보존했다. 생산 규약과 기존 assertions를 약화하지 않고 수정한 실제 최종 결과가92pass다.

## 남은 통합

소유권 밖 recovery/stretching/routine 기존 suite의 명시 consent fixture·권한 보완과 전체 consumer/phase 회귀는 후속 통합이다. 대회 actual 원장은 별도 phase 구현 중이므로 공통 baseline에 합류할 때 app admission 경계를 추가 검증해야 한다. AI versioned basis/worker/provider/UI는 v-c/v-e/v-f 범위다. 제품 API/browser/native·운영 배포·전체 V2-F31 통과를 주장하지 않는다. phase 독립 검토 전 main 병합하지 않는다.

## 기존 suite 호환 fixture 확인 (2026-10-06)

recovery-core·stretching·routine-core의 실제 처리 tenant fixture에 명시적인 합성 app grant를 추가했다. 다른 tenant의 읽기와 catalog-only 동작은 그대로이며 production 자동 동의는 없다. recovery runtime에는 consent SELECT만 추가했다. 기존 assertion을 유지한 실제 일회용 PG14 **3파일 11시험 통과**, 첫 실행 성공·cleanup exit0. persistence typecheck·owned lint·format exit0. Root가 diff와 최종 로그를 확인했다. stretching/routine 기존 owner fixture를 새 restricted-runtime gate 증거로 재분류하지 않는다.

증거: `/private/tmp/wm-s22-v-d-compat-{pg,typecheck,lint,format}.log`, `/private/tmp/wm-s22-v-d-compat-hashes.txt`. 전체 phase gate와 독립 phase 검토는 별도다.
