# 공식 Garmin 연동으로의 전환 설계

작성일: 2026-09-21. 범위: EXT-G / M0-07b / M1-06b 전환 준비.

이 문서는 **비공식 개인용 다운로드 경로**(`workout-manager fetch`, [구현 기록](../progress/garmin-unofficial-fetch.md))와
**공식 Garmin 연동**을 분리해 기록한다. 공식 연동은 구현하지 않았고 이 문서로 구현되지도 않는다.

> **이 문서는 EXT-G, M0-07b, M1-06b의 상태를 바꾸지 않는다.** 세 항목은 `not_started`로 유지한다.
> `docs/implementation/task-graph.json`은 이번 작업에서 수정하지 않았다. 아래 내용은 권한 확보 이전에
> 준비해 둔 설계·확인 목록이며, 실제 파트너 환경 검증의 증거가 아니다.

## 1. EXT-G가 실제로 요구하는 것과 비공식 경로가 충족할 수 없는 이유

`task-graph.json`의 EXT-G 범위는 "외부 조건: 공식 entitlement·파트너 명세·검증 계정"이다.
[Garmin 연결 선행 조건](garmin-prerequisites.md)의 권한 추적표에서 아래 항목은 모두 `미확인`이다.

| EXT-G 요구                          | 비공식 경로의 상태                                       |
| ----------------------------------- | -------------------------------------------------------- |
| 공식 entitlement(Activity / Health) | 없음. 개인 계정 로그인이며 앱에 부여된 권한이 아니다.    |
| 파트너 명세(endpoint·payload·버전)  | 없음. 문서화되지 않은 내부 endpoint를 관찰로 사용한다.   |
| 검증 계정과 평가 환경               | 없음. 사용자 본인 계정 외에 sandbox가 없다.              |
| 정의된 scope와 동의 기록            | 없음. 계정 비밀번호 로그인이므로 scope 개념 자체가 없다. |
| 제3자 사용자 동의                   | 불가능. 타인 계정에 사용할 수 없고 사용해서도 안 된다.   |

구조적으로 다음 네 가지가 빠져 있어 EXT-G를 대체할 수 없다.

- **권한의 주체가 다르다.** 공식 경로는 "앱이 사용자 동의를 받아 접근"하지만 비공식 경로는 "사용자가 자기
  계정에 직접 로그인"한다. 서비스가 다수 사용자 데이터를 수집하는 근거가 되지 못한다.
- **명세가 없다.** 응답 형태·오류 의미·버전 정책이 공개되지 않아 계약 테스트의 기준이 존재하지 않는다.
  Garmin이 endpoint를 바꾸면 사전 고지 없이 깨진다.
- **동의·철회 원장이 없다.** webhook·backfill·삭제 전파 같은 공식 이벤트 경로가 없어, 제품이 이미 구현한
  삭제·동의 철회 전파(4절)를 공급자 측과 맞물리게 할 수 없다.
- **운영 정당성이 없다.** 비공식 경로는 Garmin 약관 위반 가능성과 계정 조치를 전제로 하고, 라이브러리 소스에
  하드코딩된 Garmin 자체 앱 client 식별자(`GCM_ANDROID_DARK`, `GCM_IOS_DARK`, `GarminConnect`)와
  `curl_cffi`의 `impersonate="chrome"` TLS 지문 위조로 봇 차단을 통과한다.
  제품 기능으로 출시할 수 없고, 개인이 자기 데이터를 내려받는 용도로만 남는다.

따라서 `workout-manager fetch`는 M0-07a 로컬 FIT batch의 **입력을 사람이 직접 만드는 수단**일 뿐이며,
[FUT-04](../../.pre/06_follow_up_backlog.md)가 금지한 대로 파일 가져오기나 mock을 자동 동기화로 표시하지 않는다.

## 2. 이음새: 공식 adapter가 교체할 지점

비공식 경로는 **공급자 접근 표면을 좁은 인터페이스 하나**로 모았다(보안 경계가 아니라 교체 지점이다).

```
CLI(fetch) → login_read_only_source() → ReadOnlyActivitySource ┐
                                                                ├→ select_activities()
                                                                ├→ extract_original_fit()
                                                                ├→ write_fit() / manifest
                                                                ┘
```

`src/workout_manager/garmin_fetch.py`의 `ReadOnlyActivitySource` Protocol은 정확히 두 개의 읽기 연산만 갖는다.

| 이름                             | 계약                                           |
| -------------------------------- | ---------------------------------------------- |
| `list_activities(start, limit)`  | 최신순 활동 요약 목록 한 페이지                |
| `download_original(activity_id)` | 해당 활동의 ORIGINAL 파일 바이트(zip 또는 FIT) |

**공식 adapter가 교체할 것은 이 Protocol의 구현체뿐이다.**

- 교체 대상: `GarminReadOnlySource`와 private provider 레지스트리(`read_only_source()`,
  `read_only_session()`, `_read_activities()`, `_read_original()`),
  `login_read_only_source()` / `login_read_only_session()`,
  `harden_session()` / `harden_client()` / `harden_token_exchange()` /
  `reharden_after_login()`의 transport 정책과 그 적용 범위(`COVERAGE_NOTE`),
  `install_provider_log_scrubber()`의 라이브러리 로그 필터,
  `_perform_login()`의 자격 증명 격리, `read_credentials()` / `prepare_token_store()` /
  `reject_symlinked_chain()` / `reserve_token_file()` / `verify_token_permissions()`.
  공식 경로에서는 이 자리에 `packages/server/integrations/garmin`의 OAuth 2.0 PKCE adapter와
  [M1-06c](../progress/M1-06c.md)가 이미 구현한 암호화 token 저장·회전·철회가 들어간다.
  비공식 경로의 계정 비밀번호·MFA·token 캐시 처리는 공식 경로로 넘어가지 않는다.
- 그대로 유지되는 것: `select_activities()`의 경계 검사와 untrusted 응답 검증(`parse_summary`),
  `extract_original_fit()`의 zip 구조 검증과 `fit_batch.validate_fit_bytes()`의 FIT CRC 검증,
  `write_fit()`의 원자적 저장과 SHA-256, `download-manifest.json` 재개 manifest, 요청 간 최소 간격,
  항목별 실패 격리, `provider_failure()`/`redact()` 오류 경계.
  그 뒤의 `workout-manager convert`와 `export-activity`, 제품의 canonical activity 적재는 전혀 바뀌지 않는다.

교체 시 달라질 값도 미리 명시한다. 비공식 manifest는 `provider: "garmin-connect-unofficial"`,
`official: false`, `activity_id`는 Garmin Connect 내부 활동 ID다. 공식 경로에서는 파트너가 정의한
`summaryId`/`activityId`와 그 안정성 보증이 de-duplication 키의 근거가 되어야 하며(3절), 두 경로의 산출물을
같은 원장에 섞지 않는다.

**추가(2026-09-25, M1-06b-tmp).** 사용자 결정으로 생긴 앱 내 임시 수집은 server 쪽 이음새를 하나 더 둔다.
`@workout/server-integrations/garmin-collection`의 `GarminActivityCollector` interface와 provider 중립 runner다.
임시 수집(`garmin-connect-unofficial`)과 공식 adapter(`garmin-official`)는 같은 interface를 구현하고, runner가 lease·
암호화 credential CAS·기존 import 경로·삭제 억제·실패 정책을 공통으로 맡는다. 중복 판정은
`garmin_activity_ledger`(Garmin 활동 ID 기준, 행마다 provider와 `official`을 기록)로 한다. 출처는 행 단위로
구분되므로 위 문장의 "섞지 않는다"(CLI manifest)와 충돌하지 않는다. 공식 활동 ID가 Garmin Connect 활동 ID와 같은지는
3절 "활동 identity" 항목으로 재확인하기 전까지 가정이다. 교체·제거 절차는
[Garmin 설정](../garmin-setup.md#비공식-임시-수집-m1-06b-tmp)에 있다.

## 3. 권한 확보 후 실제 파트너 환경에서 재확인할 항목

[M1-06c](../progress/M1-06c.md)는 "검증 공급자는 로컬 HTTP 합성 fixture다… token 만료 필드·permissions
payload 등은 실제 파트너 환경에서 재확인해야 한다"고 이미 기록했다. 아래는 그 재확인 목록을 구현 단위로 펼친 것이다.
각 항목은 승인된 문서 또는 실제 응답으로 확인하기 전까지 `미확인`으로 남긴다.

| 확인 항목                  | 재확인해야 하는 내용                                                                                                                                                                    | 관련   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| scope·permissions payload  | 오늘 앱은 `scope`를 보내지 않고 연결 후 `/user/permissions` 응답을 읽는다. 실제 entitlement에서 반환되는 권한 문자열 집합, `ACTIVITY_EXPORT` 외 필요한 권한, 부분 승인 표현을 확인한다. | M1-06c |
| token 만료·refresh 의미    | `expires_in`/`refresh_token_expires_in`의 실제 존재 여부와 단위, 회전 시 이전 token 무효화 시점, 동시 refresh 충돌 동작. 현재 lease/CAS 가정이 유효한지 확인한다.                       | M1-06c |
| rate limit·Retry-After     | 실제 quota 단위(분/일/계정/앱), 초과 시 상태 코드와 `Retry-After` 형식(초/HTTP-date), backfill 전용 quota, 영구·일시 실패 구분.                                                         | M1-06b |
| 활동 identity·중복 제거 키 | 파트너 payload의 활동 식별자가 재전송·수정·재업로드에서 안정적인지, 기존 `(athlete_id, kind, source_id)` 키에 무엇을 매핑할지, `contentHash`·revision 단조성이 유지되는지.              | M1-06b |
| webhook vs polling         | push/ping 어느 쪽이 허용되는지, 이벤트 서명·재전송·순서 보장·중복 식별, polling만 가능한 경우의 주기와 backfill 기간·quota.                                                             | M1-06b |
| 삭제·동의 철회 전파        | 사용자가 Garmin 측에서 활동을 지우거나 연결을 해제했을 때 제품이 받는 이벤트, 지연, 재수집 금지 방법. 제품의 deletion suppression과 어떻게 맞물리는지.                                  | M1-06b |
| 파일 URL·크기·형식         | 허용된 파일 origin/redirect/유효기간, ORIGINAL이 zip인지 FIT인지, 최대 크기와 content hash 제공 여부.                                                                                   | M0-07b |
| 측정 가능 지표 범위        | Activity/Health별로 실제 받을 수 있는 지표. Garmin 화면에 보인다는 이유로 capability에 표시하지 않는다.                                                                                 | EXT-G  |

공개 소개 자료만 보고 endpoint·signature·payload를 확정하지 않는다. 비공식 경로에서 관찰한 동작은
파트너 환경의 근거가 아니며, 이 문서의 어떤 항목도 비공식 실행 결과로 `확인`으로 바꾸지 않는다.

## 4. 파트너 신청 자료용: 이 제품이 실제로 처리하는 데이터

아래는 저장소 코드에서 확인한 현재 동작이다. 계획이나 희망이 아니라 구현된 사실만 적는다.

### 4.1 활동 데이터 범위와 정밀 GPS

- 활동 계약(`packages/contracts/src/activity.ts`)은 `strictObject`이며 필드는
  `title, kind, startedAt, durationSeconds, durationKind, timezone, distanceMeters`뿐이다.
  좌표 필드가 존재하지 않고 알 수 없는 키는 거부된다.
- 상세 계약(`packages/contracts/src/activity-details.ts`)의 record는 `{index, timestamp, distanceMeters, heartRateBpm}`,
  lap은 시간·거리·심박이다. **위도·경도는 어느 계층에도 저장되지 않는다.**
- FIT 추출기(`src/workout_manager/activity_export.py`)는 `position_lat`/`position_long`을 읽지 않는다.
  모듈 docstring이 "No network access, inferred start time, GPS export, or synthetic parent activity"이며,
  timezone도 GPS로 추정하지 않고 사용자가 명시한 값만 쓴다.
- UI는 없는 것을 없다고 표시한다(`packages/modules/activities/src/activity-detail-tabs.tsx`:
  "현재 상세 형식에서 경로 데이터를 제공하지 않습니다"). 마스킹된 좌표가 있다는 뜻이 아니다.
- 로그에는 요청 URL·본문·헤더·공급자 오류 원문이 남지 않는다(`apps/api/src/app.ts`의
  `disableRequestLogging`과 req/res/err serializer). 비공식 fetch도 token·cookie·비밀번호·계정 메일을
  로그에 남기지 않고 오류 문자열을 redact한다.

공식 연동에서 GPS를 받게 된다면 저장 계약·로그 redaction·export 범위를 먼저 확장해야 하며,
현재 상태를 근거로 "GPS를 안전하게 처리 중"이라고 신청서에 쓰지 않는다.

### 4.2 보존

- 건강·활동 데이터에 달력 기준 자동 삭제 기한은 없다. 사용자가 삭제하거나 계정을 말소할 때까지 유지된다.
- 운영 데이터에는 명시적 만료가 있다: OAuth attempt 10분, Garmin 철회 큐 24시간
  (`packages/server/persistence/migrations/006_garmin.sql`), 업로드 intent 24시간과 terminal 이력 7일
  (`031_gallery_media.sql`), retrieval 캐시 TTL 600초와 실제 회수
  (`packages/server/persistence/src/resource-derived-cleanup.ts`).
- 원격 암호화 backup 저장소·retention job·재해복구 인프라는 이 저장소에 없다
  (`docs/implementation/operations-runbook.md`). 신청 자료에 운영 인프라를 있다고 쓰지 않는다.

### 4.3 삭제와 동의 철회 전파

- 활동 삭제는 한 transaction 안에서 `activity_suppression`에 source 키를 남기고 canonical을
  `deleted`로 표시하며 outbox 이벤트를 넣는다. 이후 같은 source를 다시 가져오면 `suppressed`로 끝나고
  아무것도 쓰지 않는다(`packages/server/persistence/src/activities.ts`). **backfill로 부활하지 않는다.**
- 파생물은 DB trigger로 같은 transaction에서 지워진다. 활동 삭제나 AI 동의 철회는 evidence snapshot 본문을
  NULL로 만들고(`013_evidence_snapshots.sql`), 그 연쇄로 코칭 분석 출력·candidate·proposal·decision 본문이
  purge되며 run은 취소된다(`017_coaching_runs.sql`, `018_coaching_candidates.sql`).
  읽기 경로는 이를 `withdrawn`으로 정직하게 표시한다.
- 자료(RAG) 쪽은 `derivedData / searchIndex / cache / citations` 네 대상을 모두 참으로 갖는 내구 정리 큐를
  사용하고, 검색 권한은 색인·캐시가 아니라 매 조회의 권한 join으로 결정한다
  (`resource-derived-cleanup.ts`, `resource-retrieval.ts`). 철회된 인용은 재조회에서 다시 노출되지 않는다.
- 계정 말소 `erase_account`는 Garmin 연결 해제·연결 행 삭제, evidence snapshot 삭제, 미디어 바이트 삭제
  큐잉, 활동 canonical/source/overlay/suppression 삭제를 한 transaction으로 수행한다.
- Garmin 연결 해제는 최소 권한 worker role과 내구 큐로 공급자 측 등록 철회를 시도하며, 소유권을 확인하기
  전에는 원격 삭제하지 않는다(M1-06c).

공식 연동에서는 여기에 **공급자 측 삭제 이벤트 수신**과 **동의 철회 시 backfill 중단**을 추가로 맞물려야 한다
(3절의 재확인 항목).

### 4.4 코칭에서의 사용 방식

- 흐름은 `EvidenceSnapshot → Run → 분석 출력(untrusted) → Decision → Proposal → Candidate → 사용자 명시 승인`이다.
- snapshot은 한 SQL 문으로 대화·계획·활동(최대 500건, 로컬 날짜 창 기준)·체크인을 고정하고 의존성 manifest를
  함께 저장해 drift를 감지한다(`packages/server/persistence/src/evidence-snapshots.ts`).
- 모델 출력은 저장되더라도 승인 권한이 없다. 계약 주석이 명시한다: "A stored model output is not a validated
  Decision and cannot be approved." candidate는 "neither a clinical conclusion nor approval authority"다.
- 기기 관측·앱 계산·사용자 자가보고·AI 추정은 서로 다른 테이블과 라벨로 분리된다.
  앱 계산 지표는 `definitionVersion`을 갖고 측정값이 아님을 명시하며, 자가보고는 `source: 'user'`,
  `method: 'self_report'`로 기록된다.
- 검색된 자료 본문은 untrusted 데이터로 다루며 그 안의 지시문을 명령으로 실행하지 않는다
  (`packages/server/coaching/src/runner.ts`).

### 4.5 출처 분리와 중복 제거

- `activity_canonical`(정본) / `activity_source_head`·`activity_source_revision`(출처 원본과 개정) /
  `activity_overlay`(사용자 보정)를 분리한다(`004_activities.sql`). 사용자 보정은 공급자로 되돌려 쓰지 않는다.
- 중복 제거 키는 `(athlete_id, kind, source_id)`이며 `contentHash`와 source revision 단조성,
  명령 수준 `idempotencyKey`(`activity_import_receipt`)로 보강한다. 가져오기 결과는
  `imported | unchanged | stale | suppressed`로 구분된다.
- FIT 출처의 `sourceId`는 내용 해시 기반(`sha256:<digest>:session:<index>`)이다. 공식 provider가 추가되면
  `kind`와 식별자 매핑을 새로 정의해야 하며, 같은 활동을 FIT 파일과 공식 수집으로 이중 계상하지 않도록
  3절의 "활동 identity" 항목을 먼저 확정한다.

### 4.6 현재 Garmin 연결 계층의 사실

- 앱은 authorize 요청에 `scope`를 넣지 않고, 연결 후 `/user/id`와 `/user/permissions`로 실제 권한을 읽는다
  (`packages/server/identity/src/garmin-provider.ts`, `docs/implementation/garmin-oauth.md`).
  현재 관측·기대 문자열은 `ACTIVITY_EXPORT` 하나이며 로컬 합성 fixture로만 검증했다.
- token은 AES-256-GCM으로 암호화하고 provider·key id·계정·용도를 AAD에 묶는다. 브라우저·export·일반 outbox에
  token을 넣지 않는다.
- 이 연결 계층은 **연결·해제·철회까지**이며 자동 수집은 구현되어 있지 않다. 공식 client 발급이나 실제 계정
  검증의 증거도 아니다.

## 5. 전환 순서

1. EXT-G: 신청·심사·entitlement·검증 계정 확보. 증빙 참조만 기록하고 계약 원문·credential은 넣지 않는다.
2. 3절 표를 실제 파트너 응답으로 채우고, 동의받은 비식별 fixture를 확보한다(M1-06b 선행).
3. M1-06b: `ReadOnlyActivitySource` 자리에 공식 adapter를 구현한다. 2절의 "유지되는 것"은 재작성하지 않는다.
4. M0-07b: 공식 경로의 다운로드·manifest·재개를 별도로 완료한다. 비공식 manifest와 원장을 섞지 않는다.
5. 공식 경로가 검증된 뒤 `workout-manager fetch`의 존치 여부를 사용자가 결정한다. 자동 제거하지 않는다.

전환이 끝나기 전까지 EXT-G·M0-07b·M1-06b는 `not_started`이며, 비공식 경로의 실행 결과는 그 어떤 항목의
완료 증거로도 사용하지 않는다.
