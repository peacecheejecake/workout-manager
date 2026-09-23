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

[M2-01s](progress/M2-01s.md)를 완료했다. **개인정보 결함이었다 — 말소된 계정의 GPS 파일이 말소 후에도
영구히 남았다.** 노드는 "백업 복원 후 말소 계정의 코스가 되살아나는가"를 보려고 만들었는데, 그쪽은
정상이었고(말소 재실행 뒤 13개 표 0행, 원장이 이름하는 모든 객체가 `account_erased`로 큐되어 삭제)
**다른 곳에서 더 나쁜 것**이 나왔다.

M2-01c/M2-01m이 늦은 publish 고아를 잡으려고 만든 **참조 색인**은, 원장 행이 7일 뒤 정리되면 그 객체를
이름하는 유일한 곳이 된다. 그런데 **계정 말소가 두 색인을 큐 없이 지웠다** — 그러면 그 객체를 지울
수 있는 것이 **영구히 없어진다.** 그중에는 **절대 GPS 좌표가 담긴 원본 GPX**가 있었다. 백업 복원이
이것을 드문 경합에서 정상 경로로 바꾼다. 그리고 **행만 세는 검사로는 보이지 않았다** — 수정을 끄면
13개 표가 0행인데 저장소에 객체가 남았다. 독립 검토가 base에서 원본 `.gpx`(48 B) 잔존을 독립 재현했다.

새 가장 바깥 `erase_account`(migration `042`)가 체인 전에 두 색인의 key를 읽고 체인 뒤에 전부
`account_erased`로 큐한다. 충돌하는 영수증은 033·038과 같은 규칙으로 전환하되, 이미 열린 영수증의
`available_at`은 **앞당기지 않는다** — 구현자가 검토자 전제("색인 전용 key의 fence는 이미 만료")에
**저장소의 기존 시험을 반례로** 들었다: 렌더가 fence를 연 채 코스가 삭제되면 원장이 cascade로 즉시
사라지고 fence는 그 영수증의 `available_at`에만 남는다. 검토자는 상태가 실재함을 인정하되 30일
재무장이 결국 지우므로 누수는 없다고 판정했다 — `greatest`는 옳고 보수적이지만 필수는 아니다.
잠금: 스트레스 60/60, `40P01` 0.

**병합 시 root가 한 것**: M2-01p의 `041`이 먼저 들어와 이 migration을 `044`에서 **`042`로 재번호**했고,
업그레이드 시험을 파일 이름으로 찾도록 바꿨다. drill 충돌에서 **실제 의미 충돌**을 찾았다 — M2-01s는
candidate search 입력을 helper로 뽑아 유지 tenant 코스와 말소 tenant 코스 **둘 다**에 draft를 하드코딩해
썼는데, 두 코스의 미저장 route는 draft가 달랐다(5와 3). M2-01p의 대체 규칙("다른 종류의 답은 같은
draft일 때만 남는다") 아래서는 한 값으로 맞추면 한쪽 route가 백업 전에 지워진다. helper가 draft를
매개변수로 받게 했다.

**배포 주의**: 042 적용 뒤 **`grantOperations`를 다시 돌리기 전까지** runtime이 `erase_account`에 EXECUTE가
없어 **말소가 `42501`로 실패**한다 — migrate → 즉시 re-grant → 말소 경로 확인 순서.

**분리한 노드 M2-01x**(검토 판정 중상): drill 순서가 DB dump → 객체 아카이브 복사라서 그 사이 업로드된
객체는 복원된 DB에 행이 없고, 말소가 그것을 찾을 수 없다. tenant prefix purge로 닫는다. M2-01k가 기다린다.

## 다음 ready 작업

M2-01o는 독립 검토를 통과해 병합 대기, M2-01q는 검토 대응 중, M2-01r·v는 진행 중이다. M2-01w·M2-01x는
ready다. **M2-01t는 사용자 결정이 먼저**다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 자체 운영 engine/data 선택·검증,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 working tree와 위 계획을 확인하고 M2-01a/d부터 진행한다. 실제 외부·실환경
증거가 필요한 gate를 문서 검토나 합성 fixture로 완료 처리하지 않는다.
