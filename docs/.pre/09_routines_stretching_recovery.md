# 09 · 루틴 관리·스트레칭·회복 전략 기획 및 설계 v0.2.3

기준일: 2026-09-16 · 상태: 제품·데이터·개발 계약 초안. 실제 UI/서버/알림/native 구현이나 운동·회복 효과 검증 결과가 아니다.

## 1. 이번 확장의 범위와 기존 설계 연결

사용자 요청인 **루틴 관리, 스트레칭, 회복 전략**을 MVP의 명시적 범위에 추가한다. 기존 [08 영양·보강](08_nutrition_supplementary_training.md)의 보강 루틴·동작·세트 기록, [01](01_product_screen_spec.md)의 회복 체크인, [07](07_responsive_layout.md)의 반응형 계약을 재사용한다.

| 영역 | 기존 토대 | 이번 결정 |
|---|---|---|
| 루틴 | 보강 전용 RoutineTemplateVersion | 운동·영양·스트레칭·회복·체크인을 묶는 범용 루틴 조합과 유한 일정 배치 |
| 스트레칭 | mobility 동작·시간·좌우 입력 | 전용 탐색/편집 화면, 방법·목적·좌우·실제 유지/반복·체감 기록 |
| 회복 | wellbeing 체크인·기기 지표·일반 코칭 | 목표·선택지·실행·재평가 조건이 있는 회복 전략과 행동 기록 |

**루틴은 수행을 조합하는 틀, 스트레칭은 운동 콘텐츠, 회복 전략은 상황에 따른 계획**이다. 이 셋을 같은 객체나 같은 점수로 합치지 않는다. 루틴의 단계들을 모두 실행하는 것이 언제나 목표는 아니며, 아무것도 추가하지 않고 쉬는 안도 정식 선택지다.

이 문서의 운동/회복 예시는 기능 분류와 입력 설계다. 특정 동작·빈도·온도·시간·강도를 개인에게 권장하거나 효능을 확정하지 않는다. 기존 자료의 출처는 [sources.md](sources.md)·[sources-v022.md](sources-v022.md)에 보존하며, 이번에는 새 임상 문헌·provider API를 검증하지 않았다. 방법별 콘텐츠의 적정성 검토는 FUT-08/14/15에서 수행한다.

## 2. 제품 범위와 완료 경계

| 분야 | MVP 기본 기능 | 별도 후속/검증 범위 |
|---|---|---|
| 루틴 | 만들기·조회·검색·분류·복제·즐겨찾기·버전·보관/삭제, 혼합 단계, 유한 일정 preview/승인, 수행/중단/이력 | 공유 마켓, 외부 자동화 script, 무한 자동 계획 생성, 다중 사용자 편집 |
| 스트레칭 | 공통 동작 library의 전문 보기, 단계별 계획·실제, 좌우·시간/반복·체감, 영상·자료, 일별/세션 연결, 코치 질문 | 카메라 ROM/자세 추정, 자동 부상 진단·재활, 미검토 파트너 보조 기법 자동 처방 |
| 회복 전략 | 휴식·부하 조정·수면 준비·기존 영양 계획·선택적 방법의 비교, 계획·실행·후속 체크인, 코치 질문 | 기기 원격 제어, 자동 의료 처방, 임의 회복 확률/종합 효능 순위 |
| 통합 | 기존 Planner·Activity·Intake·CheckIn·RAG·승인·버전·삭제와 연결 | 외부 provider가 상세 기록을 모두 제공한다는 가정 |

자동 권장 템플릿의 검토와 사용자 수동 기록 지원은 다른 조건이다. 미검토 회복 방법도 사용자가 이미 수행한 사실을 수동 기록할 수 있지만, 시스템 추천 기본값으로 배치하거나 효과가 검증된 것으로 표시하지 않는다.

## 3. 정보 구조 및 화면 S31~S35

| ID | URL / 화면군 | 기본 업무 | 연결 |
|---|---|---|---|
| S31 | `/routines` 루틴 라이브러리 | 내 루틴·검토된 템플릿, 목적·소요시간·장비·분야 필터, 검색·복제·보관·삭제 | S28 보강 템플릿·S34 스트레칭·S35 회복 |
| S32 | `/routines/:id`, `/:id/edit`, `/:id/schedule` 루틴 상세·편집·배치 | 단계·순서·선택 그룹·시간 anchor, version diff, 유한 일정 preview·확인 | S05 Planner·S11 승인 |
| S33 | `/routine-runs/:id` 루틴 실행·회고 | 현재 단계, 시작/일시정지/다음/중단, 단계별 실제 입력, 동기화 상태·이력 | S30 운동 performer·S27 섭취·S12 체크인 |
| S34 | `/stretching`, `/stretching/exercises/:id` 스트레칭 | 동작 탐색, 부위·방법·목적·장비 필터, 계획/실제, 자료·코치 | S29 공통 동작 catalog·S06/S30·S32 |
| S35 | `/recovery`, `/recovery/strategies/:id` 회복 워크스페이스 | 오늘/전략/방법/기록 탭, 선택지 비교·계획·실행·재평가 | S12 관측/체크인·S10 코치·S11·S18 자료 |

S28의 보강 루틴 editor는 **운동 단계 전용 콘텐츠 editor**로 유지한다. S32는 그 콘텐츠와 영양·회복 등을 조합한다. 두 화면이 별도의 동일 운동 라이브러리/실적을 만들지 않는다. S34는 `supplementary` 모듈의 하위 screen이며 별도의 중복 movement store를 만들지 않는다.

S12는 현재 관측·자기보고를, S35는 무엇을 할지와 했는지를 보여준다. 같은 체크인 입력은 공통 ID를 사용한다. 모바일 하단 목적지는 기존 5개로 유지하고 오늘 quick action·더보기·문맥 링크에서 신규 화면에 접근한다.

## 4. 루틴 관리: 콘텐츠, 배치, 실행을 분리한다

### 4.1 세 종류의 객체

```text
RoutineBlueprintVersion       # 반복 사용할 단계 조합; 날짜·실제 수행 없음
          ↓ 미리보기 / 사용자 승인
RoutineSchedule + Occurrence  # 승인된 날짜별 계획 항목을 가리키는 manifest
          ↓ 사용자 시작·확인
RoutineRun                    # 단계 진행과 실제 기록의 링크; 운동 원장 아님
```

기존 `RoutineTemplateVersion`은 보강 workout 템플릿을 의미한다. v0.2.3의 `RoutineBlueprintVersion`과 같은 이름으로 재정의하지 않는다. 범용 blueprint는 version이 고정된 보강 템플릿을 **참조**한다. 향후 `WorkoutRoutineVersion` 별칭/adapter를 만들 수 있지만 기존 ID·의미는 보존한다.

### 4.2 편집과 버전

제목, 목적, 설명, 태그, 분야, 장비·장소 조건, 예상 소요시간, 단계 순서, 각 단계의 콘텐츠 version, 선택 그룹, 안내·미디어를 편집한다. 단계 이동은 DnD와 위/아래 메뉴를 함께 제공한다. 예상 시간과 실제 수행 시간은 다른 값이다.

종류는 workout/영양/회복 행동/check-in/checklist로 제한한다. 반복 동작 세트는 보강 spec이 소유하고 범용 루틴은 임의 코드·중첩 무한 루프를 실행하지 않는다. 체크리스트를 체크한 사실과 섭취·운동을 수행한 사실을 동일시하지 않는다.

Blueprint를 수정하면 새 version을 만든다. **기존 승인 세션과 실행 중인 run은 당시 version을 유지**한다. 미래 일정에 새 version을 반영하려면 영향 미리보기와 사용자 승인을 거친다. 운동 콘텐츠나 연결 자료의 사용 철회·안전 검토 상태 변경은 저장된 version을 재작성하지 않지만, 새로운 시작/추천 전 별도의 사용 가능성 검사로 차단할 수 있다.

### 4.3 기본 일정 옵션

| 형태 | 동작 |
|---|---|
| 한 번 | 명시한 현지 날짜/시간에 배치 |
| 선택 요일 | 시작/끝 날짜 안의 요일; 지역 시간과 timezone 보존 |
| N일마다 | 시작일 기준 달력 날짜 간격; 마지막 유효 날짜까지 |
| 주기 내 날짜 | 선택 Block/Phase의 명시 날짜 또는 상대 일차 |
| 훈련 연결 | 사용자가 선택한 실제 session ID 목록의 시작/종료 전후 |

모든 반복은 **유한 기간과 생성 개수 제한**을 갖는다. 끝이 없는 반복 또는 향후 모든 장거리라는 무한 selector를 즉시 정본 계획에 적용하지 않는다. preview에는 기존 세션/영양/회복과의 중복·겹침·소요시간·일정 잠금을 표시한다. 승인된 occurrence와 그 도메인별 항목을 같은 transaction에서 저장한다. 재시도 키는 schedule/version/anchor occurrence/step을 구분한다.

템플릿 저장, 즐겨찾기, 목록 보관은 계획 승인이 아니다. 일정에 영향을 주는 활성화·일시정지·재개·범위 변경은 미래 발생분을 보여주고 확인한다. 알림만 끄는 설정은 계획을 취소하지 않는다. 미수행 루틴을 다음 날로 자동 누적하거나 두 번 하도록 보상하지 않는다.

보관은 새 선택 목록에서 숨김, 삭제는 정책에 따른 원문·개인정보 제거다. 일정 중지와 기록 삭제를 따로 묻는다. 실행 이력과 실제 원장은 템플릿 삭제에 cascade-delete되지 않으며, 완전 삭제 요구는 해당 기록의 개인정보 정책을 별도로 적용한다.

### 4.4 상대 시각과 이벤트

시간 anchor는 명시 날짜/시간 또는 session/race 시작·종료 기준 offset이다. 종료 시간이 없으면 `unresolved`로 표시한다. 거리를 임의 페이스로 나누어 완료 시각을 만들지 않는다.

훈련 일정을 옮기면 연결된 미래 루틴·영양·회복의 이동 결과를 **같은 제안의 영향 목록**으로 계산한다. 연결 해제/기준 삭제도 해결을 요구하며 실제 기록 시각은 바뀌지 않는다.

`운동 완료 후 알림`은 이미 승인된 내용을 안내하는 trigger이지, provider event가 새 계획을 승인하는 기능이 아니다. 늦은 업로드·과거 backfill은 받은 시각이 아닌 실제 발생 시각과 유효창으로 판단하며 오래된 알림을 대량 생성하지 않는다. 이벤트 수신으로 계획 날짜·용량·선택 전략이 달라져야 하면 새 draft와 승인을 요구한다.

### 4.5 루틴 예시 — 처방이 아닌 조합 예

`훈련 전 준비`는 체크인 → 선택된 준비 동작 → 기존 보급 계획 확인을 묶을 수 있다. `운동 후 정리`는 실제 운동 확인 → 선택한 스트레칭 → 영양 계획 링크 → 회복 체크인으로 만들 수 있다. `취침 준비`는 사용자 설정 행동과 다음 날 계획 확인을 묶는다.

이 예시는 선택 가능한 구성이다. 모든 단계나 특정 수행 시간을 모든 사용자에게 자동 배치하지 않는다. 기존 동일한 보급·체크인 항목이 있으면 재사용하거나 중복 확인을 요청한다.

## 5. 루틴 실행·이력

실행 화면은 한 단계씩 표시하되 전체 순서·현재 계획 version·선택한 대안·예상 시간·언제든 중단할 수 있는 경로를 제공한다. 상태는 pending/in_progress/partial/performed/confirmed_skipped/stopped/not_applicable을 구분한다.

운동 단계는 Activity/SetLog, 영양은 IntakeEntry, 회복 행동은 RecoveryActionLog, 체크인은 CheckIn, 준비물 등 일반 항목은 ChecklistConfirmation에 저장한다. **RoutineRun은 이 실적들의 링크를 묶는 역할**만 하며 운동 1회를 추가로 생성하지 않는다. 이미 기록된 actual 연결은 소유권·시점·대상·배정 범위를 검증하고 수치 합계는 안정된 canonical ID로 1회만 계산한다.

동일 저장소에서 단계 actual 생성과 progress 링크 갱신은 같은 transaction으로 처리한다. 비동기 경로를 쓰는 경우 actual 저장 실패 시 해당 단계를 동기화 대기로 남기고 완료 성공을 먼저 표시하지 않는다.

계획 없이 실행한 루틴도 기록할 수 있다. 이때 존재하지 않는 PlanVersion을 만들거나 실제 보고에 계획 변경 승인을 요구하지 않는다. 계획/실제 연결이 모호하면 사용자가 확인할 때까지 미연결로 보존한다.

타이머는 입력 보조다. 시간이 끝났다고 실제 수행이 자동 완료되거나 정확한 유지시간이 측정되었다고 표시하지 않는다. 실제값은 사용자 확인/측정 출처를 구분한다. 오프라인 실행 로그는 계정별 outbox에 저장하고 동기화 대기를 표시하며, 재전송은 안정 ID·revision으로 중복을 막는다. 계획 승인에는 서버 연결이 필요하다.

선택 그룹은 한 대안만 수행할 수 있다. 예: 회복 러닝과 완전 휴식은 모두 수행해야 할 체크리스트가 아니다. 선택하지 않은 대안은 완료율 분모에서 제외하고 선택 이력·분모를 보존한다. 필수/선택·건너뜀·미확인 개수는 별도로 보여준다. 사용자 동의 없이 제외하거나 뒤늦게 선택을 바꾸어 달성률을 부풀리지 않는다.

회고는 사용성·실행률·사용자 보고 변화다. 스트릭을 위해 아픈 날에도 실행하도록 유도하거나, 실행률을 신체 회복률로 표시하지 않는다.

## 6. 스트레칭: 같은 동작 catalog의 전문 보기

### 6.1 구분할 정보

| 축 | 설계 필드 |
|---|---|
| 방법 | 정적 유지 / 동적 반복 / 기타 검토된 방법 |
| 움직임·보조 | 능동/수동 또는 미지정, 자가/장비/파트너 보조 |
| 맥락·목적 | 준비 운동, 별도 가동성 연습, 운동 후 정리 등 사용자가 확인한 목적 |
| 대상 | 부위, 좌/우/양측, 동작 version |
| 계획 | 반복/시간/세트, 좌우 기준, 선택적 휴식·안내·대체 |
| 실제 | 수행한 시간/반복/좌우, 부분·중단·이유, 편안함/불편감 보고 |
| 설명 | 순서·영상·텍스트 대안, 출처, 검토 상태, 주의·중단 안내 |

`stretching` 분류와 StretchProfile을 공통 ExerciseDefinition 위에 추가한다. 기존 mobility를 전부 stretching으로 재분류하지 않는다. 근력 routine의 준비 동작 또는 단독 스트레칭 세션 모두 같은 definition/version을 사용한다. 고급 보조 기법은 필요한 검토·설명·범위가 확정되기 전 추천 기본 템플릿에 포함하지 않는다.

### 6.2 계획·실제 모델

정적 유지에는 계획된 유지시간/실제 확인한 유지시간, 동적 반복에는 반복·count 기준이 필요하다. 좌우를 각각 저장하거나 전체 기준을 명시한다. 전체 timer를 자동 절반으로 나누어 좌우 실적을 만들지 않는다. 휴식 시간은 스트레칭 유지시간과 별개다.

긴 시간을 버텼다고 좋은 점수를 주거나, 통증 보고를 정상적인 필수 자극으로 재해석하지 않는다. 부위 불편감이 있으면 중단·질문·전문가 검토 필요 경로를 지원하며, 앱이 부상을 진단하거나 특정 기법을 치료로 승인하지 않는다.

가동범위는 사용자가 설명하거나 출처가 있는 측정값으로 입력할 수 있으나, 카메라/센서 없이 각도를 생성하지 않는다. 범위 측정 자동화는 MVP 비범위다.

### 6.3 운동 원장과 집계

스트레칭은 `PlannedSession(kind=supplementary)`의 stretching payload 또는 다른 workout의 명시된 block으로 배치한다. 단독 수행은 canonical Activity에 연결하고, 워밍업/쿨다운의 일부이면 같은 Activity 상세/배정 구간으로 연결한다. 단독 workout의 세션 시간과 내부 단계별 유지시간은 서로 다른 정의로 표시한다.

Provider에 stretching/yoga/혼합 운동 요약만 있으면 세부 좌우·시간·순서를 만들어내지 않는다. 러닝 parent와 자식 스트레칭 구간의 시간 중복 집계를 방지하고, 분리할 근거가 없으면 mixed/unallocated로 남긴다.

## 7. 회복 전략: 목적·선택·관찰을 묶는다

### 7.1 전략 구성

RecoveryStrategyVersion은 검토 목적, 적용 기간, 현재 관련 사실·미확인 정보, 우선순위, 선택한 행동/대안, 다음 확인 시점, 재평가 조건을 가진다. 통계와 별도로 유지되며 승인 전에는 제안이다.

| 영역 | 계획에서 표현할 것 | 실제 기록 |
|---|---|---|
| 휴식·부하 관리 | 완전 휴식, 계획 유지/축소/이동 등 선택지와 일정 영향 | 사용자가 확인한 수행/휴식 보고; 기록 부재만으로 확정하지 않음 |
| 수면·휴식 기회 | 취침 준비, 수면 기회 확보, 낮잠/휴식 일정 | 행동 기록과 수면 관측·보고를 별도 링크 |
| 영양·수분 | 기존 NutritionPlan의 관련 항목 | 기존 IntakeEntry를 참조; 복제 원장 없음 |
| 가벼운 활동·스트레칭 | 선택한 운동 계획 또는 기존 활동 | 공통 Training/Activity 원장을 참조 |
| 회복 방법 | 사용자가 선택하거나 검토된 개별 방법의 계획 | method version·시각·수행·체감·불편감 |
| 재평가 | 다음 체크인/정보 확인/코치 재검토 | 기존 CheckIn·DecisionRecord 링크 |

**회복 전략이 항상 추가 활동을 뜻하지는 않는다.** 기존 훈련의 일부를 줄이거나 쉬고 다시 확인하는 후보를 같은 수준으로 지원한다. 수행 횟수를 늘리는 목적함수를 사용하지 않는다.

### 7.2 회복 방법 카드

방법 library의 분류 후보에는 수면 준비, 수동 휴식, 이완/호흡, 마사지/폼롤링, 압박, 냉·온 적용, EMS 등 사용자 기록 범주를 둘 수 있다. 이 목록은 효과 동등성·우선 추천·제품 추천이 아니다. 능동적인 러닝/걷기·스트레칭 콘텐츠는 운동 catalog를 참조한다.

카드는 method version, 대상 맥락, 사용 목적, 가능한 기대 결과의 범주, 원문 근거/검토일, 근거의 한계, 주의·사용 제외 조건, 필요한 장비·시간, 사용자가 실제로 적용한 조건을 담는다. **통증 완화·기분 변화, 다음 세션 수행, 장기 적응은 다른 결과 항목**으로 정의한다. 앱의 비교 카드에서 이 결과들을 같은 '회복 효과' 숫자로 합치지 않는다.

모든 방법을 효과순으로 정렬하거나 횟수·강도·온도·시간을 LLM이 근거 없이 기본 처방하지 않는다. 약물·영양제 구매/용량 추천이나 회복 장치 원격 제어는 포함하지 않는다. 미검토 method는 수동 기록/자료 열람까지만 지원하고 코치 자동 처방 권한을 주지 않는다. 콘텐츠 설명·안전 안내의 전문가 검토는 해당 공개 기능의 gate다.

### 7.3 실제 실행과 사후 보고

RecoveryActionLog에는 시각, method/version, 계획 연결, 수행 상태, 실제 확인한 조건·시간, 선택적인 전후 자기보고, 불편감, 출처를 저장한다. 전후 보고는 같은 질문/척도/기준시각을 구분한다. 특정 방법 이후 좋아졌다는 관측만으로 그 방법이 원인이었다고 확정하지 않는다.

취침 준비 루틴의 완료와 실제 수면 시간·수면 질은 별개다. 휴식 일정이 끝났다고 충분히 회복되었다고 처리하지 않는다. 기기 점수가 높아도 새 불편감 보고를 무시하지 않는다.

운동이 아닌 행동은 RecoveryActionLog에 저장하고 가짜 Activity·운동 칼로리·session-RPE 부하를 만들지 않는다. 능동 회복의 실제 운동은 Activity에 한 번 기록하고 이곳에는 참조만 둔다. 같은 수면·섭취·운동 기록을 여러 회복 전략이 가리켜도 합계는 늘지 않는다.

### 7.4 전략 갱신과 알림

미확인 정보, 사용자 보고 변화, 중요 세션 접근, 계획/자료 version 변경을 재평가 조건으로 둔다. 조건은 설명 가능한 입력·관측 시각·policy version과 연결하며 LLM이 임의 의료 임계값을 정하지 않는다.

조건 발생은 코치 검토 알림/새 제안을 만들 수 있지만 기존 계획을 자동 승인하지 않는다. 자동 재평가 기능은 별도 동의·예산·묶음 처리·중복 방지 조건을 갖는다. notification 전달과 재평가 실행은 구현 상태를 별도로 표시한다. 루틴 정지·선택 변경·타임존 이동 후 과거 pending 알림을 다시 보내지 않는다.

## 8. 데이터 소유권과 재사용

| 엔터티 | 소유자 / 불변 조건 |
|---|---|
| RoutineBlueprintVersion / RoutineStep | routines; 순서·조건·pinned content reference, actual 없음 |
| RoutineScheduleVersion | routines; finite expansion rule·시간대·활성 범위·version |
| RoutineOccurrence | routines; 도메인별 생성/재사용 계획 항목 manifest; 운동 원장 아님 |
| RoutineRun / RoutineStepProgress | routines; 당시 version·선택·진행·실제 ID 참조 |
| StretchProfile / StretchTarget | supplementary/exercise-catalog; 공유 동작 version과 계획 |
| StretchSetLog | Activity에 연결된 실제 상세; 기존 SetLog/시간 단위·revision 계약 확장 |
| RecoveryStrategyVersion | recovery; 기간·목적·관련 근거·대안·재평가 조건 |
| RecoveryPlanVersion / RecoveryPlanItem | recovery; 운동/영양이 아닌 행동 계획, 또는 기존 계획 연결 |
| RecoveryMethodVersion | recovery catalog; 방법·검토·자료·조건 |
| RecoveryActionLog | recovery; 운동이 아닌 실제 행동·체감·출처 |
| CheckIn / IntakeEntry / Activity | 기존 원장 유지; 새 기능은 참조·배정만 |

문자열 domain 이름만 바꿔 무제한 원장을 추가하지 않는다. 계획 쓰기 영역은 `training`, `nutrition`, `recovery`, `routine_schedule`로 제한한다. 루틴 blueprint 편집은 별도 version command이며 그 자체로 계획 변경 승인이 아니다.

RecoveryStrategy는 연결된 운동·영양 항목을 보여주되 소유하지 않는다. recovery 계획 자체에 `회복 러닝`의 거리 spec을 복사해 이중 정본으로 만들지 않는다. 계획 없는 사용자도 루틴/회복을 기록할 수 있도록 각 ledger의 존재/미존재를 명시한다.

## 9. 공통 Planner·주기·통계

Season/Wave/Phase/Block 계층과 현지 Day projection은 유지한다. 루틴은 계층을 하나 더 끼워 넣는 것이 아니라 선택된 날짜/세션/주기에 걸리는 재사용 조합이다. stretching은 training 레이어, 영양은 nutrition, 비운동 회복은 recovery 레이어로 표시한다. routine wrapper는 그룹 표시이며 그 자식과 중복 이벤트로 합산하지 않는다.

대시보드에는 오늘 예정된 루틴, 실제/미확인 단계, 회복 전략·다음 체크인, 최근 N일 분야별 실행을 표시할 수 있다. 스트레칭에는 같은 정의의 시간·빈도·좌우 coverage, 회복에는 행동 수행·관측·자기보고를 표시한다. rolling N-day와 Block의 필터는 공유하되 kg×reps·km·mL·수면·회복 행동 수를 같은 축으로 합치지 않는다.

통계는 행동 지표와 상태 지표를 분리한다. '필수 3단계 중 2단계 확인'은 실행률이고 회복률 67%가 아니다. 폼롤링/휴식/스트레칭 시간으로 전날 부하를 차감하거나 readiness를 자동 가산하지 않는다. '신호 없음' 역시 운동 허가가 아니다.

## 10. 코치·RAG·승인

### 10.1 도구 추가

| 도구 | 반환 / 권한 |
|---|---|
| `get_routine_context` | 선택 blueprint version·schedule·occurrence·run·누락/중단; 읽기 |
| `preview_routine_expansion` | 범위 안 생성 후보·충돌·참조·상대 시각; 비영속 계산 |
| `get_stretching_context` | 동작/좌우/계획/실제·보고·관련 러닝/보강; 읽기 |
| `get_recovery_context` | 전략·행동·관측·누락·기기 지표의 출처; 읽기 |
| `search_recovery_methods` | 권한 있는 method/자료 version·검토 상태·적용 맥락 |
| `project_integrated_adjustment` | 훈련·영양·회복·루틴 일정의 after 상태와 diff |
| `validate_integrated_candidate` | scope·실행 중/과거 항목·단위·충돌·근거·미확인 검사 |

사용자 선호·불편감·필수 제약은 기본 문맥에 포함한다. 실행/섭취/시간 합계는 계산 도구, 설명·문헌은 RAG, 해석은 가설로 구분한다. RAG의 방법별 검색에는 대상·운동 맥락·단기/장기 결과·검토 상태 필터를 추가한다. 자료가 부족하면 부족하다고 답하며 출처를 만들지 않는다.

질문 starter 예: '내일 훈련을 고려해 오늘 회복 선택지를 비교해줘', '지금 루틴 중 생략할 부분이 있을까?', '이 스트레칭을 어느 계획과 연결할지 검토해줘'. 질문 예시는 특정 방법의 효과를 보장하지 않는다.

### 10.2 통합 승인 계약

v0.2.2의 training/nutrition 한정 joint 계약은 legacy로 유지하고 새 schemaVersion에서 domain registry를 확장한다. candidate는 **명시한 write domain 목록**과 각 command, 실제 읽은 dependency manifest를 포함한다. plan head는 domain 하나당 한 값이 아니라 `(domain, aggregateId)`별로 식별해 여러 루틴 일정·계획을 구분한다. 읽는 영역과 수정하는 영역은 다를 수 있다.

승인 기준에는 해당 training/nutrition/recovery/routine_schedule의 현재 version 또는 미존재 조건, actual·run·catalog·선호·체크인·policy·conversation revision을 담는다. 현재 head가 없던 영역에 다른 작업이 생성한 경우에도 stale 충돌을 검사한다. 제안 digest는 branch 선택·변경 내용·기준 manifest를 포함한다.

같이 바뀌는 계획/전략/발생분, 승인 이력, outbox를 **하나의 DB transaction**으로 적용한다. 미래 routine wrapper만 옮겨 자식 계획을 남기거나 훈련만 바꾸고 회복·영양은 실패하는 반쪽 성공을 금지한다. 승인 재전송은 먼저 안정된 키로 같은 성공 결과를 조회하여 반환하고 새 버전을 중복 생성하지 않는다. 외부 LLM·기기 호출은 transaction 밖에서 수행한다.

일부만 승인하려면 새로운 범위·후보로 계산해 재확인한다. 직접 실제 행동/섭취/세트 기록을 남기는 것은 승인과 다른 command이고, 새 사실로 관련 제안을 무효화한다. 과거 실제와 시작된 실행의 콘텐츠는 계획 변경으로 재작성하지 않는다.

## 11. 프론트엔드 모듈·컴포넌트

```text
modules/routines/                # S31~33: blueprint·schedule·run orchestration
modules/supplementary/           # 기존 보강 + S34 stretching; 같은 동작/실제
modules/recovery/                # S35: 전략·방법·비운동 행동
experience/routine-kit/          # controlled steps·선택·timer UI·진행; 도메인 저장 모름
experience/planner-kit/          # 기존 event/layer/초안/탐색
experience/media-kit/            # 동작·방법 설명 영상/이미지
server/application/{routines,recovery}/
server/domain/{routines,recovery}/
server/application/supplementary/  # stretching profile adapter
server/{metrics,evidence,coaching,retrieval}/
```

`routine-kit`은 step renderer slot·timer·선택·진행 이벤트를 제공한다. 가짜 Activity를 생성하거나 승인 API를 직접 호출하지 않는다. `routines` 모듈은 각 도메인 공개 command를 orchestration하고 타 모듈 private store를 import하지 않는다. 별도 신규 UI 라이브러리를 필수로 추가하지 않고 기존 DnD·미디어·폼·timer 기반을 재사용한다.

주요 조합: `RoutineLibrary`, `RoutineBuilder`, `OccurrencePreview`, `RoutineRunner`, `StepOutcomeField`, `StretchingBrowser`, `SideHoldEditor`, `RecoveryStrategyBoard`, `RecoveryMethodCard`, `RecoveryLogForm`, `ReassessmentCard`. 이 이름들은 구현 위치의 제안이며 현재 컴포넌트가 존재한다는 의미가 아니다.

## 12. 반응형·접근성

[07](07_responsive_layout.md)의 `<768 / 768~<1280 / ≥1280 CSS px`와 container 폭 적응을 그대로 사용한다. 크기 변경으로 blueprint draft, 순서, branch 선택, 현재 step·좌우·timer·미전송 actual을 잃지 않는다.

| 화면 | 모바일 | 태블릿 | 데스크톱 |
|---|---|---|---|
| 라이브러리 | 검색+카드·필터 sheet | 목록+상세 | 목록·상세/사용 이력 |
| 루틴 builder | 단계별 editor와 전체 미리보기 전환 | 단계 목록+editor | 라이브러리+단계+일정 preview |
| 루틴 runner | 현재 단계·큰 조작 버튼·전체 순서 drawer | 순서+현재 단계 | 순서·현재 단계·기록 panel |
| 스트레칭 | 동작 card·영상/텍스트 전환·좌우 실제 입력 | 목록+설명/수행 | 필터·설명·계획/실제 |
| 회복 | 오늘 전략·행동·다음 확인을 세로 배치 | 전략+관측 | 관측·전략 비교·실행/코치 |

원형 timer는 남은 시간, 진행 ring은 확인된 단계를 나타낸다. 같은 ring에 회복 점수·부하를 섞지 않는다. screen reader에 매초 남은 시간을 읽히지 않고 시작/일시정지/완료 알림과 요청 시 값 읽기를 제공한다. haptic/audio·화면 유지 기능은 지원 capability와 명시 설정을 확인하고 동작을 보장하지 않는다.

현재 동작/좌우 변경·중단 버튼은 hover에 숨기지 않는다. 영상이 없어도 텍스트 설명을 읽을 수 있고 실행 중 언제든 멈출 수 있어야 한다. background/foreground, OS 시각 변화, 두 기기 동시 수정에서 timer와 실제 log의 revision을 구분해 충돌을 처리한다.

## 13. API 초안

| API | 의미 |
|---|---|
| `GET/POST /v1/routines` | 루틴 목록/초안 생성; 아직 일정 적용 아님 |
| `POST /v1/routines/:id/versions` | 변경한 blueprint의 새 version |
| `POST /v1/routines/:id/schedule-previews` | 유한 발생분·중복·연결 도메인 preview |
| `POST /v1/routine-schedules/:id/change-previews` | 미래 범위 pause/resume/change 영향 |
| `POST /v1/routine-runs` | 승인 occurrence 또는 명시된 비계획 실행 시작 |
| `POST /v1/routine-runs/:id/step-records` | 도메인 실적 command/검증된 기존 actual 연결과 진행 갱신 |
| `POST /v1/routine-runs/:id/revisions` | 진행·선택·중단 정정, 동시성/멱등성 |
| `GET /v1/exercises?family=stretching` | 기존 동작 catalog 전문 조회 |
| `POST /v1/executions/:id/stretch-logs` | 기존 canonical Activity의 스트레칭 실제 상세 |
| `GET /bff/v1/recovery` | 관측·전략·행동·데이터 충족도 조합 |
| `GET /v1/recovery/methods` | source/review 있는 방법 목록 |
| `POST /v1/recovery/strategy-drafts` | 회복 목적·선택지·계획·재평가 초안 |
| `POST /v1/recovery/action-logs` | 비운동 실제 행동 확인 |
| `POST /v1/recovery/action-logs/:id/revisions` | 실제 정정·원문 version·집계 무효화 |
| `POST /v1/proposals/:id/approve` | 새 schema의 통합 계획 적용; 기존 endpoint 유지 |

목록/기록의 CRUD에는 소유권·pagination·삭제·보관·내보내기 API도 필요하다. 이 표는 경로·의미 초안이며 완성 OpenAPI·DB migration·임의 provider writeback 기능이 아니다. method 이름의 `POST`만으로 중복이 방지되지 않으며 idempotencyKey·revision을 검사한다.

## 14. 프라이버시·오류·품질

전후 체감·불편감·수면·회복 방법 선택은 개인 데이터다. 확인된 사실·AI 추정·사용자 입력을 구분하고 coach 사용 동의/필수 안전 제약을 함께 다룬다. 콘텐츠·로그·미디어·캐시·개인 기억·인용의 삭제와 사용 철회를 적용한다. 원본 reference가 사라지면 삭제 표시를 하고 이전 민감 발췌를 다시 노출하지 않는다.

없는 기록은 0/미실시가 아니며, 높은 루틴 이행률은 건강 상태가 좋다는 증거가 아니다. 오류 상태는 unresolved anchor, missing content, stale plan, sync pending, unavailable method, needs_review를 구분한다. 실패 시 actual을 지우거나 루틴 전체를 완료로 처리하지 않는다.

휴식·스트레칭·수면 계획의 행동을 기록하는 기능과, 효과를 검증해 개인에게 처방하는 기능은 별개의 완료 조건이다. 기능 설계만으로 의학적 안전성/부상 예방/빠른 회복을 주장하지 않는다.

## 15. 개발 순서·완료 기준

M0에서 루틴 원장 분리·유한 전개·중복·anchor·선택·통합 승인·timer 계약을 확정한다. M1b의 영양/보강 수동 core 다음에 **M1c 루틴·스트레칭·회복의 수동 core**를 연결한다. M2에서 검토된 콘텐츠·RAG·코치 후보 비교를 확장한다. Native lifecycle은 M3의 실기기 gate다. 새로운 기능을 문서에 등록한 것을 production 구현으로 표시하지 않는다.

FUT-13(범용 루틴), FUT-14(스트레칭), FUT-15(회복 전략)를 FUT-01/02/06/08/10/11/12와 연결한다. 기능 요구·수용 테스트는 [05 §11](05_implementation_requirements.md#v023-requirements)을 따른다. 세부 책임과 미완료 fallback은 [06](06_follow_up_backlog.md)에 기록한다.

대표 완성 시나리오: `기존 러닝·보급·보강을 포함한 루틴 만들기 → 기간 미리보기 → 명시 승인 → 스트레칭 일부 수행/실제 섭취/회복 보고 → 중단 원인과 최신 정보 확인 → 휴식을 포함한 다음 전략 비교 → 연결된 미래 계획의 통합 변경 승인 → 과거 실제는 보존`.

이번 제공 파일은 설계 문서와 [타입 계약 초안](extensions-v023.contracts.ts)이다. UI/서버/native 구현, 알림 전송, 새 RAG 색인·검색, 실제 루틴 timer, 생리학적 검증은 수행하지 않았다. TypeScript 컴파일·문서 정합성 점검은 이들 기능 시험의 대체가 아니다.
