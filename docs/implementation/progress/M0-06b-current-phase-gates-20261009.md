# M0-06b 현재 phase 전체 검사 · 2026-10-09

검증 입력은 `97b00da0b86b66d0b9a57730ed757d60ca5c3a1f`의 깨끗한 로컬 복제본이다.
원 작업 트리의 보호 WIP와 stash를 가져오거나 수정하지 않았다. 전체 tracked 2,332개와
별도 고정 Python/JAR 의존성을 검사 전후 대조했다. main/push/운영/실기기는 변경하지 않았다.

## 정적 검사와 전체 단위 시험

원 명령 install offline/frozen-lockfile, check:generated, lint, typecheck, build,
format:check는 실제 exit0이었다. 복제본 초기 build 부재와 첫 도구 중단의 build terminal 미확인을
보존했다. 동일 source/dependency를 재확인한 R2에서 세 build root가 존재했고 source drift0이었다.
이 M0 브랜치에는 중앙 V9 source-proof asset/시험이 없으므로 그 runtime readiness를 주장하지 않는다.

R2 전체 unit은 4,668 passed/4 failed/2 skipped·exit1이었다. 실패한 UI 3파일만 원 설정으로
재현하면68/68·exit0이었다. 이후 DB 통합 종료 뒤 같은 원 `pnpm test` 전체를 다시 실행한 R3는
**391파일·4,672 passed/2 skipped/0 failed·exit0**이었다. timeout/worker/단언/시험 목록은
변경하지 않았고 source/dependency 전후 동일이다. 집중 성공으로 전체 실패를 덮어쓰지 않는다.
부하가 원인이었다고 확정하지 않으며 앞선 실패는 재현 이력으로 남는다.

- R2 전체 기록: `/private/tmp/wm-m0-clone-static-six-unit-actual-r2-20261009-terminal.json`, SHA `028ebc86a6152bde3bcc35ca3cc1f63be8d3a79e34a55226cbbe4283cee21432`.
- R3 전체 unit: `/private/tmp/wm-m0-whole-unit-actual-r3-20261009.json`, SHA `72647c1899cea0579b117149f5b4437167389f7829f374dc5f2ccee5a45bc390`.
- 집중 재현: `/private/tmp/wm-m0-unit-failure-diagnostic-actual-r1-20261009.json`.

## 실제 PostgreSQL 통합 실패와 후속

원 `pnpm test:integration`을 PostgreSQL17.11의 새 전용 임시 Unix socket 클러스터에서 실행했다.
Plain owner와 restricted runtime을 사용했고 기존 클러스터·공유 메모리를 변경하지 않았다.
Upgrade1/1 통과, normal **1,483 passed/4 failed/4 skipped·exit1**이었다. 입력 전후 동일이며
종료 후 새 `workout-pg-*` 디렉터리 잔존0이다. 원 harness의 종료·정리 경계를 유지했다.

실패 프레임은 ai-settings-operations/restore-app-family-loader의 REASSIGN과
worker-tenant-source-upgrade의 trigger catalog/후속 index다. 중앙 브랜치에 이미 검증된
DB owner fixture 및 PG17 trigger/MAINTAIN ACL 대응 교정 두 곳이 M0에 없음을 읽기 대조했다.
Loader는 같은 소스이므로 아직 권한·환경 원인이 미확정이다. PostgreSQL minor 버전 자체 결함이나
제품 기능 실패로 단정하지 않는다. 원 실패를 보존하고 교정·집중 재현·전체 재검증을 이어간다.

- 실제 통합 기록: `/private/tmp/wm-m0-canonical-pg-actual-r1-20261009.json`, SHA `7c8600b4a971cd44dca06222e7723f4a8ba22d49878d8c2bd7a6e10e931e1fc7`.
- 읽기 진단: `/private/tmp/wm-m0-canonical-pg-four-failures-readonly-diagnosis-20261009.md`.

Identity 두 회차·적용 가능한 drill·독립 context-less phase review/main 병합은 아직 남는다.
이 기록으로 전체 phase 또는 로컬 노드 수용 완료를 선언하지 않는다. 운영·외부 수용과
최종 실제 제품 앱의 물리 기기 gate는 별도로 유지한다. 개인 건강/GPS/오류 본문은 저장하지 않았다.

## 세 파일 집중 PostgreSQL 검증 및 fixture 교정

Root는 두 fixture diff와 TMP 실행기·유한 projector 전체를 읽고 새2334-source clone을 준비했다.
원 source2333·contracts build114를 고정하고 loader 계측은 clone에만 적용했다. 원 canonical
preinstall/별도upgrade/private Unix socket/plain role/timeout/정리는 유지하며 normal선택만
3파일로 제한했다. 최초 실행은 정확버전 표기 검사에서 실패해 설치·DB 실행0이었다.
실제 pg_ctl 출력 `17.11 (Homebrew)`를 정확히 반영한 새 실행기로 frozen offline install0·
persistence typecheck0 후 upgrade1/1·normal29/29·3files·skip0·exit0을 확인했다.

ai-settings는 fixture DB 소유권을 관리자 setup으로 설정·검증한 뒤 기존 plain REASSIGN을
실행하며 CREATEDB는 추가하지 않는다. worker는 tgenabled::text와 PG17의 MAINTAIN을 포함한
완전한 owner/grantor ACL을 비교한다. 원 assertions/skip/timeout은 보존했다. Root 실제 집중
검증을 근거로 이 두 파일만 커밋한다. 보호 WIP14·stash·원 loader 파일은 변경하지 않았다.

- 실행 입력 SHA: `00f40b989e530965aba6b055484b04d2e3a8d2f61de78fee9de4f2fc4b76f557`
- 실제 결과: `/private/tmp/wm-m0-pg-three-files-diagnostic-prepared-20261009/terminal.json`
- 결과 SHA: `08a0ff99c7c8536ccce3b9a0977c70f716e861e3840204f7bba9702c7459b6f2`

source/clone 전후 동일·새 PG scratch 잔존0이다. owner transfer 유한 이벤트는0개 수집돼
구체 권한/SQLSTATE 관측을 주장하지 않는다. loader는 이번 집중 실행에서 통과했으나 이전
전체 실패 원인은 미확정이다. 기존 full PG1483pass/4fail/4skip과 R2 unit4fail은 보존한다.
전체 PG 재검증·identity×2·독립 phase 검토·main 병합은 여전히 미완료다.

## 60e4fa4f 고정 입력 전체 정적·단위 재검증

Root는 fixture 교정을 포함한 `60e4fa4f`의 새 깨끗한 로컬 복제본을 만들었다. source2333과
Python/JAR를 독립 핀으로 동결해 install offline/frozen·generated·lint·typecheck·build·
format·unit을 원 명령대로 실행했다. **일곱 단계 exit0, unit391파일/4672passed/기존2skip**이다.
원 WIP는 포함하지 않았고 source/dependency 전후 동일·세 build root 존재를 확인했다.

- 입력 SHA: `ac69ae2eaf6b5ed4aed8b55da5748e9efdf22abeca3e19117f29be8add8cbce0`
- 전체 실제 결과: `/private/tmp/wm-m0-60e4fa4f-static-seven-actual-20261009-terminal.json`
- 결과 SHA: `e2c001b692e0502b960cf1e56f5f9957870d35f51853976eba24ee5c2bed2a1d`

새 build가 생성돼 identity는 새 build freeze를 사용해야 한다. 동일 복제본의 원 canonical
PostgreSQL17.11 전체 통합을 별도 실행 중이며 종료 전 성공으로 기록하지 않는다.
이 결과는 이전 unit4fail·전체PG4fail·집중 진단의 범위를 덮어쓰지 않는다.

## 60e4fa4f 전체 PostgreSQL 실제 종료 결과

동일 고정 clone의 원 canonical integration은 exit1로 종료됐다. Upgrade1/1 통과,
normal1486passed/1failed/기존4skip이다. 기존 네 실패 위치는 이번 전체 실행에서 통과했으며
새 실패 프레임은 `global-openai-budget.integration.test.ts:693:5`의 REASSIGN이다.
SQLSTATE는 아직 관측하지 않았고 loader 실패로 분류하지 않는다. 실제 DB 소유권·권한을
변경하기 전에 별도 고정 단일파일 진단을 준비한다. 소스·의존성 전후 동일, 새 PG scratch잔존0.

- 실제 결과: `/private/tmp/wm-m0-60e4fa4f-canonical-pg-actual-20261009.json`
- SHA: `de3a24baf7c6cb21b847985be886d408e25d8155de63e2dc95ed659feac8d57b`

기존 full4fail과 이번1fail을 각각 보존한다. 전체 통합·identity×2·독립 phase 검토·main 병합은
아직 완료되지 않았다. 운영 및 최종 제품 실기기 gate도 유지한다.

### REASSIGN 집중17 원시험 진단 결과

최초 TMP진단은 package별의존성/build누락으로 등록0·exit1이었다. 실패를 보존했다.
새 R2는 package별node_modules 링크와 contracts114 build bytes를 별도 고정했다. 실제목록17개와
원제목대응을 확인한 뒤 새privateUnixPG17.11에서17/17·skip0·exactroster·exit0이었다.
plain/NOCREATEDB·old/next USAGE/SET true·old-owned sharedDB1 상태에서 REASSIGN 자체가
success/SQLSTATE null이었다. 단순 DB소유권 사전조건 결함으로 단정하지 않으며 교정0이다.

- R1 등록0 실패: `/private/tmp/wm-m0-budget-reassign-run-6JNMIT/focused-result.json`
- R2 실제결과: `/private/tmp/wm-m0-budget-reassign-run-r2-EXCoEa/focused-result.json`
- R2 결과 SHA: `c2be2545fa095f9edacfc76b3147a967f9f954b491c21b9dfdcbe8806b15a915`

소스·의존성 전후동일, scratchDB0, 정확PGstop/remove를 확인했다. originalWholeGateAccepted false를
유지한다. 집중성공으로 원full1fail을 덮어쓰지 않고 변경없는 고정source의 전체canonical R2를
새wx결과로 실행 중이다. loader/REASSIGN의 앞선 전체실패 원인은 미확정이다.
