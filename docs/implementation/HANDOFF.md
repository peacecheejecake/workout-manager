# 다음 세션 handoff · 2026-09-21

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

[M2-01e](progress/M2-01e.md)를 완료했다. 활동 상세의 경로 탭이 서버가 저장한 `map_path`·
정규화 객체를 재조회해 자체 호스팅 배경 지도 위에 그린다 — **저장된 track의 첫 실브라우저
증거**다(M2-01c는 UI를 바꾸지 않았고 M2-01b의 증거는 저장 전 preview였다).

탭은 3패널이다. desktop은 그래프와 지도를 나란히, mobile은 3탭, tablet은 스택이다. 그래프는
같은 `DetailChart`가 같은 selection store에 쓰므로 chart·lap·sample 선택이 **표시 인덱스가
아니라 저장된 sample id로** 서로를 가리키고, lap·구간 선택은 덮이는 표본을 별도 path로
강조하되 gap을 잇지 않는다.

**대응 규칙을 두 번 틀렸고 둘 다 기록했다.** 처음엔 양방향 모두 같은 시각의 첫 항목을 골라
표본 0:1 선택이 관측 0을 거쳐 0:0으로 옮겨갔다. 두 번째는 표본 쪽 유일성만 검사해, 한 시각에
관측이 2개면 마커를 찍어 놓고 역방향 클릭이 연결을 거부해 관측 선택이 사라졌다. 지금은 한
시각이 **정확히 한 표본과 정확히 한 관측**을 가리킬 때만 확정하고, 아니면 어느 쪽이 붐비는지
말하며 선택을 움직이지 않는다.

chart 대응이 저장된 링크가 아니라 **기록 시각** 기준인 이유는 `normalize.ts`가 `detailLink`를
항상 null로 두기 때문이다. 이를 고치면 대응 digest가 바뀌어 **새 track revision**이 되므로
M2-01c 저장 내부에 손대지 않고 보고만 했다. 이 항목은 M2-01f 이후 별도로 판단한다.

`current.json`은 변경 가능한 pointer이므로 `no-store`로 서빙하고, 일주일 immutable 정책은
deployment별 자산에만 남겼다.

검증은 typecheck 32 task, unit 246 files/2,743 tests, 실제 PostgreSQL integration
44 files/403 tests, build 14 task, drill 51 checks, **identity E2E 146 passed / 0 failed**를
통과했다. Aside가 실제 OIDC 로그인 → 실제 API로 FIT 저장 → 새 페이지 로드 재조회까지 몰아
서울 도심 자체 타일 위 경로 feature 3개, **끊긴 구간이 직선으로 이어지지 않음**, 기기 거리
640m와 GPS 재계산 213m 분리, 선택 왕복을 확인했다. Aside는 viewport를 바꿀 수 없어
320~1280px와 420px pane은 Playwright로 확인했다.

**별도 커밋으로 identity suite를 복구했다.** 계정 export가 v15→v18로 오르는 동안 spec 기대값이
갱신되지 않아 main이 8건 red였다. 원인 커밋들이 format·lint·typecheck·unit·integration·drill만
돌리고 **identity suite를 돌리지 않은 것**이 이유다. export 리터럴 6곳을 한 helper로 모으고
(단언 내용 불변), storage spec 2건은 오히려 강화했다. 9 failed/131 passed → **146 passed/0 failed**.
**앞으로 커밋 전 검증에 identity suite를 반드시 포함한다.**

미충족으로 남긴 것: 경로 탭의 lap 표, 차트 드래그 범위 선택, hover 추종 마커, 장기 track 성능
측정, 그리고 배경 지도 서빙은 개발·검증 배선이지 운영 호스팅이 아니다.

## 다음 ready 작업

**M2-01f 기록→Course**가 다음 직렬 작업이다. 저장된 track에서 명시 구간을 선택해 Course를
만들고 불변 version·GPX export·private 기본값을 구현한다. 원본 actual은 불변이어야 하고 동시
수정은 CAS로 막는다. Course revision 회수 대상이 생기므로 M2-01c의 삭제·회수 경로와 연결된다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 자체 운영 engine/data 선택·검증,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 working tree와 위 계획을 확인하고 M2-01a/d부터 진행한다. 실제 외부·실환경
증거가 필요한 gate를 문서 검토나 합성 fixture로 완료 처리하지 않는다.
