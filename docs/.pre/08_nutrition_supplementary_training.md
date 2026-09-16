# 08 · 영양·보강훈련 기획 / 데이터 / 코치 통합 명세 v0.2.3

> v0.2.3 · 2026-09-16: [09 루틴·스트레칭·회복 전략](09_routines_stretching_recovery.md)과 S31~S35, FUT-13~15, V023 요구·시험을 추가했다. 기존 계약·이력은 유지하며 신규 기능은 아직 미구현이다. 아래 이전 버전 설명은 당시 기준이며 새 범위는 09와 05 §11을 따른다.

기준일: 2026-09-16 · 설계·후속 구현 요구사항. 이 문서는 개인별 식단·운동 처방이나 해당 기능의 구현 완료 결과가 아니다.

## 1. 기존 범위 확인과 제품 결정

기존 01의 S01~S24에는 영양 계획·섭취 기록과 보강 루틴·세트 수행의 독립 화면이 없었다. 일반 종목/메모, RPE·피로 체크인, Resources는 재사용할 토대였지만 영양·보강 기능 완료를 뜻하지 않았다. 이번에 **nutrition과 supplementary 도메인을 MVP의 명시적인 범위로 추가**한다.

영양은 `팁·자료 → 계획 → 실제 섭취 → 비교·체감 → 코치 질문 → 승인된 변경`을 연결한다. 보강은 `동작·루틴 → 계획 → 실제 세트 수행 → 부하·반응 → 코치 질문 → 승인된 변경`을 연결한다. 러닝의 부속 자유 메모로만 저장하지 않는다.

훈련 주기 계층(Season/Wave/Phase/Block)과 하루 projection, rolling 조회는 공유하되 영양을 km나 운동 횟수로 합산하지 않는다. 보강 세션은 공통 Training Plan/Activity의 정식 종목으로 포함하고, nutrition 계획·실제는 별도 원장으로 관리한다.

## 2. MVP 범위와 후속 범위

| 영역 | MVP 필수 | 후속 별도 검토 |
|---|---|---|
| 영양 계획 | 일별 기본 식사/간식/수분, 훈련 전·중·후 보급, 대회 연결, 재사용 template, 수정·복제·승인 | 장보기/배달 연결, 의료 질환별 영양 처방, 비용 최적화 식단 |
| 영양 실제 | 간편 기록, 수량·단위, 음식/제품 정의, source와 영양 값의 부분 입력, 시각, 계획 연결, 정정·삭제 | 식사 사진 자동 추정, barcode/상업 식품 DB 통합 |
| 영양 지식·코치 | 근거 있는 팁, 질문 starter, 기록/훈련 문맥·식이 제약을 고려한 제안, 인용·불확실성 | 영양제 자동 추천·구매, 검증 없는 자동 감량·질병 진단 |
| 보강 계획 | 플라이오매트릭, 맨몸, 웨이트, 코어/가동성/안정성 동작·루틴·세트, 훈련 일정 연결 | 자동 영상 자세 판정, 재활·치료 처방, 강제 1RM 테스트 |
| 보강 실제 | 세트/반복/외부저항/시간/접촉 수/좌우/체감, 완료·부분·중단, timer·휴식, 수정·삭제 | 장비 센서 실시간 연동, 검증된 개인 반응 예측 |
| 통합 | 하루/Block/rolling 조회, 공통 coach·evidence·승인·이력, 반응형 | 새로운 생리적 효과·부상 예측 주장은 FUT-08 별도 gate |

처음부터 모든 식사의 g 단위 계량을 강제하지 않는다. 최소 사용 경로는 `시간·먹은 항목/양의 설명·계획과의 관계`만으로도 저장 가능하다. 정확한 영양 합계가 필요한 기능은 추가 구조화값을 요구하며 추정·미상태를 명시한다. calorie tracking과 체중은 선택이며 체중 감량을 제품 기본 목표로 두지 않는다.

## 3. 추가 화면 S25~S30

| ID | URL / 이름 | 주요 필드·행동 | 기존 화면과의 연결 |
|---|---|---|---|
| S25 | `/nutrition` 영양 대시보드 | 오늘 계획/기록, 훈련 관련 보급, 선택한 영양소·수분, 데이터 충족도, tip·질문 CTA | S03 오늘, S10 코치, S18 자료 |
| S26 | `/nutrition/plans/:id` 영양 계획 | daily template·날짜·세션/대회 상대 시각, 음식 또는 영양 목표, 대안, 초안/승인/이력 | S05 planner, S11 제안 |
| S27 | `/nutrition/logs`, `/new`, `/:id/edit` 실제 섭취 | 시간, 음식/제품·양·단위·측정/추정, 부분 영양값, 수분, 불편감·메모, 정정/삭제 | S09 활동 보급 탭, S25 |
| S28 | `/supplementary`, `/supplementary/routines/:id` 보강·루틴 | 오늘·이번 Block, 루틴 만들기/복제/편집/배치, 목적·장비·동작·세트 | S04/S05, S06 보강 세션 editor |
| S29 | `/supplementary/exercises`, `/:id` 동작 라이브러리 | 동작 계열·장비·숙련·목적·부위, 수행 설명, 주의·대체 조건, 미디어/근거 | S17 gallery·S19 reader |
| S30 | `/supplementary/sessions/:id/perform` 보강 수행 | 현재 세트·실제 값·휴식 timer·중단 이유, 임시저장·종료 확인 | S07 활동 목록, S09 `tab=sets` 상세 |

음식 항목과 루틴 편집의 상세 하위 경로는 해당 module의 route manifest로 확정한다. 현재 HTML에 6개 화면을 추가한 것이 아니라 production 화면 요구를 S01~S30으로 확장한 것이다.

모바일 하단 5개 목적지는 유지한다. 영양·보강은 `더보기`에 명시하고 오늘의 quick action, planner 종류 필터, 선택 session의 contextual link에서 바로 접근한다. 모든 기기에 동일 CRUD·질문·승인 경로를 제공한다. 화면 배치는 [07](07_responsive_layout.md)을 따른다.

## 4. 영양 사용자 흐름과 UI

### 4.1 팁과 질문

TipCard는 범주(daily/before/during/after/hydration), 대상 조건, 근거 ResourceVersion/Passage, 검토 상태·작성일·한계를 포함한다. 개인 기록을 분석하지 않은 일반 팁을 개인 맞춤 처방처럼 표시하지 않는다. RAG가 아직 미구현이면 검토된 자료 링크를 사용하고 검색·인용 완료로 표시하지 않는다.

질문 starter 예: “내일 장거리의 보급 계획을 함께 검토해줘”, “계획한 음식 대신 다른 것을 먹었는데 기록을 비교해줘”, “이번 주기 훈련 일정에 맞춰 식사 시각을 조정할까?”. 예문은 상담 기능을 설명하며 특정 섭취량을 권하는 처방이 아니다.

### 4.2 계획

일별 nutrition plan은 기본 식사·간식·수분과 session/race에 연결된 before/during/after 항목을 함께 가진다. 목표는 `특정 음식과 양`, `영양소 범위`, `시간·행동 계획` 중 하나이거나 명시된 조합이다. 어떤 정보가 확정값·사용자 설정·LLM 제안인지 표시한다.

시각은 절대 날짜/시간 또는 세션 시작·종료 기준 offset으로 저장한다. 예를 들어 `session_start + offsetMinutes` 같은 관계를 저장하되 실제 시각은 기준 훈련 버전에 의해 계산한다. 종료 시각·예상 시간이 없으면 임의 페이스로 만들어 채우지 않고 `unresolved`로 둔다.

계획에서 “먹음”을 누르면 실제 기록 초안을 연다. 기본값 복사는 가능하지만 **섭취 시각·양·실제 여부를 확인하기 전 actual로 저장하지 않는다.** 계획을 채웠다고 섭취 완료가 되지 않는다.

### 4.3 실제 섭취

IntakeEntry는 한 번의 실제 섭취를 표현한다. 영양 대시보드·운동 보급·날짜 통계가 같은 ID를 참조하며 여러 화면/세션에 링크되었다고 합계가 늘지 않는다. 음식·음료는 같은 원장에 담되 기록된 수분 mL와 전체 음식 무게 g를 자동 치환하지 않는다.

Nutrient 값은 섭취 항목 전체에 대한 정규화 값과 출처를 저장한다. per-serving/per-100g/per-100mL 원자료의 기준·수량·변환 정의도 보존한다. 데이터베이스 항목이 나중에 바뀌어도 과거 섭취 값을 조용히 다시 계산하지 않는다. 실제 정정은 새 revision과 관련 집계·근거 무효화로 처리한다.

입력 후보: energy(kcal), carbohydrate/protein/fat(g), fluid(mL), sodium(mg). 제품 성분에 있는 sodium과 salt를 같은 필드로 혼동하지 않는다. caffeine 등 추가 성분은 선택 확장이고 권장 용량 계산을 자동 활성화하지 않는다. 식품명만 입력한 경우 영양 값은 null이다.

“섭취 기록 없음”은 “먹지 않음”이 아니다. 알려진 합계와 `부분 기록 / 사용자가 기록 완료로 표시`를 함께 보여준다. 기록 완료 표시는 자기보고 상태이지 실제 섭취 측정의 정확성을 보장하지 않는다. 기기 소비칼로리는 섭취 에너지와 다른 metric이다.

### 4.4 UI 컴포넌트

`NutritionTimeline`, `IntakeQuickAdd`, `FoodPortionField`, `NutrientAmountField`, `NutritionPlanActual`, `FuelingAnchorBadge`, `CoverageNotice`, `TipCard`를 도메인 모듈에서 조합한다. 공통 QuantityField·SourceBadge·Timeline은 UI/Experience Kits로 추출한다. 칼로리 초과/미달을 도덕적 성공·실패로 색칠하지 않는다.

## 5. 보강훈련 사용자 흐름과 UI

### 5.1 분류는 두 축 이상으로 둔다

맨몸은 저항·장비 방식이며 플라이오매트릭은 수행 특성이다. 서로 배타적인 단일 enum에 넣으면 맨몸 점프를 표현하기 어렵다.

| 축 | 예시 |
|---|---|
| 운동 계열 | resistance, plyometric, mobility, balance/stability, activation, other |
| 장비/저항 방식 | bodyweight, dumbbell, barbell, machine, band, weighted-bodyweight, assisted |
| 목적·부위 tag | 힘·탄성·코어·편측 안정성 등 사용자가 확인한 목적/설명 |
| 수행 구조 | 양측/좌/우, reps/time/contacts/distance, 단독·superset·circuit |

ExerciseDefinitionVersion은 지원 입력 metric, 수행 설명·안전 주의, 검토 상태, 미디어/문헌 링크를 가진다. 동작명만 비슷하다는 이유로 기록을 병합하지 않는다. 운동 방법 콘텐츠는 검토 대상이며 이번 문서에 개인용 처방을 포함하지 않는다.

### 5.2 계획과 루틴

RoutineTemplateVersion → 날짜별 PlannedSession(kind=supplementary) → ExerciseBlock → SetTarget을 구성한다. 루틴은 버전 있는 재사용 템플릿이며 템플릿 수정이 이미 승인한 세션을 바꾸지 않는다.

SetTarget에는 실제 필요한 축만 넣는다: 반복 수 또는 시간, 외부저항, 세트 간 휴식, tempo, 선택 RIR/RPE, 좌우, 플라이오 접촉 수 및 정의. `3×10`처럼 자유문만 보관하지 않고 구조화한다. 자유문은 보조 설명으로 남긴다.

Superset/circuit은 동작 순서와 반복 group, 동작 사이/round 사이 휴식을 구분한다. 예상 소요시간은 명시된 추정이며 측정한 actual duration이 아니다. 1RM이나 체중을 입력하지 않은 사용자에게 임의로 계산한 값을 요구하지 않는다.

### 5.3 시행과 세트 기록

각 set은 `미확인 / 수행 확인 / 부분 수행 / 미수행 확인 / 중단`을 구분한다. 계획 반복 수가 자동 actual 값이 되지 않는다. 이전 set 값 복사는 입력 편의를 위한 초안이며 확인을 거친다. actual은 개별 side/count/외부저항/시간/RIR/RPE/중단 이유를 보존한다.

모바일 실행 화면은 현재 동작·세트, 큰 완료/수정 버튼, 다음 동작, 선택적 휴식 timer로 구성한다. 정확한 수치는 운동 후에도 보완할 수 있다. Timer는 매초 callback 횟수만 세지 않고 기준 시각·일시정지 상태로 계산하며 foreground 복귀 시 재계산한다. 기록과 timer를 별도로 저장해 통신 실패가 timer를 초기화하지 않게 한다.

Local execution log는 명시 동의/사용자 scope 아래 임시 저장 가능하나, 실제 서버 반영 전 “동기화 대기”를 표시한다. 세트 로그의 오프라인 저장과 **계획 승인 오프라인 금지**는 서로 다른 계약이다.

### 5.4 부하·양의 단위

| 항목 | 기록/집계 규칙 |
|---|---|
| 웨이트 | 외부저항 총량 kg, 기구·동작 version, count 기준 보존. 덤벨 한 개 무게인지 양손 합계인지 명시 |
| 맨몸 | 외부저항 없음과 신체 부하 0을 구분. 실제 부하를 체중×임의 계수로 생성하지 않음 |
| 편측 반복 | 좌/우 각각 실적을 기록하거나 명시한 total 기준 사용. per-side 10을 자동 20으로 계산하지 않음 |
| 플라이오 | jump/landing event/foot contact의 정의와 값. definition이 다른 counts는 직접 합산하지 않음 |
| 등척성/가동성 | 시간, 동작 범위 설명, 좌우, 선택 체감; 거리 없는 운동에 0km 달성률 강제 없음 |
| RIR/RPE | 질문·척도·대상(set/session) 분리. RIR=0은 유효한 보고이고 null과 다름 |

동일한 exercise·external-load/count 정의 안의 volume-load(kg×reps)는 분석할 수 있으나 이를 에너지·부상 위험·러닝 km로 변환하지 않는다. 서로 다른 동작의 tonnage를 생리적 동등 부하로 비교하지 않는다. 같은 정의의 session-RPE 부하는 보조 합계와 종목별 breakdown을 제공할 수 있지만 국소 부담을 설명하는 유일한 지표로 사용하지 않는다.

### 5.5 실제 Activity와 통합

보강 수행도 **공통 Activity 원장에 하나만** 만든다. SupplementaryExecution/SetLog는 activityId를 참조하는 상세다. 별도 보강 로그 화면과 Activities에서 동일 운동 시간을 두 번 세지 않는다. provider 수집 운동과 수동 set log가 같은 세션이면 source와 상세를 연결하고 새 운동을 중복 생성하지 않는다.

러닝+보강이 한 파일에 들어오면 원본 parent와 부분 bout를 구분한다. 확정 가능한 non-overlapping 구간 배정만 합산하고, 경계가 모호하면 `mixed/unallocated`로 남긴다. 전체 parent duration과 자식 bout duration을 모두 더하지 않는다. 지원하지 않는 FIT/HealthKit set 필드를 생성하지 않고 수동 세트 보완을 허용한다.

## 6. 데이터 모델과 버전

| 엔터티 | 핵심 데이터 / 의미 |
|---|---|
| NutritionPreference | 선택한 식이 선호·불내성/알레르기 보고·음식 availability·AI 전달 동의; 근거·확인 상태 |
| NutritionPlanVersion | 불변 plan ID/version, 기간·목적, 연결 training version, 승인 이력 |
| NutritionPlanItem | 음식/영양 target/행동, 절대 또는 relative anchor, 계획 값, source, 상태 |
| FoodDefinitionVersion | 식품/제품명, 기준 단위·portion, 성분·출처/확인일, 검토·권한 |
| IntakeEntryRevision | occurredAt/recordedAt, 실제 양·부분 영양 값, 계획·활동 링크, source, coverage |
| ExerciseDefinitionVersion | 계열·장비·좌우·허용 metrics·count definition·설명/미디어·검토 상태 |
| RoutineTemplateVersion | 목적·동작 block·세트 target·순서/round·기구 조건 |
| PlannedSession(kind=supplementary) | 기존 PlanVersion 안의 세션; SupplementaryWorkoutSpec을 참조 |
| SupplementaryExecution / SetLog | canonical Activity에 연결되는 actual detail; 안정된 log ID와 revision |
| JointAdjustmentProposal | 훈련/영양/두 영역 scope, 버전 묶음, 변경 diff·evidence·승인 해시 |

공유 코드 초안은 [extensions-v022.contracts.ts](extensions-v022.contracts.ts)에 둔다. TypeScript는 의도를 표현하는 초안이며 runtime schema·migration·API 구현이 아니다. 권한은 서버 문맥에서 결정하며 DTO의 ownerId를 신뢰하지 않는다.

기존 endurance WorkoutSpec을 조용히 덮어쓰지 않는다. API schemaVersion과 `kind`를 포함한 판별 union을 추가하고, 과거 운동은 endurance adapter로 계속 읽는다. 구형 앱이 supplementary spec을 이해하지 못하면 unsupported와 업그레이드 경로를 표시하며 러닝 기록으로 변환하지 않는다.

## 7. 통합 Planner와 주기별 목표

Day projection은 running/supplementary/nutrition을 함께 보여주고 종류·current/draft/proposal/actual별 필터를 제공한다. 음식은 운동 완료 건수나 거리의 분모에 넣지 않는다. Day/Block/rolling의 각 카드에서 운동과 영양의 집계 정의를 구분한다.

Wave/Phase/Block에는 보강 목적·유지/변경 의도와 영양 관련 행동 목표(예: 보급 계획 연습)를 부가 목표로 연결할 수 있다. 초안은 특정 주기 길이나 보강 빈도·부하를 정답으로 강제하지 않는다. 보강 경험·장비·시간·사용자 반응, 주요 러닝 세션과 대회 우선순위를 코치 입력으로 제공한다.

계획된 러닝을 이동하면 relative nutrition의 영향, 인접 보강 세션, 연동한 목표를 **변경 미리보기에서 함께 보여준다**. 영향을 주는 영양 항목이 있으면 combined scope 확인을 요구하고 몰래 이동하지 않는다. 관계 계산과 필요한 버전 갱신은 같은 후보로 검증한다.

이미 기록된 섭취와 수행은 계획 이동에 따라 재배치하지 않는다. 연결 세션 삭제 시 actual을 cascade-delete하지 않고 기록을 보존한 채 link를 정정/해제한다. 미래 relative item은 미해결 상태와 재연결·삭제 선택을 제공한다. 누락한 식사·훈련을 자동으로 다음 날 모두 누적하지 않는다.

## 8. 코치·도구·RAG 확장

### 8.1 하나의 코치, 구분된 사실과 도구

| 역할 | 도구 계약 초안 |
|---|---|
| 영양 문맥 | `get_nutrition_context(snapshot, range, targetSessionIds)` |
| 섭취 분석 | `compare_nutrition_plan_actual(snapshot, range)` → 부분 합계·누락·단위·source |
| 보강 문맥 | `get_supplementary_context(snapshot, range)` → 운동 경험·장비·세트 기록·불편감 보고 |
| 동작 탐색 | `search_exercise_catalog(filters)` → version·지원 값·review 상태 |
| 통합 영향 | `project_joint_adjustment(snapshot, trainingChanges, nutritionChanges)` |
| 최종 검증 | `validate_joint_candidate(snapshot, candidate)` → errors/warnings/unknowns |
| 지식 | 기존 retrieval 도구에 nutrition/supplementary topic·대상·근거 버전 filter 추가 |

Activity/섭취 합계는 SQL·계산 도구로 조회한다. 영양/보강 자료는 문서 RAG로, 장비·식이 제약·현재 계획은 필수 문맥으로 제공한다. 검색이 실패했다고 필수 사용자 제약을 생략하지 않는다. LLM은 보급 음식 대안이나 보강 동작 대체 후보를 작성할 수 있지만, 확인 안 된 알레르기·운동 경험을 사실로 저장하지 않는다.

대화 예: “긴 러닝을 한 뒤 보강 일부를 중단했다”를 시간 부족·기록 누락·난도·불편감 등 확인된 원인으로 구분한다. 관련 섭취 기록이 부분적이면 영양 부족을 원인으로 단정하지 않는다. 코치는 일정 조정과 영양·보강 검토를 함께 제안하되 무엇이 관측·가설인지 구분한다.

### 8.2 함께 승인하는 변경

`scope = training | nutrition | combined`이며 보강은 training 범위에 포함된다. combined 후보에는 trainingPlanVersion/nutritionPlanVersion, 각 actual data revision, relevant preference/constraint revision, conversation/policy/evidence 기준을 묶는다. 범위별로 어떤 revision이 필수인지 runtime schema에서 검사한다.

해시와 새 계획 버전, 승인, outbox는 기존 Plan Service와 동일 transaction 경계로 적용한다. 훈련 변경만 성공하고 영양 변경이 실패한 반쪽 성공을 만들지 않는다. 별개로 승인하고 싶다는 요청은 새 범위·후보로 재계산한다. 단순한 식사 로그/세트 정정은 사용자 record command로 처리하되 관련 코칭 근거를 무효화한다.

기존 v0.2의 `CoachingBasisV2`를 미래 실행에 무조건 재사용하지 않고 새로운 schemaVersion과 optional-domain basis로 마이그레이션한다. nutrition만 상담하는 사용자에게 training plan이 없다는 이유로 가짜 plan ID를 만들지 않는다.

## 9. 안전·프라이버시·품질 경계

영양 기록을 바탕으로 일반 계획·팁·질문을 지원하되 질병 진단이나 치료 식단, 검증 없는 에너지 결핍/REDs 판정, 자동 감량 목표를 기본 동작으로 두지 않는다. 스포츠 영양의 개인화와 전문가 역할은 관련 학회 position statement를 검토할 항목이며, REDs는 별도 임상·연구 맥락을 갖는 개념이다. 이 문서에서 진단 규칙이나 임계값을 구현하지 않는다.[R05](sources-v022.md#r05) [R06](sources-v022.md#r06)

음식 선호·알레르기 보고·소화 불편·몸 상태는 private 데이터다. 사용자 확인과 전달 동의를 구분하고 일반 분석 로그에 자유문을 남기지 않는다. 삭제·coach-use 철회 시 원본, 파생 합계, 검색·캐시, 인용 발췌·개인 기억의 정책을 적용한다. 원인 가설을 사용자 건강 특성으로 영구 확정하지 않는다.

보강에서는 통증/불편감 보고를 무시하고 중량·반복·접촉 수를 자동 증가하지 않는다. 낮은 심박을 보강 부담이 낮다는 근거로 단정하지 않는다. 재활·부상 치료 계획과 일반 보강을 구분하며 전문가 검토 필요 결과를 지원한다. **특정 시간 간격·중량·섭취량을 보편적인 안전 규칙으로 추가한 것은 아니다.**

RAG 문헌은 검토 상태·대상·조건을 표시하고 정책 변경에는 별도 검토를 둔다. Nutrition/Exercise tip seed corpus의 실제 자료 선정·최신성·사용 권한 검토는 FUT-06/08/11/12에 남겨둔다. 현재 개인 처방의 생리학적 타당성을 검증한 것이 아니다.

## 10. 개발 위치와 API 초안

```text
packages/modules/nutrition/
packages/modules/supplementary/
packages/server/application/nutrition/
packages/server/application/supplementary/
packages/server/domain/{nutrition,exercise-catalog}/
packages/server/metrics/                 # 종목·metric 정의별 계산
packages/server/evidence/               # joint snapshot manifest
packages/experience/planner-kit/        # generic event/layer 그대로
packages/experience/data-workbench/     # linked actuals·세트 표
packages/ui/components/                 # 단위입력·source·coverage 재사용
```

| API 초안 | 의미 |
|---|---|
| `GET /bff/v1/nutrition?date=...&windowDays=...` | 영양 계획/부분 실제/훈련 context 조회 |
| `POST /v1/nutrition/plan-drafts` | 영양 계획 초안·예상 영향 |
| `POST /v1/nutrition/intakes` | 사용자가 확인한 actual 섭취 |
| `POST /v1/nutrition/intakes/:id/revisions` | actual 정정; 원본/버전 보존 |
| `DELETE /v1/nutrition/intakes/:id` | 의미를 명시한 삭제/재집계 |
| `GET /v1/exercises` | versioned 동작 library 검색 |
| `POST /v1/supplementary/routines` | 루틴 template draft |
| `POST /v1/supplementary/routines/:id/versions` | 사용자 확인 template 버전 |
| `POST /v1/sessions/:id/executions` | canonical Activity를 만들거나 명시 매칭한 실행 |
| `POST /v1/executions/:id/set-logs` | 안정된 log ID로 actual 세트 입력 |
| `POST /v1/executions/:id/set-logs/:setId/revisions` | 세트 actual 정정 |
| `POST /v1/proposals/:id/approve` | 기존 endpoint를 versioned joint 계약으로 확장 |

API는 경로·의미 초안이며 OpenAPI/인증/삭제/멱등성 구현은 별도다. 새 provider·식품 DB 없이 수동 입력과 사용자가 정의한 음식/동작부터 완결한다. Garmin/HealthKit이 상세 nutrition/strength 필드를 제공하는지 이번 변경에서는 확인하지 않았으며 지원 완료로 표시하지 않는다.

## 11. 구현 순서·시험·완료 기준

M0: 반응형·단위·null·좌우/contacts·relative anchor·joint approval schema와 fixture를 확정한다. M1의 기존 러닝 흐름 다음에 **M1b 영양·보강 수동 core loop**를 추가한다. M2에서 팁·검토된 자료·RAG와 연동한 심화 비교를 완성한다. M3은 native 수집 가능한 데이터와 lifecycle을 실기기에서 검증한다. MVP 화면 범위를 조용히 축소하지 않는다.

FUT-11(영양), FUT-12(보강)과 FUT-10(반응형), 기존 FUT-02(서버)/06(RAG)/08(검증)를 연결한다. 담당자·기간은 미확정이다. [05 §10](05_implementation_requirements.md#v022-requirements)의 V022-F/V022-A에서 요구와 시험을 추적한다.

대표 완성 시나리오:

`장거리 계획 + 연결된 보급 계획 + 같은 Block의 보강 → 실제 러닝/섭취/세트 기록 → 누락·중단 이유 확인 → 코치가 함께 검토 → 훈련·영양 변경을 한 화면에서 확인 → 사용자 승인 → 새 버전과 actual 이력 유지`.

이 예는 기능 연결을 시험하기 위한 것이지 실제 사용자의 훈련·식사 계획이 아니다. 전체 기능이 문서화되었더라도 UI/서버/native/지식 검토가 완료되었다고 표시하지 않는다.

## 12. v0.2.3 루틴·스트레칭·회복 연결

여기서의 RoutineTemplateVersion은 운동 전용 콘텐츠다. [09](09_routines_stretching_recovery.md)의 RoutineBlueprintVersion은 그 version과 영양·회복·체크인을 조합하는 별도 객체다. 기존 템플릿/세트 기록의 의미를 바꾸지 않으며 실제 기록은 각 원장에 1회만 남긴다.

StretchProfile은 공통 ExerciseDefinition의 전문 확장으로 S34와 S29/S30에서 공유한다. 계획은 supplementary session/block, 실제는 canonical Activity의 상세로 연결한다. RecoveryPlan은 비운동 회복 행동을 소유하고 러닝·스트레칭·영양은 기존 훈련/섭취의 참조로 표시한다.

v0.2.2의 joint schema는 legacy로 보존한다. 새 schemaVersion=4에서 recovery/routine_schedule을 추가하고 read dependency와 plan head 존재/미존재를 검사한다. 계획 이동에 연결된 미래 영양·회복·routine occurrence가 함께 영향을 받으면 통합 diff/승인/원자 적용을 수행한다. actual 정정은 별도 record command다. 세부 타입은 [extensions-v023.contracts.ts](extensions-v023.contracts.ts), 구현 백로그는 FUT-13~15다.
