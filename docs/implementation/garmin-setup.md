# Garmin OAuth 연결 설정

기존 [OIDC 앱 로그인](oidc-setup.md)은 유지한다. 이 설정은 로그인한 앱 계정의 Garmin 데이터 연결용이다.
공식 client 발급·entitlement 증거는 아직 없으며 실제 Garmin 계정으로 검증하지 않았다.
공식 자동 활동 수집은 별도 M1-06b 범위다. [설계와 완료 구분](garmin-oauth.md) 참고.

## 서버 설정

| 환경 변수                    | 용도                                                           |
| ---------------------------- | -------------------------------------------------------------- |
| `GARMIN_CLIENT_ID`           | 공식 앱 client ID                                              |
| `GARMIN_CLIENT_SECRET`       | 공식 앱 client secret, 서버 전용                               |
| `GARMIN_TOKEN_KEY_ID`        | 새 암호화에 사용할 key ID                                      |
| `GARMIN_TOKEN_KEYS_JSON`     | key ID → base64로 인코딩한 32-byte AES key의 JSON object       |
| `PUBLIC_ORIGIN`              | 기존 앱의 public origin; production HTTPS                      |
| `GARMIN_WORKER_DATABASE_URL` | 철회 worker 전용 최소 권한 PostgreSQL 연결; API runtime과 분리 |

네 `GARMIN_CLIENT_*`/`GARMIN_TOKEN_*` 항목을 모두 생략하면 기존 OIDC는 동작하며 Garmin 연결 시작만
비활성화된다. 일부만 제공하면 API 시작을 거절한다. 비활성 상태에서도 DB에 남은 연결 상태를 표시하고
로컬 연결 해제 요청을 기록한다. 공급자 측 철회는 정상 설정의 worker가 실행해야 완료된다.

Callback 등록 대상은 `https://<public-host>/bff/v1/integrations/garmin/callback`이다.
기존 OIDC callback `/bff/v1/auth/callback`과 다른 경로다. 등록 가능 값은 실제 파트너 설정에서 확인한다.
production adapter는 공개 명세의 고정 Garmin origin을 사용한다. 임의 provider URL을 환경 변수로
주입할 수 없으며, loopback fixture는 격리된 테스트 harness에서만 직접 구성한다.

비밀 값은 secret manager로 주입하고 저장소·로그·브라우저에 기록하지 않는다. key는 충분한 난수로
생성하며 문서의 예제 문자열을 실제 key로 사용하지 않는다. AES-256-GCM additional authenticated data는
provider·key ID·앱 계정·용도에 결합된다. 새 key ID로 전환하더라도 이전 ciphertext가 모두 교체·폐기될
때까지 이전 key를 keyring에 보존한다. 일괄 재암호화 도구나 운영 key rotation 검증은 아직 제공하지 않는다.

## DB 및 철회 worker

Migration owner로 migration 006까지 적용하고 기존 identity/operations grants와 함께 실행한다.
role은 배포 담당자가 별도로 만들며 superuser·BYPASSRLS·테이블 소유자 권한을 주지 않는다.

```ts
await migrate(deploymentDatabaseUrl);
await grantIdentityFunctions(deploymentDatabaseUrl, runtimeRole);
await grantOperations(deploymentDatabaseUrl, runtimeRole);
await grantGarmin(deploymentDatabaseUrl, runtimeRole);
await grantGarminWorker(deploymentDatabaseUrl, garminWorkerRole);
// migration 048부터: 비공식 임시 수집(M1-06b-tmp)을 켜지 않아도 필요하다(아래 참고).
await grantGarminUnofficial(deploymentDatabaseUrl, runtimeRole);
```

`grantGarminUnofficial`은 adapter를 켜지 않은 배포에도 실행한다. 활동 출처 조회
(`GET /bff/v1/activities/:id/collection-provenance`)는 adapter와 무관하게 항상 연결되어
`garmin_activity_ledger`를 읽고, 계정 말소(`erase_account`, SECURITY DEFINER)는 grant와 무관하게 동작하지만
출처 조회는 runtime role의 SELECT가 없으면 500이 된다. `grantGarmin`도 같은 성격의 공백이 있다:
Garmin 설정을 생략한 배포에서도 상태 조회와 운영 상태(`garmin_connection`)가 연결되어 있으므로 grant를 빼면 안 된다.

위 helper는 `packages/server/persistence/src/migrate.ts`에 있다. API runtime은 현재 tenant의
연결·시도와 제한된 함수만 사용한다. worker는 다른 tenant의 일반 앱 데이터나 queue table에 직접
접근하는 대신 lease/prepare/ack 전용 함수로 철회 작업을 처리한다.

배포 scheduler에서 아래 명령을 주기적으로 실행한다. 한 번에 최대 20건을 처리한다.

```bash
pnpm exec tsx scripts/process-garmin-revocations.mts --execute
```

계정 삭제·연결 해제는 새 수집과 진행 중인 시도의 commit을 차단하고, 암호화된 철회 작업을 남긴다.
worker는 필요한 경우 token을 갱신하고 사용자 ID·현재 연결 소유권을 확인한 뒤 registration을 철회한다.
공급자 오류는 비밀 원문을 출력하지 않고 재시도한다. worker 출력의 `processed`는 시도 건수이며
공급자 철회 성공 건수가 아니다. API 프로세스만 실행해서는 queue 처리가 진행되지 않는다.

Cleanup credential의 보존 상한은 생성 후 24시간과 refresh 만료 중 이른 시점이다. 만료 정리는 worker가
수행하므로 scheduler 중단 시 물리적 삭제도 지연된다. 처리 중인 lease는 안전한 정리·재연결 순서를 위해
종료까지 보호한다. 상한 도달 시 로컬 credential을 폐기해도 공급자 철회 성공을 보장하지 않는다.
공급자 측 공유 상태가 불확실하면 사용자가 Garmin Connect에서 공유 권한을 확인·철회해야 한다.

다른 앱 계정이 같은 Garmin 사용자 연결을 소유하면 새 연결을 거절한다. registration 철회는 기존
소유자의 연결까지 끊을 수 있어 이 경우 새 grant를 무조건 원격 철회하지 않는다. 사용자 식별을 아직
못한 실패 grant는 소유권을 확인하기 전까지 원격 철회하지 않고 제한된 cleanup queue로 격리한다.

DB 복구 시에는 기존 삭제 원장 재적용과 세션 폐기뿐 아니라 Garmin credential·미완료 OAuth 시도도
재검토해야 한다. [운영 runbook](operations-runbook.md)의 복구 절차를 따라 과거 token이 되살아나지
않도록 한다. 외부 공급자 호출과 DB commit은 분산 transaction이 아니므로 token 회전 직후 process가
중단되는 경우 등은 재연결이 필요할 수 있다. 실제 운영 배포·장애 복구는 별도 검증 대상이다.

## 로컬 검증

`pnpm test:identity`는 기존 로컬 OIDC와 독립 PostgreSQL에 loopback Garmin OAuth fixture를 추가한다.
3100/4300/4400/4500 포트를 사용한다. fixture 화면은 실제 Garmin이 아님을 표시하고 개인 계정이나 건강
자료를 받지 않는다. UI의 연결됨은 OAuth 등록 상태이며 Activity/Health 자동 수집 성공을 뜻하지 않는다.

개발용 화면을 직접 보려면 `pnpm build` 후 별도 터미널에서 다음 두 명령을 실행한다.

```bash
pnpm exec tsx scripts/identity-e2e.mts
pnpm --filter @workout/web start
```

임시 harness는 자신의 DB와 fixture server만 만들고 종료 시 정리한다. production credential이나
상속된 `DATABASE_URL`을 쓰지 않는다. 실제 Garmin 검증은 EXT-G 충족 뒤 별도 기록한다.

## 비공식 임시 수집 (M1-06b-tmp)

**공식 연동이 아니다.** 공식 권한(`EXT-G`)을 기다리는 동안 배포 소유자 한 명이 자기 Garmin 계정의 새 활동을 앱으로
가져오는 임시 경로다. `python-garminconnect`로 문서화되지 않은 Garmin Connect endpoint를 쓴다. 조건과 받아들인 위험은
[임시 gate](research/garmin-temporary-gate.md), 구현 기록은 [M1-06b-tmp](progress/M1-06b-tmp.md)에 있다. 이 경로는
`M1-06b`·`M2-07`·`G2`의 증거가 아니다.

### 설정

다섯 값을 모두 설정할 때만 켜진다. 모두 생략하면 꺼지고(라우트 자체가 없다), 일부만 설정하면 API 시작을 거절한다.
`CI`가 설정된 환경(빈 값·`0`·`false` 제외)에서는 설정과 무관하게 꺼진다.

| 환경 변수                            | 용도                                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `GARMIN_UNOFFICIAL_OWNER_ATHLETE_ID` | 사용할 수 있는 유일한 앱 계정 ID. 다른 계정은 `GARMIN_UNOFFICIAL_OWNER_ONLY` 403                |
| `GARMIN_UNOFFICIAL_PYTHON`           | `uv sync --extra garmin`으로 만든 환경의 Python 절대 경로                                       |
| `GARMIN_UNOFFICIAL_TOKEN_KEY_ID`     | session 암호화 key ID                                                                           |
| `GARMIN_UNOFFICIAL_TOKEN_KEYS_JSON`  | key ID → base64 32-byte AES key. M1-06c와 같은 형식, secret manager로 주입                      |
| `GARMIN_UNOFFICIAL_PROFILE_PIN_KEY`  | base64 32 byte 이상 난수. profile 고정 HMAC key. session keyring과 별개이며 **회전하지 않는다** |

`garminconnect==0.3.16`은 선택 의존성(`[project.optional-dependencies].garmin`)이다. 기본 `uv sync`와 CI는 받지 않는다.
DB는 migration 048 적용 뒤 `grantGarminUnofficial(url, runtimeRole)`을 실행한다.

### 동작 요약

- **Bridge.** 요청마다(로그인 1회 또는 수집 1회) Python 자식 프로세스 하나를 띄우고 stdin/stdout NDJSON으로만 대화한다.
  argv는 고정(`-I -m workout_manager.garmin_worker`), 환경은 allowlist(PATH·HOME·TMPDIR·LANG)이며 HOME·TMPDIR은
  매번 새 0700 디렉터리다. 비밀번호·MFA 코드·session은 stdin으로만 간다. 프로세스가 끝난 뒤 그 HOME에 파일이
  하나라도 있으면 token 파일로 보고 실패로 닫는다. stderr(라이브러리 로그)는 버린다.
- **Session 저장.** 라이브러리 token 파일은 쓰지 않는다(`GARMINTOKENS` 제거, `dump`/`load` 거부, token-store 경로 미전달).
  session은 AES-256-GCM으로 `garmin_unofficial_connection.encrypted_session`에만 저장하며 AAD purpose가
  `unofficial-session`이라 공식 credential로 복호화되지 않는다. 갱신된 session은 run lease와 generation CAS로만 되쓴다.
- **소유자·profile 고정.** 첫 로그인 성공 때 Garmin profile ID의 HMAC-SHA-256(전용 pin key)을 고정한다.
  profile ID는 작은 정수라 key 없는 digest는 전수 대입으로 되돌릴 수 있으므로 key를 쓴다. pin key를 바꾸면
  소유자 자신의 Garmin 계정도 다른 계정으로 보이므로 session keyring과 함께 회전하지 않는다. 바꿔야 한다면 먼저
  아래 "고정 해제"를 한다. 연결 해제 뒤에도 남으므로 다른
  Garmin 계정은 계속 거절된다. 고정을 풀려면 운영자가 아래 "고정 해제"를 수행한다.
- **MFA.** 대기 중인 MFA는 그 로그인의 Python 프로세스 자체이며, 이 API 인스턴스 메모리에만 있고 시작한 앱 세션에
  묶이며 5분 뒤 종료된다. **API 인스턴스가 둘 이상이면** 같은 앱 세션의 MFA 제출이 같은 인스턴스로 가도록 session
  affinity가 필요하다(없으면 `GARMIN_UNOFFICIAL_MFA_EXPIRED`로 처음부터 다시 로그인). run·lease·로그인 제한은 DB에
  있으므로 여러 인스턴스에서도 한 번만 돈다.
- **로그인 한도.** 15분 창에 5회, 실패마다 1분부터 두 배씩 최대 1시간 잠금, Garmin 429는 최소 15분 잠금.
- **수집.** "지금 가져오기"와 소유자가 켠 6시간 예약. 연결당 run 하나(lease 20분). 최근 30일·최대 50건,
  목록 25페이지, 요청 간 최소 1초(기본 2초)는 기존 fetch 경계다. provider 호출은 DB 트랜잭션 밖이다.
  429는 `Retry-After`(없으면 1시간, 최소 15분)까지 모든 run을 막고 예약을 일시 중지한다. 인증 실패는 재시도하지
  않고 session을 지운 뒤 "다시 연결 필요"로 둔다. 일시 오류는 5분부터 최대 6시간 backoff, 영구 오류는 예약을 멈춘다.
- **가져온 데이터.** ORIGINAL FIT을 `export-activity`와 같은 코드(details+bouts, revision 4)로 import 명령으로 바꿔
  기존 import 경로로 넣는다. 삭제 억제·revision 규칙이 그대로 적용된다. Garmin 활동 ID는 provider 중립 원장
  (`garmin_activity_ledger`)에 남아 다시 내려받지 않으며, 공식 adapter도 같은 원장을 본다. 출처는
  `garmin-connect-unofficial`, `official=false`로 활동 상세에 표시된다.

### 연결 해제·말소·복구에서 Garmin 쪽 세션

비공식 경로에는 철회 endpoint가 없다. 연결 해제와 계정 말소는 **앱에 저장된 session만** 지우고, M1-06c 철회 queue에는
아무것도 넣지 않는다. Garmin 쪽 세션은 계속 유효할 수 있으므로 소유자는 Garmin 비밀번호를 바꾸고 Garmin 계정
설정에서 로그인된 세션·기기를 로그아웃해야 한다. 화면(연결 패널·계정 삭제)도 이를 안내한다.

백업 복구 때는 트래픽 차단 상태에서 다음을 적용한다(`scripts/backup-restore-drill.mts`가 같은 절차를 검증한다).

```sql
UPDATE garmin_unofficial_run SET state='failed_transient',finished_at=greatest(started_at,clock_timestamp()) WHERE state='running';
UPDATE garmin_unofficial_connection SET state=CASE WHEN state='connected' THEN 'reconnect_required' ELSE state END,
  encrypted_session=NULL,session_generation=session_generation+1,lease_id=NULL,lease_until=NULL,run_requested_at=NULL;
```

백업 안의 session은 되살리지 않는다. profile 고정과 활동 원장은 credential이 아니므로 유지한다.

### 고정 해제 (운영자)

잘못된 Garmin 계정으로 처음 연결했다면 먼저 연결을 해제하고, migration owner 권한으로
`UPDATE garmin_unofficial_connection SET profile_hash=NULL WHERE athlete_id='<owner>' AND state='not_connected';`를
실행한다. 앱 화면에는 이 기능이 없다.

### 제거와 공식 연동으로의 교체

공식 adapter(`M1-06b`)가 착지하면 다음 순서로 임시 경로를 은퇴시킨다.

1. 공식 adapter를 같은 수집 interface(`@workout/server-integrations/garmin-collection`의 `GarminActivityCollector`)
   구현으로 붙인다. runner·원장·import 경로는 바꾸지 않는다. 원장이 Garmin 활동 ID로 중복을 막으므로 비공식으로 이미
   가져온 활동은 공식 adapter가 다시 가져오지 않는다(두 경로의 활동 ID가 같은지는 파트너 환경에서 재확인한다).
2. 소유자가 앱에서 "비공식 연결 해제"를 누르거나, 운영자가 `UPDATE garmin_unofficial_connection SET state='not_connected',
encrypted_session=NULL,lease_id=NULL,lease_until=NULL,schedule_enabled=false,connected_at=NULL;`로 저장된 session을 모두 지운다.
3. `GARMIN_UNOFFICIAL_*` 다섯 값을 배포에서 지워 adapter를 끈다(라우트가 사라진다). key는 저장된 session이 없음을 확인한
   뒤 secret manager에서 폐기한다.
4. 소유자에게 Garmin 쪽 세션 정리(비밀번호 변경·세션 로그아웃)를 다시 안내한다.
5. 비공식으로 들어온 활동과 출처 표시는 사용자 데이터로 남긴다(`garmin_activity_ledger`와 출처 조회는 adapter와 무관하게 동작).
6. task graph의 `M1-06b-tmp` scope 끝에 "은퇴(날짜, 대체 노드)"를 기록한다. 코드 제거(bridge·worker·패널)는 별도 작업으로 한다.
