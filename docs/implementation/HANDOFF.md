# 다음 세션 handoff · 2026-09-23

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

[M2-01r](progress/M2-01r.md)를 완료했다. M2-01k 수용 매트릭스에서 빠져 있던 S13/S14 기능을 채웠다.

- `/courses/new`·`/courses/:id/edit`(두 shell). 빈 지도에서 코스를 시작하는 경로가 아예 없었다. 미리보기는
  저장하지 않고(`POST /bff/v1/courses/route-previews`), 저장 때 서버가 엔진에 다시 물어 graph와 선 digest가
  검토한 것과 같을 때만 쓴다. 요청에는 geometry가 없다. **실제 GraphHopper에서 재계산 digest가 일치하는지는
  미실측**이며, E2E 저장은 fixture 엔진으로만 돌았다.
- S13 접근성 메모를 코스 content 밖의 새 표(migration 043, RLS FORCE, 컬럼 한정 UPDATE grant, head CAS)에
  저장한다. 계정 삭제는 course cascade로 지워지고 잠금 순서는 바뀌지 않았다. export v22.
- "미계산 초안" 상태와 geo-kit `uncomputed` 점선, 목록에서의 선택·순서 변경·삭제를 내용 기반 시험과 변이로
  고정했다.
- 매트릭스 판정 제안(§6)은 적용하지 않았다. M2-01k 재실행 때 반영하되, `S14-address`에는 위 미실측을 적는다.
- 병합 때 migration 목록을 042(M2-01s) 뒤 043으로 놓고, foundation 시험에 version 43을 더했으며, 새 upgrade
  시험에 M2-01v의 drop helper를 적용했다.

## 다음 ready 작업

M2-01q는 검토 대응 중, M2-01w·x는 진행 중이다. **M2-01t는 사용자 결정이 먼저**다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 자체 운영 engine/data 선택·검증,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 working tree와 위 계획을 확인하고 M2-01a/d부터 진행한다. 실제 외부·실환경
증거가 필요한 gate를 문서 검토나 합성 fixture로 완료 처리하지 않는다.
