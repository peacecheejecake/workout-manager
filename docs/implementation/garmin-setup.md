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
```

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
