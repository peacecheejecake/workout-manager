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

[M2-01w](progress/M2-01w.md)를 완료했다(OIDC 운영 견고성, migration 없음).

- OP discovery를 첫 사용 때로 미뤘다. OP가 내려가 있어도 API는 뜨고 로그인은 `unavailable`로 닫히며, 기존 세션과
  로그아웃은 유지된다. 설정값 오류는 여전히 기동을 거부하고, discovery에서만 드러나는 오류는 고정 사유
  (`oidc_discovery_failed`: issuer_mismatch·insecure_endpoint·network·other)를 시도마다 한 번 남긴다.
- 앱 로그아웃이 먼저 완결된 뒤, 같은 출처·CSRF를 통과한 요청에만 OP 쪽 RP-initiated logout URL을 준다. 이미 성공한
  discovery 결과만 쓰며 로그아웃이 discovery를 일으키지 않는다. HTTPS가 아닌 `end_session_endpoint`는 OP 로그아웃만 끈다.
- 로그인 취소·실패는 `/account?login_error=cancelled|failed|unavailable`의 고정 문구로 끝나며 OP 문구·쿠키 변경이 없다.
- 재인증 요청은 `prompt=login&max_age=0`을 보내고 callback에서 `auth_time`을 검사한다(기본 on, 허용 오차 30초, NTP 전제).
- **back-channel logout은 미구현**(migration 필요)이다. 그때까지 OP 쪽 계정 정지가 앱에 닿는 상한은 8시간이다.
  운영 IdP에서 확인할 항목은 EXT-OIDC scope에 옮겼다.

직전 완료: [M2-01ab](progress/M2-01ab.md)(root swap 목록 시험의 판정 오류, 제품 코드 변경 없음).

## 다음 ready 작업

M2-01q는 3라운드 검토 승인되어 병합 대기, M2-01y는 차단 지적(복원 후 재-import 억제) 수정 중이다. M2-01t는 사용자가 2026-09-23에 "현재 구현에 맞게 스펙을 고친다"로 결정했고 진행 중이다. M2-01ac는 ready다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 자체 운영 engine/data 선택·검증,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 working tree와 위 계획을 확인하고 M2-01a/d부터 진행한다. 실제 외부·실환경
증거가 필요한 gate를 문서 검토나 합성 fixture로 완료 처리하지 않는다.
