# EXT-BACKCHANNEL · OIDC Back-Channel Logout 앱 수신

기준: 2026-09-27. 사용자 결정으로 EXT-OIDC와 분리한 후속 노드.

## 구현 범위

- `POST /bff/v1/auth/backchannel-logout`는 인증 쿠키와 CSRF 없이 공급자의 form POST를 받는다.
  한 개의 `logout_token`만 허용하며 본문은 8 KiB로 제한한다. 성공은 204, 잘못된 토큰은
  `INVALID_LOGOUT_TOKEN` 400, `jti` 재전송은 `LOGOUT_TOKEN_REPLAY` 409, 공급자/DB 장애는
  `IDENTITY_UNAVAILABLE` 503이다. 요청·응답 로그에는 원본 토큰을 넣지 않는다.
- 공급자의 discovery에서 검증한 JWKS URL로 서명과 허용 알고리즘을 확인하고, 정확한 issuer,
  client audience, `iat`(5분 경과·1분 미래 거부), `jti`, 하나의 빈 back-channel `events`, `nonce` 부재,
  하나 이상의 `sub`/`sid`를 확인한다. 기한이 있으면 JWT 검증에서 확인한다.
- 로그인 때 검증된 ID Token의 `sid`를 앱 세션에 저장한다. Migration 057은 이 값과 로그인 시도 생성 시각,
  issuer별 해시 `jti` 원장을 추가한다. 새 세션 생성 함수는 기존 계정 삭제 경합 잠금을 보존한다.
  Migration 057은 이전 7인자 세션 생성 함수를 제거하고 이전 앱 세션을 전부 만료시킨다. 이전 API가
  새 로그인으로 철회 장벽을 우회하지 못하며, `sid`가 없는 기존 세션이 `sid` 전용 로그아웃 뒤 남지 않는다.
  운영 배포는 이전 API를 drain한 뒤 migration·grant와 새 API를 순서대로 적용해야 한다. 배포 중
  이전 API로 로그인하면 실패하고 기존 사용자는 다시 로그인해야 한다.
  공급자가 session back-channel을 광고하면 ID Token에 검증 가능한 `sid`가 없을 때 새 로그인을 거절한다.
  JWT 검증은 DB 거래 전에 끝난다. 하나의 DB 함수에서 `jti`를 기록하고 해당 issuer·subject·sid의
  앱 세션만 지운다. `sub`와 `sid`가 함께 있으면 둘 다 일치해야 한다. 다른 계정과 issuer는 유지한다.
  로그인 callback과 로그아웃은 동일한 subject·sid 잠금을 같은 순서로 획득한다. 로그아웃이 먼저
  끝나면 그 전에 시작한 callback은 원장의 철회 범위를 검사해 세션 생성을 거부하고, callback이 먼저
  끝나면 로그아웃이 그 세션을 삭제한다. `sub`만 있는 토큰의 이전 로그인 시도는 막지만 그 뒤 새로
  시작한 로그인은 허용한다. `sub`+`sid` 토큰은 다른 `sid`의 로그인을 막지 않는다.

## 검증

| 항목                                                              | 결과                                                                         |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 서명·issuer·audience·시각·events·nonce·대상 검증                  | 로컬 서명 공급자 단위 시험 통과                                              |
| callback 본문·코드·토큰 로그 비노출                               | Fastify inject 시험 통과                                                     |
| 재전송 동시성·issuer/subject/sid 격리·DB 권한·기존 계정 삭제 잠금 | 임시 PostgreSQL 실통합 시험 통과                                             |
| logout/callback 양쪽 경합 순서와 JWKS 장애 503 분류               | 독립 검토 지적 후 추가 시험 통과                                             |
| 기존 7인자 함수 우회·migration 이전 sid 없는 세션                 | 채워진 이전 DB 업그레이드 실통합 시험                                        |
| 실제 Zitadel Back-Channel Logout 전파                             | **not_executed** · 2026-10-01 URL 등록 확인, 실제 전파·공개 제품 수용 미실행 |
| 실제 계정 정지/로그아웃 후 앱 세션 전파                           | **not_executed** · EXT-HOSTING                                               |

실제 공급자 전파가 확인될 때까지 계정 정지 뒤 앱 세션 잔존 상한은 기존 8시간이다.

2026-09-27 로컬 검증: Node 24.12.0에서 identity·persistence·API typecheck, 변경 TypeScript의
ESLint, 변경 파일 Prettier 검사, `git diff --check`가 통과했다. 로컬 서명 공급자와 Fastify inject
집중 시험은 5파일/53건, 임시 PostgreSQL의 identity·operations 집중 통합 시험은 2파일/26건 통과했다.
격리 worktree의 첫 설치는 sandbox 네트워크 `ENOTFOUND`로 완료하지 못해, 구현 agent가 기존 workspace
의존성에 연결한 임시 로컬 링크와 테스트용 source alias로 집중 시험을 실행했다. Root가 별도 허용된 실행에서
`pnpm install --frozen-lockfile`을 완료했고, 전체 generated·lint·format·typecheck(34/34), build(15/15)가 통과했다.
전체 단위의 첫 실행은 새 worktree에 Python 환경이 없어 기존 Garmin worker 시험이 준비 단계에서 실패했다.
`uv sync --extra garmin`으로 환경을 만든 뒤 재실행해 **334 files passed, 1 skipped; 4,049 passed,
7 skipped**. 전체 PostgreSQL integration 첫 실행은 새 migration 057을 기존 checksum 기대 목록에 넣지 않아
기반 시험 하나가 실패하고 나머지 799개는 통과했다. 기대 목록을 갱신한 뒤 **80 files, 800/800 passed**로
재실행했다. 독립 phase review의 base/head 및 결과는 root 검증 뒤 기록한다.

독립 phase review `main` `53563e3a262934b3df672b758051a47754355112` →
`phase/ext-backchannel` `cb8f7e0a7507e2cc5406a6e41d6083088779c54d`는
**CHANGES_REQUESTED**였다. 지적은 동시 callback의 세션 재생성과 JWKS 장애의 400 오분류였다.
지적 1 **FIXED**: 같은 issuer·subject·sid의 advisory transaction lock과 원장 barrier로
두 완료 순서를 직렬화하고, 실제 PostgreSQL에서 각각의 대기 순서를 만들어 확인했다. `sub`+`sid`
토큰의 철회 범위를 두 값의 교집합으로 유지하는 시험도 추가했다. 지적 2 **FIXED**: JWKS 연결 실패,
비정상 HTTP 응답, 잘못된 JSON을 공급자 장애로 분류하고 503 응답을 시험했다.
추가한 실제 5초 JWKS timeout 집중 시험도 1파일/6건으로 통과했다.

수정 뒤 Node 24.12.0에서 `check:generated`, 전체 `format:check`, `lint`, `typecheck`(34/34),
`build`(15/15), `test`(335 files passed, 1 skipped; 4,067 passed, 7 skipped), 임시 PostgreSQL
`test:integration`(80 files, 803 passed)이 통과했다. 기존 `not_executed` 외부 증거는 그대로다.
수정 후 재검토의 base/head·결과는 root가 기록한다.

두 번째 독립 phase review `main` `17982f2187f75384a3410663cc954307e6cd5261` →
`phase/ext-backchannel` `9f39ea30da136ae24b17980d3296880a18c2677f`는
**CHANGES_REQUESTED**였다. 이전 경합/JWKS 두 지적은 **FIXED**로 판정했다. 새 지적은 남은 7인자
함수의 혼합 배포 우회와 migration 이전 `sid=NULL` 세션의 잔존이었다. Migration 057에서 이전 함수와
기존 세션을 함께 제거하고, 채워진 056 DB를 057로 올리는 시험을 추가했다. 수정 후 독립 재검토의
base/head·결과는 root가 기록한다.

Migration 057은 이전 함수 제거를 기존 세션 삭제보다 먼저 수행해 업그레이드 도중 이전 API 호출이
NULL-`sid` 세션을 재생성할 수 있는 순서 경합을 줄였다. 업그레이드 시험은
`NOSUPERUSER NOBYPASSRLS`인 DB 소유자 역할로 실행해 기존 세션 삭제, 7인자 함수 호출 실패,
새 `sid` 세션의 철회를 확인했다. 임시 PostgreSQL 전체 통합은 **81 files, 804/804 passed**.
실제 운영은 이전 API 인스턴스 drain을 먼저 수행해야 한다. 실제 Zitadel 전파 항목은 계속
**not_executed**다.

이번 수정의 `check:generated`, `format:check`, `lint`, `typecheck`(34/34), `build`(15/15)는 통과했다.
전체 단위의 기본 sandbox 실행은 로컬 HTTP fixture를 여는 identity/API 시험 34건이 실패했다.
로컬 loopback 허용 실행에서 같은 집중 시험 4파일/46건과 전체 단위 **335 files passed,
1 skipped; 4,069 passed, 7 skipped**로 통과했다. `git diff --check`도 통과했다.

세 번째 독립 phase review는 `main` `17982f2187f75384a3410663cc954307e6cd5261` →
`phase/ext-backchannel` `188ae8f9c757489764c5d45d89ea2f0b125393c4` 전체 diff를
Codex CLI `gpt-6-sol` high/read-only로 검토해 **APPROVE**했다. 이전 P1(7인자 함수 우회)과
P2(이전 `sid=NULL` 세션 잔존)는 각각 **FIXED**이며 새 지적은 없다. 검토자는 실DB
업그레이드 시험과 제공된 전체 검증 결과를 근거로 삼았고, 직접 시험을 재실행하지는 않았다.
통제되지 않은 혼합 버전 배포의 원자성은 주장하지 않는다. 실제 Zitadel HTTPS 전파와
계정 정지 이벤트는 `not_executed`다.

## 운영 HTTPS 전파 수용 절차 · 준비만 기록 (2026-10-05)

상태는 **in_progress**이며 아래 실제 Zitadel 전파와 계정 정지 시나리오는 모두 **not_executed**다. 로컬 서명 공급자·DB 시험을 운영 공급자 수용으로 소급하지 않는다.

### 선행 조건

1. [EXT-HOSTING](EXT-HOSTING.md)의 공개 HTTPS 제품 로그인·로그아웃, 올바른 TLS와 `__Host-`/Secure 쿠키, 운영 DB migration 057·grant·이전 API drain·새 API health를 실제 확인한다. 배포 전후 API release와 DB migration 번호를 고정한다.
2. Zitadel의 **해당 운영 client**에 back-channel logout URI `https://workout.red-10-proto.xyz/bff/v1/auth/backchannel-logout`가 등록·활성화됐는지 관리 화면에서 읽어 확인한다. discovery의 issuer·back-channel 지원 광고와 앱의 issuer/audience 설정이 일치해야 한다. URI 등록이나 지원 광고만으로 전파 통과로 판정하지 않는다.
3. 건강 자료가 없는 전용 시험 계정 A·B를 준비한다. A의 두 로그인은 분리된 브라우저 프로필/쿠키 저장소에서 만들고, 서버의 승인된 시험 세션 관찰 경로에서 Zitadel `sid`가 서로 다름을 원문을 보존하지 않는 일회성 동등성 비교로 확인한다. `sid`가 없거나 같으면 session 범위 격리 시험을 시작하지 않는다. 공급자 관리자 동작은 승인된 시험 계정에만 적용한다. 앱 로그아웃이 이미 앱 세션을 지우는 경로와 구별하기 위해 첫 시나리오는 **Zitadel 쪽에서 시작한 세션 종료**로 실행한다.

### 실행과 판정

| 순서 | 실제 조작·관측                                                                                                   | 통과 단언                                                                                                                                                                                                            |
| ---- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | A로 브라우저 두 세션에 로그인하고 B도 별도로 로그인한다. 각 세션에서 `/bff/v1/session`과 보호된 화면을 확인한다. | 시작 전 A 두 세션과 B 세션이 각각 유효하고 A 두 세션의 `sid`가 서로 다르다. 결과에는 원문 대신 `distinct=true`만 기록한다.                                                                                           |
| 2    | Zitadel에서 A의 **한 세션**을 종료하고, 공급자 전달 기록과 앱의 수신 결과를 시간 순서로 관측한다.                | session 범위 logout token이 실제 전달·검증되고 HTTP 204가 기록된다. 대상 A 세션은 다음 인증 요청에서 거절되며 다른 A 세션과 B 세션은 유지된다. 공급자가 session 범위 이벤트를 보내지 않으면 이 행은 미통과로 남긴다. |
| 3    | A의 남은 공급자 세션을 subject 범위로 종료할 수 있는 승인된 시험 동작을 수행한다.                                | 실제 `sub` 범위 이벤트가 전달되면 A의 대상 세션만 철회되고 B는 유지된다. 공급자가 이 범위 이벤트를 제공하지 않으면 `sub` 전파는 **not_executed**로 기록한다.                                                         |
| 4    | 별도로 승인된 시험 계정의 정지를 수행하고 공급자의 실제 이벤트 종류·전달 여부를 확인한다.                        | 계정 정지가 back-channel을 보내는 경우에만 대상 앱 세션의 철회를 판정한다. 이벤트가 없다면 정지 → 즉시 앱 철회를 주장하지 않고 기존 세션 만료 상한 8시간과 실제 관측을 별도로 기록한다.                              |
| 5    | 철회된 브라우저에서 새로고침·보호 API 요청 후 재로그인 가능 여부를 확인한다.                                     | 비공개 데이터가 사라지고 인증 필요 상태가 표시되며, 이후 새 로그인은 공급자 정책에 맞게 처리된다. 브라우저 표시만으로 서버 세션 철회를 판정하지 않는다.                                                              |

전달 지연은 공급자 동작 시각부터 **앱 DB 철회 확인 시각**과 **다음 인증 요청 거절 시각**까지 각각 측정한다. 단순 204는 대상 세션 철회 증거가 아니다. 전파가 없거나 수신이 실패하면 원인을 설정/전달/토큰 검증/DB 적용으로 분리하고 해당 행을 미통과로 둔다. 원본 logout token을 수동 재전송한 결과는 실제 공급자 전파로 세지 않는다. 재전송·동시성·잘못된 토큰의 로컬 검증은 위 기존 기록을 유지한다.

### 보존할 증거와 비공개 범위

운영자 제한 장소에 실행 시각(UTC), 배포 release·migration 번호, 시험 계정의 임의 별칭, 공급자 동작 종류, back-channel 도착 여부, HTTP 상태·안전한 오류 코드, DB의 대상/비대상 세션 **건수**, 다음 인증 응답 상태, 지연, 브라우저 인증 필요 표시만 기록한다. 요청 상관 ID는 비밀값과 무관한 시험용 값으로 쓴다. JWT·`jti`·`sid`·`sub` 원문, 쿠키, 토큰, 이메일, IP, 헤더, 개인 데이터, 공급자 전체 payload와 화면 캡처는 저장소·공유 로그에 남기지 않는다. 실제 실행자는 원본 영수증을 Git 밖 접근 제한 장소에 보관하고 이 문서에는 비식별 요약·실행 결과와 미수행 행만 갱신한다.

새 문맥 없는 Codex `gpt-6-sol` high 읽기 전용 phase 검토는 `main` `16f1de0f6644768dd2f4271a008e22e978ddfc9c` → 첫 HEAD `5082e5cd7f62a5124b28f9ba090dde91068d4c4a`에서 서로 다른 공급자 `sid` 전제가 빠졌다고 **CHANGES_REQUESTED**했다. 분리된 쿠키 저장소와 원문 비보존 동등성 비교를 추가한 HEAD `597e550794aa7e5c703803ee400baf80eaf5a445`의 재검토는 그 지적을 **FIXED**로 판정하고 **APPROVE**했다. 운영 Zitadel 전파는 실행하지 않았다. 이 기록과 최신 `main` 재배치를 포함한 최종 diff는 병합 전에 새로고침 검토한다.
