# 03 · Design System / Interaction / Plugins v0.2.3

> v0.2.3 · 2026-09-16: [09 루틴·스트레칭·회복 전략](09_routines_stretching_recovery.md)과 S31~S35, FUT-13~15, V023 요구·시험을 추가했다. 기존 계약·이력은 유지하며 신규 기능은 아직 미구현이다. 아래 이전 버전 설명은 당시 기준이며 새 범위는 09와 05 §11을 따른다.

> v0.2.2: 기존 768/1280 breakpoint를 유지하고 [07](07_responsive_layout.md)로 계약·검사 기준을 보완했다. 스타일·prototype 적용은 미수행이다.

## 1. 시각적 방향

기본 테마 **Alpine Mist**는 두 번째 참고 이미지의 청회색 안개·따뜻한 미색·옅은 lavender를 바탕으로 한다. 첫 번째 이미지의 보라/청록은 **Aurora** 테마와 AI 코치 강조 면에 제한적으로 적용한다. 제품명 WAVE는 임시다.

참고 이미지의 거대한 마케팅 hero를 데이터 앱에 그대로 복제하지 않는다. 여백은 유지하되 거리·시간·차트·표는 충분히 진하고 정렬되게 한다. 글래스는 정보의 층을 구분하는 장치이며 모든 행을 흐리게 만드는 효과가 아니다.

| 의미 | Alpine Mist 초안 | 사용 |
|---|---|---|
| canvas | #EDF1F6, #F6EFE8 | 넓은 배경 gradient |
| ink | #182131 | 제목·본문 |
| ink-muted | #536075 | 보조 문구 |
| accent | #6256B8 | 주요 선택·코치·action |
| accent-soft | #E7E2F9 | 선택 면 |
| teal | #286B62 | 실제 수행 series/긍정 상태 (텍스트도 병기) |
| peach | #A95836 | attention/보조 series |
| danger | #A8344B | 오류·파괴 action |
| glass | white 64~84% | 카드; 안의 데이터 table은 더 opaque |
| border | white 74%, ink 10% | surface 경계와 실질적인 divider 구분 |

Aurora는 단순 hue inversion이 아니라 어두운 배경에 별도 ink/border/surface 대비 토큰을 적용한다. 동적 배경 위 text contrast는 실제 합성 결과를 검사해야 한다. 일반 텍스트 4.5:1, 큰 텍스트 3:1 기준을 준수 목표로 잡고 chart/UI의 비텍스트 대비도 별도로 검사한다.[S31](sources.md#s31) 이번 프로토타입의 모든 상태에 대한 WCAG 인증을 주장하지 않는다.

## 2. 토큰 계층

Primitive → Semantic → Component 3계층이다. `purple-500`을 domain module이 직접 사용하기보다 `color-action-primary`나 `series-planned`를 쓴다. theme 토큰은 app shell에서 root로 제공한다. tokens CSS/JSON을 생성 원본으로 두고 JS 상수와 수작업 중복하지 않는다.

- spacing: 4/8/12/16/20/24/32/40/48. 작은 icon 내부 간격과 페이지 layout을 구분.
- radii: control 12, input 14, compact card 20, large surface 28, pill 9999.
- typography: 시스템 UI/Korean fallback; display 34~44, heading 24/20, body 15~16, label 12~13. table 숫자에는 tabular-nums.
- elevation: border 중심의 rest, 얕은 hover shadow, dialog만 더 분명한 elevation.
- glass: 배경 blur 18~24px 초안, card의 안에 또 blur를 중첩하지 않음. solid mode에서도 동일 component 구조.
- hit area: 제품 목표 최소 44×44px. 좁은 table cell은 실제 button padding/다른 액션 경로로 보완.
- z-index: base 0 / sticky 10 / popover 30 / drawer 40 / modal 50 / toast 60. 원격 모듈마다 임의의 99999 금지.

## 3. Atomic UI pack과 Experience Kits

| 범주 | 예시 | 규칙 |
|---|---|---|
| Foundation | tokens, typography, icons, focus ring | domain 의존 없음 |
| Atoms/primitives | Button, IconButton, Input, Toggle, Surface | loading/disabled/focus/error 명확 |
| Molecules | Field, SearchInput, Metric, DateRange, SourceBadge | accessible label, units/null 분리 |
| UI patterns | MetricCard, EmptyState, SplitPane, Drawer, DataToolbar | 데이터는 props, fetching 없음 |
| Experience Kits | Conversation, Planner, MediaViewer, GeoWorkbench | host/event adapter, domain source 모름 |
| Domain composition | ActivityImpact, TrainingOrbit, ProposalReview | 모듈의 use case·권한·계약 연결 |

공통 Chat는 `conversation-kit`이다. reusable message/composer, tool-result slot, evidence citation slot, streaming scroll, attachments, keyboard shortcut을 제공한다. `CoachWorkspace`가 실제 run/proposal/approval state와 결합한다. 메시지 library가 API의 승인을 대신하지 않는다.

## 4. State별 디자인

현재 승인된 계획: ink + solid outline. 편집 중: lavender + “초안” label. AI 제안: dashed border + “미적용 제안”. 실제 활동: teal + source badge. stale: amber/peach + “새 데이터로 재검토”. error: danger + 구체 오류. missing: em dash + 원인.

색상만으로 의미를 전달하지 않는다. 상태 badge와 아이콘·텍스트를 함께 쓰고 inactive/control-disabled 상태는 실제 기능과 일치해야 한다. 중요 CTA는 surface 위에서 solid fill로 표시한다.

## 5. Hover·focus·motion 사양

아래 시간과 거리는 제품 초기 조정값이며 표준 규정이나 효능 근거가 아니다. Storybook에서 mouse/touch/keyboard 및 낮은 성능 기기로 조율한다.

| 동작 | 초안 | 동작 제약 |
|---|---|---|
| button hover | 배경/테두리 100ms | 레이아웃 변경 없음 |
| 큰 card hover | shadow 140ms, lift 최대 1px | 본문/table 전체가 뜨지 않음 |
| focus | 즉시 focus-visible | hover와 같거나 더 분명한 feedback |
| tooltip | open 250ms, close 100ms | Escape로 닫기, pointer 이동 corridor, hover 가능 |
| chart crosshair | rAF coalescing | hover마다 fetch/LLM 호출 없음 |
| desktop drag | activation 6~8px | 클릭과 구분, scroll과 충돌 방지 |
| touch drag | hold 200ms, tolerance 8px | scroll 중 강제 활성화 금지 |
| drop | 140~180ms | 최종 draft 위치와 일치 |
| ring drilldown | 260ms opacity/scale | 큰 회전 금지, focus destination 명확 |
| drawer | 200~240ms | 닫힘 후 trigger에 focus 복원 |
| reduced motion | transition 제거/짧은 fade | 정보 변화는 그대로 유지 |

`@media (hover:hover) and (pointer:fine)`에서만 hover lift를 사용한다. touch는 pressed/selected 피드백, keyboard는 focus를 기본으로 한다. 모든 hover-only 상세에는 click/focus 경로를 둔다. tooltip 안에 승인 같은 필수 동작을 숨기지 않는다. WCAG의 hover/focus 내용은 dismissible/hoverable/persistent 조건을 고려한다.[S31](sources.md#s31)

포인터에 따라 광원이 움직이는 효과는 코치 hero나 빈 카드의 아주 미세한 highlight로 한정하고, 표·그래프·텍스트를 따라 움직이게 하지 않는다. 저전력/reduced motion에서 끈다.

## 6. Drag·resize interaction

Dashboard widget: 별도 “레이아웃 편집” 모드, handle 표시, 임시 grid, cancel/reset/apply. 일반 mode에서 크기 변경하지 않는다. Panel split resize: draggable separator + keyboard arrows + preset buttons. Planner: 세션 이동 ghost, 날짜/주기 drop target 안내, drag 결과는 **draft**. Waypoint: 지도 pin 이동 또는 list reorder + 대체 버튼.

drag가 없더라도 동일 작업이 가능해야 한다. 예: “날짜로 이동”, “위/아래”, “너비 40/60/80%”, 숫자 입력. 키보드 대안뿐 아니라 single-pointer non-drag 대안도 제공한다.[S31](sources.md#s31)

같은 요소에 dnd-kit과 react-grid-layout drag를 동시에 적용하지 않는다. nested scroll, dragging outside viewport, ESC, pointercancel, 앱 background 전환을 시험한다. tooltip은 drag 중 닫고 chart hover를 잠시 멈춘다. server conflict가 나면 drop을 조용히 성공 처리하지 않는다.

## 7. Circular UI 사양

`OrbitNavigator`는 domain-free `PeriodNodeView`를 받아 sector geometry와 list를 렌더한다. 중심 current node, 바깥 child nodes, 얇은 별도 completion ring, 아래 breadcrumb. 클릭은 drilldown, double-click 필요 없음. 과도한 nested donut은 피하고 한 번에 주 레벨 하나를 명확히 보여준다.

D3 partition으로 각도를 계산할 수 있지만 React가 SVG DOM을 소유한다.[S28](sources.md#s28) 레이블은 sector 길이가 충분할 때만 내부 표시하고 작으면 번호+목록을 사용한다. 스크린리더 사용자를 위한 HTML list가 같은 선택 상태를 공유한다. mouse hover와 keyboard focus 상세도 동일하다.

모바일에서는 ring과 세로 agenda, desktop에서는 ring+calendar/table. 탐색 이력은 URL로 복원되고, 사람이 이해하는 기간 경계와 local date를 표시한다. 주기 진행률, 거리 달성률, 신체 readiness를 같은 ring 하나에 섞지 않는다.

## 8. Plugin shortlist와 실제 도입 방식

아래는 확인한 공식 문서 기반 **선정 후보**다. 이번 산출물의 HTML prototype에 이 모든 package를 설치한 것은 아니다. 실제 React/Next/WebView 버전·CSP·라이선스 spike를 통과한 뒤 lockfile로 고정한다.

| 요구 | 기본 후보 | 소유·적용 | 출시 전 검사 |
|---|---|---|---|
| 목록/세션 DnD | dnd-kit [S13] | planner/media adapter | touch+keyboard, 현재 API |
| split resize | react-resizable-panels [S14] | data-workbench | current exports, persistence |
| dashboard DnD/resize | react-grid-layout [S15] | dashboard 내부 | edit mode, mobile alternative |
| chart | Apache ECharts [S16] | chart adapter | brush/axis pointer/zoom, bundle |
| table | TanStack Table [S17] | table adapter | server pagination, a11y, 필요 시 virtual |
| dropdown/dialog/tooltip/slider | Radix Primitives [S18] | ui primitives | tokens, focus/portal, native scroll |
| rich-text editor | Tiptap [S19] | resources/notes kit | sanitization, IME, paid add-ons 분리 |
| carousel/swipe | Embla [S20] | media kit | gesture conflict, reduced motion |
| gallery including video | Yet Another React Lightbox [S21] | media kit | video types, focus, signed URL |
| map | MapLibre GL JS [S22] | geo kit | worker/CSP, WebGL in WKWebView |
| map route planner | 자체 waypoint UI + openrouteservice adapter [S23] | geo module + server routing | 한국 보행 routing, quota, privacy |
| video player | HTML video + Media Chrome [S25] | media kit | codecs, inline/fullscreen, controls |
| conversation | assistant-ui external-store [S26] | conversation kit | authoritative state, citations |
| general planner | 자체 kernel + FullCalendar standard adapter [S27] | planner kit | standard/premium boundary |
| circular UI | React SVG + D3 hierarchy [S28] | period navigator | list equivalent, labels |
| date/range picker | React DayPicker [S29] | date field | Korean locale/timezone/null |
| motion | Motion [S30] | UI transitions | DnD transform conflicts, reduced motion |

[S13](sources.md#s13) · [S14](sources.md#s14) · [S15](sources.md#s15) · [S16](sources.md#s16) · [S17](sources.md#s17) · [S18](sources.md#s18) · [S19](sources.md#s19) · [S20](sources.md#s20) · [S21](sources.md#s21) · [S22](sources.md#s22) · [S23](sources.md#s23) · [S25](sources.md#s25) · [S26](sources.md#s26) · [S27](sources.md#s27) · [S28](sources.md#s28) · [S29](sources.md#s29) · [S30](sources.md#s30)

차트는 ECharts를 주력으로 통일하고, circular navigation은 bespoke interaction이라 SVG/D3 geometry를 사용한다. 아름다움은 라이브러리 기본 theme보다 토큰·밀도·정렬·상호작용의 일관성에서 구현한다. premium timeline·collaborative editor·hosted tile의 비용은 오픈소스 core와 분리해서 추적한다.

## 9. Layout 및 접근성 검증

Desktop W≥1280: 12-column; Tablet 768≤W<1280: 8-column; Mobile W<768: 4-column/one-stack. W는 CSS layout viewport 너비다. 기준값은 responsive-spec.json, 화면별 동작·container 560/960 기준·상태 연속성과 시험은 [07](07_responsive_layout.md)을 따른다. 실제 변경 시 ADR과 fixture를 함께 개정하며 module마다 임의 breakpoint를 만들지 않는다.

표는 가로 스크롤 영역 안에서만 overflow하며 페이지 전체 overflow를 만들지 않는다. 기본 보기에서 날짜·핵심 숫자는 pin한다. chart엔 읽을 수 있는 제목/설명/표 대안을 준다. 색각 이상에서도 series는 dash/marker/label로 구분한다. 정상 신체 값인지 UI 스타일만으로 판단하지 않는다.

## 10. 첨부 prototype 범위

`prototype/index.html`은 외부 라이브러리·API 없이 로컬에서 동작하는 interaction 연구용이다. 날짜·활동·계획·지표는 가상 예시다. 화면 전환, N-day 계산, Orbit 선택, 달력/표, 로컬 CRUD, coach preview/명시 적용, resizing, theme, media local preview를 확인한다. 실제 OAuth/FIT/HealthKit/RAG/도로 경로 계산/생리 점수는 구현하지 않는다. 정확한 범위와 실행한 테스트는 README와 QA에 별도로 기록한다.

## 11. Nutrition·Supplementary UI 확장

공통 primitive: QuantityWithUnit, RangeField, NullableMetric, SourceBadge, CoverageNotice. Domain composition: NutritionTimeline/PlanActual/IntakeQuickAdd, ExercisePicker/RoutineBuilder/SetEntry/RestTimer. 영양 값과 bodyweight·external resistance, 계획과 실제를 색뿐 아니라 label·unit·source로 구분한다.

영양 목표·보강 세트 진행은 목적이 다른 ring이다. 개인 피로·부상 위험을 뜻하는 것처럼 쓰지 않는다. 실제 섭취/세트 확인은 explicit action으로, 계획 복사는 draft로 표시한다. Mobile quick log는 충분한 hit area와 숫자/단위 접근, keyboard/IME·중단 복구가 필수다. 접근성 수치의 제품 목표와 표준 최소값은 [07 §6](07_responsive_layout.md)에서 구분한다.

## 12. v0.2.3 루틴·스트레칭·회복의 UI 패턴

새 조합은 RoutineCard/StepList/ChoiceGroup/OccurrencePreview/RunProgress/SideHoldField/RecoveryStrategyCard/MethodEvidence/FollowUpCard다. Foundation·QuantityField·SourceBadge·Timer·미디어·DnD를 재사용하고 거대한 별도 plugin pack을 추가하지 않는다.

원형 timer는 남은 시간, 단계 ring은 확인된 진행을 나타낸다. 숫자 옆에 뜻·단위·부분 수행을 표시하며 신체 회복률/안전 허가로 사용하지 않는다. 대안 카드의 완전 휴식도 동일한 시각적 우선순위를 가질 수 있다. 쉬거나 중단한 사용자를 실패 색·streak 손실로 압박하지 않는다.

현재 단계·좌우·확인/수정/중단 버튼은 hover 없이 접근한다. 매초 screen-reader 알림 대신 중요한 상태 변화와 요청한 값만 읽고, timer 종료는 사용자 확인 없는 실제 완료가 아니다. 색상·영상·haptic 없이도 텍스트와 조작 대안이 남아야 한다. 레이아웃은 [07](07_responsive_layout.md), 업무 동작은 [09](09_routines_stretching_recovery.md)를 따른다. 실제 스타일/컴포넌트·prototype은 미변경이다.
