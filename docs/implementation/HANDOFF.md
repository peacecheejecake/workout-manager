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

[M2-01p](progress/M2-01p.md)를 완료했다. **M2-01k 수용의 유일한 failed 행(`K-s14-edit-loop`)을 풀었다.**
저장하지 않은 제안의 코스당 상한(5개, TTL 30분)이 편집기가 더는 쓸 수 없는 옛 draft의 제안까지
세서 30분 안의 6번째 재계산이 429로 막혔고, 사용자는 한도에 걸렸다는 사실도 몰랐다.

**"세지만 않기"를 거절했다.** 035의 consume은 그 제안의 `draftRevision`을 보내면 옛 제안을 여전히
저장해 주므로, 저장 가능한 채 셈에서만 빼면 draft 번호를 바꿔 가며 저장 가능한 경로를 무한히 쌓을 수
있다 — 상한의 목적(개인 좌표 누적, 한 소유자가 표를 채우는 것)이 무력해진다. 대신 **새 답이 같은
종류의 이전 답을 대체(삭제)**한다. draft 번호는 편집 세션마다 1부터 시작하므로 순서가 아니라 같음/
다름으로만 비교한다. 쓰기-1회 트리거가 `expires_at` 변경을 막아 삭제가 유일한 무효화 수단이다.
그 결과 코스당 5석은 **규칙의 불변식**이 됐고 상한 자체는 tenant 단위 20으로 여전히 시험된다.
엔진이 계산하기 **전에** 한도를 확인하고 저장 시 같은 SQL 함수로 tenant 잠금 아래 다시 확인한다.
사용자 문구는 한도와 실제 대기 상한(30분)을 정직하게 말한다.

**F1이 실제 엔진에서 풀린 것을 독립 검토자가 확인했다** — 잠금을 잡고 실제 GraphHopper로 12회 연속
편집이 전부 `route_computed`, 한도 거절 findings 0. 구현자는 잠금 대기로 이것을 돌리지 못해 위임했다.
구현자가 **추론으로만** 한 drill 변경(candidate search를 draft 6 → 5로)도 검토자가 실제로 돌려
확인했다 — draft 6이면 대체 규칙이 draft 5의 미저장 route를 지워 실패한다.

잠금 순서 변이(reaper 순서 뒤집기, supersede 함수 안 순서 뒤집기)가 각각 **실제 `40P01`**을 냈고
둘 다 시험으로 고정했다. 동시성 시험의 liveness 임계값을 낮춘 것은 검토자가 분포를 재서(saves 3–19)
정당하다고 판정했다 — 대부분의 저장이 대체나 revision CAS에 지는 것이 설계상 정상이다.

병합 시 root가 두 가지를 고쳤다: 새 migration을 `042`에서 **`041`로 재번호**(M2-01o가 migration을
쓰지 않아 파일 번호와 버전을 맞춤), 그리고 시험용으로 내보낸 `migrationFileNames`가 **타입만
`readonly`이고 `migrate`가 적용하는 배열 객체 자체**였던 것을 `Object.freeze` 복사본으로 바꿨다
(검토자가 `push`로 적용 목록이 41 → 42로 바뀌는 것을 실측, root가 probe로 수정 후 예외 확인).

## 다음 ready 작업

M2-01o·q·s·u는 독립 검토 중이거나 검토 대응 중이고 M2-01v는 진행 중이다. **M2-01r**(S13/S14 누락
기능)은 M2-01p와 같은 `course-editor.tsx`를 건드려 M2-01p 병합 뒤로 미뤘다 — 이제 ready다.
**M2-01t는 사용자 결정이 먼저**다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 자체 운영 engine/data 선택·검증,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 working tree와 위 계획을 확인하고 M2-01a/d부터 진행한다. 실제 외부·실환경
증거가 필요한 gate를 문서 검토나 합성 fixture로 완료 처리하지 않는다.
