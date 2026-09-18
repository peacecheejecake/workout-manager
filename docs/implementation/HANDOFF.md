# 다음 세션 handoff · 2026-09-19

이 문서는 현재 구현을 이어받기 위한 진입점이다. 최신 작업 상태는
[task-graph.json](task-graph.json), 요구·수용 기준은 [docs/.pre](../.pre/README.md),
작업 규칙은 [AGENTS.md](../../AGENTS.md)를 우선 확인한다. 이 문서의 날짜 이후
커밋이 있다면 아래 HEAD·검증 수치는 해당 커밋에 맞춰 다시 확인한다.

## 현재 기준과 사용자 결정

- 브랜치 `main`; 이 handoff 작성 직전 기준 커밋은 `02fff8b`이며 당시
  `origin/main`까지 푸시했다. 이후 커밋·원격 동기화는 재개 시 확인한다. 사용자가
  `https://github.com/peacecheejecake/workout-manager.git`을 본인 관리 저장소로
  확인하고 이 코드의 푸시를 승인했다. **task별 peer review 후 커밋하고 매 커밋
  직후 `git push origin main`을 시도한다.** 일반적인 푸시 실패는 기록하고 다음
  작업을 진행한다.
- AGENTS·skill 등 규칙은 사용자가 명시적으로 규칙 수정을 지시한 때만 바꾼다.
  구현 조정이나 포맷 검사는 규칙 변경 승인이 아니다. `CLAUDE.md`는 사용자 소유
  untracked 파일이므로 읽기·수정·stage·commit하지 않는다.
- 구현 분해와 병렬 조정은 **Codex native orchestration**을 사용한다. 구현 작업은
  의존성 그래프의 ready task만 배정하고, 공유 migration·계약·lockfile은 root가
  통합한다. 커밋 전 peer review는 Herdr의 같은 tab split pane을 사용한다.
- Frontend 상태는 Zustand, 서버 캐시는 TanStack Query다. Vercel React Best
  Practices와 Composition Patterns가 기본 규칙이다. UI 변경은 Aside → Chrome →
  Playwright 순으로 실 브라우저를 시도하고 사용한 도구를 정확히 기록한다.
- 앱 로그인은 표준 OIDC, Garmin 연결은 설정의 별도 OAuth 흐름이다. 공식 Garmin
  권한·실계정 연동은 아직 완료되지 않았다. 현재 Native 검증은 **Simulator만**
  진행하며 실기기 결과로 대체하지 않는다.

## 완료된 최근 작업

- `25cd76f` 범용 루틴 core, `dea3b6b` 스트레칭 core, `75e672d` 수동 회복
  전략 core가 각각 구현·검토됐다.
- `942ec68`은 사용자 승인에 따라 세 core의 최소 운영 runtime GRANT 함수를
  추가하고, E2E fixture도 같은 함수를 사용한다. 새 테이블의 SELECT·INSERT,
  일부 현재 상태 행의 UPDATE만 허용하며 DELETE는 없다. 최신 계정 말소 함수는
  migration 뒤 `grantOperations`로 권한을 다시 부여한다. 실제 운영 DB 배포는
  실행하지 않았다. [권한 합류 기록](progress/M1c-runtime-grants.md)을 참고한다.
- `6616a05`의 공개 합성 routing 재검증은 서울 표본 1건의 형상 재현과 두
  `NoSegment`를 확인했다. [coverage 결과](progress/M0-06b.md)는 여전히
  `not_reviewed`이며 운영 provider를 선정한 결과가 아니다.
- `7752058`의 Xcode 27/iOS 27 격리 Simulator에서는 개발 fixture의
  세로→가로→세로 회전과 제목 safe-area가 통과했다. 후속 Simulator 실행은
  `02fff8b`에 기록했다. 이 실행에서는
  합성 native `UITextField`의 키보드 표시·가로 회전·세로 복귀·닫힘까지
  7단계가 통과했다. validator 39개와 실제 화면 7장의 SHA-256·시각 검토를
  완료했다. 독립 리뷰에서 키보드의 가로 교차 판정 누락을 찾아 수정하고
  재실행했다. 임시 입력창이 웹 콘텐츠 일부를 가리며, 실제 WKWebView HTML 입력·
  한국어 IME·실기기 수용은 아니다. [Native 진행 기록](progress/M0-06c.md)과
  [실행 보고서](research/capacitor-simulator-result.json)를 참고한다.

권한 변경 기준 검증은 `pnpm check`(191개 파일/1,978개 단위 테스트와 24개 패키지
타입 검사), 격리 PostgreSQL 34개 파일/276개 테스트, `pnpm build`, OIDC·임시
PostgreSQL·Chromium 루틴/스트레칭/회복 E2E 3개 통과다. 새 DB 시험은
nonowner/FORCE RLS, 다른 계정 접근 거절, DELETE 부재, 최신 말소 wrapper와
과거 wrapper 직접 실행 차단을 확인했다. Herdr 리뷰에서 추가 finding은 없었다.

## 바로 다음 구현

그래프에서 준비된 제품 task는 **M1c-04 다영역 통합 승인**이다. 기존
`packages/server/persistence/src/joint-approval.ts`와
`integrated-planner.ts`는 훈련·영양 schema v3 경계이므로, v3 호환성을 보존한
schema v4를 별도로 설계한다. 계약 초안은
[extensions-v023.contracts.ts](../.pre/extensions-v023.contracts.ts), 수용 기준은
[V023-A29/A30/A36](../.pre/05_implementation_requirements.md)을 본다.

M1c-04의 핵심은 훈련·영양·회복·routine schedule의 변경 대상과 읽기 의존성을
서버 소유 후보로 확정하고, 없던 head까지 같은 transaction 안에서 최신성
검사한 뒤 명시 승인으로만 version/history/outbox/receipt를 원자 적용하는 것이다.
run·체크인·회복 기록의 동시 변경, 부분 실패 rollback, 성공 응답 유실 후 같은
결과 반환, 구형 클라이언트의 schema v4 `unsupported`를 실제 DB/API/E2E로
검증한다. 실제 Activity·IntakeEntry·RecoveryActionLog와 RoutineRun은 별도
원장이며 계획 승인이나 타이머로 실제 수행을 생성하지 않는다.

M1c-03의 S35 화면에는 기존 관측·계획을 탐색해 새 전략에 연결하는 선택기가
아직 없다. 회복 참조 계약과 API 검증은 있으므로 M1c-04의 read dependency에
필요한 연결 범위를 확인하고, UI 범위는 별도 작업으로 명시한다. 전체 V023
수용과 자료/RAG·효능 검증이 끝났다고 표시하지 않는다.

## 남은 독립 gate

- M0-06b: 한국 보행 경로의 독립 coverage·접근 제한 검토, 운영 provider 선택,
  OS 한글 IME/물리 touch/성능·배포 조건 검증. Aside 업데이트는 `fetch failed`,
  Chrome 조작용 Orca 데스크톱 런타임은 시작 시간 초과였다. Playwright의 합성
  조합 이벤트를 OS IME 통과 근거로 올리지 않는다.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·스크롤과 Simulator의 foreground·
  back 수명주기 추가 검증, 이후 실제 iPhone/프로젝트 서명·HealthKit 실기기 gate.
  사용자가 현재 실기기를 연결하지 않으므로 실기기 작업은 보류한다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집 검증. 로컬 FIT,
  별도 Garmin OAuth fixture, 합성 데이터는 공식 실연동 증거가 아니다.

다음 세션은 `git status --short`와 원격 동기화, task graph의 ready 상태를
확인하고 M1c-04를 작은 계약·DB transaction·API/UI·통합 수용 단위로 분해한다.
각 작업마다 실제 검사, Herdr 검토, 커밋과 푸시를 반복한다.
실행 환경의 기본 Node가 18일 수 있으므로 `node --version`을 먼저 확인한다.
현재 JS workspace와 Capacitor CLI는 Node 24.12.0으로 검증했다.
