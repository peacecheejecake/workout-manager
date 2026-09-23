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

[M2-01q](progress/M2-01q.md)를 완료했다. 지도 화면이 실제로 그리지 못했는데 "표시했습니다"라고 하거나, 그렸는데
"그리지 못했습니다"라고 하던 거짓 상태를 없앴다.

- 상태는 렌더러가 실제 그린 feature와 경로 세대(`data-paths-generation`/`data-evidence-generation`)로 판정한다.
  한 번도 그리지 못한 렌더러만 `not-drawn`, 이미 그린 렌더러의 확인 지연은 `unconfirmed`, 화면 밖은
  `out-of-view`다. 이전 경로에 대한 `drawn`은 편집 뒤 최대 1.5초만 남는다.
- M2-01r의 미계산 점선(`geo-kit-path-uncomputed`)도 선으로 센다(`/courses/new` 거짓 음성 수정).
- 실패 알림은 지도 상태 줄 하나로만 나간다. 컨테이너 쿼리 미지원 브라우저 fallback은 실제 미지원 브라우저에서
  실행하지 못했다.
- 비차단 후속 지적은 M2-01q.md §11에 남겼다. 매트릭스 판정은 M2-01k 재실행에서 반영한다.

직전 완료: [M2-01y](progress/M2-01y.md)(활동·코스 단위 객체 purge와 복원 뒤 재-import 억제, migration 046).

## 다음 ready 작업

M2-01t는 사용자가 2026-09-23에 "현재 구현에 맞게 스펙을 고친다"로 결정했고 진행 중이다. M2-01ac는 ready다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 자체 운영 engine/data 선택·검증,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 working tree와 위 계획을 확인하고 M2-01a/d부터 진행한다. 실제 외부·실환경
증거가 필요한 gate를 문서 검토나 합성 fixture로 완료 처리하지 않는다.
