# M3-02 phase 독립 검토

## 첫 검토 · BLOCK

- 기준 `main` `2463f83922468818f9be9c9225cefd678681b247`, phase HEAD `04c5168bc63144175a9745222c2b28dc974ee366`. 작업 트리는 깨끗했고 변경 경로 108개였다.
- 별도 Codex CLI `gpt-6-sol` high, read-only sandbox가 전체 diff를 검토했다. 판정: **BLOCK**. 이 HEAD는 `main`에 병합하지 않는다.
- P1 #1 **NOT FIXED**: HealthKit 소유 Activity 로컬 삭제의 raw 정리 trigger가 같은 계정의 모든 batch receipt digest를 purge한다. 서버 저장 뒤 ACK를 잃은 native 배치가 409를 받아 뒤의 outbox까지 영구 보류될 수 있다. 로컬 삭제와 무관한 receipt를 보존하거나 안전한 재조정 경로 및 실제 DB/native 재전송 시험이 필요하다.
- P1 #2 **NOT FIXED**: 계정 전환이 이전 계정의 미전송 `HKDeletedObject`를 포함한 outbox와 cursor를 지운다. 서버에 남은 이전 계정의 canonical Activity 삭제가 전달되지 않는다. 계정별로 보존하되 새 계정의 인증으로 재전송하지 않는 격리 경로와 native 시험이 필요하다.
- 검토자는 M3-02h의 서명된 제품 iPhone 실행을 외부 gate로 별도 제외할 수 있다고 판단했다. M3-02h의 실제 실행은 `not_executed`이며 M3-02 부모도 미완료다. 이는 위 BLOCK 이유와 별개다.

## 지적 사항 수정 · 재검토 대기

- P1 #1 **FIXED in current content**: migration 063은 로컬 Activity 삭제와 absent-Activity 재생에서 계정의 HealthKit batch receipt를 지우지 않는다. raw 표본 삭제 상태와 lineage suppression은 유지한다. 실제 PostgreSQL 시험에서 ACK를 잃은 동일 배치 재전송, 다른 본문 충돌, 후속 배치, 삭제 표본의 재생성 방지, 타 계정 격리를 검증했다. 062가 이미 지운 과거 receipt는 복구할 수 없지만 이 phase는 아직 `main`에 병합되지 않아 제품 배포 이력이 없다.
- P1 #2 **FIXED in current content**: native SQLite outbox/cursor를 계정별 보호된 파일로 격리하고 로그아웃에서 메모리 소유자만 해제한다. 다른 계정에서는 이전 계정 배치를 볼 수 없으며, 이전 계정으로 다시 로그인하면 같은 본문으로 재전송할 수 있다. 기존 단일 소유자 파일도 해당 계정에 유지한다. Swift harness는 오프라인 삭제 대기, 계정 전환, 프로세스 재시작, ACK를 확인했다.
- 수정 통합 검증: PostgreSQL 통합 시험 841/841, 전체 단위·컴포넌트 시험 4229 통과·7건 건너뜀, Swift harness 통과, iOS SDK 타입 검사 통과, 서명 없는 iOS Simulator 빌드 통과, generated/Prettier/ESLint/TypeScript/build 통과. 처음 전체 단위 시험은 로컬 서버 바인딩이 제한된 실행 환경에서 35건 실패했으며, 권한을 갖춘 동일 코드 재실행에서 위 결과로 통과했다.
- 이 평가는 수정된 작업 트리의 자체 점검이다. 별도 `gpt-6-sol` high read-only 검토가 새 phase HEAD를 승인하기 전까지 BLOCK 판정을 유지하고 `main`에 병합하지 않는다.

## 두 번째 검토 · BLOCK

- 같은 `main` 기준 `2463f83922468818f9be9c9225cefd678681b247`, phase HEAD `2a50881ffec25e7733eebdb104e8c936ca47becc`의 110개 변경 파일을 별도 Codex CLI `gpt-6-sol` high, read-only sandbox가 검토했다. 작업 트리는 깨끗했다.
- 이전 P1 #1 receipt 삭제와 P1 #2 계정 전환 outbox 소실은 각각 **FIXED**로 판정됐다. migration 063의 영수증 보존과 실제 DB 재전송 시험, 계정별 SQLite 격리와 Swift harness가 근거다.
- 새 P1 #3 **NOT FIXED**: 다른 기기에서 동의를 철회하고 다시 허용하는 동안 오프라인이었던 iPhone의 과거 배치가 재전송 때 409를 받는다. 첫 배치를 보류하면 뒤 배치와 재조정이 멈춘다. 철회 전 표본을 재사용하지 않으면서 과거 outbox를 폐기하고 새 설치 범위에서 다시 조회하는 복구 경로가 필요하다.
- 새 P1 #4 **NOT FIXED**: 제품 iPhone의 native origin에는 HealthKit 계정 패널만 있고 검토·명시적 생성/연결·공통 Activity 상세 화면으로 가는 인증된 경로가 없다.
- M3-02h는 이번에도 외부 gate로 제외됐으며 `not_executed`다. 두 새 P1이 해결되고 전체 phase를 다시 검토받기 전까지 `main`에 병합하지 않는다.

## 두 번째 검토 지적 수정 · 재검토 대기

- 새 P1 #3 **FIXED in current content**: native 저장소는 계정별 동의 revision을 배치와 함께 보존한다. 서버 동의 revision이 바뀌면 이전 outbox·anchor·알려진 표본을 원자적으로 폐기하고 installation ID를 회전한 뒤 현재 동의 아래에서 다시 조회한다. 업로드에는 revision 헤더가 필수이며 서버는 동의 행 잠금 안에서 현재 revision과 비교한다. `CONSENT_EPOCH_EXPIRED`만 이 복구를 시작하고 일반 409는 격리 상태를 유지한다. 실제 PostgreSQL 통합 시험은 842/842, Swift State·Uploader harness는 동의 경계 회전과 재전송을 통과했다.
- 새 P1 #4 **FIXED in current content**: native 계정 화면에서 공통 ActivityBrowser의 검토 표면으로 이동할 수 있다. 좁은 native bridge GET/POST 허용 경로가 검토 목록, 명시적 생성·연결 결정, Activity 상세의 개요·구간·출처에 연결된다. native host는 현재 bearer 소유자를 검사하고 응답 크기를 제한한다. 이전 계정의 늦은 401은 새 계정 범위를 지우지 않는다. 모바일 Chromium에서 모의 native bridge로 계정→검토→명시적 생성→공통 ActivityDetail 경로를 실행했고, 링크 및 늦은 401은 컴포넌트 시험에서 확인했다.
- 합본 검증: 전체 단위·컴포넌트 4235 통과·7건 건너뜀, PostgreSQL 통합 842/842, 브라우저 smoke E2E 4/4, generated/Prettier/ESLint/TypeScript 34/34/build 15/15, Swift harness와 SDK 타입 검사, 서명 없는 iOS Simulator 빌드 통과. 최종 iOS `public/index.html`은 mobile-web build와 SHA-256이 같다. 첫 포맷 검사에서 `native-bridge.ts` 서식 차이를 찾아 수정한 뒤 전체 포맷 재검사가 통과했다. 지도·고도 자료 경로를 지정한 전체 identity E2E 두 실행은 각각 304 통과·13건 건너뜀(14.3분, 14.4분)이었다.
- 모바일 UI 검사에서 Aside 설치 업데이트는 `fetch failed`, Chrome은 native 모의 진입을 제공하지 못해 Playwright mobile Chromium을 사용했다. 이 browser mock과 서명 없는 Simulator 빌드는 M3-02h의 서명된 제품 iPhone 실행을 대체하지 않는다. M3-02h는 계속 `not_executed`다.
- 위 평가는 자체 점검이며, 새 phase HEAD의 독립 읽기 전용 전체 검토가 승인하기 전까지 `main` 병합은 보류한다.

## 세 번째 검토 · BLOCK

- `main` 기준 `2463f83922468818f9be9c9225cefd678681b247`, phase HEAD `a1e90d6bfa6fc6c17b7c287aa3b010f90aaac90b`의 113개 변경 파일을 별도 Codex CLI `gpt-6-sol` high, read-only sandbox가 검토했다. merge base가 기준 `main`과 같고 작업 트리는 깨끗했다.
- 이전 P1 #1 receipt 삭제, #2 계정 전환 outbox 소실, #3 동의 철회·재동의 후 오프라인 queue 정지, #4 제품 iPhone의 검토·결정·상세 경로 부재는 현재 코드에서 각각 **FIXED**로 판정됐다.
- 새 P1 #5 **NOT FIXED**: HealthKit 소유 정본 Activity가 대시보드, 기간 요약, 세션 실제 기록, 활동 계획 맥락의 `fit/fixture/manual` 전용 출처별 집계에서 빠져 총건수와 출처 합계가 달라진다. 대시보드 응답 파싱이 실패할 수 있으므로 계약·SQL·일별 합산·표시와 실제 DB 회귀 시험을 함께 수정해야 한다.
- 서명된 제품 iPhone 실행 M3-02h는 `not_executed` 외부 gate로 남는다. 새 P1과 전체 phase 재검토가 끝나기 전까지 `main`에 병합하지 않는다.

별도 읽기 전용 source-kind 감사에서는 HealthKit 소유 Activity에 사용자가 범용 FIT/GPX track upload를 예약할 때 `activity_track_upload_intent.source_kind`의 기존 `fit/fixture/manual` CHECK에 걸리는 경로도 확인했다. 이 발견은 세 번째 phase 검토의 지적 항목이 아니라 후속 자체 감사 결과로 기록하며, 활동 소유 출처와 업로드한 경로의 기록 출처를 구분한 수정과 실제 DB 시험에 포함한다.

## 세 번째 검토 지적·자체 감사 수정 · 재검토 대기

- 새 P1 #5 **FIXED in current content**: `dashboardActualSchema`에 `sources.healthkit`을 더하고 총건수 검증·기존 응답 기본값을 조정했다. dashboard, period-summary, session-actuals, activity-context SQL과 일별 합산, 대시보드·기간·세션·활동 맥락 표시가 HealthKit 정본을 센다. 실제 PostgreSQL에서는 HealthKit 표본 수집→명시적 정본 생성→계획 링크 뒤 네 조회 모델, 일별·기간 합산, 타 계정 격리를 검증했다.
- 자체 감사의 track upload 실패도 **FIXED in current content**: migration 065는 track/head/revision/upload intent의 활동 소유 출처 제약에 `healthkit`을 추가한다. 업로드 기록은 `recorded_source_kind`와 `format`으로 따로 남는다. 실제 PostgreSQL에서 HealthKit 정본에 사용자가 GPX 경로를 올리는 예약·준비·최종화와 타 계정·오래된 revision 거부를 검증했다.
- 합본의 실제 PostgreSQL 시험은 844/844, 전체 단위·컴포넌트 4236 통과·7건 건너뜀, generated/Prettier/ESLint/TypeScript 34/34/build 15/15, 서명 없는 iOS Simulator 빌드를 통과했다. 첫 합본 타입·빌드는 API 테스트 fixture에 새 필드가 없어 실패했고 해당 세 fixture를 고친 후 전체 타입·빌드가 통과했다. 모바일 자산을 iOS 프로젝트에 다시 동기화했고 두 `index.html`의 SHA-256이 같다. 첫 전체 identity E2E는 302 통과·2 실패·13건 건너뜀으로 끝났다. 실패는 대시보드와 기간 요약의 정확한 객체 비교가 새 `healthkit: 0` 필드를 기대하지 않은 시험 데이터 문제였으며, 두 기대값을 고친 뒤 집중 3/3, 전체 재실행 두 번 각각 304 통과·13건 건너뜀(14.6분, 14.5분)을 확인했다. 제품 코드는 첫 실패 뒤 바꾸지 않았다.
- Aside CLI 업데이트는 `fetch failed`; Chrome CUA 상태 조회에는 Mac 잠금 오류가 있었고 합성 HealthKit 응답을 넣은 화면 검사에는 Playwright Chromium을 사용했다. 합성 응답을 실제 대시보드·기간 요약·세션 실적·활동 맥락 컴포넌트에 넣어 390×844 viewport에서 각각 `HealthKit 1개` 표시와 page error 없음(0건)을 확인했다. 이는 제품 로그인이나 서명된 iPhone 실행 증거가 아니다. M3-02h는 `not_executed`다.
- 새 phase HEAD의 독립 읽기 전용 전체 검토가 승인하기 전까지 `main` 병합은 보류한다.

## 네 번째 검토 · APPROVE

- `main` 및 merge base `2463f83922468818f9be9c9225cefd678681b247`, phase HEAD `2bbf81dac8949aea1b5938fbbeeaa84038ebbc8a`의 변경 파일 141개를 별도 Codex CLI `gpt-6-sol` high, read-only sandbox가 전체 검토했다. 작업 트리는 깨끗했고 `git diff --check`가 통과했다.
- 판정: **APPROVE**. P1 #1 receipt 삭제, #2 계정 전환 outbox 소실, #3 동의 epoch의 오프라인 409, #4 iPhone 검토·명시적 결정·상세 경로 부재, #5 HealthKit 정본의 네 조회 집계 누락은 각각 현재 코드에서 **FIXED**로 판정됐다. 별도 자체 감사의 HealthKit 소유 Activity GPX/FIT 경로 업로드도 migration 065와 실제 DB 시험으로 수정 확인했다. 새 차단 지적은 없었다.
- 검토자는 제출된 PostgreSQL 844/844, 단위·컴포넌트 4236 통과·7건 건너뜀, 정적 검사·빌드·Swift·브라우저 및 identity E2E 두 실행의 기록을 대조했다. 이 읽기 전용 검토에서 검사 명령을 재실행하지는 않았다.
- 이 승인은 M3-02h의 서명된 제품 iPhone 전체 경로 실행을 포함하지 않는다. M3-02h는 `not_executed` 외부 gate이며 M3-02 부모도 완료로 바꾸지 않는다.
- 이 기록을 추가한 새 phase HEAD는 diff identity가 바뀌므로 최종 읽기 전용 검토 refresh 후에만 `main`으로 fast-forward한다.

## 2026-09-29~30 · `main` 병합 후 단계 전체 검증 · 독립 재검토 대기

- `main` `ac99e3749c643ecc4d9cd78cd0b05353ae511430`을 `phase/m3-02`에 충돌 없이 병합했다. 검증 시작 시 병합 HEAD는 `7824336d2d6ad291617174546a3f1516b2f08e9a`였다. `main`의 M2-01k 진행 문서·연구 매트릭스 변경과 단계의 M3-02 변경을 모두 보존했다.
- Node 20.10.0의 첫 `pnpm install --frozen-lockfile`은 저장소의 Node `>=24.12.0 <25` 조건에 거절됐다. Node 24.19.0의 첫 설치도 네트워크 제한, 오프라인 재시도는 캐시에 없는 `fastify` tarball 때문에 실패했다. 접근 가능한 환경에서 같은 잠금 파일 고정 설치가 완료됐다. 이 실패를 통과로 소급하지 않는다.
- `pnpm check:generated`, `pnpm lint`, `pnpm format:check` 통과. `pnpm typecheck`는 34/34, `pnpm build`는 15/15 통과했으며 두 작업 집합은 공유 Turbo 캐시 결과였다.
- 전체 단위·컴포넌트 첫 실행은 샌드박스의 로컬 OIDC 서버 바인딩 제한으로 35 실패·4,207 통과·7 건너뜀이다. 동일 코드의 로컬 바인딩 허용 재실행은 **4,242 통과·7 건너뜀**이었다. PostgreSQL 통합 첫 실행은 공유 메모리 `shmget` 제한으로 `initdb` 시작에 실패했다. 권한을 갖춘 재실행은 **844/844 통과**했다.
- identity E2E의 첫 시작은 기존 프로세스가 기본 API 포트 4300을 사용해 중단됐다. 별도 포트에서 이전 API origin을 담은 웹 빌드를 그대로 쓴 첫 실행은 앞선 4건이 30초 제한에 걸려 중단했다. 새 API origin으로 Next·Vite 셸을 다시 빌드한 뒤 대표 1건이 통과했고, 전체 실행 두 회는 각각 **308 통과·13 건너뜀·실패 0**(15.2분, 15.0분)이었다. 사용자 지도·고도 자산은 기존 로컬 검증 경로로 제공했다. 초기 중단과 제한 시간 초과를 통과로 바꾸지 않는다.
- Debug `Info-Debug.plist`와 Release `Info.plist`의 `plutil -lint`가 통과했다. `CODE_SIGNING_ALLOWED=NO` generic iOS Debug 빌드 두 회가 통과했다. 테스트 전용 `https://api.example.invalid`·`https://idp.example.invalid` override를 준 산출물에는 정확한 두 origin이, override 없는 산출물에는 두 빈 문자열이 들어 있었다. Release 원본의 두 origin도 비어 있다. 테스트 주소는 실제 서비스가 아니다.
- `git diff --check` 통과. 서명된 새 iPhone 빌드·설치·제품 로그인·실제 HTTPS 연결·HealthKit 읽기/쓰기/삭제·background wake·offline ACK와 제품 전체 수용은 이번 검증에서 **not_executed**다. M3-02h 외부 gate 및 M3-02 부모 상태를 통과/완료로 바꾸지 않는다. 이 단계 기록 커밋을 포함한 최종 phase HEAD와 `main`의 전체 diff는 독립 읽기 전용 재검토를 새로 받아야 한다.

## 다섯 번째 검토 · BLOCK 및 P2 보완

- 독립 `gpt-6-sol` high/read-only 전체 phase 검토는 base `main` `ac99e37` → HEAD `66a689f`에서 **BLOCK** 판정을 냈다. P2: HealthKit 운동 읽기를 OS에서 거부한 상태의 빈 anchored 조회가 삭제 API 성공 뒤 anchor를 전진시킬 수 있고, 삭제 확정 상태의 명시적 권한 재시도도 그 anchor를 초기화하지 않아 이후 허용된 tombstone을 놓칠 수 있다.
- P2 **FIXED in current content, 독립 재검토 대기**: 명시적 읽기 재시도는 삭제 확정 여부와 관계없이 같은 UUID 범위의 anchor를 nil로 돌린다. 비어 있는 조회는 cursor를 전진시키지 않으며, 현재 조회에서 실제 tombstone을 관측해야만 삭제 이벤트 확인을 보고한다. 계정·UUID·source·표식의 조회/삭제 격리는 유지한다. Swift harness의 거부 → 삭제 → 허용 → 재시도 상태 전이 통과, iOS SDK 타입 검사와 서명 없는 Simulator 빌드 통과. 첫 sandbox 빌드는 CoreSimulatorService·캐시 권한 문제로 중단됐고 접근 가능한 환경에서 재실행이 통과했다.
- 새 HEAD의 전체 install/generated/lint/typecheck/build/test/integration/identity 2회/format gate는 이 보완 뒤 아직 재실행하지 않았다. 실기기 HealthKit 동작과 M3-02h 전체 수용도 **not_executed**다. 새 전체 검토가 완료되기 전까지 `main` 병합은 보류한다.

## 2026-09-30 · P2 보완 HEAD 단계 전체 재검증 · 독립 재검토 대기

- 기준 `main`은 `ac99e3749c643ecc4d9cd78cd0b05353ae511430`, 검증한 phase HEAD는 `e8f53b82415fb06629753601b94fc4779265b3c4`였다. 시작 작업 트리는 깨끗했다. 이 검증 중 제품 코드는 수정하지 않았다.
- Node 24.12.0·pnpm 10.34.5에서 고정 잠금 설치의 첫 시도는 샌드박스 DNS 제한(`ENOTFOUND registry.npmjs.org`)과 비대화형 modules 제거 보호로 실패했다. `CI=true`를 준 접근 가능한 환경의 동일 `pnpm install --frozen-lockfile` 재실행은 통과했다. pnpm은 `msw` build script를 무시한다는 기존 경고를 냈다.
- `pnpm check:generated`, `pnpm lint`, `pnpm format:check`, `git diff --check` 통과. `pnpm typecheck`는 34/34, `pnpm build`는 15/15 통과했다. 두 Turbo 결과는 전부 공유 캐시였으며, 별도 identity API origin을 지정한 `@workout/web` 직접 빌드도 통과했고 출력의 route manifest에 그 origin이 들어 있었다.
- 전체 단위·컴포넌트 첫 실행은 샌드박스의 로컬 시험 서버 바인딩 제한으로 35 실패·4,207 통과·7 건너뜀이다. 접근 가능한 환경에서 같은 HEAD를 재실행해 **4,242 통과·7 건너뜀**을 확인했다. 실제 PostgreSQL 통합 시험은 **844/844 통과**했다.
- identity E2E는 별도 웹/API/OIDC/Garmin 포트와 기존 로컬 지도·고도 자산을 사용했다. 첫 전체 실행은 모바일도 별도 포트 53111로 지정했으나, `native-shell.spec.ts` 한 건이 `127.0.0.1:4200`을 고정 사용해 **307 통과·13 건너뜀·1 실패**(15.0분)였다. 이는 실행 구성 불일치이며 통과로 소급하지 않는다. 모바일 포트를 4200으로 바꾼 집중 시험은 1/1 통과했다. `pnpm test:identity -- native-shell.spec.ts` 시도는 CLI 인자가 필터로 적용되지 않아 전체 실행을 시작했으므로 43번째 부근에서 중단했고 통과 증거로 사용하지 않는다. 올바른 구성의 전체 재실행 두 회는 각각 **308 통과·13 건너뜀·실패 0**(14.9분, 15.0분)이었다. 두 회 모두 고정 포트 시험이 통과했다.
- 이 HEAD의 Swift 상태 전이 harness, iOS SDK 타입 검사, 서명 없는 Simulator 빌드 결과는 위 P2 보완 기록과 `M3-02h.md`의 2026-09-30 기록을 확인했다. 이번 단계 전체 게이트에서 이 세 명령을 별도 재실행하지 않았다. 서명된 새 iPhone 빌드·설치·제품 로그인·실제 HTTPS와 HealthKit 읽기/쓰기/삭제·background wake·offline ACK 및 M3-02h 전체 수용은 계속 **not_executed**다. M3-02 부모를 완료로 바꾸지 않으며, 이 검증 기록 커밋까지 포함한 새 phase HEAD의 독립 읽기 전용 전체 diff 재검토가 필요하다.

## 여섯 번째 검토 · APPROVE

- Codex 앱의 새 context-less `gpt-6-sol` high subagent가 base `main` `ac99e3749c643ecc4d9cd78cd0b05353ae511430` → `phase/m3-02` HEAD `73e472de3b4e6537fba457ec2d43a896b373f4c5` 전체 diff를 읽기 전용으로 검토했다. 변경 파일은 11개, 미추적 파일은 0개, 작업 트리는 깨끗했고 `git diff --check`가 통과했다. 판정은 **APPROVE**, 새 차단 지적은 없었다.
- 다섯 번째 검토의 P2는 **FIXED**로 확인됐다. 삭제 확정 뒤에도 명시적 읽기 재요청이 같은 표본의 anchor를 초기화하고, 비어 있는 filtered page는 cursor를 전진시키지 않으며, 현재 조회에서 tombstone을 실제 관측해야 삭제 확인을 보고한다. 이전 P1 #1–#5도 현재 코드에서 모두 **FIXED 유지**로 확인됐다.
- 검토자는 제출된 전체 게이트와 Swift 시험·타입 검사·서명 없는 빌드 기록을 대조했으며 명령을 재실행하지 않았다. UUID 범위의 `HKDeletedObject`가 실제 iPhone에서 반환되는지, 새 서명 빌드·제품 로그인·공개 HTTPS·합성 HealthKit 표본 수명주기·background wake·offline ACK는 **not_executed**인 M3-02h 외부 gate로 남는다. 이 승인으로 M3-02h나 부모 M3-02를 완료 처리하지 않는다. 이 판정 기록을 추가한 새 HEAD는 diff identity가 바뀌므로 `main` 병합 전에 읽기 전용 검토 refresh가 필요하다.

## 일곱 번째 검토 · 서명 빌드 기록 APPROVE

- Codex 앱의 새 context-less `gpt-6-sol` high subagent가 base `main` `e1b21111572aed340757105f857d306ec80bc2dd` → `phase/m3-02` HEAD `d9dceaee1a37697b02cb5390cba265cdfab43874` 전체 diff를 읽기 전용으로 검토했다. 변경은 `M3-02h.md` 한 파일(8줄 추가·1줄 수정), 미추적·staged·unstaged 변경은 0개였다. `git diff --check`와 해당 문서 Prettier 검사가 통과했고 판정은 **APPROVE**, 차단 지적은 없었다.
- 검토자는 임시 빌드 산출물에서 `BUILD SUCCEEDED`, Debug probe 컴파일, bundle ID, 두 HTTPS origin, HealthKit·background delivery entitlement, 앱과 mobile-web의 동일한 웹 자산 SHA-256을 대조했다. 제한된 첫 `codesign --verify --deep --strict`는 신뢰 저장소 접근 오류 `CSSMERR_TP_NOT_TRUSTED`로 실패했고, 권한 있는 동일한 읽기 전용 재실행은 exit 0이었다. 첫 실패를 검토 통과로 소급하지 않는다.
- API 주소는 호스팅 phase Compose의 계획된 `PUBLIC_ORIGIN`과 같지만 공개 DNS/HTTPS는 아직 없다. 새 빌드의 iPhone 설치·실행, 제품 로그인, 실제 합성 HealthKit 표본 수명주기·tombstone·background wake·offline ACK는 **not_executed**다. 이번 승인은 M3-02h의 실기기 수용이나 M3-02 부모 완료가 아니다. 이 검토 기록 커밋으로 HEAD가 바뀌므로 `main` 병합 전 읽기 전용 검토 refresh가 필요하다.
