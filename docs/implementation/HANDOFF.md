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

[M2-01t](progress/M2-01t.md)를 완료했다. **사용자 결정(2026-09-23): 현재 구현에 맞게 사양을 고친다.**
`docs/.pre/01_product_screen_spec.md` §7.2의 "실내·GPS 없는 기록은 경로 탭을 설명과 함께 비활성화한다"를, 경로 탭은
비활성화하지 않고 탭 안에서 위치가 기록되지 않았음을 설명하며 지도를 그리지 않고 요약을 보여 주는 현재 동작으로
바꿨다(`docs/.pre/CHANGELOG.md`에 기록, 제품 코드 변경 없음). 위치 없는 합성 FIT로 두 shell에서 실제 브라우저 E2E를
더했고, 지도가 마운트되면 실패함을 변이로 보였다. 매트릭스 `S09-indoor-tab`은 failed → passed이며 헤더
`amendments`에 이 변경을 적었다.

직전 완료: [M2-01q](progress/M2-01q.md)(지도가 실제로 그린 것만 보고하는 상태 판정).

## 다음 ready 작업

M2-01ac는 ready다. M2-01k는 외부 gate EXT-OIDC만 남았다. 내부 공백 노드(M2-01l–y, aa, ab, t)가 모두 닫혔으므로
수용 매트릭스를 다시 돌려 갱신할 수 있으나, `K-oidc`는 EXT-OIDC까지 not_executed이고 노드는 그때까지 완료되지 않는다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 자체 운영 engine/data 선택·검증,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 working tree와 위 계획을 확인하고 M2-01a/d부터 진행한다. 실제 외부·실환경
증거가 필요한 gate를 문서 검토나 합성 fixture로 완료 처리하지 않는다.
