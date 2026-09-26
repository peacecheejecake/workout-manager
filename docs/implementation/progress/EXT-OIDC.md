# EXT-OIDC · 운영 OIDC identity provider 확보

상태: **Phase 1(기계 확인 + 로컬 실행 스택 + 사람 체크리스트)과 Phase 2(사용자의 실제 브라우저 수행 + 서버측
확인 + 판정 제안 + 검증 묶음) 완료.** 기준 HEAD `52ccb09`(Phase 1), Phase 2는 `d6918aa` 위. 제품 코드 변경 없음.
`task-graph.json`·`AGENTS.md`·`CLAUDE.md`·`.geo-build`·M2-01k 매트릭스는 건드리지 않았다.
**`K-oidc` 제안 판정은 `partial`이다**(아래 "K-oidc 판정 제안") — 실제 IdP로 사람이 로그인한 증거는 생겼으나
매트릭스 header 규칙의 "이 노드에서 실행한 시험이 핵심을 단언하고, 기능 없이는 실패함"을 사람 수행으로는 보일 수
없고, 운영 배포 조건은 EXT-HOSTING으로 넘어갔다. `passed`로 올리지 않는다.

## 사용자 결정(2026-09-26)

1. 공급자: **Zitadel Cloud**. 인스턴스와 앱 등록은 사용자가 했다. issuer
   `https://personal-workout-lgn7dx.eu1.zitadel.cloud`(client id·secret은 문서·로그·저장소에 쓰지 않는다).
2. 아직 호스팅이 없으므로 `PUBLIC_ORIGIN=http://localhost:3100`, `ALLOW_INSECURE_LOCALHOST=true`, Zitadel
   **Development Mode**(HTTP redirect 허용). 등록한 redirect URI `http://localhost:3100/bff/v1/auth/callback`,
   post-logout URI `http://localhost:3100/account`.
3. 시험 사용자 둘, 그중 하나는 MFA.
4. 비밀 값은 저장소 root의 git-ignored `.env`(`PUBLIC_ORIGIN`, `ALLOW_INSECURE_LOCALHOST`, `OIDC_ISSUER`,
   `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`)에만 있고, 실행 시 프로세스 환경으로만 넣는다.
5. **EXT-OIDC / EXT-HOSTING 분리.** EXT-OIDC는 localhost + 실제 Zitadel 증거로 완료하고, HTTPS 도메인·TLS
   ingress·secret manager·배포 환경 검증은 root가 새로 만드는 노드 **EXT-HOSTING**으로 옮긴다(task-graph 반영은
   root 몫). 아래 "범위 구분" 표가 그 경계다.

## 범위 구분 — localhost에서 하는 것 / EXT-HOSTING으로 넘어가는 것

| EXT-OIDC 범위 항목(task-graph)                                         | 처리                                                                                                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 운영 IdP 선택 — `prompt=login` 준수, 서명 키 사전 공개                 | **localhost**: Zitadel Cloud. discovery·JWKS는 Phase 1에서 확인, `prompt=login`·`auth_time`은 체크리스트 3·5·6에서 사람이 확인 |
| confidential client, `client_secret_basic`, code + PKCE S256           | **localhost**: Phase 1에서 확인(아래 표)                                                                                       |
| HTTPS 도메인과 `https://<host>/bff/v1/auth/callback` 등록              | **EXT-HOSTING, `not_executed`**. 지금 등록은 `http://localhost:3100/...`(Development Mode)                                     |
| `post_logout_redirect_uri=https://<host>/account` 등록                 | **EXT-HOSTING, `not_executed`**. 지금은 `http://localhost:3100/account` 등록을 확인                                            |
| `OIDC_ISSUER`/`OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET`을 secret manager로 | **EXT-HOSTING, `not_executed`**. 지금은 git-ignored `.env` → 프로세스 환경                                                     |
| TLS ingress, `__Host-` 쿠키(Secure), `NODE_ENV=production`             | **EXT-HOSTING, `not_executed`**. localhost는 `workout_*` 쿠키(Secure 없음), `NODE_ENV=development`                             |
| 시험 계정 둘(하나는 MFA)                                               | **localhost**: 사용자가 만들었다                                                                                               |
| 실제 브라우저 체크리스트(로그인·로그아웃 후 다른 계정·전환·취소·만료)  | **localhost**: Phase 2에서 수행(아래 단계별 결과). 8 h 실시간 만료(11)는 미수행                                                |
| M2-01w 확인 항목 1–4(`max_age`/`auth_time`, end_session, back-channel) | **localhost**: 광고 여부는 Phase 1 확인, 실제 동작은 체크리스트                                                                |
| 운영 배포 환경에서 로그인·만료·세션 교체·철회 경로 검증(oidc-setup.md) | **EXT-HOSTING, `not_executed`**                                                                                                |

## Phase 1 — 공급자 기계 확인

로그인 없는 요청만 사용했다. 원 출력은 `verification-logs/ext-oidc/probes-20260926T095436Z.log`(무시되는
경로, 미커밋)에 있고 client id·secret·state·nonce·code challenge·쿠키 값은 출력하지 않았다(길이·일치 여부만).

| #    | 항목                                     | 결과                                                                                                                                                                                                                                             |
| ---- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | discovery issuer 일치                    | 문서 `issuer`=`https://personal-workout-lgn7dx.eu1.zitadel.cloud`(끝 `/` 없음), `.env`의 `OIDC_ISSUER`는 끝 `/` 있음 → **URL 정규화 후 일치**. oauth4webapi(`new URL(json.issuer).href !== expected.href`)와 앱의 재검사 모두 정규화 비교라 통과 |
| 2    | endpoint HTTPS                           | authorization·token·jwks·end_session 모두 HTTPS                                                                                                                                                                                                  |
| 3    | PKCE                                     | `code_challenge_methods_supported: ["S256"]`                                                                                                                                                                                                     |
| 4    | `client_secret_basic`                    | 광고됨. 실제 토큰 endpoint에 가짜 code + 설정한 secret(Basic) → `invalid_request`/`Errors.User.Code.Invalid`(클라이언트 인증은 통과, code만 거절). 틀린 secret → `invalid_client`/`invalid secret`                                               |
| 5    | ID Token 서명·JWKS                       | `id_token_signing_alg_values_supported`에 RS256 포함(EdDSA·ES*·RS384/512도). JWKS에 RSA 2048 `RS256` `use=sig` 키 **2개 동시 게시**(회전 대비 사전 공개), `cache-control: max-age=300`                                                           |
| 6    | `auth_time`                              | `claims_supported`에 `auth_time` 포함. **`max_age=0`에 새 `auth_time`이 들어가는지는 사람 로그인으로만 확인 가능** → Phase 2 3·5·6                                                                                                               |
| 7    | `prompt=login`                           | `prompt_values_supported`는 광고하지 않음. `prompt=login&max_age=0` 인가 요청은 거절 없이 로그인 화면으로 간다(`/ui/v2/login/login` → `loginname`). **자격 증명을 다시 묻는지는 Phase 2 3·5·6**                                                  |
| 8    | `end_session_endpoint`                   | 광고됨(`/oidc/v1/end_session`). 앱과 같은 요청(`client_id` + `post_logout_redirect_uri=http://localhost:3100/account`, `id_token_hint` 없음) → `302 /ui/v2/login/logout`. 등록 안 된 URI → `400 post_logout_redirect_uri invalid`                |
| 9    | back-channel logout                      | `backchannel_logout_supported: true`, `backchannel_logout_session_supported: true` 광고. **앱은 미구현**(M2-01w: 세션 철회 함수 + `jti` 재생 방지 → migration 필요). 그때까지 Zitadel 쪽 계정 정지의 앱 도달 상한은 8 h                          |
| 10   | `authorization_response_iss_parameter`   | 광고 안 함(앱은 요구하지 않는다)                                                                                                                                                                                                                 |
| 11   | redirect URI·client 등록(음성 대조 포함) | 앱이 만든 인가 요청 그대로 → 로그인 화면. redirect URI만 바꾸면 `400 redirect_uri is missing in the client configuration`, client id만 바꾸면 `400 Errors.App.NotFound` → **수락이 등록 일치의 증거**                                            |
| 12   | 공급자의 취소 수단                       | `loginname` 화면 버튼: `English`, `Back`, `Continue`. `Back`이 RP에 `error=access_denied`를 돌려주는지는 Phase 2 7                                                                                                                               |
| 참고 | `code_challenge_method=plain`            | 인가 단계에서 거절하지 않는다(광고는 S256만). 앱은 항상 S256을 보내므로 앱 계약에는 영향 없음                                                                                                                                                    |

## Phase 1 — 로컬 실행 스택

[oidc-setup.md](../oidc-setup.md)의 "DB 준비"·"API 실행 환경"을 그대로 따른 로컬 스택이다. 스크립트는 `.env`
경로를 담고 있어 처음에는 세션 scratchpad에만 두었고, root가 handoff용으로 `scripts/ext-oidc-local/`에 복사해
커밋했다(WIP, 제품 스크립트 아님; 값은 출력하지 않고 경로만 담는다).

- **DB**: 전용 PostgreSQL 14 클러스터(Unix socket만, TCP 없음). bootstrap superuser는 role/DB 생성과 서버측
  확인에만 쓴다. DB `workout_ext_oidc`의 소유자이자 **migration owner `workout_owner`**는
  `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`, **runtime role `workout_runtime`**도 같은 속성이다.
  migration owner로 `migrate()`(전체) → 문서의 SQL grants → `grantIdentityFunctions`·`grantOperations`·
  `grantGarmin` 외 identity E2E harness가 runtime role에 쓰는 grant 함수(worker role용·비공식 Garmin·
  fixture 전용 `coaching_analysis_output` INSERT는 제외). 앱에는 runtime URL만 준다.
  plain owner로 전체 migration과 grant가 성공했다.
- **API**: `apps/api/src/start.ts`(제품 entrypoint) — `127.0.0.1:4300`, `NODE_ENV=development`,
  `.env` 다섯 값 + `DATABASE_URL`(runtime) + `PRIVATE_RESOURCE_STORAGE_ROOT`,
  `OIDC_VERIFY_REAUTHENTICATION=true`·`OIDC_PROVIDER_LOGOUT=true`(제품 기본값을 명시). 상속 환경은 넘기지 않는다.
- **Web**: `API_ORIGIN=http://127.0.0.1:4300`로 build한 `next start` — `127.0.0.1:3100`. 브라우저는
  `http://localhost:3100`(등록된 redirect URI의 host)으로 연다.
- harness 잠금(3100/4200/4300/4400)을 supervisor가 잡고 `down`에서 푼다. DB 데이터는 `down` 뒤에도 남는다
  (세션이 API 재시작·스택 재기동을 넘어 유지되는지 보기 위해). `purge`만 지운다.
- 장애 모의: `outage-on`은 **API만** `OIDC_ISSUER=https://localhost:9/`(연결 거부)로 재시작한다. 같은 DB·같은
  세션 쿠키. `outage-off`로 원래 issuer로 재시작.

**Phase 1 실측(2026-09-26, 잠금 보유 약 3분 후 해제)**:

| 확인                                      | 결과                                                                                                                                                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 기동                                      | `/health` 200, `http://localhost:3100/account` 200(127.0.0.1로 연결)                                                                                                                                                                                                      |
| `/bff/v1/auth/login`(web 경유, 쿠키 없음) | `302` → Zitadel `authorization_endpoint`. `redirect_uri=http://localhost:3100/bff/v1/auth/callback`, `response_type=code`, `scope=openid`, `S256` + 43자 challenge, state·nonce 43자, `prompt`·`max_age` 없음. `workout_login` 쿠키 `HttpOnly; SameSite=Lax; Max-Age=600` |
| 같은 요청 + 로그아웃 표식 쿠키            | 위와 같고 `prompt=login&max_age=0`, nonce 50자(`reauth.` 접두)                                                                                                                                                                                                            |
| 같은 요청 + 세션 쿠키(계정 전환)          | `prompt=login&max_age=0`                                                                                                                                                                                                                                                  |
| 세 요청을 Zitadel에 그대로                | 모두 `302 /ui/v2/login/login?authRequest=…`(거절 없음)                                                                                                                                                                                                                    |
| `outage-on` 뒤 로그인                     | `302 /account?login_error=unavailable`, `/health` 200, 로그 `oidc_discovery_failed:network` 1회, `login_failed:unavailable` 1회, 시도 행 생성 없음                                                                                                                        |
| `outage-off` 뒤 로그인                    | 다시 `302` → Zitadel                                                                                                                                                                                                                                                      |
| API 로그 누출 검사                        | client id·secret, `code=`/`state=`/`nonce=` query, JWT·`id_token`/`access_token`, 쿠키 값, authorization 헤더 **모두 없음**                                                                                                                                               |

**결함**: Phase 1에서 제품 결함은 찾지 못했다. 코드 변경 없음.

## Phase 2 — 실제 브라우저 수행(2026-09-26, 10:07–10:43Z)

root가 스택을 띄우고(잠금 소유 `EXT-OIDC 9990`) 사용자가 실제 Chrome에서 `http://localhost:3100/account`로
체크리스트를 수행했다. 사용자 A = athlete `33e6140a…`, B(MFA) = `f722acd9…`.

**출처 표기**: "사용자" = root가 전한 사용자 보고. "서버" = root 또는 이 agent가 본 DB 행과 API 로그.
DB 행은 `stack.sh sessions`로 보며 session id·athlete id·만료만 담는다(토큰·nonce 값 없음). API 로그는 경로 없는
구조화 로그다. 302는 `auth/login` 시작 또는 `auth/callback` 성공이며, callback 실패는 반드시 `login_failed`를 남긴다.

| #   | 단계                                       | 결과          | 증거와 출처                                                                                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------ | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 첫 로그인(A)                               | 수행          | 사용자: 완료. 서버: 10:09:02 시작 → 10:09:16 callback 성공, 계정 생성                                                                                                                                                                                                                                                                              |
| 2   | 로그인 유지·새 탭                          | 수행          | 사용자: 이상 없음. 서버: 10:09–10:14 인증 요청 200 연속, 두 번째 탭 존재(3의 `SESSION_CHANGED`)                                                                                                                                                                                                                                                    |
| 3   | 계정 전환 A→B(같은 브라우저, MFA)          | 수행          | 사용자: "All look fine". 서버: 10:11:59 시작(세션 쿠키 → `prompt=login&max_age=0`) → 10:14:29 callback 성공(2.5 분, MFA와 부합). 같은 브라우저의 A 세션 행이 교체됐다(`previousTokenHash`). 다른 탭의 옛 session id 요청 → `409 SESSION_CHANGED` ×3(설계대로). callback 성공 = Zitadel `auth_time`이 앱의 30 s 검사 통과                           |
| 3a  | (관찰) 두 번째 브라우저 문맥               | 설명됨        | A 행 `3b59101c`(10:09:37)가 전환 뒤에도 남았다. 10:09:36 시작 → 1 s 만의 callback: 앱 쿠키 없는 다른 문맥이라 `prompt` 없이 Zitadel SSO가 응답(첫 로그인 설계). 사용자가 6 뒤 그 브라우저에서 로그아웃하자 행이 사라졌다(서버). **결함 아님**: 재로그인은 그 브라우저의 이전 세션만 교체하고, 다른 브라우저 세션은 끊지 않는다(전역 로그아웃 없음) |
| 4   | 같은 계정 재인증                           | 확인 없음     | 사용자의 별도 확인 없음. 재인증 성공 요청은 여럿이지만 어느 것이 "같은 계정 다시 선택"인지 서버 로그로 구분할 수 없다                                                                                                                                                                                                                              |
| 5   | 앱 로그아웃 → Zitadel 로그아웃 → 다른 계정 | 수행          | 사용자: Zitadel 화면 "Logout / Click an account to end the session"에서 B를 눌러 `/account`로 복귀, A 재로그인 "fine". 서버: 로그아웃 POST `200`(`providerLogoutUrl` 반환), B 세션 철회, 새 A 세션 `9e3a089c`. `id_token_hint` 없는 요청에 Zitadel은 바로 끝내지 않고 확인(계정 선택)을 묻는다                                                     |
| 6   | Zitadel 로그아웃 건너뜀 → 다른 계정        | 수행          | 사용자: A 로그아웃 뒤 Zitadel 화면을 건너뜀, 앱은 로그아웃 상태. B 로그인 때 "Yes, it asked me the password". 첫 시도는 끝나지 않았고 재시도에서 성공. 서버: 새 B 세션 `239aa997`, `login_failed` 없음(미완료 시도는 10 분 TTL로 소멸). SSO가 남아도 표식 → 재인증 요청 → 비밀번호 재요구 → 앱 `auth_time` 검사 통과                               |
| 7   | Zitadel 화면에서 취소                      | 부분          | 사용자: "Back"은 `/account`로 돌아왔다. 서버: `login_failed:cancelled` 없음. Zitadel "Back"은 RP에 `error=access_denied`를 보내지 않는다. 시도 행은 TTL로 소멸. 앱의 `cancelled` 화면 경로는 Zitadel로는 실행되지 않았다                                                                                                                           |
| 8   | MFA 중단                                   | 사용자 보고만 | 사용자: 이전에 확인했고 이상 없음. 서버 증거 없음                                                                                                                                                                                                                                                                                                  |
| 9a  | 장애 중 기존 세션 유지                     | 수행          | 사용자: 로그인 유지. 서버: `outage-on`(10:36:20, API만 연결 거부 issuer로 재시작) 뒤 10:36–10:38 인증 요청 200 ×35, 401 없음                                                                                                                                                                                                                       |
| 9b  | 장애 중 로그인                             | 수행          | 사용자: unavailable 문구. 서버: 10:37:51 `oidc_discovery_failed:network` + `login_failed:unavailable` + `302`                                                                                                                                                                                                                                      |
| 9c  | 장애 중 로그아웃 → 로그인                  | 부분          | 사용자: 로그아웃됨, 로그인 시 unavailable. 서버: 로그아웃 POST `204`(이 프로세스엔 성공한 discovery가 없어 공급자 로그아웃 URL 없음 — 설계대로). 그 뒤 두 번째 `login_failed`는 없다 — 사용자가 본 unavailable은 9b 화면일 수 있다                                                                                                                 |
| 9d  | 복구 뒤 로그인                             | 수행          | 사용자: A 재로그인. 서버: `outage-off`(10:39:10) 뒤 10:39:45 → 10:39:58 callback 성공, 새 A 세션 `8fe7154f`                                                                                                                                                                                                                                        |
| 10  | 만료(모의)                                 | 서버 절반만   | 서버: `expire-sessions`로 `8fe7154f` live=false, 이어 10:42:36–58 인증 요청 모두 `401`. 화면 전환·재로그인은 관찰되지 않았다 → UI 절반 `not_executed`. 실제 8 h 시계가 아니라 `expires_at`을 당긴 모의다                                                                                                                                           |
| 11  | 실제 8 h 만료                              | 미수행        | `not_executed`                                                                                                                                                                                                                                                                                                                                     |

로그 전체(Phase 1 probe 포함, 671줄): `login_failed:unavailable` ×2(Phase 1 ×1, 9b ×1), `oidc_discovery_failed:network`
×3(Phase 1 ×1, 장애 모드 기동 직후 stderr ×1, 9b ×1), 그 밖의 `login_failed` 없음. **누출 검사**(client id·secret,
`code=`/`state=`/`nonce=` query, JWT·`id_token`/`access_token`, 쿠키 값, authorization 헤더) **모두 없음**.
로그인마다 "Zitadel이 다시 물었는가"를 물었으나 6 외에는 답이 없었다. 3·5의 재인증 근거는 서버측 `auth_time`
검사 통과(기본값 on)와 callback 소요 시간(11 s–2.5 min)이다.

### M2-01w 확인 항목의 결론

1. **`max_age`/`auth_time`**: 3·5·6·9d의 재인증 callback이 모두 앱의 30 s 검사를 통과했다(`failed` 0).
   6에서는 SSO가 남은 상태에서도 비밀번호를 다시 물었다(사용자).
   → **`OIDC_VERIFY_REAUTHENTICATION=true`(기본값) 유지를 제안한다.** 30 s 허용 오차의 한계는
   [oidc-setup.md](../oidc-setup.md)에 적힌 그대로다.
2. **`end_session_endpoint`**: 광고, localhost post-logout URI 등록 확인(Phase 1). `id_token_hint` 없는 요청에 확인
   화면을 보인다(5). https post-logout URI 등록은 EXT-HOSTING.
3. **back-channel logout**: Zitadel은 광고하고, 앱은 미구현. 사용자 결정에 따라 후속 노드
   `EXT-BACKCHANNEL`(migration 포함)을 추가했다.
   그 전까지 Zitadel 쪽 계정 정지의 앱 도달 상한은 8 h.
4. **체크리스트 추가 항목**:
   - 취소(7): Zitadel "Back"은 오류 응답 없이 되돌아간다.
   - 앱 로그아웃 → OP 로그아웃 → 다른 계정(5).
   - OP 장애 중 기존 세션 유지와 로그인 unavailable(9).

## 남는 `not_executed`

- **EXT-HOSTING으로 이동(사용자 결정)**:
  - HTTPS 도메인과 `https://<host>/bff/v1/auth/callback`·`/account` 등록;
  - TLS ingress, `__Host-`/Secure 쿠키, `NODE_ENV=production`;
  - secret manager;
  - 배포 환경에서의 로그인·만료·교체·철회.
- **이 노드 안에서 미수행**: 4(같은 계정 재인증의 별도 확인), 7의 앱 `cancelled` 화면(Zitadel이 `access_denied`를
  보내지 않음), 8의 서버 증거, 10의 화면 절반, 11(실제 8 h).

## K-oidc 판정 제안

매트릭스 header 규칙: "passed only when a test, probe or measurement executed in this node passed AND asserts the
core of the requirement AND would fail without the feature."

- **실행한 것**: 이 노드에서 실제 IdP(Zitadel Cloud)로 사람이 실제 Chrome에서 로그인·전환·로그아웃·재인증·장애를
  수행했고, 서버 증거가 뒷받침한다. K-oidc의 "실제 OIDC"에 처음 닿은 증거다.
- **부족한 것**:
  1. 사람 수행이라 반복 가능한 시험이 아니다. **기능을 빼면 실패함을 보인 mutant가 없다.** 재인증 검사가 켜진
     상태에서 성공했다는 것이지, 꺼졌을 때 실패한다는 증거가 아니다.
  2. 원 요구(`map-implementation-plan.md:94` "실제 OIDC/DB/객체/E2E")의 운영 조건인 HTTPS·배포 환경은
     EXT-HOSTING으로 넘어가 미수행이다.
  3. 4, 10(화면), 11은 미수행이다.
- **제안: `not_executed` → `partial`.** `passed`로 올리지 않는다. `passed`에는 두 가지가 필요하다:
  EXT-HOSTING의 배포 환경 수행, 그리고 기능 제거 시 실패를 보이는 반복 가능한 증거(예: 자동화한 Zitadel
  로그인에서 재인증 검사를 끈 mutant가 조용한 재로그인을 받아들이는 것). 매트릭스 수정은 root가 한다.

## 검증(Phase 2, `d6918aa` 위 작업 트리, 2026-09-26)

로그: `verification-logs/ext-oidc/phase2/`(무시되는 경로). `TEST_DATABASE_*` 없음. load avg는 1분 값이다.

| 검증                                       | 결과                                                                                                                                                                                                                | load      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `pnpm install --frozen-lockfile`           | 통과                                                                                                                                                                                                                | 6.9       |
| `pnpm check:generated`                     | 통과                                                                                                                                                                                                                | 6.9       |
| `pnpm lint` 1회차                          | **실패 2건 — `scripts/ext-oidc-local/stack.mts`**(root가 커밋한 복사본): `import()` 타입 주석, 비리터럴 동적 import. 정적 import(`pg`, `../../packages/server/persistence/src/migrate.ts`)로 고쳤다. 2회차 **통과** | 6.3 / 9.9 |
| `pnpm typecheck`                           | 통과(34/34)                                                                                                                                                                                                         | 7.6       |
| `pnpm build`                               | 통과                                                                                                                                                                                                                | 11.3      |
| `pnpm test` 1회차                          | 324/325 파일: `garmin-unofficial-worker.test.ts`가 이 worktree에 `.venv`가 없어 실패(환경). `uv sync` 뒤 2회차 **3,995 passed / 325 files**                                                                         | 21        |
| `pnpm test:integration`                    | **794 passed**                                                                                                                                                                                                      | 18.6→9.6  |
| `pnpm test:identity` 1회차(잠금)           | **260 passed / 1 failed / 2 did not run / 9 skipped**. 실패: `garmin-unofficial.spec.ts:134` Next shell, "인증 코드 입력 대기" 5 s 대기 초과. 직전 `uv sync`로 막 만든 `.venv`의 첫 실행이었다                      | 20→11     |
| `pnpm test:identity` 2회차(잠금)           | **263 passed / 9 skipped**                                                                                                                                                                                          | 11→12.7   |
| 격리 재실행 `garmin-unofficial.spec.ts` ×3 | 첫 반복 4/4 통과. 2·3번째 반복의 `:134`는 실패(버튼 disabled) — `--repeat-each`가 한 harness의 상태(이미 핀된 연결)를 이어 쓰므로 유효한 신호가 아니다                                                              | 10→5.9    |
| `pnpm format:check`(마지막)                | 통과                                                                                                                                                                                                                |           |

identity 1회차의 실패는 비공식 Garmin 수집기 경로이며, 이 노드의 변경은 문서와 `scripts/ext-oidc-local/`뿐이라
제품 코드 경로를 바꾸지 않았다. 새 `.venv`의 첫 Python 실행 지연이 원인일 가능성이 높으나 **확정하지 못했다**.
2회차와 격리 첫 반복은 통과했다.

`scripts/ext-oidc-local/`의 다른 변경은 prettier 서식뿐이다(`probe-*.mjs`, `stack.mts`). root의 1회차 커밋에서
lint·format 검사를 통과하지 못하던 파일들이다.

## Phase 독립 검토 · 2026-09-26

- 기준 `main` `5a4dfb5c98d99e88344f920da3ab14558a762ac8`, 검토 HEAD `904f662`의 전체 diff를
  Codex CLI `gpt-6-sol` high, read-only sandbox에서 검토했다. 결과는 **CHANGES_REQUESTED**였다.
- 발견 1(옛 worktree·scratchpad 절대 경로): **FIXED**. stack은 현재 checkout을 기준으로 실행하고
  상태 디렉터리를 checkout별로 분리한다.
- 발견 2(실제 IdP의 미검증 취소 경로 누락): **FIXED**. EXT-HOSTING에 검증을 배정하고 실제 확인 전까지
  `not_executed`로 남긴다.
- 발견 3(EXT-HOSTING을 일반 task로 분류): **FIXED**. 외부 gate로 표시했다.
- 발견 4(공급자 응답 원문 출력): **FIXED**. probe 출력은 허용된 오류 코드와 상태로 제한한다.
- 수정 후 root가 bash/Node 구문, 오류 코드 허용 목록, graph 노드·의존성, `git diff --check`를
  재검증했다. 실제 Zitadel 로그인은 재실행하지 않았다. **수정된 HEAD의 독립 재검토는 대기 중**이다.
- 재검토 HEAD `670c888`에서 이전 4건은 모두 **FIXED**였으나, HANDOFF가 EXT-HOSTING과
  back-channel 후속 결정을 이전 상태로 안내하는 새 지적이 있어 **CHANGES_REQUESTED**였다.
  HANDOFF의 현재 상태와 사용자 결정을 고쳤다. 이 새 지적의 수정 HEAD는 다시 검토받는다.

## 열린 항목

- EXT-HOSTING: 위 이동 항목 전부. Zitadel Back이 앱의 `cancelled` 경로를 실행하지 않은 항목(7)도
  이 gate에 배정했다. 실제 공급자에서 실행 가능한 취소 수단이 없다면 미검증으로 남긴다.
- EXT-BACKCHANNEL: 앱 구현, migration, 실제 공급자 전파 시험. 현재 `not_started`.
- 4, 10(화면), 11은 EXT-HOSTING에서 확인한다.
- `scripts/ext-oidc-local/`는 현재 checkout을 기준으로 실행하며 별도 checkout의 `.env`는
  `WORKOUT_OIDC_ENV_FILE`로 지정할 수 있다. 이 경로 수정은 기존 실제 브라우저 증거의 재실행이 아니다.
