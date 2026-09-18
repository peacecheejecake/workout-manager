# 구현 계획 · Adaptive Training Coach

작성: 2026-09-16. 기준: `docs/.pre` v0.2.3. 상태: **단계별 제품 구현 중**. 아래 초기 저장소 설명은 계획 수립 당시 기준이며, 현재 완료 상태와 검증은 [작업 그래프](task-graph.md) 및 task별 progress 문서를 따른다.

이 문서는 기존 요구사항을 실행 가능한 작업 순서로 구체화한다. 제품 범위는 [01](../.pre/01_product_screen_spec.md)의 S01~S35, 기능·수용 기준은 [05](../.pre/05_implementation_requirements.md), 미완료 상태는 [06](../.pre/06_follow_up_backlog.md)를 따른다. 과거 QA 결과를 새 구현의 통과 증거로 재사용하지 않는다.

## 1. 현재 저장소와 이번 결정

- 현재 앱 코드는 Python CLI placeholder와 `scripts/fitparse.py`뿐이다. Next/React/API/DB와 JS package manifest는 없다.
- `docs/.pre/prototype/index.html`은 UI 참고 자료다. production 앱으로 확장하지 않고 토큰·상호작용·화면 의도를 옮긴다.
- 기존 Python 프로젝트는 FIT 일괄 다운로드·변환용 보조 도구로 재사용한다. 현재 다운로드 기능은 없으며, 변환 코드도 `.parquet` 경로에 CSV를 쓰므로 보완이 필요하다.
- 이번 산출물은 구현 계획, 루트 `AGENTS.md`, 상태 관리 문서 갱신이다. 아래 도구 설정과 CI는 M0에서 실제 구현하며 지금 설치·테스트 완료로 표시하지 않는다.

| 영역 | 채택 방향 | 구현 시 확정할 사항 |
|---|---|---|
| 저장소 | pnpm workspace + Turborepo, strict TypeScript | 지원 Node LTS 및 pnpm/React/Next/Vite 조합을 spike 후 정확한 버전·lockfile로 고정 |
| Web / 재사용 | Next App Router shell + framework-independent React modules | 동일 module을 Next와 Vite에서 실행하는 검증 |
| Native | Vite mobile-web + Capacitor; HealthKit native collector | M0 feasibility, M3 제품화·실기기 검증 |
| 클라이언트 상태 | **Zustand** | module/workspace별 store factory, SSR 격리·hydration·reset 계약 |
| 서버 조회 | **TanStack Query** | query key·취소·mutation invalidation·SSR hydration; Zustand에 응답 복제 금지 |
| UI | semantic CSS tokens + CSS Modules, Storybook | 기존 후보 라이브러리는 기능별 호환성·라이선스 검증 후 설치 |
| API / 저장 | Fastify BFF + application/domain + PostgreSQL | migration 도구·DB 접근 계층·인증 공급자 ADR; 객체 저장·job 실행 환경 |
| Contracts | Zod runtime schema + inferred TS + OpenAPI/client 생성 | v0.2.3 초안의 누락·상충·version 호환성 해소 |
| Unit / component | Vitest + React Testing Library + user-event + MSW | node / jsdom 프로젝트 분리; fake timer·고정 clock·fixture |
| Integration | Vitest + Fastify inject + 격리된 실제 PostgreSQL | migration·rollback·동시 승인·RLS·outbox 검증 |
| E2E | Playwright Test | 실제 web/API/DB 경로, Chromium 기본; Firefox/WebKit 확장 |
| 포맷 / 정적 검사 | Prettier + ESLint flat config + TypeScript | Python은 Ruff; Python 변경은 pytest |
| 개발 지침 | Vercel React Best Practices + 루트 AGENTS | upstream skill 출처·revision 기록, Herdr peer review, Aside 브라우저 검증 |

React 지침은 사용자가 지정한 [Vercel upstream skill](https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices)을 기준으로 한다. 동명의 다른 skill을 대체재로 간주하지 않는다. skill의 SWR/Next 전용 예제는 선택한 TanStack Query/Host 경계에 맞춰 적용한다. 앱의 데이터 소유권과 재사용 계약을 바꾸는 근거로 사용하지 않는다.

## 2. 패키지 경계와 상태 소유권

[02 아키텍처](../.pre/02_frontend_architecture.md)의 구조를 유지한다. 빈 패키지를 한꺼번에 만들지 않고 첫 기능이 필요한 시점에 추가한다.

```text
apps/web, mobile-web, mobile, api, worker, storybook
packages/modules/{dashboard,planning,activities,coaching,wellbeing,...}
packages/modules/{nutrition,supplementary,routines,recovery}
packages/experience/{planner-kit,data-workbench,conversation-kit,media-kit,geo-kit,routine-kit}
packages/ui/{tokens,primitives,components,patterns,icons}
packages/{platform,api-client,contracts,shared,tooling}
packages/server/{domain,application,integrations,persistence,metrics,evidence,coaching,retrieval,media}
src/workout_manager/              # Python FIT 보조 CLI; uv 환경 유지
scripts/                         # 기존 entry point·개발 보조
```

의존성은 shell → modules → kits/UI/platform/api-client/contracts 방향이다. server application은 domain과 port에 의존하고 persistence/integration adapter는 port를 구현한다. 조립은 apps/api·worker가 맡는다. module 간 private import, client의 server import, Next API의 module 침투를 ESLint와 package exports로 차단한다. 브라우저 `/bff/v1`은 Fastify로 proxy하고 Next에 업무 API를 복제하지 않는다.

| 상태 | 소유자 | 규칙 |
|---|---|---|
| 계획·활동·제안·실제 기록 | 서버 DB | version/revision과 승인 transaction이 정본 |
| 응답 캐시 | TanStack Query | 인증 사용자·scope·필터·관련 revision으로 격리; 로그아웃 시 제거 |
| 기간·view·filter·sort·선택 ID | URL/Host navigation | URL이 원본; store와 양방향 동기화 루프 금지 |
| 복잡한 편집·작업 공간 selection·runner UI | Zustand | store factory + provider로 수명 관리; 좁은 selector와 명시 action |
| 단일 컴포넌트의 열림·hover | React local state/ref | 공유하지 않는 상태까지 전역 store로 승격하지 않음 |
| 테마·밀도·panel 크기 | Zustand preference store | allowlist persist, version/migration, health draft와 분리 |
| timer UI | runner별 store + clock adapter | 기준 시각/정지 시간으로 계산; tick 횟수를 실제 수행으로 저장하지 않음 |

Next에서 module-level mutable singleton store를 만들지 않는다. 초기 직렬화 상태가 서버/클라이언트에서 일치하도록 하고 browser storage 복원은 hydration 정책에 따라 수행한다. resize로 renderer가 바뀌어도 store provider는 유지한다. 건강 초안은 기본 메모리 저장이며 영속화는 사용자 동의·scope·삭제 정책을 갖춘 기능에서만 추가한다. native token·HealthKit anchor는 store에 넣지 않는다.

## 3. 구현 단계와 완료 조건

### M0 · 개발 기반·계약·feasibility

| 작업 | 의존 | 결과물·완료 조건 |
|---|---|---|
| M0-01 도구 기반 | 없음 | workspace, turbo, strict tsconfig, exports, ESLint boundaries, `.editorconfig`, Prettier, Vitest, Playwright, CI, lockfile; 포맷·lint·typecheck와 독립 tooling fixture의 Vitest/Playwright smoke 실행. 제품·실DB·FIT 시험은 아래 단계 gate에서 활성화 |
| M0-02 도메인 계약 | M0-01 | `.pre` contracts를 runtime schema로 승격; ID/단위/현지 날짜·UTC·timezone/version/null 의미; valid/invalid fixture, schema v4와 기존 입력의 호환 정책 |
| M0-03 Host·상태·shell | M0-02 | 동일 ActivityList를 Next/Vite에 표시; fake transport 교체; Zustand scope/reset/SSR 격리와 query cache 경계 시험 |
| M0-04 UI·반응형 | M0-03 | token 이식, 기본 controls, Storybook, responsive-spec 생성기; mobile/tablet/desktop 및 좁은 container에서 draft 유지 |
| M0-05 API·영속화 | M0-02 | Fastify composition, PostgreSQL migration, auth/consent port, tenant scope/RLS, outbox, sanitized error/log; inject·실DB 시험 |
| M0-06 공급자·복합 UI spike | M0-03/04, 외부 권한 별도 | Garmin entitlement tracker, HealthKit feasibility, map coverage, chart/editor/drag/IME/license report; 실패·미확인을 그대로 기록 |
| M0-07 FIT 도구 정리 | M0-01, provider 경로는 M0-06 | §5의 일괄 처리 CLI·manifest·재시도·pytest; 공식 자동 수집과 구분 |

M0-01에서 upstream React skill을 프로젝트가 사용하는 agent skill 경로에 설치 또는 등록하고 upstream commit을 기록한다. 설치 방식은 환경별로 검증하며, 임시 plugin cache 경로를 저장소의 영구 의존성으로 쓰지 않는다.

M0의 외부 승인·실기기 gate가 미완료여도 mock/FIT 기반 M1 개발은 진행할 수 있다. 이때 M0 전체나 외부 연동을 완료 처리하지 않는다. 인증 공급자, 배포 환경, Garmin entitlement, native 출시 범위는 ADR/의존성 추적표에 남기며 공급자 endpoint를 추측하지 않는다.

### M1 · 러닝 core loop

1. **M1-01 Identity/Consent**: 로그인·만료·로그아웃·소유권·AI 전송 동의. 다른 사용자 API/캐시/파일 접근 차단.
2. **M1-02 Plan/Planner**: Season/Wave/Phase/Block/Session, versioned plan, 달력·rolling projection, URL 상태와 Zustand draft. 10일 Block과 calendar week 계산을 분리.
3. **M1-03 Import/Activity**: fixture/FIT → raw/source revision → canonical/overlay → 활동 조회. 중복·삭제 suppression·outbox 재실행과 집계 일치 검증.
4. **M1-04 오늘/계획/활동/체크인**: M1-04a/b 체크인과 M1-04c/d 대시보드, M1-04e/f 활동 조회, M1-04g/h 수동 활동 계약/API와 입력·정정 UI, M1-04i 계획 연결·관측 영향, M1-04j Planner 실제 기록, M1-04k 로컬 삭제, M1-04l 명시적 Block 연결 필터, M1-04m 조회 달력 경계, M1-04n 계획 multi-view 공유 선택·초안 편집, M1-04o 달력·표 동시 보기와 반응형 전환, M1-04p 활동 기록 상태 필터, M1-04q 계획 표 정렬·열 표시, M1-04r 세션 복제 초안 선택·경계 보완, M1-04s 계획 표 고정 열·범위 선택·가상 스크롤, M1-04t 날짜 이동·시간 길이 조절, M1-04u Period Explorer·Orbit 계층 탐색, M1-04v 대시보드 카드 배치 편집, M1-04w 세션 강도 라벨 편집, M1-04x FIT 상세 수입 기반, M1-04y 구간·시계열 상세 UI, M1-04z 활동 다중 선택·일괄 로컬 삭제, M1-04aa 일괄 계획 연결·해제, M1-04ab 선택 활동 요약 JSON 내보내기, M1-04ac 세션 단계 순서 편집, M1-04ad 저장된 계획 버전 조회·기간 비교, M1-04ae 기간 우선순위 편집·버전 호환성, M1-04af 기간 운동 불가 날짜·가용 시간 제약, M1-04ag 선택 기간 계획·실제 요약과 주요 세션, M1-04ah 기간 타임라인·URL 보기 전환, M1-04ai/aj 사용자 완료 원장·UI, M1-04ak 기간 날짜 이동 영향 확인, M1-04al 세션 단계 단위 전환 확인, M1-04am 대시보드 기간 탐색, M1-04an 세션 페이스·심박 목표, M1-04ao 참석 잠금·삭제 보호, M1-04ap 거리·시간 목표 범위와 집계, M1-04aq 활동 로컬 태그·일괄 편집·필터, M1-04ar 계획 시나리오 A/B/C 저장·비교·적용, M1-04as 활동 페이스·심박 요약, M1-04at 체크인 자기보고 관측 추세, M1-04au 활동 상세 URL 탭·관측 상태 보존, M1-04av 계획 표 사용자 완료 보고 상태, M1-04aw 세션별 연결 실제 집계·거리 비교, M1-04ax 세션별 저장본·초안 변경 표시, M1-04ay 대시보드 실제 요약에서 기간별 활동 탐색을 연결하고 활동 workbench에 합류한다. S03~S12 중 해당 업무를 실제 API/DB까지 연결. chart/table·empty/partial/error·반응형 완결. 개별 slice 완료를 전체 workbench 완료로 간주하지 않는다.
5. **M1-05 Evidence/Coach/Approval**: 독립 기반 M1-05a에서 기존 원장의 단일 snapshot 의존성 캡처·비교를 준비한다. M1-05b는 불변 계획의 검토 범위와 사용자 대화 저장·계정 수명주기를 준비한다. M1-05c는 사용자 상담 기록 UI와 저장 복구를 연결한다. M1-05d는 구조화 근거 본문·의존성을 같은 시점에 저장하고 삭제·철회를 연결한다. M1-05e는 상담에서 근거를 명시 저장하고 고정 본문·회수 상태를 검토하는 UI를 연결한다. M1-05f는 사용자가 명시 확인한 필수 제약 문장의 원장과 상담 UI를 연결하고, M1-05g는 새 running-core-v2 근거 본문·의존성에 강제 포함하고 삭제 회수를 연결한다. 기존 v1 근거는 당시 제외 범위를 보존한다. 부모 통합은 M1-04 완료를 계속 요구하며, 제한된 원장 비교를 완전한 승인 freshness로 간주하지 않는다. snapshot → 후보 → diff → 명시 승인 → PlanVersion. stale/중복/동시 승인과 transaction 실패 시험. LLM 실패는 실패 상태로 남김.
6. **M1-06 운영·연결**: sync/settings/audit·내보내기/삭제, 승인된 공식 Garmin adapter 교체·회귀. mock 성공과 실제 provider 성공을 구분.

M1-04의 지도 독립 workbench 범위는 [수용 대조](progress/M1-04.md)와 통합 시험을 거쳐 완료했다. 위 4번의 전체 화면 요구나 출시 gate 완료를 뜻하지 않으며, 지도·Native·공식 Garmin 검증은 후속 task에 남는다.

M1-05의 training-only 범위는 [DAG](task-graph.md)의 h~m과 [통합 수용](progress/M1-05m.md)까지 완료했다. 고정 근거·대화·필수 제약, 결정론 실행, 서버 검증 후보·diff, 원자적 명시 승인, S10/S11 UI를 실제 OIDC·API·격리 PostgreSQL에서 연결했다. 일반 서버에서는 fixture를 명시 활성화한 개발·테스트 환경에서만 실행을 생성한다. 실제 LLM 판단·공식 Garmin 수집·생리학적 타당성은 별도 검증이며, 이 slice를 제품 출시 gate로 간주하지 않는다.

계획 시나리오는 기준 계획 버전마다 0개 이상을 저장한다. A/B/C는 기존 호환 데이터와 예시
이름이며, 사용자 이름을 추가해도 고정 슬롯이나 자동 병합은 없다. 이 보완은
[M1-04ba](progress/M1-04ba.md), S05 계획 종류 도메인 열은
[M1-04az](progress/M1-04az.md)에서 추적한다.

2026-09-16 결정: 기존 OIDC 앱 로그인은 유지하고 `/account` 설정에 별도의 **Garmin 연결** OAuth 2.0
PKCE 흐름을 추가했다. [M1-06c 검증 기록](progress/M1-06c.md)과 [운영 설정](garmin-setup.md)에
구현·로컬 fixture 검증 결과를 기록했다. M1-06b는 EXT-G와 M1-06c 이후 공식 연결·실제 수집을 검증한다. 로그인·동의 화면은 Garmin이
소유하며 앱은 Garmin 비밀번호를 받지 않는다. 공식 권한·실연동·출시 gate는 유지한다.

2026-09-16 사용자 승인으로 M0-06b의 지도 coverage·OS IME 검증을 M1-04의 착수 의존성에서
분리했다. 지도 기능 M2-01과 전체 통합 M2-06에서 해당 gate를 계속 요구하며 완료 조건은 유지한다.

첫 수직 slice는 `가상 활동 수신 → 오늘/활동 조회 → 상담 후보 → diff → 승인 → 새 계획 재조회`다. 승인 검증·재전송 결과·원자성은 실제 DB로 시험한다. 외부 모델은 CI에서 결정론적 adapter로 대체하되 실제 LLM/provider 연결 증거는 별도 확보한다. 연관: FUT-01/02/04/08/10.

### M1b · 영양·보강 수동 core

M1의 정본 Activity·계획·승인 위에서 S25~S30을 구현한다. nutrition plan/intake/food version, exercise/workout template/set actual, 부분 기록·좌우·단위·timer, 혼합 Planner와 joint approval 순서다. 활동과 세트 상세를 이중 집계하지 않고 계획값을 자동 actual로 저장하지 않는다. 연관: FUT-11/12, V022-F/A 전체.

### M1c · 루틴·스트레칭·회복 수동 core

M1b 이후 S31~S35를 연결한다. blueprint → finite schedule/occurrence → run/actual link, 선택 branch·anchor·pause/resume·중단, supplementary 내부 stretching, 비운동 recovery 원장을 구현한다. schemaVersion=4의 다영역 승인으로 여러 aggregate head/미존재 조건·read dependency·outbox를 한 transaction에 검사·적용한다. resize/foreground/재전송에서 진행과 actual을 보존한다. 연관: FUT-13/14/15, V023-F/A 전체.

### M2 · 전체 Web MVP

코스/routing → 대회 → 갤러리/media → 자료 권한·version·삭제 → 검색/RAG·인용 → 검토된 영양/동작/회복 자료와 코치 연결 순서다. 나머지 S01~S35 화면, 검색·설정·연결·오류 복구를 목록으로 대조한다. 자료 생명주기와 ACL 이전에 RAG를 먼저 붙이지 않는다. FUT-06/07/09 및 기존 나머지 backlog를 회수한다. 공유 계획 원문이 없는 FUT-09는 확보하거나 미확정 상태를 유지한다.

완료 조건은 모든 화면의 실제 업무, 수용 시험, 보안·삭제·backup restore·운영 검증이다. **공식 Garmin 승인/실연동이 없는 FIT 개발판을 기존 명세의 Web MVP 출시 완료로 간주하지 않는다.** 생리학적 타당성은 CRUD·계산 시험과 별도 gate다.

### M3 · Native 제품화

mobile-web 모듈 재사용, secure transport/versioned bridge, HealthKit collector의 anchor/tombstone/outbox/ack, foreground·background·IME·back·offline을 실기기에서 시험한다. WebKit 브라우저 테스트를 WKWebView/HealthKit 실기기 검증으로 대체하지 않는다. Native-inclusive 출시에는 M3도 필요하다.

## 4. 테스트·Prettier·CI 설정 명세

### 설정 파일과 실행 명령 계약

다음은 **M0-01에서 만들 파일과 scripts**이며 아직 실행 가능한 저장소 명령이 아니다.

| 파일 | 설정 내용 |
|---|---|
| `package.json`, `pnpm-workspace.yaml`, `turbo.json` | engines/packageManager 고정, scripts, build/typecheck/lint/test graph; dev persistent, E2E cache 제외 |
| `packages/tooling/` | TS/ESLint/test 공통 설정; package별 public export; React Hooks·접근성·의존성 규칙 |
| `vitest.config.ts`, package별 test config | node unit / jsdom component / 실DB integration 분리; V8 coverage; setup cleanup/reset |
| `playwright.config.ts`, `tests/e2e/` | webServer 준비, 실제 API/DB seed, baseURL, 브라우저·viewport projects, report/trace |
| `.prettierrc.json`, `.prettierignore`, `.editorconfig` | 아래 포맷 정책과 제외 경로 |
| `.github/workflows/ci.yml` | frozen install → 생성물 확인 → 정적 검사 → unit/component → integration → build → E2E |
| `pyproject.toml`, `tests/python/` | FIT 작업 시 Ruff/pytest 설정, uv lock 유지 |

Prettier 초기값: `semi: true`, `singleQuote: true`, `trailingComma: "all"`, `tabWidth: 2`, `printWidth: 100`, `endOfLine: "lf"`. EditorConfig도 UTF-8/LF/final newline로 맞춘다. ESLint formatting 규칙은 `eslint-config-prettier`로 끄고 Prettier가 포맷을 단독 소유한다.

제외: dependencies, `.venv`, build/cache/coverage/Playwright 결과, 생성 DTO, FIT·Parquet·다운로드 데이터. `docs/.pre/**`는 제공된 설계 원본의 일괄 재포맷을 방지하도록 제외하고 의도적인 문서 수정은 별도 diff 검토한다. Python은 Prettier 대신 Ruff format을 사용한다.

```text
pnpm format / pnpm format:check
pnpm lint / pnpm typecheck
pnpm test                 # 비대화형 unit + component; watch 별도
pnpm test:integration     # disposable PostgreSQL, migration 적용
pnpm test:e2e             # 실제 앱을 대상으로 Playwright
pnpm build
pnpm check               # format:check + lint + typecheck + unit/component
uv run pytest            # FIT 코드 변경 시
uv run ruff check . / uv run ruff format --check .
```

단계별 활성화: M0-01은 formatter/linter/typecheck와 최소 tooling fixture로 Vitest·Playwright runner가 동작하는지 확인한다. 제품 없는 E2E나 DB 없는 integration을 빈 suite로 통과시키지 않는다. M0-03에서 두 shell build·화면 smoke, M0-05에서 실제 DB integration, 첫 M1 수직 slice에서 실제 web/API/DB E2E, M0-07에서 Ruff/pytest를 필수 gate로 활성화한다. 미활성 단계는 CI/작업 기록에서 미구현으로 명시하고 이후 기능 PR부터 해당 gate를 생략하지 않는다.

`pnpm check` 성공만으로 integration/E2E/build 통과를 주장하지 않는다. CI의 전체 gate는 이들 단계도 실행한다. 실패 trace/report는 민감정보 없는 fixture 기준으로 제한된 기간 보관한다. 테스트 DB는 사용자 DB와 분리하고 run별 ID/schema를 사용한다. 외부 provider/LLM 호출은 CI 네트워크 의존성으로 두지 않는다.

### 시험 계층과 핵심 사례

| 계층 | 검사할 동작 |
|---|---|
| Unit | 날짜/DST·단위/null·rolling 집계, finite recurrence, anchor/branch, freshness/digest, dedup·지표 정의 |
| Component/store | Zustand 사용자·작업공간 격리, hydration/reset, selector, URL 복원, 실패한 저장의 draft 유지, renderer 전환, timer 재계산 |
| Integration | 소유권/RLS·schema 거절·CSRF, 동시 승인/중복 요청/rollback, multi-domain write, outbox 재시도, 삭제 suppression |
| E2E | 로그인 → FIT fixture import → 계획 preview/승인 → 새로고침 후 보존; stale 충돌; 영양/보강/루틴 actual·중단; 계정 전환 |
| 실 브라우저 | Aside 우선, 불가 시 Chrome, 다음 Playwright; 한글 IME·키보드·drag 대안·reflow·focus·network 오류 |
| 실기기/외부 | HealthKit lifecycle·공식 Garmin·실제 routing/LLM, 별도 자격/환경과 결과 기록 |

E2E와 실 브라우저 점검은 별개다. **Playwright 자동화는 M0부터 설정**하고 Aside/Chrome fallback 여부와 관계없이 CI에서 실행한다. MSW는 UI 개발·component 시험에 사용하며 실제 persistence를 증명하는 E2E에서는 API/DB를 mock하지 않는다.

기본 PR E2E는 Chromium 390/1440에서 핵심 업무를 실행한다. 반응형 변경 시 320/360/390/767/768/1024/1279/1280/1440 및 container 560/960 경계·orientation·200% zoom·reduced motion을 관련 화면에 추가한다. 전체 브라우저 회귀는 Firefox/WebKit에도 수행한다. role/label 기반 locator, 자동 대기와 assertion을 사용하고 임의 sleep·대규모 screenshot snapshot에만 의존하지 않는다.

coverage는 보고서를 남기고 핵심 domain/승인 경로의 누락을 우선 검토한다. 의미 없는 숫자 달성을 위한 테스트를 만들지 않는다. 초기 기준치를 첫 slice의 실제 결과로 확정하고 이후 하락을 관리한다. Vitest는 async RSC 동작의 완료 증거로 삼지 않고 Next server/client 조합은 E2E에서 검증한다.

## 5. 기존 Python/FIT 도구 재사용

기존 위치·uv entry point를 보존하면서 `src/workout_manager/`에 작은 CLI 모듈을 추가하고 `scripts/fitparse.py`는 호환 wrapper로 전환한다. 제품 서버의 정본 규칙은 Python에 중복 구현하지 않는다.

1. 변환 명령: 파일/디렉터리 입력, record/lap/session, `--format csv|parquet`, 실제 확장자 일치, 명시 output dir, 덮어쓰기 제어. `to_parquet`/`to_csv`를 구분한다.
2. 다운로드 명령: 권한 있는 provider adapter 또는 허가된 export manifest 입력. 공식 권한 전에는 로컬 FIT batch import를 제공한다. 계정 비밀번호 scraping을 기본 수집 경로로 만들지 않는다.
3. manifest: provider/activity ID, source timestamp, hash, 경로, 성공/실패·재시도 상태. URL의 credential/query token은 기록하지 않는다. 부분 실패 뒤 resume·중복 skip·속도 제한·timeout을 지원한다.
4. 파일: 임시 파일에 내려받고 검증 후 atomic rename. 크기 제한·URL/redirect allowlist·path traversal 방어. 삭제 suppression을 무시한 자동 재수집 금지.
5. fixture 시험: 깨진 FIT·빈 메시지·중복 파일·일부 다운로드 실패·resume·출력 형식 round-trip. 개인 FIT/GPS/토큰은 git에 넣지 않는다.

## 6. 추적·review·착수 순서

병렬 착수·합류 조건은 [작업 의존성 그래프](task-graph.md)와 [기계 판독 DAG](task-graph.json)를 따른다. M0-06/07·M1-06의 조사/수동/외부 연동 범위를 분할하고 M1b~M3의 하위 task를 정의했다. 아래 권장 순서는 기본 우선순위이며 독립 task의 직렬 실행을 강제하지 않는다. Native 준비는 M2와 병행할 수 있으나 최종 M3 통합·출시는 M2 완료 이후다.

각 구현 티켓은 FUT-ID, S-ID, V2/V022/V023-F 및 A-ID, 의존 작업, 변경 패키지/schema/migration, 수용 기준, 검증 명령·증거·남은 gate를 포함한다. 기존 50 + 36 + 36 수용 항목은 삭제하지 않고 구현 티켓과 연결한다. 테스트 파일에는 관련 A-ID를 명시하고 실제 실행 결과만 상태를 갱신한다.

권장 첫 PR은 **M0-01 도구·품질 기반**, 다음은 **M0-02 계약 + M0-03 두 shell의 공통 ActivityList**, 그 뒤 **M0-04 UI / M0-05 DB 기반과 첫 M1 slice**다. 기간 추정은 toolchain spike·외부 권한·팀 가용성이 확인된 후 수행한다.

커밋 전에는 [AGENTS.md](../../AGENTS.md)의 Herdr pane peer review를 수행한다. reviewer는 현재 diff·미추적 파일·요구사항·검증 결과를 읽고 수정 없이 findings를 보고한다. 유효한 지적을 수정·검증한 뒤 변경된 결과를 다시 검토한다. review 미실행을 통과로 간주하지 않는다.

실 UI 변경은 Aside skill에 따라 브라우저에서 확인한다. 불가 원인과 Chrome → Playwright 대체 결과를 기록한다. 문서만 바꾸는 현재 단계는 앱 브라우저 검증 대상이 아니며 과거 prototype QA 상태를 갱신하지 않는다.

## 참고

- [Vercel React Best Practices skill](https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices): 프론트엔드 성능 지침 기준.
- [Vitest 시작하기](https://vitest.dev/guide/): test runner 설정 참고.
- [Playwright 설치](https://playwright.dev/docs/intro): E2E runner·브라우저 설치 참고.
- [Prettier 설치](https://prettier.io/docs/install): 프로젝트 로컬 formatter 및 check 참고.
- [참고 저장소 지침](/Users/min.jiwon/red-10-red/pfm-agent/AGENTS.md): 문서 구성·경계·검증·review workflow 참고. 해당 제품 고유 규칙은 이식하지 않음.
