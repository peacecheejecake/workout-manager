# 02 · Frontend / WebView / Module 아키텍처 v0.2.3

> v0.2.3 · 2026-09-16: [09 루틴·스트레칭·회복 전략](09_routines_stretching_recovery.md)과 S31~S35, FUT-13~15, V023 요구·시험을 추가했다. 기존 계약·이력은 유지하며 신규 기능은 아직 미구현이다. 아래 이전 버전 설명은 당시 기준이며 새 범위는 09와 05 §11을 따른다.

> v0.2.2 추가 계약: [07 반응형](07_responsive_layout.md), [08 영양·보강](08_nutrition_supplementary_training.md). 기존 모듈·Host 경계와 승인 불변 조건을 유지한다.

## 1. 결정: MFE-ready modular frontend부터 시작한다

MVP는 **build-time composition 기반 모듈형 프론트엔드**다. 도메인별 모듈·계약·의존성·라우트 경계를 갖지만, 모든 모듈이 독립 배포되는 runtime microfrontend라고 부르지 않는다. 모노레포, lazy loading, microfrontend 독립 배포는 서로 다른 개념이다.

선택안: pnpm workspace + Turborepo task graph, React 모듈, Next.js web shell, Vite mobile-web shell, Capacitor native shell. 기존 Nx를 유지하는 팀이면 task runner만 Nx로 바꿔도 모듈 구조는 동일하다. 두 task runner를 중복 운영하지 않는다.

**Turbopack**은 Next의 bundler이고 **Turborepo**는 모노레포 작업·캐시 도구다. Turbopack이 모듈 아키텍처나 native WebView 재사용을 만들어 주지 않는다. 또한 webpack plugin을 지원하지 않으므로 webpack 기반 federation 설정이 그대로 작동한다고 가정하면 안 된다.[S01](sources.md#s01) [S03](sources.md#s03)

독립 배포가 실제 필요해지면 자료실/미디어 같은 경로를 Next multi-zones로 분리하는 안을 우선 검토한다. zone 간 이동은 hard navigation이므로 planner↔activity↔coach처럼 빠른 상태 공유가 필요한 작업 공간은 같은 zone에 둔다.[S02](sources.md#s02) Runtime federation은 팀별 배포 독립성의 편익이 버전 충돌·공유 런타임·장애 격리·SSR 비용보다 큰 경우 별도 ADR로 선택한다. 현 시점의 host/bundler 지원을 검증하지 않은 nextjs-mf 플러그인 도입을 전제로 삼지 않는다.

## 2. 모듈 계층의 이름과 책임

사용자가 제시한 목록은 일렬의 계층보다 **두 개의 의존성 흐름**으로 표현한다.

```text
Web App / Mobile App Shell
        ↓
Domain Modules
   ├── Experience Kits ── UI Components ── Tokens
   ├── API Client ── HTTP or Native Transport ── BFF Gateway
   ├── Platform SDK ── Web / Native capabilities
   └── Contracts / Pure utilities

BFF Gateway ── Application services ── Domain / Integration / Persistence
```

**공통 복합 컴포넌트 이름은 `Experience Kits`를 추천**한다. primitives나 generic shared와 구분되며, `conversation-kit`, `planner-kit`, `data-workbench`, `media-kit`, `geo-kit`처럼 사용자의 작업 경험을 묶는다. 실제 코칭 비즈니스 로직은 `coach` module, 재사용 가능한 대화 rendering/composer/scroll은 `conversation-kit`이다.

| 계층 | 책임 | 금지 |
|---|---|---|
| App/Shell | URL, auth boundary, layout, deep link, host 구현 | 세션 수정 규칙·코칭 상태를 중복 구현 |
| Domain Module | 특정 도메인 screens/use cases/hooks/read model | 다른 모듈 internal import, next API 직접 import |
| Experience Kits | generic 복합 interaction, controlled data/events | Garmin 호출, 승인 API 직접 실행 |
| API client | schema 기반 요청·오류·query key | provider secrets, DB 모델 import |
| UI pack | primitive/molecule/pattern, style, a11y | 서버 fetching, 훈련 규칙 |
| Shared Contracts | serializable DTO, runtime schema, units, IDs | ORM entity·token·node-only 코드 |
| Platform SDK | navigate/share/media/haptics/capability/transport | 임의 native eval·임의 URL access |
| Plugin adapters | 3rd-party 라이브러리와 제품 API 변환 | library 타입이 모든 모듈 공개 계약으로 전파 |
| BFF | 인증·screen read model·stream·command forwarding | UI code import, 동일 domain logic 복제 |

## 3. 저장소 구조

```text
apps/
  web/                       # Next App Router: thin route wrappers
  mobile-web/                # Vite React: bundled client assets
  mobile/                    # Capacitor project + Swift HealthKit collector
  api/                       # Fastify; /bff/v1 + application API boundary
  worker/                    # sync, FIT, media, RAG indexing, coach jobs
  storybook/                 # UI/kit/module mock stories
packages/
  modules/
    dashboard/ planning/ activities/ coaching/ wellbeing/
    courses/ competitions/ gallery/ resources/ identity/ settings/ connections/
    nutrition/ supplementary/
  experience/
    conversation-kit/        # transcript, composer, attachments, evidence slots
    planner-kit/             # generic planner kernel + view adapters
    data-workbench/          # linked chart/table/selection/panels
    media-kit/               # grid/lightbox/upload/player
    geo-kit/                 # map/waypoints/routing preview UI
  ui/
    tokens/ primitives/ components/ patterns/ icons/
  platform/                  # Host interface, web/native adapters, bridge protocol
  api-client/                # generated DTO calls + cache conventions
  contracts/                 # browser/server safe schema, no ORM
  shared/                    # explicit subpaths: dates, units, ids, result
  server/
    domain/ application/ integrations/ persistence/
    metrics/ evidence/ coaching/ retrieval/ media/
  tooling/                   # eslint boundaries, tsconfig, test fixtures
```

라이브러리 adapters는 소유 kit 안에 둔다. 예: `experience/geo-kit/adapters/maplibre`. 모든 것을 전역 `plugins` 패키지에 모아 단일 거대 진입점을 만들지 않는다. 런타임 plugin registry는 도메인 capabilities와 adapter manifest만 가지며 임의 사용자 script loading 기능은 제공하지 않는다.

UI package 내부는 atomic 사고를 적용하되 atoms/molecules/organisms를 모든 도메인 폴더에 강제하지 않는다. `Button`, `Surface`, `Metric`, `MetricCard`, `SectionHeader`와 실제 도메인 `TrainingImpactPanel`의 소유권을 분리한다.

## 4. 모듈 표준 계약

모듈 공개 진입점은 manifest, route definitions, screen factory/component, optional initial-data schema로 제한한다. app은 권한·URL을 처리해 module에 넘기며, module은 `HostContext`로 navigation와 runtime capability를 사용한다.

```ts
interface HostContext {
  environment: 'web' | 'ios-webview' | 'android-webview';
  navigate(intent: NavigationIntent): void;
  transport: AuthenticatedTransport;
  capabilities: PlatformCapabilities;
  openExternal(url: string): Promise<void>;
  onForeground(listener: () => void): () => void;
}
```

각 module은 public `index`와 private `internal`을 나누고, package exports/ESLint/import graph로 경계를 검사한다. module 간 통신은 도메인 ID navigation, typed shared selection(작업 공간 소유), 또는 app-level event다. 전역 event bus로 모든 서버 데이터를 복제하지 않는다. 예: `activity.changed`는 query invalidation을 유발하고 record 내용은 API에서 재조회한다.

모듈은 React/client runtime을 공유하지만 `next/navigation`, `next/image`, Server Action에 직접 의존하지 않는다. Next wrapper가 SSR 가능한 초기 데이터를 주더라도 module 실행에 SSR을 필수로 요구하지 않는다. 지도·에디터·player는 client-only lazy leaf로 둔다.

## 5. BFF와 API 경계

브라우저는 same-origin `/bff/v1`을 호출한다. 배포 proxy는 Fastify의 BFF 경계로 보낸다. Next route handler를 같은 로직의 두 번째 구현으로 만들지 않는다. BFF는 대시보드 집계·기간 projection·코치 UI DTO를 조합하고, 변경 명령은 application service에 위임한다.

read endpoint 예:
- `GET /bff/v1/dashboard?anchor=...&windowDays=10`
- `GET /bff/v1/plans/:id/period-tree`
- `GET /bff/v1/planner?from=...&to=...&view=...`
- `GET /bff/v1/activities/:id/workbench`
- `GET /bff/v1/connections/capabilities`
- `GET /bff/v1/resources?query=...&status=...`

모든 relevant read model은 planVersion/dataRevision/definitionVersion/observedAt을 포함한다. 화면의 appearance 선택이 domain data revision을 올리지는 않는다. 건강 데이터의 background sample 한 개가 매번 진행 중 제안을 무효화하지 않도록 **coaching revision과 단순 raw ingest revision을 구분**한다. 후자는 원본 수신, 전자는 debounce한 semantic snapshot 갱신에 사용한다. 승인 시에는 최신 relevant canonical dependency를 다시 검사하며 무효화 대상 누락 테스트가 선행되어야 한다. 초기에는 보수적인 coarse coaching revision으로 운영한다.

write는 commands와 expectedVersion/idempotencyKey를 사용한다. 전체 화면 model을 PUT해서 숨겨진 필드를 덮어쓰지 않는다. 승인 freshness/transaction 계약은 v0.1을 유지한다.

## 6. 상태 관리

2026-09-16 구현 결정: 공유 클라이언트 상태는 **Zustand**, 서버 조회 캐시는 **TanStack Query**를 사용한다. 설치·구현은 아직 미수행이며 [실행 계획](../implementation/README.md)에 도구 설정과 검증 순서를 정의한다.

| 상태 | 소유·보존 |
|---|---|
| 정본 계획·활동·제안·권한 | Server repository |
| 서버 조회 캐시 | TanStack Query, user+scope+revision 기반 키 |
| URL 상태 | 기간, view, filter, sort, selected ID |
| 편집 초안 | Zustand module/workspace draft store, local persistence는 동의/민감도 고려 |
| 차트 cursor·hover·selection | workbench local context |
| theme·density·panel 크기 | Zustand preference store (health data와 분리) |
| native token·HealthKit anchor | Native secure/local storage, JS 노출 금지 |

서버 state를 Zustand와 query cache 양쪽 정본으로 두지 않는다. optimistic 업데이트는 draft UI/저위험 metadata에 제한하고 **계획 승인 성공은 실제 서버 결과 후에만** 표시한다. 계획 canonical value를 드래그 도중 optimistic하게 바꾸지 않는다. 오래된 화면의 저장은 conflict UI와 재검토를 요구한다.

Zustand는 store factory와 module/workspace provider로 수명을 관리하고 좁은 selector·명시 action을 사용한다. Next SSR 요청 사이에 mutable singleton을 공유하지 않으며 초기 상태·persist hydration 정책을 명시한다. 단일 control의 열림/hover는 React local state/ref로 유지한다. URL 상태를 store에 별도 정본으로 복제하지 않는다. Draft·selection·runner timer provider는 반응형 renderer 밖에 둔다. 로그아웃/사용자 전환 시 private store와 query cache를 정리하고, 기본 persist는 비민감 preference allowlist에 한정한다.

## 7. WebView 전략과 native bridge

### 7.1 Shell 분리

Web: Next shell + 순수 React modules. Native: Capacitor + Vite로 빌드한 같은 modules + native collector. Native에 Next 서버를 넣거나, 단순히 원격 웹 URL만 여는 것을 기본 전략으로 삼지 않는다. 번들 자산 사용으로 release/bridge 버전을 통제하고 외부 resources는 system browser 또는 제한 reader로 분리한다.[S04](sources.md#s04)

mobile bridge는 versioned handshake → capabilities → allowlisted command → request/response ID + timeout/cancel 구조다. raw JS 문자열 실행이나 임의 HTTP 프록시를 지원하지 않는다. 예: `health.requestAuthorization`, `health.syncStatus`, `media.pick`, `share.open`, `app.openSettings` 등. HealthKit raw records는 native→ingestion API로 전달하고 UI에는 필요한 상태·요약만 전달한다.

### 7.2 인증

브라우저는 HttpOnly/Secure session cookie + same-origin + CSRF 방어. Native는 system authentication session/browser에서 로그인·OAuth를 완료하고, 서버가 검증한 일회성 code를 교환한다. refresh credential은 Keychain 등에 보관한다. native authenticated transport가 지정 API origin·경로·method allowlist에 요청하며 장기 token을 localStorage나 query string에 넣지 않는다. 외부 링크는 native bridge가 있는 privileged WebView 안에서 열지 않는다.

웹과 native의 서로 다른 transport는 같은 generated API client 계약을 구현한다. client-supplied athlete ID는 권한의 근거가 아니며 서버 세션이 결정한다. 인증 실패 후 재연결은 draft 보존과 함께 처리한다.

### 7.3 모바일 UX와 lifecycle

safe-area, software keyboard/IME composition, 스크롤 잠금, native back 우선순위(modal→detail→tab→app), swipe-back 충돌, foreground 최신성 재조회, 대용량 upload background 전환, poor connectivity를 테스트한다. 모바일 drag와 map pan, carousel swipe가 겹치지 않도록 gesture owner를 하나로 둔다. native haptic은 drop/승인 같이 의미 있는 이벤트에만 사용한다.

offline에서는 last-known read와 명확한 draft만 허용한다. 승인·계정 삭제·OAuth completion은 서버 연결 없이 성공 처리하지 않는다. service worker에 민감한 health API responses를 무제한 cache하지 않는다. logout과 사용자 전환 시 query cache/미디어 URL/draft scope를 정리한다.

### 7.4 독립 release 호환성

bridge의 major/minor, API schema version, module manifest requiresCapabilities를 관리한다. 지원하지 않는 native 기능은 capability unavailable로 떨어뜨린다. WebView 서버 shell 업데이트로 오래된 앱 native bridge가 깨지지 않도록 backwards compatibility test를 둔다. native HealthKit 기능 등 모바일 가치를 구현해도 앱스토어 승인이 보장되지는 않으며 단순 웹사이트 포장 여부와 기능 적정성을 심사한다.[S12](sources.md#s12)

## 8. General Planner kit

`PlannerKernel`은 시간 범위·resource·event·selection·constraint·draft operations만 안다. `TrainingPlannerAdapter`가 session·period·workout intent를 연결한다. 나중에 대회 준비 일정, 콘텐츠 학습 일정, 일반 태스크에도 kernel을 재사용할 수 있다.

```text
PlannerKernel (framework-light pure TS)
  ├─ calendar renderer
  ├─ table renderer
  ├─ agenda renderer
  ├─ timeline renderer
  └─ orbit period navigator
Training Adapter -> application commands -> Plan Service
```

plan event와 actual activity를 동일 mutable event로 만들지 않는다. layer는 planned/current/draft/proposal/actual다. selection과 hover는 layer를 포함한 key를 가진다. recurrence는 template로 저장하되 외부 provider infinite recurrence를 승인 계획으로 자동 확장하지 않는다. MVP는 유한 기간 expansion preview를 제공한다.

## 9. 성능·안전성 예산 (달성 주장 아님)

initial authenticated shell gzip JS 목표 250KB 이하(외부 heavy adapters 제외), 모듈 초기 chunk 150KB 이하를 조사 목표로 둔다. map/editor/video는 필요 시 로드하고 domain module별 bundle analyzer로 중복 React·아이콘 전체 import를 검사한다. 숫자는 실제 deps와 대상 기기에서 재협의한다.

긴 table/시계열은 pagination/virtualization/downsampling을 사용한다. 지도+chart+blur를 동시에 많이 활성화하지 않는다. blur surface 수를 제한하고 preference/성능 fallback을 제공한다. chart raw data를 zoom마다 무제한 요청하지 않으며 cancellation/sequence를 적용한다. hover 한 번마다 network/LLM을 호출하지 않는다.

UI test는 desktop 1440, tablet, mobile 390/360, iOS WKWebView 실기기, Android WebView 실기기로 나눈다. 브라우저 responsive 테스트만으로 HealthKit·keyboard·native background가 검증되었다고 하지 않는다.

## 10. v0.2.2 확장 경계

`nutrition`은 계획·실제 섭취·식품 정의·팁/질문을, `supplementary`는 동작·루틴·실제 set를 소유한다. 보강 실제는 공통 Activity 한 건의 상세이므로 별도 원장에서 시간·횟수를 중복 집계하지 않는다. Nutrition actual은 IntakeEntry 원장을 사용하며 운동으로 세지 않는다.

BFF는 두 module의 read model과 통합 daily/period projection을 조합하고, 계산은 server metrics, 계획 변경은 application service에 위임한다. 사용자 세트·섭취 기록은 실제 log command이며 AI 제안 승인과 다른 동작이다. 함께 바뀌는 훈련·영양 계획은 joint basis/diff/transaction을 사용한다. [08 §8](08_nutrition_supplementary_training.md)에서 상세를 정의한다.

Viewport layout mode는 Shell, container responsiveness는 Module/Kit이 소유한다. Draft/selection/timer는 layout renderer 밖에 있고 CSS layout 전환으로 저장 상태를 바꾸지 않는다. threshold의 원본은 [responsive-spec.json](responsive-spec.json)이며 생성기·앱 적용은 후속 구현이다.

공유 타입은 [extensions-v022.contracts.ts](extensions-v022.contracts.ts)에 분리했다. 기존 API schema의 endurance payload를 덮어쓰지 않고 versioned union과 adapter로 확장한다. TypeScript 컴파일은 runtime validation·API 호환 완료의 증거가 아니다.

## 11. v0.2.3 루틴·회복 모듈과 스트레칭 전문 보기

`modules/routines`(S31~33), `modules/recovery`(S35)를 추가한다. S34 `/stretching`은 `modules/supplementary`에서 소유하며 공통 exercise-catalog와 Activity 상세를 재사용한다. 별도 stretching 원장/중복 데이터 store를 만들지 않는다.

`experience/routine-kit`은 단계 목록·choice·timer·진행 UI와 slot만 제공한다. 실제 workout/섭취/회복/체크인 저장은 도메인별 command, 계획 적용은 서버 application service가 담당한다. 루틴 완료가 가짜 Activity나 칼로리를 만들지 않도록 public 계약을 분리한다. 기존 v022 strength RoutineTemplateVersion은 그대로 참조하고, 범용 RoutineBlueprintVersion과 혼동하지 않는다.

API BFF는 RoutineOccurrence/Run 및 RecoveryStrategy/Action의 read model을 조합한다. plan write 도메인은 training/nutrition/recovery/routine_schedule로 제한하고, 변경되는 도메인 version·read dependencies·승인·outbox의 transaction을 확장한다. 일반 실제 기록 command와 plan approval은 분리한다. 알림만 끄는 것은 계획 취소가 아니다.

반응형 renderer 밖에서 step/선택/좌우/timer/미전송 상태를 보존한다. Kit 라이브러리 추가 설치는 이번 작업에서 수행하지 않았다. 세부 계약은 [09](09_routines_stretching_recovery.md)와 [extensions-v023.contracts.ts](extensions-v023.contracts.ts)이며 새 schemaVersion=4는 기존 schema와 명시적으로 변환해야 한다.
