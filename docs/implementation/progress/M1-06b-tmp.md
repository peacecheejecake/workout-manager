# M1-06b-tmp · 임시 Garmin 앱 내 수집(비공식, 소유자 한정)

상태: **완료(2026-09-25).** 독립 보안 검토 1차(태그 `m1-06b-tmp-review-r1`, tree `c003efd9`) APPROVE 뒤 강화 항목 1–12(§9),
2차 REQUEST CHANGES(§10), 3차 APPROVE의 비차단 2건(§11)을 반영했고 4차(`m1-06b-tmp-review-r4`, tree `15274da9`) APPROVE
뒤 M2-01al 병합 위로 병합했다. 처음 기준 HEAD는 main `e00a992`였고, 반영 뒤 main `e54ef80` 위로
옮겼다(WIP 커밋 → rebase → `reset --mixed`, 충돌 없음). 사용자 결정(2026-09-25)과 수용 기준은
[임시 gate](../research/garmin-temporary-gate.md)의 조건 1–9다. **공식 연동이 아니며** `EXT-G`·`M0-07b`·`M1-06b`·`M2-07`·`G2`의
어떤 증거도 아니다. **실제 Garmin 계정 실행은 `not_executed`**다(소유자가 앱에서 로그인해야 하는 별도 증거).

## 1. 설계 근거

### 1.1 한 줄 요약

앱 설정 화면에서 배포 소유자가 Garmin에 한 번 로그인하면(MFA 포함), 서버가 Python 자식 프로세스로
`python-garminconnect`를 돌려 session만 받아 AES-256-GCM으로 저장한다. 이후 "지금 가져오기"나 소유자가 켠 예약이
같은 자식 프로세스 bridge로 최근 활동을 나열·다운로드하고, ORIGINAL FIT을 기존 import 경로로 넣는다.

### 1.2 TypeScript ↔ Python bridge: 작업당 자식 프로세스 하나

- **선택.** 로그인 1회(MFA 단계 포함) 또는 수집 run 1회마다 `python -I -m workout_manager.garmin_worker` 프로세스
  하나를 띄우고 stdin/stdout NDJSON으로만 대화한다(`packages/server/integrations/src/garmin/unofficial-worker.ts`,
  `src/workout_manager/garmin_worker.py`).
- **왜 상주 Python 서비스가 아닌가.** 포트가 없고, 멈추거나 죽은 worker는 상태째 SIGKILL된다. 대기 중인 MFA 상태는
  라이브러리 객체 안(`_mfa_session` 등, 직렬화 불가)에 있으므로, "그 로그인의 프로세스 자체"가 MFA 상태가 된다.
  TTL(5분)이 지나면 프로세스를 죽이는 것으로 상태가 사라진다. 디스크·DB에 쓰는 것이 없다.
- **비밀이 지나가는 길.** 비밀번호·MFA 코드·session은 stdin 한 줄로만 간다. argv는 고정이고 환경은 allowlist
  (`PATH`·`HOME`·`TMPDIR`·`LANG`·`PYTHONDONTWRITEBYTECODE`)이며 `HOME`·`TMPDIR`은 매번 새 0700 디렉터리다.
  `-I`로 `PYTHON*`·user site를 무시한다. stderr(라이브러리 자체 로그, scrubbing은 best effort)는 버린다.
- **token 파일 금지(세 겹).** Python: `GARMINTOKENS` 제거, client의 `dump`/`load`를 거부 함수로 교체, 로그인에
  token-store 경로를 넘기지 않고 inline JSON만 쓰며 `_tokenstore_path`가 비어 있는지 확인한다. TS: 프로세스 종료 후
  sandbox 전체(private HOME·TMPDIR·작업 디렉터리)에 파일이 하나라도 남으면 `SANDBOX_FILE_LEFT`로 실패시키고 session을
  저장하지 않는다(검토 1차 항목 4 전에는 HOME만 봤다).
- **기존 fetch 재사용.** transport 정책(`harden_client`·`harden_token_exchange`·`reharden_after_login`), 로그 scrubbing,
  `select_activities`(366일·200건·25페이지·직렬·최소 간격), `extract_original_fit`(zip 1멤버·64 MiB·CRC),
  `redact`/`scrub`, 비밀번호 8자 규칙을 그대로 쓴다. FIT → import 명령은 `export-activity`의 `detailed_commands`
  (details+bouts, revision 4)다. 라이브러리 자체 재시도는 `retry_attempts=0`으로 끈다.
- **실패 분류.** worker는 예외 원문을 내보내지 않고 `auth`/`mfa_invalid`/`rate_limited`(+`retryAfterSeconds`)/
  `transient`/`permanent`와 고정 code만 보낸다. `select_activities`가 공급자 예외를 메시지로 바꾸기 전에 분류를
  남기는 `ClassifyingSource`를 둔다.
- **선택 의존성.** `garminconnect`는 계속 `garmin` extra다. worker는 extra 없이 import되며, 시험은 `--fixture`의
  합성 provider(`garmin_fixture.py`, 라이브러리와 같은 token 파일 동작 포함)를 쓴다. CI는 기본 `uv sync --locked`만 한다.

### 1.3 수집 interface (공식 M1-06b와 공유)

`@workout/server-integrations/garmin-collection`의 `GarminActivityCollector`(provider·official·`collect(request)`)와
provider 중립 runner `runGarminCollection`. runner가 lease·session 복호화·CAS 되쓰기·원장·import·실패 정책을 맡고,
collector는 목록(`select` 콜백)과 다운로드(`accept`)만 한다. **runner는 collector를 DB 트랜잭션 밖에서만 부른다**
(각 store 호출이 짧은 트랜잭션 하나다).

- **import.** 기존 `ActivityRepository.importActivity`. collector 전용 idempotency key(`garmin-u-<명령 digest>`)를 써서
  수동 import receipt와 섞이지 않게 했다. 섞이면 수동으로 가져왔다가 지운 FIT에 대해 과거 receipt가 `imported`를
  답했다(데이터는 부활하지 않았지만 결과가 거짓). 지금은 import 경로가 `suppressed`를 답한다.
- **provider 간 중복.** `garmin_activity_ledger`(Garmin 활동 ID PK, 행마다 `provider`·`official`)를 두 collector가
  공유한다. 알려진 ID는 다운로드하지 않는다. 공식 활동 ID와 Garmin Connect 활동 ID가 같은지는 파트너 환경 확인 전
  가정이다.
- **출처.** `garmin_activity_ledger_source`가 원장과 `activity_source_head`를 잇고,
  `GET /bff/v1/activities/:id/collection-provenance`가 adapter와 무관하게(꺼져도) 답한다. 교체 뒤에도 표시가 남는다.

### 1.4 저장·소유자·실패 정책

- migration 048: `garmin_unofficial_connection`(상태·profile hash·암호화 session·lease·예약·차단·로그인 한도),
  `garmin_unofficial_run`(이력 20개, `running`은 연결당 하나: partial unique index), 원장 두 테이블. 모두 RLS.
  `erase_account`를 한 번 더 감싸 77206 → 0 → 행 순서로 네 테이블을 지운다. 공식 `garmin_connection`·철회 queue는
  건드리지 않는다.
- **소유자 한정.** `GARMIN_UNOFFICIAL_OWNER_ATHLETE_ID` 등 다섯 설정이 모두 있어야 켜지고, 없으면 라우트 자체가 없다
  (404). `CI` 환경에서는 무조건 꺼진다. 조건 3의 "CI에서 꺼짐"은 **배포 설정 경로**(`configuredGarminUnofficial`)에 대한
  것이다. identity E2E harness는 배포 설정을 거치지 않고 서비스를 직접 조립하며, 그때 worker는 항상 `--fixture`의 합성
  provider만 쓴다(`garminconnect`를 import하지 않고 네트워크에 닿지 않는다). 모든 라우트와 서비스 메서드가 `isOwner` 하나를 거쳐 다른 계정에
  `GARMIN_UNOFFICIAL_OWNER_ONLY` 403을 준다(본문 검증보다 먼저).
- **profile 고정.** 첫 성공 로그인에서 `HMAC-SHA-256(pin key, 'garmin-connect-profile:'+id)`를 고정한다. pin key
  (`GARMIN_UNOFFICIAL_PROFILE_PIN_KEY`, 32 byte 이상)는 session keyring과 별개이고 함께 회전하지 않는다. 처음에는 key
  없는 sha256이었고 profile ID가 작은 정수라 전수 대입으로 되돌릴 수 있었다(검토 1차 항목 2). 연결 해제 뒤에도 남는다.
  다른 profile 로그인은 409이고 그 session은 저장하지 않는다. run 때도 worker가 연 profile을 다시 대조한다.
- **session 암호화.** M1-06c `createGarminCipher`에 AAD purpose `unofficial-session`을 더했다. 별도 keyring 설정
  (`GARMIN_UNOFFICIAL_TOKEN_*`, 같은 형식)이다.
- **로그인 한도.** 15분 창 5회, 실패마다 1분부터 두 배(최대 1시간) 잠금, Garmin 429는 최소 15분. DB에 있어
  여러 인스턴스에서도 공유된다.
- **run.** lease 20분(인스턴스 간 한 번만), 매 목록·활동 처리 전 lease 재확인, 연결 해제 시 run은 `cancelled`이고
  갱신 session은 CAS에 실패해 버려진다. 429: `Retry-After`(없으면 1시간, 최소 15분)까지 모든 run 차단과 예약
  일시 중지. 인증 실패: 재시도 없이 session 삭제, `reconnect_required`. 일시 오류: 5분부터 최대 6시간 backoff.
  영구 오류: 예약 일시 중지. 예약은 6시간, 창은 최근 30일·50건.
- **MFA 다중 인스턴스 한계.** 대기 중 MFA는 그 인스턴스 메모리의 프로세스다. 인스턴스가 둘 이상이면 session
  affinity가 필요하다(runbook에 기록).

### 1.5 화면

`/account`(Next·Vite 두 shell의 `IdentityWorkspace`)에 공식 패널과 **분리된** "비공식 임시 Garmin 연결" 섹션:
경고(비공식·임시·약관·rate limit·예고 없는 중단·비밀번호가 서버를 한 번 지남·session의 전체 권한·소유자/첫 계정 고정),
자체 상태 문구, 로그인·MFA·지금 가져오기·예약·연결 해제, "비공식 가져오기 상태"(공식 동기화 상태가 아님을 명시),
철회 불가와 Garmin 쪽 세션 끊는 방법 안내. 계정 삭제 영역에 같은 경고를 slot으로 넣었다. 활동 상세의 출처에
"비공식 임시 Garmin 연결로 가져온 활동" 표시. 비소유자·adapter 꺼짐에는 아무것도 보이지 않는다. 비밀번호는
uncontrolled input에서 요청 본문으로만 가고 요청 직후 입력을 비운다.

## 2. 변경 파일

- Python: `src/workout_manager/garmin_worker.py`(신규), `garmin_fixture.py`(신규, 합성 provider),
  `tests/python/test_garmin_worker.py`(신규, 18).
- 계약: `packages/contracts/src/garmin-unofficial.ts`(신규), `package.json` export.
- 서버: `packages/server/integrations/src/garmin/{collection,unofficial-worker,unofficial-service}.ts`(신규),
  export 3개; `packages/server/identity/src/garmin-crypto.ts`(purpose 타입);
  `packages/server/persistence/migrations/048_garmin_unofficial.sql`, `src/garmin-unofficial.ts`(신규),
  `src/migrate.ts`(048·`grantGarminUnofficial`), `src/database.ts`(소유자 검사 목록), `package.json` export.
- API: `apps/api/src/garmin-unofficial-routes.ts`·`garmin-unofficial-deployment.ts`(신규), `app.ts`, `configured.ts`.
- UI(하위 에이전트 작성, root 검토): `packages/modules/identity/src/garmin-unofficial-panel.tsx`(+css),
  `identity-workspace.tsx`, `operations-panel.tsx`(slot), `packages/modules/activities/src/collection-provenance.tsx`
  (+css), `activity-browser.tsx`.
- 시험: `apps/api/tests/garmin-unofficial.test.ts`(13), `garmin-unofficial-collector.integration.test.ts`(16),
  `garmin-unofficial-fakes.ts`; `packages/server/integrations/tests/garmin-unofficial-worker.test.ts`(7, 실제 Python);
  `packages/server/persistence/tests/garmin-unofficial-upgrade.integration.test.ts`(2),
  `foundation.integration.test.ts`(48); UI `garmin-unofficial-panel.test.tsx`(19),
  `collection-provenance.test.tsx`(5), `identity-workspace.test.tsx`(+1, 기존 2개 fetch 계수 보정).
- E2E: `tests/identity/garmin-unofficial.spec.ts`(4), `scripts/fixtures/garmin-unofficial.ts`,
  `scripts/fixtures/oidc-provider.ts`(합성 계정 Carol 추가), `scripts/identity-e2e.mts`(소유자 Carol·합성 provider).
- drill: `scripts/backup-restore-drill.mts`(비공식 session seed·export 부재·복원 폐기 검사 2개),
  `docs/implementation/research/backup-restore-result.json`.
- CI: `.github/workflows/ci.yml`(quality·identity job에 기본 `uv sync --locked`).
- 문서: 이 파일, `garmin-setup.md`(설정·runbook·교체 절차), `operations-runbook.md`(복구 한 문단),
  `research/garmin-official-transition.md`(이음새 추가 문단).

## 3. 조건 1–9 대응

| 조건                  | 구현                                                                | 근거 시험                                             |
| --------------------- | ------------------------------------------------------------------- | ----------------------------------------------------- |
| 1 표시                | 분리된 패널·상태, 출처 라벨, status `official:false`, 원장 provider | UI 시험, E2E Next/Vite, M7a–d                         |
| 2(a) 비밀번호         | stdin만, 로그·응답·행·저장 session·argv·환경에 없음                 | API 로그 시험, worker 시험, 통합 password 시험, M3a–c |
| 2(b) MFA              | 프로세스 메모리, 앱 세션 결합, 5분 TTL                              | API MFA 시험(가짜 시계), worker MFA 시험, E2E, M9     |
| 2(c) 로그인 한도      | 창·backoff·429 잠금(DB)                                             | 통합, API 시험, M10                                   |
| 2(d) token 파일       | 세 겹 금지                                                          | pytest 2개, worker HOME 시험, M5a–c                   |
| 2(e) 키               | AES-256-GCM, 별도 purpose                                           | 통합·API 봉인 시험, M4a–b                             |
| 2(f) 철회 불가        | 화면 안내, 철회 queue 미사용                                        | UI·E2E 문구, 통합 queue 계수, M13                     |
| 2(g) export·복구·말소 | export 부재, 복원 폐기, 말소 삭제                                   | 통합 export·말소, drill 2검사, M6, M16                |
| 3 소유자              | 설정 필수·CI 꺼짐·403·profile 고정                                  | API·통합·E2E, M1, M2a–b, M14                          |
| 4 수집                | lease, 트랜잭션 밖 호출, 429·인증·일시/영구                         | 통합 7개, M11a–b, M12, M15                            |
| 5 데이터              | 기존 import·삭제 억제·출처                                          | 통합 2개, E2E 삭제 후 재실행, M8a–b                   |
| 6 교체                | 공유 interface·원장·runbook                                         | 통합 공식 원장 skip, `garmin-setup.md`                |
| 7 Python              | 선택 의존성, 자식 프로세스                                          | 기본 install 시험 통과, CI 변경                       |
| 8 증거                | 합성 fixture만                                                      | 실제 계정 `not_executed`                              |
| 9 변이                | §4                                                                  | §4                                                    |

## 4. 변이 시험 (single-anchor, 복원 `cmp` 확인)

도구: scratchpad의 `m106btmp-mutants.py`. 각 변이는 파일 하나의 한 곳만 바꾸고, 지정 시험을 돌린 뒤 원본으로 되돌려
`cmp`로 같음을 확인했다. 기준선(변이 전)은 모두 통과(API+worker 20, UI 24, 통합 16, pytest 18).
로그: `coverage/m1-06b-tmp-verification/mutants/*.log`, 결과 `results-round1.json`·`results-round2-M3bc.json`·`results.json`.

| ID   | 조건           | 변이                                          | 시험   | 결과 | 실패한 단언                         |
| ---- | -------------- | --------------------------------------------- | ------ | ---- | ----------------------------------- |
| M1   | 9 비소유자     | `isOwner`가 항상 true                         | api    | 죽음 | 다른 계정에 403                     |
| M2a  | 9 다른 profile | 로그인 commit의 profile 대조 제거             | int    | 죽음 | 다른 profile 거절                   |
| M2b  | 9 다른 profile | run의 `verifyAccount` 항상 true               | int    | 죽음 | 저장 session이 다른 profile         |
| M3a  | 9 request 로그 | 로그인 route가 body 로깅                      | api    | 죽음 | 로그에 비밀번호 없음                |
| M3b  | 9 argv         | 비밀번호를 `--min-interval` 인자로            | worker | 죽음 | spawn 인자에 비밀번호 없음(첫 단언) |
| M3c  | 9 job payload  | 저장 session(예약 run 입력)에 비밀번호 덧붙임 | int    | 죽음 | 저장 session에 비밀번호 없음        |
| M4a  | 9 평문 token   | seal이 base64 평문                            | int    | 죽음 | 복호 전 ciphertext에 session 없음   |
| M4b  | 2(e)           | purpose를 `tokens`로                          | api    | 죽음 | 공식 purpose로 복호 불가            |
| M5a  | 9 token 파일   | `GARMINTOKENS` 제거 호출 삭제                 | py     | 죽음 | env token store 미사용              |
| M5b  | 9 token 파일   | 로그인에 `~/.garminconnect` 경로              | py     | 죽음 | 로그인 성공·파일 없음               |
| M5c  | 9 token 파일   | TS HOME 검사 끔                               | worker | 죽음 | HOME 파일이면 실패                  |
| M6   | 9 말소 잔존    | 말소의 connection DELETE 제거                 | int    | 죽음 | 말소 후 네 테이블 비어 있음         |
| M7a  | 9 표시 제거    | 패널 경고 문구 제거                           | ui     | 죽음 | 비공식 경고                         |
| M7b  | 9 표시 제거    | 활동 출처 라벨 제거                           | ui     | 죽음 | 출처 라벨                           |
| M7c  | 9 표시 제거    | 원장 provider를 공식으로                      | int    | 죽음 | provenance가 unofficial             |
| M7d  | 9 표시 제거    | status `official: true`                       | api    | 죽음 | status가 unofficial                 |
| M8a  | 9 삭제 재수집  | import source kind를 바꿔 억제 우회           | int    | 죽음 | 삭제한 활동 재등장 없음             |
| M8b  | 9 삭제 재수집  | 원장 skip 제거                                | int    | 죽음 | 삭제 후 재다운로드 없음             |
| M9   | 2(b)           | MFA 세션 결합 제거                            | api    | 죽음 | 다른 세션에 MFA_EXPIRED             |
| M10  | 2(c)           | 잠금 검사 제거                                | int    | 죽음 | 창·backoff                          |
| M11a | 4              | 429에 예약 일시 중지 안 함                    | int    | 죽음 | schedule_paused                     |
| M11b | 4              | Retry-After 무시                              | int    | 죽음 | blocked_until ≥ Retry-After         |
| M12  | 4              | 인증 실패를 일시 오류로                       | int    | 죽음 | reconnect_required, 재시도 없음     |
| M13  | 2(f)           | 연결 해제가 철회 queue에 넣음                 | int    | 죽음 | queue 계수 불변                     |
| M14  | 3              | CI에서도 켜짐                                 | api    | 죽음 | CI면 null                           |
| M15  | 4              | 살아 있는 lease 무시                          | int    | 죽음 | 연결당 run 하나                     |
| M16  | 2(g)           | 복원에서 비공식 session 폐기 생략             | drill  | 죽음 | 복원 후 session 0개                 |

27개 모두 죽었고 모두 복원 `cmp` 일치. **변이 없이 단언만 있는 속성:** "provider 호출이 트랜잭션 밖"(계측
Database로 호출 시점의 열린 트랜잭션 0을 단언), export에 session 없음(투영 SQL이 새 표를 읽지 않으므로 변이를
만들 한 줄이 없다). M3b는 Python argparse도 같이 실패시키므로 시험을 재배치해 argv 단언이 먼저 실패함을 확인했다.
M3c는 1차에서 "session 정확 일치" 시험만 죽였고(비밀번호 전용 시험은 run이 session을 교체해 놓쳤다), 로그인 직후
session을 검사하도록 강화한 뒤 전용 시험도 실패함을 확인했다.

## 5. 검증 (실제 실행, 이 노드)

로그: `coverage/m1-06b-tmp-verification/`(git 무시 경로). 부하는 공유 머신 load average.

| 실행                                           | 결과                                                                      | 시간·부하                              |
| ---------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------- |
| `pnpm install --frozen-lockfile`               | 통과                                                                      | 1 s                                    |
| `pnpm check:generated`                         | 통과                                                                      | 0 s                                    |
| `pnpm lint`                                    | 통과(경고 0)                                                              | 23 s                                   |
| `pnpm typecheck`                               | 통과                                                                      | 37 s                                   |
| `pnpm build`                                   | 통과                                                                      | 20 s                                   |
| `pnpm test`                                    | 303 files / 3,690 tests 통과                                              | 92 s, load 16→19                       |
| `pnpm test:integration`(TEST_DATABASE_* 없음)  | 1+66 files / 1+663 tests 통과                                             | 86 s, load 19→8                        |
| `uv run ruff check .`, `ruff format --check .` | 통과                                                                      | —                                      |
| `uv run pytest`                                | 247 통과(extra 미설치)                                                    | 6 s                                    |
| backup-restore drill                           | passed, 78 checks(이전 76 + 2), cleanup 통과                              | load 6                                 |
| `pnpm test:identity` ×2 (lock)                 | 각 232 통과 · 3 skipped(oidc-certified 전용) · 실패 0. 이 노드의 4개 포함 | 11.7 m(load 4→21) / 11.0 m(load 21→23) |
| `pnpm format:check`(마지막)                    | 통과(마지막에 실행)                                                       | —                                      |

## 6. UI 확인 (Aside → Chrome → Playwright)

- **Aside(실행함).** 격리 harness(lock 보유)를 띄우고 `aside repl`로 Next shell에서 Carol 로그인 → 비공식 로그인 →
  MFA 코드 입력 → 연결됨 → "지금 가져오기" → 완료(목록 2·새로 가져옴 2) → 활동 상세 출처에 "비공식 임시 Garmin 연결로
  가져온 활동" 라벨(Next 3100·Vite 4200 두 shell 모두) → 연결 해제 → 연결되지 않음을 접근성 snapshot으로 확인했다.
  DOM에 비밀번호가 남지 않았다(`passwordInDom: false`). 스크린샷을 직접 봤다(연결 상태 패널: 경고·상태·버튼·철회 불가 안내·
  비공식 가져오기 상태가 공식 패널과 분리되어 보임). 증거: `coverage/m1-06b-tmp-verification/aside-result.txt`,
  `aside-artifacts/`.
- **Aside 한계.** `setViewportSize`가 이 Aside 버전에서 `TypeError: not a function`이라 폭을 바꾸지 못했다(1440 고정).
  그래서 **모바일(320)·태블릿(768) 폭은 Playwright**로 확인했다: `garmin-unofficial.spec.ts`의 Next shell 연결 상태와 Vite
  shell 연결 상태에서 320·768 px 가로 넘침 없음. Chrome(computer-use)은 이 세션에 도구가 없어 쓰지 않았다.
- 활동 출처 스크린샷은 목록 상단만 찍혀 라벨은 snapshot 텍스트로만 확인했다.

## 7. 매트릭스 판정 제안 (`m2-01k-requirement-matrix.json`, root 재판정)

- **V2-A20**(로컬 삭제 후 provider 이벤트 재수신 → 재등장 방지): **`partial` 유지, 새 증거 추가.** 이 노드에서 수집
  경로가 같은 활동을 다시 받는 두 경우 — 수집 후 삭제(원장이 재다운로드를 막음), 수동 import 후 삭제(수집 import가
  `suppressed`) — 를 실제 PostgreSQL 통합 시험과 두 shell E2E로 실행했고 M8a·M8b가 각각 실패한다. 그러나 provider는
  임시·소유자 한정 adapter 뒤의 **합성 fixture**이고, 제품의 provider 이벤트 경로는 아직 없다. 그래서 `passed`가 아니다.
- 매트릭스에 Garmin 전용 행(F25–F28 등)은 없다. 다른 행의 변경 제안은 없다. **`not_executed`를 통과로 바꾸지 않는다.**

## 8. 열린 항목

- **실제 Garmin 계정 실행 `not_executed`.** 로그인 전략·MFA·실제 목록·ORIGINAL zip·429·`Retry-After`·session 갱신과
  CAS 되쓰기를 실제로 확인하지 않았다. 소유자가 앱에서 로그인해야 하는 별도 증거다.
- 0.3.16은 `_run_request`의 429를 응답 없이 새 예외로 올리므로 `Retry-After`가 대개 사라진다. 그 경우 기본 1시간이다.
- JWT_WEB 대체 로그인(DI token 없음)은 저장할 session이 없어 `SESSION_NOT_PERSISTABLE`로 실패한다(실제 빈도 미확인).
- MFA 대기 상태는 인스턴스 메모리다. 다중 인스턴스는 session affinity가 필요하다.
- 비공식 session은 Garmin 계정 전체 권한이다. 읽기 전용 wrapper는 보안 경계가 아니다(fetch 기록과 같음).
  서버 침해 시 피해 범위가 CLI보다 넓다(사용자가 받아들인 위험).
- ORIGINAL FIT의 원본 bytes·GPS track은 저장하지 않는다(요약·details·bouts만). track 저장은 후속 선택.
- 수집 창은 최근 30일·50건 고정이다. 더 오래된 활동은 CLI `fetch`로 받는다.
- 공식 활동 ID = Garmin Connect 활동 ID 가정은 파트너 환경 재확인 전까지 가정이다.
- 예약 tick은 API 프로세스 안(60초)이다. worker 앱으로 옮기는 것은 후속 선택이다.

## 9. 독립 검토 1차 강화 (m1-06b-tmp-review-r1)

검토 결과는 APPROVE, 차단 0건이었다. 검토자는 M3a/b/c·M5a/b/c·M6과 자체 M6b(말소 후 원장 잔존)를 다시 죽였다.
아래 강화 항목을 모두 반영했다.

| #   | 항목                                 | 반영                                                                                                                                                                                                                                                                 | 근거(시험·변이)                                                                                                                                    |
| --- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | session 되쓰기 CAS 무시험(CAS1 생존) | 통합 시험 3개: 오래된 generation, 오래된 lease id, 해제 후 재로그인. 각각 false이고 새 session 유지                                                                                                                                                                  | CAS1(WHERE를 athlete_id만으로) → 3개 모두 실패, 죽음                                                                                               |
| 2   | profile pin이 key 없는 sha256        | HMAC-SHA-256, 전용 `GARMIN_UNOFFICIAL_PROFILE_PIN_KEY`(필수·32 byte 이상·회전 안 함). migration 주석·runbook 갱신                                                                                                                                                    | 통합 "keyed HMAC" 시험, 설정 시험(누락·짧은 key 거절); M17(빈 key HMAC) 죽음                                                                       |
| 3   | stdout 버퍼 무한·O(n²)               | `LineQueue`: 바이트를 받는 즉시 누적, 한 줄과 전체 버퍼를 같은 상한(48 MiB)으로 묶음, 받지 않은 줄이 있으면 stdout pause                                                                                                                                             | 단위 4개(분할 줄·pause/resume, 다중 바이트, 전체 버퍼, 32 MiB 1 KiB 조각 선형) + 실제 프로세스 초과 줄 → `WORKER_OUTPUT_TOO_LARGE`; M19a·M19b 죽음 |
| 4   | HOME만 검사                          | 종료 뒤 sandbox 전체(HOME·TMPDIR·cwd) 검사, 파일 하나라도 있으면 `SANDBOX_FILE_LEFT`                                                                                                                                                                                 | worker 시험: TMPDIR·cwd·HOME 각각; M18(HOME만) 죽음, M5c 죽음                                                                                      |
| 5   | 잃어버린 key가 영원히 일시 오류      | 복호 실패는 `reconnect_required`(envelope 삭제), 이벤트 코드 `CREDENTIAL_UNREADABLE`                                                                                                                                                                                 | 통합 "unreadable session" 시험(keyId를 모르는 값으로); M20 죽음                                                                                    |
| 6   | 비소유자에게 400/413이 403보다 먼저  | scope 안에서 Fastify content-type parser를 모두 제거하고 원문 문자열 parser 하나만 둔다. JSON 파싱·content-type·query 검증은 소유자 확인 뒤 handler에서 한다. **남은 예외:** bodyLimit(16 KiB) 초과 413과 CSRF·세션 검사는 모든 라우트처럼 인증 단계에서 먼저 답한다 | API 시험: 비소유자에게 깨진 JSON·text/plain·xml·query 모두 403, 소유자는 400/415; M21 죽음                                                         |
| 7   | core dump                            | `garmin_worker.main()`이 가장 먼저 `RLIMIT_CORE=(0,0)`                                                                                                                                                                                                               | pytest 2개(호출 순서, 실제 자식 프로세스 getrlimit); M22 죽음                                                                                      |
| 8   | 종료 시 진행 중 로그인               | 서비스가 로그인 worker를 AbortController로 추적하고 `close()`에서 abort → 프로세스 SIGKILL. 늦게 온 결과는 저장하지 않음                                                                                                                                             | API 시험(종료 후 저장 없음), 실제 프로세스 시험(30초 지연 로그인이 abort로 즉시 `WORKER_ABORTED`); M23 죽음                                        |
| 9   | "CI에서 꺼짐" 범위                   | §1.4에 배포 설정 경로 한정과 harness의 합성 worker를 적었다                                                                                                                                                                                                          | 문서                                                                                                                                               |
| 10  | 배포 grant 단계                      | `garmin-setup.md`의 grant 코드에 `grantGarminUnofficial`을 넣고, adapter가 꺼져도 출처 조회가 연결되어 있어 필요함과 `grantGarmin`의 같은 성격을 적었다                                                                                                              | 문서                                                                                                                                               |
| 11  | migration 번호                       | 048 유지(병합 때 root가 재번호)                                                                                                                                                                                                                                      | —                                                                                                                                                  |
| 12  | V2-A20                               | `partial` 유지, 새 증거로 수정(§7)                                                                                                                                                                                                                                   | 문서                                                                                                                                               |

변이 재실행: 기존 27개 + 새 9개(CAS1, M17, M18, M19a, M19b, M20, M21, M22, M23) = 36개 모두 죽음, 모두 복원 `cmp` 일치.
M3a·M3c는 코드가 바뀌어 anchor를 새 줄로 옮겼다. 기준선: API+worker 31, UI 24, 통합 21, pytest 20 모두 통과.
로그: `coverage/m1-06b-tmp-verification/mutants/`(이전 회차는 `mutants-r1-prev/round0/`).

### 9.1 재검증 (e54ef80 위)

로그: `coverage/m1-06b-tmp-verification/`(`v-*.log`, `r1-*.log`; 1회차 로그는 `round0-logs/`).

| 실행                                                               | 결과                                                               | 시간·부하                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------- |
| install --frozen-lockfile, check:generated, lint, typecheck, build | 모두 통과                                                          | lint 24 s, typecheck 39 s, build 27 s |
| `pnpm test`                                                        | 310 files / 3,770 tests 통과                                       | 99 s, load 86                         |
| `pnpm test:integration`(TEST_DATABASE_* 없음)                      | 1+66 files / 1+669 tests 통과                                      | 89 s, load 46                         |
| ruff check, ruff format --check                                    | 통과                                                               | —                                     |
| `uv run pytest`                                                    | 249 통과(extra 미설치)                                             | 3 s                                   |
| backup-restore drill                                               | passed, 78 checks, cleanup 통과(결과 JSON은 main 판에서 다시 실행) | load 33–35                            |
| `garmin-unofficial.spec.ts`(두 shell, lock)                        | 4 통과                                                             | 19.4 s, load 17–20                    |
| 변이 36개                                                          | 모두 죽음, 복원 `cmp` 일치                                         | —                                     |
| `pnpm format:check`(마지막)                                        | 통과                                                               | —                                     |

전체 `pnpm test:identity` ×2는 1회차(§5)에서 실행했고 이번에는 조정자 지시대로 이 노드 spec만 다시 돌렸다.

## 10. 독립 검토 2차 (REQUEST CHANGES) 반영

2차 검토는 1–12를 모두 FIXED로 판정했지만, 새 `LineQueue`가 만든 **차단 회귀 1건**을 찾았다.

- **차단: 줄이 queue에 남은 채 run이 끝나면 영원히 멈춤.** `LineQueue`가 `child.stdout`을 pause하고
  `WorkerProcess.close()`가 SIGKILL 뒤 `'close'`를 기다렸다. 읽지 않은 데이터가 있는 paused stream은 `'close'`를 내지
  않는다(exit flush가 resume해도 `push`가 다시 pause한다). 결과: 서비스의 `running`이 영원히 풀리지 않아 그 인스턴스가
  다시 수집하지 못하고, `service.close()`가 API `onClose`를 멈추며, sandbox가 지워지지 않았다.
  - **수정.** `close()`가 기다리기 전에 `LineQueue.close()`(queue를 비우고 이후 push·pause를 멈춤)와
    `child.stdout.destroy()`를 한다.
  - **시험.** 가짜 worker(Node)가 `opened`·`listed` 뒤 stdout을 계속 쏟아 낸다. 느린 소비자에서 (a) abort(연결 해제)와
    (b) 소비자 예외로 run을 끝내고, 각각 15초 안에 끝남(`aborted` / 일시 실패)을 단언한다.
  - **변이 M24**(두 줄 제거): 두 시험 모두 `HUNG`로 실패, 죽음.
- **비차단: 다운로드 중 kill의 오탐.** SIGKILL(시간 초과·abort)로 끝난 worker가 남긴 자기 다운로드 파일
  (`TMPDIR/garmin-collect-*/original.fit`)이 영구 `SANDBOX_FILE_LEFT`가 되어 예약을 멈췄다.
  - **수정.** 그 경로 하나만, 그리고 프로세스가 **signal로 죽었을 때만**(시간 초과·abort·출력 초과의 SIGKILL) 예외로 둔다
    (3차 검토 반영: 처음 판은 exit code가 0이 아니면 모두 면제해 protocol 종료 2도 포함했다). 스스로 exit한 경우는 0이든 2든 면제하지 않는다. HOME·cwd·다른 TMPDIR
    파일, 그리고 정상 종료 뒤 남은 파일은 여전히 실패다.
  - **시험.** 가짜 worker가 그 파일을 쓰고 멈춤 → 시간 초과 → `transient`/`WORKER_TIMEOUT`.
  - **변이 M25** 죽음. 기존 HOME·TMPDIR·cwd 시험과 M5c·M18은 그대로 죽는다.
- **비차단: `submitMfa`의 종료 가드.** 시작 시 `closed`면 `GARMIN_UNOFFICIAL_UNAVAILABLE`. 진행 중이던 제출도 종료 뒤에는
  결과를 저장하지 않는다. API 시험 1개를 추가했다. 변이 M26a(시작 가드 제거)·M26b(제출 후 가드 제거) 모두 죽음.
- **비차단: 부하 시 flake.** 실제 Python 프로세스를 쓰는 worker 시험 파일의 기본 5초 시험 제한이 load 59에서 넘칠 수
  있었다(가장 유력한 원인이다. 검토자가 실패한 시험 이름을 남기지 않아 확정하지는 못했다).
  - **수정.** 이 파일의 시험 제한을 60초로 올렸다. 시간 상한 단언도 느슨하게 했다: 선형성 5초 → 30초, abort 10초 → 25초.
  - **확인.** worker+API 두 파일을 6회 반복했고 매회 35/35 통과했다(load 15–19,
    `coverage/m1-06b-tmp-verification/r2-repeat.log`). load 59 재현은 하지 못했다.

변이: 기존 36개 + 새 4개(M24, M25, M26a, M26b) = 40개 모두 죽음, 모두 복원 `cmp` 일치. M5c는 anchor를 새 판정식으로
옮겼다. 기준선은 worker+API 35, UI 24, 통합 21, pytest 20으로 모두 통과했다. 로그는 `mutants/`, 이전 회차는
`mutants-r1-prev/round1/`에 있다.

### 10.1 재검증

로그: `coverage/m1-06b-tmp-verification/r2-*.log`. 기준 HEAD는 main `e54ef80`이다.

| 실행                                        | 결과                                          | 시간·부하          |
| ------------------------------------------- | --------------------------------------------- | ------------------ |
| `pnpm lint`, `pnpm typecheck`               | 통과                                          | —                  |
| `pnpm test`                                 | 310 files / 3,774 tests 통과                  | load 24–38         |
| 통합(수집·upgrade 파일, 격리 PostgreSQL)    | 2 files / 23 tests 통과                       | —                  |
| pytest `test_garmin_worker.py`              | 20 통과                                       | —                  |
| worker+API 반복 6회                         | 매회 35/35                                    | load 15–19         |
| 변이 40개                                   | 모두 죽음, 복원 `cmp` 일치                    | —                  |
| `garmin-unofficial.spec.ts`(두 shell, lock) | 4 통과                                        | 23.2 s, load 22    |
| `pnpm test:identity` 전체 1회(lock)         | 249 통과 · 3 skipped(oidc-certified) · 실패 0 | 11.7 m, load 19–23 |
| `pnpm format:check`(마지막)                 | 통과                                          | —                  |

## 11. 독립 검토 3차 (APPROVE, 비차단 2건) 반영

- **면제를 signal kill로 한정.** `WorkerProcess`가 exit code 대신 종료 signal을 기록하고, 다운로드 파일 면제는 signal로
  끝났을 때만 적용한다. 코드 주석과 §10을 고쳤다.
- **시험.** 가짜 worker가 `TMPDIR/garmin-collect-*/original.fit`을 남기고 스스로 exit 0, exit 2로 끝나는 두 시험을
  추가했다. 둘 다 `SANDBOX_FILE_LEFT`를 단언한다. 기존 "시간 초과 kill은 transient" 시험도 유지했다.
- **변이 M25x**(면제를 항상 적용, 즉 스스로 exit한 뒤에도 적용): exit 0·exit 2 시험이 모두 실패해 죽음. worker 파일 변이
  M3b·M5c·M18·M19a·M19b·M24·M25와 M26a·M26b를 다시 돌렸고 모두 죽었으며 복원 `cmp`도 일치했다
  (`coverage/m1-06b-tmp-verification/r3-mutants-run.log`, 2차 전체 결과는 `mutants/results-r2-all40.json`).
- **재검증.** worker+API Garmin 시험 37 통과, pytest(worker) 통과, `pnpm lint`·`pnpm typecheck` 통과,
  `pnpm format:check` 통과(마지막). 로그: `r3-*.log`.

## 12. 독립 검토 4차 (APPROVE) · 병합

- 4차 검토(태그 `m1-06b-tmp-review-r4`, tree `15274da9`)는 §11의 두 항목을 FIXED로 판정했다. 검토자가 M25x, "exit code 0만
  아니면 면제"(3차 의미), "면제 없음", M24를 직접 돌려 모두 죽었고, worker+API Garmin 시험 37건이 통과했다. signal 종료가 외부
  원인(OOM-killer 등)이어도 면제는 worker 자신의 FIT scratch 파일 하나에만 적용되고 run은 transient 실패로 끝나므로 자격 증명
  안전과 무관하다고 판단했다.
- 병합 때 main에는 047까지만 있어 migration 048을 그대로 썼다(§9 항목 11의 재번호는 필요 없었다).
