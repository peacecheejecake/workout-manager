# Profile27 (V11, source tip 148) 로컬 통합과 검증 · 2026-10-13

Profile27은 profile26(V10, 146) 위에 gallery 143/144/145(M2-03a/b/c), restore processing admission 147(EXT-RESTOREa),
AI execution job store 148(M2-05a)을 하나의 설치 단위로 묶는다(사용자 결정: profile27 하나로 묶기, profile26 은퇴).
API 선택은 `baseline107`과 `installed-current-profile27`만 남고, account export는 pooled V40이다.
이 기록은 로컬 구현·로컬 실제 PostgreSQL 검증만 다룬다. 운영 hosting·실제 restore drill·실기기·외부 OIDC는 실행하지 않았고
`not_executed`를 바꾸지 않는다.

## 구성

- 설치·권한: `current-runtime-installation-v11.ts`(parent 33, extension 143/144/145/147/148),
  `current-runtime-grants-v11.ts`(runtime 51 RPC + 7 table grant, gallery rendition worker 5 RPC,
  AI dispatcher `ai_execution_job_disposition` SELECT/INSERT). 세 principal은 서로 겹치지 않는다.
- Runtime은 `ai_execution_job_disposition`을 SELECT만 받는다(작업 조회가 복원 취소 disposition을 보여 주기 때문, U5).
  쓰기는 dispatcher만 가능하다. Roster 검사는 runtime grant가 table delegation의 부분집합이고 dispatcher는 전체임을 요구한다.
- Catalog: witness/cold catalog v11, compiled-expected v11. 고정 principal 두 개(`workout_gallery_rendition_worker`,
  `workout_ai_dispatcher`)는 기대 catalog에 항상 존재한다. 없거나 속성이 다르면 catalog mismatch다.
- 공유 witness visit 상한을 250000→1000000으로 올렸다(사용자 결정). profile27 metadata는 약 263k visit이다. digest는 바뀌지 않는다.
- Source-build proof v3 / readiness v3, protocol `named-profile27-pooled-v3-v40`.
- `deploy/lightsail/compose.yml` `ledger_export`는 head witness를 `<data>/ledger-witness`(root 소유, 0700)에 쓴다.

## Catalog 관측

두 독립 관측(각각 고정 PG17.6 이미지, a/b fresh V11, c = profile26 → V11 upgrade)이 모든 section·catalogSha256·sqlJsonbSha256에서 일치했다.
c의 V10 control은 profile26 digest `eb61b2d6…`을 재현했고 V10 witness는 V11을 거절했다.

- 리뷰 수정 후 최종 catalogSha256 `40c62f7e186124b34661469328bbfc8c1d8028189cc1ff2ca8215f1769861a43`, sqlJsonb `add5bf29…`, metadata 7024620 bytes.
  직전 `46ab5572…`과의 차이는 143·148 함수 본문 두 개와 설치 seal의 member SHA뿐이다.
- 첫 관측 `d1234cc8…`은 runtime disposition SELECT 추가 전 값이다. 차이는 그 ACL 한 행과 shared dependency 한 행뿐이다.

## Proof v3

최종 stage r5 manifest `9d0e73f7c1d89bf6ffd35e06ff729d7d48c8ddf3892962f033e9b1e9834435d0`,
asset `d017bbf216a04735febd055e86413a952b03ec863740ed669320e34fa3871de6`(381 source, 414 case: 역사 310 + Root 실제 PG17.6 증거 104).
verifier는 `verified_build_evidence`이고 asset의 currentFunctionalExecution은 `not_executed`, authority/restoreAuthority none이다.
`gallery-albums` 20건은 라벨 형식이 proof 검사와 맞지 않아 case에 들어가지 않았다(시험 자체는 통과).
v1/v2 proof는 이 branch에서 의도적으로 source_drift다(profile26 은퇴). r12 guard는 정확한 허용 drift 집합(v1 12, v2 10)만 받는다.

## Canonical에서 찾아 고친 결함

1. 고정 principal이 API 시험·identity harness에 없어 readiness `catalog_mismatch` → 생성·grant 추가.
2. 작업 조회가 disposition을 join하나 runtime SELECT가 없어 404 대신 500 → runtime SELECT 추가, catalog 재관측.
3. C4 successor suite: datum byte가 macOS(signed char)와 Linux aarch64(unsigned)에서 다르게 출력되어 macOS에서 만든
   census가 고정 이미지와 맞지 않았다 → decoder가 unsigned octet으로 정규화, census 재생성(`67892899…`, 두 플랫폼 byte 동일).
   pg_dump는 password를 `PGPASSWORD` 환경으로만 받는다. `TEST_PG_DUMP_PATH` 기본값은 PG17 client.
4. Identity V11 fixture가 grant 결과의 `grantedTables`를 strict parse에서 거절해 current-manual 서버가 시작하지 않았다 → 고정 table grant와 정확 비교.
5. Mobile preview dist가 종료 때 남았다(Vite SIGTERM handler가 process.exit) → graceful SIGTERM + 동기 exit hook 제거.
6. Gallery admission 시험이 `updated_at`/`deleted_at`을 서로 다른 `clock_timestamp()`로 넣어 부하에서 transition guard가 실패 → 한 시각 사용.

## 최종 gate (HEAD `8e5e8f3e`)

- Static7 모두 exit0, unit 699파일·11630 통과·5 skip.
- Canonical(PG17.6 full normal): 326파일 통과·5 skip, 3348 통과·21 skip, 실패0, container 제거·cleanup clean.
  finite-terminal SHA `06309ded44ebc21e9b470dee20d44639ad45cee4c7b01c4677b8c4b990370959`.
- Identity 두 회차 모두 accepted: general 320/skip11, app-consent 4, ai-settings-lifecycle 1, current-manual 22, unexpected·flaky 0.
  result SHA `bf517a5cffc69c1dc21276a7d1342e63d2e6bbf3547e8c7a730c462d1a9f02ff`.
- Gate tooling r12: static guard SHA `64350791…`, driver `gates-r24.sh` SHA `09a8c5de…`.

## 보존한 실패

- r24 첫 시도들: `.geo-build` link 부재로 freeze 실패; canonical 3 suite 실패(위 1–3); identity current-manual 미실행(4);
  identity 미수락(5); canonical gallery admission 1건(6). 각각 고친 뒤 재실행했다.
- `8e5e8f3e` 첫 canonical에서 `nutrition-race-plan-v4-writer` write/withdraw 직렬화 시험 1건이 실패했다. 이 phase는 nutrition·consent·database 코드를
  바꾸지 않았고, 단독 6/6·부하 병렬 3/3은 통과했다. canonical runner는 오류 본문을 남기지 않아 원인(5s statement/3s lock timeout 또는
  host 시각 `approvedAt` 등)은 확인하지 못했다. 기존 부하성 간헐 실패로 기록하고 조용한 기계에서 같은 HEAD로 재실행해 위 결과를 얻었다.
  요약 `gates-summary-r24-8e5e8f3e-attempt1.txt`.

## 남은 위험

- Worker AI job registry는 비어 있다(작업 생성 경로 없음). Subtitle storage는 profile27 밖이다.
- 배포 bootstrap은 profile27 설치·고정 principal 생성을 아직 하지 않는다(EXT-HOSTING 범위).
- macOS 사용자 TMPDIR에 이전 실행의 `wm-identity-mobile-*` 10개가 남아 있다(수정 전 생성분).

## 독립 phase 리뷰 r1과 수정 (2026-10-14)

Codex `gpt-6-sol` high, 읽기 전용, `a0c430ce..c7634a5c`를 6개 partition으로 나눴다(`/private/tmp/wm-profile27-phase-review-r1-20261014/`).
3개 APPROVE, 3개 REQUEST_CHANGES, P1 4건·P2 9건이다. 모두 고쳤다.

- P27-p1-1(P1): 148 job guard가 불변 catalog 정의에서 canonical digest를 다시 계산해 위조 `catalog_digest`를 거절한다.
- P27-p1-2(P1): V11 검증은 고정 worker 외 역할의 worker RPC EXECUTE와 dispatcher 외 역할의 disposition INSERT를 거절한다(멤버 없는 역할만 허용). 모든 grant가 먼저 검증한다.
- P27-p1-3: 143은 restore CLOSED에서 연결 해제만 하는 요청을 허용한다.
- P27-p2a-1(P1): dump 대조는 허용 목록 문법만 받고 중복·상충 setval을 거절한다. p2a-2: 한계값 검증과 고정 상한. p2a-3: structure census가 trigger 함수 본문 SHA와 보안 속성을 묶는다(V1 `1d26190f…`, V2 재생성).
- P27-p3b-1(P1): gallery host가 media transfer adapter를 session별로 memo하고 hook은 adapter 정체성으로 다시 열지 않는다. p3b-2: 409 뒤 새 목록 조회 전까지 그 앨범 쓰기를 막는다. p3b-3: mobile dist exit 정리를 mkdtemp 직후 등록한다.
- P27-p2b-1: 빈 ledger 실행이 head가 참조하는 원격 segment를 모두 다시 읽어 검증한다. p3a-1: rendition 계약 주석을 SQL144 실제 동작으로 맞췄다. p4-1: profile27 identity는 역할이 없는 Garmin/course thumbnail worker를 시작하지 않고 미실행으로 표시한다. p4-2: 배포 README에 ledger 비밀·네트워크를 적었다.
- 143·148은 미배포 profile27이므로 제자리 수정했다(143 `2beb8a2c…`, 148 `aefbff30…`). Catalog를 두 번 독립 재관측하고 proof v3 stage r6(`74eb9ca2…`, asset `47be9097…`, 416 case)을 다시 컴파일했다.
- 남은 한계: structure census는 trigger 함수가 호출하는 다른 함수는 묶지 않는다. ledger_export의 AWS 자격 증명 구성은 EXT-HOSTING 범위로 남았다.

리뷰 수정 HEAD `5ea51623` gate(첫 시도): static7 exit0, unit 699파일·11643 통과·5 skip. Canonical 3353 통과·21 skip·실패0, cleanup clean.
Identity 두 회차 accepted(general 320/skip11, app-consent 4, ai-settings 1, current-manual 22). result SHA
`4440f9d77ef73c3a0c715ffea1c98c335921beeac04b9f5641d8f2e3590c4edc`.

## 독립 phase 리뷰 r2 (집중) · APPROVE

Codex `gpt-6-sol` high, 읽기 전용, `c7634a5c..7010230b`: r1 13건 모두 FIXED, 새 지적 없음
(`/private/tmp/wm-profile27-phase-review-r2-focused-20261014/review-output.md`). main을 이 phase로 fast-forward한다.
Task graph: M2-05a completed. M2-03a(자막은 profile28 범위)·M2-03b·M2-03c(UI Aside→Chrome→Playwright 검증과 실제 codec 실행 전)·
EXT-RESTOREa(완전 인증 복원 protocol 아님)는 in_progress를 유지한다.
