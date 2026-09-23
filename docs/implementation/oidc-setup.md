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
`https://<public-host>/bff/v1/auth/callback`으로 등록한다. issuer는 discovery 문서의 issuer와 일치해야 한다
(URL 정규화 후 일치, 라이브러리의 호스트별 예외 없이 앱이 다시 검사한다).
공급자가 RP-initiated logout(`end_session_endpoint`)을 제공하면 post-logout redirect URI
`https://<public-host>/account`도 등록한다([M2-01w](progress/M2-01w.md)).
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
| `OIDC_VERIFY_REAUTHENTICATION`          | 기본 true. 아래 "재인증 증명" 참고                    |
| `OIDC_PROVIDER_LOGOUT`                  | 기본 true. 아래 "공급자 로그아웃" 참고                |

API는 기동 시 공급자를 기다리지 않는다([M2-01w](progress/M2-01w.md)). discovery는 첫 로그인(또는
기동 직후의 백그라운드 시도)에서 하고, 실패하면 5초 뒤 다음 요청에서 다시 시도한다. 공급자에 닿지
못하는 동안 로그인은 `/account?login_error=unavailable`로 끝나고(설정을 모르면 인가 URL도 토큰 교환도
만들 수 없다 — fail-closed), 이미 발급된 세션과 로그인과 무관한 API는 계속 동작한다(세션 검증은 DB만
본다). 성공한 discovery는 프로세스 수명 동안 유지한다.

**어떤 오류가 기동을 거부하고 어떤 오류가 로그인만 막는가.** 기동을 거부하는 것은 **설정값 자체**의 오류뿐이다
(`OIDC_ISSUER`·`PUBLIC_ORIGIN`이 URL이 아니거나 HTTPS가 아님, callback 경로). **discovery에서야 드러나는
설정 오류** — 공급자 문서의 issuer가 `OIDC_ISSUER`와 다름, 공급자가 광고한 endpoint가 HTTPS가 아님 — 는
이제 기동을 막지 않는다: `/health`는 정상이고 로그인만 계속 `unavailable`로 실패한다(fail-closed). 운영자는
원인을 로그로 본다: discovery 시도마다 한 번(요청마다가 아니라) 고정 이유만 담은
`{"event":"oidc_discovery_failed","reason":"issuer_mismatch|insecure_endpoint|network|other"}`를 남긴다
(API logger가 생기기 전의 기동 직후 시도는 stderr에 같은 JSON 한 줄). `network`에는 연결 실패·timeout·
discovery 문서의 비-200 응답이 들어간다. 공급자 응답·URL·오류 문구는 로그에 쓰지 않는다. 배포 직후
`unavailable`이 계속되면 이 이벤트를 확인한다.

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
원장과 revision·receipt·collection head의 제한된 DML을 허용한다. `grantPlanScenarios`는 시나리오 head의 SELECT/INSERT/UPDATE와 불변 수정·적용 이력의 SELECT/INSERT를 허용한다. `grantCoachingThreads`는 대화·메시지 SELECT/INSERT와 대화 revision/updated_at 열 UPDATE만 허용한다. `grantCoreEvidenceSnapshots`는 근거 snapshot SELECT/INSERT와 필수 사용자 제약·head의 SELECT를 허용한다. 본문 회수는 제한된 lifecycle trigger가 수행한다. `grantCoachingConstraints`는 사용자 제약과 head의 SELECT/INSERT/UPDATE만 허용한다. migration 001–016은 checksum으로 보호한다.

### M1c 루틴·스트레칭·회복 운영 권한

Migration 023–025를 적용한 뒤 migration owner로 아래 권한 함수를 실행한다. `grantOperations`를
다시 실행해야 마지막 migration이 새로 만든 `erase_account(text)` wrapper에 runtime EXECUTE가
부여된다. 앱 runtime URL로 migration이나 GRANT를 실행하지 않는다.

```bash
node --import tsx --input-type=module <<'JS'
import {
  migrate,
  grantOperations,
  grantRoutineCore,
  grantStretchingCore,
  grantRecoveryCore,
} from './packages/server/persistence/src/migrate.ts';
const admin = process.env.DEPLOY_DATABASE_URL;
const role = process.env.RUNTIME_DB_ROLE;
if (!admin || !role) throw new Error('Deployment DB configuration required');
await migrate(admin);
await grantOperations(admin, role);
await grantRoutineCore(admin, role);
await grantStretchingCore(admin, role);
await grantRecoveryCore(admin, role);
JS
```

세 함수는 새 원장 테이블의 SELECT·INSERT, 현재 head/log에 필요한 UPDATE만 부여하며 DELETE는
부여하지 않는다. 새 테이블은 모두 tenant FORCE RLS를 유지하고, 계정 삭제는 권한을 제한한 최신
함수를 통해 처리한다. [루틴](progress/M1c-01.md)·[스트레칭](progress/M1c-02.md)·
[회복](progress/M1c-03.md)에 테이블별 최소 권한과 검증 범위를 기록한다.

## 요청 경계

`GET /bff/v1/session`은 session ID·CSRF token·expiry를 반환하며 캐시하지 않는다.
Cookie 세션의 consent GET/PUT 및 logout POST는 `x-workout-session-id`가 현재 세션과 일치해야 한다.
계획·활동의 보호 경로도 같은 세션 검사를 적용한다. PUT/POST/PATCH/DELETE에는 정확한 Origin과 `x-csrf-token`도 필요하다. 동의 PUT은 expectedRevision과
`idempotency-key`를 사용한다. 과거 성공의 재시도 영수증은 최신 상태가 아니므로 GET으로 확인한다.

만료는 DB에서도 검사한다. 브라우저 cookie 삭제만으로 로그아웃을 처리하지 않는다.
앱 로그아웃은 그 자체로 완결된다(서버측 세션 철회 + 표식). **공급자 로그아웃**: 공급자가
`end_session_endpoint`를 광고하고 `OIDC_PROVIDER_LOGOUT=true`(기본)이면, 세션·Origin·CSRF 검사를
통과한 logout POST만 `200 {"providerLogoutUrl"}`을 돌려주고 화면이 그 URL(`client_id`,
`post_logout_redirect_uri=https://<public-host>/account`, `id_token_hint` 없음 — ID Token을 보관하지
않는다)로 이동한다. 공급자는 보통 확인을 묻고, 사용자가 거절하면 공급자 SSO는 남는다(표식이 여전히 다음
로그인을 다시 묻게 한다). 그 외에는 `204`다. 인증되지 않은 401 logout은 URL을 주지 않는다.
로그아웃은 **이미 성공한 discovery의 메타데이터만** 쓴다 — discovery를 시작하거나 기다리지 않으므로 공급자
장애가 로그아웃 응답을 늦추지 않고, 아직 discovery가 없으면 `204`다(세션 철회·쿠키 처리는 항상 먼저 한다).
광고된 `end_session_endpoint`가 HTTPS가 아니면 공급자 로그아웃만 끄고(로그인은 영향 없음)
`{"event":"oidc_provider_logout_disabled","reason":"insecure_endpoint"}`를 남긴다.
**재인증 증명**: 아래 표식으로 다시 인증을 요청할 때 `prompt=login`과 함께 `max_age=0`을 보내고,
callback에서 ID Token의 `auth_time`이 30초 허용 오차 안이어야 받는다(`OIDC_VERIFY_REAUTHENTICATION=true`,
기본). **30초 허용 오차(openid-client/oauth4webapi 기본값)의 한계 두 가지**: (1) `prompt=login`을 무시하고
SSO의 **실제** `auth_time`을 보내는 비준수 공급자라면, 직전 인증이 30초 이내일 때 조용한 재로그인을 막지
못한다(예: 로그인 직후 곧바로 로그아웃하고 다른 사람이 로그인). (2) 공급자와 API 서버의 시계가 30초 넘게
어긋나면 **모든** 재인증 로그인(로그아웃 뒤·계정 전환)이 실패한다 — 서버 시계 동기화(NTP)가 전제다. 재인증 요청이었는지는 서버에 저장한 로그인 시도의 nonce 표시로 판단한다(migration 없음).
공급자가 `max_age`/`auth_time`을 지원하지 않으면 로그아웃 뒤·계정 전환 로그인이 **실패**한다 — 그 경우에만
끄고, 끄면 공급자가 `prompt=login`을 무시할 때 직전 사용자로 조용히 다시 로그인되는 것을 막지 못한다.
운영 값은 EXT-OIDC의 공급자 확인에서 확정한다. **세션 수명 8시간은 유지한다**: back-channel logout이 없어
공급자에서 비활성화된 계정은 남은 앱 세션(최대 8시간)을 유지한다. back-channel logout은 subject 기준 세션
철회 함수와 재생 방지 저장소가 필요해 migration 대상이다([M2-01w](progress/M2-01w.md)).
**실패 화면**: 로그인 시작·callback이 실패하면 JSON 대신 `/account?login_error=cancelled|failed|unavailable`로
보내고 화면은 자기 문구만 보여 준다. 공급자의 `error_description`·`error_uri`는 어디에도 쓰지 않는다.
실패한 callback은 쿠키를 설정·삭제하지 않는다.
**로그아웃 표식**: 로그아웃은 HttpOnly 표식
`__Host-workout_signed_out`(30일)을 남기고(세션이 이미 없어 401인 로그아웃도 **허용된 origin에서 온 경우** 표식만 남긴다 — 세션 쿠키는 지우지 않는다), 표식이나 현재 세션 쿠키가 있는 브라우저의 다음 로그인은
공급자에 `prompt=login`을 보내 다시 인증하게 한다(계정 전환·공유 브라우저). 표식이 없는 첫 로그인은
공급자 SSO를 그대로 쓴다. 공급자는 `prompt=login`을 지켜야 한다([M2-01u](progress/M2-01u.md)).
실제 배포 전 공급자/TLS 설정과
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
