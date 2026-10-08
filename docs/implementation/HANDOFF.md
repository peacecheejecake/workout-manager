# 다음 세션 handoff · 2026-09-27

최신 상태는 [task-graph.json](task-graph.json), 요구·수용 기준은
[docs/.pre](../.pre/README.md), 작업 규칙은 [AGENTS.md](../../AGENTS.md)를 우선 확인한다.
재개할 때 `git log -1`, `git status --short`, 원격 동기화를 다시 확인한다.

**최신 Garmin 범위 결정(2026-09-27):** 공식 권한·다운로드·adapter·출시 검증을
[별도 후속 계획](research/garmin-official-deferred.md)으로 이관했다. 현 Web MVP의 `G2`는
공식 Garmin을 요구하지 않는다. 완료된 `M1-06b-tmp`는 소유자 한정·기본 꺼짐 비공식
개발 경로이고, 실제 Garmin 계정 실행은 `not_executed`다. 아래의 2026-09-25/26 결정
기록은 역사로 보존하며, 현재 작업에는 이 새 결정을 적용한다.

**최신 호스팅 범위 결정(2026-09-27):** `G2`는 내부 출시 준비 판정이다. 공개 Web 출시는
새 `G2-PUBLIC` gate에서 `G2`와 `EXT-HOSTING`의 실제 HTTPS 배포 증거를 함께 요구한다.
Native 최종 통합 `M3-03`은 내부 `G2` 뒤에 진행할 수 있지만, 공개 Native 출시 `G3`도
`G2-PUBLIC`을 요구한다. 2026-09-29 사용자는 호스팅 진행과 AWS 서울 리전·월 10만 원 상한을 결정했다.
CLI 로그인·AWS Organizations·서울 단일 리전 Identity Center·관리자 권한 할당·USD 60 예산 경고까지
확인했다. 비루트 관리자 포털 로그인·WebAuthn MFA 1개·CLI SSO 역할도 확인했다. 사용자는
`workout.red-10-proto.xyz`를 선택했다. `Ubuntu-1`·`Node-js-1`의 새 스냅샷이 `available`인 것을 확인한 뒤 두 인스턴스를 삭제해,
기존 도메인 서버를 스냅샷에서 8 GiB `workout-shared-8gb-20260929`로 옮겼다. 원본 Docker 데이터 볼륨의 파일 해시가 일치했고,
고정 IP 이관 후 공개 기존 사이트의 `200`·TLS 검증을 확인했다. 최종 원본 스냅샷이 `available`이 된 뒤 이전 `Ubuntu-2`를 삭제해
Lightsail 인스턴스는 새 서버 한 대만 남는다. 가비아 `workout` DNS 접근과 운영 기간은 결정 대기 중이며, [EXT-HOSTING](progress/EXT-HOSTING.md)은
`in_progress`다. 새 서버에서 앱·GraphHopper 이미지를 실제 빌드하고 새 전국 graph의 비공개 경로 계산과
전용 DB 65개 마이그레이션·제한된 역할을 확인했다. Zitadel 자격 증명은 사용자 승인 뒤 서울 Secrets Manager에
저장했다. 서버 전달은 처음 자동 승인 검토에서 거절됐으나, 사용자의 정확한 목적지 명시 승인 후 root 전용
`app.env`에 전달했다. 앱을 비공개로 기동해 API·웹·DB 통합 health와 전국 graph의 합성 경로를 확인했다.
두 Docker 네트워크의 `postgres` 이름 충돌은 전용 `wm-postgres` 별칭으로 고쳤다. 기존 사이트의 공개 HTTPS는 계속
`200`이었다. 실제 서울 OSM 추출물에서 장소·고도 자료와 ODbL 고지를 다시 빌드해 내부 앱에 연결했고,
배경 지도·경로·장소/고도 스크립트 다운로드 10개의 응답 해시를 배포 기록과 대조했다. `workout` DNS·Zitadel
HTTPS 등록·공개 로그인·전체 제품 검증은 `not_executed`다.
이후 비공개 저장소에 쓴 합성 파일은 앱·경로 엔진 재시작 후 같은 해시로 남았고, 기존 사이트는 HTTPS 200을 유지했다.
격리된 PostgreSQL 백업 복원은 제한된 객체 소유자·역할 재구성·복원본 앱 health까지 확인했다. 실제 사용자 데이터,
작업자와 IdP를 포함한 운영 복구는 검증하지 않았다. 가비아 Chrome 탭은 로그인·CAPTCHA 단계이며 Zitadel의 현재
`minificent.project` 계정에는 관리자 역할이 0개다. DNS와 앱 callback 설정은 해당 계정 접근을 기다린다.

**최신 M0-06c 판정(2026-09-27):** 별도 서명 작성 앱의 합성 심박수 1건 저장 뒤, 종료된 probe의 새 background launch와 observer callback을 실기기에서 확인했다. [실행·정리 기록](progress/M0-06c-native-host-addendum.md#별도-서명-작성-앱으로-실제-wake-확인--2026-09-27)에 따라 M0-06c의 제한된 feasibility 범위는 `completed`다. 아래 초기 phase·실기기 기록의 `in_progress`와 `not_executed`는 해당 시점의 결과다. 미저장 Back 버튼별 기계 기록과 제품 native host 통합은 남아 있으며 제품 범위는 M3-01이다.

**최신 EXT-HOSTING 중단 상태(2026-10-05):** 승인된 uidtimer-v2 준비 스크립트는 후보 구조 render 중 `ledger-export.env` 미존재로 한 번 실패했다. 활성 source/env/pin은 기존 값이며 두 timer mask와 검증된 `.next`·root-only 보존본만 남았다. 원본 스크립트 재실행이나 `.next` 무조건 삭제를 하지 않는다. 별도 wm-recovery/root 접근·available 스냅샷·Workout 503/기존 사이트 200을 재확인했다. 원장 env/암호화·HMAC 키, logical slot/publication/사건 표·signed head와 컨테이너 AWS 자격 증명은 미준비다. [실패·진단 기록](progress/EXT-HOSTING.md#uidtimer-v2-준비-실행-중단과-읽기-전용-진단--2026-10-05)을 확인한 뒤 masked timer/남은 `.next`를 정확히 검사하는 새 continuation script의 독립 검토와 명시 승인을 받는다. Docker의 공식 `--no-env-resolution`을 이용한 후보 구조 검사는 서버 읽기 전용 exit 0이지만 원장 실행·복원 수용 증거가 아니다. UID/컨테이너/backup fence 전환·운영 백업/복원·503 해제는 계속 `not_executed`다.

## 사용자 결정과 작업 방식

- 규칙은 [AGENTS.md](../../AGENTS.md)가 기본이다. Claude agent는 [CLAUDE.md](../../CLAUDE.md)의 override(Claude native orchestration)를
  따른다. Codex는 AGENTS.md대로 Codex native orchestration을 쓴다.
- **독립 검토는 phase 단위**다(AGENTS.md "Independent phase review before main", 사용자 결정 2026-09-26). task는 검증 뒤
  `phase/<접두>` 브랜치에 커밋하고, phase의 실행 가능한 노드가 끝나면 Codex CLI `gpt-6-sol`(reasoning high, read-only sandbox)로
  main 대비 phase 전체 diff를 검토받는다. APPROVE 뒤에만 main에 fast-forward한다. 구현한 agent의 자기 검토는 리뷰가 아니다.
- push는 **사용자가** 한다(자동 분류기가 agent의 push를 막는다; 우회하지 않는다).
- AGENTS·CLAUDE·skill 규칙은 명시적 규칙 변경 요청 없이 수정하지 않는다. UI 검증은 Aside → Chrome → Playwright 순서.
- 실제 외부·실환경 증거 없이 `not_executed`를 통과로 바꾸지 않는다. Simulator로 실기기를 대신하지 않는다. `.env` 값·개인
  건강 자료를 커밋·출력하지 않는다.
- JavaScript workspace는 Node 24.12.0(`~/.local/share/fnm/node-versions/v24.12.0/installation/bin`)과 pnpm 10.34.5. 새 worktree는
  `uv sync`(Garmin worker 시험)와 `.geo-build` symlink가 필요하다.

## 완료된 최신 작업과 phase 검토 (2026-09-27)

`phase/m0-06`(독립 검토 APPROVE 후 main에 fast-forward 완료):

- [M0-06b-odbl](progress/M0-06b-odbl.md) 완료: 타일 배포·routing graph가 빌드 값에서 만든 ODbL disclosure와 그 렌더링인
  `ATTRIBUTION.txt`(OSM copyright·ODbL 1.0 URI)를 쓰고, 누락·불일치면 빌드를 거부한다. 인증 없는 `/map-data-licence` 페이지와
  `GET /bff/v1/map-data/licence`. **지금 서빙 중인 타일(`ec81f3367889-mub8vb9q`)과 전국 graph(`92e0fa5f319a41df`)는 고지가 없어
  새 검사에 실패한다** — 사용자 결정: 호스팅(EXT-HOSTING) 때 재빌드. 전국 extract의 acquisition 기록도 그때 다시 받아 만든다.
- [M0-06c](progress/M0-06c.md) 당시 진행(in_progress; 현재 feasibility 완료): 유료 team `XVT9A9T7RP`로 서명한 probe 앱(`org.workoutmanager.feasibility.deviceprobe`)을
  실제 iPhone(iPhone16,2, iOS 27.0)에서 실행. 사람 조작 체크리스트 1–9 완료(HealthKit 쓰기 권한, 자기 source 빈 조회, IME, 스크롤,
  가로 safe-area, back, 개발 계정 전환, 백그라운드·잠금, cold relaunch). **당시 가로 화면에서 키보드가 입력란을 가렸다**(후속 수정 전 결함 후보).
  WKWebView가 한국어 입력에 composition 이벤트를 보내지 않았다(IME 로직 전제 점검 필요). 변경 후 단위·통합·빌드와
  브라우저 검증은 [진행 기록](progress/M0-06c.md)에 따로 남겼다. 이 시점에는 수정 후 실기기 재실행이 없었다.
- 당시 task-graph는 M0-06b-odbl 완료, M0-06b-odbl-places 미시작이었다. Places 후속은 아래처럼 이후 완료했다.
  당시 EXT-G 유지 결정은 위 2026-09-27 결정으로 현재 범위에서 대체됐다.
- Codex CLI `gpt-6-sol` high/read-only가 `main` 기준 `5a4dfb5c98d99e88344f920da3ab14558a762ac8`부터
  `phase/m0-06` HEAD `97aee9a84cb6abb237a57b728ec34b920a903d96`까지의 전체 diff를 최종 **APPROVE**했다.
  앞선 지적은 수정 커밋과 재검토로 닫았고, main을 해당 HEAD로 fast-forward했다. 실기기 재실행 및
  당시 합성 HealthKit 표본·background delivery 증거는 `not_executed`였다.

`phase/ext-oidc`(독립 재검토 APPROVE 후 main에 fast-forward 완료):

- [EXT-OIDC](progress/EXT-OIDC.md) 완료(사용자 결정: 분할). Zitadel Cloud(`personal-workout-lgn7dx.eu1.zitadel.cloud`)에 사람이
  localhost에서 실제 로그인 체크리스트를 수행하고 서버 증거로 확인. K-oidc not_executed → **partial**. HTTPS·TLS·secret manager·
  배포 환경 확인은 새 노드 **EXT-HOSTING**. 로컬 스택: `scripts/ext-oidc-local/`(`stack.sh up|down|sessions|log-check|outage-on|off|
expire-sessions`), 값은 Git 제외 `.env`에서만 읽는다. 사용자 결정으로 back-channel logout 후속 노드
  `EXT-BACKCHANNEL`을 추가했다.
- M0-06 병합 뒤 새 main 대비 재검토가 APPROVE였고, main을 `c3455868fcc70b50b3f1e35c4bfd262fcd6a970f`로 fast-forward했다.

이후 `phase/m0-06b-odbl-places`(최종 review APPROVE, main `53563e3`)와 `phase/m2-01az`
(최종 review APPROVE, main `17982f2`)가 차례로 반영됐다. P8 새 기준의 82쌍 재실행과 별도 채점은
`adequate` 75.5/82이며, 과거 `failed`는 보존한다. [P8 기록](progress/M2-01az.md)을 참고한다.
`phase/ext-backchannel`은 [별도 phase 기록](progress/EXT-BACKCHANNEL.md)의 전체 diff 검토에서
APPROVE를 받고 main `7d54934`로 fast-forward했다. 실제 HTTPS 공급자 전파는 EXT-HOSTING까지 `not_executed`다.
`phase/m0-06c`는 [native probe 전체 diff](progress/M0-06c-native-host-addendum.md)의 독립 검토에서
APPROVE를 받아 main `9ac6aa1`로 fast-forward했다. 당시 수정 앱의 실기기 검증은 `not_executed`, 노드는 `in_progress`였다.
이후 연결된 iPhone에서 서명·설치, 표식 있는 합성 HealthKit 표본의 두 차례 생성·수집·삭제·정리,
중단·재실행·재설치 복구와 background delivery 설정·해제를 실행했다. 세부 결과와 미확인 항목은
[실기기 후속 기록](progress/M0-06c-native-host-addendum.md#연결된-iphone-실기기-후속-실행--2026-09-27)에 따로 기록했다.
그 후 종료 대상 식별 수정과 실기기 기록은 새 main `d75fc94` 기준 phase `5ad1abd` 전체 독립 검토에서
APPROVE를 받았다. 당시 기록 갱신의 검토 refresh 후 main에 반영했고, 노드는 `in_progress`였다.
`phase/m2-01k`는 반응형 초안·지도 상태·차트↔지도 확대·계정 전환과 늦은 응답·S13 카드 노면·S14 공급자 분리 수용을
보강했다. 매트릭스는 passed 91 · partial 14 · failed 1 · not_executed 4이며, 부모 노드는 `in_progress`다.
이 phase 브랜치는 main `9ac6aa1` 대비 전체 독립 검토 1차 지적 둘을 `f12c021`로 고쳤다. 2차 검토는
그 둘을 FIXED로 확인하고 새 지적 둘을 냈으며 `9967344`로 수정했다. 3차 검토는 앞선 네 지적을
모두 FIXED로 확인하고 새 P2 지적 하나를 냈으며 `da2e201`로 수정했다. 4차 검토는 앞선 다섯 지적을
모두 FIXED로 확인하고 resize 출처 문제를 새로 지적했으며 `c33091b`로 수정했다. 5차 검토는 앞선 여섯 지적을
모두 FIXED로 확인하고 진행 중 wheel 완료 신호 소실을 새로 지적했으며 `58c9022`로 수정했다. 6차 전체 diff 검토는
일곱 지적 모두 FIXED, 새 차단 지적 없이 `3c2c74a`에 APPROVE를 냈다. 7차 문서 갱신 검토도 전체 diff와
일곱 지적 모두를 확인해 `0b183c8`에 APPROVE를 냈다. main을 그 HEAD로 fast-forward했다.
규칙 변경(AGENTS.md phase 리뷰, CLAUDE.md 영구 override)은 그보다 앞선 기록이다.

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
  front proxy가 있어야 한다(Next rewrite는 클라이언트 값을 그대로 넘긴다). 복원 뒤에는 epoch를 올린다(runbook). 재식별 완화(M2-01as)와 그 독립 검토는
  통과했다(상한 10). 링크를 켜면 migration 054의 예산 원장도 복원 절차에 들어간다(runbook). rate key는 base64를 풀어 32 byte 이상이다.
- migration 050 뒤에는 링크를 켜지 않은 배포도 `grantCourses`와 `grantOperations`를 다시 실행한다(확인 receipt와 export v23이 항상
  쓴다). [운영 runbook의 050·054 후 권한 재적용 절차](operations-runbook.md)와
  [배포 bootstrap](../../deploy/lightsail/bootstrap-db.mjs)에 두 grant 호출이 있다. 실제 운영 적용 여부는 별도 검증한다.
- migration 소유 역할은 051·052·055(M2-01at·M2-01au·M2-01av)부터 superuser나 BYPASSRLS가 아니어도 된다. 단 그 역할이 migration을
  직접 적용했을 때만이며, 소유를 옮겼다면 **가장 먼저** `select retarget_definer_policies();`를 새 소유자로 실행한다(그 전에는 055의 8개 원천
  표 쓰기도 `42501`로 실패). 복원 replay의 외래 id 확인은 identity 계정이 있는 tenant만 본다. object key의 tenant와 다른 tenant의 행은
  object 정리에서 보이지 않는다. 최악의 prune 비용은 호출당 약 0.35 s(그 뒤 한 시간 미룸). 055의 trigger는 썸네일 갱신에 약 +250 µs를 더한다.
  object key가 tenant를 이름 붙이지 않으면 정리 authorize가 `INCONSISTENT_LEDGER:OBJECT_KEY_TENANT`로 닫는다.
- 성능 판정 run은 M2-01ar 뒤의 probe로만 기록한다. 2026-09-25T15:00Z 뒤에 옛 probe로 기록한 판정 run은 `verifyRerunPolicy`가
  거부한다. 브라우저 판정은 harness lock 아래에서 `node --import tsx scripts/run-browser-performance-budget.mts --execute`로 돌린다. 이력
  검사는 `git merge-base HEAD main`을 부르므로 CI checkout은 history와 로컬 `main` ref가 있어야 한다(지금은 없으면 skip으로 보고된다).

## 다음 작업 순서

2026-10-08 추가 진행: source116 인증 수신기 unit36/실제PG 복합1, 공개 최신성 추가 실제PG10, 새 preview/template contracts unit40 및 contracts 전체 TS/build를 Root가 검증·phase 커밋했다. 이전 setup 실패·skip는 별도 보존했다. SQL123 template producer는 Root unit17/두 프로필 실제PG18 및 consumerTS/lint/format을 통과해 phase에 커밋했다. template 소비 helper·공개 frozen before/after mapper·공개 소비 경로 준비는 native subagent 병렬 작업 중이며 Root만 공유파일/실제PG를 통합한다. parent 없는 unplanned run은 top-level roster로 계약을 수정하고 unit27을 재검증했다. source116222 profile은 그대로이고123 포함 새 profile·export/복원/이미 적용된 erasure postimage는 별도 미완료다. AWS STS는 SSO 만료로 실패하여 서버/503/배포 검증은 갱신하지 않았다. 상세 SHA/실제 결과·한계는 [I 기록](progress/M2-02i.md)을 따른다.

최신 재개 기록(2026-10-08): `phase/m2-02` 검증 HEAD `b292e32e`, main은 병합하지 않았다. atomic approval 검증 당시 HEAD는 `b14c26ab`이었다. atomic approval 원15건, 별도 routine version6건, 기존 integrated approval19건이 실제 합성PG에서 통과했다. full phase나 공개 HTTP/UI/복원/운영 출시 완료가 아니다. 정확 입력·초기실패·최종결과는 [I 기록](progress/M2-02i.md)을 따른다.

현재 Root는 공통 DTO/API/registry/profile·실제 DB 검증·결과 통합을 맡고, native agent는 NEW 공개 whole-preview 계약2파일·추가 public freshness PG fixture1파일·whole source receiver2파일을 비중복으로 병행한다. public service/122와119의 검증된 slice는 phase에만 기록한다. whole-source capture5파일은 Root unit10/actualPG 복합1건 통과, public service3/SQL122는 Root unit16·actualPG9 통과이며 whole preview/API/UI 연결은 남았다. SQL119/fixture는 Root R2 actual14통과/1skip이며 genuine consumed CheckIn public port 부재를 별도 not_executed로 유지한다. 이전R1 11통과/3실패는 보존한다. source116 캡처는 전체 restore/admission 완료가 아니며 정확 실패/결과는 I 기록을 따른다. 새 public command 계약은 기존 intent 본문을 그대로 추출한 strict DTO이며 caller basis/recipe를 받지 않는다. 정상 registry107은 유지한다. PB chip/gun·거리 분류와 AWS 로그인 가능 여부를 다시 질문했으며 답변 전 확정하지 않는다.

앞선 실행 기준(2026-10-08): main `1d557358`, `phase/m2-02` 최신 검증 커밋 `dec6543e`. 이전 실행 기준 `2e56edd8`과 뒤에 이어지는 2026-09-27 기록은 역사적 스냅샷이며 최신 수용으로 승격하지 않는다. 이후 검증 커밋은 재개 시 `git log -1`로 확인한다.

1. **M2-02i/j ready 구현**: I/J의 정상 runtime 설치·configured 활성화·최신 export/restore closure를 완료한다. 비중복 scope를 native agent에 배정하고 Root가 shared schema/registry·실DB·graph/Git를 직렬 통합한다. PB는 사용자 확정 Chip 우선·Chip null이면 Gun 비교로 구현해 실제 두 Host 4/4를 확인했다. 공개 영양 재연결은 별도 명시 승인 경로의 두 Host 2/2를 확인했으며 정상107에 쓰기 port를 자동 활성화하지 않는다. 전체 노드/phase 수용과 운영·native gate는 별도다.
2. **M2-02 phase 검증·독립 검토**: runnable 노드 완료 후 전체 install/generated/lint/TS/build/unit/integration/identity 두 회차/format 및 해당 drill을 실제 실행하고, base/head를 고정한 context-less `gpt-6-sol` high 읽기 전용 phase review를 받는다. 승인과 기록 후 main fast-forward만 수행하며 push는 사용자 작업이다.
3. **후속 graph·외부 gate**: I/J/K/L 완료 뒤 EXT-RESTOREa/b를 진행한다. AWS 인증 재개·실제 서버 상태와 새 실행 승인 없이는 recovery/drill/백업/복원/공개503 전환을 실행하지 않는다. 실기기 성능·제품 HealthKit·운영 OIDC·back-channel·ODbL 공개응답은 각각 실제 증거를 확보한다. FUT-09 실제 원문과 외부 `not_executed`는 별도 대기다.

### 과거 실행 순서 스냅샷 · 2026-09-27

M0-06c의 실제 wake는 위 최신 기록으로 확인했다. 미저장 Back 확인창의 버튼별 기계 기록은 없으며 제품 native host 통합은 M3-01이다.

1. **M2-01k 남은 gate**: `M2-01k-t`에서 Vite의 대시보드·웰빙·활동 편집 경로와 두 shell의
   비공개 상태 수명을 로컬 검증했다. 실제 OS focus·운영 OIDC·실기기 증거가 없어 `P5-logout-clear`는
   제품 전체 행에서 partial이다. `P8-ui-component`는 후속 M2-01k-p 검증으로 passed가 됐다.
   실제 호스팅·실기기 증거는 별도 gate로 남기고, 공식 Garmin은 후속 계획으로 이관했다.
2. **외부 gate**: EXT-HOSTING(AWS 배포 준비 중; 가비아 DNS 접근·운영 기간·비용 검증 대기,
   G2-PUBLIC 선행 조건), M0-06b의 실기기 성능·ODbL 공개 배포 확인.
3. **ODbL 배포 gate**: M0-06b-odbl-scripts(공개 페이지의 빌드 스크립트 본문)와
   M0-06b-odbl-gpx(코스 GPX 출처 표기)의 로컬 구현·검증은 완료했다. 실제 공개 배포 증거는 EXT-HOSTING에 남는다.

재개 중 받은 결정 중 M0-06c의 native 키보드 처리·확인 후 Back·합성 HealthKit 표본 허용은 probe 후속 실행에 반영했다(제품 host는 M3-01). `EXT-BACKCHANNEL`은 노드 추가·구현·병합이 완료됐다. P8 새 기준의 엔진 재실행과 독립 채점도 완료했고 과거 사전등록 기준의 `failed`는 보존한다. 아래 사용자 결정 기록과 실행 기록을 따른다.

기준 스냅샷(2026-09-27): `phase/m2-01k`의 승인된 작업은 `0b183c8`까지 main에 포함됐다.
이후 결과는 재개 시 `git log -1`로 확인한다. push는 사용자 작업이다. `phase/m2-01`은 이미 main에 포함(삭제 가능).
전국 보행 graph 최종 root `.geo-build-routing/kr-260901-m2-01ay-r1`(`92e0fa5f319a41df`), 기본 `.geo-build`는 Seoul. 오래된 root
`kr-260901-m2-01ay-barriers`(대체됨)·`kr-260924`는 사용자 승인 후 삭제했다. `.claude/worktrees/`의 agent worktree는
현재 작업용이므로 삭제 전 상태를 각각 확인한다.

## 사용자 결정 기록(2026-09-26, 외부 gate)

아래 결정은 **문서에만 반영**했다. 표시가 없는 항목은 구현하지 않았다(사용자 지시: "지금의 답변은 바로 구현하지 말고 문서에만 적용").

- **EXT-OIDC:** Zitadel Cloud를 사용자가 등록했다(instance `personal-workout-lgn7dx.eu1.zitadel.cloud`, Web app, auth method CODE와 client
  secret, Development Mode). 호스팅 보류로 `PUBLIC_ORIGIN=http://localhost:3100`, `ALLOW_INSECURE_LOCALHOST=true`. redirect는
  `/bff/v1/auth/callback`, post-logout은 `/account`. 시험 사용자 둘(하나 MFA). 값은 저장소 밖 `.env`(Git 제외)에만 있다. discovery
  200, S256·`client_secret_basic`·`end_session_endpoint` 광고 확인.
- **EXT-OIDC 분할(결정 후 `phase/ext-oidc`에서 구현):** localhost 실제 IdP 검증이 통과하면 EXT-OIDC를 완료로 하고, HTTPS 도메인·TLS ingress·secret manager
  항목은 새 노드 EXT-HOSTING(호스팅 gate)으로 분리한다. 그러면 M2-01k가 진행될 수 있고 HTTPS 행은 not_executed로 남는다.
  `phase/ext-oidc`에서 외부 gate 노드를 만들었다.
- **EXT-G(당시 결정, 현 범위에서 대체):** Garmin Connect Developer Program 승인 전까지 로컬 FIT 가져오기만 쓰고,
  승인되면 M0-07b·M1-06b를 공식 경로로 구현하려던 계획이다. 2026-09-27 결정에 따라 현재 그래프 대신
  [후속 계획](research/garmin-official-deferred.md)에 수용 계약을 보존한다.
- **실기기:** iPhone(iPhone16,2)이 연결·pair되었고 실기기 보류가 풀렸다. 서명은 유료 Apple Developer Program team `XVT9A9T7RP`(`TC7DXULXVQ`는 인증서 이름의 식별자로, team이 아니다).
  Xcode가 활성 developer dir이고 license를 수락했다.
- **HealthKit 시험 자료(결정과 후속 실행):** 앱이 표식을 붙여 쓴 합성 표본만 쓰고 지우는 것을 허용했다. 기존 건강 자료는 수집·저장·내보내지
  않았다. 연결된 iPhone에서 표식 있는 두 쌍의 합성 표본을 생성·삭제·정리했고, 이후 별도 작성 앱의 표식 심박수 1건으로 실제 wake를 확인하고 삭제했다. [별도 기록](progress/M0-06c-native-host-addendum.md)에 OS 호출과 한계를 남겼다.
- **호스팅·ODbL:** ODbL 이행을 먼저 하고(M0-06b-odbl 노드), 실제 호스팅은 보류한다.
- **ODbL §4.6 스크립트 공개(결정만, 미구현):** 빌드 스크립트 본문을 서비스의 로그인 불필요 데이터 출처 페이지에서 내려받게 한다(별도 공개
  저장소 없음, manifest의 SHA-256과 같은 바이트).
- **GPX export 표기(결정만, 미구현):** 법적 판단 없이 보수적으로 GPX 메타데이터에 OSM 출처와 ODbL 1.0 URI를 넣는다.
- **P8-coverage(기존 결정과 후속 변경):** 기존 사전등록 기준과 `failed` 판정은 역사 기록으로 보존한다.
  후속 결정에서 RUR-02 최소 거리 1,500m, BRG-01의 보행 가능한 한강 다리, NEG-ISL-01의 지도에 있는
  보행 허용 페리 경로를 인정하는 새 기준을 채택했다. 그 기준으로 엔진을 2회 재실행하고 별도 독립 채점에서
  `adequate`(75.5/82)를 받았다. [실행 기록](research/m0-06b-coverage-execution-m2-01az.md)과
  [채점 기록](research/m0-06b-coverage-review-grading-m2-01az.md)을 참조한다. 기존 `failed`는 바꾸지 않는다.

## HealthKit 계정 귀속 후속 결정·서버 로컬 수용(2026-10-05)

- 사용자의 명시적 운동 선택·등록은 현재 제품 계정에 대한 귀속 선언이다. HealthKit 자체는 실제 인간 소유자를 확인하지 못한다.
- 개별 등록 해제는 제품 내 관련 기록을 삭제·정리한 뒤 귀속을 해제한다. 다른 계정은 정리가 완료된 뒤 같은 UUID를 명시 재등록할 수 있다.
- 계정이 남아 있어도 HealthKit 동의 철회 시 귀속을 삭제해 다른 계정의 명시 재등록을 허용한다. 계정 말소도 귀속 삭제 후 재등록을 허용한다. 모두 유효 동의와 새 사용자 선언이 필요하다.
- [ADR](research/healthkit-account-registration-adr.md), [M3-02k](progress/M3-02k.md)에 결정과 구현 범위를 기록했다. 094 AFTER consent trigger가 claim/등록 receipt/head를 기존 raw purge와 같은 거래에서 정리한다. 등록·수신과 기존 HealthKit persistence 회귀 **8개 suite·79개 테스트**, 집중 재실행 **6개 테스트**가 실제 PostgreSQL에서 통과했다. 최초 회귀의 **72개 통과·1개 실패**(철회 후 claim/등록 receipt/registry head 기대 0/0/0·실제 1/1/1)는 실패 이력으로 보존했다.
- M3-02k는 **로컬 PostgreSQL 수용 완료 / 루트 최종 확인 후 그래프 완료 반영 대상**이다. export v29 owner projection, 095 DB protocol fence, 합성 자료의 실제 dump/restore와 철회 suppression replay, 동시 철회 commit/rollback에 따른 B 등록 대기·결과를 검증했다. 전체 실DB 재실행은 초기 smoke 1/1 및 1,057개 통과·3개 건너뜀·0개 실패다. 중간 export assertion 5개 실패와 첫 전체 assertion 2개·hook 8개 실패는 M3-02k에 보존했다. DB rollback 검증을 운영 이미지 rollback 증거로 사용하지 않는다. 개별 해제 runtime 계약/API와 v1→v2 API는 l, native 선택/등록/수집은 m/n, 운영 이미지 rollback·공개 배포·실기기는 o/h에 남는다. 개인 운동이 있는 현재 iPhone에서 Release collector를 실행하지 않는다. M3-02h 실기기 행은 **not_executed**다.

## M3-02l 로컬 서버 수용과 다음 작업(2026-10-05)

M3-02l은 2026-10-05 로컬 서버·계약 수용을 완료했다. 개별 해제 DTO/API·096/097 정리 worker와 좁은 권한·owner exact replay·export v30을 연결했다. 실제 객체 삭제 뒤 claim release/B 등록, 소비자 TS 6패키지, 전체 PostgreSQL 선행 1/1과 본 1,087 통과·3 건너뜀·0 실패를 확인했다. [M3-02l](progress/M3-02l.md)에 최초 전체 5실패와 좁은 1실패를 보존한다. 역사적 v1 unknown receipt 계정의 개별 해제는 failclosed이며 안전한 기존 자료 처리 경로는 M3-02o에 남는다. 다음 ready node는 M3-02m의 ACK된 UUID 범위 native 수집이다. 현재 제품 collector 실행은 계속 금지하며 m/n/o/h의 운영·실기기와 phase 독립 검토는 완료하지 않았다.

## 알려진 흔들리는 시험

- `tests/identity/session-attendance.spec.ts:123`("계획 초안 편집" 버튼이 보이지 않음)이 높은 부하(1분 load 32–40)에서 한 번 실패했고
  그 spec만 다시 돌리면 통과했다(M2-01aq 검증, 2026-09-25). 반복되면 별도 노드로 다룬다.
- `tests/identity/course-extras.spec.ts:95`(GPX 가져오기 상태 "코스를 가져왔습니다"가 5초 안에 보이지 않음)이 M2-01aq 병합 검증의 identity 2회차에서
  한 번 실패했다(1회차 통과, 제품 코드 변경 없음). 반복되면 별도 노드로 다룬다.
- `tests/identity/oidc.spec.ts:55`(두 번째 탭 계정 전환, 30초 timeout)와 `tests/identity/activity-track-map.spec.ts:446`(Vite "저장된
  경로" 영역이 5초 안에 안 보임)이 M2-01am 병합 검증의 identity 두 회차에서 각각 한 번 실패했고, 같은 코드를 포함한 M2-01ak 병합 검증
  두 회차는 모두 통과했다(2026-09-25). 반복되면 별도 노드로 다룬다.
- `tests/identity/plan-scenarios.spec.ts:287`(교차 branch 비교)이 M2-01k-o 병합 검증 identity 1회차(1분 load 약 84)에서 한 번 실패했고
  2회차는 통과했다(2026-09-26). 반복되면 별도 노드로 다룬다.
- `apps/api/tests/course-sharing.integration.test.ts` T23(분당 rate limit 창)이 M2-01an 검증의 통합 1회차에서 `expected 200 to be 404`로
  한 번 실패했고, 그 파일만·전체를 다시 돌리면 통과했다(2026-09-26). 시각 창에 기대는 단언이라 반복되면 별도 노드로 다룬다.
- `tests/identity/course-extras.spec.ts:59`가 M2-01au 검증의 identity 두 회차(1분 load 60–70)에서 실패했다(가져오기 상태 5초 timeout 한 번,
  제거본 요청의 `COURSE_ZONE_ACKNOWLEDGEMENT_STALE` 한 번). 같은 코드로 단독 6/6, 전체 ×2가 통과했다(2026-09-26). digest 불일치가 부하에서
  어떻게 생기는지는 밝히지 못했다.
- `tests/identity/garmin-unofficial.spec.ts:134`(Next shell, "인증 코드 입력 대기" 상태 5초 timeout)가 M0-06b-odbl 검증 2회차와
  EXT-OIDC 검증 1회차에서 실패했다(각각 다른 회차는 통과, 2026-09-26). **두 번 반복**됐으므로 별도 노드로 조사한다.
- main의 `garmin-unofficial-worker.test.ts`는 Python `.venv`가 필요하다. 새 worktree에서는 `uv sync`를 먼저 한다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 자체 운영 engine/data 선택·검증,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c feasibility는 실제 background wake를 포함해 실기기에서 확인했다. 미저장 Back 분기의 버튼별 기계 기록은 없고 사용자 관찰만 있다. 제품 native host 통합과 실제 인증 기반 계정 전환은 M3-01 이후 범위에 남는다.
- 공식 Garmin 권한과 허가된 실제 응답·자동 수집은 [후속 계획](research/garmin-official-deferred.md)에 남는다.
  로컬 FIT, OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.
- 임시 Garmin 경로(사용자 결정 2026-09-25): 공식 권한을 기다리는 동안 `garminconnect`로 소유자 자신의 계정에서 앱 내
  수집을 하는 M1-06b-tmp를 완료했다([결정 기록](research/garmin-temporary-gate.md)). 실제 Garmin 계정 실행은 소유자가 앱에서
  로그인해야 하는 별도 증거이며 not_executed다. 당시 EXT-G·M0-07b·M1-06b·M2-07을
  `not_started`로 두고 G2가 공식 연동을 요구하던 결정은 2026-09-27에 후속 계획으로 이관됐다.
- 사용자 결정(2026-09-25): 코스 공유(M2-01k-o) [요구](research/m2-01k-o-sharing-requirement.md)를 승인했다. 범위는 확인 뒤 소유자
  GPX(A)와 보기 전용 unlisted 링크(B, 기본 꺼짐)이며, 링크는 보호 구역이 하나 이상 있어야 한다. B는 독립 재식별 검토의 차단 항목
  (공유용 확장 원과 비밀 오프셋 등)과 T22–T25가 통과해야 켤 수 있다. 계획 문장(map-implementation-plan.md:104, :187)을 개정했다.
- 사용자 결정(2026-09-25): routing 지도 데이터를 서울 extract에서 한국 전체 extract로 바꿨다(M2-01ak 완료, graph
  `188b65effcc6ef5c`). M0-06b 증거 묶음은 [m0-06b-routing-evidence.md](research/m0-06b-routing-evidence.md)이며 독립 coverage 검토는
  새 graph로 받았다. 기존 사전등록 기준의 P8-coverage `failed`는 보존한다. 후속 새 기준은
  [실제 엔진 2회 재실행과 독립 채점](research/m0-06b-coverage-execution-m2-01az.md)을 완료해 별도 `adequate`를 받았다.
  운영 OIDC는 Google을 평가했고([평가](research/ext-oidc-google-evaluation.md): Google 단독은 prompt=login·새 auth_time·OP
  로그아웃을 못 해 탈락), 사용자가 Zitadel을 선택했다(2026-09-25). 인스턴스·등록·secret은 사용자가 준비했다.
  M0-06b는 자체 운영 GraphHopper 10.0과 OSM 한국 extract를 선택했고, 실기기 검증의 남은 항목은 위에 기록했다.

다음 세션은 working tree와 위 "다음 작업 순서"의 완료 여부를 git 기록으로 확인하고,
남은 M2-01k 수용 항목과 외부 gate를 이어 간다. 실제 외부·실환경 증거가 필요한 gate를
문서 검토나 합성 fixture로 완료 처리하지 않는다.

## 재개 결정과 서버 준비 실행 · 2026-10-05 오후

- 사용자 승인한 정확한 v4 script SHA `83c51165936b5665934ace5dfe8521d5f10439ca46dc18b58c780c8092bd1bc9`를 서버에서 13:35:03 KST에 1회 실행해 준비 설치·읽기 전용 검증이 성공했다. [EXT-HOSTING 실행 기록](progress/EXT-HOSTING.md#승인된-v4-서버-준비-1회-실행--2026-10-05)을 따른다. 기존 container·데이터는 유지, Workout503/apex200과 timer masked 유지. UID 전환·container 재생성·운영 원장/백업/복원·503 해제는 아직 미실행이다.
- 사용자가 합성 자료를 사용하는 iPhone 성능 **측정 진행**을 승인했다. 개인 HealthKit/GPS 수집을 포함하지 않으며 실제 측정 후 별도 예산을 정한다. 아직 측정값이 없어 기존 realDevice not_executed/budget null을 통과로 바꾸지 않는다.
- FUT-09는 과거 공유 계획 이식을 위한 원문·미리보기·승인 항목임을 설명했다. 전체 텍스트·Markdown·PDF·확인 가능한 export를 받거나 이식 범위를 별도로 결정한다. 원문 처리 답변은 아직 기다리는 중이며 일반 계획 편집기 개발은 계속 가능하다.

## M3-02m 로컬 native 수용과 다음 작업(2026-10-05)

등록 UUID/claim epoch 전체 목록 검증 뒤에만 제한된 native observer·anchored query·v2 outbox를 실행하도록 연결했다. 루트가 소스와 실제 합성 218 단언·arm64 네 소비자 typecheck/compile을 확인했다. [M3-02m](progress/M3-02m.md)에 실제 결과와 실패·미실행을 분리했다. 다음 ready node는 M3-02n 운동 선택 UI/native bridge다. 제품 collector의 개인 실기기 실행은 n/o 안전 통합 전 계속 금지하고, M3-02h와 phase 독립 검토는 별도다.

## 재개와 다음 작업 · 2026-10-06

- M3-02n의 명시 선택·계정 귀속 등록과 M3-02o의 비식별 감사/개별 해제/배포 준비를 phase/m3-02에 커밋했다. 로컬 수용은 [n](progress/M3-02n.md)·[o](progress/M3-02o.md), 전체 phase 검사·독립 검토 상태는 [phase 기록](progress/M3-02-phase-review-20261006.md)을 따른다. o의 실제 운영 감사·선배포·rollback과 h의 제품 HTTPS/실기기 수용은 in_progress/not_executed를 유지한다. 검토된 main 포함 여부는 최종 Git HEAD와 annotated review tag로 확인한다.
- 전체 identity 최초 완료는 공통 export helper의 28/실제 producer30 불일치로 301통과·8실패·12skip였다. 후속 focus/MFA 응답 경합도 [M3-02p](progress/M3-02p.md)에 별도로 보존·수정했다. 최종 고정 HEAD `bd625ee8`에서 두 전체 회차가 각각309통과·12skip·0실패·exit0으로 완료돼 p만 로컬 completed다. 첫 전체 phase 독립 검토는 stale native outbox의 후속 동기화 차단 P1로 REQUEST_CHANGES였다. UUID/epoch 대조·mixed 유효 tombstone 보존·새 key/원래 sequence 정리를 수정하고 State92 및 iOS15 compiler로 검증했다. 새 HEAD 전체 독립 재검토와 승인 뒤 main 병합이 다음 단계다. 실패·중단·외부 미실행을 통과로 바꾸지 않는다.
- 10월5일 UID v3의 후속 실행은 old container 정지와 ubuntu 권한 회수 뒤 sudo 판정 조건에서 fail-stop했다. 해당 정확한 1회 승인은 사용됐으며 전체 v3를 다시 실행하지 않는다. 마지막 관측에서 UID 소유권 전환과 새 container 시작은 미실행, Workout503·apex307→200·timer mask는 유지됐다. 이는 오늘의 새 서버 관측이 아니다. EXT-HOSTING 별도 branch의 부분 실행 기록 `8a78619d`와 원본 서버 record를 확인한다.
- 남은 UID 작업을 위한 정확한 resume-v2 script SHA-256 `dce43db9ab995d003a75241ef6dc5f33c82abb7da1a6b9c9457712d131466060`은 fresh context-less 독립 읽기 전용 검토를 통과했다. 설치/실행은 하지 않았다. AWS SSO 재연결 후 새 Linux 상태·copied baseline 무결성·권한을 확인하고, 정확한 새 실행 승인을 받은 다음 진행한다. 과거 v3 승인은 이 script 승인으로 전용하지 않는다. 운영 원장·전체 백업/격리 복원·503 해제는 별도 gate다.
- 사용자 답변 대기: 비루트 AWS SSO 로그인 재연결 가능 시점, HealthKit 없는 WM Synthetic Performance가 실제 iPhone에서 지도/그리기 값을 표시하고 계속 열려 있는지, FUT-09 원문 제공 또는 원문 이식 보류 결정. 합성 성능값/예산은 미확정이며 기존 제품 collector를 개인 건강 자료에서 실행하지 않는다.
- S22 추가 정책 답변 대기: generic app 동의의 처리 대상·철회 효과, generic provider를 개별 연동 기준으로 둘지 공통 상위 수집 gate로 사용할지. 별도 M2-01k 읽기 전용 대조에서 두 kind의 원장 저장은 확인했으나 실제 업무 gate consumer를 찾지 못했다. 기존 HealthKit/Garmin 결정은 유지하며 새 의미를 임의 구현하지 않는다.

## 로컬 phase 통합 최신 상태 · 2026-10-06

- M3 전체 독립 재검토는 base173d8d6 → headd132fb41 **APPROVE**, 이전 stale outbox P1 **FIXED**였다. main에 d132fb41을 fast-forward했고 clean을 확인했다. 정확한 diff·검토·실행/미실행 증거는 annotated tag `review/m3-02-20261006-registration-refresh`와 [phase 기록](progress/M3-02-phase-review-20261006.md)을 따른다. 앞선 대기/수정 중 문단은 그 시점 기록이며 o/h 운영·실기기 gate는 여전히 in_progress/not_executed다.
- 병렬 M2 URL callback 로그·S22 준비는 [M2-01k §44](progress/M2-01k.md#44-url-로그s22-준비-전체-phase-통합-검증2026-10-06)의 고정 입력에서 전체 unit4398·PG1095(+upgrade1/pgoutput7) 및 identity 두 회차각309통과/12skip를 실제 확인했다. 승인된 main 위에 통합했고 exact diff의 독립 phase 검토는 이후 APPROVE를 받아 main `6b46cf30`에 반영됐다(`review/m2-01k-20261006-url-consent-preparation`). app/provider 정책 답변과 운영/기기 증거를 로컬 검사로 대신하지 않는다.

## S22 확정 고지 회귀 후속 · 2026-10-06

- [M2-01k-u](progress/M2-01k-u.md)는 명시 mutation 전 고지/권한 분리와 이전 계정의 늦은 삭제 응답 보호를 테스트 세 파일에 보강했다. Root 집중64/64 재검증 및 phase 고정 입력79fc5d34에서 unit4401, PG1095(+upgrade1/pgoutput7), identity 실제2회 각309/12skip와 전체 gate를 확인했다. final 문서 포함 새 independent phase review는 별도로 진행한다. app/provider 새 업무 gate는 정책 답변 대기이며 V2-F31 partial과 운영/기기 미실행은 유지한다.
- 출시 잔여 감사에서 M2-02는 계약만 구현된 상태임을 다시 확인했다. 별도 phase/m2-02에서 명령 계약 및 PostgreSQL 후속 저장 작업을 분리 진행하며, 이 S22 phase 검증에 그 다른 브랜치의 결과를 포함하지 않는다.

## 실제 AWS UID 재개 결과 · 2026-10-06

- 사용자 새 CLI 로그인 완료 후 비루트 `workout-admin` 신원과 pinned recovery SSH를 확인했다. 새 v2 설치/검사/1회 실행을 명시 승인받았다. 정확한 script SHA `dce43db9ab995d003a75241ef6dc5f33c82abb7da1a6b9c9457712d131466060`을 root0700 경로에 독점 설치했고 `--check` exit0, `--execute --external-gates-confirmed` **정확히 1회 exit0 / UID_RESUME_LOCAL_CHECKED**였다. 이전 v3 실패/보존본은 덮지 않았다.
- 별도 fresh Ubuntu 단기 SSH에서 root 권한 거절·8개 write 및4개 private read 거절을 실제 확인했다. 이어 recovery 읽기 전용 posttransition 점검은 **2026-10-06 11:18:18 UTC exit0**: 현재 앱/GH fixed image·UID20001/20002·세 runtime identity, 원본 PG/system ID·schema/slot/publication metadata 유지, 전체 tree/mount·original13/copy7 보존본·current fence pin·source digest·timers masked·Workout503/TLS0·apex307→persona200/TLS0를 확인했다. posttransition payload 자체의 freshSSH 미실행 표시는 그 payload 범위이고 별도 SSH 실행 로그와 구별한다.
- 원본 로그 `/private/tmp/wm-uid-resume-v2-{install,check,execution}-20261006.log`, `/private/tmp/wm-fresh-ubuntu-readonly-20261006.log`, `/private/tmp/wm-uid-posttransition-readonly-20261006.log`. 이 결과는 UID/runtime 전환의 실제 증거다. backup fence의 실제 held window·운영 원장/키/slot/tail·full backup/upload/격리 restore·latest product/serverfirst migration·503 해제와 공개/native 수용은 여전히 **not_executed**다. EXT-HOSTING 전체 완료가 아니다.

## 사용자 결정 기록 · 2026-10-07 대회·기록

- S16 PB: 공식 확인된 대회 기록만 포함. 수동·미확인·기기 추정 split은 공식 PB로 승격하지 않는다. M2-02j로 구현·실제 수용을 추적한다.
- 대회 날짜 변경: 기존 미해결 상대 일정은 안내하며 보존하되 이번 변경으로 영향을 받는 미해결 일정은 승인 전에 해결한다. M2-02i의 freshness/영향 판정·명시 승인에 반영하며 자동 해소나 임의 race end를 만들지 않는다.

## 2026-10-07 M2-02k 동의 화면 수용

- Race6 create/update app admission의 actualPG96/96, HTTP 신규11/11·기존actual5/5에 이어 새 계정 app panel·거절 초안 UI를 실제 OIDC Next/Vite2/2로 검증했다. 별도 Chrome16 layout/focus 및 재동의/logout2 checks, Aside 실제 grant/revoke/초안 snapshot과 각 도구 한계를 [K 기록](progress/M2-02k.md)에 구분한다.
- K completed; M2-02i 날짜 영향 전체 atomic 승인과 M2-02j 공식 PB는 in_progress다. 현재 phase의 full gates·독립 phase review 전 main으로 병합하지 않는다. HTTPS·실기기·provider 결과를 승격하지 않는다.

## S22 확정 처리 정책과 후속 실행 · 2026-10-06

사용자는 app 동의를 핵심 계획·실제기록·대화 저장/처리 허가로 정의하고, 철회 후 새 처리 금지·기존 조회/export/delete 허용을 승인했다. 부재는 false/revision0이며 자동 동의하지 않는다. generic provider는 호환 기록만 유지하고 HealthKit/Garmin 개별 허가를 유지한다. 새 M2-01k-v-a~f가 공통 admission·직접 처리·versioned basis·영양/회복/루틴·provider worker·UI/native 연결을 분리한다. 준비 대조는 읽기 전용이며 실제 gate 완료가 아니다. 독립 library/gallery/course authoring 전체를 이 동의 목적으로 임의 확대하지 않으며, actual 첨부·코칭 retrieval의 core 처리 경계는 포함한다. 기존 성공 receipt는 새로운 app gate 이전에 재반환하되 AI/HK 철회·redaction 의미를 우회하지 않는다. 같은 tenant lock0→기존 domain lock 순서를 지켜 철회와 처리 거래를 직렬화한다. strict manifest v1/v2에 필드를 임의 추가하지 않고 명시 version compatibility를 만든다. 완료/전체 검증/phase review 전 main에 넣지 않는다.

## S22 처리 경계·화면 로컬 수용 · 2026-10-07

M2-01k-v-a~f의 각 로컬 구현·수용이 완료됐다. Root 통합 화면RTL274/274와 두Host 실제Chrome E2E4/4를 확인했고 native fixed app 계약은 별도M3-02q 로컬55시험/Swift40/SDK로 추적한다. 운영 제공자·기기·전체 backup/복원·생리학 결과가 아니다. M2-01k 부모와 phase 전체 검사·fresh context-less 독립 검토는 다음 단계이며 최신HEAD 검토 이전 main에 넣지 않는다. 과거 검토 승인과 전체 gate 기록은 그때의 고정입력에만 적용한다.

## 사용자 결정 갱신 · 2026-10-07 PB·대회 삭제

- 앞선 “공식 확인된 대회 기록만 PB” 결정은 새 사용자 답변으로 대체한다. 직접 입력한 대회 기록도 PB에 인정한다. 링크나 인증 첨부가 있으면 인증 마크를 제공한다. 첨부 존재와 실제 진위 검토 완료는 구분하며, 마크가 서버·공급자 검토 증거를 만들어내지는 않는다. 기기 추정 split의 대회 기록 자동 승격은 허용하지 않았다. chip/gun 분리와 종목별 거리 분류는 제안에 대한 명시 답변이 없어 아직 미확정이다. M2-02j의 기존 수용 기록은 당시 입력의 역사로 보존하고 새 정책 구현·검증을 별도로 수행한다.
- 대회를 삭제하면 대회 시각을 바탕으로 이미 승인된 영양 일정은 연결 해제로 표시한다. 음식·수량·실제 섭취 기록은 보존하며 재연결·재승인 전까지 그 시각 사용을 중단한다. M2-02i의 versioned writer/read projection·freshness·원자적 승인·삭제 갱신 수용에 연결한다. 이 결정 기록만으로 제품 동작을 완료 처리하지 않는다.

## 로컬 M2-02 후속 최신 상태 · 2026-10-07

- phase/m2-02의 루틴·회복 export34는 `fc99ff6a`, 공통 영양 계산 추출은 `96aa39a3`로 커밋했다. [L](progress/M2-02l.md)과 [I](progress/M2-02i.md)의 실제 수용·한계를 따른다. main은 `1d557358` clean이며 새 phase 병합·push는 하지 않았다.
- [I의 운영 조회 V5](progress/M2-02i.md)는 계약→한 snapshot reader→API→실제 planner 패널을 미커밋 구현했다. Root unit191, 강제 consumer TS36/cached0, 루트 TS·contracts·Next/Vite build·변경 lint/format은 실제 통과했다. 실제 PG/browser는 NOT_EXECUTED, public V2 writer·영구 disconnect·명시 재연결/재승인·copied-body lifecycle·historical reader·전체 atomic 승인은 미완료다. 기존 source/history/export/restore를 로컬 mock으로 수용하지 않는다.
- [J](progress/M2-02j.md)의 직접 입력 PB 안내·링크 첨부 표시도 미커밋이며 PB 계산·manual 첨부 저장은 미완료다. chip/gun·거리 분류 답변과 현재 미연결32개 shared-memory 정리 승인을 기다린다. 앞선31개 정리 승인은 재사용하지 않는다. 승인이 오면 실제 자원 상태를 재확인하고 PG/browser 검증을 재개한다.

### 실제 DB 검증 차단 해소와 병렬 후속 · 2026-10-07

Root는 설치된 PostgreSQL17.6 Docker 이미지의 localhost 전용·tmpfs·host-volume 미연결 일회용 서비스에서 V5 실제 SQL/RLS/cap/snapshot **8/8**을 확인했다. 입력268개 변화0, suite DB/role 각각0이며 [I의 최신 기록](progress/M2-02i.md)을 따른다. macOS IPC 삭제0이다. 앞선32개 정리 승인 대기는 이 실제 DB 시험을 더 이상 차단하지 않는다. 실제 browser는 아직 미실행이며 canonical identity fixture가 이 Docker 경로를 쓰도록 별도 opt-in 준비 중이다. 기본 local fixture·보안 gate는 유지한다.

V3 disconnected 계약과 계산은 V1/V2 strict 의미를 유지하면서 새 상태를 표현한다. Root 계약55시험 및 actor helper79시험, contracts build/persistence TS를 확인했지만 authoritative marker·물리 삭제·API/current/history·receipt/export/restore·명시 재연결/재승인은 계속 구현 중이다. 번호108의 신규 storage migration, V3 영양 조회 API, 외부 일회용 PG17 identity fixture를 native agent별 분리 소유 범위로 병렬 진행한다. 미등록 migration 초안이나 합성 계약을 실제 privacy/승인/출시 통과로 표시하지 않는다. main은 `1d557358` clean으로 재확인했고 병합·push0이다.

## 실제 연결 해제·화면 검증 후속 · 2026-10-07

사용자의 대회 삭제 결정은 기존 영양 음식·수량·실제 섭취를 보존하고, 연결 해제 표시 후 재연결·재승인 전까지 대회 시각 사용을 중단하는 것이다. 미등록 SQL108의 실제 PG17 집중 시험13/13을 통과했으며 생성 DB·역할 잔존0이다. 첫 invalid meal fixture 실패는 별도 보존한다. 자세한 한계는 [I 기록](progress/M2-02i.md)에 있다. 정상 V2 승인·복원/export35·copied-channel 처리·명시 재연결은 여전히 미완료다.

Playwright 실제 identity 대회 화면 E2E는 Next/Vite 두 shell **2/2 통과·exit0**(`/private/tmp/wm-pb-ui-pg17-20261007-r4/actual.log`)했다. R1 fixture startup 실패, R2 Chromium 부재, R3 Bob app 동의 누락에 따른 정상409를 각각 별도 보존했다. Bob에게 명시 동의를 추가한 뒤 기존 foreign404 기대값을 유지했다. 브라우저와 정상 public107은 실제 실행했지만 IdP·운동 자료는 합성 fixture다. PB 순위 계산·인증 자료 진위 검토·iPhone 증거가 아니다. fixture DB/역할 정리0/0을 확인했다.

V3 receipt 소비자와 replay-only API는 원 승인 tuple만 반환하며 receipt 없음을 새 저장으로 바꾸지 않는다. 집중 unit30 및 API10·타입 검사·lint/format은 통과했다. 후속 실제 PG17 receipt/V3 조회6시험도 모두 통과했고 임시 DB·역할 잔존0이다. 첫5PASS/1FAIL과 숫자 표기·Unicode 시험 가정 수정은 I 기록에 별도 보존한다. Offline 역사 fixture를 공개 V2 승인 증거로 세지 않는다. Root는 graph·API·실행 자원을 소유하고 native agents는 receipt 실DB 시험과 exact copied-channel 설계를 분리해 계속 진행한다. main 병합·push0, I/J와 phase 상태는 진행 중이다.

## 2026-10-07 copied-source·증빙 후속

Root 실제 copied-source unit26 및 V4 PG17 승인 회귀19, compatible V3 preview PG17 R2 3, 관련 계약 회귀141과 수동 증빙 계약38/contracts build를 확인했다. 실패했던 startup과 시간 기대값 시험은 별도 로그로 보존하며 [I](progress/M2-02i.md), [J](progress/M2-02j.md)의 최신 범위·한계를 따른다. main `1d557358`은 clean, phase 병합·push0이다.

Native 병렬 작업은 SQL108의 exact copied-channel 처리, immutable V2 pin과 분리한 proposed-after 계산, 수동 증빙의 저장용 redacted lifecycle 계약으로 나눴다. Shared registry/grants/restore/graph는 Root 소유다. 미등록 migration·합성 fixture를 공개 승인·privacy restore 또는 출시 완료로 세지 않는다. AWS CLI token 만료와 새 recovery-v1 정확 실행 승인, iPhone 연결/합성 측정, PB 비교 기준 및 FUT-09 원문은 질문 대기다. 기존 실패 drill 승인을 새 artifact 실행에 재사용하지 않는다. macOS IPC32 정리는 승인 대기지만 Docker PG17 검증을 차단하지 않는다.

## 최신 bounded source 검증 체크포인트 · 2026-10-07

- 현재 작업 branch/worktree는 `phase/m2-02` / `.claude/worktrees/phase-m2-02`이며 HEAD `1679d8c5`다. 완료 자기보고 frozen source는 `fba081ff`, owned immutable course projection은 `21c0b11b`, manual intake retained read 및 실제 recorded lineage는 `1679d8c5`로 커밋했다. 위 이전 “미커밋” 기록은 당시 상태이며 최신 구현은 [I progress](progress/M2-02i.md)를 따른다.
- 최종 scoped unit327/327, 공개 producer 기반 실제 합성 PG17 context63+course lineage9=72/72, persistence/API TS·변경 lint/format 통과, 전용 DB/역할 잔존0이다. 앞선 실패 로그는 각각 별도 보존한다. external object bytes·live provider·AWS/HTTPS/iPhone/전체 archive restore 증거로 승격하지 않는다.
- normal migration registry107·기본 export34를 유지한다. raw SQL108–113와 명시 read/writer/export35 시험을 configured 제품 활성화로 세지 않는다. full collector missing5/authority none/freshness not_checked, I/J/phase in_progress다. 전체 phase gates와 fresh context-less gpt-6-sol high 독립 phase 검토 전 main 병합 금지; push는 사용자 작업이다. main `1d557358` clean을 재확인했다.
- 다음 native 병렬 작업은 manual Activity retained read exact correspondence 포트, workout template의 full immutable catalog source, purpose-bound 저장 체인의 missing gate 조사다. Root가 공통 capture/consumer/graph를 통합하고 실제 DB 수용을 수행한다. agent 단위 통과만으로 full source permission·semantic freshness/all-domain approval 완료를 선언하지 않는다.
- PB chip/gun·거리 분류, FUT-09 원문과 기존 AWS recovery-v1 정확 실행 승인/새 로그인·iPhone 합성 측정 질문은 기존 대기 상태를 따른다. Docker 경로가 있으므로 새 macOS IPC 일괄 삭제는 현재 DB 검증에 필요하지 않다.

## bounded manual Activity/workout source checkpoint · 2026-10-07

- phase/m2-02 구현 HEAD는 `414ca07c`다. manual retained Activity와 frozen workout source/consumer를 실제 공개 producer·normal107에서 검증해 커밋했다. [I progress](progress/M2-02i.md)의 최신 검증·실패·한계를 따른다. unit455/455, full context PG65/65, 별도 앞선 context64+workout helper6의70/70은 겹치는 결과이며 합산하지 않는다. TS/API TS·변경 lint/format·diff와 테스트 DB/역할 잔존0을 실제 확인했다.
- routine actual의 exact current/deleted manual source correspondence와 workout 원본·generated target·역사 head 분리를 검증한다. provider/역사 Activity 본문 부재·resource/media permission 누락을 포트 존재만으로 통과시키지 않는다. full capture missing5/none/not_checked, purpose 저장·전체 semantic freshness/atomic approval·archive/restore·운영/기기·full phase gates/독립 phase review는 미완료다. graph I/J/phase in_progress, registry107 및 main `1d557358`/push0을 유지한다.
- 다음 병렬 준비는 workout resource/media retained-read 권한 경계 조사와 exact immutable candidate codec/storage inventory 조사다. 공통 파일·graph와 통합은 Root 소유다. PB chip/gun·거리 분류 질문과 FUT-09 원문, AWS recovery-v1 정확 실행 승인/로그인·iPhone 측정 대기는 기존 상태를 따른다. 대회 삭제 시 승인 영양은 연결 해제 및 재연결·재승인까지 대회 시각 사용 중단이라는 사용자 결정을 유지한다.

## text resource source checkpoint · 2026-10-07

- phase/m2-02 구현 HEAD `0d4b59c6`에 exact own text resource 본문·version/hash/문단·current access tuple 및 workout/full consumed 검증을 커밋했다. Root unit522/522·actual PG77/77·persistence/API TS·lint/format·diff·전용DB/roles 잔존0이며 [I progress](progress/M2-02i.md)의 실패·한계를 따른다. 텍스트 현재/역사 원본을 유지하고 공개 삭제 후 소비를 차단한다. file/URL은 합성metadata producer만 검증했고 실제bytes/fetch0, 미디어 포트·전체 freshness/atomic 승인·저장/lifecycle/restore·운영/기기·독립phase review는 미완료다.
- 다음 병렬 작업은 actual calendar projector에 근거한 routine schedule current/historical source companion, normal107 public producer PG 준비, Root actual calendar intent capture seam 조사다. Root가 공유 context/complete/graph를 통합하며 runnable I/J/phase 상태는 in_progress다. registry107/main `1d557358`/push0 및 기존 사용자 결정 대기는 유지한다.

## calendar intent·routine source checkpoint · 2026-10-07

- phase/m2-02 구현 HEAD `27583d6f`에 actual calendar intent/collector selection과 frozen routine schedule current/history source 검증을 커밋했다. Root 단위577/577·actual context67+preview16=83/83, 별도 unchanged helper7/7 및 TS/API TS/lint 통과, 테스트DB/roles 잔존0이다. 초기PG88/90·TS 오류·문서 format 실패는 보존하고 수정 내용을 [I progress](progress/M2-02i.md)에 구분한다. 일정/계획은 hypothetical preview로 읽으며 직접 변경하지 않는다.
- 현재 native 병렬 작업은 미디어 current owned descriptor/immutable ledger/narrow cleanup correspondence helper와 정상 public producer DB 시험 준비다. Root가 shared capture/consumer·graph를 통합한다. source fact는 binary 존재·외부 삭제·처리 동의·승인 권한을 증명하지 않는다. V4 candidate codec/storage/lifecycle successor 선결도 읽기 전용 조사 중이다.
- registry107, full missing5/none/not_checked 및 I/J/phase in_progress를 유지한다. 대회 삭제 후 영양 연결 해제와 재연결·재승인까지 대회 시각 사용 중단 결정은 전체 writer/restore 수용까지 진행 중이다. main `1d557358`/push0, 독립 phase 검토·운영/실기기 gate 및 기존 사용자 결정 대기는 변경 없다.

## media descriptor checkpoint · 2026-10-07

- phase/m2-02 구현 HEAD `e13b5248`에 own current media DTO·immutable original/preview ledger·별도 locator fingerprint·exact narrow cleanup correspondence 및 full 캡처 연결을 커밋했다. Root unit716/716, 실제 helper PG8/8와 full context68+preview16=84/84, TS/API TS/lint/format/diff 통과, 전용DB/roles 잔존0이다. 초기7/8·714/716 실패와 수정은 [I progress](progress/M2-02i.md)에 보존한다. normal107의 SQL113 부재는 소비 검증 차단이며 configured 제품에서 통과했다고 주장하지 않는다. 외부binary 존재/삭제·처리 허가·승인 권한0이다.
- 다음 bounded native 작업은 V4 readonly candidate successor용 strict calendar output codec 신규 두 파일이다. Root가 shared export/typed adapter/storage inventory/lifecycle·graph를 통합한다. registry107, full missing5/none/not_checked, I/J/phase in_progress·독립phase/full gates 미완료 및 main `1d557358`/push0 상태를 유지한다. 대회 삭제 영양 시각 중단 결정과 기존 PB 비교 기준/외부 게이트 대기는 앞선 기록을 따른다.

## strict V4 calculation checkpoint · 2026-10-07

- phase/m2-02 구현 HEAD `907f8c36`에 strict calendar/V4 relative output codec·기존 input/timing/expansion 및 consumed capture/scope named exports·실제 projection 소비 연결을 커밋했다. Root unit345/345, actual preview PG16/16 및 source-linked routine 한 사례1/1, coaching/persistence/API TS·linter/format/diff 통과, 전용DB/roles 잔존0이다. context 나머지67건은 이 집중 run에서 미선택이며 pass로 세지 않는다. [I progress](progress/M2-02i.md)의 초기15/16 출력한도 회귀 및 TS/fixture 실패를 보존한다.
- 내부 finite producer BodySchema와 외부 successor4MiB EnvelopeSchema를 분리해 기존 큰 계산 결과 및 preview 결합4MiB·CONTEXT_LIMIT 의미를 유지한다. strict parsing은 actual ownership/최신성/저장/승인 권한이 아니다. explicit resolution itemId max200과 SQL106/schema1/9kind는 유지했으며 명시 successor가 필요하다.
- 다음 bounded native 작업은 V4 readonly manual candidate assembler 신규 두 파일이다. binding restoreGeneration은 실제 UUID이며 숫자 legacy generation과 섞지 않는다. Root가 후속 typed original capture/intent adapter·new finite copied-source inventory/lifecycle·purpose chain/atomic writer·graph를 직렬 통합한다. registry107, full missing5/none/not_checked와 I/J/phase in_progress·full gates/독립phase review 미완료/main `1d557358`/push0 및 기존 사용자 결정·외부 gate 대기를 유지한다.

## V4 readonly 초안·공통 포트 checkpoint · 2026-10-07

- phase/m2-02 구현 HEAD `9e073e71`에 strict schema2 V4 transient manual draft assembler와 shared captured calculation ports를 커밋했다. Root unit41/41·actual preview PG16/16·coaching/persistence/API TS·linter/format/diff 통과, 테스트DB/roles 잔존0이다. 초기 fixture·format 및 actor 실패는 [I progress](progress/M2-02i.md)에 보존한다. bodychecksum은 인증/최신성/저장권한이 아니며 none/not_checked/not_persisted/approvalAllowedfalse와 missing5를 유지한다.
- native actor `s22_api_gate_design`은 same snapshot actual original context/intent→readonly preparation-v2 신규 source/integration 두 파일을 구현 중이다. actor `ai_settings_dispatch_gap`은 CandidateV2 본문만 대상으로 finite copied-source inventory-v2 신규 source/unit 두 파일을 구현 중이다. 각 actor 파일은 독점이며 shared exports/context/graph·실제PG·Git 통합은 Root 소유다. inventory의 구조적 indexed 결과는 full capture/source permission/lifecycle coverage가 아니다.
- 다음: actor 동결 소스·검증 읽기→Root 실제 PG/통합→후속 lifecycle/purpose chain/semantic freshness/전체 affected-domain atomic writer 수용. I/J/phase in_progress·registry107·main `1d557358`/push0 및 fullphase gates/독립phase review 미완료를 유지한다. 대회 삭제 시 영양 연결 해제·재연결/재승인 전 시각 중단, 기존 PB 비교 기준/FUT-09 원문/AWS recovery 정확 승인·로그인/iPhone 합성 측정 대기는 변경 없다.

## copied-source inventory checkpoint · 2026-10-07

- phase/m2-02 구현 HEAD `a5378315`에 finite CandidateV2 fullbody8kind inventory를 커밋했다. Root actual unit39/39·persistence TS·lint/format/diff 통과. opaqueID/semantic array·exact tuples·retained copies/fragment/derived/reference-only와 input/output4MiB/visit5000을 보존한다. allCopiedBodiesIndexed는 후보 구조 범위이며 full context·source permission/ownership/lifecycle/저장/승인은 별도다. [I progress](progress/M2-02i.md) 참조.
- readonly preparation-v2 source/integration 두 파일은 actor `s22_api_gate_design` 소유 미커밋이다. actual PG R1 7/8, R2 8/9 실패와 DB/roles잔존0을 기록했다. V4 positive 실제 검증은 통과했고 resource 삭제 negative는 saved blueprint만 있어 실제 schedule 소비 연결을 수정 중이다. 원본 guard/limit은 유지하며 Root가 동결 후 actualPG 재실행한다.
- actor `s22_phase_gate_checks`는 실제8namespace owned current/historical reader seam과 다음 reconciliation pair를 읽기 준비 중이다. shared context/exports/graph/PG/Git는 Root 소유. I/J/phase in_progress·registry107·main `1d557358`/push0·fullphase gates/독립phase review 미완료와 기존 사용자 결정/외부대기는 유지한다.

## readonly snapshot preparation checkpoint · 2026-10-07

- phase/m2-02 구현 HEAD `49dab990`에 same fenced snapshot 기반 readonly V4 preparation과 server subpath를 커밋했다. Root actual PG9/9·persistence/API TS·lint/format/diff 통과 및 테스트 DB/roles잔존0이다. 정상107과 explicit raw108/109/110 staging V4를 구분한다. 실제 public 승인 schedule→Resource 소비를 확인한 뒤 삭제가 prepared_blocked와 원 blocker/contentless 사실을 유지함을 검증했다. R1/R2 fixture 실패는 [I progress](progress/M2-02i.md)에 보존한다. none/not_checked/not_persisted/no approval 및 missing5를 유지한다.
- actor `s22_phase_gate_checks`가 NEW owned-source-inventory-v2 source/unit 두 파일을 구현 중이다. actual same tx8namespace current/historical row·exact DTO/full tuple/hash 대응, 기존 SourceBudget/grantOperations/RLS만 사용하고 private grant·registry·SQL authority는 변경하지 않는다. actor `s22_api_gate_design`은 NEW owned helper integration 한 파일의10case publicproducer PG 준비안을 완료했고 sourceAPI/shape 동결 후 구현한다. Root가 공유/PG/Git/graph를 직렬 통합한다.
- 다음 실제 owned source 수용 뒤 purpose chain·full context copied lifecycle/restore·semantic freshness/전체 atomic writer가 필요하다. I/J/phase in_progress·registry107·main `1d557358`/push0·fullphase gates/독립phase review 미완료 및 기존 사용자 결정/외부대기는 유지한다. goal은 전체 graph/출시이며 이 readonly 부분의 통과를 완료로 취급하지 않는다.

## Actual owned-source 대응 검증 및 다음 SQL 관측 · 2026-10-07

- `phase/m2-02` 구현 HEAD `e19c77b8`에 CandidateV2 copied full body 8종의 same-transaction own source 대응을 커밋했다. Root 결합 단위64/64·actual PG8/8·persistence/API TS·lint/format/diff 통과, 실제 테스트 DB/roles잔존0이다. R1 fixture3실패와 R2 실제 삭제 null body 결함을 보존하고 exact tombstone 검증으로 수정했다. 자세한 증거·SHA·한계는 [I progress](progress/M2-02i.md)에 있다.
- `s22_phase_gate_checks`의 NEW SQL114 `observe_manual_review_owned_source_bindings_v2`와 integration 한 파일은 작업 중이며 해당 커밋에서 제외했다. SECURITY INVOKER/static8namespace/RLS/actual immutable historical row의 UTC full-row hash를 관측하는 단계다. Root 번호예약만 했고 registry107 및 public activation은 변경하지 않았다. `s22_api_gate_design`은 동일 snapshot typed consumer의 최소 준비를 읽기 전용으로 진행한다. Root가 공통 파일/Git/실DB/graph를 통합한다.
- DTO checksum은 SQL full-row hash가 아니며 copied body coverage는 full context permission/lifecycle/restore 수용이 아니다. helper budget의 실제 수용과 capture+preview 전체 physical transfer 한도를 구분한다. none/not_checked/not_persisted/no approval·missing5, I/J/phase in_progress·main `1d557358`/push0·전체 phase gate/독립 검토 미완료를 유지한다.
- 대회 삭제 후 승인 영양의 연결 해제·재연결/재승인 전 시각 사용 중단 결정을 유지한다. PB 비교 기준/FUT-09 원문/AWS recovery 정확 실행 승인·로그인/iPhone 합성 측정의 기존 대기는 변경 없다. 이 slice에는 UI/browser/운영/device 실행0이다.

## SQL114·same snapshot 소비 실제 수용 · 2026-10-07

- `phase/m2-02` HEAD `39265dbd`: 미등록 SQL114 actual owned full-row 관측(`89499094`)과 typed same snapshot 소비(`39265dbd`)를 커밋했다. Root actual PG는 각각9/9·8/8 exit0이며 persistence/API TS·scopedlint/format/diff 및 실제 DB/roles잔존0이다. SQL114 R1/R2 fixture/aborted 거래 실패는 [I progress](progress/M2-02i.md)에 보존했다. 정상 registry107+explicitraw114 수용이고 public writer activation0이다.
- 소비자는 실제 transaction/role/tenant/isolation/orderedidentity/refs digest와 owned DTO correspondence를 대응한다. sourceRowDigest는 PG whole-row UTC JSONB SHA256이며 DTO checksum과 구분한다. 원 consumed blocker와 contentless unavailable를 유지하며 sourceCompleteness unverified·authority none·freshness not_checked·storage not_persisted·admission/approval false다.
- 다음 native 병렬 작업: `s22_api_gate_design`이 consumer integration 한 파일에서 별도 raw108/109/110+114 publicV4 multipin fixture 수용을 준비한다. `s22_phase_gate_checks`는 consumer→preparation→preview→initial/recapture→helper/observer의 request-wide physical budget seam을 읽기 전용으로 조사한다. Root는 shared files/manifest/PG/Git/graph를 직렬 통합한다. baseline8 consumer 수용을 V4 multipin 수용으로 확대하지 않는다.
- 전체 purpose chain·fullcontext source permission/copied lifecycle/restore·semantic freshness/all-domain atomic approval·UI/E2E/fullphase 검토는 미완료다. request physical transport는 owned_transfer_only/not_verified다. I/J/phase in_progress·main `1d557358`/push0 및 기존 외부 not_executed/사용자 결정 대기를 유지한다.

## 다음 요청 budget·V4 staging 병렬 범위 · 2026-10-07

- `phase/m2-02` checkpoint `758df308`에서 SQL1149/9와 baseline consumer8/8 actualPG 커밋/증거를 보존한다. 이후 source/test 변경은 이 통과 범위와 별도 검증한다.
- `s22_phase_gate_checks`가 request-wide bounded source-response 예약 구현을 맡았다. 독점 범위는 context/preview/preparation-v2/owned-source-inventory-v2/owned-binding-consumer-v2 source5파일과 NEW race-request-source-budget.integration.test.ts다. initial+recapture 같은 SourceBudget, root body 전 scalar 예약, Node→DB 로컬 refs와 source-response 구분, SQL observer MATERIALIZED 1회 응답 gate/중복charge 제거가 목표다. 정확 PostgreSQL wire/TLS 계측은 아니므로 aggregatePhysicalTransfer:not_verified를 유지한다. actor DB/Git/공유manifest 수정0, Root actualPG/통합 이후만 수용한다. 조사 원문 `/private/tmp/wm-race-request-transfer-budget-plan-20261007.md`.
- `s22_api_gate_design`은 consumer integration 한 파일만 맡아 baseline8+별도 V4 staging1 수용을 준비한다. 추가 prefix는 DB owned_binding_v4_stage_, roles owned_binding_v4_owner_/app_다. source5파일과 쓰기 범위가 겹치지 않는다. 정상107+raw108/109/110/114 actual multipin original1/current2/target3과 current fullrace SQLref1·역사fragment 분리를 시험한다. 실제PG는 아직0이며 Root가 두 actor 최종 입력을 확인해 실행한다.
- phase/I/J/registry107/main/push 및 기존 authority/approval 미완료·외부/사용자 결정 대기는 변경 없다. fullpurpose/copied context lifecycle/restore/all-domain approval/UI/E2E 수용은 후속으로 계속 필요하다.

## Request 예약·V4 multipin 최종 검증 · 2026-10-07

- phase/m2-02 구현 HEAD `3466c54c`: 같은 SourceBudget를 initial/recapture/preparation/owned/SQL observer까지 전달하고 body 전 선예약·single-call 응답 gate·독립 ingress/counter 한도를 커밋했다. Root 단위67/67, actual PG budget6+consumer9+owned8=23/23 및 context68+preview16+preparation9=93/93, 해당 회차 실DB116/116이다. R1 21/23 실패와 fixture 교정을 [I progress](progress/M2-02i.md)에 보존한다. source5 실행 전후 동결 SHA 일치, actual DB/roles잔존0이다.
- consumer9에는 별도 raw108/109/110/114 public V4 multipin 수용1개가 포함된다. 원 rev1/current2 및 미할당 target3·현재 fullrace SQLref1·과거 timing fragment 구분을 실제 소비까지 확인했다. 정상registry107/publicrollout/approval 권한 완료는 아니다.
- Root scoped persistence tracked-source+newbudgetfixture TS 및 API TS/변경9파일 lint/format/diff exit0다. 독립 fullcopied mapper WIP를 제외한 scope이며 whole persistence TS의 해당 WIP tuple 오류2건(exit2)을 별도로 기록했다. fullphase TS/gates로 바꾸지 않는다. UTF8 보수적 source-response 예약과 정확 wire/TLS/작은metadata/count 계측을 구분하고 aggregatePhysicalTransfer:not_verified를 유지한다.
- `s22_api_gate_design` 소유 NEW full-copied-inventory-v2 source/test는 별도 구현 중이다. context/sourceInput/candidate 모든 실제 copied path와 기존8+recovery+food/catalog/manualactual/course/resource/media/timer의 actual strict tuples를 map하고, schema에 없는 identity/provenance만 genuine unindexable로 보존한다. core8-only로 범위를 대체하지 않는다. actor DB/Git/공유파일 변경0; Root export/검증/통합 후만 수용한다.
- `s22_phase_gate_checks`는 전체copied 채널의 existing grant/RLS·immutable/current actual row·DTO/SQL hash·delete/withdraw tuple 및 후속 readonly SQL 대응 포트를 읽기 전용으로 조사한다. DDL예약/privategrant/positive store0이며 fullmapper actor와 native로 조율한다. Root shared files/registry/graph/Git/실DB를 직렬 통합한다.
- PB chip/gun 분리·공식 종목별 비교 질문을 다시 띄웠으며 답변 전 결정 대기로 유지한다. 전체purpose chain/copied lifecycle/restore/freshness/all-domain atomic approval·UI/E2E/phase review/main/push와 외부gate는 아직 미완료다. 현재 main `1d557358`이다.

## 전체 copied body inventory 및 exact food 조회 후속 · 2026-10-07

- `phase/m2-02`에서 fullcopied typed mapper 27identity와 기존 exact food reader 추출을 연결했다. immutable/observation/fragment·실제 copiedLocation payload digest를 구분하며 authority none/not_checked/not_persisted 및 missing5를 유지한다. 공개 subpath만 추가하고 HTTP/product writer 활성화0이다.
- Root unit98/98, 실제 PG food7/7 + fullcopied public4/4 R2 + 기존 nested 회귀2/2(66 filtered skip), scoped persistence/API TS·lint/format/diff 및 actual DB/roles잔존0이다. 최초 fullcopied PG3PASS/1FAIL과 actor static/unit 실패는 별도 보존한다. 자세한 입력 SHA와 로그·scope는 [I](progress/M2-02i.md)의 최신 수용 절을 따른다. 전체channel DBpositive/whole phase gates나 lifecycle/storage/approval 완료로 확대하지 않는다.
- Native 병렬은 NEW full-owned DTO adapter pair, 미등록 SQL115 relation-group observer/PGfixture pair, 남은 public channel PGfixture에 각각 비중복 소유를 배정했다. Root가 manifest/graph/Git·실제 DB 실행을 직렬 통합한다. registry107/I/J/phase in_progress·main `1d557358`/push0, 대회 삭제 영양 연결 해제·재연결/재승인 전 시각 사용 중단 및 기존 PB/FUT-09/AWS/iPhone 대기는 유지한다.

## 외부 상태 재확인 및 병렬 구현 범위 · 2026-10-07

- Root 실제 `aws sts get-caller-identity --profile workout-admin --region ap-northeast-2`는 exit255, SSO token expired/refresh failed였다. 새 로그인 가능 여부를 질문했다. 인증 재개가 정확 recovery-v1 실행 승인을 대체하지 않는다. 서버 상태·운영 백업/복원·503 해제는 실행하지 않았다.
- `xcrun devicectl list devices` 실제 exit0 JSON(`/private/tmp/wm-device-status-root-20261007.json`)에서 iPhone15ProMax/OS27.0은 paired, tunnelState unavailable이었다. 연결·앱 실행·측정 성공으로 표시하지 않는다. 기기 변경/건강 자료 읽기0이다.
- PB chip/gun·공식 종목별 비교와 FUT-09 실제 공유 계획 원문 파일·링크를 다시 질문했다. 답변 전 정책/원문 이식 완료로 표시하지 않는다.
- 실제 producer `race-plan-impact-source-permissions.ts:396`는 checklist catalog 요청을 skip한다. inline checklist는 blueprint fullbody에 포함되므로 catalog fake-checklist의 unindexable 거절이 맞다. 새 채널 fixture의 초안 우려는 실제 emitted capture 증거가 없던 추정으로 철회했으며 새 identity를 발명하지 않았다.
- full-owned DTO adapter는 기존 core8 query/guard 복제를 피하기 위해 기존 owned source helper에서 strict ref1개 reader를 공통 추출 중이다. 별도 SQL115/group 관측 및 추가 channel fixture와 비중복 소유로 계속 구현하며, 현재 WIP는 phase 검증/commit 완료가 아니다.

## FUT-09 원문 링크 접근 재확인 · 2026-10-07

기준 공유 링크 `https://chatgpt.com/share/6aa89754-1ea4-83ee-b91a-5ed2a1955bd9`의 웹 조회는 제목만 반환하고 본문0이었다. Aside CLI1.26.916.1741/skill3의 guide와 guide repl을 읽었으며 skills list는 daemon auth challenge 실패/Aside not running으로 exit1이었다. 사용자 선호 in-app Browser로 해당 정확URL을 열어 실제 DOM의 `Could not load this ChatGPT conversation`을 확인했다. 원문 확보/날짜 추출/이식·활성화는 완료하지 않았다. 사용자의 앞선 sample 요청을 위한 [원문 전달 예시](shared-plan-original-example.md)를 추가했으며 합성 양식을 실제 원문으로 대체하지 않는다. 원문 파일·텍스트·접근 가능한 링크 수신을 기다린다.

## 재개 · fullowned PG 및 SQL115 설치 오류 · 2026-10-07

- 대회 삭제 답변을 재확인했다. 기존 승인 영양은 연결 해제 표시, 재연결·재승인 전 대회 시각 사용 중단이며 음식·수량·실제 섭취는 보존한다. 기존 결정과 동일하며 제품 writer/restore 수용을 완료로 바꾸지 않는다.
- 실제 PG fullowned7 PASS / SQL115 설치 구문 오류·18 SKIP로 전체 exit1이다. 별도 core PG23와 unit43은 PASS다. channel R5의 5 PASS 중 하나는 unplanned projection gap 관찰이며 기능 완료 증거가 아니다. [I 기록](progress/M2-02i.md)에 실제 로그와 한계를 추가했다.
- Native 3 agent를 SQL115 수정, original frozen unplanned retained roster 구현, broad channel fullowned PG 준비에 병렬 배정했다. Root가 실제 DB·공통 export·graph/Git를 직렬 통합한다. registry107/main `1d557358`/push0·I/J/phase in_progress, 기존 사용자 결정/외부 gate 대기를 유지한다.

SQL115는 R2의 실제 식별자 타입 오류와 두 공개 producer fixture 오류를 교정한 R3에서 실제 PG **18/18 PASS·exit0**이고 DB/역할 잔존0이다. 코드·시험·기록은 phase의 `c93827fd`에 커밋했다. R1/R2 실패는 보존한다. Registry107/main/push는 그대로이며 전체27 same-snapshot consumer·unplanned retained run·broad fullowned channel 시험 및 lifecycle/restore 후속 구현을 native 병렬로 진행 중이다.

Unplanned 원 실행 보존 후 Root unit213·scoped persistence/API TS·lint/format과 실제 fullowned7/unplanned4/broad채널5를 검증했다. 초기 foreign consent/error-code 기대와 unrelated schedule assertion 실패는 [I 기록](progress/M2-02i.md)에 보존했다. 새 full27 consumer는 실제 R1 3PASS/7FAIL의 strict adapter envelope 전달 오류를 교정해 재시험 중이다. 이 결과는 저장/승인/lifecycle/restore/phase 수용 완료가 아니며 main/push0·registry107·I/J/phase in_progress를 유지한다.

새 full27 same-snapshot consumer는 strict C/S/B 입력과 exact nutrition expected fact를 교정한 R3에서 실제 PG **10/10 PASS·exit0**다. Root persistence TS/lint/format·source/test SHA·실제 DB/역할 잔존0을 확인했다. 다음 native 병렬은 retained payload codec, purpose/fullpermission/freshness seal 조사, successor storage/lifecycle27 exact hook 조사다. JSON/행 hash만으로 저장·승인 권한을 만들지 않으며 registry107/main/push0·phase in_progress 및 전체 phase 검토·출시 gate 미완료는 유지한다.

## 재개 · 구조 parser/retained codec 실제 확인 · 2026-10-07

- 지난 goal 턴은 phase 커밋 `c93827fd`·`7d8fdef7`·`6994889c` 및 실제 unit213/sourcePG16/SQL18/consumer10 증거로 progress다. 이번 턴 Root는 공유 구조 parser/retained codec unit44와 refactor consumer 실제PG10·cleanup0을 확인했다. [I 기록](progress/M2-02i.md)에 범위와 입력 SHA를 기록했다.
- 현재 native 병렬은 실제 retention preparation 연결, current app/manual-policy binding 소비 연결, exact27 lifecycle parent edge binder다. 이 준비를 저장/삭제/복원·fullpermission/freshness/원자 승인 완료로 바꾸지 않는다. registry107/main/push0·I/J/phase in_progress를 유지한다.
- iPhone 읽기 전용 조회의 첫 sandbox 실행은 CoreDeviceService 초기화 timeout으로 실패했다. sandbox 밖 재조회는 paired/OS27.0/tunnel unavailable이었다. 최초 실패의 빈 devices를 기기 부재로 해석하지 않는다. 앱 실행·설치·HealthKit 읽기·성능 측정0이며 별도 실기기 gate는 미완료다.
- PB chip/gun·거리 비교, FUT-09 실제 원문, AWS 관리자 로그인 가능 시점을 다시 질문했다. 답변 전 기존 결정 대기를 유지한다.

## Current app·retention 실제 preparation 수용 · 2026-10-07

Root unit63·currentbinding/retention/consumer actualPG21·기존 preparation 회귀PG9·persistence TS/lint/format를 확인했다. 새 helper를 server preparation에서 실제 소비하고 full27 관측을 retained codec으로 연결하며 원 blocked 진단·none/not_checked/not_persisted를 유지한다. 증거/입력 SHA는 [I 기록](progress/M2-02i.md)에 기록했다. 저장·전체 permission/freshness·Evidence→Decision→Proposal·lifecycle/restore·원자승인/phase 수용은 미완료다. lifecycle binder 구현과 purpose/storage coherent 후속 설계를 native 병렬 진행한다. registry107/main/push0 및 기존 사용자 결정·외부 not_executed를 유지한다. 대회 삭제 영양은 연결 해제·재연결/재승인 전 대회 시각 사용 중단·음식/수량/실제 섭취 보존 결정을 재확인했다.

## Lifecycle binder·schema2 저장 구현 전환 · 2026-10-07

Root lifecycle unit11/actualPG7·scopedTS/lint/format/diff·DB/roles잔존0을 확인했다. target 개수만 비교하지 않고 정확 exercise/version/target namespace tuple을 대조한다. [I 기록](progress/M2-02i.md)의 actual7은 모든27 source 삭제/restore 수용이 아니다. Native3 agent가 consumed purpose/semanticbasis, 미등록 SQL116 store+all27hooks, trusted chain service를 비중복범위로 병렬 구현한다. Root는 strict successor event codec·공유등록/실DB/Git·graph를 직렬 통합한다. 저장은 canonical Evidence1+Decision/ProposalFK이며 적용은 false이고 fullatomicapproval 별도다. registry107/main/push0·phasein_progress·외부 gate를 유지한다.

Record7 별도 strict 구조 codec의 unit49와 scopedstatic을 확인했다. full typed identity/namespace·legacy1..6 physical 변환을 보존하고 원 event/tail authentication으로 승격하지 않는다. SQL116/체인/목적helper는 WIP이며 public registry·pgoutput/export/restore activation은 아직 없다. 세부 증거는 [I 기록](progress/M2-02i.md)를 따른다.

Consumed/semantic PG 초기8FAIL(strict envelope extra field), 수정 후7PASS/1FAIL(foreign error expectation)을 [I 기록](progress/M2-02i.md)에 보존한다. AI derived cleanup을 manual rawtext deny로 오인한 정책 결함을 발견해 purpose-specific guard/semantic projection과 SQL116을 수정 중이다. 현재 신규helper/chain/SQL116/pgoutput successor는 WIP이며 actualstore/restore/전체phase 통과가 아니다.

## 목적별 사용·V7 consumer 로컬 검증 · 2026-10-07

Root 신규 목적helper unit30·actualPG11·scopedTS/lint/format·DB/역할잔존0을 확인했다. AI 파생 정리와 own rawtext 수동 사용을 구분하고 exact source identity/삭제·frozen DTO를 유지한다. V7 pgoutput 신규24·기존 binary 회귀45도 통과했으나 실제 logical slot/원격 tail/archive restore는 미실행이다. [I 기록](progress/M2-02i.md)에 초기 실패와 최종 입력 SHA를 함께 보존했다. SQL116 trusted store/privacy hook 구현, 나머지 provider/course/media 실제 adapter 조사, J configured 경로 조사는 native 병렬로 이어진다. registry107·main/push0·I/J/전체 phase 미완료는 유지한다. 대회 삭제 시 승인 영양의 연결 해제 표시·재연결/재승인 전 대회 시각 사용 중단 결정을 재확인했으며 음식/수량/실제 섭취 보존은 유지한다.

## PB 화면 실제 소비자 연결 · 2026-10-07

기존 결과 목록 pages에서 명시 비교 입력으로 PB를 계산하도록 연결했다. Root 두Host build 및 실제 OIDC/API/합성 DB Next·Vite identity2/2를 확인했고, 0초를 승자로 기대한 최초2FAIL은 기존 정책을 변경하지 않고 시험을 교정한 기록으로 보존했다. [J 기록](progress/M2-02j.md)을 따른다. V2 첨부 normal registry/owner/export/restore 및 실제 HTTP/UI 수용은 별도 미완료이며 J/phase in_progress를 유지한다. SQL116 첫 설치시험은 STABLE 함수를 index expression에 넣은 오류로 0PASS/28SKIP였다. 일반 lookup index로 수정한 R2는 아직 실제 재실행 전이며 성공으로 바꾸지 않는다. FIT는 앞단 strict manual companion 차단을 발견해 actual imported-source companion 연결이 필요하다. source/purpose/lifecycle/전체 원자 승인과 외부 gate를 계속 분리한다.

## Trusted chain 로컬 own/core/text 검증 · 2026-10-07

SQL116 첫 두 설치 실패와 R3 11PASS/17FAIL+unhandled1을 수정한 R4는 Root 실제 **28/28 PASS**, focused unit68·scoped TS/lint/format·DB/역할잔존0이다. [I 기록](progress/M2-02i.md)에 초기 실패·exact SHA와 수용범위를 보존했다. canonical payload1·FK·minimal digest receipt·동시성/rollback·source delete/purge를 검증했으며 normal registry107·public activation0·Plan 적용0이다. NEW source preparation3은 course1PASS/FIT·fixture2FAIL로 앞단 manual-only companion 연결 gap을 실제 확인했다. 별도 imported metadata port 준비를 context/routine/complete에 연결하고 재검증할 예정이다. whole27 lifecycle/원격 tail/archive restore/전체 도메인 승인·J 첨부 공개 활성화·전체 phase 및 외부 gate는 계속 미완료다. main/push0·I/J/phase in_progress를 유지한다.

## Imported 읽기·PB 반응형 실제 수용 · 2026-10-07

Root imported companion 집중 unit359와 실제 source-purpose PG3(FIT/fixture/course), PB responsive Next/Vite 실제 identity2를 확인했다. 초기 FIT2FAIL은 보존하고 현재 연결의 실제 통과만 별도로 기록했다. [I 기록](progress/M2-02i.md)·[J 기록](progress/M2-02j.md)을 따른다. 합성 DB/역할 잔존0이며 SQL116 local FIT/course 저장 확장은 native agent WIP이다. provider/media 권한 연결 및 J configured proof/normal restore 후속을 병렬 조사한다. registry107·main/push0·I/J/phase in_progress·외부 not_executed는 유지한다. 대회 삭제 후 승인 영양은 연결 해제 표시·재연결/재승인 전 대회 시각 사용 중단·음식/수량/실제 섭취 보존 결정을 다시 확인했다.

## 증빙 V2 공통 경계 및 local 저장 첫 실험 · 2026-10-07

Root V2 optional product 등록과 브라우저 Host exact path/method 경계의 unit153+33·API/platform TS·lint를 확인했다([J 기록](progress/M2-02j.md)). configured 정상 활성화·OIDC/DB 첨부 검증은 아직 없다. Native agent는 typed V2 client, own media purpose, local store/purge를 독점 범위에서 병렬 구현한다. local SQL116 확장 Root 실제 PG R1은32개 중31PASS/1FAIL이며 코스 저장의 PLpgSQL course_id ambiguity를 수정 중이다. 원 실패는 /private/tmp/wm-chain116-local-root-pg-r1-20261007.log에 보존하며 전체32 통과로 바꾸지 않는다. registry107·main/push0·I/J/phase in_progress·외부 not_executed를 유지한다.

## Local 저장 실제 재검증 · 2026-10-07

SQL116 local FIT/fixture와 manual recorded course 저장·삭제 R2는 Root actualPG34/34 및 DB/roles0이다([I 기록](progress/M2-02i.md)). R1 course ambiguity 실패는 보존했다. phase의 V2client commit6bc97834는 unit43/actualmoduleTS0이고 공개 proof DTO exact 조회 준비까지이며 J 첨부 화면·실 HTTP/DB activation은 아직 없다. Native 병렬3범위는 result editor/selector UI, own media purpose/semantic, SQL 저장 후속이다. normalregistry107·main/push0·I/J/phase in_progress·외부not_executed를 유지한다.

## Media actual purpose 검증 · 2026-10-07

Root own media named adapter→실제 preparation/semantic 연결의 unit71/actualPG5·frozen7 SHA·DB/roles0를 확인했다([I 기록](progress/M2-02i.md)). normal107에 capability 없으면 blocked이며 raw113+115 공개 gallery metadata finalize로 검증한 로컬 범위다. 객체 bytes/provider 인증/SQL116 media store/withdrawal lifecycle/full authenticated restore는 미완료다. Native3 agent는 HealthKit current purpose+metadata companion, media 최종 SQL predicate/store/purge, 증빙 선택 editor를 비중복 범위로 진행한다. Root는 shared integration/실DB/Git/graph를 직렬 소유한다. registry107·main/push0·I/J/phase in_progress 및 외부not_executed를 유지한다.

## HealthKit 실제 준비 후속 · 2026-10-07

Root HK unit426·실제 PG4 및 persistence TS를 확인했다. R1/R2의 actual 실패와 원인을 별도 보존하고 기존 공개 grant 누락·typed neutral tombstone fixture를 교정했다. [I 기록](progress/M2-02i.md)을 따른다. 미디어 SQL116+chain 실제 R2는39PASS였으나 HK를 포함한 회차는42PASS/1FAIL이며 마지막HK R3만4PASS다. 이 결과를 단일43PASS 회차로 합치지 않는다. registry107/main/push0·I/J/phase in_progress·외부 not_executed와 기존 사용자 결정은 유지한다.

## Current HealthKit store·J capability 진행 · 2026-10-08

Root 실제 HK storage39+chain13 PG52/52를 확인했고 초기50PASS/2FAIL을 보존한다. 별도 capability 계약/API/platform191/191는 phase의 검증 커밋 f3d78b15에 있다. [I](progress/M2-02i.md)·[J](progress/M2-02j.md) 기록을 따른다. 새 J editor/Host unit83·Next/Vite build는 성공했지만 Chrome actualR3/R4 각두Host2FAIL이다. R4의 exact recheck GET200 이후 선택이 retained에 남는 실패로, readonly proof DTO를 strict write DTO로 spread한 실제 UI 문제를 발견해 명시 최소 identity projection과 positive 재확인 회귀를 native actor가 수정 중이다. E2E/제품 경로 성공으로 승격하지 않는다.

native 병렬은 J selector수정, Garmin current metadata/purpose gap 준비, 실제 authenticated export/restore integration조사로 비중복 배정했다. Root DB/browser·shared registry·graph/Git는 직렬 통합한다. Garmin collector에는 개별 provider processing consent mapping이 실제 없음을 확인했으므로 common provider gate를 임의로 추가하지 않고 not_captured/finiteblocked를 정확히 유지한다. 실제 underlying grant/retained-use closure는 별도 미완료다. PB Chip/Gun·거리 기준 및 AWS 로그인 가능 여부는 재질문했으며 답변 대기, FUT-09 실제 원문도 미수신이다. I/J/phase in_progress·main/push0·외부not_executed를 유지한다.

## 증빙 화면 실제 교정 수용 · 2026-10-08

Root가 read→write DTO 과다 필드 문제를 수정한 증빙 selector의 unit86·Next/Vite build 및 실제 Chrome R5/R6 각두 Host2/2를 확인했다. R6는320px·키보드·한글 입력값 보존을 포함하며 입력21 SHA 변경0, 시험 DB/전체5역할 잔존0이다. [J 기록](progress/M2-02j.md)에 R1–R4 실패와 교정·실제 증거를 분리했다. iPhone/native IME·운영 배포·normal registry/완전 authenticated restore 및 J/phase 완료 증거로 사용하지 않는다.

Garmin 저장 canonical Activity 수동 목적은 사용자 승인된 S22 app core 처리 정의로 actual app admission을 적용하도록 정책 연결을 정정 중이다. 기존 not_captured 개별 collection 권한은 유지하며 app 동의를 신규 원격 수집이나 historical raw grant로 치환하지 않는다. metadata retained read와 새 core 처리 gate를 분리한다. 이전 blanket blocked 준비 기록은 역사로 보존하고 새 helper unit30 및 실제 PG는 별도로 기록한다. native 병렬은 V7 authenticated protocol 구현, Garmin core 목적 검증, 전체 원자 승인 successor 준비다. Root는 실제 DB/browser·공통 통합·Git/graph를 직렬 소유한다. 대회 삭제 시 승인 영양의 연결 해제·재연결/재승인 전 시각 사용 중단 및 음식/수량/실제 섭취 보존 결정을 유지한다. main/push0·I/J/phase in_progress·외부 not_executed다.

## 2026-10-08 검증 커밋과 다음 병렬 범위

작업 checkout은 `.claude/worktrees/phase-m2-02`, branch `phase/m2-02`다. main은1d557358(clean)이며 이전m0-06/ext-oidc/m0-06c heads가 모두 main ancestor인 것을 다시 확인했다. 증빙 공개 Host 화면30657573(실제 Chrome 두Host R6 PASS), Garmin helper897535cc(unit30/actualPG6), 영양 동일transaction ca3aaa9e(unit30/newPG5/legacyPG11), V7 암호 consumer1f02c9dc(new25/legacy38/actualoldexporterPG3)를 검증 커밋했다. 추가 Garmin metadata 소비자337/actualPG4도 확인해 phase에 기록한다. [I](progress/M2-02i.md)·[J](progress/M2-02j.md)의 실패/skip/동결SHA와 실제 수용 범위를 따른다.

다음 native 병렬은 Garmin core 목적의 consumed/semantic/store 연결, 실제 V7 extended publisher 시험 준비, authenticated current-family/original-event 설치 successor 폐쇄 범위다. 실제 공개 source delete는 원본1..6 event를 재사용하므로 새7 producer를 가짜event INSERT로 만들지 않는다. V7 profile byte검증/oldevent PG는 새7원본 적용·완전복원을 대신하지 않는다. 전체 source freshness/affected-domain 승인·정상 registry/공개configured activation·phase fullgates/독립검토가 남아 있으며 I/J/phase는 in_progress다. 대회 삭제 후 영양 연결 해제·재연결/재승인 전 시각 사용 중단 및 food/quantity/actual intake 보존 결정을 유지한다. 기존 PB Chip/Gun·거리 분류/AWS로그인 여부·FUT09원문 답변은 대기, 외부not_executed·main/push0다.

## Garmin core 소비·실제 V7 publisher 후속 · 2026-10-08

검증 커밋35b4f2fc는 실제 appAdmission을 쓰는 Garmin core 목적 소비·semantic을 연결했고 Root unit51/actualPG9/scopedTS 및6 SHA변경0이다. SQL116 저장 직전 목적 재검증은 다음 작업이다. 새 V7 실제 publisher 시험은 두회차6/6이며 R2의12입력변경0과 DB/roles/slot0를 확인했다([I 기록](progress/M2-02i.md)). 실제 old4/5 원본 reuse이며 새7 공개 producer·원본 stage·complete source/tail/archive 인증을 통과시킨 것이 아니다.

현재 native 병렬은 Garmin 최종 저장 재검증, current-family signed artifact+strict roster/parent closure prerequisite, V7 실제 전달 수용의 통합/원본 stage 준비다. Root는 SQL/공통registry 소유를 직렬 배정하고 actualDB/graph/Git 통합을 소유한다. 전체영향 도메인 원자 승인·normalconfigured 활성화·phasefullgates/독립검토·운영/실기기 gate와 기존 사용자 답변대기를 유지한다.

## 사용자 결정 재확인 · 2026-10-08 대회 삭제와 영양 일정

사용자는 대회 삭제 뒤 승인된 영양 일정을 연결 해제로 표시하고, 명시적 재연결·재승인 전까지 대회 시각 사용을 중단하도록 확정했다. 음식·수량·실제 IntakeEntry는 보존한다. 기존 V4 disconnection/reconnect 정책을 유지하며 자동 재연결이나 삭제를 추가하지 않는다. 전체 영향 일정 원자 승인 수용은 M2-02i의 잔여 작업이다.

## current child artifact 인증 검증 · 2026-10-08

Root가 15 child relation(14 durable와 archive-empty transient)의 strict signed-byte codec/factory opaque handle을 단위47/47, persistence TypeScript0, scoped ESLint0/Prettier0으로 재검증했다. source key resolver는 factory 생성 때 고정하되 매 준비 시 내부 키 철회 정책을 다시 조회한다. 입력2 SHA는 R5 동결값과 일치한다. 부모 closure·SQL row encoding·original tail stage·운영 restore는 이 child 인증으로 통과하지 않으며 별도 미완료다.

## Garmin 최종 core 저장 실제 수용 · 2026-10-08

Root가 신규11 및 기존 retained39/chain13/V7 publication6을 실제 격리 PG에서69/69로 검증했다. 초기9pass/2fixturefail을 보존하고 정확한 event/error namespace 기대만 교정했다. SQL116/test2 SHA 변경0, DB/roles/slot 잔존0이다. 수집·공식 인증·whole freshness/atomic approval·full restore·phase/main은 통과로 올리지 않았다. 병렬 후속은 current full-parent artifact 준비와 전체 영향 일정 원자 승인 최소 scope 감사다.

## 병렬 후속 입력 동결 · 2026-10-08

Root 실제 current107+raw108–116 빈 DB catalog 추출을 부모 artifact actor와 full27 freshness actor에게 전달했다. 현재 native agent 쓰기 범위는 NEW parent artifact/unit, NEW manual atomic approval contract/unit이며 세 번째 actor는 full27 comparator 및 actual child codec PG 수용을 준비한다. 공통 exports/registry/SQL stage/API/UI/graph는 Root가 직렬 통합한다. 현 main은1d557358이고 clean, AGENTS는 작업 branch와 동일하다. 계약/인증 구조만으로 실제 atomic 승인이나 restore gate를 완료하지 않는다.

## 실제 child 인코딩 후속 · 2026-10-08

Root actual child PG4/4를 확인했고 초기2pass/2fixturefail은 보존했다. chain7+suppression1은 실제 행, 나머지6은 빈 census-only 및 transient0 검증이다. metadata/source bytes/full restore를 확대 인증하지 않는다. parent artifact 단위24/24를 검증 중이며 SQL117 loader와 네도메인 원자 승인 계약 구현을 병렬 진행한다. 기존 child factory handle의 prepare 이후 키철회·교체도 소비 전에 거절하도록 별도 후속 보강 중이다.

## whole-affected application 경계 준비 · 2026-10-08

새 수동 승인 contract30와 child key52 unit82/82 및 계약 build/api-client·platformTS/public subpath runtime 검증을 완료했다. SQL118 실제applicationcandidate/allfour approval actor는 기존 회복/루틴 sameTx writer를 좁게 추출해 재사용하며, race-only 변경 시 nutritionV4가 기존pin을 유지하는 실제 gap을 별도 private-context seam으로 처리한다. 가짜 제목/period 변경이나 기존readonly applicable false 토글은 하지 않는다. 원 SQL110/116 retainedbody는 보존하고 applicationcandidate의 실제 currentbasis를 새로 저장해 승인 시 recapture와 비교한다. SQL117 restore actor에는 actual110관계/244trigger 정의를 추가 제공했다. 원본tail typed callback 및 actualparent+child+tail loader/whole source closure·allfour acceptance·fullphase gates/독립review·공개/native 수용은 미완료다.

## V7 원본 경계 및 공개 응답 재확인 · 2026-10-08

Root가 verified V7 원본 callback unit31/actualPG6/scopedTS와 DB/roles/slot0를 확인했다. 원본6µs/WeakMap factory 소유/fresh clone을 보존하며 stale witness 재검증·SQL stage·복원 admission 완료로 세지 않는다. SQL117 원본 loader의 실제 암호 검증 handle 소비를 준비한다. 공개 workout.red-10-proto.xyz를 새로 읽었고 HTTP503/TLS verify0이었다(`/private/tmp/wm-public-workout-probe-20261008.json`). 공개 로그인·503 해제·제품 경로는 여전히 미완료이며 AWS 인증 재개 질문의 답변을 기다린다.

## CheckIn routine·공개 미리보기 통합 후속 · 2026-10-08

Root routine unit36/actualPG6, public frozen whole preview unit37/actualPG R3 11 및 API/client/루틴 RTL 합동136을 확인했다. 초기 PG/단위시험/format/PATH 실패와 교정은 [I 기록](progress/M2-02i.md)에 별도 보존했다. 입력5/12 SHA 불변·DB/roles/slots0이며 normalregistry107/source116222/main/push0를 유지한다. 실제 UI browser/build·HTTP→DB 수용은 미실행이다. 기존 identity harness의 template port 누락을 발견해 명시 opt-in raw123와 두Host시험을 agent에 배정했고, 대회 public review/explicit approve UI 및 authenticated identity target 변환 준비를 병렬 진행한다. 대회 삭제 nutrition 연결 해제·재연결/재승인 전 시각 중단·음식/수량/실제 섭취 보존 결정을 재확인했다. I/J/phase 전체·최신 restore·공개/native/외부 gate는 미완료다.

## 체크인 두 Host 실제 수용 완료 · 2026-10-08

Aside 실제 확인으로 빠진 Host template 경로를 발견·교정했고 Root platform212/212, Next/Vite rebuildR2 및 actual Chromium focused R3 **2/2**를 확인했다. 실제 template→frozen blueprint→run→actual CheckIn0/null·stale revision 거절·명시연결/수행·count1·철회/retained read·계정삭제 경로다. R1두실패/R2실행전오류·수동 harness 실패를 [I 기록](progress/M2-02i.md)에 별도 보존했다. 입력SHA·cleanup0는 wm-checkin-identity-root-verified-r3-20261008.json에 있다. native IME/iPhone/공개HTTPS·copied lifecycle/최신restore·I/J전체/phase/main 완료로 세지 않는다. 날짜 상세검토 wiring과 실제 미해결 영향 diagnostics·unlinked date PATCH 차단을 native 병렬 진행한다. normalregistry107/main/push0·기존결정/외부 not_executed를 유지한다.

## 날짜 변경 두 Host 수용·복원 identity SQL 후속 · 2026-10-08

Root actual Chromium Next/Vite 날짜 검토 R3 **2/2** 및 RTL99/platform focused219를 통과했다. Aside에서 발견한 동일 세션 focus 재조회 초안 소실과 실제 승인 뒤 성공 안내 소실을 교정했고 R1/R2 실패는 [I 기록](progress/M2-02i.md)에 보존했다. direct date PATCH409·검토 전후 no-write·별도 명시승인·새 event revision·keep_plan head 보존·320/768/1280 reflow를 실제 확인했다. 실제 SQL125 fixed116 identity target 적용도 R2 **1/1**이고 CLOSED 유지/credential4 empty/logout replay deny 보존을 확인했으나 전체 restore/admission은 미완료다. normalregistry107/main/push0를 유지한다. 미해결 진단 서비스·해결 UI/ended 정책, allfour 승인 후 public nutrition V4 조회 및 consumer 지원을 병렬 진행한다. 전체phase/운영503/native/외부 not_executed는 유지한다.

## 공개 영향 진단 실제 DB 수용 · 2026-10-08

Root actual PG R2 15/15·unit43/43 및 cleanup0로 non-stored five-domain 영향 서비스의 소유권·동의·revision·긴 ID 해결을 검증했다. R1 fixture sorted-item 오류14/1은 [I 기록](progress/M2-02i.md)에 보존했다. candidate/receipt/plan head 쓰기는 없으며 HTTP/UI/whole phase 완료가 아니다. 병렬 nutrition V4 consumer/API 구현을 회수해 Root rebuild·두Host 수용을 진행하고 ended unresolved의 frozen 보존 정책 모순을 별도 교정한다. normalregistry107/main/push0와 공개503·native·외부 not_executed를 유지한다.

## 네 도메인 두 Host·CheckIn 실제 삭제 수용 후속 · 2026-10-08

Root actual allfour R16 Next/Vite **2/2**·V2 boundary unit355/355를 확인했다. 새 non-stored 진단→저장검토→명시승인→네 도메인 head/receipt 재생→영양 V4 readonly 화면까지 검증했고 raw126는 SQL116 원본을 보존하며 checklist UUID 비교만 교정한다. 이전 R1–R15 실패/진단 및 불일치 gate는 [I 기록](progress/M2-02i.md)에 보존한다. 실제 CheckIn copied/delete PG R2 **2/2**·companion unit327/327도 통과했다. 기존 값 없는 command ack 재생은 현재 자료가 아니며 삭제 자료/복사 payload 재생성없음을 확인했다. 별도 ended PG R3는2pass/1fail로 current/역사 schedule 분류 수정이 진행 중이다. unresolved editor 두Host4case와 archive 실제행 대응 증명을 native 병렬 진행한다. normal107/fixed116222/main/push0와 외부 not_executed·503은 유지한다.

## fixed116 archive 행 대응 검증 갱신 · 2026-10-08

Root가 신규 correspondence verifier의 단위19/19와 실제 PG composite1/1(skip0)을 통과했다. authenticated snapshot archive를 별도 일회용 DB에 실제 복원하고222 물리 관계의 행·배열 layout·float bit를 대조했다. 같은 count의 public 수정·target/key 불일치는 거절했고 정리 잔존0이다. [I 기록](progress/M2-02i.md)의 한정 fixed116 증거이며 최신 profile·tail/sequence·admission·전체 복원·공개 release는 미완료다. main/push0이다.

## PB 기본 비교 결정 갱신 · 2026-10-08

사용자는 Chip 우선·Chip 없는 기록은 Gun 비교를 선택했다. 직접 입력도 PB 후보이며 비교한 시간 기준을 표시하고 원값을 보존한다. M2-02j의 chip/gun 기본 선택 대기를 해소하고 구현·실제 두 Host 수용을 이어간다. 이 결정만으로 J 완료를 표시하지 않는다.

## 날짜 영향 통합 실제 수용 갱신 · 2026-10-08

SQL127의 실제DB5/5 및 current/historical routine 분리 후 ended PG3/3·public/CheckIn copied17/17·Next/Vitecombined6/6(skip0)을 통과했다. 긴 영양ID 해결과 미해결 routine dates/window 입력부터 명시승인까지 실제두Host를 검증했다. [I 기록](progress/M2-02i.md)에 원실패/입력SHA/정리0·type/format후속차이를 보존한다. 다음 ready는 사용자 확정Chip우선 PB기본정책 및 공개 영양 V4재연결/재승인 preview/API/UI이며 nativeagent별 분리소유한다. 최신fullrestore·wholephase/독립review/main·운영/native gate는 미완료다.

## PB 결정 반영·공개 영양 재연결 후속 수용 · 2026-10-08

PB Chip우선/null일 때 Gun 기본 정책은 unit75/75와 실제두Host4/4로 `9d295764`에 커밋했다. 공개 영양 V4 write-free preview/API/명시 재연결 UI를 native agent의 비중복 소유로 병렬 구현해 Root unit395/395·실제PG15/15·Next/Vitebuild0·실제두Host2/2(skip0)을 확인했다. 실제 대회 삭제 후 시각 중단·새 대회만으로 자동재개0·미저장 비교 후 별도승인·멱등재생·음식/수량0|null/실제Intake 보존·320reflow를 수용했다. [I 기록](progress/M2-02i.md)에 SHA/한계/과거실패를 보존한다.

정상registry107과 production writer/preview 부재는 유지한다. bounded 대회선택 첫50개와 manual계약에 표현불가한 reviewed provenance 재연결 한계도 별도 남는다. 다음 ready I/J 작업은 runtime 설치 profile/좁은grant/정상configured 활성화 및 최신 export·restore closure 준비다. 고정116/222의 target-only117119125를 최신runtime에 그대로 설치하거나 기존guard를 완화하지 않는다. 전체phase gate/독립review/main·운영503/native/외부not_executed 및 AWS로그인/FUT09원문 대기는 변경 없다.

## 정상 설치 경로 실제 HTTP 수용 · 2026-10-08

명시 `installed-runtime` identity 모드는 base107→별도17-step installer→좁은26RPC grant→실제 owner ledger 확인을 사용한다. raw staging과 target-only117/119/125는 이 경로에서 실행하지 않는다. Root actual Chromium Next/Vite 공개 proof/PB/미해결 영향/네 도메인 승인/영양 삭제·재연결 **12/12 PASS·skip0·exit0**,59.6초다. 로그 `/private/tmp/wm-installed-runtime-root-e2e-r1-20261008.log`, 입력3 SHA 및 정리 DB/role/slot0는 `/private/tmp/wm-installed-runtime-root-verified-20261008.json`에 있다. Root parser26+개인 manual export 관련86 **112/112** 단위 통과다. 전체 harness strict TS의 기존 oidc-provider 선언 TS7016 실패는 보존하며 tooling scoped typecheck와 구별한다.

실제 설치 경로 수용은 configured production의 cold catalog/transitive 보안 지원·최신 전체 personal export/restore·phase 전체 gate/독립검토/main·운영503/native/외부 gate 통과가 아니다. 이 gate와 원문/AWS 사용자 답변 대기는 유지한다.

## 개인 export successor 병렬 구현 배정 · 2026-10-08

Root는 새 migration128 `128_personal_export_retained_runtime.sql`을 개인 template/manual public export의 좁은 두 reader 전용으로 직렬 배정했다. SQL·실제PG 시험준비, NEW `retained-personal-export` mapper/unit, current-runtime-support의 실제catalog integration 시험은 nativeagent별 분리소유한다. 기존001..127과 installer17/checksum/defaultexport34를 수정하지 않으며 SQL128의 존재만으로 설치/지원/producer/복원 완료를 표시하지 않는다. Root가 actualDB·공통exports/operationsV36·installation/grant witness·graph/Git 통합을 맡는다. 내부전용 candidate/preparation을 공개 JSON에 넣지 않는다.

`40e68342` 정상설치 HTTP12/12와 `fe3ae229` 개인publicmanual 구조계약86/86은 phase branch에만 커밋했다. 운영 cold 지원·최신전체export/restore·wholephase/독립review/main·공개503/native/외부 gate와 AWS로그인/FUT09원문 답변은 대기 중이다.

## V36 retained 개인 export 후속 · 2026-10-08

Root 실제 aggregate PG R4 **16/16**,focused unit174 및 별도 계약8파일248을 확인했다. R1/R2의 신규8skip과 R3 실제15PASS/1FAIL은 [I 기록](progress/M2-02i.md)에 보존했다. 수정은 실제 versioned routine occurrence·별도 nutrition approval ID·central manual history 대응이며 조건을 우회하거나 이력을 만들어내지 않는다. cleanup DB/roles/slots0, default34/installer17/registry107/main/push0다. Native 병렬 작업은 internal-only portable renderer, 전체116/118 narrow enumeration 설계, actual catalog witness의 internal FK trigger identity 정규화다. Internal 계약 단위검증은 전체personal-export 완료가 아니다. provenance·normal successor/cold activation·최신 authenticated restore/phase/운영 gate는 미완료이며 I/J/phase in_progress와 외부 not_executed를 유지한다.

## internal source129·additive installation 후속 · 2026-10-08

phase commit4d92e59a는 V36/source128, df30fec8는 closed owner catalog observer,6151b4e7는 immutable parent17을보존하는 named installer-v2다. Root v2 actualPG10/10·publicsubpath import·combinedunit81을 확인했다. Owner actualfinal28 metadata를 수집/rollback/cleanup했고 newgrant-v2는 native WIP다. SQL129+internal renderer는 실제R4 **10/10**,unit68이며 공개122검토없는 chain/후보·원all-fourhistory·실제purge·withdraw·13정상독립 체인의 용량 수용을 확인했다. 초기8/2·9/1과 targeted진단 실패를 [I 기록](progress/M2-02i.md)에 보존했다. Registry107/main/push0·I/J/phase in_progress다. 최종wholeaccount successor·source27/SQL110 provenance·normal129successor/cold/configured·전체restore/phase/운영 gate는 미완료이며 linked-only nutrition dependency predicate gap을 병렬 조사한다. Actualcatalog의 원실패10/1과 수정targeted1/10filteredskip은 단일현재11PASS가 아니다. 외부 not_executed를 유지한다.

## 설치19·V37 실제 수용과 다음 병렬 작업 · 2026-10-08

이후 phase 커밋 `2cc88d55`는 grant-v2 실제13/13, `883554a3`는 parent18 불변 installer-v3 실제10/10, `f8a860e6`는 linked-only 영양/회복 영향 수정 실제PG4/4와 Next/Vite2/2, `dc36366c`는 V37 계약 prerequisite, `d0d2c39b`는 실제 final29 관측 기반 grant-v3 실제13/13, `e68f9901`는 V37 same-RR composer/129 adapter다. Root 실제 V37 11+V36 회귀8 **19/19 PASS·skip0**,66.29초와 composer/reader 단위36/36·public import·DB/role/slot 정리0을 확인했다. 최초37의9/2 fixture 비교 실패, 이름이 잘못된 V36/V35 선택과 미실행은 [I 기록](progress/M2-02i.md)에 보존하며 통과로 세지 않는다. 공개 producer의1000 template versions와 독립 chains로 실제 공유8MiB 초과 및 audit0, 1001 count cap도 검증했다.

다음 native 병렬은 source27/SQL110 safe provenance 계약과 신규130 좁은 reader/mapper, 명시profile19의 typed whole-catalog 관측 보강이다. Root는130 `130_retained_source_provenance_export.sql`만 직렬 배정했으며 normalregistry/profile 편입은 아직 없다. Safe projection이 다른 external sourceRecordId를 같은 값으로 축약할 때 저장ordinal을 지키는 보완과 개별planned/C/S/B JSON visits 용량 조사도 진행 중이다. current root catalog witness의 원body·v1 의미는 export-only 재사용 seam 외에 변경하지 않는다. source-authentication/caller wire/dynamic/effective recipe·cold/configured·전체복원·phase 전체 gate/독립검토/main·운영/native/provider gate는 미완료다.

AWS 관리자 STS는 현재 `Token has expired and refresh failed`로 거절돼 새 로그인 가능 여부를 사용자에게 다시 질문했다. FUT-09 원문은 사용자가 전달 예정이라고 답했고, 이후 원문 없이 신규 시작 가능 여부를 질문했다. 신규 시작은 가능하며 기존 원문 이식 범위 변경 여부를 질문한 상태다. 답변 전 원문 이식을 완료/제외로 바꾸지 않는다. I/J/phase·graph 상태와 외부 not_executed는 유지하고 push는 사용자 작업이다.

## 출처 계약 커밋·실제 catalog/130 발견 후속 · 2026-10-08

`6189aa95`는 새 safe source provenance 계약/subpath와 exact tuple Map 최적화다. Root 현재46/46·persistence consumerTS0·API import0를 확인했으며 [I 기록](progress/M2-02i.md)에 남겼다. 비수동 external sourceRecordId redaction의 noninjective ordinal을 유지하고 source/event authentication을 주장하지 않는다.

Named profile19 catalog v3의 Root 첫PG는 alias 오류로1PASS/5FAIL이었다. 실제 공통 CTE의 description 컬럼에 맞춰 교정한 R2는4PASS/2 testcase timeout·exit1,360.55초이며 전체통과가 아니다. 실제 domain/type/view 및 FORCE RLS/unknown ACL testcase가90초를 넘었고 afterAll DB접속 잔존으로 실패했다. Root가 R2의 정확한 owned DB/roles whitelist만 정리한 뒤 inspector DB/roles/slots0를 확인했다. cleanup 출력의2/5는 대상 whitelist 크기이며 실제 삭제된 개수 계측이 아니다. unit35/35는 실제 전체PG 완료를 대체하지 않는다. 반복 whole metadata 계산을 줄이되 query30초/16MiB/250000visits/depth32를 유지하는 보완을 native actor에 배정했다. 지원false·dynamic/strict caller/effective recipe/실제cold gate는 유지한다.

SQL130 실제R1은5PASS/3FAIL·exit1,17.21초다. 두번째race삭제 뒤 역사 nutrition lineage 검증 CORRUPT, escapedID fixture의 실제V2command 계약 오류, RR/delete barrier locktimeout을 교정 중이다. Root 실제 정리0를 확인했다. 130 설치/구문이 실행됐다고 전체27 producer/출처census/계정V38/정상profile 설치·grant·최신restore를 완료로 세지 않는다. source/event fact를 현재 resolver로 재작성하거나 guard를 삭제하지 않는다.

정상400항목 planned presentation의 generic JSON5000-node 거절은 source 참조/array/512KiB 정책과 독립적인 검사 결함이었다. 같은 exact UTF8 plain helper로4MiB/8MiB를 검증하는 수정은 actor9파일 동결이며 Root 집중단위145/145와 별도 V37/renderer/reader58/58을 확인했다. 처음 Root 명령의 존재하지 않는 두 파일명은 실행 증거가 아니며 올바른 남은 파일을 별도로 실행했다. 실제 nutrition400 publicproducer→stored chain→129→V37 fixture는 native actor 준비 중이며 실제PG 미실행이다.

Root는 실제DB lane·sharedgraph/Git 통합, agent들은 비중복 구현/fixture/closure 감사를 병렬 진행한다. normalregistry107·현재 profile19·default34·graph I/J in_progress·main/push0, 운영503/외부native/provider not_executed와 AWS로그인/FUT09 범위 답변 대기를 유지한다.

## Catalog R3 성공·source130 R2 후속 · 2026-10-08

Root catalog R3는6/6 PASS·skip0·exit0,35.09초이며 unit36/36·정리0다. 반복계산을 MATERIALIZED 한 번으로 바꾸고 callback terminal 이후 정리해 한도 상향 없이 수용했다. `f1cbe784`에 관측기/시험/기록5파일만 phase 커밋했다. trusted compiled expected/dynamic/caller/effective recipe/cold 활성화는 아직없다. actual two-DB metadata artifact capture 준비를 native actor에 배정했으며 compiler/supporttrue를 자동생성하지 않는다.

Root SQL130 R2 실제8/8 PASS·skip0·exit0,13.70초 및 정리0를 확인했다. 새race삭제의 원origin과 과거lineage를 함께 보존하는 SQL 교정/V2fixture/RR 실제첫tenantlock barrier가 input이다. 이후 Root reader검토에서 reportedbytes보다 실제 compact body가 큰 응답을 shareddebit으로 받아들이는 경계 결함을 발견해 source/unit에 min(remaining,reported) exact byte 선guard를 배정했다. 새로운 public bounded-plain-json subpath는 Root manifest WIP이며 수정된 reader의 새검증 전 전체130완료/커밋하지 않는다.

Root dense actual public400 fixture R1은 live(세션54422)였으며 결과 전 PASS로 세지 않는다. 에이전트는 서로 겹치지 않는 V38계약2파일, source130reader2파일, private metadata capture script를 계속 준비한다. graph I/J·phase in_progress, main/push0·AWS/FUT09결정대기 및 외부not_executed 유지다.
