# 05 · 개발 요구사항 / 실행 계획 / 수용 기준 v0.2.3

> v0.2.3 · 2026-09-16: [09 루틴·스트레칭·회복 전략](09_routines_stretching_recovery.md)과 S31~S35, FUT-13~15, V023 요구·시험을 추가했다. 기존 계약·이력은 유지하며 신규 기능은 아직 미구현이다. 아래 이전 버전 설명은 당시 기준이며 새 범위는 09와 05 §11을 따른다.

> v0.2.2 · 2026-09-15: [07 반응형](07_responsive_layout.md), [08 영양·보강](08_nutrition_supplementary_training.md), FUT-10~12 및 V022 요구·시험을 추가했다. 기존 V2-F01~36 / V2-A01~50은 유지한다. 실제 기능 구현·새 UI 수용 시험은 미수행이다.

> v0.2.1 당시 기록(보존) — 문서 개정일: 2026-09-15. 기존 M0~M3·V2-F01~F36·V2-A01~A50 요구사항을 유지하고, [06 · 후속 개발 백로그](06_follow_up_backlog.md)를 추가했다. **이번 개정은 문서화만 수행했으며 실제 구현·외부 연동·검증 상태는 바뀌지 않았다.** §8의 검증 내용은 기존 v0.2 기록이며 이번에 다시 실행한 결과가 아니다.


## 1. MVP와 배포 단위

MVP 전체 범위는 01 문서의 S01~S35 화면군이다. v0.2.3 루틴·스트레칭·회복은 M1c~M2에서 구현한다. v0.2.2의 영양·보강은 M1b와 M2에서 구현하고 모든 화면에 07 반응형 계약을 적용한다. 구현은 M0 feasibility, M1 core loop, M2 확장 화면, M3 mobile로 나눈다. 이것은 구현 순서이지 요청한 화면의 삭제가 아니다. Web-only MVP와 Apple 자동 수집을 포함한 native-inclusive MVP의 완료 조건을 구분한다.

공식 Garmin 권한은 개발 코드로 해결할 수 없는 선행 조건이다. 승인 대기 중 mock/FIT fallback 개발은 가능하지만 production automatic import라고 발표하지 않는다. Apple auto까지 필수면 native collector도 release gate다. 실제 API 비용·파트너 계약·OS별 지원과 라이브러리 lock은 ADR에 기록한다.

## 2. 우선 결정할 ADR

| ADR | 제안 결정 | 대안 / 검증 |
|---|---|---|
| 01 모듈 배포 | build-time modular frontend, MFE-ready | 팀별 독립 배포 필요 시 path-zone/federation 검토 |
| 02 app hosts | Next web + Vite client + Capacitor | remote website wrapper보다 모듈 재사용·native bridge 통제 |
| 03 공통 층 | Experience Kits + atomic UI | common/shared 거대 패키지 회피 |
| 04 BFF | Fastify의 논리 경계, same-origin proxy | Next와 동일 업무 endpoint 중복 금지 |
| 05 styling | CSS semantic tokens + CSS Modules | Panda 등 대체 시 module 계약·token 구조 유지 |
| 06 계획 | versioned hierarchical periods + calendar/rolling lenses | 주간과 10일 Block 혼합 금지 |
| 07 Garmin | 공식 Activity API 우선 | 승인 전 모의 데이터와 파일 fallback |
| 08 Apple | native HealthKit collector | 순수 웹 API 방식 채택 안 함 |
| 09 점수 | source-native + self-report + versioned load trends | 임의 injury probability/composite 기본 노출 안 함 |
| 10 RAG | PG+pgvector+lexical, policy preload 분리 | 초기엔 curated corpus도 ablation 비교 |
| 11 maps | MapLibre + server routing provider adapter | 지역 coverage/약관 확인 전 공급자 확정 안 함 |
| 12 auth | web cookie / native secure transport | token query string/localStorage 금지 |
| 13 responsive | 기존 768/1280 viewport 기준 + kit container 적응 | 07·responsive-spec 원본; 경계/상태/실기기 검증 |
| 14 nutrition/supplementary | 별도 nutrition 원장 + 공통 Activity의 보강 상세 | 08; actual/planned, 단위·source 보존 |
| 15 joint approval | 두 계획·actual·constraint revision 기반 combined transaction | scope별 계약, stale·부분 적용 차단 |
| 16 routine composition | versioned blueprint + finite schedule + actual references | workout template/원장 복제 금지; 09 |
| 17 stretching/recovery | 공통 exercise의 전문 보기 + 비운동 recovery 원장 | S12 관측·S35 전략 분리; 09 |
| 18 integrated approval | training/nutrition/recovery/routine_schedule write와 read dependencies | schemaVersion 4, 원자 적용·stale 차단 |

## 3. Epic별 구현 계획

### M0 · 기술·연동 검증과 제품 계약

결과물: schema source, module host stub, design token+storybook, Garmin 신청/entitlement tracker, HealthKit iOS spike, map route coverage sample, library licenses/CSP compatibility report.

통과 조건: 같은 샘플 module을 Next route와 Vite shell에 각각 표시하고 navigation/API mock을 host로 교체할 수 있음. MapLibre worker, chart, editor IME, DnD/resize를 production build와 실기기에서 시험. Garmin 실제 응답을 얻기 전에는 payload schema를 provisionally marked로 둠. PWA 브라우저를 HealthKit 실기기 검증으로 대체하지 않음.

### M1 · 완결된 core loop

순서: Identity/Consent → PlanPeriod/PlanVersion → Import/Measurement/Canonical Activity → Screens S03~S12 → Evidence/LLM tools → Proposal/Approval → Sync/Settings/Audit.

상위 계약을 먼저 구현하되 세로 기능 단위로 완결한다. 첫 slice는 “가상 provider activity 수신→화면 반영→상담 후보→변경 미리보기→승인→새 plan version”이다. 그 뒤 실제 Garmin adapter를 같은 interface에 연결한다. 동기화 실패·중복·stale approval 시험을 기능 성공과 같은 우선순위로 둔다.

### M1b · 영양·보강의 수동 core loop — v0.2.2 추가

NutritionPlanVersion/IntakeEntry와 Exercise/Routine/SupplementaryExecution을 기존 Activity/Plan/Evidence 경계에 연결한다. S25~S30 기본 CRUD, 실제 값 확인·부분 기록·timer, 혼합 Planner와 joint diff/approval을 실제 저장까지 완성한다. 모든 신규·기존 화면은 07의 mobile/tablet/desktop 계약을 따른다. 식품 DB와 provider의 상세 set 지원을 기다리지 않고 사용자 정의·수동 경로를 먼저 완결한다.

### M1c · 루틴·스트레칭·회복 수동 core — v0.2.3 추가

범용 blueprint/schedule/occurrence/run, 공통 동작의 StretchProfile/실제 상세, RecoveryStrategy/Plan/ActionLog를 구현한다. S31~S35와 기존 오늘/Planner/Activity/Coach를 연결하고 유한 배치·중복·anchor·선택·통합 승인·중단/오프라인 경로를 시험한다. 회복 효과를 검증한 기능이라고 표시하지 않는다.

### M2 · 전체 MVP 화면군 완성

Courses/route planner → races/results → gallery/media → resources reader/indexing → grounded coaching/citations + 검토된 영양 팁·동작/스트레칭·회복 방법 자료·문맥 기반 코칭. 도메인 API와 screen reader를 함께 구현한다. RAG index는 자료 upload/권한/버전/삭제 흐름 이후에 연결한다. media 썸네일·video 지원·코스 routing은 화면 component만 완성했다고 처리하지 않는다.

### M3 · Native WebView 제품화

같은 modules를 mobile-web shell에 조합하고 Swift HealthKit authorization/incremental+deletion/background/outbox와 secure transport를 연결한다. safe-area/IME/back/foreground/draft 복구/poor-network를 실기기에서 검증한다. 앱스토어 개인정보·AI 전송 disclosure와 native 기능 적정성을 검토한다.

Web-only MVP는 M2까지 모든 기본 화면과 Garmin 연동 승인이 필요하다. Native-inclusive MVP는 M3까지 필요하다. 정확 일정은 팀 구성·공식 승인·라이브러리 spike 후 추정한다. 승인 대기 시간을 엔지니어링 effort와 같은 값으로 합산하지 않는다.

## 4. 기능 요구사항 (기존 v0.1 불변 조건에 추가)

| ID | 요구사항 | 수용 기준 / 화면 |
|---|---|---|
| V2-F01 | Thin app wrappers | 동일 module mock이 Next/Vite에서 동작; module에 next import 없음 |
| V2-F02 | Module public boundary | internal cross-import CI 실패, manifest/exports 명시 |
| V2-F03 | UI/experience separation | Chat renderer가 plan approval service를 import하지 않음 |
| V2-F04 | Safe shared contracts | browser dependency graph에 ORM/provider secret/node-only 없음 |
| V2-F05 | Host capability/bridge | unsupported method version과 arbitrary URL 차단 |
| V2-F06 | Hierarchical periods | wave/phase/block date·parent·partial 검증 S04 |
| V2-F07 | Rolling/calendar lens | N일/주간/Block 집계가 별개이며 날짜 범위 표기 S03/S05 |
| V2-F08 | Orbit navigator | click+keyboard+list 동일 선택, breadcrumb 복귀 S04 |
| V2-F09 | Planner multi-view | calendar/table/agenda 동일 draft/selection S05 |
| V2-F10 | Planner draft operations | drag/menu/resize 결과는 미적용 draft; undo/preview S05 |
| V2-F11 | Session structure | 여러 session/day, workout 단계·단위·의도·lock S06 |
| V2-F12 | Activity CRUD overlays | imported 원본 보존, local 수정/삭제 의미 표시 S07/S08 |
| V2-F13 | Linked workbench | 차트 시간 선택과 route/lap 선택 일치; GPS gaps S09 |
| V2-F14 | Impact semantics | 관측 contribution/추정/상담 분리; 가상 위험확률 금지 S09 |
| V2-F15 | Coach state UI | progress와 validated final 구분, 추가 질문·취소 S10 |
| V2-F16 | Proposal diff/approval | known version binding, unknown/error/stale 제약 S11 |
| V2-F17 | Check-in and score provenance | null/0/unknown 구분, source/method/time S12 |
| V2-F18 | Course CRUD/version | 원본 track에서 새 코스 생성, 원본 불변 S13 |
| V2-F19 | Route planning | waypoint/menu+drag, routing stale/error, GPX boundary S14 |
| V2-F20 | Race/result entities | race event와 actual result, official/device split 구분 S15/S16 |
| V2-F21 | Gallery photo/video | private assets, preview+delete, derivatives, signed URLs S17 |
| V2-F22 | Resources lifecycle | quarantine/parse/index/failed/version/use-toggle S18/S19 |
| V2-F23 | Retrieval authority | mandatory constraints preload, doc never grants write |
| V2-F24 | Citation grounding | correct version+locator, ACL and entailment check |
| V2-F25 | Garmin connection | official OAuth, scopes/capabilities, revoked/retry S20 |
| V2-F26 | Automatic FIT import | approved API → verified source file → idempotent ingest |
| V2-F27 | Garmin health scores | Health capability별 수집, 없는 지표 생성하지 않음 |
| V2-F28 | Sync QA center | backfill/live/errors/duplicates/timezone/link correction S21 |
| V2-F29 | Apple native import | typed consent, incremental/tombstones/outbox M3 |
| V2-F30 | Multi-source dedup | Garmin→HealthKit 재수입의 lineage와 중복 확인 |
| V2-F31 | Account/consent/erase | app/provider/AI consent 별도, export/delete 파생물 S22 |
| V2-F32 | Appearance/accessibility | Mist/Aurora/solid/reduced-motion/units/timezone S23 |
| V2-F33 | Notice/decision history | pending proposal/current applied, revocation S24 |
| V2-F34 | Offline/lifecycle | last-known+draft 허용, offline final approval 금지 |
| V2-F35 | Runtime budgets | lazy heavy plugins, bounded model/tools/retrieval/jobs |
| V2-F36 | Audit/evaluation | trace IDs/versions, no raw tokens/no hidden CoT logging |

## 5. 추가 수용 테스트

| ID | 상황 | 기대 결과 |
|---|---|---|
| V2-A01 | Next에서 module 호출 후 Vite로 host 교체 | use case/UI 수정 없이 adapter만 변경 |
| V2-A02 | module 내부 next/navigation import | CI boundary lint 실패 |
| V2-A03 | server ORM을 shared entry에서 export | browser build/boundary 테스트 실패 |
| V2-A04 | 과거 앱이 새 bridge method 호출 | unsupported 응답, silent 실패 아님 |
| V2-A05 | native bridge로 임의 domain fetch 요구 | allowlist 차단 |
| V2-A06 | WebView external resource 클릭 | privileged bridge 없는 외부 경로로 이동 |
| V2-A07 | 10일 Block 끝이 시즌 끝을 넘음 | partial Block 표시/검증, 조용한 날짜 확대 없음 |
| V2-A08 | sibling 기간 겹침·parent 벗어남 | 저장 오류와 범위 지시 |
| V2-A09 | 자정·DST·다른 timezone 수행 | 문서화된 date projection과 일관된 합계 |
| V2-A10 | rolling 10일이 두 Block·달력 주를 가로지름 | 독립 합계, 활동 이중집계 없음 |
| V2-A11 | 여러 session/day | 같은 날짜에 중복 ID 없이 표시·편집 |
| V2-A12 | Orbit 작은 sector | 목록으로 동일 탐색 가능 |
| V2-A13 | pointer 없이 calendar move | menu/date input으로 완료 가능 |
| V2-A14 | touch scroll 중 session 위를 지나감 | drag가 잘못 활성화되지 않음 |
| V2-A15 | drag 후 network loss | canonical plan 불변, draft 보존 |
| V2-A16 | 임시 초안에 stale plan version | conflict, 자동 canonical 덮어쓰기 없음 |
| V2-A17 | CSV 요약에 route 없음 | route unavailable, 직선 route 생성 금지 |
| V2-A18 | GPS gap과 chart range 선택 | gap 보존, 시간 index 일치 |
| V2-A19 | 원본 provider 값 수정 | overlay revision, provider writeback 없음 |
| V2-A20 | 로컬 삭제 후 provider 이벤트 재수신 | suppression 정책에 따라 재등장 방지 |
| V2-A21 | OAuth callback state mismatch | connection 생성 거부 |
| V2-A22 | concurrent Garmin token refresh | 한 번만 갱신, 최신 secret 보존 |
| V2-A23 | 중복/역순 Garmin event | source ID/revision 기준 canonical 일관성 |
| V2-A24 | API 권한에 없는 Training Readiness | unavailable, score fabrication 없음 |
| V2-A25 | backfill 중 live sync | 우선순위·dedup 유지 |
| V2-A26 | Apple read query empty | 읽기 거절로 확정하지 않음 |
| V2-A27 | native anchor 저장 직후 upload 실패 | durable outbox에서 재시도, data loss 없음 |
| V2-A28 | HealthKit 삭제/재설치 | tombstone/reset 재조정, duplicate aggregation 없음 |
| V2-A29 | Garmin 활동이 Apple에도 존재 | source lineage 보존, 운동 합계 1회 |
| V2-A30 | HRV method가 다른 제공자 | 동일 단위처럼 합산·series 연결 안 함 |
| V2-A31 | fatigue 미입력·RPE 미입력 | 0 정상/0load로 바꾸지 않음 |
| V2-A32 | baseline 부족한 자체 percentile | not_observed/insufficient 표시 |
| V2-A33 | provider 점수는 높고 사용자 불편감 보고 | 보고 무시·안전 단정 안 함 |
| V2-A34 | routing quota/error | draft 보존, 직선을 성공 경로로 확정 안 함 |
| V2-A35 | 빠르게 waypoint 연속 수정 | 오래된 route response가 최신 geometry 덮지 않음 |
| V2-A36 | video codec unsupported | 오류/대체 안내, 계속 spinner 아님 |
| V2-A37 | media 삭제 후 thumbnail URL 재조회 | access 차단·파생물 삭제 |
| V2-A38 | 사설 IP로 resource URL fetch | SSRF 차단, redirect도 재검사 |
| V2-A39 | 자료에 정책 무시 지시 | 데이터로 처리, tool/write 권한 확대 없음 |
| V2-A40 | 타 사용자 유사문서가 검색 상위 | ACL로 context 이전 차단 |
| V2-A41 | resource 사용 해제 후 index 삭제 지연 | query-time access gate로 RAG 제외 |
| V2-A42 | 예전 resource version 인용 | 당시 원문 위치 표시 또는 삭제 정책에 따른 차단 |
| V2-A43 | 여러 문헌 상충 | 단일 확정 처방으로 은폐하지 않고 불확실성 표현 |
| V2-A44 | 문서 없는 질문 | source를 만들어 내지 않음 |
| V2-A45 | 승인 도중 새 activity/체크인 | relevant revision 검사, stale 적용 거부 |
| V2-A46 | 동일 승인 재전송 | 같은 결과, 중복 PlanVersion 없음 |
| V2-A47 | 로그아웃 후 다른 계정 로그인 | caches/media/drafts 사용자 간 누출 없음 |
| V2-A48 | reduced motion/transparency | 기능 동일, 접근성·동작 유지 |
| V2-A49 | 360px/large text/table | page overflow 없음, data 영역 안 스크롤 |
| V2-A50 | hover 없는 환경 | 필수 정보와 모든 동작 접근 가능 |

v0.1의 36개 승인·데이터·코칭 시나리오를 폐기하지 않고 유지한다. 위 테스트는 **요구사항**이며 이번 HTML의 60개 smoke check와 같은 테스트 집합이 아니다. 실제 backend/native/API 검증은 미수행이다.

## 6. 비기능 요구와 release gate

접근성: 일반 텍스트 대비, keyboard/focus/modal trap, non-drag alternatives, reduced motion, screen reader와 real touch 검증. 예쁜 hover만으로 정보 접근을 해결하지 않는다.

보안: 인증/CSRF/CSP/SSRF/upload parsing/rate limits, native bridge allowlist, token encryption/rotation/revocation, 객체 URL·GPS 최소화, tenant ACL와 RLS. AI 전송 동의와 HealthKit/미디어 동의를 구분한다.

데이터 정합성: outbox at-least-once consumer 멱등성, source revisions, 삭제 suppression, fine/coarse revision semantic 정의. DB transaction 밖에서 LLM/remote requests를 수행한다.

성능: shell과 heavy adapter의 bundle 분리; table virtual/paging; map/large chart의 progressive data; responsive input/drag 60fps는 **대상 기기 측정 목표**이지 현재 달성 주장 아님. large import job과 UI 동작을 분리한다.

운영: provider별 success/freshness/429, index lag, proposal stale ratio, model/tool/retrieval costs, job retry/lease, 삭제 진행, source schema change 탐지. 공급자 장애 kill switch와 안전한 기능 제한 상태를 둔다.

모델 품질: 동일 정보·후보 수·budget으로 rule/search baseline, LLM generation, LLM+RAG를 비교한다. 실제 부하 계산의 정확성과 인용 의미의 정확성을 분리한다. 전문 판단은 전문가 rubric을 적용하고 모델 judge의 동의를 임상 근거로 대체하지 않는다.

## 7. 첫 구현 티켓 예

1) `platform/HostContext`와 fake AuthenticatedTransport 작성 → 두 shell story에서 동일 ActivityList 화면 실행.
2) `PlanPeriod` schema와 date fixtures 작성 → 10일+partial hierarchy → Orbit/list/calendar projection.
3) Activity raw/source/canonical/overlay/tombstone 테이블과 imports worker → mock event retry + FIT fixture.
4) DashboardReadModel query → rollingN/table/summary의 수치 동치성 테스트.
5) PlannerDraft→Projection→Validation→Approval API → manual move와 AI 후보 공통 경로.
6) Garmin 승인 후 captured sample contract test → sync center와 capability 표시.
7) ResourceVersion/Passage/ACL ingestion → hybrid retrieval → citation drawer → delete/rerank leak test.
8) HealthKit native outbox/anchor prototype → secure uploader → WebView 동일 ActivityDetail.

## 8. Prototype의 실제 검증 범위

제공한 `prototype/index.html`은 프레임워크 선택을 확정하는 production 구현이 아니다. 실제 HTTP·OAuth·LLM·RAG·routing·HealthKit 호출이 없고 모두 가상 데이터/로컬 메모리다. 화면에 확인 가능한 제약을 표시했다. 8개 화면 목적지, 모달, source/status 표현과 interaction을 검토할 수 있다. 캘린더+표 동시 split과 provider library adapter 등 나머지 요구는 설계에 포함되며 prototype에서 모두 구현되었다고 하지 않는다.

실행한 검사: TypeScript contract compile, 공유 순수 함수 9 assertions, Chromium 기반 prototype 60 smoke checks. 브라우저 렌더링·모바일 폭·CSS/JS interaction 검사는 backend/API/native/임상 테스트의 대체가 아니다. 기존 브라우저 검사 결과는 [qa/prototype-results.json](qa/prototype-results.json)을 참고한다. 이 결과는 실제 서버·native·외부 API·생리학 검증의 증거가 아니다.


## 9. 미완료 항목의 후속 개발 추적 — v0.2.1 추가

아직 하지 않은 작업은 [06 · 후속 개발 백로그](06_follow_up_backlog.md)를 기준으로 추적한다. 항목별 선행 조건, 구현 위치, 완료 기준, 미완료 시 동작, 연관 요구·테스트를 연결했다. 아래 항목이 후속 대상으로 기록되었다고 MVP 범위에서 삭제되는 것은 아니다.

| 추적 ID | 후속 작업 | 연결된 실행 계획 |
|---|---|---|
| [FUT-01](06_follow_up_backlog.md#fut-01) | 전체 React 도메인 모듈의 production 구현 | M0 구조 검증 → M1 핵심 흐름 → M2 전체 화면, M3 native 조합 |
| [FUT-02](06_follow_up_backlog.md#fut-02) | 로그인·실제 BFF·DB·LLM 및 worker 통합 | M0 계약 → M1 실제 저장·승인 → M2 확장 도메인 |
| [FUT-03](06_follow_up_backlog.md#fut-03) | 선정 UI 라이브러리의 설치·호환성·라이선스 검증 | M0부터 해당 기능의 실제 구현 시 지속 |
| [FUT-04](06_follow_up_backlog.md#fut-04) | Garmin 공식 승인·권한과 자동 수집 | M0 외부 의존 추적 → M1 실제 adapter |
| [FUT-05](06_follow_up_backlog.md#fut-05) | HealthKit native collector·WebView 통합 | M0 실험 → M3 실기기·배포 준비 |
| [FUT-06](06_follow_up_backlog.md#fut-06) | 실제 RAG 색인·검색·인용·삭제 검증 | M2 자료 생명주기 이후 |
| [FUT-07](06_follow_up_backlog.md#fut-07) | 실제 도로 routing | M0 지역·공급자 검증 → M2 코스 기능 |
| [FUT-08](06_follow_up_backlog.md#fut-08) | 지표의 생리학적 타당성·해석·효과 검증 | 정의·계산은 M0/M1, 예측·효능 주장은 별도 검증 gate |
| [FUT-09](06_follow_up_backlog.md#fut-09) | 공유 계획 원문 확보·상세 일정 이식 | 자료 확보 후 사용자의 계획 활성화 전 |
| [FUT-10](06_follow_up_backlog.md#fut-10) | 반응형 3-mode·container·입력 상태 검증 | M0~M2, native M3 |
| [FUT-11](06_follow_up_backlog.md#fut-11) | 영양 계획·실제·팁·코치 | M1b~M2 |
| [FUT-12](06_follow_up_backlog.md#fut-12) | 보강 library·루틴·set actual·코치 | M1b~M2 |
| [FUT-13](06_follow_up_backlog.md#fut-13) | 범용 루틴·유한 배치·진행·실제 링크 | M0 계약 → M1c → M2 |
| [FUT-14](06_follow_up_backlog.md#fut-14) | 스트레칭 library·계획·실제·코치 | M1c → M2, native M3 |
| [FUT-15](06_follow_up_backlog.md#fut-15) | 회복 전략·방법·기록·재평가 | M1c → M2, 효과 검증 별도 |

### 9.1 상태와 완료 근거

`구현 상태`, `착수 준비`, `검증 상태`, `배포 범위`를 분리한다. 설계·mock·프로토타입 테스트와 실제 서비스 통합을 같은 완료로 처리하지 않는다. 외부 API 승인은 권한 증빙으로, 실제 통합은 실행·테스트 결과로, 생리학적 타당성은 해당 주장에 맞는 검증으로 확인한다.

FUT-09의 원문이 없더라도 일반 계획 editor를 개발할 수 있지만, 가상 데이터를 사용자의 실제 계획으로 활성화하지 않는다. Garmin 권한이 없어도 내부 preview는 개발할 수 있지만, 원래 API-first Web MVP의 완료 조건을 무단 축소하지 않는다.

### 9.2 추후 갱신 규칙

작업 착수 시 현재 공식 문서·버전·외부 권한을 확인하고, 관련 ADR과 테스트 fixture를 확정한다. 완료 시 코드·실제 통합·회귀 테스트·운영·보안·삭제·fallback 증거를 연결한 뒤 상태를 갱신한다. 현재 기존 테스트 ID와 본래 요구사항의 의미는 변경하지 않았다.


<a id="v022-requirements"></a>
## 10. v0.2.2 추가 요구와 수용 테스트

명세는 [07](07_responsive_layout.md)·[08](08_nutrition_supplementary_training.md)를 따른다. 아래 **18개 기능 요구사항·36개 수용 테스트는 미구현 기능을 위한 요구**다. 이번 문서 정합성/타입 점검과 실제 기능 시험을 구분한다.

### 10.1 추가 기능 요구사항

| ID | 요구 | 완료 기준 | V022-A 검사 |
|---|---|---|---|
| V022-F01 | 반응형 3-mode 계약 | viewport CSS px 기준 <768 / 768~<1280 / ≥1280, JSON 원본과 생성 fixture를 일치시킨다. | 01~03 |
| V022-F02 | 컨테이너 적응 | module 폭 560/960 기준으로 밀도·split을 조정하며 viewport의 기기명을 강제하지 않는다. | 04 |
| V022-F03 | 상태 연속성 | resize/회전/레이아웃 전환에 draft·selection·focus·set/timer를 유지한다. | 05~07 |
| V022-F04 | 기기별 조작·접근성 | reflow·IME·safe area·touch target·키보드·non-drag 대안을 시험한다. | 08~10 |
| V022-F05 | 영양 계획 | 별도 version과 daily/세션/대회 상대 anchor를 지원하고 actual과 분리한다. | 11,15~16 |
| V022-F06 | 섭취 actual CRUD | 시간·양·단위·출처·부분 값·coverage·정정·삭제를 지원하며 미기록은 0이 아니다. | 12~14 |
| V022-F07 | 식품·성분 기준 | FoodDefinitionVersion·portion 기준·영양 단위를 보존해 계산·정정한다. | 17~18 |
| V022-F08 | 영양 팁·질문 | 일반 팁/개인 제안/의료 검토 필요를 구분하고 근거·제약·누락을 연결한다. | 19~20 |
| V022-F09 | 보강 분류·library | 계열과 장비/저항, 목적·좌우·metric·설명·미디어·review를 구분한다. | 21~22 |
| V022-F10 | 보강 루틴·처방 구조 | versioned routine, reps/time/contacts/load/rest/tempo/RIR를 구조화하고 날짜 세션에 배치한다. | 23~24 |
| V022-F11 | 보강 actual 실행 | set별 실제 확인·부분/중단·timer·정정·오프라인 동기화 대기를 지원한다. | 25~27 |
| V022-F12 | canonical 활동 연계 | 보강 상세와 provider 활동을 한 Activity에 연결하고 parent/bout 이중집계를 막는다. | 28~29 |
| V022-F13 | 통합 주기·Planner | 훈련·보강·영양 레이어와 별도 metrics를 제공하며 완료 분모를 혼합하지 않는다. | 15,29 |
| V022-F14 | joint approval | 훈련/영양 scope·기준 version·data/preference revision을 묶어 원자적으로 적용한다. | 30~32 |
| V022-F15 | RAG·도구 확장 | 영양/동작 자료는 ACL/원문 version으로 검색하고 실제 값은 계산 도구를 사용한다. | 20,33 |
| V022-F16 | 지표 해석 | km·kg×reps·contacts·섭취량을 혼합하지 않으며 null/0·동일 정의를 검증한다. | 18,23~24,34 |
| V022-F17 | 민감정보·삭제 | 식이·불편감·섭취/set·파생 근거의 접근·동의·삭제·계정 전환을 시험한다. | 33,35 |
| V022-F18 | 버전·공개 조건 | legacy endurance 호환, 신규 spec 미지원과 mock/실연동 상태를 구분한다. | 36 |

### 10.2 추가 수용 테스트

| ID | 상황 | 기대 결과 | 연결 V022-F |
|---|---|---|---|
| V022-A01 | 767/768 CSS px로 같은 화면 전환 | 정확히 Mobile/Tablet, fractional 767.9도 Mobile. DOM/초안 값 유지. | 01,03 |
| V022-A02 | 1279/1280 CSS px 경계와 1920 | Tablet/Desktop 계약; 1920은 같은 Desktop의 확장, 허가 기능 차이 없음. | 01 |
| V022-A03 | 1280px tablet에 touch/trackpad 교체 | layout mode와 pointer capability 독립, hover 필수 정보 누락 없음. | 01,04 |
| V022-A04 | 1440px viewport 안에 420px module pane | compact 렌더와 full data 접근; 잘린 editor/3열 강제 없음. | 02 |
| V022-A05 | 입력 중 회전·split-screen·resize | draft/기록 초안/선택/정렬·focus가 유지되고 자동 저장/승인 없음. | 03 |
| V022-A06 | requested split 상태에서 폭 축소 후 확대 | effective tabs로 전환 후 원래 split 의도·가능한 비율 복구. | 03 |
| V022-A07 | DnD 중 breakpoint 통과·pointercancel | drag 취소·capture 정리, 정본 변경/유령 drop/승인 발생 없음. | 03 |
| V022-A08 | 320 CSS px·200% text·400% zoom | 일반 콘텐츠 reflow; 표/지도 예외는 자체 영역, 정보/기능 손실 없음. | 04 |
| V022-A09 | IME composition+가상 keyboard+safe area | Enter 오저장/전송 없음; 입력·오류·저장/coach CTA 접근 가능. | 04 |
| V022-A10 | 원형/세트 버튼·메뉴·range/drag pointer 없이 또는 tap만 사용 | 같은 업무를 키보드·non-drag single pointer로 수행, 클릭 영역/초점 검사. | 04 |
| V022-A11 | 영양 계획 생성·복제 후 actual 조회 | 섭취 기록 자동 생성 안 됨; 먹음 액션은 확인 가능한 actual 초안. | 05 |
| V022-A12 | 섭취 로그 없음 또는 음식 이름만 입력 | 0kcal/굶음으로 단정 안 함; unknown/partial과 알려진 합계 표시. | 06 |
| V022-A13 | 동일 섭취를 날짜와 두 활동에 연결 | 원장 ID 기준 합계 1회; 링크 수로 수량이 늘지 않음. | 06 |
| V022-A14 | 실제 섭취 정정·삭제 | revision·source 보존/보존정책 적용, 관련 집계·evidence·제안 최신성 갱신. | 06,17 |
| V022-A15 | 장거리 세션 이동과 relative nutrition | 미래 영양 영향 포함한 combined preview·동의; actual 섭취 시각 불변. | 05,13,14 |
| V022-A16 | 연결 세션 삭제 또는 종료 시각 불명 | actual cascade-delete 안 함; 미래 상대 항목 unresolved/재연결 요청. | 05 |
| V022-A17 | per-serving와 per-100g를 같은 quantity에 적용 | 기준·수량에 맞춰 한 번만 계산, 원자료 버전과 변환 근거 표시. | 07 |
| V022-A18 | kcal/g/mL/mg, sodium/salt, 섭취/소비 에너지 입력 | 단위와 개념 검증; 불명 변환·혼합합계 없음. | 07,16 |
| V022-A19 | 불완전 섭취와 감량/질병 관련 질문 | 누락으로 결핍/REDs 진단 안 함; 무근거 제한 식단·개인 용량 생성 안 함. | 08 |
| V022-A20 | 사용자 식이 제약이 있고 자료 검색 실패 | 필수 제약 유지; 가짜 인용/무단 대체 처방 없이 답변 범위·질문 제시. | 08,15 |
| V022-A21 | 맨몸 점프 또는 weighted-bodyweight 동작 | 계열·장비 축 모두 표현; 단일 enum 때문에 잘못 분류/누락되지 않음. | 09 |
| V022-A22 | 동작 library·루틴 template 개정 | 이전 승인 세션/actual은 당시 version으로 표시, 자동 대체 없음. | 09,10 |
| V022-A23 | 좌우 10회, total 10회, side 미기록 비교 | count 기준을 유지; 불명 값 자동×2 하지 않음. | 10,16 |
| V022-A24 | 외부저항 없음/보조저항/RIR=0/미응답/contacts 정의 다름 | 0과 null 구분, 체중 임의 환산 및 정의가 다른 contacts 직접 합산 없음. | 10,16 |
| V022-A25 | 세트 계획만 있거나 일부 반복 후 중단 | actual은 확인된 값만; 계획 전체 완료·실패로 임의 확정 안 함. | 11 |
| V022-A26 | 휴식 timer 중 background·네트워크 실패·foreground | 기준 시각/일시정지로 재계산, timer와 미전송 set log 유지. | 11,03 |
| V022-A27 | offline actual log 재전송 및 offline 계획 승인 | 안정 ID로 actual 중복 없음/동기화 대기 표시; 최종 계획 승인 차단. | 11 |
| V022-A28 | provider 보강 활동과 수동 set log가 동일 운동 | canonical Activity 1회 집계, source/set 상세만 연결; 없는 필드 생성 안 함. | 12 |
| V022-A29 | 러닝+보강 parent와 부분 bout 및 영양 이벤트 | 운동 시간/횟수 이중집계·음식의 운동 분모 포함 없음; 불명 구간은 미배정. | 12,13 |
| V022-A30 | combined 승인 직전에 섭취/set/식이 제약 수정 | 관련 dependency freshness 실패, 최신 근거로 다시 검토. | 14 |
| V022-A31 | combined 적용 중 영양 저장 실패·동일 요청 재시도 | 전체 rollback 또는 기존 성공 결과 반환; 반쪽 성공·중복 버전 없음. | 14 |
| V022-A32 | 후보 중 훈련 부분만 선택 승인 | 나머지 영향과 scope를 재계산한 새 후보로 재승인; silent 부분 적용 금지. | 14 |
| V022-A33 | 타 사용자/철회/삭제된 영양·운동 자료가 검색 상위 | LLM 입력·인용·cache 이전 ACL 적용; 자료가 권한·정책 변경하지 않음. | 15,17 |
| V022-A34 | 보강 tonnage·contacts·러닝 km·영양 g와 낮은 HR | 각 metric 정의/한계 유지; 단일 위험/피로 점수·부담 없음으로 단정 안 함. | 16 |
| V022-A35 | 계정 전환·민감 기록 삭제/AI 동의 철회 | 초안·실행 로그·파생 집계/기억·검색의 정책 처리, 사용자 간 잔여 데이터 없음. | 17 |
| V022-A36 | 구형 앱에 새 supplementary spec 또는 unknown provider field | schema version 기반 unsupported/업그레이드; 러닝 변환·실연동 성공 위장 없음. | 18 |

### 10.3 추적·배포·회귀 기준

FUT-10은 반응형, FUT-11은 영양, FUT-12는 보강 구현을 소유한다. FUT-01/02/03/06/08과 연결해 중복 개발 대신 같은 UI·API·근거·승인 경계를 확장한다. v0.2.2 Web MVP는 S01~S30 기본 업무, 반응형 3-mode 기능 동등성, 실제 계획/섭취/운동 기록의 정합성과 joint approval을 포함한다. Native-inclusive는 기존 FUT-05 실기기 gate를 추가한다.

훈련·영양 수치의 의학적 타당성과 개별 처방 효능은 해당 주장에 맞는 FUT-08 검증 대상으로 유지한다. 테스트 계획이나 타입 컴파일을 임상 검증으로 표현하지 않는다. 이전 50개 V2-A와 36개 v0.1 시나리오는 폐기하지 않는다.

<a id="v023-requirements"></a>
## 11. v0.2.3 추가 요구·수용 테스트

명세는 [09 루틴·스트레칭·회복](09_routines_stretching_recovery.md)를 따른다. 아래 18개 기능 요구와 36개 수용 테스트는 **구현할 계약**이며 아직 실행한 기능 검사가 아니다. 기존 V2·V022 요구·테스트는 유지한다.

### 11.1 추가 기능 요구사항

| ID | 요구 | 완료 기준 | V023-A |
|---|---|---|---|
| V023-F01 | 루틴 CRUD·분류 | blueprint 검색·필터·복제·version·보관/삭제와 별도 일정 적용을 구현한다. | 01~02 |
| V023-F02 | 템플릿·배치·실제 분리 | 범용 blueprint와 기존 운동 template을 구분하고 승인 세션/실행 중 version을 보존한다. | 03~04 |
| V023-F03 | 유한 일정 전개 | 요일/N일/주기/session link는 유효 범위·개수 제한·충돌 preview·멱등성을 갖는다. | 05~06 |
| V023-F04 | 루틴 pause·누락 처리 | 미래 계획 영향 확인과 알림 mute를 구분하고 미수행을 자동 누적하지 않는다. | 07~08 |
| V023-F05 | 상대 시각·이벤트 | unresolved anchor·훈련 이동·삭제·늦은 backfill을 처리하고 무승인 계획을 만들지 않는다. | 09~10 |
| V023-F06 | 실행·원장 위임 | run 단계별 사용자 확인을 각 canonical actual에 저장·연결하며 wrapper는 운동이 아니다. | 11~12 |
| V023-F07 | 선택·실행률 | 대안/선택 단계를 분리하고 분모·변경 이력·미확인·중단을 명시한다. | 13~14 |
| V023-F08 | 스트레칭 catalog | 같은 exercise catalog에 method/context/side/review를 추가하고 기존 mobility와 구분한다. | 15~16 |
| V023-F09 | 스트레칭 계획·실제 | 유지/반복/좌우·휴식·출처를 구분하며 timer만으로 실제를 확정하지 않는다. | 17~18 |
| V023-F10 | 단독·부분 운동 통합 | 계획 없는 실제와 workout 내부 block을 지원하고 provider/parent/bout 중복을 막는다. | 19~20 |
| V023-F11 | 회복 전략·휴식안 | 목적·기간·선택지·관찰·재평가를 연결하며 쉬는 안도 정식 후보다. | 21~22 |
| V023-F12 | 회복 방법·검토 | 방법별 원문/조건/검토/한계를 표시하며 미검토 방법의 자동 처방·기기 제어를 하지 않는다. | 23~24 |
| V023-F13 | 비운동 회복 actual | 행동·수면/섭취/운동 관측을 구분하고 정정·삭제·출처를 지원한다. | 25~26 |
| V023-F14 | 분야별 지표·해석 | 실행률과 상태/효과를 구분하고 회복 행동으로 부하를 상쇄하거나 안전 판정을 하지 않는다. | 27~28 |
| V023-F15 | 네 도메인 통합 승인 | training/nutrition/recovery/routine_schedule의 version·read dependency·원자 적용을 검증한다. | 29~30 |
| V023-F16 | 코치·RAG·필수 제약 | 기록/계산/문헌/가설을 분리하고 질문·근거·수정/유지·전문가 검토 결과를 지원한다. | 31~32 |
| V023-F17 | 실행 UI·타이머·복구 | 반응형·좌우/단계·background·두 기기 충돌과 실제 미전송 상태를 검증한다. | 33~34 |
| V023-F18 | 권한·삭제·호환 | 계정·자료 철회·민감 인용·cache를 통제하고 구형 schema를 묵시 변환하지 않는다. | 35~36 |

### 11.2 추가 수용 테스트

| ID | 상황 | 기대 결과 | 연결 V023-F |
|---|---|---|---|
| V023-A01 | 루틴 만들기/검색/복제/즐겨찾기 | blueprint version만 저장하고 일정·섭취·Activity를 자동 생성하지 않는다. | 01 |
| V023-A02 | 사용 중인 루틴 보관/삭제 | 미래 일정 처리와 기록 삭제를 별도로 확인하고 actual cascade-delete가 없다. | 01,02,18 |
| V023-A03 | 활성 루틴 template에 새 version | 이미 승인된 occurrence/세션/진행 중 run은 원래 version으로 유지된다. | 02 |
| V023-A04 | 같은 보강 template을 단독·혼합 routine에서 사용 | pinned workout reference를 재사용하며 별도 동작 정본/세트 template을 복제하지 않는다. | 02 |
| V023-A05 | 무한 recurrence·과다 발생분 요청·기간 끝 넘어감 | 유한 기간/개수 제한을 요구하고 preview에서 범위·충돌을 검증한다. | 03 |
| V023-A06 | 같은 일정 승인/전개를 재전송 | 동일 결과/occurrence를 반환하고 자식 계획이 중복 생성되지 않는다. | 03,15 |
| V023-A07 | 활성 schedule pause/resume 또는 알림만 mute | 미래 계획 변경은 preview/확인; mute는 계획을 취소하지 않고 실제 기록은 유지된다. | 04 |
| V023-A08 | 하루 루틴 미기록·다음 날 진입 | 미실시로 단정하거나 밀린 루틴·강도를 자동 누적하지 않는다. | 04 |
| V023-A09 | session 종료 시각 미정/삭제/날짜 이동 | unresolved·영향 목록·재연결을 제공하며 actual 시각은 불변이다. | 05,15 |
| V023-A10 | 늦은 FIT/HealthKit 업로드·과거 backfill | 발생 시각/유효창으로 처리; 과거 알림·새 계획·승인·자동 완료를 생성하지 않는다. | 05 |
| V023-A11 | routine에서 섭취·운동·체크인 완료 입력 | 각 도메인의 확인된 actual과 step link만 저장하고 Run 자체는 Activity가 아니다. | 06 |
| V023-A12 | 기록 실패 후 재전송 또는 이미 있는 actual 연결 | canonical ID/검증된 배정/멱등성으로 1회 집계하며 타인 기록 연결을 거부한다. | 06,18 |
| V023-A13 | 회복 러닝과 휴식 중 한 가지 선택 | 선택한 대안만 실행 대상이며 둘 다 해야 완료되는 강요가 없다. | 07,11 |
| V023-A14 | 선택적 단계 건너뜀·진행 후 branch 변경 | 분모·선택 이력 보존; 미확인/중단은 완료로 둔갑하지 않고 actual을 삭제하지 않는다. | 07 |
| V023-A15 | mobility와 stretching/정적·동적 동작 검색 | 원래 family/definition을 보존하고 같은 catalog의 전문 필터로 표시한다. | 08 |
| V023-A16 | 사용 중인 설명 자료/동작 version 철회 | 역사 version은 재작성하지 않지만 새로운 실행/추천은 유효성 확인 후 제한한다. | 08,12,18 |
| V023-A17 | 좌우 유지시간 미입력·전체 timer·휴식 포함 | 전체시간 자동÷2/계획값 복사 없이 side·hold·rest·unknown을 분리한다. | 09 |
| V023-A18 | timer 종료·일부 반복 후 중단 | actual 완료는 사용자 확인/측정 출처 필요, 미완료·중단·이유를 보존한다. | 09,17 |
| V023-A19 | 계획 없는 단독 stretching 실행 | 가짜 PlanVersion 없이 Activity와 실제 상세 저장 가능; run wrapper 중복 없음. | 10 |
| V023-A20 | Garmin 혼합/yoga 요약+러닝 warmup block+수동 stretch log | 없는 세부값 생성 금지, source/배정 범위를 확인하고 parent/child 시간을 중복 집계하지 않는다. | 10 |
| V023-A21 | 새 회복 전략 생성·휴식 선택 | 목적/기간/선택/다음 관찰을 가지며 별도 운동 추가나 실제 휴식 확정을 강제하지 않는다. | 11 |
| V023-A22 | 재평가 조건에 해당하는 체크인/계획 변화 | 알림/새 검토까지; 사용자 동의 없는 계획 변경·기기 동작·자동 승인 없음. | 11,15 |
| V023-A23 | 미검토 EMS/냉·온 등 method의 수동 기록과 추천 요청 | 사실 기록은 가능하나 자동 용량/효과 보장/치료·기기 제어를 하지 않는다. | 12 |
| V023-A24 | 방법 카드에 단기 체감 근거만 있음 | 그 근거로 장기 적응·다음 수행의 효과까지 확정하거나 종합 효능 순위를 만들지 않는다. | 12,16 |
| V023-A25 | 취침 준비/휴식 시간표 완료 | 행동 확인과 실제 수면/회복 상태는 분리되고 기록 없음을 충분한 휴식으로 채우지 않는다. | 13 |
| V023-A26 | 회복 strategy에서 기존 Intake/Activity/CheckIn 연결·정정 | 원장을 재사용하고 정정 revision으로 근거 무효화; 별도 복제 합계 없음. | 13,15 |
| V023-A27 | routine 100% 또는 여러 회복 행동 수행 | 실행률은 행동 지표; readiness 가산·훈련 부하 차감·부상 안전 허가 없음. | 14 |
| V023-A28 | 회복 후 체감 개선과 높은 기기 점수, 새 불편감 | 개선은 보고로 유지; 원인/효능을 확정하지 않고 새 보고/불확실성을 검토한다. | 14,16 |
| V023-A29 | 통합 승인 직전 run·체크인·회복 계획 또는 없던 head 생성 | 모든 관련 read/write dependency 검사로 stale 거부; 변경한 후보는 재승인. | 15 |
| V023-A30 | 훈련/영양/회복/schedule 저장 중 하나 실패·성공 응답 유실 | 전체 rollback 또는 동일 이전 성공 반환; 부분 적용·중복 생성 없음. | 15 |
| V023-A31 | 루틴 단축·스트레칭·회복 상담에 일부 기록만 있음 | 필수 제약과 unknown을 유지하고 원인 추측을 사실로 저장하지 않는다. | 16 |
| V023-A32 | RAG 상충·자료 없음·문서 안 악성 지시 | 해당 원문/불확실성·답변 범위 표시; 인용 생성·권한/정책 해제 없음. | 16,18 |
| V023-A33 | 767/768·1279/1280 전환·420px pane·IME·touch | 단계/좌우/선택/초안 유지; non-drag/텍스트 대안/중단 액션 접근 가능. | 17 |
| V023-A34 | 타이머 background/시각 변경·offline 재전송·다중 기기 수정 | 실제와 timer 분리, outbox/revision 충돌 표시·해결; 자동 완료/최종 offline 승인 없음. | 17 |
| V023-A35 | 계정 전환·회복 기록/루틴/자료 삭제·coach 사용 철회 | cache/미전송 로그/민감 발췌/파생 기억 정책 적용·타인 노출 차단. | 18 |
| V023-A36 | 구형 앱에 schemaVersion 4 또는 새 방법/단계 | unsupported와 적절한 안내; 러닝/영양 payload로 silent 변환하지 않는다. | 18 |

### 11.3 범위·출시·정합성

현재 Web MVP의 기본 업무는 S01~S35다. 기존의 반응형·실제 수집·보안·삭제·운영 조건을 줄이지 않는다. M1c에서 일반 루틴/스트레칭/회복의 수동 core를 먼저 만들고 M2에서 검토된 자료/RAG·코칭과 결합한다. 자동 알림·provider/native 상세 필드는 해당 구현/권한 gate를 별도로 충족해야 한다.

FUT-13은 범용 루틴, FUT-14는 스트레칭, FUT-15는 회복을 소유한다. FUT-12의 운동 template·세트와 FUT-13의 범용 조합을 다른 객체로 유지한다. FUT-08은 회복·부상·성능 효과 주장에 대한 별도 검증이다. 전체 방법을 추천하거나 새로운 치료/회복 효과를 자동 주장하는 기능은 이 문서 추가만으로 공개하지 않는다.

테스트의 기계 판독본은 [qa/v023-acceptance-plan.json](qa/v023-acceptance-plan.json)이다. `not_executed` 상태를 문서 검사 결과와 혼동하지 않는다. 새 구현이 추가될 때 API·DB·UI·실기기별 실행 증거를 연결한다.
