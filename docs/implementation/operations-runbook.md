# M1 운영 기반 실행 기록

현재 앱의 계획·활동·동의를 대상으로 한 개발/검증 절차다. 운영 서비스 배포나 정기 백업이 구축됐다는 뜻은 아니다.

## 데이터 경계와 API

| 경로                                | 동작                                                           |
| ----------------------------------- | -------------------------------------------------------------- |
| GET `/bff/v1/operations/status`     | 자신의 outbox 집계·최근 audit 10건                             |
| POST `/bff/v1/operations/export`    | body 없는 명시적 export 요청; attachment JSON, no-store        |
| DELETE `/bff/v1/operations/account` | `{ "confirmation": "DELETE MY ACCOUNT" }`; 거래 commit 후 성공 |

계정 ID는 인증에서 결정한다. cookie 요청에는 현재 `x-workout-session-id`가 필요하고 POST/DELETE는
허용 Origin과 `x-csrf-token`도 필요하다. 출력이나 로그에 cookie·token·원본 건강 payload를 기록하지 않는다.
요청 로그는 내부 생성 request ID·method·status와 제한된 오류 코드만 포함한다.
현재 outbox worker가 소비하지 않은 이벤트는 대기로 남으며 provider 정상 상태로 해석하지 않는다.

005 migration과 `grantOperations`를 기존 [OIDC 배포 설정](oidc-setup.md)에 추가했다.
계정 삭제 함수는 고정 search_path의 SECURITY DEFINER이고 runtime 직접 identity 접근이나
계획 immutable trigger 우회를 허용하지 않는다. 기존 migration 파일을 변경하지 않았다.
소유자·superuser·BYPASSRLS 역할을 앱 runtime URL로 사용하면 연결을 거절한다.

## 격리된 복구 drill 실행

```bash
pnpm exec tsx scripts/backup-restore-drill.mts           # 설명만 출력
pnpm exec tsx scripts/backup-restore-drill.mts --execute # 합성 자료, 새 임시 cluster
```

PostgreSQL binaries가 필요하다. 스크립트는 상속된 DB URL을 사용하지 않고 private Unix socket의
새 cluster와 source/restore DB를 생성한다. 별도 시험 runtime role과 합성 계정(삭제·보존 및 동의 철회 검증)을 사용한다.
자신이 생성한 trusted custom dump만 복원한다. 종료 시 cluster·dump·삭제 원장 파일을 정리한다.
검증 보고서는 `research/backup-restore-result.json`에 기록되며 다시 실행하면 교체된다.

복구 시험은 백업 이후 삭제한 계정의 원장을 최신 source에서 별도로 받아 복구 데이터에 적용한다.
삭제 원장을 과거 backup 안의 사본으로 대체하면 삭제된 건강 자료가 되살아날 수 있다.
실서비스 복구는 트래픽을 차단한 상태에서 독립 보관한 최신 삭제 원장을 모두 적용하고,
복원된 세션·로그인 시도를 폐기한 뒤 RLS·삭제·소유권 검증을 완료해야 한다.
원장이 없거나 최신 여부가 불명확하면 서비스 접근을 재개할 근거가 없다.

Garmin OAuth 추가 후에는 백업 안의 모든 Garmin credential·미완료 OAuth 시도를 폐기하고 연결을
재연결 필요 상태로 초기화한다. 백업 이후 해제되거나 회전된 token을 다시 사용하지 않는다.
최신 암호화 cleanup queue 원장도 백업 밖에서 확보해 재적용하고, 오래된 lease는 해제한 뒤 worker가
현재 소유권을 재검사하도록 한다. 이 원장은 token을 포함하는 암호화 자료이므로 일반 로그·보고서에
내용을 노출하지 않는다. 최신 cleanup 원장이 없으면 안전한 철회 재개의 증거가 부족하다.
기존 활동·계획 복구와 Garmin 재연결 상태는 구분한다. [Garmin 설정](garmin-setup.md) 참고.

이 저장소에는 원격 암호화 backup 저장소·별도 삭제 원장 전달 파이프라인·retention/만료 job·재해복구
인프라가 없다. 운영 배포 전 이를 구성하고 실제 RPO/RTO·복구 훈련을 별도로 검증해야 한다.
백업 사본의 삭제는 앱 거래와 즉시 동기화되지 않는다는 점을 계정 화면에 표시한다.

검증 근거: [PostgreSQL pg_dump](https://www.postgresql.org/docs/15/app-pgdump.html),
[pg_restore](https://www.postgresql.org/docs/15/app-pgrestore.html).

## 체크인 저장 이후의 내보내기·복구

M1-04a에서 export artifact `schemaVersion: 2`를 도입했다. 기존 v1 다운로드 파일은 변경하지 않으며
이번 앱은 과거 export를 다시 import하는 기능을 제공하지 않는다. v2는 기존 collection에
`checkIns`와 `checkInRevisions`를 추가한다. 원래 관측 시각·시간대·0/null·정정 이유와 이력을
내보내며 인증 정보·명령 receipt는 제외한다. 레코드 삭제는 건강 payload와 해당 정정 이력을 제거한다.
남는 tombstone의 opaque ID·revision·입력/삭제 시각은 재전송 억제용 메타데이터다.

Migration 007과 `grantCheckIns`를 API runtime에 적용한다. 계정 삭제와 백업 복구의 최신 삭제 원장
재적용 시 `check_in`, `check_in_revision`, `check_in_receipt`, `check_in_collection_head`도 함께
삭제해야 한다. 신규 보고서의 체크인 복구 검사는 실제 임시 DB 검증이며 운영 복구 서비스 배포 증거는 아니다.

## 세션 완료 확인 이후의 내보내기·복구

M1-04ai에서 도입한 export는 `schemaVersion: 3`이며 `sessionCompletions`와
`sessionCompletionRevisions`를 추가한다. 기존 v2 artifact 파서는 계속 지원하지만 이전 파일에
없는 완료 기록을 만들어 넣지 않는다. 완료 확인은 사용자 자기보고이며 실제 활동·이행률이 아니다.
확인/철회·사유·확인 시각·참조한 불변 계획 버전과 일정을 내보내고 명령 receipt는 제외한다.

Migration 010과 `grantSessionCompletions`를 적용한다. 현재 완료 확인 기록은 계획 저장과 같은
사용자 단위 lock으로 직렬화되어 날짜·시각·Block·시간대 변경과 삭제를 차단한다. 정정은
별도의 명시 철회 명령이다. 계정 삭제 및 복구 전 최신 삭제 원장 재적용은 `session_completion`,
`session_completion_revision`, `session_completion_receipt`, `session_completion_collection_head`를
함께 제거한다. runtime에 복구 DB를 열기 전에 기존 복구 절차를 그대로 완료해야 한다.

## 시나리오 이후의 내보내기·복구

M1-04ar의 새 계정 export는 `schemaVersion: 4`이다. `planScenarios`,
`planScenarioRevisions`, `planScenarioApplications`에 대안의 현재 수정본·불변 수정 이력·
현재 계획으로 적용한 출처를 포함한다. 기존 v2/v3 읽기를 유지하고 과거 파일에 시나리오를
만들어 넣지 않는다. 명령 receipt·인증 정보는 내보내지 않는다.

Migration 011과 `grantPlanScenarios`를 적용한다. 시나리오 생성·저장은 현재 계획 head를
변경하지 않는다. 적용 명령은 저장된 시나리오 수정번호·현재 계획 버전·완료 원장 버전을
검사하며 현재 계획 잠금과 완료 일정 보호를 동일하게 적용한다. 분기에서 잠금을 해제해도
현재 계획의 잠금을 우회할 수 없다. 활동 연결은 실제 불변 계획 버전을 계속 참조한다.

Migration 016은 기준 계획 버전별 시나리오 이름을 사용자 입력으로 확장한다. A/B/C는 기존
데이터와 예시 이름으로 계속 허용되지만 슬롯 수는 제한하지 않는다. 같은 기준 버전 안에서만
이름 중복을 거절하며, 다른 기준 버전에서는 같은 이름을 사용할 수 있다.

계정 삭제 및 복구 전 삭제 원장 재적용은 적용 출처 → 수정 이력 → 시나리오 head를
기존 계획보다 먼저 제거한다. 새 테이블에도 tenant RLS를 강제하고 수정·적용 이력은
불변으로 유지한다. 분기 생성·수정·적용의 outbox와 receipt는 각각 같은 거래에 저장한다.

## 상담 사용자 대화 원장 (M1-05b)

Migration 012와 `grantCoachingThreads`를 적용한다. 스레드의 계획 버전·검토 범위·제목과
사용자 메시지는 생성 후 변경하지 않는다. 메시지 추가는 대화 revision을 검사하며 동일 키의
재전송은 최초 결과를 반환한다. 메시지 본문을 outbox나 운영 로그에 기록하지 않는다.

새 export `schemaVersion: 5`는 `coachingThreads`, `coachingMessages`를 포함한다.
v2/v3/v4 다운로드 읽기는 그대로 지원하고 없었던 대화 컬렉션을 합성하지 않는다.
대화도 기존 내보내기의 컬렉션별 1,000행·전체 8MiB 한도에 포함된다. 한도 초과는
`EXPORT_TOO_LARGE`로 실패하며 일부 대화를 누락한 성공 다운로드를 만들지 않는다.
계정 삭제는 메시지→스레드→계획 순서로 제거하고, 삭제 ledger를 복원 DB에 재적용한다.
이 원장은 사용자 메시지만 저장한다. AI 전송·assistant 답변·근거 생성·계획 승인은 후속 기능이다.

## 구조화 근거 snapshot

Migration 013과 `grantCoreEvidenceSnapshots`를 적용한다. `running-core-v1`의 본문과 원장
의존성을 한 시점에 고정하며 새 export v6의 `evidenceSnapshots`에 포함한다. v2~v5 읽기는
유지한다. 기존 전체 export 8MiB/컬렉션 1,000행 제한은 그대로 적용한다.

근거 본문은 생성 후 수정할 수 없지만 원본 활동·체크인 삭제 또는 AI 동의 철회 시 회수한다.
회수된 내용은 API·export·이전 명령 receipt를 통해 다시 제공하지 않는다. receipt에는 ID만
저장하고 outbox에도 건강 본문을 넣지 않는다. 계정 삭제는 근거→상담→계획 순으로 처리한다.

앱 안의 사용자 근거 저장은 외부 AI 전송과 별도다. 전송·후보·승인 통합은 별도로 동의·정책과
전체 의존성의 최신성을 재검사해야 한다. 이 profile만으로 승인 권한을 부여하지 않는다.

백업 이후 회수된 근거도 과거 dump의 본문으로 복구해서는 안 된다. 복원 DB를 runtime에
열기 전에 독립 보관한 최신 근거 회수 원장(`athlete_id`, snapshot ID, 회수 사유)과 AI 동의
현재 상태를 함께 적용한다. 과거 dump 안의 동의·회수 정보로 최신 원장을 대체하지 않는다.
AI 동의 행이 삭제된 경우도 명시적인 부재 상태로 기록하여 복원 DB의 이전 동의 행을 제거한다.
백업 시점의 동의 소유자를 포함한 대상 목록을 검증하고, 원장 항목 누락을 부재로 추정하지 않는다.
회수 원장이 없거나 완전성·최신성을 확인할 수 없으면 근거 제공을 재개하지 않는다.
이 복구 절차의 로컬 합성 검증은 별도 원장 전달·보관 인프라의 운영 배포 완료를 의미하지 않는다.

## 사용자 확인 제약 원장 (M1-05f)

Migration 014와 `grantCoachingConstraints`를 적용한다. 전체 head와 항목 revision을 함께
검사하며 최대 50개 활성 문장을 저장한다. 정정은 현재 본문을 교체하고 삭제는 본문을 NULL로
비운 tombstone을 남긴다. 명령 receipt에는 요청 해시와 결과 메타데이터만 보관하며 outbox도
본문을 복제하지 않는다. 완료 세션 상태나 기간 운동 불가 날짜·가용 시간과는 별도 원장이다.

M1-05f 시점의 export v7에는 `coachingConstraints`, `coachingConstraintHeads`가 추가됐다. v2~v6
다운로드 읽기는 보존하고 과거에 없던 컬렉션을 합성하지 않는다. 기존 내보내기 크기 제한과
계정 삭제 gate가 그대로 적용된다. 과거 running-core-v1 근거에는 포함되지 않는다.
신규 running-core-v2의 강제 포함·삭제 회수는 M1-05g에서 연결한다.

합성 backup drill은 백업과 현재 원장의 소유자를 모두 포함한 최신 제약 상태(head, 활성
문장, 삭제 tombstone)를 단일 snapshot으로 별도 보관해 복원한다. 이 자료도 건강정보이므로
운영 로그나 공개 artifact에 기록하지 않는다. 누락·역행 revision·동일 revision의 본문 변경·
tombstone 부활은 거절한다. 계정 삭제 원장을 먼저 적용한 뒤 runtime 접근 전에 최신 상태로
바뀐 행만 반영한다. 최신 외부 원장 없이 과거 dump의 제약을 현재 제약으로 제공하지 않는다. 로컬
합성 drill은 외부 원장 보관 인프라나 운영 복구 목표가 검증되었다는 의미가 아니다.

## 필수 제약 근거 v2 (M1-05g)

Migration 015는 제약 삭제 시 이를 포함한 근거를 `source_deleted`로 회수한다. 신규 capture는
running-core-v2 본문과 core-ledgers-v2 의존성을 한 SQL snapshot으로 읽는다. 필수 사용자
제약 전체를 포함하며 날짜나 상담 대상에 따라 일부를 제외하지 않는다. 미기록 head와
명시적으로 비운 head를 구분한다. v1 읽기와 과거 명령의 멱등 재전송은 그대로 지원한다.

제약 정정은 기존 근거의 과거 문장을 보존하되 제약 head 비교에서 stale로 판정한다. 삭제는
과거 근거 전체 본문을 제거하고 API·export·이전 capture receipt로도 되돌리지 않는다. v1/v2
의존성 교차 비교는 unsupported이며, v1을 최신 완전 근거로 취급하지 않는다. 현재 schema의
비교는 제한된 원장 revision 비교일 뿐 전체 승인 freshness나 승인 권한이 아니다.

최신 제약 원장 복원은 행 전체 삭제·재삽입 대신 변경된 행만 반영한다. 유지 중인 과거 근거는
보존하고 실제 삭제된 제약의 근거만 회수한다. 검증된 외부 최신 원장에 필요한 revision 건너뛰기는
일치하는 tenant 문맥의 table owner에게만 허용된다. runtime은 계속 한 revision씩만 증가하며
ID/소유권 변경·삭제 tombstone 부활은 허용하지 않는다. 계정 삭제 원장 우선 적용, 완전성·역행
검사, 실패 시 유지보수 transaction rollback은 기존과 같다.

## 코치 실행 기록 (M1-05i2b1)

Migration 017은 tenant별 실행 원장과 별도의 내부 미검증 출력 저장소를 만든다. 계정 삭제는
출력→실행→근거 순서로 제거한다. 근거 삭제·AI 동의 철회는 활성 실행을 취소하고 출력 본문과
종료 상태의 질문·실패 문구를 같은 transaction에서 회수한다. 실행 상태는 승인된 계획이나
검증된 결정의 증거가 아니다.

계정 내보내기 v8은 `coachingRuns`와 `coachingAnalysisOutputs`를 추가한다. 사용자 소유
출력 본문은 현재 근거와 AI 동의가 유효할 때에만 포함한다. 회수 후에는 메타데이터만 내보내고
본문을 NULL로 유지한다. 과거 v2~v7 artifact는 각 당시 컬렉션 그대로 읽으며 누락된 실행
기록을 합성하지 않는다. 크기 제한은 전체 8MiB, 컬렉션별 1,000행으로 유지한다. 멱등
receipt·outbox는 다운로드에 포함하지 않는다.

복원 절차에서는 최신 삭제 원장과 AI 동의 상태를 적용한 뒤 runtime 접근을 열어야 한다.
과거 백업의 미검증 출력이 철회된 동의나 삭제된 근거를 통해 다시 노출되어서는 안 된다.
일반 서버의 실행 생성 경로는 아래의 명시적 비프로덕션 fixture 설정이 없으면 비활성이다.

## 불변 코치 후보 원장 (M1-05j2)

Migration 018과 `grantCoachingCandidates`를 적용한다. 검증된 Decision, Proposal,
Candidate는 각각 `coaching_decision`, `coaching_proposal`, `coaching_candidate`에 저장하며
계획 head를 바꾸거나 사용자의 승인으로 간주하지 않는다. 후보의 본문과 digest는 생성 후
수정할 수 없다. 근거 원본 삭제 또는 AI 동의 철회 시 세 본문과 후보 digest를 같은 거래에서
비우고 회수 사유를 남긴다. 계정 삭제는 후보→제안→결정→실행 순으로 제거한다.

계정 내보내기 v9는 `coachingDecisions`, `coachingProposals`, `coachingCandidates`를 추가한다.
현재 근거와 AI 동의가 유효한 소유자의 본문만 내보내며 회수된 행은 ID·연결·시각·회수 사유
등 메타데이터만 남긴다. 과거 v8 artifact는 원래 모양대로 읽고 없었던 후보 행을 합성하지
않는다. 컬렉션당 1,000행, 전체 8MiB 제한과 receipt·outbox 제외는 유지한다.

합성 복구 drill은 백업 전 저장소 검증용 후보 행을 심고 source export v9 및 과거 v8 파서
호환을 확인한다. 백업 복원 직후에는 철회 전 본문이 실제로 존재함을 확인하고, 최신 외부
근거 회수·AI 동의 원장을 runtime 접근 전에 재생한 뒤 결정·제안·후보 본문과 후보 digest가
모두 사라졌는지 검증한다. 원본 삭제와 계정 삭제도 같은 경로를 검사한다. 이 직접 삽입
fixture는 복구·회수 동작만 검증하며 후보 생성의 freshness·검증·승인 권한 증거는 아니다.
외부 최신 원장의 보관·전달과 운영 복구 목표도 이 로컬 drill의 범위 밖이다.

## 비프로덕션 코치 fixture 실행 (M1-05i2b2b)

Migration 017 적용 후 API 역할에는 `grantCoachingRuns`, 별도의
`workout_coaching_worker` 역할에는 `grantCoachingRunWorker`를 적용한다. 두 역할 모두
schema 사용 권한이 필요하다. worker 역할에는 출력 삽입 권한만 있으며 출력 조회 권한은 없다.
API와 worker는 각각 제한된 별도 DB 자격증명을 사용한다.

개발·테스트에서만 `NODE_ENV`를 `development` 또는 `test`로 두고 `COACHING_FIXTURE_ENABLED=true`,
`COACHING_FIXTURE_ID=synthetic-v1`를 함께 설정한다. API는 이때만 실행 route를 연결하며
프로덕션에서 fixture 활성화를 요청하면 시작을 거부한다. worker는 별도의
`COACHING_WORKER_DATABASE_URL`로 다음 one-shot 명령을 실행한다.
URL의 사용자 이름은 `workout_coaching_worker`여야 하며, Unix socket용 `host` 이외의
query parameter는 자격증명 재정의를 막기 위해 허용하지 않는다.

```bash
pnpm --filter @workout/worker coaching:fixture --athlete-id <athlete-uuid>
```

명령은 해당 tenant의 `coaching.run_queued` 이벤트 하나만 처리한다. 작업이 비어 있으면
다른 tenant를 자동 탐색하지 않는다. lease 만료 후에는 같은 tenant를 다시 dispatch할 수
있고, 여섯 번째 claim은 adapter 호출 없이 내부 오류 상태로 종결한다. 결과 본문을 로그에
기록하지 않는다. API의 출력 조회는 현재 동의·근거·정책·의존성을 다시 확인하며 stale,
회수·취소된 출력은 404로 숨긴다. fixture 분석은 미검증 출력이며 실제 모델이나
Decision/Proposal·계획 승인의 근거가 아니다.
