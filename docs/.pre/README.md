# Adaptive Training Coach · 문서 묶음 v0.2.3

기준일: 2026-09-16 · 변경: **범용 루틴 관리 + 스트레칭 + 회복 전략 설계 추가**. 기존 v0.2.2 원본은 보존하고 새 사본으로 제공한다. production UI/서버/native·외부 연동과 새 기능/생리학 검증 상태는 바뀌지 않았다.

## 이번 변경부터 읽기

2026-09-16 실행 계획 보완: [구현 계획](../implementation/README.md) · [저장소 작업 지침](../../AGENTS.md). Zustand/TanStack Query 상태 소유권, unit/integration/E2E·Prettier 설정 계획, Herdr peer review·Aside 브라우저 검증, Python FIT 도구 재사용을 구체화했다. 제품·도구 구현 및 기존 수용 시험 상태는 그대로 미완료다.

| 문서 | 내용 |
|---|---|
| [09 루틴·스트레칭·회복 전략](09_routines_stretching_recovery.md) | 5개 화면군·루틴 CRUD/유한 배치/실행·스트레칭·회복·통합 승인·개발 경계 |
| [01 제품·화면](01_product_screen_spec.md) | 기존 S01~S30 + S31~S35, 기존 화면 연결 |
| [05 개발 요구사항](05_implementation_requirements.md#v023-requirements) | 기존 V2/V022 행 유지 + V023-F01~18 / V023-A01~36 |
| [06 후속 백로그](06_follow_up_backlog.md#fut-13) | 기존 FUT-01~12 + FUT-13 범용 루틴 / 14 스트레칭 / 15 회복 |
| [CHANGELOG](CHANGELOG.md) | 추가·수정·보존·미수행 |

## 설계 계약

루틴 template → 유한 일정과 occurrence → 실행/실제 링크를 구분한다. 루틴 envelope로 가짜 Activity를 만들지 않는다. 스트레칭은 기존 동작 catalog/운동 상세를 재사용하고 회복 중 비운동 행동만 별도 원장에 저장한다. 기존 nutrition·training 원장은 복제하지 않는다.

[02 아키텍처](02_frontend_architecture.md) · [03 디자인 시스템](03_design_system.md) · [04 연동·점수·RAG](04_integrations_metrics_rag.md) · [07 반응형](07_responsive_layout.md) · [08 영양·보강](08_nutrition_supplementary_training.md)에 새 범위를 연결했다.

[extensions-v023.contracts.ts](extensions-v023.contracts.ts)는 schemaVersion=4의 설계 타입이다. 기존 [extensions-v022.contracts.ts](extensions-v022.contracts.ts)는 보존한다. 타입 컴파일은 API/runtime validator·DB·UI·타이머·생리 모델의 구현/정합성 시험이 아니다. contracts.ts의 ModuleId에는 routines/recovery만 추가하고 stretching screen은 supplementary에 속한다.

## 보존·미수행

[기존 HTML](prototype/index.html), [데스크톱 이미지](qa/dashboard-desktop.png), [모바일 이미지](qa/dashboard-mobile-viewport.png), [과거 prototype 결과](qa/prototype-results.json)는 변경하지 않았다. **루틴·스트레칭·회복 화면을 HTML에 추가하거나 과거 브라우저 smoke check를 재실행하지 않았다.**

[responsive-spec.json](responsive-spec.json), design-tokens.css, shared-domain.ts 및 과거 sources/QA도 보존했다. 새 방법의 효과·안전성, provider 가용성과 라이브러리 호환성은 이번에 조사/검증하지 않았다. 기존 Garmin·HealthKit·RAG·routing·생리학·공유 계획 원문 미완료 항목은 그대로다.

## 검증과 개발 재개

이번 점검은 문서 경로·고유 ID·기존 요구 행/산출물 보존·JSON 및 TypeScript 컴파일에 한정한다. 상세는 [문서 검사 결과](qa/document-v023-checks.json)에서 확인한다. [새 수용 테스트 36개](qa/v023-acceptance-plan.json)는 모두 not_executed 상태다.

M0 계약 → 기존 M1 러닝 → M1b 영양/보강 → **M1c 루틴/스트레칭/회복 수동 core** → M2 검토 자료·RAG·코칭·전체 화면 → M3 native 검증 순서다. 특정 일정을 약속하거나 외부 이슈 트래커에 자동 등록한 상태가 아니다. 작업 상태는 FUT ID와 실제 증거로 갱신한다.
