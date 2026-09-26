# EXT-OIDC · 운영 OIDC identity provider 확보

상태: **Phase 1 완료(기계 확인 + 로컬 실행 스택 + 사람 체크리스트). Phase 2(실제 브라우저 결과의 서버측
확인·판정 제안·검증 묶음)는 사용자의 체크리스트 수행 뒤.** 기준 HEAD `52ccb09`. 제품 코드 변경 없음.
`task-graph.json`·`AGENTS.md`·`CLAUDE.md`·`.geo-build`·M2-01k 매트릭스는 건드리지 않았다.
**`K-oidc`는 이 문서 시점에 계속 `not_executed`다** — 아래 기계 확인은 로그인 없는 요청만이며 사람이 실제
브라우저로 로그인한 증거가 아니다.

## 사용자 결정(2026-09-26)

1. 공급자: **Zitadel Cloud**. 인스턴스와 앱 등록은 사용자가 했다. issuer
   `https://personal-workout-lgn7dx.eu1.zitadel.cloud`(client id·secret은 문서·로그·저장소에 쓰지 않는다).
2. 아직 호스팅이 없으므로 `PUBLIC_ORIGIN=http://localhost:3100`, `ALLOW_INSECURE_LOCALHOST=true`, Zitadel
   **Development Mode**(HTTP redirect 허용). 등록한 redirect URI `http://localhost:3100/bff/v1/auth/callback`,
   post-logout URI `http://localhost:3100/account`.
3. 시험 사용자 둘, 그중 하나는 MFA.
4. 비밀 값은 저장소 root의 git-ignored `.env`(`PUBLIC_ORIGIN`, `ALLOW_INSECURE_LOCALHOST`, `OIDC_ISSUER`,
   `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`)에만 있고, 실행 시 프로세스 환경으로만 넣는다.
5. **EXT-OIDC / EXT-HOSTING 분리(문서 기록만).** 사용자는 EXT-OIDC를 localhost + 실제 Zitadel 증거로
   완료하고, HTTPS 도메인·TLS ingress·secret manager 항목은 root가 새로 만들 노드 **EXT-HOSTING**으로 옮기기로
   결정했다. 사용자 정정에 따라 **지금은 문서에 기록만 하고 작업 구성은 바꾸지 않는다**(task-graph 반영은
   root 몫). 아래 "범위 구분" 표가 그 기록이다.

## 범위 구분 — localhost에서 하는 것 / EXT-HOSTING으로 넘어가는 것

| EXT-OIDC 범위 항목(task-graph)                                         | 처리                                                                                                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 운영 IdP 선택 — `prompt=login` 준수, 서명 키 사전 공개                 | **localhost**: Zitadel Cloud. discovery·JWKS는 Phase 1에서 확인, `prompt=login`·`auth_time`은 체크리스트 3·4·5에서 사람이 확인 |
| confidential client, `client_secret_basic`, code + PKCE S256           | **localhost**: Phase 1에서 확인(아래 표)                                                                                       |
| HTTPS 도메인과 `https://<host>/bff/v1/auth/callback` 등록              | **EXT-HOSTING, `not_executed`**. 지금 등록은 `http://localhost:3100/...`(Development Mode)                                     |
| `post_logout_redirect_uri=https://<host>/account` 등록                 | **EXT-HOSTING, `not_executed`**. 지금은 `http://localhost:3100/account` 등록을 확인                                            |
| `OIDC_ISSUER`/`OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET`을 secret manager로 | **EXT-HOSTING, `not_executed`**. 지금은 git-ignored `.env` → 프로세스 환경                                                     |
| TLS ingress, `__Host-` 쿠키(Secure), `NODE_ENV=production`             | **EXT-HOSTING, `not_executed`**. localhost는 `workout_*` 쿠키(Secure 없음), `NODE_ENV=development`                             |
| 시험 계정 둘(하나는 MFA)                                               | **localhost**: 사용자가 만들었다                                                                                               |
| 실제 브라우저 체크리스트(로그인·로그아웃 후 다른 계정·전환·취소·만료)  | **localhost**: 아래 체크리스트(사람 수행 대기). 8 h 실시간 만료는 선택 항목                                                    |
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
| 6    | `auth_time`                              | `claims_supported`에 `auth_time` 포함. **`max_age=0`에 새 `auth_time`이 들어가는지는 사람 로그인으로만 확인 가능** → 체크리스트 3·4                                                                                                              |
| 7    | `prompt=login`                           | `prompt_values_supported`는 광고하지 않음. `prompt=login&max_age=0` 인가 요청은 거절 없이 로그인 화면으로 간다(`/ui/v2/login/login` → `loginname`). **자격 증명을 다시 묻는지는 체크리스트 3·4·5**                                               |
| 8    | `end_session_endpoint`                   | 광고됨(`/oidc/v1/end_session`). 앱과 같은 요청(`client_id` + `post_logout_redirect_uri=http://localhost:3100/account`, `id_token_hint` 없음) → `302 /ui/v2/login/logout`. 등록 안 된 URI → `400 post_logout_redirect_uri invalid`                |
| 9    | back-channel logout                      | `backchannel_logout_supported: true`, `backchannel_logout_session_supported: true` 광고. **앱은 미구현**(M2-01w: 세션 철회 함수 + `jti` 재생 방지 → migration 필요). 그때까지 Zitadel 쪽 계정 정지의 앱 도달 상한은 8 h                          |
| 10   | `authorization_response_iss_parameter`   | 광고 안 함(앱은 요구하지 않는다)                                                                                                                                                                                                                 |
| 11   | redirect URI·client 등록(음성 대조 포함) | 앱이 만든 인가 요청 그대로 → 로그인 화면. redirect URI만 바꾸면 `400 redirect_uri is missing in the client configuration`, client id만 바꾸면 `400 Errors.App.NotFound` → **수락이 등록 일치의 증거**                                            |
| 12   | 공급자의 취소 수단                       | `loginname` 화면 버튼: `English`, `Back`, `Continue`. `Back`이 RP에 `error=access_denied`를 돌려주는지는 체크리스트 6                                                                                                                            |
| 참고 | `code_challenge_method=plain`            | 인가 단계에서 거절하지 않는다(광고는 S256만). 앱은 항상 S256을 보내므로 앱 계약에는 영향 없음                                                                                                                                                    |

## Phase 1 — 로컬 실행 스택

[oidc-setup.md](../oidc-setup.md)의 "DB 준비"·"API 실행 환경"을 그대로 따른 로컬 스택이다. 스크립트는 `.env`
경로를 담고 있어 저장소 밖(세션 scratchpad `ext-oidc/`)에 두고 커밋하지 않는다.

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

## 사람 체크리스트(Phase 2 입력)

별도 보고로 root에 전달했다(한국어, 번호별로 "보이는 것"과 "서버측 확인"). 결과가 오면 여기 기록한다.

## 열린 항목

- 체크리스트 수행과 그 결과의 서버측 확인(Phase 2).
- `OIDC_VERIFY_REAUTHENTICATION` 운영 기본값(on) 확정 — 체크리스트 3·4·5 결과로.
- back-channel logout: Zitadel이 광고하므로 원하면 migration을 포함한 후속 노드(root 결정). 그 전까지 상한 8 h.
- EXT-HOSTING(사용자 결정, 문서 기록만): HTTPS 도메인·TLS·`__Host-` 쿠키·secret manager·운영 redirect/post-logout
  URI 등록·배포 환경 경로 검증은 `not_executed`.
- 검증 묶음(install·gen·lint·typecheck·build·test·integration·identity ×2·format)은 Phase 2에서 실행한다.
