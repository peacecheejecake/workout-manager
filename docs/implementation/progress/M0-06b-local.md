# M0-06b-local · UI·지도 로컬 수용 근거

2026-10-09. 상태: **수용 근거 연결 중; 완료 미판정**. 감사 기준 HEAD는 `0fb7a1f1fb503a10a28eadebea523c919873d632`다. 이 기록은 읽기 전용 metadata 검사와 기존 실제 증거의 범위를 연결한다. 새 브라우저·빌드·DB·실기기 시험은 실행하지 않았다. graph/HANDOFF와 기존 실패 판정은 변경하지 않는다.

## 수용 범위

[M0-06b](M0-06b.md)의 비실기기 adapter 호환성·라이선스·coverage·두 shell 브라우저 수용을 분리한다. [FUT-03](../../.pre/06_follow_up_backlog.md#fut-03)의 후보별 설치/peer/SSR/client 경계, 정확 버전·라이선스·비용, 조합 화면, Next/Vite, 실패·대체 ADR 기준을 보존한다. 지정 Vercel React Best Practices와 Composition Patterns 및 `bundle-conditional`/`state-decouple-implementation`을 읽었다. 이번에는 UI를 수정하지 않았다.

실제 제품의 물리 touch/viewport/IME/back/offline/lifecycle/성능은 [최종 제품 계획](../device-validation-plan.md)의 `M3-03b`, 제품 HealthKit 전체 경로는 `M3-02h`다. 공개 ODbL 응답·활성 산출물 재빌드·운영 위치 로그/보존은 `EXT-HOSTING`이다. standalone 시험 앱 작업은 중단 상태다. 이 분리는 원 수용 조건을 통과·제외로 바꾸지 않는다.

## 기준 → 현재 입력 → 실제 증거 → 남은 범위

| 기준                                         | 현재 입력 및 확인                                                                                                                                                                          | 실제 기존 증거                                                                                                                                                                     | 남은 정확한 범위                                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 6개 실행 후보의 조합·lazy/SSR 경계           | ui-spike package와 workspace/map/data/interaction/routing/CSS 7파일은 M0 검토 HEAD `4b3be69f0af3f3a5003b3feafc209f5b8ced71c7`와 byte 동일                                                  | [M0 실행 기록](M0-06b.md#구현-범위)의 Next/Vite/Storybook build, 조합 E2E, Aside 실제 조작                                                                                         | 최신 shell package/Next config는 달라 과거 host 전체 입력 동일성은 주장하지 않는다. 전체 후보 disposition은 아래 표 참조 |
| reflow·keyboard·draft 유지·pointer 취소·대안 | `tests/shells/ui-spike.spec.ts` SHA `658a5a6b71ec1b060c8eff8ac9cf0a6e3e3f89faf8436d7a24205021276286e0`; 역사와 동일                                                                        | [브라우저 기록](M0-06b.md#브라우저-확인과-남은-검증): 320/767/768/1279/1280, focus/composition 모사, Escape/resize 취소·버튼 대안·Aside 두 shell                                   | 실제 OS 조합/손가락은 별도 gate. 최신 host와 해당 fixture의 실제 실행 핀 연결은 이번에 미확인                            |
| worker/CSP/WebGL 실패/해제·재생성            | MapLibre 6.9.1, same-origin worker/shared ESM; 설치 원본과 Next public/Vite public/Vite dist의 worker/shared/LICENSE 9개 모두 byte 동일                                                    | shell spec의 실제 software WebGL·외부 tile0·해제/재생성·좌표 대안, [역사 기록](M0-06b.md#빌드와-경계)                                                                              | 물리 GPU·native memory 증거로 확대하지 않는다. 현재 실제 HTTP worker/CSP 응답은 미실행                                   |
| 정확한 dependency/license closure            | 읽기 전용 collector로 현재 production+installed peers **101 packages**, 필수 미해결0. 과거 inventory의 packages/notice hashes/licenses/optional peer와 정확 동일                           | [inventory](../research/ui-spike-license-inventory.json), [검토 및 배포고지](../research/ui-spike-license-review.md#배포-고지-후속-구현)                                           | 전체 lock SHA는 변경됐지만 relevant closure는 실제 동일성 확인. 전체 앱·유료 extension·법적 승인은 이 inventory 범위 밖  |
| 배포 고지와 보충 본문                        | Next public/Vite public/Vite dist의 `THIRD_PARTY_NOTICES.txt` 각149988bytes 및 manifest가 각각 byte 동일. generator SHA `3022f256d4a471869a7d8ece2a82f20bf22777407e2a4310acf043bcabb59ee7` | 역사 Aside 응답200·동일바이트, 단위6, 두 shell E2E24; murmurhash README MIT 및 ECharts 하위 고지 수록                                                                              | 이번 검사는 기존 산출물 읽기다. 새 생성·서빙을 실행하지 않았다. 최종 native bundle 동봉은 실제 제품 준비에서 확인        |
| 한국 보행 coverage                           | graph/기준/표본 identity를 가진 후속 문서                                                                                                                                                  | [M2-01az](M2-01az.md): 실제 엔진2회, 별도 독립 채점75.5/82 adequate, 필수23층·실격0, phase APPROVE                                                                                 | 원 P8 failed68/82와 ay inadequate 유지. 이 평가와 다른 활성 graph를 인증하지 않는다. 운영 identity 대응은 EXT-HOSTING    |
| 로컬 ODbL disclosure/원문/GPX                | identity·URI·본문 SHA·경로 포함·symlink·index bound·고지 source 존재                                                                                                                       | [places](M0-06b-odbl-places.md) Chrome/Playwright 두 shell 및 outside-region 회귀; [scripts](M0-06b-odbl-scripts.md) fixture4/4; [GPX](M0-06b-odbl-gpx.md)32/32와 mutant 실패/복원 | 공개 HTTPS·활성 산출물 재빌드·운영 고지 누락/503는 EXT-HOSTING. 로컬 fixture로 이를 통과 처리하지 않음                   |

## FUT-03 전체 후보의 현재 disposition

아래 “미채택”은 저장소 package manifest의 직접 의존성이 없다는 관측이다. 실패한 라이브러리·승인된 대체 ADR이라는 뜻이 아니다. 요구된 기능의 자체 구현과 후보 선택 수용은 별개다. 공통 제품 소스를 임의 교체하지 않는다.

| 기능 / 원 후보                       | 현재 설치·소유 구현                                                    | disposition 및 증거 경계                                                                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| DnD / dnd-kit                        | ui-spike `@dnd-kit/react`0.5.0 + dom0.5.0                              | 채택, keyboard/pointer/cancel/버튼의 실제 로컬 증거 있음; physical 충돌은 M3-03b                                                          |
| 분할 / react-resizable-panels        | ui-spike4.12.4                                                         | 채택, keyboard resize·draft/focus·겹침 회귀 증거 있음                                                                                     |
| Dashboard / react-grid-layout        | 직접 의존성 없음; modules/dashboard layout store/editor/drag 소유 구현 | 후보 미채택; 선택·대체 ADR와 responsive/save/restore evidence 연결 미확인                                                                 |
| Chart / ECharts                      | ui-spike6.1.0                                                          | 채택, SVG zoom/표 연계/resize/dispose·1000행 증거; low-end performance 아님                                                               |
| Table / TanStack Table               | ui-spike9.2.4                                                          | 채택, controlled sort/filter/selection/null0·1000행 증거. 이 fixture는 virtualization 검증 아님; 제품 필요 범위는 별도 노드 evidence 연결 |
| Primitives / Radix                   | 직접 의존성 없음; ui/foundation 및 소유 모듈의 native/ARIA controls    | 후보 미채택; portal/focus 등 후보 기준에 대한 선택·대체 기록 미확인                                                                       |
| Editor / Tiptap                      | ui-spike core/react/pm/starter-kit3.31.3                               | 채택, formatting/undo/JSON/literal 문자열·composition 모사; 물리 IME 별도                                                                 |
| Carousel / Embla                     | 직접 의존성 없음                                                       | 후보 미채택; 필요 기능/대체/범위 disposition 미확인                                                                                       |
| Gallery / Yet Another React Lightbox | 직접 의존성 없음; modules/gallery 자체 preview/workspace               | 후보 미채택; private asset·codec/focus 실제 제품 증거와 선택 ADR 연결 필요                                                                |
| Map / MapLibre                       | ui-spike 및 geo-kit6.9.1                                               | 채택, worker/CSP/실패 대안·style/해제 검증. cooperative gesture 정책은 제품 실기기에서 확인                                               |
| Video / Media Chrome                 | 직접 의존성 없음; gallery media-preview HTML video                     | Media Chrome 미채택; HTML video 선택의 inline/fullscreen/error/codec evidence·대체 기록 연결 필요                                         |
| Conversation / assistant-ui          | 직접 의존성 없음; modules/coaching 자체 UI                             | 후보 미채택; authoritative store/streaming/승인 분리 evidence·선택기록 연결 필요                                                          |
| Calendar / FullCalendar              | 직접 의존성 없음; modules/planning 자체 planner kernel/view            | 후보 미채택; standard/premium·calendar/table 공유 상태의 선택기록 연결 필요                                                               |
| Circular / React SVG + D3 hierarchy  | D3 hierarchy 직접 의존성 없음; 제품 period navigation 소유 구현        | React SVG와 D3 후보를 구분해 선택/목록 대안/부모 복귀 evidence 연결 필요                                                                  |
| Date / React DayPicker               | 직접 의존성 없음; 제품 native date fields                              | 후보 미채택; timezone/locale/null/keyboard 수용·대체 기록 연결 필요                                                                       |
| Motion / Motion                      | 직접 의존성 없음                                                       | 후보 미채택; 필요한 transition/reduced-motion·DnD transform 범위 또는 미사용 disposition 연결 필요                                        |

후보 이름을 반드시 설치해야 한다는 판단은 하지 않는다. 반대로 현재 이름이 없다는 이유로 원 기능 기준을 삭제하지 않는다. 위 미확인 항목은 Root가 기존 owning phase의 실제 수용·선택 문서를 먼저 연결하고, 기록/구현 공백만 bounded task로 배정할 대상이다.

## 현재 읽기 전용 검사의 실제 결과

Node `v24.12.0`으로 `collectUiLicenseInventory()` 공개 읽기 함수를 import해 실행했다. 쓰기를 하는 CLI main은 실행하지 않았다. 현재101 package와 과거 inventory의 relevant tuple/notice/license 목록은 정확 동일, optional `zustand@5.0.15 → immer` 부재는 기존과 동일했다. murmurhash root notice 부재는 역사값이며 README MIT 보충으로 해소되어 새 누락으로 분류하지 않는다.

- TMP closure: `/private/tmp/wm-m006b-local-current-ui-license-closure-20261009.json`, SHA `5011f68550a331d60f648c7f0a4724deb5ea430805719585c1360cb94d5da5bd`.
- TMP worker/notice 사본: `/private/tmp/wm-m006b-local-current-generated-assets-20261009.json`, SHA `5dad7d179a88ab45c439e467bbef96925c4002b86d63413c44ca3264e47172da`.
- 전체 현재 lock SHA `7beb121b136689045950ef47b9a04a94bf6a6010e5941481913b1b0841fd477a`; 최초 inventory lock SHA `9447d64cecdb72846471ef9d07e050df4428f07e9a8fcad97367c16d07b56b69`. 전체 lock 변경 자체를 relevant closure 실패로 오인하지 않는다.
- 역사와 byte 동일: ui-spike workspace/map/data/interaction/routing/CSS/package, shellspec, map-data-licence spec, geo-kit maplibre-adapter, noticegenerator. 전체 전이 host 입력은 같은 것으로 주장하지 않는다.

## 남은 실행안 — 제안만, 아직 실행하지 않음

최신 브라우저 evidence가 해당 current fixture+host/build/worker/notice 입력을 핀한다면 재사용한다. 없는 경우 nutrition 진단 종료 및 Root의 실행 승인 후 기존 **제품 두 shell** 설정을 사용한다:

```bash
pnpm exec playwright test --config=playwright.shells.config.ts tests/shells/ui-spike.spec.ts
```

기존 next-desktop/vite-mobile 두 project·worker/timeout/retries/reflow assertion을 유지한다. 이 파일은 standalone iPhone 시험 앱이 아니다. build가 stale라면 현재 source를 변경하지 않고 Root 소유 build gate를 먼저 확인한다. 기존 일반 identity의 licence spec은 원 test-identity CLI·general recipe·두 Host로 선택 실행하는 안을 Root가 별도 확정한다. 새로운 shared runner/config를 만들거나 fixture응답을 실호스팅 증거로 사용하지 않는다. Aside는 변경 UI 검증 시 지정순서대로 확인하며 도구실패/Chrome/Playwright 범위를 기록한다. 이번에는 UI 변경·Aside 실행이 없었다.

현 시점 실행 가능한 다음 작업은 (1) 위10개 미채택 후보의 실제 선택/대체 ADR 및 제품 기준 evidence 연결, (2) current host 브라우저 입력핀·결과 연결 또는 위 좁은 기존시험 실행이다. 확인된 제품 버그 없이 source patch를 강요하지 않는다. 모든 로컬 기준이 연결되기 전에는 M0-06b-local 완료나 부모 M0-06b 통과를 선언하지 않는다.

## 후속 후보 추적 · 구현을 후보 설치와 구분

아래는 current 제품 소유 구현에 연결되는 기존 수용 범위다. 후보 라이브러리를 반드시 설치할 새 조건을 만들지 않는다. 공식 후보 배제 ADR은 찾지 못한 경우 그대로 미확인이다.

| 미채택 후보                | 기존 제품/설계 수용 연결                                                               | 확인된 범위와 남은 기능                                                                                                                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| react-grid-layout          | [M1-04v](M1-04v.md), dashboard-layout/store/editor/drag                                | 자체 allowlist 배치·mode별 크기·명시 적용/취소/초기화·사용자별 저장/복원·breakpoint 취소, 실제 두 shell E2E4 및 Aside 기록. 라이브러리 미설치를 기능 미구현으로 분류하지 않음. 고정4 widget 이후 기능은 해당 node 밖              |
| Radix                      | ui-foundation button/text-field/status/adaptive-workspace; 소유 모듈 semantic controls | 전체 Radix 후보의 portal/dialog/tooltip/slider 수용을 이 primitives만으로 완료 주장하지 않음. 요구된 각 interaction의 owning node 연결은 남아 있음                                                                                |
| Embla                      | 현재 dependency/import 부재                                                            | 독립 carousel/swipe/중첩 스크롤 구현·수용 근거를 찾지 못함. 요구가 있는 화면과 현재 대체 동작을 Root가 먼저 확정할 대상                                                                                                           |
| Yet Another React Lightbox | [M2-03](M2-03.md), gallery-workspace/media-preview                                     | 자체 private byte/Blob 수명·목록·preview·paging·계정/삭제 수용은 있음. M2-03의 남은 gate가 실제 video decoder, caption/speed/fullscreen viewer/thumbnail/transcoding 미구현을 명시. 이 기능 공백을 후보 이름 부재와 혼동하지 않음 |
| Media Chrome               | 같은 M2-03, HTML video controls                                                        | 기존 HTML video preview만. source의 `<video controls preload="none">`를 iOS inline/fullscreen·자막·codec 수용으로 읽지 않음. 로컬 full viewer 요구는 실제 gap, 물리 재생 차이는 M3-03b                                            |
| assistant-ui               | [M2-05](M2-05.md), modules/coaching owning UI·후보 승인 경계                           | 실제 인용/ACL/삭제/후보 승인 guard의 수용은 존재. 전체 external-store streaming/tool conversation interaction와 assistant-ui 대체 선정은 해당 자료로 미확인; 제품 의미를 라이브러리 설치만으로 해결하지 않음                      |
| FullCalendar               | [M1-04n](M1-04n.md), [M1-04o](M1-04o.md), [M1-04t](M1-04t.md), planned-session-views   | 자체 kernel/calendar/table/agenda 동일 선택·draft·40:60/container 전환·pointer 날짜 이동/숫자 대안·명시 저장, 실제 두 shell OIDC/DB 및 Aside 기록. premium 기능 채택 증거는 없으며 비용 발생을 추정하지 않음                      |
| D3 hierarchy               | [M1-04am](M1-04am.md), period-orbit/period-explorer/navigation                         | 자체 React SVG 원형·키보드/목록/타임라인·기간 lens 링크의 기록을 재사용. D3 설치는 없고 SVG 구현을 D3 runtime 검사라고 표시하지 않음                                                                                              |
| React DayPicker            | M1-04t의 실제 move-to-date 입력·날짜/잠금/unknown semantics, native date input source  | 필요한 날짜 입력의 직접 구현과 실제 keyboard/focus/저장 수용은 있음. DatePicker의 전체 locale/range interaction 후보 실험은 미확인; 요구된 제품 범위를 별도 연결                                                                  |
| Motion                     | ui-foundation/tokens.css `prefers-reduced-motion:reduce` 및 실제 owning gesture 취소   | CSS 감소 규칙 존재는 Motion 검증 아님. Motion 미사용 자체는 결함이 아니며 실제 필요한 animation/transform conflict scope만 확인해야 함                                                                                            |

FUT-03의 디자인 후보 표와 현재 자체 구현 사이에는 선택 이유/대체 범위가 명시된 단일 연결 문서가 없다. 이 index가 존재 사실과 이미 실제 수용된 기능을 연결하지만, 미실행 carousel·전체 gallery/video viewer·conversation streaming 등을 완료로 바꾸지 않는다. Root가 기존 scope/요구 기준으로 필요한 구현 task를 배정해야 하며, 미채택10개 모두 설치하는 방안은 제안하지 않는다.

## 실행 전 제출한 기존 두 shell runner

실제 실행은 Root GO 전까지 하지 않는다. TMP runner는 정확한 기존 config/spec 및 `--reporter=json`을 사용하고 artifact 경로만 own TMP로 옮긴다. original project/fullyParallel/workers/test timeout/retries가 유지된다. CI가 설정되어 config retries가 달라질 환경은 실행 전에 거절한다. expected roster는 원7개 literal case와 viewport/container resize2개, 두 project 각각9개로 **18개 exact title multiset**이다. stdout64MiB/stderr8MiB 상한·해시 후 원문 폐기, report에는 알려진 title/project/status/duration/retry/errorPresent와 통계만 남긴다. raw error·응답·URL/body를 기록하지 않는다. 실패는 자동 재시도하지 않는다.

입력 scope는 현재 web/mobile-web source와 build, browser module/kit/UI/platform/contracts/api-client, lock/config/test 및 worker/notice scripts다. API agent의 새 API test/docs는 제외된다. `.next/cache`, `.next/trace` 및 test-output은 runtime generated output으로 입력에서 제외한다. Node24/PATH와 pnpm 실제 실행 경로를 고정한다. build를 실행하거나 소스를 변경하지 않는다. 시작 전 3100/4200이 free라는 실제 TCP observation이 필요하며 ECONNREFUSED만 free, permission/timeout은 unknown이다. 종료 뒤 같은 ports가 닫혀야 수용한다. Playwright의 own webServer lifecycle만 사용하고 기존/unknown PID를 kill하지 않는다.

- source/build 입력 **2171 files**. TMP manifest `wm-m006b-local-shells-current-r3-inputs-20261009.json`, SHA `412b5871e72c4bbd3dd486ffbc76fc8f7ff88ec9521e0ffca8776dda63bd81c9`.
- 제한 sandbox의 r2 port observation은 두 port `unknown`이었다. 이를 서비스 실패나 free로 판정하지 않았다. 승인된 read-only loopback 관측의 r3에서 **3100/4200 둘 다 free**를 확인했다. 원 r1/r2 준비 기록은 보존한다.
- runner 문법 `node --check`는 통과했다. 아직 브라우저 test process는 시작하지 않았다. run은 독립 manifest literal SHA와 `root-go-m006b-local-shells`가 있어야 가능하다.

## 최신 두 shell 실제 수용 · 2026-10-09

Root가 runner 원형과 generated-output 제외 diff를 검토하고 실행을 승인했다. 원 runner/manifest는 보존하고 v2는 `.turbo` 디렉터리 및 `apps/web/.next/diagnostics`만 추가로 제외했다. 2171→2146에서 제외25개는 그 두 범위뿐이며 기존 입력 변경0·추가0, worker/notice 핀은 유지했다. Root의 postbuild canonical freeze와 source/build 교집합이 동일하고, 별도 worker/notice 대응은 앞의 실제 설치 원본 비교가 결속한다. build를 다시 만들거나 소스를 변경하지 않았다.

| 항목          | 실제 결과                                                                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 실행          | 기존 `pnpm exec playwright test --config=playwright.shells.config.ts tests/shells/ui-spike.spec.ts --reporter=json`, artifact output만 own TMP                         |
| Node / 조건   | v24.12.0, 원 두 project·fullyParallel/workers/timeout 유지, CI 미설정·retry0                                                                                           |
| terminal      | **exit0 / 18 passed / 0 skipped / 0 failed / 0 flaky / retry0**                                                                                                        |
| roster        | next-desktop9 + vite-mobile9, 원9개 title multiset 각각 정확일치                                                                                                       |
| 시간          | actor31907ms, Playwright30454ms                                                                                                                                        |
| 입력          | manifest SHA `855673bb1bd7f2ba574729cebb8185059c45a5170b365d86cc77d19b8048bcba`; source/build **2146개 pre/post 동일**                                                 |
| 자원          | 시작 전3100/4200 free, terminal 후 두 port closed; Playwright own webServer lifecycle, unknown PID 강제종료0                                                           |
| privacy       | stdout22129bytes SHA `d708dc4bd91fcffb8f01f96108af0b99d266945be078fa444d4d122facb4312b`, stderr0bytes. 원문은 메모리 parse·hash 후 폐기, response/URL/error body 저장0 |
| actual record | `/private/tmp/wm-m006b-local-shells-v2-actual-20261009-result.json`, SHA `b3833c0125c2f897aaa3bf1afbcf82d0c283204e6f9d415aa0241656905d758f`                            |

이 최신 결과는 조합·reflow·worker/CSP·라이브러리 interaction의 기존 **로컬 두 shell 브라우저** 공백을 닫는다. 기존 historical Aside 직접 관측은 그대로 보존한다. 이번 도구는 Playwright이며 Aside를 새로 실행했다고 주장하지 않는다. physical GPU/OS IME/native gesture·성능 또는 공개 license endpoint 수용으로 확대하지 않는다. standalone iPhone 합성 앱 실행은 없었다.

새 UI source 결함은 이18개에서 관측되지 않았다. 남은 정확한 판단은 FUT-03의 미채택 후보별 자체 구현 범위/명시 선택·대체 기록, 기존 M2-03의 full viewer·caption/speed/codec 등 실제 제품 기능 공백과 carousel/conversation streaming 요구의 소유 node 연결이다. 현재 owning 기능 수용이 있는 항목을 새 라이브러리 설치 task로 확대하지 않는다. 이 문서는 local 전체 완료를 스스로 선언하지 않으며 Root가 기존 요구와 disposition을 검토한 뒤 상태를 판정한다.

## 추가 구현 수용 연결 · 2026-10-09

위 최초 감사/후보 표는 역사 입력에 대한 기록이다. 후속 `phase/m0-06b` HEAD `f7849f268edd04f1d4c6e9e99112aa7df2e37be3`에서 다음 실제 구현과 검증이 추가됐다. 아직 main에 통합되지 않았고 전체 M0/local 완료 판정도 아니다.

| 수용 범위                    | owning 구현/기록                                                                                                                 | 실제 추가 검증                                          | 남은 범위                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Conversation presentation    | `6021bf48`, conversation-kit와 coaching 소비자; 해당 phase의 `M0-06b-conversation-consumer.md`                                   | kit/consumer 28/28·두 host 2/2                          | 실제 token streaming/tool-result producer 연결·후보 선택 근거·전체 phase/기기 |
| Dialog/tooltip/dropdown 조합 | `7deae951`, ui-foundation 및 lazy overlay consumer; `M0-06b-overlay-composition.md`                                              | 두 host 14/14; 이전 두 10통과/4실패 결과 보존           | 제품 기기 수용, slider의 기존 owning 기능/시험 연결 및 전체 phase             |
| Table virtualization         | `eb5b6e2a` public table-kit, `f7849f26` controlled 10k consumer; `M0-06b-table-kit.md`·`M0-06b-table-virtualization-consumer.md` | kit/planning 32/32·두 host 10/10; 이전 8통과/2실패 보존 | 현재 dependency/license closure 재대조·전체 phase·최종 제품 기기              |

10k 시험은 전체 DOM 읽기 대안, 동적 높이·scroll/focus·정렬/검색·null/zero·viewport 경계와 emulated touch를 실제 검증했다. 현 추가 수용을 원 18개 조합/현재 모든 shell 입력의 전체 회귀, 실기기 또는 외부 운영 gate로 확대하지 않는다. 새 table-kit은 이미 고정된 virtual-core 3.17.11을 사용하지만 과거 101-package closure 동일성을 새 importer까지 자동 적용하지 않는다. 정확 closure/고지 재대조가 필요하다.

Gallery viewer·caption/speed/fullscreen·carousel·파생물의 제품 저장/worker/권한/복원 연결은 M2-03a~c에서 계속 구현한다. Historical core completed를 전체 S17 또는 M0의 남은 기능 완료로 세지 않는다. 전체 phase install/generated/lint/typecheck/build/unit/integration/identity×2/format과 context-less 독립 phase 검토는 별도이며 main/push 경계는 유지한다.

## 후속 closure와 streaming store · 2026-10-09

`phase/m0-06b`의 `2fefc6f1`에서 위 추가 table importer의 dependency/license closure를 실제 재대조했다. 현재 103 packages(외부 100), 기존 101개의 metadata/notice SHA 불변, 추가 table-kit/virtual-core 두 항목, required unresolved 0이다. 새 inventory SHA는 `ab1c916463f0c839fe232cafb0dbbf6362cfc7e47eaba600faeb9dd91458c595`이며 Web/mobile-web/Storybook의 notice manifest 전체와 bundle hash가 모두 정확 일치했다. 해당 phase의 `M0-06b-license-closure-20261009.md`를 따른다. 앞 표의 재대조 필요는 이 후속 로컬 범위에서 해소됐으며 전체 법률/지도 데이터 권한 수용으로 확대하지 않는다.

`a216daa3`은 호출별 external store의 provisional text/read-only tool result 실험을 추가했다. Root가 기본 Vitest node 수집에서 15/15·skip 0 및 kit TS/lint/format을 확인했다. account/session/run/attempt와 순서·bounds·dispose를 구분한다. 실제 provider/token/tool 전송·서버 권한/동의/lease·승인 적용은 미구현이며 React 소비자/브라우저 통합은 진행 중이다. 이 순수 시험을 제품 streaming 완료로 세지 않는다. 기존 후보/조합 시험과 미실행 최종 제품 실기기 gate는 유지한다.
