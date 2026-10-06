# M3-02 phase · 계정별 HealthKit 등록/해제 검토 준비

상태: **전체 phase 검증 진행 중 / 독립 검토 대기 / main 미병합**. 이 문서는 M3-02j–o의 로컬 구현·준비와 실제 운영·기기 수용을 구분한다. baseline main `173d8d6e5fac4f6304ad3762e3c9dd8a6e0bae24`, 코드 freeze HEAD `1887073ac7b97059da31f363bb50f19558fd01ed`. 아래 기록을 포함한 최종 phase HEAD를 별도로 고정한 뒤 전체 diff를 fresh context-less gpt-6-sol high 읽기 전용 reviewer에게 제출한다.

## 실행 가능한 로컬 작업과 외부 조건

j 계약, k 등록 영속화, l API/개별 해제 cleanup, m native UUID/epoch 범위 수집, n 선택 등록 UI/bridge의 로컬 수용을 마쳤다. o 비식별 감사·제품 개별 해제·안전 배포 준비의 로컬 수용도 마쳤으나 실제 운영 감사·선배포/운영 rollback은 외부 조건이다. o/h 그래프의 in_progress는 유지한다. 이 외부 조건을 로컬 시험으로 통과 처리하지 않는다. phase 검토와 main 병합은 운영 배포·공개 전환 승인이나 실기기 수용이 아니다.

현재 서버의 migration65/과거 이미지와 중지된 container, 만료된 AWS SSO, 운영 백업·독립 삭제 원장·격리 복원·실제 감사/배포/rollback·제품 HTTPS·iPhone UIKit/VoiceOver/HealthKit는 별도로 남는다. `org.workoutmanager.app`의 기존 collector를 개인 운동 자료에서 실행하지 않는다. HealthKit 없는 별도 합성 성능 앱의 측정과 예산도 미확정이다. 과거 failed/skipped/not_executed를 유지한다.

## 전체 phase 검사 · 실제 결과

- frozen install exit0, lockfile 변경 없음. msw ignored-build-script 경고 유지.
- generated/format/lint exit0.
- 전체 typecheck 34/34 및 root tsc exit0; 6 cached, 28 actual tasks. 전체 build 15/15 exit0; 3 cached. 기존 Vite/Next/Zod/chunk/없는 turbo output 경고 유지.
- 전체 unit 최초 sandbox 실행: 369파일 통과·5실패·1skip, 4343시험 통과·36실패·7skip. 로컬 fixture listen EPERM과 이어진 server-not-running 실패를 보존한다. 승인된 loopback 환경으로 같은 전체 검사를 다시 실행해 **374파일 통과·1skip, 4379시험 통과·7skip**, exit0. SQLite experimental 및 jsdom canvas 미구현 경고 유지.
- 실제 격리 PostgreSQL 전체: upgrade1/1, **135파일 통과·1skip, 1095시험 통과·3skip**, exit0. 자체 cluster 종료 확인. pg query 동시호출 deprecation 경고 유지.
- unit7 skip는 소스 조건/현재 환경/합계를 대조하면 `military-perimeter-barriers.test.mjs`의 pinned worktree Jar 부재 조건과 정확히 일치한다. 로그 자체는 개별 skip 이름을 출력하지 않았으므로 이 식별의 대조 한계를 명시한다. 해당 M2-01ay barrier 구현은 이 phase에서 바뀌지 않았으며 이번 실행은 실 GraphHopper 검증이 아니다.
- 표준 PG3 skip는 `restore-suppression-exporter.integration.test.ts`의 TEST_PGOUTPUT_CONTRACT 미설정이며 기본 runner의 별도 logical/pgoutput/coordinator 경계다. 별도 `--pgoutput-contract`를 실제 격리 PostgreSQL에서 실행해 **3파일·7/7**, exit0과 cluster 종료를 확인했다. 이는 합성 계약 drill이며 실제 외부 remote ACK/서명 원장/운영 복원 gate가 아니다.
- identity 최초 시도는 default API4300 rewrite가 격리5630과 불일치해 readiness에서 중단했다. 자체 Next/Vite/API PID·cwd를 확인한 뒤 SIGTERM으로 종료했고 다섯 포트가 닫혔다. API_ORIGIN5630으로 web production을 재빌드해 exit0. corrected 첫 전체 실행은 **301통과·8실패·12skip**, 실제 exit1이었다. 8개 error context 모두 서버 export30에 대해 공통 시험 helper가28을 기대하는 불일치였다. 다섯 포트와 자체 임시 PG 디렉터리 정리를 확인했다. strict schema/assert를 보존하고 literal/type 두 곳만30으로 수정해 `ebe3d185519bda4e4bffdafe25305f2b5133411e`에 커밋했다. 전체 typecheck34/34+root tsc, 해당 helper lint/format/diff exit0. 수정한 HEAD에서 두 새 전체 회차를 실행 중이며 아직 identity 통과로 표시하지 않는다.
- 첫 identity 12skip는 source/환경 대조 결과 routing fixture에 따른 GraphHopper positive surface2·real sample2, sharing default-off4, certified OP 미지정3, Vite map-states의 basemap 배포 미서빙1이다. 실제 공급자/인증/배포 수용을 이 합성 실행으로 통과 처리하지 않는다.
- 수정 후 첫 새 전체 identity 회차(`isolated-r2`)는 **309통과·12skip·0실패**, 실제 exit0(11.8분)이었다. HEAD `ebe3d185` 불변, 5610–5650 listener0 및 자체 임시 PG 디렉터리0을 확인했다.
- 두 번째 회차(`isolated-r3`)에서는 `activity-delete.spec.ts`가 실제 deletion-impact 조회 전 disabled 확인 버튼에 focus를 요청해 toBeFocused에서 실패했다. 제품은 조회 미확인을 삭제 가능으로 오인하지 않는 정상 gate를 유지했다. 원인/실패 context 확인 뒤 자기 runner만 SIGINT해 **119통과·1실패·1중단·2skip·198미실행**, 실제 exit130(4.2분)과 자체 포트/PG 정리를 기록했다. 이 회차는 전체 완료/통과가 아니다. 두 focus 앞에 toBeEnabled를 기다리고 재확인의 focus도 명시 단언하도록 고쳤다. 임의 sleep·제품 코드/안전 gate 변경·기존409/204/재수집 억제 assertion 약화 없음. 전체 typecheck34/34+root tsc, 해당 시험 lint/format/diff exit0 뒤 `11f6ced549275095e5d5ba1bfde1e8e4808c051e`에 커밋했다. 이 새 HEAD의 두 새 전체 회차(`isolated-r4/r5`)를 검증 중이다. 이전 r2 통과를 새 HEAD의 두 회차로 대신 세지 않는다.
- Playwright bundled Chromium이 없어 실제 config를 import하는 외부 .mts wrapper에서 installed Chrome의 격리 profile을 사용한다. 개인 profile·실제 IdP 인증을 사용하지 않는다. 준비 --list는321개/112파일이며 시험 통과가 아니다.
- 신규 선택/관리 실제 Swift 합성 단언·iPhoneOS unsigned consumer compile, Xcode source membership/plutil, 실제 합성 브라우저 증거는 [n](M3-02n.md)·[o](M3-02o.md)에 있다. root는 관리 dylib 두 개의 LC_BUILD_VERSION에서 platform IOS/minos15.0/sdk27.0을 실제 확인했다. 서명 앱 전체 build나 iPhone 실행으로 표현하지 않는다.
- `isolated-r4`는 새 합성 Garmin MFA 상태5초 실패로 자기 runner만 중단해 **251통과·1실패·1중단·12skip·56미실행**, exit130이었다. 실제 POST timing tmp 진단3/3과 원본 HTTP receipt 선검증 수정 후 smoke4/4를 확인했지만 이전 실패 원인을 확정하지 않는다. timeout/제품 gate/기존 UI5초 단언은 유지했다. 반복 경합을 별도 [M3-02p](M3-02p.md)로 추적하며 새 고정 HEAD의 두 전체 회차가 아직 남아 있다.

로그는 `/private/tmp/wm-m3-phase-20261006-*`, corrected identity는 `/private/tmp/wm-m3-phase-identity-isolated-r*.log`에 보존한다. skip 항목/사유·미실행은 별도 분류하며 통과 건수에 포함하지 않는다.

## 독립 phase 검토

검증 완료 후 최종 base/head·실제 변경/미추적 파일·검사/실패/skip·외부 조건을 fresh context-less gpt-6-sol high reviewer에게 전달한다. 리뷰 중 해당 tree를 변경하지 않는다. 전체 phase diff의 계약·도메인·ownership/RLS·보안·스타일/경계·회귀·시험을 검토하며 완료된 결과를 읽기 전에는 main을 fast-forward하지 않는다. valid finding은 새 commit과 검증, fresh 재검토를 거친다. 최종 base/head·결과·FIXED/NOT FIXED·검증 기록은 해당 HEAD의 annotated review tag로 보존한다. push는 사용자 작업이다.
