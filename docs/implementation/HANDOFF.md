# 다음 세션 handoff · 2026-09-25

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

[M2-01am](progress/M2-01am.md)를 완료했다. S09 영향 탭의 금지 형태 단언을 단위 시험과 두 shell E2E가 함께 쓰는 한 목록으로 넓혔다(비율·차지·몫·
이행률, 영어 share·odds·percentage points, 분수·비, 앞뒤 인과 형태, 요소가 나뉜 이름·값). 관측 절 이름을 제목에서 가져오고, 관련 상담이
없는 이유를 경우별로 적고, 코치 검토 링크를 E2E에서 실제로 열어 쓰기 0을 단언한다. 세 행은 passed 유지. 영향 탭에 숫자가 든 새 문구를
넣을 때는 `packages/modules/activities/tests/impact-forbidden.ts`의 목록·허용 표본을 함께 본다.

직전 완료: [M2-01ao](progress/M2-01ao.md)(백업 뒤 지운 코스의 복원 부활 방지).

## 운영 메모

- 운영 API는 `WORKOUT_RELEASE`를 반드시 설정한다. 없으면 로그의 version이 `unreleased`로 남는다(M2-01k-c2).
- routing을 켠 API를 여러 인스턴스로 운영할 수 있다(M2-01ah). 모든 인스턴스는 같은 PostgreSQL과 같은 한도 설정을 쓰고, 047 적용
  뒤 `grantCourses`를 다시 실행한다. graph 교체는 인스턴스마다 전환하며 그동안 graph가 섞인다(runbook). 배포는 web을 API보다 먼저
  또는 함께 한다(옛 web bundle은 `timeout_may_be_no_route`를 해석하지 못한다).
- `.geo-build`의 배포 routing graph A는 아직 옛 profile 사본으로 돈다. 저장소 helper가 request-log override와 WARN threshold를
  자동으로 붙이므로 보호되지만, 새 profile로의 교체는 M2-01ak로 한다.
- 후속(M2-01k-l 검토 비차단): 연결·해제 PATCH가 실패하면 keyboard focus가 body로 떨어진다. 활동 상세 재조회 중 미디어 panel을
  유지하는 gate에 시험이 없다.
- track parser child는 컨테이너 메모리 한도 안에서 돈다. OS OOM-killer가 child를 죽이면 `TRACK_PARSE_WORKER_FAILED`로 보이고,
  heap 밖 메모리는 컨테이너 한도로만 묶인다(M2-01ai). parse child RSS 예산은 300 MiB다(M2-01aj). 동시 child 최대 4개의 합은 기록만 한다(컨테이너 크기는 4 × 300 + 800 MiB를 기준으로 잡는다).

- 비공식 Garmin 수집(M1-06b-tmp)은 기본 꺼짐이다. 켜려면 `GARMIN_UNOFFICIAL_OWNER_ATHLETE_ID`,
  `GARMIN_UNOFFICIAL_TOKEN_KEYS_JSON`·`GARMIN_UNOFFICIAL_TOKEN_KEY_ID`, `GARMIN_UNOFFICIAL_PROFILE_PIN_KEY`(회전 금지),
  `GARMIN_UNOFFICIAL_PYTHON`(`uv sync --extra garmin`으로 만든 환경)이 필요하다. 048 적용 뒤 `grantGarminUnofficial`은
  adapter를 켜지 않은 배포에도 실행한다(활동 출처 조회가 쓴다). MFA 대기 상태는
  인스턴스 메모리라 다중 인스턴스는 session affinity가 필요하다. 절차와 제거 방법은 [garmin-setup](garmin-setup.md)과 runbook에 있다.

- 복원 절차에 코스 삭제 원장 재적용이 더해졌다(M2-01ao, runbook "코스 삭제 원장 재적용"). 원장은 DB 밖으로 캡처하고, data와
  post-data 복원이 끝난 뒤 runtime 접근 전에 RLS를 우회하는 복원 admin 역할로, 계정 원장 다음에 재적용한다.

## 다음 ready 작업

task-graph에서 not_started인 ready 노드: M2-01k-n, M2-01ag, M2-01ak, M2-01an, M2-01ap, M2-01ar, M2-01k-o. 이 중
M2-01k-n과 M2-01k-o·M2-01ag·M2-01ak는 이 세션의 병렬 agent가 작업 중이며(task-graph 상태는 커밋할 때 completed로 바뀐다), 재개 시 각
worktree의 미커밋 상태를 먼저 확인한다. M2-01ag는 M2-01k-a가 끝나 진행할 수 있다(목록 `li`에 카드가 들어갔다). M2-01ak는 공유
`.geo-build`를 바꾸므로 harness lock을 잡고 다른 엔진 시험과 겹치지 않게 한다. `M2-01k-o`(공유)는 요구가 승인되어 구현할 수 있다. M2-01k는 이 gap 노드들과 외부 gate EXT-OIDC에 달려 있다.

## 알려진 흔들리는 시험

- `tests/identity/session-attendance.spec.ts:123`("계획 초안 편집" 버튼이 보이지 않음)이 높은 부하(1분 load 32–40)에서 한 번 실패했고
  그 spec만 다시 돌리면 통과했다(M2-01aq 검증, 2026-09-25). 반복되면 별도 노드로 다룬다.
- `tests/identity/course-extras.spec.ts:95`(GPX 가져오기 상태 "코스를 가져왔습니다"가 5초 안에 보이지 않음)이 M2-01aq 병합 검증의 identity 2회차에서
  한 번 실패했다(1회차 통과, 제품 코드 변경 없음). 반복되면 별도 노드로 다룬다.
- `packages/server/track-storage/tests/parse-host.test.ts`의 메모리 상한 시험이 1분 load 약 50에서 `TRACK_PARSE_MEMORY_EXCEEDED`
  대신 `TRACK_OUTPUT_TOO_LARGE`로 한 번 실패했고, 그 파일만 두 번 다시 돌리면 15/15 통과했다(M2-01k-n 재검증, 2026-09-25).
- main의 `garmin-unofficial-worker.test.ts`는 Python `.venv`가 필요하다. 새 worktree에서는 `uv sync`를 먼저 한다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 자체 운영 engine/data 선택·검증,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.
- 임시 Garmin 경로(사용자 결정 2026-09-25): 공식 권한을 기다리는 동안 `garminconnect`로 소유자 자신의 계정에서 앱 내
  수집을 하는 M1-06b-tmp를 완료했다([결정 기록](research/garmin-temporary-gate.md)). 실제 Garmin 계정 실행은 소유자가 앱에서
  로그인해야 하는 별도 증거이며 not_executed다. EXT-G·M0-07b·M1-06b·M2-07은 그대로
  not_started이고 G2는 공식 연동을 거친다.
- 사용자 결정(2026-09-25): 코스 공유(M2-01k-o) [요구](research/m2-01k-o-sharing-requirement.md)를 승인했다. 범위는 확인 뒤 소유자
  GPX(A)와 보기 전용 unlisted 링크(B, 기본 꺼짐)이며, 링크는 보호 구역이 하나 이상 있어야 한다. B는 독립 재식별 검토의 차단 항목
  (공유용 확장 원과 비밀 오프셋 등)과 T22–T25가 통과해야 켤 수 있다. 계획 문장(map-implementation-plan.md:104, :187)을 개정했다.
- 사용자 결정(2026-09-25): routing 지도 데이터를 서울 extract에서 한국 전체 extract로 바꾼다(M2-01ak). M0-06b 증거 묶음은
  [m0-06b-routing-evidence.md](research/m0-06b-routing-evidence.md)이며 독립 coverage 검토는 새 graph로 받는다.
  운영 OIDC는 Google을 평가했고([평가](research/ext-oidc-google-evaluation.md): Google 단독은 prompt=login·새 auth_time·OP
  로그아웃을 못 해 탈락), 사용자가 Zitadel을 선택했다(2026-09-25). 인스턴스·등록·secret은 사용자가 준비한다. M0-06b는 현재 자체 운영 GraphHopper 10.0과 OSM 한국 extract를 선택하고 증거 묶음과
  독립 coverage 검토를 준비한다. M0-06c 실기기 작업은 계속 보류한다.

다음 세션은 working tree와 위 계획을 확인하고 M2-01a/d부터 진행한다. 실제 외부·실환경
증거가 필요한 gate를 문서 검토나 합성 fixture로 완료 처리하지 않는다.
