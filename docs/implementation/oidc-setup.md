# 표준 OIDC 설정

사용자 결정: 특정 로그인 공급자에 종속되지 않는 표준 OIDC. 서버 adapter는
[openid-client](https://github.com/panva/openid-client)를 사용한다.
로컬 fixture로 프로토콜을 검증했으며 외부 공급자의 등록·실제 로그인은 별도 운영 검증이다.

Garmin 연결은 앱 로그인과 분리한다. 기존 OIDC issuer/client와 `/bff/v1/auth/*`는 유지하며,
설정의 provider OAuth와 별도 credential을 사용한다. [Garmin 연결 설계](garmin-oauth.md)와
[서버·DB·worker 설정](garmin-setup.md)을 참고한다. Migration 006 적용 후에는 Garmin 설정 유무와
관계없이 runtime에 `grantGarmin`을 적용한다.

## 공급자와 앱

Confidential client를 등록하고 `client_secret_basic`, authorization code,
PKCE S256, `openid` scope를 사용한다. redirect URI는 정확히
`https://<public-host>/bff/v1/auth/callback`으로 등록한다. issuer는 discovery 문서의 issuer와 일치해야 한다.
로그인·가입·계정 복구 화면은 공급자가 소유한다. 이메일 일치만으로 계정을 합치지 않는다.

API 실행 환경:

| 변수                                    | 값                                                    |
| --------------------------------------- | ----------------------------------------------------- |
| `DATABASE_URL`                          | 아래 제한된 runtime role의 PostgreSQL URL             |
| `PUBLIC_ORIGIN`                         | 경로·query·credentials 없는 브라우저 HTTPS origin     |
| `OIDC_ISSUER`                           | 공급자 HTTPS issuer                                   |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | 공급자가 발급한 confidential client 값                |
| `NODE_ENV`                              | `production` (기본값)                                 |
| `PORT`                                  | API loopback 포트, 기본 4300                          |
| `ALLOW_INSECURE_LOCALHOST`              | 기본 false; development/test loopback 시험에서만 true |

비밀 값은 secret manager/실행 환경으로 전달하고 저장소·브라우저·로그에 넣지 않는다.
`pnpm dev:api`는 위 설정으로 Fastify를 실행한다. API는 127.0.0.1에 bind한다.
Next의 `API_ORIGIN`은 내부 API origin이며 기본 `http://127.0.0.1:4300`이다.
Next rewrites는 build 시 구성되므로 실제 배포 값을 지정한 뒤 `pnpm build`한다.
브라우저는 같은 origin의 `/bff/v1`만 사용하고 TLS ingress가 HTTPS를 종료한다.

## DB 준비

새 전용 DB와 별도의 migration owner / `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`
runtime role을 운영 배포 도구로 생성한다. 앱에는 migration owner URL을 제공하지 않는다.
아래는 저장소 root에서 배포 단계에 실행하는 예이며 환경 변수는 미리 안전하게 주입한다.

```bash
node --import tsx --input-type=module <<'JS'
import { migrate, grantIdentityFunctions, grantOperations, grantGarmin, grantCheckIns, grantSessionCompletions, grantPlanScenarios, grantCoachingThreads, grantCoreEvidenceSnapshots, grantCoachingConstraints } from './packages/server/persistence/src/migrate.ts';
const admin = process.env.DEPLOY_DATABASE_URL;
const role = process.env.RUNTIME_DB_ROLE;
if (!admin || !role) throw new Error('Deployment DB configuration required');
await migrate(admin);
await grantIdentityFunctions(admin, role);
await grantOperations(admin, role);
await grantGarmin(admin, role);
await grantCheckIns(admin, role);
await grantSessionCompletions(admin, role);
await grantPlanScenarios(admin, role);
await grantCoachingThreads(admin, role);
await grantCoreEvidenceSnapshots(admin, role);
await grantCoachingConstraints(admin, role);
JS
```

동일 owner로 아래 grants를 적용한다. role 이름은 실제 선택한 이름으로 교체한다.

```sql
GRANT USAGE ON SCHEMA public TO workout_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON consent, outbox, command_receipt TO workout_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON plan_head TO workout_runtime;
GRANT SELECT, INSERT ON plan_snapshot, plan_history TO workout_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON activity_canonical, activity_source_head,
  activity_overlay TO workout_runtime;
GRANT SELECT, INSERT ON activity_source_revision, activity_overlay_revision,
  activity_suppression, activity_import_receipt TO workout_runtime;
```

`identity_private` 테이블/스키마에 runtime 직접 권한을 주지 않는다. `grantIdentityFunctions`는
검증된 role 이름에 인증용 함수 5개의 EXECUTE만 허용한다. `grantOperations`는 삭제 차단 원장 조회,
민감 내용 없는 작업 이력 조회·추가와 계정 삭제 함수 실행을 허용한다. `grantGarmin`은 현재 tenant의
연결·시도 및 제한된 연결 관리 함수 권한을 추가한다. `grantCheckIns`는 자기보고 원장·정정·
명령 receipt의 제한된 DML을 허용한다. `grantSessionCompletions`는 사용자 세션 완료 확인·철회
원장과 revision·receipt·collection head의 제한된 DML을 허용한다. `grantPlanScenarios`는 시나리오 head의 SELECT/INSERT/UPDATE와 불변 수정·적용 이력의 SELECT/INSERT를 허용한다. `grantCoachingThreads`는 대화·메시지 SELECT/INSERT와 대화 revision/updated_at 열 UPDATE만 허용한다. `grantCoreEvidenceSnapshots`는 근거 snapshot SELECT/INSERT와 필수 사용자 제약·head의 SELECT를 허용한다. 본문 회수는 제한된 lifecycle trigger가 수행한다. `grantCoachingConstraints`는 사용자 제약과 head의 SELECT/INSERT/UPDATE만 허용한다. migration 001–015는 checksum으로 보호한다.

## 요청 경계

`GET /bff/v1/session`은 session ID·CSRF token·expiry를 반환하며 캐시하지 않는다.
Cookie 세션의 consent GET/PUT 및 logout POST는 `x-workout-session-id`가 현재 세션과 일치해야 한다.
계획·활동의 보호 경로도 같은 세션 검사를 적용한다. PUT/POST/PATCH/DELETE에는 정확한 Origin과 `x-csrf-token`도 필요하다. 동의 PUT은 expectedRevision과
`idempotency-key`를 사용한다. 과거 성공의 재시도 영수증은 최신 상태가 아니므로 GET으로 확인한다.

만료는 DB에서도 검사한다. 브라우저 cookie 삭제만으로 로그아웃을 처리하지 않는다.
이 앱 로그아웃은 공급자 SSO logout을 의미하지 않는다. 실제 배포 전 공급자/TLS 설정과
로그인·만료·세션 교체·철회 경로를 배포 환경에서 검증해야 한다.

## 로컬 E2E API 포트 충돌

기본 API 포트 4300을 다른 프로세스가 사용하면 해당 프로세스를 종료하거나 재사용하지 않는다.
검증용 포트를 명시하고 Next의 build-time rewrite도 같은 origin으로 준비한다.

```bash
API_ORIGIN=http://127.0.0.1:4301 pnpm --filter @workout/web build
WORKOUT_IDENTITY_API_PORT=4301 API_ORIGIN=http://127.0.0.1:4301 pnpm test:identity
```

`WORKOUT_IDENTITY_API_PORT`는 1024–65535 범위의 테스트 API listen/readiness 포트만 바꾼다.
앱 3100, OIDC fixture 4400, Garmin fixture 4500은 그대로다. 임시 DB는 항상 별도로 생성한다.
기본 포트로 돌아갈 때는 기본 `API_ORIGIN`으로 Next를 다시 build한다.
