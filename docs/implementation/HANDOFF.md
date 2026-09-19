# 다음 세션 handoff · 2026-09-19

최신 상태는 [task-graph.json](task-graph.json), 요구·수용 기준은
[docs/.pre](../.pre/README.md), 작업 규칙은 [AGENTS.md](../../AGENTS.md)를 우선
확인한다. 이 문서는 M1c-04 구현 직전 기준 HEAD
`abf4d5b925aa139e0f05108910555a60071925c8`에서 작성한 작업 결과를 설명한다.
재개할 때 `git log -1`, `git status --short`, 원격 동기화를 다시 확인한다.

## 사용자 결정과 작업 방식

- 브랜치는 `main`이다. 사용자는 본인 관리 원격 저장소로의 task별 peer review,
  commit, `git push origin main`을 승인했다. 일반적인 push 실패는 기록하고 다음
  작업을 진행한다.
- AGENTS·skill 규칙은 명시적 규칙 변경 요청 없이 수정하지 않는다. 사용자 변경과
  untracked 파일을 보존한다.
- 구현 분해는 Codex native orchestration, 커밋 전 독립 검토는 같은 tab의 Herdr
  split pane을 사용한다. UI 검증은 Aside → Chrome → Playwright 순서를 지킨다.
- JavaScript workspace는 Node 24.12.0과 pnpm 10.34.5로 검증했다.

## 완료된 최신 작업

[M1c-04](progress/M1c-04.md)는 훈련·영양·회복·routine schedule의 서버 소유
schema v4 후보, 완전한 dependency manifest와 plan head freshness, 명시 승인
transaction, 이력/outbox/receipt, 재전송을 구현했다. Migration 026은 안정적 훈련
aggregate와 v4 원장·RLS·계정 말소를 추가한다. 함께 승인한 영양 계획은 새 훈련
버전을 참조하며 부분 실패는 네 도메인 전체를 rollback한다. 계획 승인으로 실제
Activity·IntakeEntry·RecoveryActionLog·RoutineRun을 만들지 않는다.

web과 mobile-web에 같은 검토 화면을 연결했고, 통합 Planner schema v4에 회복,
루틴과 스트레칭 actual detail을 추가했다. production-disabled 서버 fixture로 OIDC,
임시 PostgreSQL, Chromium에서 두 shell 검토→승인→네 도메인 조회를 검증했다.
구형 Planner와 승인 경계의 호환성은 유지한다. 최종 검사 수와 Herdr 결과는
[진행 기록](progress/M1c-04.md)에 있다.

최근 선행 작업은 M1c-01 범용 루틴, M1c-02 스트레칭, M1c-03 수동 회복 전략과
[최소 운영 권한 코드](progress/M1c-runtime-grants.md)다. 실제 운영 DB 적용은 아직
배포하지 않았다.

## 다음 ready 작업

M1c-04 완료로 **M2-03 갤러리·media**와 **M2-04 자료 생명주기**가 준비됐다.
두 작업은 이후 M2-05 RAG·검토 자료·코치에서 합류한다. 객체 저장 port, tenant
ACL, upload/parser 제한, 삭제가 raw/derived/index/cache/citation에 전파되는 경계를
먼저 확정해야 한다. 공유 contracts·migration·manifest는 root가 직렬 통합한다.

M2-01 코스·도로 routing은 M0-06b coverage/provider gate가 남아 있어 아직
ready가 아니다. M3-01도 M0-06c 실제 native 조건이 남아 있다. 실제 LLM·검토 자료
RAG는 M2-03/04 이전에 완료로 표시하지 않는다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 운영 provider 선택,
  OS 한글 IME/물리 touch/성능·배포 조건. Aside 업데이트는 `fetch failed`였고
  이번 세션의 computer-use 상태에는 Chrome surface가 없었다.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/back 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 task graph에서 ready 상태를 다시 계산하고 M2-03 또는 M2-04 하나를
작은 계약·저장/권한·API/UI·실DB 수용 단위로 분해해 시작한다.
