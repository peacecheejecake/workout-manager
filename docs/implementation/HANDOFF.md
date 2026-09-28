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
`G2-PUBLIC`을 요구한다. 2026-09-29 사용자는 호스팅 진행과 AWS 사용을 결정했다. 리전·예산·
도메인 및 CLI 로그인은 아직 정해지지 않았고, [EXT-HOSTING](progress/EXT-HOSTING.md)은
`in_progress`이나 실제 배포 시험은 `not_executed`다.

**최신 M0-06c 판정(2026-09-27):** 별도 서명 작성 앱의 합성 심박수 1건 저장 뒤, 종료된 probe의 새 background launch와 observer callback을 실기기에서 확인했다. [실행·정리 기록](progress/M0-06c-native-host-addendum.md#별도-서명-작성-앱으로-실제-wake-확인--2026-09-27)에 따라 M0-06c의 제한된 feasibility 범위는 `completed`다. 아래 초기 phase·실기기 기록의 `in_progress`와 `not_executed`는 해당 시점의 결과다. 미저장 Back 버튼별 기계 기록과 제품 native host 통합은 남아 있으며 제품 범위는 M3-01이다.

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
  쓴다). runbook에 이 단계는 아직 없다(후속).
- migration 소유 역할은 051·052·055(M2-01at·M2-01au·M2-01av)부터 superuser나 BYPASSRLS가 아니어도 된다. 단 그 역할이 migration을
  직접 적용했을 때만이며, 소유를 옮겼다면 **가장 먼저** `select retarget_definer_policies();`를 새 소유자로 실행한다(그 전에는 055의 8개 원천
  표 쓰기도 `42501`로 실패). 복원 replay의 외래 id 확인은 identity 계정이 있는 tenant만 본다. object key의 tenant와 다른 tenant의 행은
  object 정리에서 보이지 않는다. 최악의 prune 비용은 호출당 약 0.35 s(그 뒤 한 시간 미룸). 055의 trigger는 썸네일 갱신에 약 +250 µs를 더한다.
  object key가 tenant를 이름 붙이지 않으면 정리 authorize가 `INCONSISTENT_LEDGER:OBJECT_KEY_TENANT`로 닫는다.
- 성능 판정 run은 M2-01ar 뒤의 probe로만 기록한다. 2026-09-25T15:00Z 뒤에 옛 probe로 기록한 판정 run은 `verifyRerunPolicy`가
  거부한다. 브라우저 판정은 harness lock 아래에서 `node --import tsx scripts/run-browser-performance-budget.mts --execute`로 돌린다. 이력
  검사는 `git merge-base HEAD main`을 부르므로 CI checkout은 history와 로컬 `main` ref가 있어야 한다(지금은 없으면 skip으로 보고된다).

## 다음 작업 순서

M0-06c의 실제 wake는 위 최신 기록으로 확인했다. 미저장 Back 확인창의 버튼별 기계 기록은 없으며 제품 native host 통합은 M3-01이다.

1. **M2-01k 남은 gate**: `M2-01k-t`에서 Vite의 대시보드·웰빙·활동 편집 경로와 두 shell의
   비공개 상태 수명을 로컬 검증했다. 실제 OS focus·운영 OIDC·실기기 증거가 없어 `P5-logout-clear`는
   제품 전체 행에서 partial이다. `P8-ui-component`는 후속 M2-01k-p 검증으로 passed가 됐다.
   실제 호스팅·실기기 증거는 별도 gate로 남기고, 공식 Garmin은 후속 계획으로 이관했다.
2. **외부 gate**: EXT-HOSTING(AWS 배포 준비 중; 리전·예산·계정 로그인 결정 대기,
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
