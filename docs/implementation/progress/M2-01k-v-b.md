# M2-01k-v-b · S22 계획·대화·직접 actual 처리 gate

상태: completed (이 노드의 직접 저장 경로만). 전체 S22와 phase 검토는 미완료.

## 구현

계획 저장, scenario create/save/apply, manual/import/overlay Activity, check-in create/update, completion write, dialogue create/append, constraint create/update의 14개 명령이 tenant 락과 성공 receipt 검사 뒤 `requireAppAdmission`을 호출한다. Check-in은 tenant0 →77209 락 순서다. 기존 성공 replay는 철회 후에도 원래 결과를 반환하며 새 artifact를 만들지 않는다. 삭제/remove·기존 조회/export는 허용한다. Completion retract는 이유를 저장하는 새 자기보고 revision이므로 새 처리 gate를 적용한다.

Production 7개 repository와 기존 integration fixture 7개, 새 `core-app-admission.integration.test.ts`를 변경했다. 기존 fixture는 tenant-scoped admin CTE로 app grant를 명시하며 production 자동 동의나 기존 assertions 완화는 없다. 해당 API 명령은 기존 product-boundary.command의 APP_CONSENT_REQUIRED 매핑을 사용한다.

## 실제 검증 · 2026-10-06

- disposable PostgreSQL14, restricted runtime role: **8 files /127 passed**, cleanup 성공. 신규48개는 14명령의 absent/withdrawn/성공 replay와 소유권·조회/export/delete·payload conflict·retract·실제 두 연결 revoke/write 경쟁을 확인한다. 기존79개 회귀 통과.
- persistence src/tests typecheck, 변경15파일 ESLint/Prettier: exit0.
- Root는 실제 diff, 락/receipt 순서, 전체 artifact facts 비교와 경쟁 assertions, API 공통 매핑, 로그 및 보고된 파일 SHA256 일치, git diff --check를 확인했다.
- 로그: `/private/tmp/wm-s22-v-b-pg-r2.log`, `/private/tmp/wm-s22-v-b-{typecheck-r2,lint,format}.log`, hash `/private/tmp/wm-s22-v-b-hashes.txt`.
- 초기 fixture의 tenant 설정 누락으로34pass/92fail 기록은 `/private/tmp/wm-s22-v-b-pg.log`에 보존했다. fixture를 수정하고 기존 assertions를 유지한 실제 재실행 결과가 위127pass다.

## 남은 경계

AI snapshot/basis·worker는 v-c, 다른 actual/routine 저장은 v-d, provider 수집 commit는 v-e, 제품 UI/native 동의 경로와 넓은 fixture 회귀는 v-f다. 이 노드로 전체 V2-F31, native 실기기, 외부 provider, 운영 배포 또는 phase 독립 검토 통과를 주장하지 않는다. Unreviewed phase code는 main에 병합하지 않는다.
