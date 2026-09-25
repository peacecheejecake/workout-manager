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

[M2-01an](progress/M2-01an.md)를 완료했다. `GET /courses/cards`가 코스마다 전체 선을 읽고 두 번 검증하던 것을, 카드에 필요한 표본(최대 600
정점)·세대·썸네일 상태·고도 근거만 한 tenant 트랜잭션에서 25코스씩 나눈 문장으로 읽게 바꿨다. 출력은 옛 경로와 같다(19코스 계약 시험).
최악 기준(200코스 × 20,000정점) 요청당 CPU가 약 9 s에서 0.5–2 s로 줄었고, 가장 느린 문장(고도 영역 밖)은 약 266 ms로 5 s
`statement_timeout`에 19배 여유가 있다. 카드 목록 재조회 조건(ready면 다시 읽지 않음, 같은 head, focus 재조회 없음, 60초 신선)을 시험으로
고정했다. 행 판정 변화는 없다.

직전 완료: [M2-01at](progress/M2-01at.md)(plain 소유 역할의 object purge).

## 운영 메모

- 운영 API는 `WORKOUT_RELEASE`를 반드시 설정한다. 없으면 로그의 version이 `unreleased`로 남는다(M2-01k-c2).
- routing을 켠 API를 여러 인스턴스로 운영할 수 있다(M2-01ah). 모든 인스턴스는 같은 PostgreSQL과 같은 한도 설정을 쓰고, 047 적용
  뒤 `grantCourses`를 다시 실행한다. graph 교체는 인스턴스마다 전환하며 그동안 graph가 섞인다(runbook). 배포는 web을 API보다 먼저
  또는 함께 한다(옛 web bundle은 `timeout_may_be_no_route`를 해석하지 못한다).
- 전국 routing graph는 `.geo-build-routing/kr-260901/`(git 밖)에 있다. 서빙하려면 그 root의 `config-serving.yml`로 엔진을 helper로
  띄우고 API의 `ROUTING_GRAPH_DIRECTORY`(`<root>/foot`)·`ROUTING_PROFILE_CONFIG`(`<root>/config-serving.yml`)·`ROUTING_ENGINE_URL`·
  `ROUTING_ENGINE_ARTIFACT`를(또는 blue/green 전환 파일과 SIGHUP으로) 그쪽으로 옮긴다(runbook "graph 교체·rollback — blue/green",
  `apps/api/src/routing-deployment.ts`). `ROUTING_GRAPH_ROOT`·`ROUTING_EXTRACT_SOURCE=osm-extract-south-korea`는 build·probe script가
  root와 extract를 고르는 값이다. 기본 `.geo-build`는 여전히 Seoul graph(옛 profile 사본, helper override로 보호)이며 rollback 대상이다.
  엔진 단계가 든 판정 성능 probe는 위 두 script 값 없이 기본 layout에서 돌리면 `ENGINE_GRAPH_NOT_BASELINED`로 멈춘다. PBF는 graph와
  함께 보관한다(월간 파일은 약 석 달 뒤 내려간다).
- 배경 타일은 아직 Seoul extract다(ADR §1·§11, 지역 확대 보류). 그래서 서울 밖 경로에는 배경 지도가 없을 것으로 본다(확인한 사실은
  아니다).
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

- 코스 공유 링크(M2-01k-o)는 `COURSE_SHARING` 기본 꺼짐이다. 켜려면 `COURSE_SHARE_EPOCH`, 32 byte 이상 `COURSE_SHARE_RATE_KEY`,
  `COURSE_SHARE_TRUSTED_PROXIES`가 모두 필요하고(없으면 API가 시작을 거절), web shell 앞에 `X-Forwarded-For`를 연결 주소로 설정하는
  front proxy가 있어야 한다(Next rewrite는 클라이언트 값을 그대로 넘긴다). 복원 뒤에는 epoch를 올린다(runbook). 그리고 M2-01as가 끝나
  독립 재식별 검토가 통과하기 전에는 켜지 않는다. rate key는 base64를 풀어 32 byte 이상이다.
- migration 050 뒤에는 링크를 켜지 않은 배포도 `grantCourses`와 `grantOperations`를 다시 실행한다(확인 receipt와 export v23이 항상
  쓴다). runbook에 이 단계는 아직 없다(후속).
- migration 소유 역할은 지금 superuser나 BYPASSRLS로 둔다. 051(M2-01at)부터 두 object purge는 그렇지 않은 소유 역할에서도 돌지만,
  **그 역할이 051을 직접 적용했을 때만**이다(policy가 적용 역할에 묶여 소유 이전 뒤엔 다시 실패). 그리고 그런 소유 역할에서는 추적·썸네일
  객체가 있는 계정 말소와 추적이 있는 활동 삭제가 여전히 `resource_object_cleanup`에서 `42501`로 실패하고, 정리 queue·sweep·썸네일·URL
  수집 worker는 행을 보지 못한다(후속 M2-01au). 051은 grant를 바꾸지 않는다. 적용할 때는 runtime·worker를 멈추거나 `lock_timeout`을 둔다.

## 다음 ready 작업

task-graph에서 not_started인 ready 노드: M2-01ag, M2-01ap, M2-01ar, M2-01as, M2-01au. 이 중
M2-01ag·M2-01ap·M2-01ar·M2-01as·M2-01au는 이 세션의 병렬 agent가 작업 중이며(task-graph 상태는 커밋할 때 completed로 바뀐다), 재개 시 각
worktree의 미커밋 상태를 먼저 확인한다. M2-01ag는 M2-01k-a가 끝나 진행할 수 있다(목록 `li`에 카드가 들어갔다). M2-01k는 이 gap 노드들과 외부 gate EXT-OIDC에 달려 있다.

## 알려진 흔들리는 시험

- `tests/identity/session-attendance.spec.ts:123`("계획 초안 편집" 버튼이 보이지 않음)이 높은 부하(1분 load 32–40)에서 한 번 실패했고
  그 spec만 다시 돌리면 통과했다(M2-01aq 검증, 2026-09-25). 반복되면 별도 노드로 다룬다.
- `tests/identity/course-extras.spec.ts:95`(GPX 가져오기 상태 "코스를 가져왔습니다"가 5초 안에 보이지 않음)이 M2-01aq 병합 검증의 identity 2회차에서
  한 번 실패했다(1회차 통과, 제품 코드 변경 없음). 반복되면 별도 노드로 다룬다.
- `packages/server/track-storage/tests/parse-host.test.ts`의 메모리 상한 시험이 1분 load 약 50에서 `TRACK_PARSE_MEMORY_EXCEEDED`
  대신 `TRACK_OUTPUT_TOO_LARGE`로 한 번 실패했고, 그 파일만 두 번 다시 돌리면 15/15 통과했다(M2-01k-n 재검증, 2026-09-25).
- `tests/identity/oidc.spec.ts:55`(두 번째 탭 계정 전환, 30초 timeout)와 `tests/identity/activity-track-map.spec.ts:446`(Vite "저장된
  경로" 영역이 5초 안에 안 보임)이 M2-01am 병합 검증의 identity 두 회차에서 각각 한 번 실패했고, 같은 코드를 포함한 M2-01ak 병합 검증
  두 회차는 모두 통과했다(2026-09-25). 반복되면 별도 노드로 다룬다.
- `tests/identity/plan-scenarios.spec.ts:287`(교차 branch 비교)이 M2-01k-o 병합 검증 identity 1회차(1분 load 약 84)에서 한 번 실패했고
  2회차는 통과했다(2026-09-26). 반복되면 별도 노드로 다룬다.
- `apps/api/tests/course-sharing.integration.test.ts` T23(분당 rate limit 창)이 M2-01an 검증의 통합 1회차에서 `expected 200 to be 404`로
  한 번 실패했고, 그 파일만·전체를 다시 돌리면 통과했다(2026-09-26). 시각 창에 기대는 단언이라 반복되면 별도 노드로 다룬다.
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
- 사용자 결정(2026-09-25): routing 지도 데이터를 서울 extract에서 한국 전체 extract로 바꿨다(M2-01ak 완료, graph
  `188b65effcc6ef5c`). M0-06b 증거 묶음은 [m0-06b-routing-evidence.md](research/m0-06b-routing-evidence.md)이며 독립 coverage 검토는
  새 graph로 받는다(P8-coverage not_executed).
  운영 OIDC는 Google을 평가했고([평가](research/ext-oidc-google-evaluation.md): Google 단독은 prompt=login·새 auth_time·OP
  로그아웃을 못 해 탈락), 사용자가 Zitadel을 선택했다(2026-09-25). 인스턴스·등록·secret은 사용자가 준비한다. M0-06b는 현재 자체 운영 GraphHopper 10.0과 OSM 한국 extract를 선택하고 증거 묶음과
  독립 coverage 검토를 준비한다. M0-06c 실기기 작업은 계속 보류한다.

다음 세션은 working tree와 위 계획을 확인하고 M2-01a/d부터 진행한다. 실제 외부·실환경
증거가 필요한 gate를 문서 검토나 합성 fixture로 완료 처리하지 않는다.
