# 01 · 제품 및 화면 기획 v0.2.3

> v0.2.3 · 2026-09-16: [09 루틴·스트레칭·회복 전략](09_routines_stretching_recovery.md)과 S31~S35, FUT-13~15, V023 요구·시험을 추가했다. 기존 계약·이력은 유지하며 신규 기능은 아직 미구현이다. 아래 이전 버전 설명은 당시 기준이며 새 범위는 09와 05 §11을 따른다.

> v0.2.2: 반응형 계약을 [07](07_responsive_layout.md)로 구체화하고 영양·보강훈련 S25~S30을 [08](08_nutrition_supplementary_training.md)에 추가했다. 문서·계약 보완이며 기존 프로토타입에는 새 기능을 적용하지 않았다.

기준일 2026-09-16 · 검토 가능한 초안 · 임시 제품명 **WAVE / 웨이브** (상표·도메인 확인 전)

## 1. 제품 정의와 변경점

기존 계획, 실제 수행, 주관적 체크인, 허가된 기기 지표와 자료를 연결해 **어떤 훈련 목적을 보존하고 무엇을 바꿀지** 상담하는 서비스다. LLM이 맥락 해석·분석 선택·전략별 후보를 주도하며, 실제 계획 변경은 검증된 후보의 사용자 승인으로만 반영한다.

v0.1의 EvidenceSnapshot → Decision → Proposal → PlanVersion 계약은 유지한다. 이번 변경은 다음과 같다.

| 항목 | v0.1 | v0.2 |
|---|---|---|
| UI 범위 | 일별 계획·기록 중심 | 전체 MVP 화면군과 WebView 독립 모듈 계약 |
| 계획 기간 | 가변 Block | Season/Plan → Wave → Phase → Block → Day view → Session |
| Garmin | 후속 외부 연동 | **주 입력 경로**. 승인·entitlement 확보가 연동 출시 조건 |
| Apple | 파일 확장 검토 | Native HealthKit 수집기 + 자체 ingestion. 순수 웹만으로 자동 수집하지 않음 |
| 지표 | 결정론적 합계 | 기기 점수·사용자 보고·자체 부하 추세를 출처별 분리 |
| 지식 | 소수 원칙 문서 | 사용자 resources archive + 권한/버전/근거 위치가 있는 RAG |
| 디자인 | 기본 표 | Alpine Mist glass, Aurora 변형, Orbit 탐색, 정밀한 상호작용 |

요청한 화면들을 모두 **MVP 전체 범위**에 둔다. 구현 순서상 M1/M2/M3로 나누지만 gallery·resources·course planner를 설명 없이 범위 밖으로 미루지 않는다. Apple 자동 수집까지 최초 출시 필수라면 M3의 native companion도 MVP 출시 조건에 포함해야 한다. Web-only 공개판은 Apple 자동 수집 미지원 상태를 명확히 표시한다.

## 2. 정보 구조

상위 내비게이션: **오늘 / 계획 / 활동 / 탐색 / 코치**.

탐색/더보기에는 코스, 대회·기록, 갤러리, 자료실과 영양·보강훈련을 둔다. 오늘과 Planner에도 영양·보강 quick action을 제공한다. 프로필 메뉴에는 계정, 연결 계정, 동기화 센터, 환경 설정을 둔다. 모바일 하단은 오늘·계획·활동·코치·더보기의 5개 목적지만 유지한다. 주요 객체는 URL로 직접 접근 가능해야 한다. 메뉴 위치와 URL의 존재를 같은 것으로 취급하지 않는다.

전체 shell의 전역 요소는 사용자/기간 전환, 데이터 최신성, 알림, 전역 검색, 코치 launcher, 공통 command menu다. 긴 페이지에도 현재 선택한 계획 기간과 초안 상태가 유지된다.

## 3. 화면 목록과 URL 계약

| ID | 화면 / URL | 주요 업무 | 구현 묶음 |
|---|---|---|---|
| S01 | 인증 `/auth/login`, `/signup`, `/recover` | 로그인·가입·재인증·계정 복구 | M1 |
| S02 | 온보딩 `/onboarding` | 목표·일정·기준선·연동·AI 전달 동의 | M1 |
| S03 | 대시보드 `/dashboard?window=10&anchor=...` | 오늘, 현재 블록, rolling N-day, 변경 대기 | M1 |
| S04 | 기간 탐색 `/plans/:planId/periods/:periodId?view=orbit` | Wave/Phase/Block 탐색과 기간 목표 편집 | M1 |
| S05 | 통합 계획 `/planner?from=...&to=...&view=split` | 달력+표+타임라인, 계획·실제 편집 | M1 |
| S06 | 세션 편집 `/sessions/new`, `/:id/edit` | 목적·단계·잠금·연결 코스·버전 | M1 |
| S07 | 활동 목록 `/activities` | 검색·필터·정렬·선택·삭제·품질 | M1 |
| S08 | 활동 입력 `/activities/new`, `/:id/edit` | 수동 기록·업로드 fallback·정정 | M1 |
| S09 | 활동 상세 `/activities/:id?tab=overview` | 분석·구간·지도·impact·미디어·출처 | M1 |
| S10 | 코치 `/coach/:threadId?` | 대화, 맥락 선택, 도구 상태, 자료 근거 | M1 |
| S11 | 제안 검토 `/proposals/:id` | 후보 비교·변경 전후·승인·거절 | M1 |
| S12 | 회복·체크인 `/wellbeing` | 피로/불편감 보고·기기 지표·추세 | M1 |
| S13 | 코스 목록 `/courses` | 개인 코스 CRUD, GPX, 즐겨찾기 | M2 |
| S14 | 경로 편집 `/courses/new`, `/:id/edit` | 지도 waypoint·보행 경로·고도·저장 | M2 |
| S15 | 대회 관리 `/races`, `/:id` | 목표 대회·우선순위·일정·코스 | M2 |
| S16 | 기록 관리 `/records` | 공식/수동/기기 기록·PB·연결 활동 | M2 |
| S17 | 미디어 `/gallery`, `/:assetId` | 사진·동영상·앨범·활동 연결 | M2 |
| S18 | 자료실 `/resources` | 업로드·URL·태그·검색·RAG 포함 | M2 |
| S19 | 자료 읽기 `/resources/:id` | 본문·주석·버전·출처·인용 위치 | M2 |
| S20 | 연결 관리 `/connections`, `/connections/:provider` | Garmin OAuth·Apple capability·철회 | M1/M3 |
| S21 | 동기화·품질 `/sync`, `/sync/conflicts/:id` | 작업·재시도·중복·시간대·매칭 정정 | M1 |
| S22 | 계정 `/account`, `/privacy` | 인증·세션·내보내기·삭제·동의 | M1 |
| S23 | 환경 설정 `/settings` | 테마·단위·주 시작·rolling 창·접근성 | M1 |
| S24 | 알림·이력 `/inbox`, `/decisions` | 승인 요청·재평가·과거 결정·작업 결과 | M1 |
| S25 | 영양 대시보드 `/nutrition` | 오늘·주기 영양 계획/실제·수분·팁·질문 | M1b/M2 |
| S26 | 영양 계획 `/nutrition/plans/:id` | 식사·전/중/후 보급·상대 시각·승인 | M1b |
| S27 | 섭취 기록 `/nutrition/logs`, `/new`, `/:id/edit` | 수량·단위·source·부분 실제·정정·삭제 | M1b |
| S28 | 보강·루틴 `/supplementary`, `/supplementary/routines/:id` | 루틴 생성/편집/배치, 목적·장비·세트 | M1b |
| S29 | 동작 라이브러리 `/supplementary/exercises`, `/:id` | 계열·장비·설명·미디어·검토된 자료 | M1b/M2 |
| S30 | 보강 수행 `/supplementary/sessions/:id/perform` | 실제 set·휴식 timer·부분/중단·수정 | M1b |
| S31 | 루틴 라이브러리 `/routines` | 혼합 루틴 검색·필터·생성·복제·version·보관·삭제 | M1c |
| S32 | 루틴 상세·편집·배치 `/routines/:id`, `/:id/edit`, `/:id/schedule` | 단계·순서·선택 그룹·상대 시각·유한 일정 preview/승인 | M1c |
| S33 | 루틴 실행·회고 `/routine-runs/:id` | 단계 진행·실제 기록 연결·중단·동기화·회고 | M1c |
| S34 | 스트레칭 `/stretching`, `/stretching/exercises/:id` | 공통 동작 catalog의 전문 보기·계획·좌우/시간·실제·코치 | M1c |
| S35 | 회복 전략 `/recovery`, `/recovery/strategies/:id` | 오늘·전략·방법·실행 기록·재평가 | M1c/M2 |

route query는 기간/검색/정렬/선택 등 공유 가능한 상태만 포함한다. 비밀값·토큰·건강 보고 자유문은 URL에 넣지 않는다. 모듈의 route는 app router에서 매핑하며 모듈 내부가 Next router에 의존하지 않는다.

## 4. 대시보드 상세

### 4.1 데스크톱 구성

상단 인사와 기준 날짜 아래 **현재 계획 / 실제 수행 / AI 제안** 상태를 분리한다. 왼쪽 넓은 영역은 오늘 세션, Orbit 기간 탐색, 최근 N일 부하와 계획 이행, 가까운 일정이다. 오른쪽은 최신 체크인·제공자 지표·코치 제안 패널이다. 사용자가 widget 순서와 크기를 조정할 때만 layout edit mode를 연다. 평소 스크롤 중에는 drag handle을 활성화하지 않는다.

### 4.2 Rolling N-day

기본 10일, 빠른 선택 7/10/14/28일, 설정 가능한 3~90일을 **UI 범위 초안**으로 둔다. 이는 훈련 처방 주기가 아니다. 기준일 포함 N개 현지 달력 날짜를 정확히 표시하고, 최근 N×24시간과 혼동하지 않는다. 기본 비교는 바로 앞의 같은 길이 창이다. 데이터가 불완전하면 전기 대비 증감을 확정적으로 표시하지 않는다.

표시 후보: 실제 거리·시간, 등록된 session-RPE 부하, 고강도 분류 횟수(분류 근거 포함), 계획/실제 차이, 체크인 존재 일수. 거리와 시간의 축을 혼합하지 않는다. 목표는 범위일 수 있으며 달성률을 100% 초과로 과장 보상하는 인터랙션은 사용하지 않는다.

### 4.3 데이터와 동작

DashboardReadModel에 planVersion/dataRevision, 기간 선택, metric 정의·출처, upcomingSessions, proposalSummary, connectionFreshness를 포함한다. 카드 클릭은 상세 정보 또는 필터가 적용된 목적 화면으로 이동한다. 연결 끊김 상태에서도 마지막 유효 데이터의 관측 시각을 표시한다. 데이터가 없으면 예시 값을 개인 데이터인 것처럼 채우지 않는다.

## 5. 계획 단위와 Period Explorer

논리 구조는 다음과 같다.

`Season/Plan → Wave → Phase → Block → Day projection → Session(s) → Workout steps`

Season은 한 목표 시즌의 컨테이너로 제안한다. Wave/Phase/Block은 각각 ID·시작/끝·목적·우선순위·수정 가능한 제약을 가진다. Day는 독립적으로 소유권을 갖는 훈련 주기라기보다 현지 날짜별 projection이다. 하루 여러 세션, 휴식, 시간 미정, 이동 중 시간대 변화를 지원한다.

이전 대화에서 사용한 10일 Block을 기본 템플릿으로 두되 길이를 강제하지 않는다. 20~30일 Phase나 약 60일 Wave는 가능한 예일 뿐 고정 규칙이 아니다. 마지막 4일 같은 잔여 기간은 부분 Block으로 표시하거나 명명된 전환 Block으로 둔다. 달력 주간·rolling 창은 별도 조회 lens이며 기간 트리의 노드로 만들지 않는다.

공유 링크의 제목은 확인했으나 본문은 회수하지 못했다.[S36](sources.md#s36) 따라서 과거 대화에서 보인 특정 W1/W2/W3 길이나 A/B/C 계획 날짜를 이번 계획의 정본으로 자동 이식하지 않는다.

### 5.1 Orbit interaction

중앙은 현재 선택한 부모 기간의 이름·기간·목적이다. 주변 sector는 자식 기간을 나타낸다. 기본 sector 각도는 **날짜 길이**에 비례하고 별도의 바/텍스트가 수행량을 나타낸다. 각도가 훈련량인 것처럼 보이지 않도록 범례를 고정한다. 원형은 탐색 용도이며 달력/표는 정밀 편집 용도다.

클릭·Enter로 자식으로 들어가고 중앙 back/breadcrumb로 부모로 돌아간다. hover/focus는 미리보기만 하며 이동이나 선택을 실행하지 않는다. 키보드는 이동 가능한 자식 목록과 동일한 결과를 가져야 한다. 좁은 sector는 번호와 옆 목록을 이용한다. Wave→Phase→Day 빠른 탐색은 가능하지만 Block 소속을 생략 저장하지 않는다. Phase의 달력으로 이동하는 버튼은 실제 child 조회가 아닌 view lens 변경이다.

### 5.2 기간 상세

헤더는 목적·기간·주요 대회·핵심 세션·버전, 본문은 Orbit/타임라인/달력/표 전환, 하단은 계획·실제 집계와 변화 이력이다. 기간 날짜를 옮길 때 자식 세션 자동 이동 여부를 확인하고, 완료 세션은 고정한다. 임의 드래그로 전체 트리를 재작성하지 않는다. sibling 기간 겹침·parent 바깥 날짜·미배정 일자를 검증한다. scenario A/B/C 비교는 별도 계획 버전/branch이며 intensity A/B/C와 다른 필드다.

## 6. 통합 Planner와 세션 편집

S05는 가용 module container가 충분한 데스크톱에서 달력 40% + 표 60%의 split view를 우선한다. 태블릿은 보기 전환, 모바일은 날짜 agenda를 기본으로 하며 실제 container 폭과 최소 pane 폭에 따라 전환한다([07](07_responsive_layout.md)). 두 view는 같은 selection/dateRange/draft를 쓴다. 달력에서 세션을 선택하면 표의 같은 행과 상세 패널이 선택된다. 표에서 날짜를 바꾸면 달력 draft 위치가 바뀐다.

표 열: 날짜·주기·계획 종류·목적·거리/시간 범위·강도·실제 수행·차이·상태·메모. column pinning/visibility/sort, 범위 선택, virtual scroll을 지원한다. 원본/승인/초안/AI 제안을 서로 다른 semantic badge와 변경 마커로 구분한다.

DnD는 **초안만** 변경한다. 날짜 이동, 세션 복제, 길이 조절 후 변경 요약과 undo를 제공한다. move-to-date 메뉴와 숫자 편집이 항상 대안으로 있다. 시간 미정 세션의 drag는 날짜만 바꾸며 거리에서 소요시간을 몰래 산출하지 않는다. 다른 Block으로 이동하면 목적과 제약을 다시 검사한다. 달력에 이미 지나간 세션을 끌어 놓으면 과거 기록 정정 경로를 안내한다.

S06 필드: 제목, 종목, 날짜/시간/시간대, 주기, 목적, 중요도, 워밍업·반복·회복·쿨다운, 거리 또는 시간, intensity label/pace/HR target, 코스, 참석/시간/강도 lock, 메모. 단계의 단위 전환은 확인 후 변환한다. 저장은 draft→preview→commit, AI도 동일 도메인 연산을 사용한다.

## 7. Activities CRUD 및 상세

### 7.1 목록과 편집

S07은 검색·날짜·종목·출처·주기·품질 필터와 table/card view를 제공한다. 대량 동작은 로컬 태그·계획 연결·export·삭제만 명시적으로 지원한다. 로컬 삭제는 Garmin 실제 활동 삭제가 아니다. 동기화가 삭제한 항목을 재생성하지 않도록 suppression/tombstone 정책을 제공한다. 계정 완전 삭제와 활동 숨김의 보존 조건은 다르다.

S08 수동 입력은 제목, 시작 시각/시간대, duration 종류, 거리, 체감 RPE, 계획 연결, 메모다. 가져온 데이터 편집은 원본을 덮어쓰지 않고 overlay revision과 변경 사유를 남긴다. 거리 0/미측정/null, timer/elapsed/moving time을 구분한다. 자동으로 연결된 계획은 사용자가 정정할 수 있다.

### 7.2 상세 레이아웃

S09 상단은 출처·관측 시각·정정 여부와 거리/시간/페이스/심박 요약이다. 본문 탭은 **개요 / 구간 / 경로 / 영향 / 미디어 / 출처**다. 큰 그래프와 지도는 데스크톱 split-pane, 모바일은 개별 탭으로 lazy mount한다.

차트에서 구간을 선택하면 지도 경로와 lap table의 동일 시간 범위가 강조된다. 커서 상태는 shared selection store에만 두고 매 움직임을 전역 서버 상태로 저장하지 않는다. GPS 끊김은 점선/갭으로 표현하고 직선을 달린 실제 경로로 해석하지 않는다. 실내·GPS 없는 기록은 경로 탭을 설명과 함께 비활성화한다.

영향(impact)은 다음을 분리한다.

| 종류 | 의미 |
|---|---|
| 관측·계산 | 해당 Block의 거리/시간에 기여한 양, 계획 대비 차이, 보고한 RPE |
| 분류·추정 | 목적/강도 분류와 그 출처·불확실성 |
| 상담 | 향후 계획에서 검토할 항목과 관련 제안 |

“이번 활동 때문에 부상 위험이 12% 증가” 같은 검증되지 않은 인과 수치는 표시하지 않는다. 분모가 불완전하면 기여율 대신 부분 합계로 표시한다.

## 8. 코치, 제안, 회복

S10 코치는 thread 목록 + 대화 + 선택 가능한 evidence drawer를 갖는다. 사용자는 다음 세션/Block/Phase 검토 scope와 포함할 자료 범위를 확인할 수 있다. 필수 사용자 제약을 대화 화면에서 제외할 수는 없다. 도구 진행은 “활동 구간 비교 중 / 자료 검색 중 / 후보 검증 중”처럼 사용자 의미로 보여주고 숨겨진 모델 사고 과정은 노출·저장 요구하지 않는다.

제안 카드에는 상태, 기반 버전, 전략, 보존한 목적, 변경 요약, 근거, 미확인 정보, 다시 판단할 조건을 표시한다. provisional streaming 텍스트로 승인 버튼을 만들지 않는다. assistant-ui는 대화 renderer 후보이며 제안의 정본은 서버다.[S26](sources.md#s26)

S11은 원안과 2~4개의 실제로 다른 후보를 비교한다. 후보 개수는 최소 채우기 조건이 아니다. 변경 전후 달력+표, 수치 영향, validation error/warning/unknown을 표시한다. stale이면 승인 비활성화 및 다시 검토. 부분 승인 요청은 새 후보로 분리해 재검증한다. 새 원장 버전은 명시 승인 후에만 나타난다.

S12는 “종합 점수 하나”보다 제공자 지표·주관적 피로/불편감·최근 부하·데이터 충족도를 나란히 보여준다. 사용자가 보고하지 않은 통증을 0으로 그리지 않는다. 증상·부위 기록은 상담 정보이며 진단 화면이 아니다. 점수 methodology drawer에서 원본 값·범위·기준 시점·정의·제한을 확인한다.

## 9. Courses, Race, Records

S13 코스 카드에 지도 썸네일, 실제/추정 거리, 고도 데이터 출처, 노면 정보의 확인 상태, 접근성 메모, 마지막 사용을 표시한다. 활동의 실제 track에서 새 코스를 만들 수 있으나 원본 track과 planned course는 다른 엔터티다.

S14 지도 편집은 검색→시작/경유/도착 지점→foot profile routing→고도/거리 확인→저장이다. 왼쪽 waypoint list의 drag와 이동 버튼은 같은 상태를 편집한다. undo/redo, 왕복/loop 초안, GPX import/export, 경유점 잠금, 장소 검색을 제공한다. MapLibre는 지도 렌더러이며 routing·geocoder·tiles·elevation은 별도 provider다.[S22](sources.md#s22) [S23](sources.md#s23)

경로 계산 불가 상태에서 직선 연결은 **미계산 초안**으로 표시한다. 이를 보행 가능한 코스나 실제 거리로 확정하지 않는다. 지도에서 보인 경로가 안전·통행 허가를 보장하지 않는다. 정확한 시작·끝 위치 공유에는 privacy trim/확인 화면이 필요하다. 공개 tile 서버의 quota/정책을 production 계획에서 별도로 처리한다.[S24](sources.md#s24)

S15 대회는 날짜, 거리 종류, 목표 우선순위, 장소/시간대, 참가 상태, 공식 URL, 코스, 목표 기록, 연결 Plan을 관리한다. 공식 일정 자동 수집은 MVP 필수로 가정하지 않고 사용자 등록부터 지원한다. 대회 날짜 변경은 관련 계획 영향 preview와 별도 승인을 요구한다.

S16 기록은 race result와 training best를 분리한다. chip/gun time, 공식 거리/기기 거리, 인증·수동 입력 출처, 날씨 메모, 활동 연결을 둔다. PB 계산에 포함할 기록 기준을 사용자에게 보인다. 기기 추정 10km split을 공식 대회 PB로 자동 승격하지 않는다.

## 10. Gallery, Resources

S17 사진·동영상 grid, 앨범, 날짜·활동·코스 filter, swipe viewer, 자막/재생 속도/전체 화면, 파일 업로드·삭제를 지원한다. 기본 공개 범위는 private. EXIF 위치 제거 옵션, thumbnail 생성, orientation, video transcoding/status, signed URL, 삭제 파생물 처리를 설계한다. 실제 media decoding은 native/브라우저 차이를 시험한다. 사용자 파일을 AI에 보내는 동의는 gallery 열람과 별도다.

S18 resource는 논문/가이드/개인 메모/대회 자료 등 분류, source/author/year/language/tag, ingestion 상태, **코치에 사용 여부**를 표시한다. 별표와 RAG 포함은 다른 상태다. PDF/Markdown/지원 URL/text를 입력하고 media transcript는 명시 허용된 자료만 지원한다. 단순 파일 업로드 성공을 검색 가능으로 표시하지 않는다.

S19 reader는 원문·파싱 본문·요약·인용·버전 탭, 문단/page/time locator, 하이라이트·주석을 제공한다. AI 요약은 원문이 아니다. 특정 코치 답변의 인용을 누르면 그 당시 resource version의 해당 위치를 연다. 권한 철회/삭제된 문서는 재노출하지 않고 인용이 더 이상 열람 불가임을 표시한다. 보존·삭제 요구에 따라 대화의 발췌도 제거한다.

## 11. Account, Connections, Sync, Settings

S20 Garmin 화면의 “연결”은 Garmin ID/password 입력 폼이 아니라 공식 OAuth로 이동하는 버튼이다. 연결 계정 마스킹, 승인 범위, available metrics, 마지막 성공, backfill 상태, 재연결/철회, 데이터 삭제 선택을 제공한다. 사업자 API 승인 미확보 상태는 사용자의 비밀번호 입력으로 우회하지 않는다.[S05](sources.md#s05) [S06](sources.md#s06)

Apple 화면은 일반 웹에서 native companion 필요를 표시하고, 앱에서 HealthKit 유형별 요청과 native sync 상태를 보여준다. Sign in with Apple과 건강 접근 동의를 혼동하지 않는다. 읽기 권한 거절 여부를 앱이 확실히 판별할 수 없는 제약에 맞춰 “접근 가능한 데이터 없음”을 사용한다.[S08](sources.md#s08)

S21 동기화 센터는 provider별 live/backfill/failed/revoked, cursor, last event·last successful import, 중복 후보, 필드 품질, 분리/병합 확인을 관리한다. 세션에 주석을 덧붙일 때 provider 원본은 변경되지 않는다. 이미 숨긴 source ID 재수신을 silent reimport하지 않는다.

S22 계정 인증/active sessions/재인증, 계정·건강·위치·AI 사용 동의, export, 삭제 진행을 제공한다. 연결 철회와 계정 삭제는 다른 destructive action이다. AI 제공자에게 보내는 정보와 목적은 별도로 안내·동의받는다.[S12](sources.md#s12)

S23 테마(Alpine Mist/Aurora), 투명도 줄이기, motion 줄이기, hover 상세 정도, 기본 N, 단위, 주 시작 요일, 시간대, 숫자 정밀도, 차트 접근성, 알림을 관리한다. 조작 성능 저하 시 solid surface로 내려도 기능은 동일하다.

S24 inbox는 actionable 카드 중심이다. 새로운 기록 도착과 계획 승인 요청을 구분하고 mute한 알림이 최신성 검사를 해제하지 않게 한다. 결정 이력에서 누가·어떤 기준·어떤 후보를 적용했는지 확인한다.

## 12. 공통 상태 계약과 추가 발굴

모든 화면은 loading skeleton, empty with CTA, partial/stale, offline, denied, unsupported, validation error, conflict, success, cancelled 상태를 정의한다. 사용 불가와 정상 0을 같은 placeholder로 처리하지 않는다. 자동 동기화 실패는 오래된 데이터 badge로 연결한다. 편집 이탈 전 경고와 draft 복구를 제공한다.

추가로 필요한 MVP 기능은 목표/제약 설정, 체크인, 동기화 품질 센터, 제안 검토, 결정 이력, 데이터 삭제·export다. 신발/장비 수명, 훈련 템플릿 마켓, 소셜 feed, 코치 다중 사용자 협업, 자동 race scraping은 다음 범위로 제안한다. 필수 기능의 검증 전에 이들을 MVP에 계속 누적하지 않는다.

## 13. 제품 성공 기준

주 지표는 추천 승인율만이 아니다. 업로드/자동 동기화 성공·신선도, 근거 추적 가능률, 좋은 후보 포함 여부, 질문의 필요성, 유효한 변경 완료, 승인 충돌 방지, 접근성 핵심 경로 완료, 사용자가 이해한 불확실성, 장기 사용 지속을 측정한다. 개인 기록 향상·부상 감소 인과 효과는 별도 연구 전 제품의 입증된 성과로 주장하지 않는다.

## 14. v0.2.2 영양·보강 통합

v0.2.2 당시 화면 범위는 S01~S30이었다. v0.2.3 현재 범위는 S01~S35다. 기존 화면의 actual·planned·draft·proposal 분리는 새 도메인에도 그대로 적용한다. S03은 오늘의 영양/보강 quick log와 요약, S04/S05는 주기 목표와 혼합 timeline, S06은 supplementary workout editor, S07~S09는 보강 actual과 세트·영양 연결 탭, S10/S11은 joint coaching/approval을 지원한다.

모든 기기에서 기능을 유지하고 representation만 조정한다. 명세는 [07](07_responsive_layout.md)·[08](08_nutrition_supplementary_training.md), 구현 상태는 [FUT-10~12](06_follow_up_backlog.md#fut-10)를 따른다. 아직 계획 문서·타입 초안만 있으며 실제 prototype 화면을 추가하지 않았다.

## 15. v0.2.3 루틴·스트레칭·회복 전략 통합

현재 MVP 화면군은 **S01~S35**다. 루틴은 일정·활동을 복제 저장하는 별도 원장이 아니라 재사용 콘텐츠·유한 배치·실적 링크의 조합이다. 기존 S28은 운동 루틴 콘텐츠, 신규 S32는 운동·영양·회복을 묶는 조합 editor다. S34는 supplementary 모듈 하위 화면으로 같은 ExerciseDefinition/SetLog를 사용한다. S12의 관측·체크인과 S35의 회복 계획·행동도 분리한다.

S03에는 오늘 루틴·회복 전략·다음 확인, S05에는 routine grouping과 stretching/training·nutrition·recovery layer, S09에는 같은 Activity의 상세 기록을 추가한다. S10/S11은 휴식안과 연결된 미래 계획 변경을 검토한다. 행동 수행률을 회복 점수로 표시하지 않는다.

루틴 라이브러리 → 유한 일정 preview → 승인 → 단계별 실제 확인 → 누락·중단·변화 확인 → 코치 재검토 → 새 승인 계획의 흐름을 지원한다. 정확한 화면·입력·권한·상태는 [09](09_routines_stretching_recovery.md)에 정의했다. 이번에 프로토타입에 5개 화면을 구현한 것이 아니다.
