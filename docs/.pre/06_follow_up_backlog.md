# 06 · 후속 개발 백로그 / 확장·검증 계획 v0.2.3

> v0.2.3 · 2026-09-16: [09 루틴·스트레칭·회복 전략](09_routines_stretching_recovery.md)과 S31~S35, FUT-13~15, V023 요구·시험을 추가했다. 기존 계약·이력은 유지하며 신규 기능은 아직 미구현이다. 아래 이전 버전 설명은 당시 기준이며 새 범위는 09와 05 §11을 따른다.

- 문서 기준일: 2026-09-16
- 목적: 기존 미완료 항목, 반응형·영양·보강과 v0.2.3 루틴·스트레칭·회복 요구를 이후 개발 티켓으로 전환할 수 있게 보존한다.
- 변경 성격: **문서 보완만 수행했다. 실제 기능 구현, 외부 승인 확보, 새로운 호환성·생리학 검증을 수행한 것이 아니다.**
- 상태 근거: 이전에 지정한 9개 미완료 항목과 이번 반응형·영양·보강 요구. 실제 외부 계정·저장소·API 상태는 재확인하지 않았다. v0.2.2에서 일부 공개 표준 문서를 추가 검토했으나 기능/외부 연동 상태가 바뀐 것은 아니다.
- 연결 문서: [구현 요구사항](05_implementation_requirements.md), [화면 기획](01_product_screen_spec.md), [프론트엔드 구조](02_frontend_architecture.md), [디자인 시스템](03_design_system.md), [연동·점수·RAG](04_integrations_metrics_rag.md).

> **이 목록은 기능의 폐기나 MVP 범위 축소가 아니다.** 이미 합의한 기능을 후속 구현 대상으로 추적한다. 개발 순서, 외부 승인, 자료 확보, 과학적 검증은 서로 다른 종류의 의존성이다.

## 1. 현재 기준선과 상태 규칙

v0.2에는 설계 문서, 타입·순수 함수 예제, 가상 데이터 기반 HTML 프로토타입이 있다. 이를 production React 앱, 실제 로그인·BFF·데이터베이스, Garmin·HealthKit·RAG·routing의 통합 완료로 해석하지 않는다. 기존 프로토타입의 검사 결과는 보존하지만 이번에 재실행한 결과는 아니다.

기존 상태 설명은 [개발 요구사항 §8](05_implementation_requirements.md#8-prototype의-실제-검증-범위), 기존 브라우저 검사 기록은 [prototype-results.json](qa/prototype-results.json)을 참조한다. 이 기록은 실제 서버·공급자·native·생리학 검증의 증거가 아니다.

| 상태 차원 | 사용할 값 | 의미 |
|---|---|---|
| 구현 | 미착수 / 진행 / 검토 / 완료 | 코드와 통합 상태. 설계가 있다는 이유로 완료 처리하지 않는다. |
| 준비 | 개발 가능 / 결정 대기 / 외부 승인 대기 / 자료 대기 / 검증 설계 필요 | 지금 시작하지 못하는 이유. 코드 상태와 분리한다. |
| 검증 | 미수행 / 실험 / 검토 / 통과 / 실패 | 아래 수용 기준에 대한 증거가 있는지 나타낸다. |
| 배포 | 비활성 / 개발 전용 / 제한 공개 / 운영 | 어느 사용자·환경에 실제 기능을 노출하는지 나타낸다. |

모든 항목의 담당자는 **미지정**이다. 개발 기간과 마감일도 미확정이며, 외부 승인 대기 기간을 개발 공수로 간주하지 않는다. 완료 표시는 커밋·테스트·승인·검토 기록 등 증거가 연결된 뒤에만 갱신한다.

## 2. 추적 목록

| ID | 후속 작업 | 현재 상태 | 시작 조건 | 목표 단계 |
|---|---|---|---|---|
| FUT-01 | 전체 React 모듈의 production 구현 | production 미착수 / 미검증 | 모듈·Host 계약과 도구 버전 결정 | M0 → M1 → M2, mobile 조합 M3 |
| FUT-02 | 로그인·실제 BFF·데이터베이스·서버 통합 | 미구현 / 미검증 | 인증 방식·배포 환경·데이터 계약 확정 | M0 → M1, 확장 도메인 M2 |
| FUT-03 | UI 라이브러리 설치·호환성·라이선스 검증 | 후보 선정 상태 / 통합 미검증 | 대표 화면·대상 플랫폼·검증 매트릭스 | M0부터 지속 |
| FUT-04 | Garmin 공식 권한 확보와 실제 자동 수집 | 권한 확보·실연동 미완료 | 신청 조건·Activity/Health 권한·파트너 명세 | M0 병행 → M1 |
| FUT-05 | HealthKit native collector와 WebView 통합 | native 미구현 / 실기기 미검증 | iOS 앱·서명·기기·권한·수집 유형 | M0 실험 → M3 |
| FUT-06 | 실제 RAG 색인·검색·인용 연결 | 설계 상태 / 실제 색인·검색 미구현 | 자료 생명주기·ACL·버전·평가 코퍼스 | M2 |
| FUT-07 | 도로·보행망 기반 route planner | 실제 routing 미연결 | 공급자·키·이용 조건·지역 테스트 코스 | M0 실험 → M2 |
| FUT-08 | 피로·부하·부상 관련 지표의 타당성 검증 | 의미·계산 설계 / 생리학 검증 미수행 | 주장 범위·측정 정의·검증 계획·검토자 | 정의 M0/M1, 검증 별도 트랙 |
| FUT-09 | 공유 계획 원문 확보와 상세 일정 이식 | 원문 미확보 / 이식 미확정 | 전체 본문 또는 사용자가 확인 가능한 export | 자료 확보 후, 사용자의 계획 활성화 전 |
| FUT-10 | Mobile/Tablet/Desktop 반응형 명세 적용·검증 | 명세 보완 / UI 적용·수용 시험 미수행 | 07·responsive-spec·대표 화면·기기 matrix | M0 → M1/M2, native M3 |
| FUT-11 | 영양 팁·계획·섭취 actual·코치 통합 | 신규 설계 / 미구현·미검증 | 단위·부분 기록·자료·joint approval 계약 | M1b → M2 |
| FUT-12 | 보강 동작·루틴·실제 set·코치 통합 | 신규 설계 / 미구현·미검증 | 동작·좌우/count/load·canonical activity 계약 | M1b → M2, native M3 |
| FUT-13 | 범용 루틴 관리·유한 배치·실행 | 설계 / 미구현·미검증 | 기존 도메인 원장·유한 전개·실제 연결 계약 | M0 → M1c → M2 |
| FUT-14 | 스트레칭 계획·실제·자료 | 설계 / 미구현·미검증 | 동작 catalog·좌우/시간·콘텐츠 검토 | M1c → M2, native M3 |
| FUT-15 | 회복 전략·방법·실행 | 설계 / 미구현·미검증 | 관측/계획/실제·효과 주장·통합 승인 구분 | M1c → M2, 효능 검증 별도 |

FUT-01~09는 이전에 지정한 미완료 묶음이고 FUT-10~12는 v0.2.2 추가 요구의 후속 카드다. v0.2.3에서 FUT-13~15를 추가해 현재 총 15개 항목이다. 실제 LLM 연결, 계정별 보안, 운영 배포, 미디어 처리 등 연관 작업이 완료되었다는 뜻은 아니다. 관련 작업은 FUT-01/02 및 공통 release gate에서 계속 추적한다.

## 3. 항목별 개발 카드

<a id="fut-01"></a>
### FUT-01 · React 도메인 모듈의 production 구현

**완료할 가치:** 같은 도메인 모듈을 Web Page와 Mobile Web Shell에서 재사용하면서 실제 데이터를 조회·수정한다.

| 항목 | 내용 |
|---|---|
| 연관 요구 | V2-F01~F16, V2-F18~F22, V2-F31~F35. 현재 화면 범위는 S01~S35이며 FUT-10~15를 함께 따른다. |
| 연관 테스트 | V2-A01~A18, A45~A50 |
| 선행·병행 | FUT-03의 핵심 라이브러리 검증. 초기는 mock transport, 운영 연결은 FUT-02. |
| 확장 지점 | `apps/web`, `apps/mobile-web`, `packages/modules/*`, `packages/experience/*`, `packages/platform` |
| 결과물 | React 모듈, thin route wrapper, Host adapter, UI stories, 라우트·상태별 테스트 |

**작업 범위**

- `HostContext`, navigation, transport, capabilities를 실제 코드로 구현한다. 모듈 내부에서 플랫폼 전용 API를 직접 호출하지 않게 한다.
- Dashboard → Activities → Planner → Coach → Proposal 흐름을 먼저 연결하고, 코스·기록·Gallery·Resources·계정 화면으로 확장한다.
- 달력·표·agenda·Orbit가 동일한 날짜 범위·선택·초안을 사용하도록 구현한다. 실제 기록과 승인 계획, 사용자 초안과 AI 제안을 별도 레이어로 유지한다.
- 로딩·빈 데이터·일부 데이터·오류·stale·권한 없음·저장 충돌 상태를 포함한다. 모듈별 lazy loading과 오류 격리를 구현한다.
- 초안 보존, 로그아웃·계정 전환 시 캐시 제거, 접근성·touch·IME·safe area를 구현한다.

**완료 기준**

- [ ] 동일한 대표 모듈이 Next wrapper와 Vite shell에서 public 계약 변경 없이 실행된다.
- [ ] 모든 화면군의 실제 데이터 경로와 필수 상태를 점검하고, 미완성 화면은 완료로 표시하지 않는다.
- [ ] 타 모듈 internal import와 browser bundle의 server-only 의존성이 CI에서 차단된다.
- [ ] drag/menu/date input의 변경 결과가 동일하며, 서버 승인 전 정본 계획은 바뀌지 않는다.
- [ ] production build, 키보드·모바일·접근성 테스트와 실제 API end-to-end 결과가 기록된다.

**미완료 시:** 기존 HTML은 디자인·상호작용 참고물로만 유지한다. React로 화면을 옮긴 것만으로 production 완료 처리하지 않는다.

<a id="fut-02"></a>
### FUT-02 · 로그인·BFF·데이터베이스와 실제 서버 경로

**완료할 가치:** 사용자의 기록과 계획을 영속 저장하고, 인증된 작업과 AI 제안을 안전하게 적용한다.

| 항목 | 내용 |
|---|---|
| 연관 요구 | V2-F04~F05, F12, F15~F17, F22~F24, F28, F31, F33~F36 및 v0.1 승인 불변 조건 |
| 연관 테스트 | V2-A03~A06, A15~A16, A19~A20, A38~A47 및 기존 동시성 테스트 |
| 선행 조건 | 인증 공급자/방식, Web·native 세션 계약, 배포·비밀값·보존 정책 결정 |
| 확장 지점 | `apps/api`, `apps/worker`, `packages/server/*`, `packages/contracts`, `packages/api-client` |
| 결과물 | migrations, 인증·동의, BFF read models, command API, worker, 운영 설정·복구 절차 |

**작업 범위**

- 가입·로그인·로그아웃·세션 만료·계정 복구·연결 철회 흐름을 선정한 인증 방식에 맞춰 구현한다.
- User/Consent, PlanPeriod/PlanVersion, Activity/Source/Revision, CheckIn, Proposal/Approval, Connection/Sync, Resource/Passage 등 도메인을 단계별 migration으로 추가한다.
- source/canonical/overlay와 삭제 억제 상태를 분리하고, 날짜·단위·주간·rolling·Block 집계 정의를 서버에서 통일한다.
- `/bff/v1`의 화면 조회와 application command를 연결한다. API 계약에서 클라이언트와 runtime 검증을 생성하되 DB 모델을 브라우저에 직접 공유하지 않는다.
- 실제 LLM provider adapter, 제한된 도구, EvidenceSnapshot, 실행 상태·취소·예산·오류를 연결한다. API key 설정만으로 코칭 완료 처리하지 않는다.
- 승인 해시·기준 버전·최신성·멱등성·원자적 저장을 구현한다. DB transaction 안에서 외부 모델이나 provider를 호출하지 않는다.
- outbox/job 재시도, 업로드·객체 접근, 내보내기·삭제·백업 복구·배포 설정을 구현한다.

**완료 기준**

- [ ] 서비스 재시작 뒤에도 기록·계획·진행 상태가 보존된다.
- [ ] 다른 계정의 API·파일·검색·제안에 접근할 수 없다. 로그아웃과 계정 전환의 잔여 캐시도 시험한다.
- [ ] 실제 활동 수집 → 조회 → 코칭 → 제안 → 명시 승인 → 새 PlanVersion을 통합 시험한다.
- [ ] stale/중복/동시 승인, worker 중단·재시도에서 정본이 손상되지 않는다.
- [ ] 실제 LLM 호출 실패는 `unable_to_evaluate`로 처리하고 무승인 변경이나 가짜 성공을 만들지 않는다.
- [ ] 배포·migration·backup restore·삭제·관측 가능성의 검증 기록이 있다.

**미완료 시:** 인증·영속화가 없는 환경은 가상·개발 데이터용으로만 사용한다. production 사용자 건강 자료를 저장하는 서비스로 공개하지 않는다.

<a id="fut-03"></a>
### FUT-03 · UI 라이브러리 설치·호환성·라이선스 검증

**완료할 가치:** 후보 이름이 아니라 실제 선택된 버전 조합에서 실행 가능한 UI stack을 확정한다.

| 항목 | 내용 |
|---|---|
| 연관 요구 | V2-F01~F05, F08~F10, F13, F19, F21, F32, F35 |
| 연관 테스트 | V2-A01~A06, A12~A14, A36, A48~A50 |
| 선행 조건 | Node/package manager/React/Next/Vite/native host의 대상 버전과 기기 정의 |
| 확장 지점 | `apps/storybook`, 각 Experience Kit의 `adapters`, `packages/tooling` |
| 결과물 | lockfile, 통합 fixture, license 목록, 호환성 보고서, 선택·대체 ADR |

다음은 **기존 선정 후보의 검증 목록**이다. 이 문서에서 설치 성공이나 현재 라이선스·호환성을 새로 확인한 것은 아니다.

| 기능 | 후보 | 필수 실험 |
|---|---|---|
| DnD | dnd-kit | touch scroll 충돌, keyboard, overlay, virtual list |
| 분할 패널 | react-resizable-panels | pointer·키보드 resize, 최소 크기, 모바일 전환 |
| Dashboard 배치 | react-grid-layout | responsive, 편집 모드, 저장·복원 |
| Chart | ECharts | production bundle, zoom, 선택 연동, 대량 데이터 |
| Table | TanStack Table | controlled state, 정렬·filter, virtualization |
| 기본 interaction | Radix Primitives | portal, focus, dropdown·dialog·tooltip·slider |
| Editor | Tiptap | 한글 IME, serialization, sanitization, extension license |
| Carousel | Embla | touch·nested scroll·접근성 |
| Gallery | Yet Another React Lightbox | image/video plugin, private asset, unsupported codec |
| Map | MapLibre GL JS | worker·CSP·WebGL·mobile memory |
| Video | HTML video + Media Chrome | controls, fullscreen, iOS inline, 오류 복구 |
| Conversation | assistant-ui | external-store, streaming·tool result·승인 분리 |
| Calendar | FullCalendar adapter | calendar·table 상태 공유, 필요한 기능의 license |
| Circular UI | React SVG + D3 hierarchy | sector selection, list 대안, 부모 복귀 |
| Date / range | React DayPicker | locale·timezone·keyboard·range |
| Motion | Motion | reduced motion, layout animation, WebView 성능 |

**완료 기준**

- [ ] 실제 설치·production build·peer dependency·SSR/hydration/client-only 경계를 검사한다.
- [ ] 정확한 버전, license·상업 조건, 필요한 extension 비용과 근거 확인일을 기록한다.
- [ ] 대표 기능을 개별 story뿐 아니라 지도+차트+표+editor 등의 조합 화면에서 시험한다.
- [ ] Next web과 Vite shell에서 실행하고, native 용도는 해당 WebView 실기기 결과를 별도로 남긴다.
- [ ] 실패한 후보는 대체 ADR을 남기고 public kit 계약을 보존한다. 설치 성공만으로 전체 호환 완료 처리하지 않는다.

**검증 표 양식:** `기능 | 라이브러리/버전 | host/OS/기기 | build | runtime | touch/IME/a11y | license | 실패/대안 | 증거/확인일`.

<a id="fut-04"></a>
### FUT-04 · Garmin 공식 권한과 실제 자동 FIT 수집

**완료할 가치:** 사용자가 Garmin 연결에 동의하면 허가된 실제 활동·지표가 안정적으로 들어온다.

| 항목 | 내용 |
|---|---|
| 연관 요구 | V2-F25~F28, F30~F31 |
| 연관 테스트 | V2-A19~A25, A29, A45~A47 |
| 상태 구분 | 권한 확보와 실연동은 미완료. 신청 접수 여부·현재 심사 상태는 별도 확인 필요. |
| 선행 조건 | 자격·사용 목적·파트너 승인·계약, Activity/Health별 entitlement와 실제 명세 |
| 확장 지점 | `server/integrations/garmin`, sync worker, `modules/connections`, ingestion |
| 결과물 | 권한 증빙, capability matrix, 실제 payload fixtures, OAuth·sync adapter, 운영 runbook |

**작업 범위**

- 신청·심사·추가자료·sandbox·production 권한을 각각 추적한다. 세부 API 조건은 구현 시 공식 자료와 승인 계정 문서로 재확인한다.
- 앱 로그인과 provider 연결을 분리하고, 파트너 명세에 맞춰 OAuth callback·credential 보관·갱신·철회를 구현한다.
- 실제 FIT/JSON 샘플로 contract test를 작성한다. 공개 소개만 보고 endpoint·signature·payload를 확정하지 않는다.
- backfill과 live 수집, 중복·역순 event, token 경쟁 갱신, rate limit, 재시도·연결 해제·재연결을 구현한다.
- 제공 가능한 지표만 capability에 표시한다. Garmin 화면에 보인다는 이유로 모든 점수를 수집 가능으로 표시하지 않는다.

**완료 기준**

- [ ] 요청한 사용 사례와 데이터에 대한 실제 사용 권한·조건이 확인되었다.
- [ ] 실제 사용자 연결부터 FIT 수집·정규화·화면 표시까지 증거가 있다.
- [ ] 권한 없음·철회·만료·중복·역순·일시 장애·backfill/live 충돌을 시험했다.
- [ ] 로컬 정정은 원본 writeback과 구분되고, 로컬 삭제 후 재수집 정책이 동작한다.
- [ ] 원본과 수집 시각·출처가 추적되며 로그에 credential이 노출되지 않는다.

**미완료 시:** mock과 파일 import는 개발 대체 경로다. 이를 Garmin 자동 연동으로 표시하지 않는다. 승인 지연 시 제한 preview를 별도로 표시하고, 원래 Garmin API-first MVP의 완료 조건을 조용히 축소하지 않는다.

<a id="fut-05"></a>
### FUT-05 · HealthKit native 구현과 WebView 통합

**완료할 가치:** iOS 앱의 수집기에서 들어온 실제 자료를 웹·모바일의 같은 모듈로 조회한다.

| 항목 | 내용 |
|---|---|
| 연관 요구 | V2-F05, F29~F31, F34 |
| 연관 테스트 | V2-A04~A06, A26~A30, A47~A50 |
| 선행 조건 | iOS 앱·서명·테스트 기기, 대상 OS·데이터 유형·동의·전송 정책 확정 |
| 확장 지점 | `apps/mobile`, Swift collector, platform bridge, `/v1/ingestion/healthkit/batches` |
| 결과물 | native collector, durable outbox, batch API, capability·sync UI, 실기기 보고서 |

**작업 범위**

- 구현 시작 시 현재 공식 API·권한·OS별 지원을 확인하고 읽을 유형과 상태 표현을 확정한다.
- 데이터 유형별 요청, 증분 조회·삭제 추적, local outbox, server acknowledgement, 재시작·재설치·재조정을 구현한다.
- native 수집과 UI bridge를 분리한다. bridge에는 허용된 기능·상태·요약만 제공하고 credential·원본을 무제한 노출하지 않는다.
- foreground 재확인, background 지연, 네트워크 단절·권한 변화·빈 결과를 다룬다.
- Garmin에서 넘어온 동일 운동의 lineage와 canonical 중복 처리를 검증한다.

**완료 기준**

- [ ] 실제 iOS 기기에서 동의 → 실제 자료 수집 → 서버 → 공통 화면이 연결된다.
- [ ] outbox와 cursor/anchor 저장 순서, 실패 후 재전송·삭제·reset을 시험해 누락·중복을 점검한다.
- [ ] 빈 조회 결과를 데이터가 없거나 접근 가능 범위를 알 수 없는 상태와 구분 없이 단정하지 않는다.
- [ ] 앱 lifecycle, IME·safe area·back·사용자 전환과 native transport 경계를 검증한다.
- [ ] 개인정보·AI 전달 동의와 앱 배포 준비를 별도로 확인한다. 실기기 기능 검증과 앱 심사 결과는 분리한다.

**미완료 시:** 웹에서 지원 상태와 native 필요 조건을 안내한다. Apple 자동 import를 제공한다고 표시하지 않는다. Apple 자동 수집이 필수인 배포는 이 항목이 release gate다.

<a id="fut-06"></a>
### FUT-06 · 실제 RAG 색인·검색·근거 연결

**완료할 가치:** 사용 권한이 있는 자료의 정확한 버전·원문 위치를 찾아 코칭 답변의 근거로 연결한다.

| 항목 | 내용 |
|---|---|
| 연관 요구 | V2-F22~F24, F31, F35~F36 |
| 연관 테스트 | V2-A38~A44 및 인용·수치 검증 |
| 선행 조건 | FUT-02의 인증·자료 저장·ACL·삭제, 코퍼스 사용 권한, 평가 질문·근거셋 |
| 확장 지점 | `server/retrieval`, indexing worker, ResourceVersion/Passage, `modules/resources`, citation UI |
| 결과물 | parser·index jobs, hybrid search, 인용 payload, 평가셋·보고서·삭제 테스트 |

**작업 범위**

- 자료 등록·격리·추출·버전·원문 locator·coach-use를 구현한 뒤 색인한다. 업로드와 검색 가능 상태를 분리한다.
- 현재 라이브러리·모델·비용을 검증한 후 lexical+vector 검색, 후보 병합과 필요 시 rerank를 구현한다.
- 사용자·자료 권한과 coach-use·삭제·버전을 모델 입력 이전에 검사한다. cache에도 권한 revision을 반영한다.
- 활동 합계·계획·필수 제약은 구조화 도구로 제공한다. RAG가 없다는 이유로 필수 제약이 문맥에서 빠지지 않게 한다.
- 실제 passage를 EvidenceSnapshot에 연결하고, 답변의 인용에서 당시 원문 위치를 열 수 있게 한다.
- 출처 없음·상충·유효하지 않은 버전·자료 속 악성 지시·삭제 지연을 처리한다.

**완료 기준**

- [ ] 실제 자료의 등록 → 색인 → 검색 → 실제 모델 응답 → 원문 인용 이동을 통합 시험한다.
- [ ] 타 사용자 자료·coach 사용 해제·삭제 자료가 모델 문맥과 캐시에 재노출되지 않는다.
- [ ] no-RAG/작은 검토 자료 묶음/hybrid의 검색·답변·인용·비용·지연 비교 결과를 남긴다.
- [ ] 품질 임계값을 평가 전에 정하고 미달이면 범위·설정·검색 방식을 수정한다.
- [ ] 인용 문장의 의미가 원문으로 지지되는지 검토한다. 검색 성공을 훈련 효과 검증으로 취급하지 않는다.

**미완료 시:** 자료실은 저장·reader로 제공할 수 있지만 코칭 반영 상태는 비활성·미색인으로 표시한다. 가짜 인용을 만들지 않는다.

<a id="fut-07"></a>
### FUT-07 · 실제 도로 routing과 코스 관리

**완료할 가치:** 경유점으로 실제 routing 결과를 계산·검토하고, 코스 버전으로 저장한다.

| 항목 | 내용 |
|---|---|
| 연관 요구 | V2-F18~F19, F35 |
| 연관 테스트 | V2-A17~A18, A34~A35 |
| 선행 조건 | 공급자·profile·권한·비용·quota·표시 조건, 한국 지역의 대표 검증 코스 |
| 확장 지점 | `experience/geo-kit`, `server/integrations/routing`, Course/RouteRevision |
| 결과물 | routing adapter, 실제 geometry, error/stale 처리, 지역 품질·비용 보고서 |

**작업 범위**

- 지도·경로 계산·geocoding·고도·tile의 역할과 공급자를 구분하고 실제 조건을 확인한다.
- 경유점 편집을 draft로 유지하면서 routing 요청 취소·순서·버전을 관리한다.
- 지도·도로망 기반 계산 결과에 engine/profile/source/createdAt와 경고를 저장한다.
- 대표 보행로·다리·공원·교차로 등에서 계산 경로를 검토하고 지도와 실제 통행 조건이 다를 수 있음을 표시한다.
- quota·timeout·경로 없음·부분 실패를 처리하고 코스 저장·revision·GPX 내보내기를 연결한다.

**완료 기준**

- [ ] 실제 공급자가 반환한 경로와 거리·출처를 표시하고 검토한 결과만 저장한다.
- [ ] 빠른 경유점 수정에서 오래된 응답이 최신 결과를 덮어쓰지 않는다.
- [ ] 요청 실패·quota 초과에서도 draft가 보존되며 직선 스케치를 계산 성공으로 표시하지 않는다.
- [ ] 대표 지역 품질, 이용 조건·표시 의무·credential·좌표 최소화 정책을 검토한다.

**미완료 시:** 지도와 waypoint 스케치를 제공하더라도 도로 경로가 계산되었다고 표현하지 않는다.

<a id="fut-08"></a>
### FUT-08 · 피로·부하·부상 관련 지표의 타당성 검증

**완료할 가치:** 지표가 무엇을 의미하고 어느 범위에서 사용할 수 있는지 근거와 함께 설명한다.

| 항목 | 내용 |
|---|---|
| 연관 요구 | V2-F14, F17, F27, F36 |
| 연관 테스트 | V2-A24, A30~A33 및 별도 연구 프로토콜 |
| 선행 조건 | 사용 목적·주장 범위·측정 정의·결과 정의·데이터 동의·검토자·검증 계획 |
| 확장 지점 | Measurement/MetricDefinition, `server/metrics`, `modules/wellbeing`, coaching tool |
| 결과물 | 지표별 model/metric card, 계산 fixture, 연구 계획·결과·한계·공개 기준 |

**세 종류의 완료를 구분한다.**

| 단계 | 검증 내용 | 충족해도 자동으로 주장할 수 없는 것 |
|---|---|---|
| 데이터·계산 | 원점수 수집, 단위·시간·계산·누락 처리의 정확성 | 생리 상태를 정확히 예측한다는 주장 |
| 해석·사용성 | 라벨·척도·근거·한계를 사용자가 이해하는지 | 부상 확률·안전한 훈련 강도의 확정 |
| 예측·효과 | 사전에 정한 결과와 기간에 대한 독립 검증·calibration·전문가 검토 | 검증 대상 밖의 집단·기간·사용 목적 |

**작업 범위**

- 제공자 점수·사용자 보고·자체 계산·예측 가설을 구분한다. 제공자 점수 수집 성공과 우리 서비스의 해석·활용 검증도 별도다.
- metric definition/version/input provenance를 유지하고, baseline 부족·결측·측정 방식이 다른 출처를 시험한다.
- 자체 0~100 표현의 의미를 정의한다. 개인 내 상대 위치를 피로율·부상 확률로 이름 바꾸지 않는다.
- 예측 기능이 필요하면 target/outcome/horizon을 먼저 정하고, 시간·사용자 분리 검증과 누출·calibration·실패 사례·소집단 편차를 평가하도록 연구 계획을 작성한다.
- 전문가 검토·필요한 윤리·규제 검토·데이터 요건을 착수 전에 확인한다. 검증이 부족하면 표현과 기능 범위를 제한한다.

**완료 기준**

- [ ] 공개하는 모든 지표에 뜻·출처·정의·시각·한계·미산출 조건이 있다.
- [ ] 계산 정확성과 생리학적 타당성에 서로 다른 증거를 연결한다.
- [ ] 고위험 해석은 문서화한 독립 검증과 검토 없이 일반 사용자에게 노출하지 않는다.
- [ ] 검증 결과가 불충분하거나 음성이어도 기록하고, 기능 축소·비활성 결정을 남긴다.
- [ ] 출시 뒤 성능·입력 변화·잘못된 안심 유발에 대한 재평가 기준을 둔다.

**미완료 시:** 원점수·관측·보고·명확한 계산과 데이터 부족을 표시한다. 미검증 부상 확률·독자 readiness 합성 점수나 자동 안전 허가를 제공하지 않는다. 이 제한은 일반 계획·기록 앱 개발을 막는 것이 아니라 해당 **효능 주장·고위험 기능**의 공개 조건이다.

<a id="fut-09"></a>
### FUT-09 · 공유 계획 원문 확보와 상세 일정 이식

**완료할 가치:** 사용자가 합의한 실제 계획을 출처와 의도를 보존하며 승인된 최초 계획으로 가져온다.

| 항목 | 내용 |
|---|---|
| 연관 요구 | V2-F06~F11, F16 및 v0.1 계획 가져오기·버전 요구 |
| 연관 테스트 | V2-A07~A11, A16, A45~A46 |
| 기준 원문 | `https://chatgpt.com/share/6aa89754-1ea4-83ee-b91a-5ed2a1955bd9` |
| 현재 상태 | 기존 기록상 전체 본문 미확보. 이번 문서화에서 링크 본문을 새로 조회하거나 이식하지 않았다. |
| 선행 조건 | 전체 텍스트·Markdown·사용자 제공 파일 등 확인 가능한 원문. 후반 수정·선택 전략 포함 여부 확인. |
| 확장 지점 | PlanImportDraft / source snapshot / extraction mapping / `modules/planning` |
| 결과물 | 원문 snapshot, 추출 매핑, 미확인 목록, 일정 preview, 승인된 PlanVersion |

**작업 범위**

- 링크 접근이 안 되면 사용자가 제공한 본문·export를 받는다. URL이나 제목만으로 상세 날짜·세션을 복원하지 않는다.
- 원문 시점·구간·후속 정정·사용자가 선택한 전략을 확인한다. 여러 전략이 있으면 무엇을 활성화할지 명시적으로 확인한다.
- Season/Wave/Phase/Block, 일별 session, 목적·우선순위·고정 일정·단위·시간대를 추출하고 원문 위치와 연결한다.
- 날짜 누락·충돌·부분 Block·전략 미선택은 미확인으로 남긴다. 시스템의 기본 템플릿이나 가상 예시로 조용히 채우지 않는다.
- 달력·표·Orbit 미리보기와 원문 대비 누락·추정 목록을 보여준다.
- 사용자 승인 후 새 계획 버전을 생성한다. 현재 계획이 있으면 충돌·교체·병합 범위를 확인하고 과거 수행과 원래 계획은 보존한다.

**완료 기준**

- [ ] 이식 대상 본문이 확보되고 원문 버전·범위가 식별된다.
- [ ] 날짜·계층·세션·목적·제약마다 원문 또는 사용자 확인 근거가 있다.
- [ ] 원문과 다른 추정값·일정 충돌·미선택 전략이 사용자에게 노출되고 해결된다.
- [ ] 최종 미리보기를 사용자가 승인했으며 최초/변경 PlanVersion과 source snapshot이 연결된다.
- [ ] 가상 프로토타입 데이터가 사용자의 실제 계획으로 활성화되지 않는다.

**미완료 시:** 일반 계획 편집기 개발은 계속할 수 있지만, 이 공유 링크의 상세 계획을 가져왔다는 표시는 하지 않는다.


<a id="fut-10"></a>
### FUT-10 · 반응형 3-mode 구현과 접근성 검증

목표는 기존 768/1280 제안을 [07](07_responsive_layout.md)의 계약으로 구현하는 것이다. 구현·앱 적용/실기기 수용 시험은 미수행, 담당자·기간은 미정이다.

| 항목 | 계약 |
|---|---|
| 연결 | FUT-01/03/05; V022-F01~04; V022-A01~10; S01~S30 |
| 시작 조건 | responsive-spec 원본, 지원 browser/OS·기기, 대표 화면·fixture 정의 |
| 구현 위치 | Shell layout, UI tokens generator, kit container styles, module renderer, Storybook/E2E |
| 결과물 | breakpoint 생성물, adaptive views, 보존되는 draft/focus/selection, 실제 기기 시험 기록 |

- [ ] Mobile <768 / Tablet 768~<1280 / Desktop ≥1280에 빈틈·불일치가 없다.
- [ ] 좁은 module pane과 tablet split-screen에서도 viewport에 얽매이지 않고 기능을 수행한다.
- [ ] 입력·세트/timer·영양/계획 초안이 회전·resize에서 보존된다.
- [ ] 320 reflow, keyboard/IME, touch, non-drag, solid/reduced-motion, safe-area와 경계 fixture를 시험한다.
- [ ] 각 mode의 실제 CRUD→상담→diff→승인 결과를 기록한다. 화면 이미지/기존 smoke test로 대체하지 않는다.

미완료 시 기존 prototype을 새로운 반응형 명세의 통과 증거로 표시하지 않는다. 공개 대상 UI에 대해 충족한 폭·기기·한계를 별도로 알린다.

<a id="fut-11"></a>
### FUT-11 · 영양 계획·실제 섭취·팁·코치

목표는 영양을 자유 메모가 아닌 독립 plan/actual/evidence로 관리하는 것이다. [08](08_nutrition_supplementary_training.md) 기준 신규 설계 상태이며 production 구현·검증은 미수행이다.

| 항목 | 계약 |
|---|---|
| 연결 | FUT-01/02/06/08/10; V022-F05~08/F13~17; S25~S27과 기존 Planner/Coach |
| 시작 조건 | 부분 로그·단위·food version·relative anchor, 동의·검토 자료 범위, joint basis 합의 |
| 구현 위치 | modules/nutrition, server/domain·application/metrics/evidence, Resource tip adapter |
| 결과물 | 계획/섭취 CRUD, quick log, 영양 diff·coverage, tips·질문·RAG 근거, 통합 승인 |

- [ ] 계획 입력을 실제 섭취로 자동 간주하지 않고 시간·양을 확인한다.
- [ ] 미기록/부분/사용자 기록완료, 단위·portion·source version을 보존한다.
- [ ] 세션 이동·삭제의 상대 보급 계획을 미리보기로 검토하고 actual을 덮어쓰지 않는다.
- [ ] 연관된 훈련·영양 변경은 하나의 후보로 검증·승인·원자 저장한다.
- [ ] 자료 미확보·식이 제약·불완전 기록에서 근거를 만들거나 진단/감량 목표를 자동 생성하지 않는다.
- [ ] 세 mode의 실제 로그/계획/코치와 접근·삭제·회귀 시험이 있다.

미완료 시 tip/link만 있는 자료실을 영양 계획·실제 관리 완료로 표시하지 않는다. 식품 DB/API 없이 수동·사용자 정의부터 구현 가능하다. 정량 처방 규칙은 자료/전문가 검토·FUT-08 gate와 분리해 추적한다.

<a id="fut-12"></a>
### FUT-12 · 보강훈련 루틴·실행·actual·코치

목표는 플라이오매트릭/맨몸/웨이트/가동성/코어·안정성 등을 공통 훈련 계획에 포함하면서 운동별 실제 단위를 보존하는 것이다. [08](08_nutrition_supplementary_training.md) 기준 신규 설계 상태이며 아직 구현·검증하지 않았다.

| 항목 | 계약 |
|---|---|
| 연결 | FUT-01/02/03/06/08/10; V022-F09~18; S28~S30과 S05~S11 |
| 시작 조건 | 운동 계열×장비, versioned routine, count/side/load 정의, actual 원장·provider 매칭 |
| 구현 위치 | modules/supplementary, exercise catalog, common Activity detail, set log, metrics/evidence |
| 결과물 | 동작 library·routine builder·execution UI, set actual·중단/수정, mixed timeline·코칭 |

- [ ] 플라이오와 맨몸을 서로 배타적인 종목으로만 취급하지 않는다.
- [ ] reps/time/contacts·외부저항/좌우·RIR와 null/0를 올바르게 기록한다.
- [ ] 확인한 세트만 actual이며 미실시·부분·중단·누락을 구분한다.
- [ ] timer/미전송 set는 lifecycle에서 보존되고 replay가 중복 수행을 만들지 않는다.
- [ ] canonical Activity와 상세 log가 한 운동을 중복 집계하지 않는다.
- [ ] 루틴 변경이 기존 세션/actual을 덮어쓰지 않으며 일정·영양 영향과 최신성을 검토한다.
- [ ] 실제 기기 입력·도구·권한·정정·삭제·회귀 결과와 동작 콘텐츠 검토가 있다.

미완료 시 일반 활동 메모에 운동 이름을 저장하는 것을 세트 단위 보강 관리라고 부르지 않는다. 제공자가 지원하지 않는 상세를 만들어 채우지 않는다. 자동 재활·자세 진단·의학적 안전 보장은 별도 검증 없이는 제공하지 않는다.

<a id="fut-13"></a>
### FUT-13 · 범용 루틴 관리·유한 일정·실행 연결

상태: 설계 초안 / production 미구현 / 기능 검증 미수행 / 비활성. 담당자·일정 미정.

| 항목 | 내용 |
|---|---|
| 목적 | 운동·영양·회복·체크인을 재사용 조합하고 계획과 실제에 중복 없이 연결 |
| 범위·참조 | S31~S33, V023-F01~07/15~18, V023-A01~14/29~36, 09 §4~5 |
| 선행 | FUT-01/02/10 UI·서버·반응형, FUT-11/12 도메인 기록과 콘텐츠 계약 |
| 위치 | modules/routines, experience/routine-kit, server/{application,domain}/routines |
| 산출물 | blueprint/schedule/run schemas·migration·bounded expansion·API·3-mode UI·검증 증거 |

작업: 기존 운동 template은 참조하고 범용 blueprint를 분리한다. CRUD/검색/분류/버전과 유한 발생분 preview/승인을 만든다. 단계의 선택·actual 연결·중단·timer·계정별 outbox를 구현한다. 일정 pause/resume과 알림 mute, archived blueprint와 과거 기록을 분리한다. LLM은 신규 계획의 승인 권한을 갖지 않는다.

완료 기준:
- [ ] 같은 blueprint의 수정이 과거 승인/진행 중 version을 바꾸지 않는다.
- [ ] 유한 전개·중복·선택 그룹·relative anchor·미수행의 비누적을 검사한다.
- [ ] 각 실제 기록은 기존 도메인 원장에 한 번 저장되고 routine wrapper로 중복되지 않는다.
- [ ] 동시에 바뀌는 계획·발생분·승인·outbox의 원자 적용과 멱등성을 검증한다.
- [ ] 반응형·중단·background·두 기기·offline 복구와 삭제/계정 전환의 실제 증거가 있다.

미완료 시: 템플릿 메모·mock은 가상/초안이며 실제 일정 반복·알림·실적 자동 연결로 표시하지 않는다. 연결 도메인이 미구현이면 단계별 capability를 표시한다.

<a id="fut-14"></a>
### FUT-14 · 스트레칭 계획·실제·자료·코칭

상태: 설계 초안 / production 미구현 / 기능·콘텐츠·효능 검증 미수행. 담당자·일정 미정.

| 항목 | 내용 |
|---|---|
| 목적 | 스트레칭을 자유 메모가 아닌 계획/실제 운동 상세로 다루되 보강·러닝 원장과 통합 |
| 범위·참조 | S34 및 S06/S29/S30/S33, V023-F08~10/16~18, A15~20/31~36 |
| 선행 | FUT-12 공통 동작·세트, FUT-13 조합, FUT-02·10, 자료/RAG FUT-06 |
| 위치 | modules/supplementary의 stretching screens, exercise-catalog/StretchProfile, Activity 상세 |
| 산출물 | definition/target/log 계약·동작 설명·좌우/hold/repetition UI·중복 집계 fixture |

작업: static/dynamic·context·body region·side·assistance/검토를 분리한다. 유지/반복/휴식과 실제 timer/사용자 확인을 구분한다. 단독/세션 내부 동작, provider 요약·미지원 상세를 명시하고 원본을 보존한다. 자료의 사용 권리·원문 위치·주의 안내를 확인한다.

완료 기준:
- [ ] 같은 catalog/version을 library·루틴·단독/복합 운동에서 공유한다.
- [ ] 좌우·전체시간·반복·계획과 실제의 오변환 및 parent/bout 중복이 없다.
- [ ] 중단/불편감/unknown 입력과 타이머·실행 기록을 구분해 저장한다.
- [ ] 전문 화면과 일반 Activity 모두 같은 actual을 표시하고 구형 payload를 보존한다.
- [ ] 콘텐츠 검토·사용 범위·출처가 있으며 효과/부상 예방/재활 주장은 FUT-08의 별도 gate다.

미완료 시: 기존 보강의 수동 메모와 unsupported 상세를 명시한다. 새로운 동작·시간 처방이 검증되었다고 발표하지 않는다.

<a id="fut-15"></a>
### FUT-15 · 회복 전략·방법·실행·재평가

상태: 설계 초안 / production 미구현 / 기능·콘텐츠·효능 검증 미수행. 담당자·일정 미정.

| 항목 | 내용 |
|---|---|
| 목적 | 휴식·부하 변경·수면 준비·영양·선택적 방법을 목표/관찰과 연결하고 코치와 검토 |
| 범위·참조 | S35 및 S03/S10/S11/S12, V023-F11~18, A21~36 |
| 선행 | FUT-02 서버/승인, FUT-08 지표/효과 검토, FUT-06 자료, FUT-11/12/13 도메인 참조 |
| 위치 | modules/recovery, server/{domain,application}/recovery, metrics/evidence/coaching |
| 산출물 | Strategy/Plan/Method/ActionLog·read model·통합 승인·재평가 UI/도구·검토 기록 |

작업: 회복 관측(S12)과 전략/실행(S35)을 구분한다. 운동·섭취는 기존 원장을 참조하고 비운동 행동만 RecoveryActionLog에 저장한다. 방법 카드에 대상·출처·검토·주의·기대 결과의 범위를 명시한다. 완전 휴식/추가하지 않음도 선택지로 포함하고 재평가 조건·알림 동의를 정의한다.

완료 기준:
- [ ] 계획/실제/관측을 분리하고 '취침 준비 완료=수면/회복 완료' 오류가 없다.
- [ ] 미검토 방법은 수동 기록과 자동 추천 범위를 구분하며 효능 보장·무근거 용량·기기 제어가 없다.
- [ ] 회복 실행률을 안전/생리 상태와 구분하고 기존 부하를 상쇄하지 않는다.
- [ ] 새 보고·계획/콘텐츠 변경의 freshness, 부분 실패·재전송·삭제·민감 인용을 검사한다.
- [ ] 회복+훈련+영양+routine schedule의 영향을 비교하고 승인한 변경만 원자적으로 저장한다.
- [ ] 콘텐츠 검토와 실제 기능 시험, provider 데이터·자동 알림, 효과 검증의 증거를 각각 기록한다.

미완료 시: 체크인/원점수·수동 메모까지만 제공하고 회복 전략 적용·방법 추천·알림·효능 평가가 완료되었다고 하지 않는다.


## 4. 의존성과 권장 재개 순서

```text
FUT-03 핵심 라이브러리 실험 ──→ FUT-01 React 모듈
                                  ↕
FUT-02 인증·BFF·DB·도구 ──────────┤
    ├── FUT-04 Garmin 실연동 ─────┤
    ├── FUT-06 RAG ──────────────┤
    ├── FUT-07 routing ──────────┤
    └── FUT-05 HealthKit ────────┘

FUT-04 공식 신청: 코드 개발과 병행해 먼저 착수 가능
FUT-09 원문 확보: 별도 병행 → 계획 schema에 검토·승인해 이식
FUT-08 정의·검증 계획: 먼저 설계 → 필요한 데이터 확보 후 검증
```

FUT-01과 FUT-02는 공통 계약에 맞춘 세로 기능으로 병행한다. FUT-03 전체 라이브러리의 검증이 끝날 때까지 모든 개발을 멈추기보다는 해당 기능의 의존성부터 검증한다. Garmin 승인과 공유 본문 확보를 기다리는 동안 mock/명시된 파일 입력과 가상 계획으로 개발할 수 있다.

FUT-10은 FUT-01/03의 공통 UI와 병행한다. FUT-11/12는 FUT-02의 원장/승인 계약 위에 M1b로 연결하고, FUT-06 자료·FUT-08 검토는 M2의 tip/코칭 품질을 지원한다. 외부 식품·세트 데이터 승인을 새 선행 필수 조건으로 만들지 않고 수동 경로를 먼저 완결한다.

**첫 재개 단위:** `HostContext + ActivityList/Detail + 실제 로그인·조회 API + 테스트 DB`를 연결한다. 이후 `PlannerDraft → 검증 → 사용자 승인 → PlanVersion`을 실제 저장까지 완결하고, 외부 수집기·RAG·routing을 adapter로 추가한다.

추가 의존성: FUT-13은 FUT-11/12의 콘텐츠·원장을 참조하고 FUT-14는 FUT-12 공통 동작을 확장한다. FUT-15는 FUT-11/12의 영양·운동과 FUT-13 조합을 연결한다. 세 항목은 FUT-02의 같은 승인/동시성 계약과 FUT-10 반응형을 재사용한다. 기초 입력·UI는 mock으로 병행 가능하지만 기록 연결·원자 승인 E2E는 실제 통합 뒤에 검증한다.

## 5. 공개 조건과 대체 동작

| 배포 수준 | 충족할 조건 | 미완료 항목의 표시 |
|---|---|---|
| v0.2.3 전체 Web MVP | S01~S35, 기존 gate + FUT-13~15의 기본 plan/actual·반응형·통합 승인·검토된 콘텐츠 | 이전 시안/문서/타입을 새 기능 완료로 표시하지 않음 |
| 디자인·로컬 prototype | 기존 가상 데이터·interaction 검토 | 실제 인증·수집·LLM·RAG·routing·native 제공 아님 |
| 내부 end-to-end preview | FUT-01/02의 해당 핵심 흐름·FUT-03의 사용 부분 검증 | provider mock/미구현 기능을 명시, 실제 사용자 공개와 구분 |
| 기존 v0.2 Web MVP 기준(역사 기록) | S01~S24 기본 업무, FUT-01/02/03/04/06/07의 해당 범위와 운영·보안 gate | Garmin 승인이 없으면 API-first Web MVP 완료로 부르지 않음 |
| v0.2.2 Web MVP 기준(역사 기록) | S01~S30, 기존 Web 조건 + FUT-10/11/12의 실제 기본 업무 | 영양·보강과 3-mode를 문서만으로 완료 처리하지 않음 |
| Native-inclusive MVP | Web 범위 + FUT-05, 실제 iOS·WebView·배포 준비 | 브라우저 반응형 시험으로 native 완료를 대체하지 않음 |
| 개인 계획 이식 완료 | FUT-09 원문·미리보기·승인 | 일반 계획 editor 완료와 별개 |
| 예측·효능 지표 공개 | FUT-08의 해당 지표·주장 범위에 맞춘 검증 | 통계·원점수 표시와 구분, 미검증 확률 비활성 |

FUT-08은 데이터·계산·의미 표시의 기본 검증은 Web MVP에 포함하고, 새로운 생리학적 예측·효능 주장은 추가 gate로 둔다. 요구를 축소하거나 release 모드를 바꾸려면 별도 결정 이력을 남긴다.

## 6. 공통으로 지킬 확장 계약

| 계약 | 이후 기능을 붙일 때 유지할 경계 |
|---|---|
| Module/Host | app은 wrapper, module은 Host·public API만 사용. native별 구현을 모듈 내부로 흩뜨리지 않음 |
| Provider → Ingestion | 외부 데이터를 source revision과 품질·동의·capability로 정규화. raw/canonical/overlay 분리 |
| API·권한 | schema·버전·오류·멱등성·tenant 확인. client-supplied 사용자 ID를 권한으로 믿지 않음 |
| 계획 변경 | 조회·제안·승인·실제 적용 분리. version/freshness 검사와 원자적 저장 유지 |
| 지표 | value뿐 아니라 단위·정의·출처·시각·data coverage·unknown을 보존 |
| RAG 근거 | 원문 version/locator·ACL·coach-use와 EvidenceSnapshot 연결. 문서가 쓰기 권한을 주지 않음 |
| Feature 상태 | 지원 여부·실패·미관측·stale·권한 대기를 구분. fallback을 실제 기능 성공으로 표시하지 않음 |
| 운영·삭제 | source·파생 파일·검색·cache·인용·로그의 보존·삭제·재수집 정책을 함께 구현 |

이 표의 경로와 인터페이스는 **구현 위치에 대한 설계**다. 실제 패키지·서비스가 이미 존재한다는 의미가 아니다.

## 7. 착수·완료 체크리스트와 증거

각 항목을 착수할 때 당시 공식 문서·선택 버전·권한·비용·정책을 재확인한다. 기존 [sources.md](sources.md)는 v0.2 검토 기록이며 이번 요청에서 다시 조사한 최신 인증 자료가 아니다.

### 착수 조건

- [ ] 담당자, 목표 release 범위, 의존 항목을 지정했다.
- [ ] 필요한 결정·자료·공식 권한 또는 명시된 mock 전략이 정리되었다.
- [ ] 입력·출력·실패 상태·privacy 경계와 테스트 fixture가 준비되었다.
- [ ] 완료 기준과 측정 방법을 합의했으며 테스트 전 임계값을 확정했다.

### 완료 조건

- [ ] 기능 코드와 실제 통합 경로가 구현되었다.
- [ ] 기능·권한·오류·재시도·삭제·성능·접근성 중 해당 항목을 시험했다.
- [ ] 모의 시험과 실제 provider/native/DB 시험을 구분해 증거를 남겼다.
- [ ] 배포·운영·복구·fallback·kill switch와 사용자 표시가 준비되었다.
- [ ] 결과와 알려진 제한을 문서화하고 관련 ADR·FR·AT를 갱신했다.
- [ ] 외부 승인/연구 검증은 해당 증빙이 있는 범위에서만 완료로 표시했다.

**권장 증거 경로 — 추후 생성할 경로이며 현재 파일이 있다는 뜻은 아님**

```text
adr/ADR-xxx-*.md
qa/compatibility/<host>-<version>.md
qa/e2e/<run-id>/
qa/provider-contracts/<provider>/<run-id>/
qa/native/<device-os>/<run-id>/
qa/retrieval/<corpus-version>/<run-id>/
research/metrics/<definition-version>/
imports/plans/<source-version>/
```

개인 자료·credential·원문 저작물은 공개 저장소의 테스트 증거로 올리지 않는다. 공개 가능한 fixture와 접근 제한 증거를 분리한다.

## 8. 후속 티켓 템플릿

```markdown
# [FUT-xx / 하위 작업] 제목

상태: 미착수
담당자: 미지정
목표 단계: M0 / M1 / M2 / M3 / 별도 검증
선행 작업·외부 의존:
관련 화면·FR·AT:

## 목적과 사용자 가치

## 변경할 패키지 / public 계약 / migration

## 구현 범위와 비범위

## 수용 기준
- [ ] 정상 경로
- [ ] 권한·누락·오류·재시도·삭제
- [ ] 실제 통합 또는 명시된 모의 시험

## 배포·fallback·되돌리기

## 미결정 사항

## 완료 증거
- commit / PR:
- 테스트 환경·버전·실행일:
- 검토·공식 승인·연구 보고서:
- 잔여 한계:
```

## 9. 변경 관리

FUT ID는 작업 완료 이후에도 유지한다. 세부 티켓은 `FUT-04.1`처럼 하위 ID로 나눈다. 현재 문서는 개인적인 메모나 외부 task tracker에 자동 등록된 상태가 아니며, 프로젝트 문서로 보관하는 백로그다.

상태 변경 시 `날짜 / 항목 / 이전→이후 / 증거 / 결정자 / 남은 제약`을 기록한다. 향후 별도 이슈 트래커를 쓰더라도 ID와 원문 문서를 연결한다.

| 날짜 | 변경 | 실행·검증 상태 |
|---|---|---|
| 2026-09-15 | 사용자가 지정한 9개 미완료 항목을 후속 백로그로 등록하고 개발 요구사항에 연결 | 문서화만 수행. 구현·연동·호환성·원문 이식·생리학 검증 상태 변화 없음 |
| 2026-09-15 | v0.2.2 반응형 명세 보완·영양·보강 MVP 추가; FUT-10~12 연결 | 문서·타입 초안 보완. 기존 미완료 상태 유지 |
| 2026-09-16 | v0.2.3 루틴·스트레칭·회복과 FUT-13~15, V023 요구/수용시험 추가 | 문서·타입 초안 개정; 새 기능/실기기/생리학 시험은 미수행 |

## 10. 근거 문서와 읽는 순서

1. [01 화면 기획](01_product_screen_spec.md): 무엇을 제공할지 확인한다.
2. [02 아키텍처](02_frontend_architecture.md): app/module/kit/BFF/native 경계를 확인한다.
3. [03 디자인 시스템](03_design_system.md): 컴포넌트·토큰·라이브러리 검증 대상을 확인한다.
4. [04 연동·점수·RAG](04_integrations_metrics_rag.md): 상세 동작과 미확정 외부 조건을 확인한다.
5. [05 개발 요구사항](05_implementation_requirements.md): M0~M3와 기존 V2-F/V2-A 요구·테스트를 확인한다.
6. 이 문서의 FUT 카드에서 착수 조건과 완료 증거를 정하고 구현한다.

기존 문서의 설계·후보 선정은 구현 완료 증거가 아니다. 외부 기술·정책·연구에 관한 상세 근거는 당시 [sources.md](sources.md)를 참고하되, 실제 착수 시 필요한 항목을 재확인한다.

추가 명세: [07 반응형](07_responsive_layout.md), [08 영양·보강](08_nutrition_supplementary_training.md), [v0.2.2 참고 근거](sources-v022.md).

추가 상세: [09 루틴·스트레칭·회복 전략](09_routines_stretching_recovery.md). 기존 FUT-01~12는 폐기/완료하지 않고 새 범위와 함께 추적한다.
