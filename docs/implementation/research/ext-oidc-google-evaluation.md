# EXT-OIDC 운영 IdP 후보 평가 — Google

사용자 결정(2026-09-25): "Google을 평가한다".

확인일: 2026-09-25. 범위: [EXT-OIDC](../task-graph.json)(M2-01u에서 분리, M2-01w가 넘긴 확인 항목 포함).
상태: **공식 문서·공개 discovery 조사와 인증 없는 authorize 요청 관찰만 수행. 계정 생성·Cloud Console
등록·실제 로그인은 하지 않았다.** 이 문서는 EXT-OIDC 통과 증거가 아니다. EXT-OIDC는 실제 운영 공급자와
실제 브라우저 체크리스트가 있어야 닫히며, M2-01k `K-oidc` 행은 계속 `not_executed`다.

기준은 [표준 OIDC 설정](../oidc-setup.md), [M2-01u](../progress/M2-01u.md), [M2-01w](../progress/M2-01w.md)와
RP 코드 [`packages/server/identity/src/oidc.ts`](../../../packages/server/identity/src/oidc.ts)다.

## 결론 요약

**Google은 이 앱의 현재 재인증·로그아웃 계약을 만족하지 못한다. 설정만 바꿔서는 채택할 수 없다.**

- Google 문서는 "Google does not support Google Account reauth requests"라고 명시한다
  ([Security bundle](https://developers.google.com/identity/siwg/security-bundle)). `prompt=login`은
  거절되지는 않지만(아래 관찰) 문서화된 값이 아니며 재인증을 강제한다는 근거가 없다.
- `auth_time`은 기본적으로 ID Token에 없다. `claims` 요청 파라미터 + 앱 게시·검증 + 콘솔 설정을 모두
  갖춰야 나오며, 나오더라도 "요청 시점의 재인증"이 아니라 그 브라우저의 **마지막 Google 로그인 시각**이다.
  그래서 기본값(`OIDC_VERIFY_REAUTHENTICATION=true`)에서는 **로그아웃 뒤·계정 전환 로그인이 모두 `failed`로
  끝난다**.
- `end_session_endpoint`가 없어 RP-initiated logout이 불가하고, back-channel logout도 없다(대신 비표준
  Cross-Account Protection(RISC)이 있다).
- 서명 키 공개·PKCE S256·`client_secret_basic`·HTTPS redirect 등록은 문제없다.

권고: **재인증 계약을 유지하려면 Google이 아닌 공급자**(아래 대안 비교: Zitadel 또는 Keycloak 우선,
관리형이 필요하면 Auth0)를 쓴다. Google 로그인이 사용자 요구라면 **Google을 upstream으로 연합하는
브로커 OP**를 두거나, 재인증 보장을 약화하는 설계 변경(사용자 결정 필요)을 한다.

## 앱이 OP에 요구하는 것(코드 기준)

| 요구                                                                                | 근거 코드                                                                                                     |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| discovery 문서의 `issuer`가 `OIDC_ISSUER`와 URL 정규화 후 정확히 일치               | `oidc.ts` `discover()` — 라이브러리 비교 후 앱이 `new URL(...).href`로 재검사                                 |
| authorization/token/jwks endpoint HTTPS                                             | `oidc.ts` `checkUrl` 루프                                                                                     |
| confidential client, `client_secret_basic`                                          | `oidc.ts` `client.ClientSecretBasic`                                                                          |
| code flow, `scope=openid`, `nonce`, PKCE S256                                       | `oidc.ts` `authorizationUrl`                                                                                  |
| ID Token 서명 검증(JWKS 사전 공개)                                                  | `enableNonRepudiationChecks`                                                                                  |
| ID Token `iss`가 discovery `issuer`와 문자열로 동일                                 | oauth4webapi `validateIssuer` + `oidc.ts` `claims.iss !== metadata.issuer`                                    |
| 재인증 요청 시 `prompt=login`을 지킨다                                              | `oidc.ts` `reauthenticate ? { prompt: 'login', ... }`, `service.ts` 표식·세션 쿠키 판단                       |
| `max_age=0`이면 새 `auth_time`을 ID Token에 넣는다(30 s 허용 오차)                  | `oidc.ts` `max_age: '0'`, `authorizationCodeGrant(..., { maxAge: 0 })` → oauth4webapi가 `auth_time` 필수 요구 |
| (선택) `end_session_endpoint` + `client_id` + `post_logout_redirect_uri`, 힌트 없음 | `oidc.ts` `logoutUrl()` — 없으면 `204`로 앱 로그아웃만                                                        |
| (미구현) back-channel logout                                                        | M2-01w: migration 필요, 그때까지 상한 8 h                                                                     |

## 항목별 판정

판정은 **이 앱의 현재 코드·기본 설정 그대로** 기준이다. WORKAROUND는 앱·설정·운영 절차 변경이 필요함을 뜻한다.

| #   | 요구                                                          | 판정                        | Google에서 확인한 사실                                                                                                                                                                                                                                                                                                                                                                                                                                      | 출처                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | discovery·issuer                                              | PASS                        | `issuer`=`https://accounts.google.com`. authorization/token/jwks endpoint 모두 HTTPS. `authorization_response_iss_parameter_supported: true`(callback의 `iss` 검사도 통과 대상)                                                                                                                                                                                                                                                                             | [discovery](https://accounts.google.com/.well-known/openid-configuration)                                                                                                                                                                                                         |
| 2   | 서명 키 사전 공개                                             | PASS                        | `jwks_uri`=`https://www.googleapis.com/oauth2/v3/certs`, RS256, `kid` 여러 개 동시 게시. 문서는 HTTP cache 지시에 따라 캐시하라고 한다. 회전 주기는 공지되지 않는다                                                                                                                                                                                                                                                                                         | [JWKS](https://www.googleapis.com/oauth2/v3/certs), [OIDC 문서](https://developers.google.com/identity/openid-connect/openid-connect)                                                                                                                                             |
| 3   | code flow·`openid`·PKCE S256·`client_secret_basic`            | PASS                        | `response_types_supported`에 `code`, `scopes_supported`에 `openid`, `code_challenge_methods_supported`=`plain,S256`, `token_endpoint_auth_methods_supported`=`client_secret_post,client_secret_basic`                                                                                                                                                                                                                                                       | [discovery](https://accounts.google.com/.well-known/openid-configuration)                                                                                                                                                                                                         |
| 4   | ID Token `iss` 동일성                                         | PASS(실측 필요)             | 문서: `iss`는 "Always `https://accounts.google.com` or `accounts.google.com`". 앞의 값이면 통과, 뒤의 값이면 oauth4webapi가 거절한다(fail-closed, 로그인 `failed`). code flow에서 어느 값인지는 실제 로그인으로 확인해야 한다                                                                                                                                                                                                                               | [OIDC 문서 — ID token](https://developers.google.com/identity/openid-connect/openid-connect#an-id-tokens-payload)                                                                                                                                                                 |
| 5   | `prompt=login` 준수                                           | **FAIL**                    | 공식 `prompt` 값은 `none`·`consent`·`select_account` 셋뿐이다. 인증 없는 authorize 요청 관찰(아래): `prompt=login`은 **거절되지 않고 수용**되며 `prompt=bogus`만 `invalid_request: Invalid prompt: bogus`로 거절된다. 수용된 `login`이 재인증을 강제하는지는 문서에 없고, Security bundle 문서는 "Google does not support Google Account reauth requests"라고 쓴다. 판단: **수용되나 재인증은 보장되지 않는다**(신뢰도: 수용 여부 높음, 재인증 미보장 중상) | [OIDC 문서 — prompt](https://developers.google.com/identity/openid-connect/openid-connect#prompt), [Security bundle](https://developers.google.com/identity/siwg/security-bundle), [Google Workspace DevRel 글](https://dev.to/googleworkspace/google-oidc-and-prompt-login-4d5o) |
| 6   | `max_age=0` → 새 `auth_time`                                  | **FAIL**                    | `max_age`는 Google 문서의 authentication URI 파라미터 표에 없다. 관찰상 `max_age=0`은 거절되지 않고 불투명 파라미터(`opparams`)로 전달될 뿐이다. `auth_time`은 discovery `claims_supported`에 없고, `claims={"id_token":{"auth_time":{"essential":true}}}`를 보내고 **앱이 In production·Verified이며 Google Auth Platform Settings에서 "Session age claims"를 켠 경우에만** 들어간다. 값은 그 브라우저의 마지막 Google 로그인 시각이다                     | [OIDC 문서 — claims](https://developers.google.com/identity/openid-connect/openid-connect#authenticationuriparameters), [Security bundle — Setup·Authentication time](https://developers.google.com/identity/siwg/security-bundle#setup)                                          |
| 7   | RP-initiated logout(`end_session_endpoint`)                   | FAIL(앱은 안전하게 degrade) | discovery에 `end_session_endpoint`가 없다. 앱은 이 경우 `logoutUrl()`이 `null` → `204`로 앱 로그아웃만 한다. EXT-OIDC 체크리스트의 "앱 로그아웃 → OP 로그아웃 확인 → 다른 계정 로그인"은 수행 불가                                                                                                                                                                                                                                                          | [discovery](https://accounts.google.com/.well-known/openid-configuration)                                                                                                                                                                                                         |
| 8   | `id_token_hint` 없는 로그아웃 확인 화면                       | 해당 없음(FAIL과 동일)      | end-session endpoint 자체가 없다                                                                                                                                                                                                                                                                                                                                                                                                                            | 같음                                                                                                                                                                                                                                                                              |
| 9   | back-channel logout                                           | FAIL / WORKAROUND(비표준)   | `backchannel_logout_supported` 없음. 대신 Cross-Account Protection(RISC)이 `sessions-revoked`·`account-disabled`·`tokens-revoked` 등 서명된 security event token을 HTTPS endpoint로 보낸다. OpenID Back-Channel Logout과 다른 규격이고, 서비스 계정·RISC API·수신 endpoint 등록, 사용자의 `profile`/`email` scope 동의가 필요하다(앱은 `openid`만 요청). 앱 쪽은 back-channel과 같은 subject 기준 철회·재생 방지가 필요하다(migration)                      | [RISC](https://developers.google.com/identity/protocols/risc)                                                                                                                                                                                                                     |
| 10  | 시험 계정 둘(하나 MFA)                                        | PASS(사용자 작업)           | 일반 Gmail 계정 둘로 가능하고 한쪽에 2단계 인증을 켠다. `amr`로 MFA 여부를 받으려면 역시 게시·검증·"Authentication strength claims" 설정이 필요하다(앱은 `amr`을 쓰지 않는다). Workspace는 필요 없다                                                                                                                                                                                                                                                        | [Security bundle — amr](https://developers.google.com/identity/siwg/security-bundle)                                                                                                                                                                                              |
| 11  | consent screen 게시 상태                                      | PASS(제약 있음)             | Testing은 test user 100명·동의 7일 만료지만, `openid`/`email`/`profile`만 쓰는 앱은 test user 목록·7일 만료 대상이 아니라고 안내한다. 비민감 scope만 쓰면 앱 검증은 필수가 아니나, 이름·로고 표시에는 brand verification, `auth_time`(#6)에는 **Verified**가 필요하다. User type Internal은 Google Cloud Organization(Workspace) 소속 사용자 한정이므로 일반 사용자 서비스는 External                                                                       | [Audience](https://support.google.com/cloud/answer/15549945), [App verification](https://support.google.com/cloud/answer/13463073)                                                                                                                                                |
| 12  | redirect `https://<host>/bff/v1/auth/callback` 정확 일치 등록 | PASS                        | HTTPS 필수(localhost·loopback IP만 예외), raw IP 금지, TLD는 public suffix list, userinfo·fragment·path traversal·wildcard 금지, 요청 값은 Clients 페이지에 등록한 값과 정확히 일치. Web application client의 Authorized redirect URIs에 등록한다                                                                                                                                                                                                           | [Web server flow — redirect URI validation](https://developers.google.com/identity/protocols/oauth2/web-server#uri-validation), [OIDC 문서](https://developers.google.com/identity/openid-connect/openid-connect#setredirecturi)                                                  |
| 13  | OpenID 인증                                                   | 참고                        | OpenID Foundation 목록에 "Google Federated Identity" Basic/Implicit/Hybrid/Config OP가 2015-04에 인증돼 있다. 11년 전 인증이며 logout 프로필 인증은 없다. 인증이 `prompt=login` 현행 동작을 보증하지 않는다                                                                                                                                                                                                                                                 | [Certified OpenID Providers](https://openid.net/certification/certified-openid-providers-profiles/)                                                                                                                                                                               |
| 14  | `sub` 안정성                                                  | PASS                        | "unique among all Google Accounts and never reused". `subject_types_supported`=`public`                                                                                                                                                                                                                                                                                                                                                                     | [OIDC 문서](https://developers.google.com/identity/openid-connect/openid-connect)                                                                                                                                                                                                 |

### `prompt` 관찰 방법과 한계

2026-09-25, 인증·쿠키 없이 `curl`로 `https://accounts.google.com/o/oauth2/v2/auth`에 Google OAuth Playground의
공개 client(`407408718192.apps.googleusercontent.com`, redirect `https://developers.google.com/oauthplayground`)로
`response_type=code&scope=openid&nonce&state&code_challenge(S256)`를 보내고 `prompt`만 바꿨다. 아무것도 등록하거나
로그인하지 않았다.

| 요청                     | 응답                                                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `prompt=consent`         | 302 → `/v3/signin/identifier?...&prompt=consent`                                                                                   |
| `prompt=login`           | 302 → `/v3/signin/identifier?...&prompt=login` (거절 없음)                                                                         |
| `prompt=login&max_age=0` | 302 → 같은 로그인 화면, `opparams=%3Fmax_age%3D0`                                                                                  |
| `prompt=bogus` (대조군)  | 302 → `/signin/oauth/error`, 디코드한 `authError`: `invalid_request` / "Invalid parameter value for prompt: Invalid prompt: bogus" |

**한계**: Google 세션이 없는 요청이라 어떤 값이든 로그인 화면으로 간다. 따라서 이 관찰은 "`login`이 수용된다"만
보여 주고, **기존 Google 세션이 있을 때 비밀번호를 다시 묻는지는 보여 주지 않는다.** 이는 실제 계정·실제 브라우저
시험으로만 확정된다(아래 체크리스트 G-3). 문서상 근거("reauth requests" 미지원, `prompt` 값 표에 `login` 없음)로
미보장으로 판정했다.

## Google 그대로 쓸 때 앱에서 일어나는 일

1. **첫 로그인**(표식·세션 쿠키 없음): `prompt`·`max_age` 없이 요청 → Google SSO → 정상.
2. **로그아웃 뒤·계정 전환**(`service.ts`가 `reauthenticate=true`로 판단): `prompt=login&max_age=0` 요청.
   - `OIDC_VERIFY_REAUTHENTICATION=true`(기본): 앱이 `claims` 파라미터를 보내지 않으므로 ID Token에
     `auth_time`이 없다 → oauth4webapi가 필수 claim 누락으로 거절 → `/account?login_error=failed`.
     **로그아웃한 모든 사용자가 다시 로그인하지 못한다.**
   - `false`로 끄면: 로그인은 되지만 Google이 조용히 SSO로 답하면 **직전 Google 계정으로 재로그인**된다.
     M2-01u가 고친 공유 브라우저 문제(로그아웃 뒤 다른 사람이 로그인 누름 → 이전 사용자로 들어감)가 되살아난다.
3. **앱 로그아웃**: `end_session_endpoint`가 없어 항상 `204`. Google 세션은 남는다.
4. **Google 쪽 계정 정지**: 앱 세션은 최대 8 h 유지(현재 설계 상한 그대로).

## 우회책(Google을 고집할 경우)

### W1. `max_age` + `auth_time`만으로 재인증을 강제할 수 있는가 — **불가**

`auth_time`은 Google이 **재인증을 해 준 시각**이 아니라 **사용자가 그 브라우저에서 마지막으로 Google에 로그인한 시각**이다.
Google은 재인증 요청을 지원하지 않으므로 `max_age=0`을 보내도 새 인증이 일어나지 않는다. 필요한 변경을 모두 해도:

- `oidc.ts` `authorizationUrl`에 `claims={"id_token":{"auth_time":{"essential":true}}}` 추가,
- Google Auth Platform에서 In production + Verified + Settings → Advanced Settings → "Session age claims",

결과는 "직전 30 s 안에 Google에 직접 로그인한 경우만 통과"다. 로그아웃한 사용자는 Google 계정에서 직접
로그아웃·재로그인한 뒤 30 s 안에 앱 로그인을 눌러야 한다. 앱이 Google 로그아웃을 시킬 수단(#7)이 없으므로
**현재 검사(`maxAge: 0`, 30 s 허용 오차)를 만족시킬 실용적 경로가 없다.** 허용 오차를 몇 분으로 늘리면 통과는
쉬워지지만, 그 창 안의 조용한 SSO 재로그인을 막지 못해 보장이 약해진다(M2-01w가 기록한 한계 (1)이 커진다).

### W2. 재인증을 "계정 선택"으로 약화 — 설계 변경, 사용자 결정 필요

재인증 요청에서 `prompt=login` 대신 `prompt=select_account`(문서화된 값)를 보내고 `max_age`/`maxAge` 검사를 끈다.
Google 계정 선택 화면이 매번 나오므로 **계정 전환**은 된다. 그러나 공유 브라우저에서 이전 사용자의 Google 세션이
남아 있으면 선택만으로 비밀번호 없이 그 계정으로 들어간다 — M2-01u 보장("다시 인증")이 "다시 선택"으로 낮아진다.
화면에 "공용 기기에서는 Google 계정에서도 로그아웃하세요" 안내가 필요하다.

바꿔야 할 곳:

- `packages/server/identity/src/oidc.ts` — `authorizationUrl`의 `prompt: 'login'`과 `max_age: '0'`(재인증 분기),
  `exchange`의 `maxAge: 0` 분기, `configSchema`(재인증 prompt 값 설정 추가, 예: `reauthenticationPrompt: 'login' | 'select_account'`).
- `apps/api/src/configured.ts` — `OIDC_VERIFY_REAUTHENTICATION`(Google이면 `false`), 새 env 전달.
- `packages/server/identity/src/service.ts` — 재인증 판단(`hasCookie(...sessionName) || hasCookie(...signedOutName)`)은
  그대로 쓸 수 있다. 의미(보장 수준)만 문서에서 바뀐다.
- 시험: `packages/server/identity/tests/oidc.test.ts`(`prompt`가 `['login']`, `max_age`가 `['0']`인 단언),
  `apps/api/tests/identity.test.ts`(`&prompt=login` 단언), `scripts/oidc-certified-check.mts`(비준수 OP 거절·재프롬프트 확인).
- 문서: `docs/implementation/oidc-setup.md` "재인증 증명"·"로그아웃 표식" 절.

### W3. Google을 upstream으로 두는 브로커 OP

앱은 브로커(Keycloak·Zitadel·Auth0·Cognito 등)에만 붙고, 브로커가 Google을 외부 IdP로 연합한다. 앱 코드 변경은 없다.
브로커가 `prompt=login`·`auth_time`·`end_session_endpoint`·back-channel(공급자별)을 제공하므로 **앱이 보는 OP 계약은
만족**된다. 단, 브로커의 유일한 인증 수단이 Google이면 브로커가 재인증을 위해 Google로 보냈을 때 Google이 다시 SSO로
답할 수 있어 "비밀번호 재입력"은 여전히 Google 세션에 달려 있다. 브로커 로그인 화면에서 계정 선택·"다른 계정"
경로가 생기고 앱의 로그아웃이 브로커 세션을 끝내는 것은 개선이다. 브로커 운영 비용이 추가된다.

### W4. back-channel 대체 — RISC

필요하면 RISC 수신 endpoint로 `sessions-revoked`·`account-disabled` 시 subject 기준 앱 세션 철회. back-channel logout과
같은 저장소·migration(subject 기준 철회 함수, 재생 방지 `jti` 저장)이 필요하고, `email` 또는 `profile` scope 추가와
RISC 약관 동의가 필요하다. 이번 노드 범위 밖이며 8 h 상한 결정(M2-01w)을 바꾸지 않는다.

## 대안 비교

공개 discovery·공식 문서 기준(2026-09-25). 요금 수치는 이번에 확인하지 않았다 — 채택 전 각 공식 요금표로 확정한다.
모든 후보는 여전히 실제 운영 등록·브라우저 체크리스트가 필요하다.

| 후보                         | `prompt=login`                                     | `max_age`/`auth_time`                                                  | `end_session_endpoint`(힌트 없이 `client_id`+`post_logout_redirect_uri`)               | back-channel logout                                                      | issuer·앱 호환 메모                                                                                                                                            | 비용·노력                                                                                      |
| ---------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Zitadel**(Cloud 또는 자체) | 지원("user must reauthenticate")                   | `max_age` 문서화, `auth_time` claims_supported                         | 광고됨, `client_id`로 redirect 검증                                                    | discovery 기본 광고, 앱별 URI 등록                                       | 인스턴스별 고정 issuer. OpenID 인증은 1.53.1(2021)                                                                                                             | Cloud 무료 등급으로 시작 가능(한도 확인 필요), 자체 호스팅 시 PostgreSQL 사용                  |
| **Keycloak**(자체)           | 지원(OIDC 명세대로 재인증)                         | `max_age` 지원(기본 5분보다 짧게만), `auth_time` 포함                  | 광고됨, 힌트 없으면 확인 화면, `client_id` 필요, Valid Post Logout Redirect URIs       | 지원(client의 Backchannel logout URL)                                    | realm별 고정 issuer. Keycloak 18 전 프로필 인증(2022)                                                                                                          | 라이선스 무료, 운영(HA·DB·업그레이드·백업·TLS) 부담이 가장 큼. 이미 자체 운영 스택과 성향 일치 |
| **Auth0**                    | 지원                                               | `auth_time` claims_supported                                           | 지원하나 tenant 설정으로 discovery 광고를 켜야 함(samples tenant는 미광고) · 확인 필요 | discovery `backchannel_logout_supported: true`, **Enterprise 플랜 한정** | tenant issuer는 끝 `/` 포함(`https://<tenant>/`) — 앱 비교는 정규화 후라 문제 없음                                                                             | 관리형, 설정 노력 적음. back-channel까지 원하면 Enterprise 비용                                |
| **Amazon Cognito**           | 지원(**managed login만**, classic 불가)            | `max_age` 문서 없음. `prompt=login`이면 새 `auth_time` 기대(실측 필요) | `/logout`은 비표준이며 discovery에 `end_session_endpoint`로 광고되지 않음 → 앱은 `204` | 없음                                                                     | user pool별 고정 issuer                                                                                                                                        | 관리형·저렴한 편, AWS 계정 필요. RP-initiated logout 체크리스트 항목 불가                      |
| **Microsoft Entra ID**       | 지원("forces the user to enter their credentials") | `auth_time` claims_supported. `max_age` 문서화 여부 확인 필요          | 광고됨(front-channel 지원)                                                             | discovery 미광고(front-channel만)                                        | `common`/`consumers` authority의 issuer는 `{tenantid}` 템플릿이라 **앱의 엄격한 issuer 검사와 맞지 않음** — 단일 tenant(또는 External ID tenant) issuer만 가능 | 일반 소비자 대상이면 Entra External ID. 설정·정책 복잡도 중간                                  |
| Google(참고)                 | 미보장(FAIL)                                       | 기본 없음, 조건부·재인증 아님(FAIL)                                    | 없음                                                                                   | 없음(RISC 비표준)                                                        | 고정 issuer, `iss` 두 형태                                                                                                                                     | 무료, 등록 쉬움                                                                                |

출처: [Zitadel endpoints](https://zitadel.com/docs/apis/openidoauth/endpoints),
[Zitadel back-channel](https://zitadel.com/docs/guides/integrate/back-channel-logout),
[Zitadel discovery](https://zitadel.cloud/.well-known/openid-configuration),
[Keycloak Server Admin](https://www.keycloak.org/docs/latest/server_admin/index.html),
[Auth0 back-channel](https://auth0.com/docs/authenticate/login/logout/back-channel-logout/configure-back-channel-logout),
[Auth0 samples discovery](https://samples.auth0.com/.well-known/openid-configuration),
[Cognito authorize endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html),
[Entra OIDC](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc),
[Entra discovery](https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration),
[OpenID 인증 목록](https://openid.net/certification/certified-openid-providers-profiles/).

## 권고

1. **Google 단독 채택은 권하지 않는다.** 앱 코드를 바꾸지 않으면 로그아웃 뒤 로그인이 전부 실패하고(기본값),
   검사를 끄면 M2-01u의 공유 브라우저 보호가 사라진다.
2. **현재 계약을 코드 변경 없이 만족하는 후보**: Zitadel, Keycloak(두 가지 모두 back-channel까지 지원), Auth0(back-channel은
   Enterprise). 운영 부담을 줄이려면 Zitadel Cloud, 자체 운영 원칙을 우선하면 Keycloak 또는 자체 Zitadel.
3. **Google 로그인이 제품 요구라면** W3(브로커 + Google 연합)이 앱 계약을 유지하는 방법이다. W2는 보장 약화이므로
   별도 사용자 결정과 코드·시험·문서 변경 노드가 필요하다.
4. 어느 경우든 EXT-OIDC는 아래 실제 브라우저 체크리스트 전에는 닫지 않는다.

## 사용자 체크리스트

### 공통(어느 공급자든)

- [ ] 공개 HTTPS 도메인·TLS ingress 준비(`PUBLIC_ORIGIN`).
- [ ] confidential web client 등록: redirect `https://<host>/bff/v1/auth/callback` 정확히, `client_secret_basic`,
      code + PKCE S256, scope `openid`. RP-initiated logout이 있으면 post-logout `https://<host>/account` 등록.
- [ ] `OIDC_ISSUER`·`OIDC_CLIENT_ID`·`OIDC_CLIENT_SECRET`을 secret manager에 넣고 실행 환경으로만 주입(저장소·채팅·로그 금지).
- [ ] 서로 다른 사람의 시험 계정 2개, 그중 하나 MFA.
- [ ] 서버 NTP 동기화(30 s 허용 오차 전제).
- [ ] 실제 브라우저 확인: 로그인 · 로그아웃 뒤 다른 계정 로그인 시 **OP가 다시 묻는지** · 로그인 중 계정 전환 · 취소 화면 ·
      앱 로그아웃 → OP 로그아웃 확인 → 다른 계정 로그인 · OP 장애 중 기존 세션 유지와 로그인 `unavailable` · 8 h 만료 ·
      같은 계정 재로그인 시 같은 athlete. 결과는 M2-01k `K-oidc`와 EXT-OIDC 진행 문서에 운영 증거로 기록.

### Google을 그래도 시험할 경우 추가

- [ ] G-1 Google Cloud 프로젝트 생성 → Google Auth Platform: Branding(앱 이름·지원 이메일·홈페이지·개인정보처리방침),
      Audience는 External.
- [ ] G-2 Clients → Web application 생성, Authorized redirect URIs에 위 callback 등록, client secret을 secret manager로.
- [ ] G-3 **결정적 시험**: 계정 A로 Google·앱 로그인 → 앱 로그아웃 → 앱 로그인. 현재 기본값이면 `failed`가 예상되고,
      `OIDC_VERIFY_REAUTHENTICATION=false`면 Google이 비밀번호를 다시 묻는지 본다(묻지 않으면 FAIL 확정).
- [ ] G-4 첫 로그인 ID Token `iss`가 `https://accounts.google.com`인지(아니면 로그인 `failed`).
- [ ] G-5 `auth_time`이 필요하면 In production 게시 + 검증(도메인 소유 확인 포함) + Settings의 "Session age claims" — 앱에
      `claims` 파라미터 코드 변경이 선행돼야 의미가 있다.
- [ ] G-6 계정 정지 반영이 필요하면 RISC(서비스 계정·RISC API·수신 endpoint) — 별도 설계·migration 노드.

## 증명하지 못함

실제 Google 세션이 있는 상태의 `prompt=login` 동작, code flow ID Token의 실제 `iss` 형태, 게시·검증 후 `auth_time` 값,
대안 공급자의 실제 동작(모두 문서·discovery 기준), 요금. 이 문서의 어떤 항목도 EXT-OIDC·`K-oidc`를 통과로 바꾸지 않는다.
