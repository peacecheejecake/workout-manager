# 다음 세션 handoff · 2026-09-20

최신 상태는 [task-graph.json](task-graph.json), 요구·수용 기준은
[docs/.pre](../.pre/README.md), 작업 규칙은 [AGENTS.md](../../AGENTS.md)를 우선 확인한다.
재개할 때 `git log -1`, `git status --short`, 원격 동기화를 다시 확인한다.

## 사용자 결정과 작업 방식

- 브랜치는 `main`이다. 사용자는 본인 관리 원격 저장소로 task별 peer review, commit,
  `git push origin main`과 다음 ready 작업 계속 진행을 승인했다. 일반적인 push 실패는 기록하고
  다음 ready 작업을 진행한다.
- AGENTS·skill 규칙은 명시적 규칙 변경 요청 없이 수정하지 않는다. 사용자 변경과 untracked 파일을
  보존한다.
- 구현 분해는 Codex native orchestration, 커밋 전 독립 검토는 같은 tab의 Herdr split pane을 사용한다.
  UI 검증은 Aside → Chrome → Playwright 순서를 지킨다.
- JavaScript workspace는 Node 24.12.0과 pnpm 10.34.5로 검증했다.

## 완료된 최신 작업

[M2-05](progress/M2-05.md)를 완료했다. M2-04d가 의도적으로 비워 둔 색인·retrieval cache·
grounding·인용 실행기를 실제로 구현해 파생 cleanup manifest가 기존 lease/재시도 규율
그대로 닫히고, 모든 target에 실행기가 생긴 뒤에만 coach 사용 gate가 다시 열린다.

Retrieval은 술어를 복제하지 않고 `resource_coach_use_authorized()` gate 함수 자체를 조인해
조회 시점에 재검증하며, 순위 계산 전에 필터를 적용하고 현재 version만 대상으로 한다.
검토 pin `reviewed_version_id`가 현재 version과 일치할 때만 색인하므로 본문을 교체하면
명시적 재검토 전까지 색인·retrieval·인용이 모두 차단된다. cache key에 인가 집합 digest가
들어가고 검색 후 manifest를 재수집해 동일성을 확인한 뒤에만 cache에 쓴다. 인용은 본문을
저장하지 않고 offset과 SHA만 보관하며 발췌에 cascade로 묶여 더 오래 살 수 없다.

삭제·AI 동의 철회·coach 사용 중지·검토 하향·공유 철회 다섯 전환을 각각 색인 → cache →
인용 → 실패한 purge 재시도 → drain → cleanup replay → coaching job replay까지 실제
PostgreSQL로 검증했다. `resource-access-v1`을 `evidence-dependencies.ts`에 통합해 승인
transaction 안에서 인가 집합 전체를 재비교한다.

Migration 032는 채워진 031 DB 업그레이드 경로를 포함한다. 기존 reviewed 행은 본문이 하나뿐
(`current_version = 1`)이거나 검토 시각이 version 생성보다 명확히 이후일 때만 pin하며,
동률처럼 순서를 증명할 수 없으면 pin하지 않는다.

검증은 typecheck 28/28, unit 219 files/2,332 tests, 실제 PostgreSQL integration
42 files/373 tests, build 11 tasks, Playwright 10/10, backup/restore drill 44 checks를
통과했다. drill은 export가 v14에서 v17로 오르는 동안 갱신되지 않아 red였던 것을 고치고
v15·v16·v17 collection 복원과 삭제·동의 철회 자료의 미부활까지 검증하도록 확장했다.

**검증하지 않은 것**: 실제 LLM 호출이 없어 모델의 인용 생성과 의미 정확도, claim-citation
entailment, retrieval recall, latency/cost 평가는 not_executed다. 검색은 `simple` FTS
lexical만 있고 vector·rerank·한국어 형태소는 없다. 색인은 retrieval 시점 지연 색인이며
운영 재색인 scheduler는 없다.

## 다음 ready 작업

**내부 구현으로 진행할 수 있는 task는 없다.** 남은 15개 노드는 모두 아래 외부 gate에
막혀 있다. task-graph의 semantics대로 외부 노드는 실제 외부 증거가 있어야 하며 mock이나
합성 데이터 준비는 완료가 아니다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 운영 provider 선택,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 M2-04c commit이 원격에 있는지 확인하고 M2-04d의 접근 revision과 전환 command 계약부터
구현한다.
