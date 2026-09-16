# 기술·연동·연구 근거

확인 기준일: 2026-09-15. 아래는 공개 공식 문서 또는 원 연구다. 라이브러리의 정확한 버전, 이용계약, Garmin 승인 계정의 entitlement, Apple OS별 가용성은 개발 시작 시 다시 확인하고 lockfile/ADR에 기록한다. 문서 확인은 라이브러리 설치·상용 API 승인·임상 검증을 의미하지 않는다. 문서상의 제품 기능이 공개 API 필드로 모두 노출된다고 추론하지 않는다.

## S01
Next.js — Turbopack. Rust 기반 bundler이며 webpack plugin을 지원하지 않음. 모노레포 task runner나 microfrontend 구성 방식과 구분.
https://nextjs.org/docs/app/api-reference/turbopack

## S02
Next.js — Multi-zones. 경로별 별도 배포, zone 경계 hard navigation, asset 경계.
https://nextjs.org/docs/app/guides/multi-zones

## S03
Turborepo — Package and Task Graphs. 저장소 package/task dependency와 실행·cache 계층. 페이지 본문 접근에 제약이 있어 공개 검색 설명 범위에서 확인; 정밀 설정은 구현 시 문서 재확인.
https://turborepo.dev/docs/core-concepts/package-and-task-graph

## S04
Capacitor — Web/native capabilities. Native adapter를 분리하기 위한 참조.
https://capacitorjs.com/docs/core-apis/web

## S05
Garmin Connect Developer Program — Activity API. 동의와 Connect 동기화 후 FIT/GPX/TCX 및 push/ping-pull, 승인 후 평가 환경.
https://developer.garmin.com/gc-developer-program/activity-api/

## S06
Garmin Connect Developer Program — FAQ. business/enterprise 대상, 신청·승인, OAuth 2.0, 일부 지표의 추가 상업 조건.
https://developer.garmin.com/gc-developer-program/program-faq/

## S07
Garmin Connect Developer Program — Health API. 수면·심박·스트레스·Body Battery 등 공개된 범위. Training Readiness 등 모든 UI 지표의 API 노출은 이 페이지로 확인되지 않음.
https://developer.garmin.com/gc-developer-program/health-api/

## S08
Apple — HealthKit framework / authorization. Native framework, 유형별 접근, 읽기 권한 거절과 빈 결과를 앱이 확실히 구분할 수 없다는 제약.
https://developer.apple.com/documentation/healthkit
https://developer.apple.com/documentation/healthkit/authorizing-access-to-health-data

## S09
Apple WWDC20 — Synchronize health data with HealthKit. Anchored queries, 새 데이터와 삭제, 외부 서버와의 동기화 설계. 이 문서에 기반하되 본 설계의 outbox/ack 정책은 자체 제안.
https://developer.apple.com/videos/play/wwdc2020/10184/

## S10
Apple — HKAnchoredObjectQuery, HKObserverQuery, HealthKit background delivery. Native background 통지는 주기적 실시간 보장을 뜻하지 않음. 대상 OS·entitlement·기기에서 검증 필요.
https://developer.apple.com/documentation/healthkit/hkanchoredobjectquery
https://developer.apple.com/documentation/healthkit/hkobserverquery
https://developer.apple.com/documentation/healthkit/hkhealthstore/enablebackgrounddelivery(for:frequency:withcompletion:)

## S11
Apple — route data, effort score identifiers. Workout route 및 직접/추정 effort는 지원 OS와 실제 존재 여부를 확인. Fitness 화면의 모든 점수에 공개 API가 있다고 가정하지 않음.
https://developer.apple.com/documentation/healthkit/reading-route-data
https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier/workouteffortscore
https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier/estimatedworkouteffortscore

## S12
Apple — App Review Guidelines. 4.2 최소 기능, 5.1.2 데이터 이용·공유 동의. 단순 웹사이트 재포장이 자동 승인된다고 가정하지 않음; AI 제공자 전송도 설명·동의 대상으로 설계.
https://developer.apple.com/app-store/review/guidelines/

## S13
dnd-kit 공식 문서. DnD interaction adapter 후보. 현재 package/API는 spike 후 고정.
https://dndkit.com/

## S14
react-resizable-panels 공식 저장소. Split-pane resize 후보; 현재 API에 맞춰 wrapper 구현.
https://github.com/bvaughn/react-resizable-panels

## S15
React Grid Layout 공식 저장소. Dashboard 편집 모드의 widget 위치·크기 후보. 같은 영역에 여러 drag 엔진을 중첩하지 않음.
https://github.com/react-grid-layout/react-grid-layout

## S16
Apache ECharts — event concepts. 차트 이벤트·선택 연결의 참조.
https://echarts.apache.org/handbook/en/concepts/event/

## S17
TanStack Table — introduction. Headless 데이터 table 후보.
https://tanstack.com/table/v8/docs/introduction

## S18
Radix Primitives. Menu, dialog, tooltip, slider 등의 접근성 기반 primitive 후보.
https://www.radix-ui.com/primitives

## S19
Tiptap — overview. Resources·노트 편집. core와 유료 확장/hosted 서비스는 별도 확인.
https://tiptap.dev/docs/editor/getting-started/overview

## S20
Embla Carousel. Swipe/carousel 후보.
https://www.embla-carousel.com/

## S21
Yet Another React Lightbox — video plugin. Photo/video gallery 후보.
https://yet-another-react-lightbox.com/plugins/video

## S22
MapLibre GL JS. Map rendering; directions, tiles, geocoding 공급과 별개. 번들 worker/CSP/WebView 검증 필요.
https://maplibre.org/maplibre-gl-js/docs/

## S23
openrouteservice — Directions. 서버 측 route provider adapter 후보. 실제 지역별 보행 경로 품질과 이용조건·quota를 검증해야 함.
https://giscience.github.io/openrouteservice/api-reference/endpoints/directions/

## S24
OpenStreetMap tile usage policy. 공개 tile 서버를 무제한 production/offline 백엔드로 사용하지 않음.
https://operations.osmfoundation.org/policies/tiles/

## S25
Media Chrome. HTML media player control 후보.
https://www.media-chrome.org/

## S26
assistant-ui — External Store runtime. 제품의 저장된 대화·도구·제안 상태를 UI에 연결하는 adapter 후보.
https://www.assistant-ui.com/docs/runtimes/custom/external-store

## S27
FullCalendar — license. Standard와 Premium 기능의 라이선스를 구분. General planner kernel은 제품에서 소유하고 calendar는 renderer adapter로 둠.
https://fullcalendar.io/license

## S28
D3 — hierarchy partition. Orbit UI의 분할 geometry 후보. SVG 렌더링·키보드·리스트 대안은 제품에서 구현.
https://d3js.org/d3-hierarchy/partition

## S29
React DayPicker. 날짜·범위 선택기 후보.
https://daypicker.dev/

## S30
Motion for React. 제한된 layout/state transition 후보.
https://motion.dev/docs/react

## S31
W3C WCAG 2.2 — Dragging Movements / Content on Hover or Focus / Contrast Minimum. Drag를 대체할 single-pointer 동작, hover/focus 내용 제어, 대비 요건.
https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html
https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html
https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html

## S32
pgvector 공식 저장소. PostgreSQL 안의 vector 검색과 필터 처리. 실제 schema/인덱스와 ACL recall을 평가.
https://github.com/pgvector/pgvector

## S33
Anthropic — Contextual Retrieval. 문맥을 보존한 chunk와 검색·rerank 설계의 참고. 제품에서의 효과는 별도 ablation 평가 대상.
https://www.anthropic.com/engineering/contextual-retrieval

## S34
Impellizzeri FM et al. (2020), Acute:Chronic Workload Ratio: Conceptual Issues and Fundamental Pitfalls. DOI 10.1123/ijspp.2019-0864. ACWR을 인과적 부상 예방 처방이나 개인별 부상 확률로 단순 해석하는 문제에 대한 비판.
https://pubmed.ncbi.nlm.nih.gov/32502973/

## S35
Foster C et al. (2001), A new approach to monitoring exercise training. Session-RPE와 운동 지속 시간으로 훈련 부하를 추적하는 원 연구. 부상 확률 계산식의 근거는 아님.
https://pubmed.ncbi.nlm.nih.gov/11708692/

## S36
공유된 계획 대화. 제목은 확인했으나 공개 링크의 본문은 도구로 회수하지 못함. v0.2의 hierarchy는 사용자의 이번 설명과 이전에 확인 가능한 대화 맥락에 기반한 설계이며 해당 링크 전체의 정확한 전사는 아님.
https://chatgpt.com/share/6aa89754-1ea4-83ee-b91a-5ed2a1955bd9

## S37
OpenAI — Function calling / agent safety. 도구 스키마와 데이터/지시 경계의 참고; strict schema가 처방 정확성이나 권한을 대신하지 않음.
https://platform.openai.com/docs/guides/function-calling
https://developers.openai.com/api/docs/guides/agent-builder-safety
