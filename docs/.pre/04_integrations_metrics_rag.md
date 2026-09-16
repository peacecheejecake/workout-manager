# 04 · 자동 수집 / 점수 / 코스 / RAG 설계 v0.2.3

> v0.2.3 · 2026-09-16: [09 루틴·스트레칭·회복 전략](09_routines_stretching_recovery.md)과 S31~S35, FUT-13~15, V023 요구·시험을 추가했다. 기존 계약·이력은 유지하며 신규 기능은 아직 미구현이다. 아래 이전 버전 설명은 당시 기준이며 새 범위는 09와 05 §11을 따른다.

> v0.2.2 추가: 영양·보강 actual/metrics/RAG·joint approval을 [08](08_nutrition_supplementary_training.md)에서 정의한다. 기존 provider 조사·권한 상태를 이번에 재검증한 것은 아니다.

## 1. Garmin: API-first, 승인 조건은 제품 의존성이다

Garmin Activity API는 사용자 동의와 Garmin Connect 동기화 이후 FIT/GPX/TCX 등의 activity 데이터를 제공하고 push 또는 ping/pull 방식으로 통합한다.[S05](sources.md#s05) 현행 공개 FAQ는 Connect Developer Program을 사업/기업용으로 설명하며 신청·승인을 요구하고 OAuth 2.0을 명시한다. 프로그램 가입·일반 API와 일부 지표의 상업 조건은 같지 않을 수 있다.[S06](sources.md#s06)

따라서 **개인 Garmin 계정만 있으면 즉시 아무 앱에서나 공식 API로 FIT를 받을 수 있다는 전제는 두지 않는다.** 먼저 신청 자격·제품 사용 목적·sandbox·Activity entitlement·Health entitlement를 확인한다. 승인 전 개발은 provider mock+지원 FIT import로 진행하지만 실제 자동 연동 완료라고 표시하지 않는다. 비공식 로그인 scraping/password 저장을 기본 경로로 채택하지 않는다.

### 1.1 승인 후 수집 흐름

```text
앱 연결 요청
→ Garmin OAuth (state/redirect 검증; 파트너 명세에 따른 PKCE 등)
→ 서버 code exchange / token 암호화 / provider subject 저장
→ scope·entitlement capability snapshot
→ 초기 backfill job + 이후 provider event
→ event 검증·queue·중복 방지
→ 허가된 FIT/JSON 수신·검사
→ raw object + normalized revisions
→ cross-source duplicate resolution
→ aggregate / Evidence invalidation / UI freshness
```

정확한 endpoint·signature header·payload·refresh 정책은 승인 계정의 공식 파트너 문서로 확정한다. 공개 소개 페이지만으로 webhook HMAC 형식이나 파일 URL을 만들어 구현하지 않는다. download URL은 공급자 검증·네트워크 allowlist·redirect 검사를 거친다.

### 1.2 데이터·운영 계약

`Connection`: owner/provider/providerSubject/scopes/capabilities/status/consentedAt/lastSync/credentialRef.
`SyncJob`: mode backfill/incremental, cursor, eventIds, period, receivedAt, successfulAt, retries, retryAfter, error.
`SourceActivity`: stable external ID, content hash, revision, source measurement time, raw file ref.

동일 provider subject/activity ID를 멱등 키로 사용하고 파일 hash로 보강한다. refresh token 갱신은 connection별 잠금으로 경쟁을 제어한다. 429/일시 장애는 backoff와 공급자 retry-after를 존중한다. 중복·순서가 뒤집힌 이벤트에 대비해 canonical revision을 비교한다. file mutation/re-export는 새 source revision으로 보존한다. live sync가 느린 대규모 backfill 뒤에 밀리지 않게 큐 우선순위를 분리한다.

동기화 event마다 LLM을 호출하지 않는다. 활동 묶음과 체크인·주기 변경을 debounce해 재평가 필요 신호만 만들며 실제 자동 상담은 별도 동의·예산 설정을 따른다. 이미 승인한 계획은 새 event가 와도 자동으로 바꾸지 않는다.

### 1.3 API capability matrix

| 데이터 | 공개 문서 확인 | 구현 결정 |
|---|---|---|
| 활동 및 FIT/GPX/TCX | Activity API 확인 | 승인 후 필수 |
| 일중 심박·수면·스트레스 | Health API 확인 | 별도 권한/범위 확인 |
| Body Battery | Health API 소개에 명시 | entitlement와 실제 payload 확인 후 표시 |
| Training Readiness / Recovery Time / Training Status | 이 조사에서 공개 API 필드 확인 불충분 | 미지원/미확인으로 capability 표시, 가상 값 금지 |
| 모든 기기 점수가 FIT에 포함 | 확인되지 않음 | FIT와 Health API 분리 |
| 코스/워크아웃 기기 전송 | 이번 조회 범위의 필수 계약 아님 | 별도 API 승인·개발 범위 |

Health API 공개 범위 근거는 [S07](sources.md#s07)이다. UI에 존재하는 지표를 자동으로 API에서 읽을 수 있다고 가정하지 않는다.

### 1.4 CRUD·삭제 의미

활동명·태그·거리 정정은 앱 내부 overlay이며 Garmin 원본 writeback을 뜻하지 않는다. 일반 활동 삭제는 사용자에게 의미를 확인하고 source suppression을 보존해 다음 backfill에서 재등장하지 않게 한다. 완전 삭제 요청에서는 건강 내용과 raw·derived를 삭제하며 재수집 방지에 필요한 최소 identifier 보관 여부도 보존정책과 동의에 명시한다. 재연결 시 과거 데이터 재가져오기 선택을 제공한다. provider 계정의 실제 활동 삭제는 MVP에 포함하지 않는다.

## 2. Apple Health & Activity: Native collector가 필요하다

HealthKit은 Apple 플랫폼의 native framework다. 웹사이트의 Apple 로그인이나 Apple 계정 OAuth를 HealthKit 데이터 접근으로 바꿀 수 없다. Native 앱에서 사용자에게 필요한 유형을 요청하고, 조회한 데이터를 자체 backend로 동기화하는 구조를 택한다.[S08](sources.md#s08) [S09](sources.md#s09)

```text
Apple Watch / iPhone / 다른 앱
→ iPhone HealthKit store
→ Swift collector (type-specific authorization)
→ anchored query / observer notification
→ native local outbox
→ 자체 ingestion API batch upload
→ canonical store + 출처별 dedup
→ 같은 Web/모바일 화면에서 조회
```

### 2.1 MVP의 두 release 모드

Web MVP: Garmin 자동 수집 + 수동/파일 fallback + Apple native-required 안내 + Apple ingestion/contract 준비.

Native-inclusive MVP: 위 기능 + iOS shell + HealthKit authorization/query/route/background/outbox/철회 및 실기기 테스트. **Apple 자동 수집을 최초 MVP 필수로 선택하면 native-inclusive 모드가 필요**하다. WebView HTML만으로 HealthKit을 읽는 것처럼 계획하지 않는다.

### 2.2 수집 대상과 품질

기본 후보: workout, workout route, heart rate, resting heart rate, sleep samples, 일부 activity summary/effort, 가능한 경우 HRV·VO2max. 정확한 필드·최소 OS·권한·샘플 존재 여부는 native capability probe와 실제 기기로 검증한다. 노력 점수 direct/estimated 식별자는 확인되지만 모든 workout에 존재한다고 가정하지 않는다.[S11](sources.md#s11) Fitness 앱의 Training Load나 다른 화면의 Sleep Score가 동일 공개 API로 제공된다고 아직 확정하지 않는다.

HRV는 측정 종류·단위·집계 창을 반드시 보존한다. 서로 다른 제공자의 SDNN/RMSSD 등 측정 정의를 같은 series로 합치지 않는다. sleep stage는 overlapping source/타임존과 미완성 밤을 처리한다. device별 걸음 수를 그대로 합산하지 않고 데이터 유형별 canonical selection/정식 통계 query 방식을 사용한다.

### 2.3 변경·삭제·background

HKAnchoredObjectQuery를 통해 새 샘플과 삭제를 추적하고, observer는 변경 신호로 쓴다.[S09](sources.md#s09) [S10](sources.md#s10) query 결과를 native outbox에 영속화한 후 local anchor를 진전시키고 서버 ack는 batch 단위로 별도 관리한다. outbox가 내구적이지 않다면 server ack 이전 anchor 진전을 금지한다. 재시작·재설치·anchor reset에도 stable sample UUID와 source로 중복을 방지한다.

background 통지는 OS·entitlement·상태에 영향을 받으므로 실시간 또는 일정 초 이내 동기화를 보장하지 않는다. 앱 foreground 시 reconciliation을 수행한다. 읽기 권한 거절을 확실히 판별할 수 없으므로 빈 결과를 “사용자가 권한을 거부했다”로 단정하지 않는다.[S08](sources.md#s08)

Garmin 활동이 HealthKit에도 저장되는 경우 출처 lineage를 보존해 하나의 운동을 두 번 세지 않는다. matching 확신이 낮으면 사용자가 확인한다. 앱에서 삭제한 기록이 underlying HealthKit의 다른 앱 데이터 삭제를 뜻하지 않는다.

### 2.4 Privacy boundary

HealthKit 원본은 native collector가 직접 batch upload하고 web bridge에는 상태와 UI에서 필요한 summary만 노출한다. AI에게 보낼 최소 필드는 별도 동의·field allowlist로 결정한다. 정확한 GPS, 집/회사 위치 추정, 원본 사진 EXIF를 일반 코칭 문맥에 넣지 않는다. 앱스토어의 데이터 공유·AI 전송 관련 요건도 launch checklist에 둔다.[S12](sources.md#s12)

## 3. 통합 Measurement 모델

```
Measurement / Score
 id, ownerId, metricKey, value|null, unit, scale?
 source: provider/device/user/derived
 observedFor(start,end), receivedAt, timezone
 method/definitionVersion, inputEvidenceIds
 dataCoverage, status, unavailableReason
```

`available`, `partial`, `stale`, `unsupported`, `not_observed`, `error`를 구분한다. null은 0이 아니다. vendor display label과 내부 metricKey를 분리한다. 동일한 0~100 범위라도 뜻이 다른 점수는 더하거나 평균내지 않는다. normalization을 하면 원값과 변환 목적·식·버전을 별도로 보여준다.

## 4. 점수화: 네 가지 층으로 시작한다

### 4.1 제공자 원점수

예: 승인된 Health API에서 수신한 Garmin Body Battery. 원래 이름·값·범위·관측 시각·제공자를 보존한다. 점수 하나가 현재 훈련을 해도 안전하다는 허가증은 아니다. 지표가 없으면 다른 값으로 몰래 대체하지 않는다.

### 4.2 사용자 보고

fatigue 0~10, soreness/discomfort 0~10, sleep quality 등은 질문 문구·scale anchor·입력 시점을 고정한다. session RPE는 현재 피로와 다른 질문이다. 보고 안 함은 null. 자유 대화에서 추출한 숫자는 사용자가 말한 단위와 뜻을 확인한 후 구조화한다.

### 4.3 계산된 훈련 부하·추세

거리·지속시간·고강도 분류·session-RPE 기반 load를 분리한다. session-RPE load는 기록한 session effort × 해당 운동 시간(분)으로 정의하고 AU로 표시한다.[S35](sources.md#s35) duration 종류와 휴식 포함 범위를 고정한다. RPE 없는 활동을 0부하로 합산하지 않고 `knownLoad + missingCount`를 반환한다.

0~100 표현이 필요하면 **최근 부담 상대 위치(백분위)**를 제공할 수 있다. 같은 개인·같은 metric·같은 N-day 창의 유효한 과거 분포에 대한 위치다. 예시 정의: `100 × (strictlyLower + 0.5×equal) / baselineCount`. baseline 범위, 유효 sample 수, 데이터 coverage와 정의 버전을 표시한다. 연속 rolling 창은 서로 상관되므로 독립 표본의 통계적 신뢰구간처럼 설명하지 않는다. 최소 baseline은 product quality gate로 정하고, 충분하지 않으면 산출하지 않는다. 이 백분위는 “피로가 78%”나 “회복력이 22%”가 아니다.

LLM은 점수의 계산을 맡지 않는다. metrics service가 산출하고 LLM은 사용자 보고·계획·개인 사례와 함께 해석한다. 자체 readiness composite의 임의 가중치 합은 MVP 기본 지표로 노출하지 않는다. 별도 가설과 검증 실험에서만 다룬다.

### 4.4 부상 관련 상태

MVP 이름은 **부상 관련 확인 신호 / 주의 필요 상태**로 제안한다. 보고된 불편감, 지속·악화 여부, 훈련 수행 변화, 데이터 부족 등을 근거 목록으로 표시한다. “부상 위험 23%”처럼 미검증 확률을 생성하지 않는다. 필요하면 “확인 필요한 정보 2개”를 표시하되 위험 강도의 연속 점수로 오해시키지 않는다.

ACWR 등의 단순 비율을 개인 부상 확률이나 안전한 훈련 허용 범위로 바꾸지 않는다. ACWR의 인과·측정 해석에 대한 원 연구의 비판을 고려한다.[S34](sources.md#s34) 연구 한 편이 이후 모든 논의를 종결했다는 의미는 아니지만, 이 MVP의 확률 모델을 정당화하는 자료로는 부족하다.

미래에 진짜 예측 확률을 만들려면 outcome 정의(어떤 부상), horizon(언제까지), incident label, 충분한 추적 data, 선수/시간별 독립 검증, calibration, subgroup/false-negative 분석, 외부 검증과 전문가 검토가 필요하다. 의료적 효능 주장에 관한 규제 검토도 별도 진행한다. 그 이전에는 점수 UI를 먼저 예쁘게 만들고 의미를 나중에 붙이지 않는다.

## 5. Course route pipeline

Geo UI는 waypoint draft를 보관하고 서버 route adapter에 좌표·profile·제약을 전달한다. 서버는 routing/geocoding/tiles/elevation credential과 quota를 관리한다. 지도 tile credential 중 공개 사용이 허용되는 것은 origin 제한으로 관리하되 민감한 서버 secret은 browser에 노출하지 않는다.

route estimate는 engine/version/profile/createdAt/geometry/distance/elevationSource/warnings를 가진다. user-edited segment와 provider-calculated segment를 구분한다. 좌표는 UI에 필요한 정밀도를 유지하되 logs/LLM에서는 최소화한다. routing 실패 시 draft는 보존하고 outdated estimate를 현재 결과로 보여주지 않는다. 한국 지역의 보행로·다리·지하도·공원 출입·야간 이용 데이터 품질을 대표 코스에서 검증한다. 지도는 통행 안전의 보증이 아니다.[S22](sources.md#s22) [S23](sources.md#s23) [S24](sources.md#s24)

## 6. RAG 타당성: 자료실과 코치 연결에는 도입한다

RAG는 이 서비스에서 타당하다. 이유는 사용자가 관리하는 자료·개인 메모·확인된 훈련 원칙을 **현재 권한과 버전으로 검색하고 답변 근거로 연결**해야 하기 때문이다. 다만 모든 입력을 vector로 바꾸지는 않는다.

| 질문/정보 | 경로 |
|---|---|
| 지난 10일 거리·실제 계획·현재 제약 | SQL/read model/calculation tool |
| 선택한 자료의 훈련 원칙·관련 논문·메모 | 문서 RAG |
| 유사한 과거 조정·반응 | structured filter + episode retrieval |
| 사용자 확인 hard constraints | 기본 문맥에 명시 로딩; retrieval 탈락 불가 |
| 새 외부 연구 찾기 | 별도 research workflow; 자동 정책 승격 금지 |

처음부터 별도 vector cluster를 운영하기보다 PostgreSQL+pgvector와 lexical 검색을 사용하고 규모·검색 평가에 따라 분리한다.[S32](sources.md#s32) 공개 archive와 private user resources는 같은 index를 쓰더라도 ACL과 corpus namespace를 분리한다.

### 6.1 Ingestion 상태와 원문 관리

```text
resource created
→ quarantine / file·URL·권리·소유권 검사
→ parse isolated worker
→ section/page/time locator 확보
→ versioned text + structured fragments
→ chunk + metadata + embedding
→ lexical/vector index
→ user-visible searchable / coach-enabled
```

URL fetch는 SSRF 방어가 필요하다. scheme/domain·DNS resolution·private/link-local IP·redirect 재검증·egress 제한을 적용하고, 사용자의 내부 로그인 cookie나 임의 network access를 허용하지 않는다. parser는 HTML script/macros를 실행하지 않는다. 파일 크기·압축해제·페이지·타임아웃 제한을 둔다. 자료 권한·저작권과 서버 처리/AI 전송 가능 여부를 확인하고 private 자료가 자동 public corpus가 되지 않게 한다.

PDF에는 page+text offsets, video transcript에는 timecodes, Markdown에는 heading+paragraph index를 유지한다. 표는 행 단위만 무작정 잘라 단위/머리글을 잃지 않게 한다. 본문을 얻을 수 없는 링크는 title/bookmark 상태로 보관하며 RAG source로 사용할 수 있다고 표시하지 않는다.

### 6.2 Chunk와 schema

초기 chunk target 400~800 tokens, heading/context prefix와 제한 overlap을 제안하되 corpus 평가로 조정한다. 출처 본문과 생성된 contextual summary를 구분한다. generated summary만을 primary evidence로 인용하지 않는다. multilingual embedding과 Korean lexical 처리를 검토하며 영어 stemming을 한국어 검색 해법으로 사용하지 않는다. 작은 초기 corpus에는 normalized title/keyword + PostgreSQL simple FTS/trigram 조합을 실험한다. PostgreSQL 기본 full-text rank를 BM25라고 부르지 않는다.

`Resource`: owner/workspace/visibility, type, title, sourceURL, author/year, license/useRights, language, reviewedState, includeForCoach, currentVersion, deletedAt.
`ResourceVersion`: hash, originalObject, parsedObject, parserVersion, effectiveAt, retractedAt, status.
`Passage`: resourceVersion, content, locator, headingPath, tableRefs, tokenCount, embeddingModel/version, acl scope.
`Citation`: passage/version, quotedSpan/offset, supportsClaimId, retrievedAt.

### 6.3 Query-time 흐름

```text
요청 해석
→ structured data tool 또는 document retrieval 선택
→ 사용자/공유 범위 + coach-enabled + version/status ACL 필터
→ lexical + vector 후보 (초안 각 top20)
→ deduplicate + reciprocal-rank fusion
→ 필요한 경우 rerank
→ 근거 passage (초안 top6) + source/locator/한계
→ EvidenceSnapshot에 고정
→ LLM 응답/후보 생성
→ claim-citation 의미·권한·수치 검사
```

각 topK는 초기 budget이며 품질 근거가 아니다. 필터는 결과를 LLM으로 전달하기 전에 적용한다. vector approximate search에서 필터 후 후보가 부족하면 재탐색하며 unauthorized 자료를 가져와 모델에게 거르게 하지 않는다. cache key에는 tenant/user authorization revision/corpus version/filter를 포함한다. 임베딩 유사도는 의학적 근거의 질과 같은 점수가 아니다.

contextual chunk, hybrid retrieval와 rerank는 참고 가능한 패턴이지만 우리 corpus에서의 개선 여부는 별도 평가한다.[S33](sources.md#s33)

### 6.4 Coach grounding과 authority

답변은 `metric` 근거와 `document passage` 근거를 다른 badge로 연결한다. 최신 범위·적용 대상이 다른 문헌을 사용자에게 그대로 적용한다고 단정하지 않는다. 상충되는 문헌이나 사용자 데이터는 conflict/uncertainty로 표현한다. 필요한 자료가 없으면 검색 결과 부족을 말하고 모델 기억으로 source를 만들어 내지 않는다.

문서의 “이 지시를 따르면 이전 규칙 무시” 같은 텍스트는 데이터일 뿐 지시가 아니다. 자료가 검토되지 않았다는 사실과 사용자가 저장했다는 사실을 정책 승인으로 간주하지 않는다. RAG는 Plan Service write permission이나 사용자 승인을 제공하지 않는다.[S37](sources.md#s37)

### 6.5 삭제·철회·버전

자료 삭제/coach 사용 해제 시 resource access gate를 즉시 차단하고 비동기 index 제거가 늦어도 model context에 들어가지 않게 한다. 원문·chunk·embedding·generated summary·cache·인용 발췌·보존 가능한 메타데이터의 정책을 구분한다. 이미 생성된 답변을 재열람할 때도 삭제된 민감 인용 재노출을 막는다. 재색인 중에는 이전 유효 버전을 쓰는지 검색 중지인지 명시하고 버전 혼합을 금지한다.

### 6.6 평가

비교군: no-RAG / SQL+작은 curated bundle / hybrid RAG. 질문은 한국어·영어·혼합 용어, 동일 문서 다른 버전, 상충 근거, 표의 단위, 권한 없는 문서, 악성 문서 지시, 삭제 직후, 자료 없는 질문을 포함한다. retrieval recall, answer-citation entailment, unsupported claim, ACL 누출, false refusal, latency/cost를 측정한다. 원문을 제대로 찾았다는 결과와 훈련 효과 개선은 다른 평가다.

## 7. Backend 엔터티·API 추가

추가 엔터티: PlanPeriod, ViewPreference, Connection/Grant/Capability, SyncJob/SourceRecord/Tombstone, Measurement/MetricDefinition, Course/RouteRevision, Race/Result, MediaAsset/Derivative, Resource/Version/Passage/Citation/RetrievalRun.

API 초안:

| 경로 | 의미 |
|---|---|
| `POST /v1/connections/garmin/authorize` | 서버 생성 authorization URL/state, password 수신 안 함 |
| `GET /v1/connections/garmin/callback` | 공식 protocol callback; 실제 partner 명세로 확정 |
| `POST /v1/connections/:id/disconnect` | grant 철회·token 제거·수집 중지 |
| `POST /v1/sync-jobs` | 허용 범위 backfill/retry 요청 |
| `POST /v1/ingestion/healthkit/batches` | native 인증, sample/tombstone 멱등 batch |
| `GET /v1/measurements` | metric/provider/시간/정의 필터 |
| `POST /v1/courses/route-estimates` | 미저장 waypoint routing 계산 |
| `POST /v1/courses/:id/revisions` | 검토한 route version 저장 |
| `POST /v1/resources` | ingestion 초안 생성 |
| `POST /v1/resources/:id/versions` | 새 버전·재색인 |
| `PATCH /v1/resources/:id/coach-use` | RAG 포함/제외, access revision |
| `POST /v1/retrieval/queries` | 권한 있는 검색; 일반 user-facing API와 agent tool 권한 구분 |

외부 webhook ingress는 provider 특성에 맞춘 별도 인증 경로다. 우리 사용자 session cookie가 없는 webhook을 무조건 anonymous unrestricted API로 만들지 않는다. 수집 이벤트 검증·rate/size limit·network policy를 적용한다.

## 8. v0.2.2 영양·보강 입력·근거·지표 확장

외부 API의 nutrition/strength 상세 필드가 자동으로 제공된다고 가정하지 않는다. 수동 섭취·set log를 독립적으로 완결하고 provider 지원은 FUT-04/05의 실제 capability·sample로 검증한다. 수동 log를 imported activity에 연결할 때 source·canonical·overlay를 분리해 중복 운동을 만들지 않는다.

Nutrition: IntakeEntryRevision + FoodDefinitionVersion + nutrient/portion basis. Supplementary: canonical Activity + ExerciseDefinitionVersion + SetLog, set별 side/count/load/tempo·source. 기록 누락은 0이나 미실시가 아니며 본문/제품·동작 version이 바뀌었다고 과거 actual을 자동 재작성하지 않는다.

집계 정의는 [08 §4~5](08_nutrition_supplementary_training.md)를 따른다. kg×reps, contacts, km, 섭취 kcal를 단일 생리 부하로 합치지 않는다. RIR=0과 미응답, 맨몸과 무부하를 구분한다.

영양·운동 자료는 기존 ResourceVersion/Passage에 topic·적용 대상·단위·review 상태를 추가해 검색한다. mandatory dietary constraints/equipment/user reports는 retrieval 성공에 의존하지 않는다. 실제 섭취·수행 기록은 구조화 도구, 문헌은 RAG, 가설은 분리한다. 식이·불편감·개인화 가설 삭제 시 snapshot/cache/index·기억도 보존정책에 따라 제거한다.

훈련·영양의 combined 후보는 두 계획과 actual·preference revision을 기준으로 검증하고 한 번에 승인·반영한다. existing training-only API를 새 schema 없이 묵시적으로 확장하지 않는다. [08 §8](08_nutrition_supplementary_training.md) 및 [확장 계약](extensions-v022.contracts.ts)을 참조한다.

## 9. v0.2.3 루틴·스트레칭·회복의 데이터·근거 확장

RoutineRun은 Activity/IntakeEntry/RecoveryActionLog/CheckIn을 참조하는 진행 envelope다. Provider의 같은 운동을 routine wrapper와 상세 운동에서 이중 집계하지 않는다. 스트레칭의 좌우·유지시간·순서는 실제 지원 field 또는 사용자 확인에 한정하고 yoga/혼합 요약을 임의 세부 동작으로 변환하지 않는다.

회복 중 운동은 Activity, 식사·수분은 IntakeEntry, 비운동 행동은 RecoveryActionLog, 수면·기기 지표는 기존 Measurement에 남긴다. '취침 준비 완료'를 실제 수면이나 회복 완료로 바꾸지 않는다. 회복 방법을 실행했다고 기존 훈련 부하를 차감하거나 임의 준비도 점수를 가산하지 않는다. 실행률·자기보고 변화·생리 상태/효능 검증은 별개다.

RAG는 동작/회복 방법의 원문 version·검토 상태·대상 조건·결과 종류(체감/수행/장기 적응)·주의 정보를 검색한다. 실제 수행 숫자는 구조화 조회와 계산으로 얻는다. 콘텐츠를 저장했다는 사실만으로 추천 또는 의료적 처방 권한을 주지 않는다. 자료가 철회되면 신규 실행·추천 시 유효성을 다시 확인하고 민감한 이전 인용도 삭제 정책을 따른다.

과거 backfill 수신과 지금 운동 완료를 구분하고, 이벤트는 승인된 내용의 유효한 안내 또는 새 검토 신호로만 사용한다. 실제 미구현 알림/provider 기능은 완료로 표시하지 않는다. 자세한 원장·도구·동시성·출시 조건은 [09](09_routines_stretching_recovery.md), 연구·콘텐츠 검토는 FUT-08/14/15다. 이번 변경에서 회복 방법의 효과나 API 가용성을 새로 조사하지 않았다.
