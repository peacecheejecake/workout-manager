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

| 항목                                                              | 결과                                             |
| ----------------------------------------------------------------- | ------------------------------------------------ |
| 서명·issuer·audience·시각·events·nonce·대상 검증                  | 로컬 서명 공급자 단위 시험 통과                  |
| callback 본문·코드·토큰 로그 비노출                               | Fastify inject 시험 통과                         |
| 재전송 동시성·issuer/subject/sid 격리·DB 권한·기존 계정 삭제 잠금 | 임시 PostgreSQL 실통합 시험 통과                 |
| logout/callback 양쪽 경합 순서와 JWKS 장애 503 분류               | 독립 검토 지적 후 추가 시험 통과                 |
| 기존 7인자 함수 우회·migration 이전 sid 없는 세션                 | 채워진 이전 DB 업그레이드 실통합 시험            |
| 실제 Zitadel Back-Channel Logout 전파                             | **not_executed** · 외부 HTTPS callback 등록 필요 |
| 실제 계정 정지/로그아웃 후 앱 세션 전파                           | **not_executed** · EXT-HOSTING                   |

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
