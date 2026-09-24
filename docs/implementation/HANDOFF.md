# 다음 세션 handoff · 2026-09-24

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

[M2-01k](progress/M2-01k.md) 수용 **2차 판정**을 마쳤다(노드는 새 gap 노드 16개와 외부 gate EXT-OIDC 때문에 아직 완료가 아니다). 110행 매트릭스를 main
`4d5b9e9` 기준으로 다시 판정해 passed 28 → 38, partial 72 → 66, failed 1 → 0, missing 3 → 0, not_executed 6 그대로다.
승격한 행은 모두 이 판에서 실행하고 변이로 비공허성을 보였다(실제 GraphHopper에서 저장 재계산 digest 일치 포함).
독립 검토가 R-S13-S14 승격(태블릿의 접히는 **경유점** 목록 부재)을 차단해 partial로 되돌렸다.

남은 partial·not_executed 72행은 모두 새 노드 `M2-01k-a`…`M2-01k-o`, 외부 gate, "지금은 partial로 수용" 중 한 곳에
들어간다. **사용자 결정(2026-09-24):** S14 목록 drag, 왕복 초안, S09 주소 별칭·미디어 탭·영향 분리·범위/lap/지도 연결,
코스 공유(privacy 확인 포함)를 모두 만든다(i–o). 공유(o)는 passed 행 P7-no-public-share의 전제를 바꾸므로 코드 전에
요구·ACL·철회·재식별 검토를 사용자 승인받고, 기본값 꺼짐으로 시작한다.

직전 완료: [M2-01ac](progress/M2-01ac.md)(부하 간헐 실패 규명, 제품 코드 변경 없음).

## 다음 ready 작업

M2-01ad는 독립 검토 지적(진단 redaction) 수정 중이다. `M2-01k-i`는 같은 편집기 컴포넌트를 바꾸는 `M2-01k-c1` 뒤이고, 나머지 `M2-01k-a`…`M2-01k-n`은 ready이며, `M2-01k-o`(공유)는 `M2-01k-c2`
뒤이며 코드 전에 사용자 승인이 필요하다. M2-01k는 이 노드들과 외부 gate EXT-OIDC에 달려 있다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 자체 운영 engine/data 선택·검증,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 working tree와 위 계획을 확인하고 M2-01a/d부터 진행한다. 실제 외부·실환경
증거가 필요한 gate를 문서 검토나 합성 fixture로 완료 처리하지 않는다.
