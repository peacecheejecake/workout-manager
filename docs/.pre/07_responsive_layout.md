# 07 · 반응형 레이아웃·상호작용·검증 명세 v0.2.3

> v0.2.3 · 2026-09-16: [09 루틴·스트레칭·회복 전략](09_routines_stretching_recovery.md)과 S31~S35, FUT-13~15, V023 요구·시험을 추가했다. 기존 계약·이력은 유지하며 신규 기능은 아직 미구현이다. 아래 이전 버전 설명은 당시 기준이며 새 범위는 09와 05 §11을 따른다.

기준일: 2026-09-16 · 상태: 구현을 위한 명세. 기존 HTML이나 production React 화면에 적용한 결과가 아니다.

## 1. 검토 결과와 적용 범위

기존 [03 디자인 시스템 §9](03_design_system.md)는 Mobile <768 / Tablet 768~1279 / Desktop 1280+ 및 4/8/12-column을 이미 제안했다. 기존 02·05에는 WebView, touch, overflow, 모바일 검사 요구도 있었다. 부족했던 것은 경계값의 정확한 의미, 화면별 tablet 동작, 좁은 모듈 컨테이너, 상태 유지, 경계·회전·확대 테스트였다. **기존 768/1280 기준을 유지하면서 명시적 계약으로 보완**한다.

대상은 S01~S35 전 화면, Experience Kits, 로그인 전 화면, 브라우저와 native WebView다. 별도 모바일 도메인 구현을 만들지 않는다. 페이지 크기만 줄이는 것이 아니라 정보의 순서·밀도·표현을 바꾸되, 기록 등록·편집·삭제·상담·승인의 핵심 기능을 없애지 않는다.

## 2. Breakpoint 계약

`W`는 하드웨어 해상도나 User-Agent 분류가 아닌 **CSS layout viewport의 너비**다. 범위는 소수 CSS px에서도 빈틈 없이 적용한다. 단위는 CSS px다.

| 이름 | 정확한 범위 | 기본 grid | 페이지 여백 / gap 초안 | 내비게이션 | 코치 기본값 |
|---|---|---|---|---|---|
| Mobile | W < 768 | 4-column; 업무 본문 1열 | 16 / 12 | 하단 5개 목적지 + 더보기 | 전용 화면 또는 full-height sheet |
| Tablet | 768 ≤ W < 1280 | 8-column; 업무별 1~2열 | 24 / 16 | compact rail, 전체 메뉴 drawer | overlay drawer; 상시 3열 금지 |
| Desktop | W ≥ 1280 | 12-column; 본문 + 보조 영역 | 32 / 24 | sidebar; 접기 지원 | 공간이 충분하면 dock, 아니면 drawer |

기준점은 768px·1280px 두 개이며 그 사이로 세 layout mode를 만든다. 1920px 이상을 별도 기능 분기로 만들지 않고 workspace max-width 1600px을 시작값으로 둔다. 지도·정밀 데이터 작업은 명시적인 확장 보기로 최대 폭 제한을 풀 수 있다. 배경은 full-bleed여도 본문 줄 길이는 제한한다.

최소 reflow 검사는 320 CSS px에서 수행한다. 320px 미만에서도 가능한 자연스러운 wrap을 유지하며 min-width로 페이지를 강제 확대하지 않는다. 320은 네 번째 breakpoint가 아니라 접근성 검사점이다. W3C reflow의 일반 콘텐츠와 표·지도처럼 본질적으로 2차원인 콘텐츠의 예외를 구분한다.[R01](sources-v022.md#r01)

### 2.1 정의의 단일 원본

[responsive-spec.json](responsive-spec.json)을 값의 기계 판독 원본으로 둔다. 구현 시 이 파일에서 CSS media query·TypeScript layout constants·Storybook viewport·Playwright boundary fixture를 생성한다. 이번에는 JSON 명세만 추가했으며 generator나 앱 적용은 미구현이다. 각 모듈에 767/768/1279/1280을 수작업 중복하지 않는다.

CSS는 mobile-first를 기본으로 한다. 아래는 구현 형태를 설명한 예이며 기존 prototype에 적용하지 않았다.

```css
/* Generated thresholds: source = responsive-spec.json */
.app-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); }
@media (min-width: 768px) {
  .app-grid { grid-template-columns: repeat(8, minmax(0, 1fr)); }
}
@media (min-width: 1280px) {
  .app-grid { grid-template-columns: repeat(12, minmax(0, 1fr)); }
}
```

## 3. Viewport와 module container를 나눈다

Shell의 내비게이션·페이지 여백은 viewport로 결정한다. Module/Kit의 한 열·두 열, table/card, toolbar 접힘은 **실제 할당된 컨테이너 폭**으로 결정한다. Container query는 viewport 대신 containing element 크기에 반응하는 기능이므로, 같은 모듈을 전체 페이지와 작은 패널에 재사용할 때 적합하다.[R02](sources-v022.md#r02)

| module container 폭 | 기본 동작 |
|---|---|
| <560px (`compact`) | 상세 필드 세로 배치, card/agenda, toolbar 메뉴, 보조 설명 접기 |
| 560~959.999…px (`standard`) | 읽기 쉬운 1~2열 폼, 목록+간결한 요약, split은 기본 비활성 |
| ≥960px (`workspace`) | calendar/table 또는 chart/table split 검토, 최소 pane 폭 유지 |

이 숫자는 전역 기기 breakpoint가 아닌 component 조합의 시작값이다. 특수 kit는 근거와 최소 폭을 명시해 별도 container 조건을 정의할 수 있다. 브라우저·WebView 버전별 지원 검증 및 단일 열 fallback을 둔다.

Desktop 1440px 안의 420px 코치 패널은 compact다. 가로 tablet이 1280px에 도달하면 Desktop layout을 쓸 수 있지만 **터치 입력은 여전히 터치**다. `pointer/hover` capability는 layout mode와 별개다. User-Agent로 tablet=touch, desktop=mouse를 고정하지 않는다.

## 4. 화면별 반응형 배치

| 화면 | Mobile | Tablet | Desktop |
|---|---|---|---|
| Dashboard S03 | 오늘→체크인→영양/보강 요약→rolling→가까운 일정 순; 세로 stack | 2열 카드, 상세는 drawer | main+context; widget 재배치, 필요시 coach dock |
| Period/Orbit S04 | ring+동등한 목록, 선택 후 agenda | ring+기간 요약, 달력 별도 보기 | ring+calendar/table, 폭 부족 시 단일 보기 |
| Planner S05 | agenda 기본; 달력/표 전환은 가능 | 달력/표 전환 기본; container가 960 이상일 때 split 선택 | split 우선, 좁은 pane에서는 tabs로 내려감 |
| Session editor S06 | 한 열, 섹션 구분, 저장 동작 가시성 | 주 필드+요약; 접촉·무게 단위 명확 | 편집+검증 미리보기; 루틴 builder 연계 |
| Activity list S07/S08 | 요약 card와 전체 table 전환, quick-add | 핵심 열+세부 drawer | 가상화 table, 필터 rail 선택 |
| Activity workbench S09 | chart/route/lap/sets 탭; 필요할 때 mount | chart+table 또는 지도 보기; 3개 동시 강제 없음 | linked split-pane, 선택·zoom 공유 |
| Coach/Proposal S10/S11 | 대화/근거/변경 탭, 후보는 하나씩 읽되 전체 영향 요약 | 대화+drawer, 후보 비교는 별도 workspace | context/chat/evidence를 가용 폭에 맞춰 조합 |
| Wellbeing S12 | 보고·지표·한계 순, 카드 | 2열 + 상세 | 추세·방법론 비교, 임의 종합점수 없음 |
| Courses S13/S14 | 지도+경유점 sheet, 전체 목록 대안 | 지도+접히는 경유점 목록 | 지도+list+세부 정보; 각 최소 폭 검증 |
| Races/Records S15/S16 | card→상세 | 요약 table+drawer | 비교 table+세부 패널 |
| Gallery S17 | 2열 시작, cell min폭에 따라 1열; swipe+버튼 | container에 맞춘 grid | grid+lightbox; 키보드 조작 |
| Resources S18/S19 | 목록→reader→인용 drawer | 목록/reader 전환 또는 2열 | 목록+reader, 인용/주석은 필요시 패널 |
| Account/Settings/Sync S20~S24 | 한 열; 실패/동의/삭제 문구 생략 안 함 | list-detail 가능 | 설정 navigation+본문, 표는 자체 overflow |
| Nutrition overview S25 | 오늘 식사·보급·수분, 빠른 실제 기록 | 요약+섭취 timeline | 계획/실제/훈련 문맥, coach dock 가능 |
| Nutrition plan S26 | 시간순 card와 식사/훈련 전·중·후 전환 | timeline+편집 drawer | 통합 planner+영양 target editor |
| Intake logs S27 | 최근 항목·간편 수량/단위 입력, 실제 확인 | 목록+편집 | 일별 표·plan 대비·출처 |
| Supplementary S28/S29 | 루틴 card, 동작 설명과 미디어 | 루틴 목록+builder/상세 | 동작 library+루틴 builder+세트 요약 |
| Workout execution S30 | 한 번에 현재 동작·세트, 큰 완료/수정 버튼 | 세트표+현재 동작 | 전체 세트표+세부 기록, 동일 실제 데이터 |

로그인·온보딩은 모든 크기에서 읽기 폭을 제한한 폼으로 유지한다. 모바일 하단 탭을 영양·보강 추가로 7~8개로 늘리지 않는다. `오늘` quick action·통합 Planner 필터·`더보기`에서 접근하며 모든 상세 URL을 유지한다.

## 5. 상태·URL·focus의 연속성

`requestedView`(사용자 선택)와 `effectiveView`(가용 공간에 맞춘 표현)를 구분한다. URL의 `view=split`이 좁은 화면에서 tabs로 보이더라도 원래 선택을 잃지 않는다. 다시 넓어지면 사용자가 선택한 split과 pane 비율을 복구하되 최소 폭을 재검사한다.

Resize·회전·split-screen 전환으로 draft, 선택 날짜/세션/섭취 항목, scroll anchor, 차트 range, 현재 set, 실행 timer, 입력 내용이 초기화되어서는 안 된다. 상태는 viewport별 렌더러 밖의 동일 module store에 둔다. React tree 전환 시 focus를 같은 semantic control로 복원하고, 없으면 안정적인 섹션 제목/launcher로 옮긴다.

숨긴 dialog/drawer는 focusable하지 않아야 한다. 중복 desktop/mobile DOM을 모두 띄워 ID·tab order·screen-reader 내용을 중복시키지 않는다. Resize 중 실행 중인 drag는 취소하고 draft 이전 상태를 유지하며 저장 요청을 발생시키지 않는다.

SSR는 초기 HTML을 CSS로 재배치하는 것을 우선한다. viewport를 모르는 서버와 클라이언트가 서로 다른 초기 DOM을 임의 렌더링하지 않는다. 비싼 지도·editor·player의 mount 여부는 hydration 이후 capability와 visible view로 판단하고 이 과정에서 초안을 보존한다.

## 6. Touch·키보드·가로 화면·WebView

영양 수량, kg, 반복 수, 시간은 의미에 맞는 inputMode를 사용하고 소수점·locale을 runtime에서 검증한다. IME composition 중 Enter를 저장/메시지 전송으로 처리하지 않는다. 현재 set 완료·섭취 확인처럼 되돌릴 수 있는 입력과 최종 계획 승인을 구분한다.

주요 버튼의 **제품 목표**는 최소 44×44 CSS px, 빠른 set 기록·실수하기 쉬운 action은 48px 높이를 시작값으로 한다. 이것은 WCAG AA의 최소 target 크기(예외가 있는 24×24 CSS px)와 같은 주장으로 쓰지 않는다. 원형·불규칙 target은 bounding box만으로 적합성을 단정하지 않고 실제 클릭 영역과 대체 동작을 검사한다.[R03](sources-v022.md#r03)

Drag에는 tap 메뉴/숫자입력 대안을, swipe에는 이전/다음 버튼을 둔다. 키보드만 있는 대안으로 touch 사용자의 non-drag 접근을 충족했다고 간주하지 않는다.[R04](sources-v022.md#r04)

Safe-area와 동적 viewport 높이, software keyboard에 가려지지 않는 composer/저장 CTA, landscape의 낮은 높이를 시험한다. Sheet 최대 높이는 visible viewport를 넘지 않도록 하고 내부 스크롤·body scroll lock을 정확히 해제한다. zoom을 막는 viewport 설정을 사용하지 않는다.

## 7. 정보·가독성·성능

핵심 오류·수치 단위·출처·미확인 상태·승인 범위는 화면이 작다는 이유로 제거하지 않는다. 열을 숨길 때 row details나 보기 선택에서 같은 정보를 열 수 있게 한다. 표·지도 내부의 필요한 가로 이동은 허용하되 페이지 전체에 불필요한 가로 스크롤을 만들지 않는다.

Text 200%와 400% zoom/reflow를 별도로 시험한다. Glass 투명도/blur 감소와 reduced motion에서도 동일 정보를 제공한다. nutrition 목표 ring은 목표·단위·기록 충족도를 함께 표시하고 많이 섭취할수록 무조건 좋은 보상을 하지 않는다. 보강 세트 진행 ring은 실제 확인한 세트를 나타내며 생리적 안전도를 나타내지 않는다.

숨긴 chart/map/player를 계속 무제한 실행하지 않는다. ResizeObserver 결과로 필요한 chart geometry만 갱신하고 매 resize마다 API·LLM을 호출하지 않는다. Dashboard grid 배치는 mode별 저장하되 객체·순서는 공통 ID를 사용한다.

## 8. 검증 매트릭스와 완료 조건

| 축 | 필수 fixture |
|---|---|
| 폭 | 320, 360, 390, 600, **767, 768**, 820, 1024, 1180, **1279, 1280**, 1440, 1536, 1920 CSS px |
| 경계 | 767.9/768, 1279.9/1280 fractional case도 style 계산 확인 |
| 입력 | mouse, keyboard, coarse touch, tablet+trackpad, pen 가능한 경우 |
| 레이아웃 | portrait/landscape, tablet split-screen, desktop 420px module pane, drawer 열림 |
| 접근성 | 200% text, 400% zoom에서 320-equivalent, screen-reader, motion/투명도 감소 |
| lifecycle | IME/keyboard, background/foreground, tab 전환, viewport 변경 중 초안/세트/timer |
| 플랫폼 | 지원 버전의 desktop browser, iOS Safari/WKWebView, Android Chrome/WebView |

반응형 완료는 screenshot 한 장이나 overflow 검사만으로 판정하지 않는다. **세 mode에서 실제 CRUD→상담→diff→승인을 끝내는지**, 기록 중 모드가 바뀌어도 데이터가 유지되는지 확인한다. 테스트의 상세 ID는 [05 §10](05_implementation_requirements.md#v022-requirements), 실제 구현 작업은 [FUT-10](06_follow_up_backlog.md#fut-10)에서 추적한다.

이번에 추가한 것은 명세·시험 계획이다. 이전 v0.2 prototype의 60 smoke check는 이 반응형 완료 증거가 아니며 다시 실행하지 않았다.

## 9. v0.2.3 실행형 루틴·스트레칭·회복 화면

기존 viewport `<768 / 768~<1280 / ≥1280`과 container 560/960 기준을 유지한다. 이번에 breakpoint 숫자나 생성 원본 JSON을 바꾸지 않았다.

| 화면 | 모바일 | 태블릿 | 데스크톱 |
|---|---|---|---|
| S31 루틴 | 검색·카드·필터 sheet | 목록+상세 | 목록·상세·사용 이력 |
| S32 builder | 단계 editor/전체 preview 전환 | 단계 목록+editor | library·단계·배치 preview |
| S33 실행 | 현재 단계·큰 확인/중단·순서 drawer | 순서+현재 단계 | 순서·현재 단계·기록 패널 |
| S34 stretching | 동작/영상/텍스트 전환·좌우 입력 | 목록+설명/수행 | 필터·계획/실제·설명 |
| S35 recovery | 전략·관측·행동을 세로 배치 | 전략+관측 | 관측·전략 비교·실행/코치 |

Timer/선택된 branch/좌우/step/입력/미전송 로그는 renderer 밖에서 보존한다. 시각 변화·background 복귀는 timer 표시와 실제 확인을 구분하고 두 기기에서 stale 실제값을 덮지 않도록 revision을 검사한다. 화면 전환만으로 시작/완료/승인 command를 보내지 않는다. Media 없이 설명을 읽고 어떤 입력 기기로도 중단할 수 있어야 한다.

V023-A33/34는 기존 반응형 검사에 추가되는 **미실행 요구**다. 문서/타입 검사 또는 과거 prototype smoke test를 이번 실행형 UI 검증으로 취급하지 않는다.
