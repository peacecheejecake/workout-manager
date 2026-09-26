# CLAUDE.md · Claude agent override

이 파일은 Claude agent(Claude Code)가 이 저장소에서 따르는 **영구 override**다(사용자 결정 2026-09-26).
`AGENTS.md`가 기본 규칙이며, 이 파일은 아래에 적은 항목만 바꾼다. 적지 않은 것은 모두 `AGENTS.md`를 따른다.

## 구현 orchestration — Claude native

- 구현 분해·위임·조정·통합은 **Claude native orchestration**(Agent 도구, SendMessage)을 쓴다. `AGENTS.md`
  "Codex native task orchestration"의 Codex 도구(`spawn_agent` 등) 대신이며, 그 절의 나머지 원칙(root가
  `task-graph.json`을 소유, ready 노드만 배정, 쓰기 범위 분리, 공유 manifest·lockfile·contract·migration은 root가
  직렬화, agent 완료 보고만으로 통과 아님)은 그대로 따른다.
- 구현 agent는 커밋하지 않고, 검토자를 띄우지 않으며, `task-graph.json`·`AGENTS.md`·`CLAUDE.md`를 고치지 않는다.
  root가 검증된 결과를 phase 브랜치에 커밋한다.

## 독립 검토

- `AGENTS.md`의 "Independent phase review before main"을 따른다(phase 단위, Codex CLI `gpt-6-sol` high,
  읽기 전용, phase 브랜치 → 리뷰 통과 뒤 main fast-forward).
- Claude subagent는 phase 리뷰의 검토자가 아니다. root 자신이나 구현한 agent의 검토도 리뷰가 아니다.

## 그 밖에 Claude agent가 지킬 것

- **실제 외부·실환경 증거 없이 `not_executed`를 통과로 바꾸지 않는다.** Simulator 결과로 실기기 증거를 대신하지 않는다.
- 개인 FIT/GPS·건강 자료·토큰·자격 증명·`.env` 값을 커밋하거나 출력하지 않는다.
- UI 검증은 Aside → Chrome → Playwright 순서를 따른다.
- push는 사용자가 한다. 자동 분류기가 막은 동작을 우회하지 않는다.
- 사용자 결정이 필요한 것은 질문으로 묻는다.
