# 변경 이력

## v0.2.3 · 2026-09-16 · 루틴·스트레칭·회복 전략

### 추가

- 09 명세: 루틴 콘텐츠/유한 일정/실행 분리, 선택 그룹·반복·중단·기록 링크, 스트레칭 전문 보기, 회복 전략·방법·실제·관찰.
- S31~S35, FUT-13~15, V023-F01~18과 V023-A01~36.
- extensions-v023.contracts.ts: 루틴·스트레칭·회복·다영역 승인 schemaVersion=4 타입 초안.
- qa/v023-acceptance-plan.json: 실행 전 수용 테스트 계획. qa/document-v023-checks.json: 실제 수행한 문서/타입 점검 기록.

### 수정

- 01~08: 현재 범위·모듈·반응형·지표·RAG·Planner·승인의 연결, M1c 구현 단계.
- 기존 운동 RoutineTemplateVersion과 범용 RoutineBlueprintVersion을 구분하고 원장 재사용을 명시.
- contracts.ts: ModuleId의 routines/recovery 추가. stretching은 supplementary 내부 화면.
- README: 현재 읽기 순서·상태·코드/시험 경계.

### 보존·미수행

v0.2.2 파일/ZIP 원본, 기존 V2/V022 요구·시험 행과 FUT-01~12를 보존한다. prototype·이미지·CSS·반응형 JSON·기존 공유 함수·v022 타입·sources·기존 QA는 유지한다. 신규 UI/서버/native/알림/RAG를 구현하지 않았고 새 기능/호환성/생리학 시험을 수행하지 않았다. 과거 smoke 검사를 다시 실행하지 않았다. 문서·타입 점검 결과를 제품 기능 검증으로 표시하지 않는다.


## v0.2.2 · 2026-09-15 · 반응형·영양·보강 설계 보완

### 추가

- 07 반응형 명세와 responsive-spec.json: 세 layout mode, container, 화면별 배치, 상태·접근성·시험 조건.
- 08 영양·보강 명세: S25~S30, 계획/실제·단위/출처·세트·통합 코칭과 원자 승인.
- extensions-v022.contracts.ts: 영양/보강/joint basis 타입 초안.
- sources-v022.md: 이번 보완의 표준·검토 참고 자료와 확인 범위.

### 수정

- 01~04: 화면·모듈·디자인·지표/RAG 연결; viewport 768/1280 기존값 유지.
- 05: M1b, V022-F01~18 / V022-A01~36. 기존 V2 요구/시험 행은 유지.
- 06: FUT-10/11/12, 기존 백로그와 연결; v0.2.2 Web MVP 범위.
- contracts.ts: ModuleId에 nutrition/supplementary를 추가.
- README: 최신 문서 읽기 순서와 정확한 구현·검사 상태.

### 유지·미수행

기존 prototype·이미지·prototype-results·design-tokens·shared-domain·sources는 보존한다. production UI/React/서버/native·외부 API를 구현하거나 미완료 상태를 완료로 바꾸지 않았다. 새로운 앱 반응형/E2E·영양/보강 기능·생리학 검증은 미수행이다. 추가 타입 컴파일·JSON 및 문서 정합성 검사는 이들 기능 검증의 대체가 아니다.


## v0.2.1 · 2026-09-15 · 문서 보완

### 추가

- `06_follow_up_backlog.md`: FUT-01~FUT-09, 상태 기준선, 착수 조건, 확장 지점, 완료 기준, 실패·대체 동작, 의존성, 공개 조건, 티켓 양식.
- `README.md`: 문서 읽기 순서와 기존 산출물의 실제 범위.
- 이 변경 이력.

### 수정

- `05_implementation_requirements.md`: 문서 버전·변경 범위 안내, §9 후속 백로그 연결.
- 기존 §8의 `qa/QA.md` 참조를 실제 포함된 `qa/prototype-results.json`으로 정정. 기존 기록이며 이번 실행 결과가 아님을 명시.

### 유지

- 기존 M0~M3 계획, V2-F01~F36 요구사항, V2-A01~A50 수용 테스트 ID와 내용.
- 01~04, sources, TypeScript 예제, CSS, HTML 프로토타입, 기존 QA JSON·이미지의 파일 내용.
- 실제 기능·외부 승인·원문 이식·검증의 미완료 상태.

### 하지 않은 작업

production React 구현, 로그인·실제 BFF·DB·LLM 연결, UI 후보 설치·호환성 재검증, Garmin 신청·승인 확보, HealthKit native 개발, RAG 색인·검색, 도로 routing, 생리학 검증, 공유 계획 본문 확보·이식. 기존 prototype 테스트를 이번 변경에서 다시 실행하지 않았다.

이번 산출물 점검은 파일 존재, 기존 파일 보존, FUT ID와 요구·테스트 표 보존, 상대 파일 링크, ZIP 구성의 확인이다. 서비스 기능 테스트나 외부 API 검증이 아니다.
