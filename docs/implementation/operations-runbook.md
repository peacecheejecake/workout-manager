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

### 활동 삭제 원장 재적용과 객체 purge (M2-01y)

백업 이후 삭제된 활동은 최신 활동 삭제 원장(활동 id, 삭제 시 activity revision, source kind·source id,
source head의 source revision·content hash)으로 재적용한다. **재적용은 runtime 접근을 열기 전에만 한다.**
원장 재생의 SQL은 repository와 달리 앞에서 command lock을 잡지 않으므로, 라이브 writer와 겹치면
`40P01`이 날 수 있다(M2-01y 스트레스 시험에서 관측). 재적용은 RLS를 우회하는 복원 관리자 role로 한다.
다른 tenant의 활동 id·말소 기록·identity 계정을 확인하는 검사는 그 role에서만 다른 tenant 행을 볼 수 있다
(우회하지 않는 role이면 purge 행 쓰기에서 실패하므로 여전히 fail closed다). dump 뒤에 생긴 계정의 항목은
`ACTIVITY_REPLAY_TENANT_UNKNOWN`으로 복원 전체를 막으므로, 계정 원장을 먼저 재적용한다.
항목마다 그 tenant 세션(`app.athlete_id`)으로:

1. 말소된 tenant의 항목은 말소 재생이 이미 만족시킨다(계수만 한다).
2. 복원 cluster에 활동 행이 **있으면** suppression 행을 넣고 묘비 UPDATE(`deleted=true`, 원장 revision,
   복원 행이 원장보다 앞서 있으면 fail closed)를 한다. 묘비 trigger가 활동 디렉터리와, 그 삭제가 회수한
   코스마다 코스 디렉터리의 객체 purge를 무장한다.
3. 복원 cluster에 활동 행이 **없으면**(dump 뒤 생성·원장 전 삭제)
   `SELECT public.replay_absent_activity_deletion(tenant, activity, kind, source_id, source_revision, revision, content_hash)`
   를 부른다. 활동 값이 없는 삭제된 canonical 행, source head, suppression 행을 되살리고 purge를 무장한다.
   그래서 복원 뒤 기기 재동기화가 같은 source를 보내도 `suppressed`로 거절되고 새 활동이 생기지 않는다.
   세션 불일치, 형식이 틀린 항목, 비-canonical id, 말소되었거나 identity 계정이 없는 tenant, 복원 cluster가
   이미 가진 활동 id(자기 것이든 다른 tenant 것이든), 다른 활동으로 이미 알려진 source는 모두 **예외로 재적용
   전체를 rollback**한다. 조용히 건너뛰는 경로는 없다. 원장에 source revision·content hash가 없으면 이 항목을
   재적용할 수 없으므로 복원을 재개하지 않는다.

운영 순서: migrate 046 → `grantResourceObjectCleanupWorker` 재실행 → 새 cleanup worker 배포. worker는 매
run에서 말소 tenant purge 뒤에 활동·코스 purge를 최대 20건 차례로 lease해 그 디렉터리만 walk하고 guarded delete로
지운다. grant 전에는 그 호출이 `42501`/`42883`으로 실패해 같은 run의 뒤 단계도 돌지 않는다. 046은
rename이 없어 `grantOperations`를 다시 돌릴 필요는 없다.

처리량: worker는 한 번 호출에 활동·코스 purge를 최대 20건(`OBJECT_SCOPE_PURGE_RUNS_PER_INVOCATION`) 차례로
돌린다. run마다 자기 lease·삭제 예산(200)·첫 오류 중단을 따르고, 실패·lease 유실·빈 queue에서 멈춘다. 1분마다
부르면 시간당 1,200 scope다. **046은 적용 시점의 삭제된 활동 전부와 unavailable 코스 전부를 무장**하므로, 그 수를
1,200으로 나눈 시간만큼 backfill이 걸린다. 멈춘 작업은 `object_scope_purge`에서
`last_error_code LIKE 'DEAD_LETTER:%' OR last_error_code LIKE 'INCONSISTENT_LEDGER:%'`로 찾는다.
`INCONSISTENT_LEDGER:ACTIVITY_LIVE`·`INCONSISTENT_LEDGER:COURSE_AVAILABLE`은 살아 있는 소유자에게 purge가 무장된,
시스템이 만들지 않는 원장 상태다. 재시도로 고쳐지지 않으므로 사람이 조사한다. 자세한 근거는
[M2-01y 기록](progress/M2-01y.md).

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
회수·취소된 출력은 404로 숨긴다. fixture 분석 자체는 미검증 출력이며 별도 서버
검증 전에는 Decision/Proposal이 아니다. 계획 승인은 후속 명시 transaction에 남는다.

## 비프로덕션 구조화 후보 검증 (M1-05j3a)

Migration 018 뒤 API runtime 역할에 `grantCoachingCandidates`도 적용한다. 위의
비프로덕션 fixture 설정이 활성일 때만 `POST /bff/v1/coaching-runs/:runId/candidates`,
`GET /bff/v1/coaching-runs/:runId/candidates`, `GET /bff/v1/coaching-candidates/:candidateId`를
연결한다. POST는 본문을 받지 않고 `idempotency-key`를 요구한다. 클라이언트가 임의 계획
초안이나 전략을 후보로 제출하는 API는 없다.

Fixture worker는 정확한 시간이 있는 첫 세션에 한해 300초 변경 의도를 구조화 출력으로
남긴다. 서버는 이 출력을 여전히 미검증 입력으로 취급하고, 소유한 실행·고정 근거·현재
원장 의존성·동의·정책·계획·완료 보고와 출력 형식을 다시 확인한 뒤 변경 한 건만
PlanDraft에 반영해 순수 diff/validation을 실행한다. 성공 시 불변 후보와 서버 digest를
저장하지만 계획 head는 바꾸지 않는다. 현재 구조화 형식이 아닌 과거 요약 출력은
후보 생성에서 거절한다. 이 fixture 경로는 실제 코치 모델의 품질이나 계획 승인 증거가 아니다.

M1b-03의 공동 훈련·영양 fixture는 같은 비프로덕션 설정에서만
`POST /bff/v1/joint-fixture-candidates`를 등록한다. 이 endpoint는 상담 ID·영양
계획 ID·대화 revision·근거 기간만 받는다. 서버가 v3 실행과 미검증 출력을 만든
뒤 공동 후보를 검증하며, 브라우저가 제안 계획을 제출할 수 없다. 이 경로는 API
역할이 fixture 출력을 삽입하므로 **fixture 전용 개발·시험 DB 역할에만** 다음
추가 권한이 필요하다. 격리 identity E2E harness는 이를 자동으로 부여한다.

```sql
GRANT INSERT ON coaching_analysis_output TO workout_runtime;
```

일반 `grantCoachingRuns`와 프로덕션 API 역할에는 이 권한을 추가하지 않는다.
비프로덕션 역할에 권한이 없으면 후보 생성은 500으로 실패한다. v3 후보는 별도
`/joint-proposals/:candidateId` 화면에서 검토하고, 승인 시 현재 계획·섭취·보강
개정을 재검사한 뒤 훈련·영양 계획을 한 트랜잭션에 적용한다. fixture 변경은 실제
모델의 판단이나 의학적·영양학적 타당성을 검증하지 않는다.

## 부분 후보와 최신성 조회 (M1-05j3b)

`POST /bff/v1/coaching-candidates/:candidateId/partials`는 기존 후보 diff의 세션 ID,
기간 ID, 제목 변경 여부만 선택한다. `schemaVersion: 1`, `sessionIds`, `periodIds`,
`includeTitle`을 본문에 넣고 `idempotency-key` 헤더를 전달한다. 최소 한 항목을 선택해야
하며 원본 후보에 없는 변경 ID는 거절한다. 서버는 현재 근거·계획·완료 보고를 잠금 아래
다시 확인하고 선택 항목만 투영·검증한다. 결과는 원본과 같은 Decision 아래 별도
Proposal/Candidate로 저장하며 `parentCandidateId`로 계보를 표시한다. 이 요청도 계획
head를 변경하지 않는다. 같은 키의 재시도는 같은 후보를 반환하고 다른 선택으로 키를
재사용하면 충돌한다.
실행 하나의 후보 수는 원본을 포함해 최대 100개다. 한도 이후 새 부분 요청은 충돌로
거절하고, 이미 성공한 키의 재시도는 기존 후보를 반환한다.

`GET /bff/v1/coaching-candidates/:candidateId/status`는 소유자에게만 `current`,
`stale`, `withdrawn` 중 하나와 후보 ID를 반환한다. 이 응답에는 계획·근거·후보 본문이
없다. 계획이나 근거가 바뀐 후보와 철회된 후보는 상세 조회·부분 요청에서 본문을
반환하지 않는다. 이 상태는 승인 권한이 아니며, 명시 승인 transaction은 M1-05k다.

## 훈련 후보 명시 승인 (M1-05k)

`POST /bff/v1/coaching-candidates/:candidateId/approve`는
`{ "schemaVersion": 1, "expectedDigest": "…", "confirmed": true }` 본문과
`idempotency-key` 헤더를 요구한다. 사용자가 방금 검토한 서버 후보의 digest와 명시 확인을
함께 보낸다. 클라이언트 계획 초안은 허용하지 않는다. 서버는 현재 소유권·근거·동의·정책·
원장 의존성·계획 버전·잠금·완료 보고·후보 무결성과 검증 결과를 거래 안에서 다시 확인한다.
통과 시 새 PlanVersion, `candidate_approved` 계획 이력, outbox, 해시 기반 멱등
receipt를 원자적으로 기록한다. 성공 키 재시도는 원래 버전을 반환하며 다른 키의
오래된 승인은 충돌한다. fixture 후보 생성 API와 그 승인 호출은 현재 비프로덕션
fixture 설정에서만 연결된다. 실제 모델의 후보 품질이나 프로덕션 배포 승인을 이
경로의 테스트만으로 확정하지 않는다.

## 코치 실행·후보 검토 화면 (M1-05l)

S10 `/coach`에서 상담과 저장된 근거를 선택한 뒤 사용자 대화 전체가 로드되면
`선택한 근거로 실행`을 요청할 수 있다. 실행 이력과 사용자용 진행 단계는 서버에
저장된 상태를 보여준다. 현재 후보 검증 버튼은 결정론적 비프로덕션 fixture
실행에서만 나타나며, 실행 또는 후보 검증은 계획을 변경하지 않는다.

S11 `/proposals/:candidateId`는 두 웹 shell에서 원안·제안과 검증 결과를 보여준다.
부분 변경 선택은 새 자식 후보를 요청한다. 적용하려면 체크박스로 검토를 명시하고
`확인하고 계획에 적용`을 눌러야 한다. 화면은 승인 직전 상태·계획 head를 다시
확인하고, 서버가 반환한 버전과 다시 조회한 현재 계획을 표시한다. stale·철회된
후보는 본문과 승인 버튼을 표시하지 않는다. 요청 결과를 확인할 수 없는 경우
`같은 요청으로 결과 재확인`은 원래 멱등 키를 재사용한다. `적용하지 않기`는 코치
화면으로 돌아가는 동작이며 서버에 거절 결정을 저장하지 않는다. 승인 성공 후
`저장된 계획 보기`는 각 shell의 `/planner`에서 서버의 새 버전을 조회한다.

실제 OIDC·격리 PostgreSQL fixture에서 두 shell의 흐름은
`pnpm exec playwright test --config playwright.identity.config.ts tests/identity/coaching-runs.spec.ts`
로 검증한다. 이 harness는 3100(Next), 4200(mobile-web), 4300(API),
4400(OIDC), 4500(Garmin fixture)을 사용하고 종료 시 임시 DB를 제거한다.

## Private resource object storage와 삭제 worker (M2-04b)

Migration 028과 `grantResources`를 적용한다. API에는 전용 absolute non-root
`PRIVATE_RESOURCE_STORAGE_ROOT`를 설정하고, API 프로세스와 cleanup worker가 같은 private
volume을 사용하도록 mount한다. 로컬 adapter는 root와 directory를 `0700`, object를 `0600`으로
유지하며 symlink·경로 이탈을 거절한다. PDF는 10 MiB, Markdown은 1 MiB까지 허용하고
확장자·MIME, PDF signature, Markdown UTF-8/제어문자를 streaming으로 검증한다.

업로드는 intent 예약, raw byte 저장, finalize의 세 단계다. finalize 전 성공은 검색·파싱 완료가
아니다. object key와 credential은 브라우저 응답과 계정 export(현재 v17)에 포함하지 않는다. DB dump와
object snapshot은 같은 쓰기 정지 구간에서 함께 생성하고 함께 복원해야 한다. 합성 drill은 local
object archive와 PostgreSQL metadata를 함께 복원해 SHA-256 descriptor와 exact bytes를 확인한다.
원격 object provider, 암호화 remote backup, 운영 RPO/RTO는 별도 검증 대상이다.

Soft delete, 실패한 staged upload, 계정 말소는 `resource_object_cleanup`에 durable manifest를 남긴다.
별도 `workout_resource_cleanup_worker` 역할을 만들고 `grantResourceObjectCleanupWorker`만 적용한다.
이 역할에는 table 권한을 주지 않는다. worker에는 API DB URL과 분리된
`RESOURCE_CLEANUP_DATABASE_URL`, API와 같은 `RESOURCE_STORAGE_ROOT`를 설정한다.

```bash
pnpm --filter @workout/worker resources:cleanup
```

명령은 한 번에 한 object만 lease하고 성공, 재시도 예약, lease 유실, 빈 queue를 JSON 결과로
반환한다. 오류 로그는 generic code만 남긴다. scheduler는 이 one-shot 명령을 반복 실행할 수 있다.
각 intent는 upload-scoped final key와 deterministic temporary key를 사용한다. API는 final publish 전에
두 key와 descriptor를 `prepared` 상태로 기록한다. 30분 동안 finalize되지 않은 intent는 worker가 최대
100건씩 실패 처리해 temp/final key를 queue에 넣는다. worker는 lease 뒤 live version과 active intent가
없다는 DB authorization을 다시 받은 exact key만 삭제한다. prepare/finalize가 먼저 reference를 보호하면
queue를 안전하게 완료하고, delete authorization이 먼저면 prepare/finalize를 거절해 외부 삭제와 경쟁하지
않는다. expiry·lease·authorization·finish는 호출자가 보낸 절대 시각이 아니라 DB 시각으로 판정한다.
tenant별 active intent는 20개, prepared/staged raw bytes는 50 MiB, active+failed history는 100개로
제한한다. cleanup이 끝난 failed intent는 7일, 완료 cleanup 기록은 30일 뒤 worker가 각각 최대 100건씩
정리하며 finalized idempotency receipt는 유지한다. 삭제가 100회 실패한 항목은 완료 처리하지 않고
`attempts=100`, `completed_at=NULL`, `last_error_code=DEAD_LETTER:*`인 운영 개입 상태로 격리한다.
worker는 이 항목을 다시 lease하지 않아 뒤 queue를 계속 처리한다. 운영자는 해당 행과 object provider를
조사하고 삭제를 실제로 확인한 뒤에만 복구 절차로 상태를 변경해야 한다.

### 말소 tenant prefix purge의 멈춘 행 (M2-01x, M2-01z)

계정 말소는 `tenant_object_purge`에 그 tenant의 `private/v1/tenants/<id>/` purge를 무장하고, 같은
cleanup worker가 30일 동안 매시간 prefix를 walk해 지운다. worker 역할은 이 표를 읽을 수 없으므로 운영자는
관리자 연결로 아래 한 질의로 멈춘 행을 찾는다.

```sql
SELECT athlete_id, attempts, passes, last_error_code, available_at, last_pass_at
FROM tenant_object_purge
WHERE completed_at IS NULL
  AND (last_error_code LIKE 'INCONSISTENT_LEDGER:%' OR last_error_code LIKE 'DEAD_LETTER:%');
```

- `INCONSISTENT_LEDGER:IDENTITY_ACCOUNT_PRESENT`: 말소 원장에 있는 id에 identity account가 남아 있다.
  lease가 이 행을 **거절**하고(attempt 미차감, 삭제 0) 표식만 남긴다. 재시도로 풀리지 않는다. 그 id가 정말
  말소된 사용자인지(원장·복원 순서) 조사한다. 계정이 살아 있어야 하는 사용자라면 purge 행과 원장이 잘못된
  것이고, prefix 아래 객체는 **절대 수동 삭제하지 않는다**. 계정이 지워진 뒤에는 다음 lease가 이 행을 받지만
  표식은 그 run이 끝날 때(성공이면 NULL, 실패면 그 code)까지 남으므로, 진행 중인 행이 한 run 동안 이 조회에
  보일 수 있다.
- `LEASE_EXPIRED`: 직전 시도가 2분 lease 안에 끝나지 못했다. 재시도는 계속된다(정보용).
- `DEAD_LETTER:LEASE_EXPIRED`: 100번째 시도까지 lease를 잃었다. `DEAD_LETTER:<code>`: 100번째 시도가 그
  code로 실패했다. 둘 다 다시 lease되지 않는다. 원인(저장소 속도·루트·권한)을 고친 뒤 그 tenant의 말소를
  재생(`erase_account`)하면 attempts 0으로 다시 무장된다. `attempts=100`인데 표식이 없는 상태는
  CHECK(`tenant_object_purge_dead_letter_labelled`)가 막는다.

처리량: worker 1회 실행은 purge를 최대 10회(`TENANT_OBJECT_PURGE_RUNS_PER_INVOCATION`) 차례로 lease하며
각 run은 삭제 200개 예산과 첫 오류 중단을 그대로 가진다. 실패·lease 유실·빈 queue에서 그 실행의 purge를
멈춘다. 말소 tenant 하나는 30일 동안 매시간 1 pass(720 pass)가 필요하므로, scheduler를 분당 1회 돌리면
30일 창 안의 말소 tenant 약 600명(하루 약 20건 말소)까지 매시간 주기를 지킨다. 5분 주기면 약 120명이다. 넘치면
due 행이 `available_at` 순으로 기다릴 뿐 빠지지 않고, 주기만 늘어난다. 복원 재생은 원장의 모든 tenant를 한꺼번에
다시 무장하므로 복원 직후에는 이 한도로 소진 시간을 계산한다. 이 수치는 실패가 없다고 가정한다. 특정 tenant에서
반복 실패하는 purge(예: 그 tenant 디렉터리 안의 link로 `UNSAFE_STORAGE_PATH`)가 due일 때마다 그 실행의 batch가
1회로 끊기므로, 그런 행이 dead letter가 될 때까지 처리량이 044 수준(시간당 60)으로 내려갈 수 있다. 실행 1회의
시간은 벽시계로 묶여 있지 않다. run마다 2분 lease 안에 끝나야 하므로 느린 저장소에서는 최대 약 20분까지 늘어나
뒤이은 derived 정리·스윕·housekeeping을 미룬다.

raw PUT의 `UPLOAD_RESUME_REQUIRED`는 같은 upload ID와 동일 파일로 재전송한다.
`UPLOAD_RETRY_REQUIRED` 또는 terminal failed reservation은 새 idempotency key로 intent부터 다시 만든다.
두 경우 모두 파일 선택은 local React state에만 유지하며 storage ref는 브라우저 응답에 포함하지 않는다.

## Private HTTPS URL ingestion worker (M2-04c)

Migration 029와 `grantResources`를 적용한다. 별도 `workout_resource_ingestion_worker` 역할을 만들고
`grantResourceUrlIngestionWorker`만 적용한다. API와 worker는 자격증명을 공유하지 않는다. worker에는
`RESOURCE_URL_INGESTION_DATABASE_URL`, API와 cleanup worker가 사용하는 private volume의 같은 absolute
`RESOURCE_STORAGE_ROOT`, 쉼표로 구분한 exact HTTPS host 목록 `RESOURCE_URL_ALLOWED_HOSTS`를 설정한다.
wildcard, port, path, credential이 포함된 allowlist 항목은 시작 시 거절한다.

```bash
pnpm --filter @workout/worker resources:url-ingest
```

명령은 한 번에 한 ingestion의 한 phase만 처리하고 종료한다. scheduler는 raw fetch와 parse가 각각
별도 lease/transaction으로 진행되도록 one-shot 명령을 반복한다. fetch는 hop마다 exact host, DNS의
모든 주소와 실제 TLS socket 주소를 검증한다. redirect는 5회, raw decoded body는 1 MiB, parsed snapshot은
64 KiB로 제한한다. proxy, cookie, auth header와 자동 redirect는 사용하지 않는다. 운영 로그에는 URL,
query, 주소, headers, object key, 본문과 parser exception을 남기지 않는다.

retryable failure는 DB 시각의 `retry_at` 이후 다시 claim하며 최대 5회다. permanent failure와 5회 소진은
닫힌 상태로 유지한다. raw capture 이후 parser가 실패하면 bookmark-only 상태로 원문을 보존한다.
soft delete와 계정 말소는 active lease를 취소하고 temporary/raw/parsed key를 durable cleanup manifest에
추가한다. 계정 말소 cleanup receipt는 30일간 완료되지 않은 deletion fence로 남아 매시간 같은 key를
다시 삭제한다. 이미 authorization을 받은 cleanup과 늦은 publication이 겹치거나 worker가 publish 직후
중단돼도 fence 기간의 다음 실행이 object를 제거한다. 계정 export(현재 v17)는 safe display URL과 상태·parser
metadata만 포함하며 requested URL query,
DNS/socket 주소, storage ref와 content digest를 포함하지 않는다. DB dump와 object snapshot은 같은 쓰기
정지 구간에서 함께 백업·복원한다.

## 검토 자료 retrieval과 파생 저장소 (M2-05)

검색 색인 `resource_passage`, retrieval cache `resource_retrieval_cache`, 코치 실행에 고정된 발췌
사본 `resource_grounding`/`resource_grounding_excerpt`, 저장된 인용 `resource_citation`은 모두
검토된 자료의 파생물이다. 네 저장소는 M2-04b/M2-04d의 `resource_derived_cleanup` manifest가 지우며
별도 queue가 없다. 실행기는 `public.purge_resource_derived_store(manifest,worker,target)`이고 해당
manifest에 유효한 lease를 가진 worker만 호출할 수 있다. 실행기가 없는 target은 완료로 기록하지 않고
attempt 예산도 쓰지 않는다.

권한 판정은 언제나 `public.resource_coach_use_authorized()` 한 곳이다. 삭제, AI 동의 철회, 공유 철회,
검토 해제, coach 사용 중지, 미완료 cleanup manifest는 다음 statement부터 retrieval과 인용 본문을
차단한다. 색인 행이 아직 남아 있어도 차단은 즉시 적용되므로 비동기 purge 지연이 노출 창을 만들지
않는다. 새 버전을 추가하면 검토는 이전 버전에 고정된 채로 남아 gate가 닫히고, 소유자가 현재 버전을
다시 검토 표시해야 코치가 사용할 수 있다.

retrieval cache는 TTL(10분)과 tenant당 50개 상한을 질의 시점에 실제로 회수하며, cleanup worker가
매 주기 `public.prune_resource_retrieval_cache(500)`으로 만료 행을 전역 회수한다.

백업·복원: DB dump는 이 네 테이블과 열린 cleanup manifest를 함께 담는다. 복원본에서는 gate가 이미
닫혀 있으므로 삭제·철회된 자료의 발췌가 노출되지 않고, 운영 재개 전에 cleanup worker를 돌려 남은
manifest를 소진해야 행 자체가 사라진다. 합성 drill이 이 순서를 그대로 검증한다.

## 자체 보행 routing 엔진 배선 (M2-01k)

API는 네 변수가 **모두** 있을 때만 경로 제안·목표 거리 후보·`/routing/walking-routes` 라우트를 등록한다.
하나도 없으면 라우트가 없고(화면은 "구성되어 있지 않음"), 일부만 있으면 기동을 거절한다.
graph·jar·profile이 manifest와 맞지 않아도 기동을 거절한다(`apps/api/src/routing-deployment.ts`).

| 변수                           | 값                                                                    |
| ------------------------------ | --------------------------------------------------------------------- |
| `ROUTING_ENGINE_URL`           | `http://127.0.0.1:8991/` (경로 없이 origin만)                         |
| `ROUTING_GRAPH_DIRECTORY`      | **graph 디렉터리 자체**: `.geo-build/routing-graph/foot` (절대 경로)  |
| `ROUTING_ENGINE_ARTIFACT`      | `.geo-build/graphhopper/graphhopper-web.jar` (절대 경로)              |
| `ROUTING_PROFILE_CONFIG`       | `.geo-build/routing-graph/config-serving.yml` (절대 경로)             |
| `ROUTING_ENGINE_ALLOWED_HOSTS` | 선택. 쉼표 구분. 기본은 loopback(`127.0.0.1`, `localhost`, `[::1]`)만 |

함정: `ROUTING_GRAPH_DIRECTORY`에 부모(`.geo-build/routing-graph`)를 주면 그 디렉터리 전체가 해시되어
`GRAPH_CONTENT_CHANGED`로 거절된다. `routing-graph-manifest.json`이 들어 있는 디렉터리를 준다.
profile은 M2-01d 측정용 `scripts/geo/graphhopper-foot.yml`이 아니라 serving profile이다
(다르면 `PROFILE_CONFIG_MISMATCH`).

엔진은 같은 graph·profile로 loopback에 띄운다. 인자는 `scripts/geo/graphhopper-launch.mjs`의
`graphhopperJavaArguments`가 만든다. 저장소의 모든 기동 경로(`startEngine`, probe들)가 이 함수를 쓴다.
손으로 띄울 때도 같은 인자를 쓴다:

```sh
java -Xmx2048m -Xms512m \
  -Ddw.graphhopper.datareader.file=<.geo-build/source/region.osm.pbf> \
  -Ddw.graphhopper.graph.location=<.geo-build/routing-graph/foot> \
  -Ddw.server.request_log.type=external \
  -jar <.geo-build/graphhopper/graphhopper-web.jar> server <.geo-build/routing-graph/config-serving.yml>
```

**`-Ddw.server.request_log.type=external`은 빼면 안 된다(M2-01k-c2).** adapter는 모든 waypoint를 요청 줄
(`GET /route?...&point=lat,lon`)에 담는다. Dropwizard 기본 request log는 그 줄을 stdout에 쓰므로, 이 인자가
없으면 정확한 waypoint가 엔진 로그에 남는다. 보호는 **두 겹**이고 어느 하나만으로는 부족하다.

1. **이 기동 인자.** `external` 형식은 jar 안에서 `CustomRequestLog(Slf4jRequestLogWriter, ClassicLogFormat)`를
   만든다(`logback-access.xml`은 읽지 않는다). 그래서 요청 줄은 애플리케이션 logger
   `org.eclipse.jetty.server.RequestLog`에 INFO로 가고, **경로만 담고 query string은 담지 않는다.**
2. **serving profile 콘솔 appender의 `threshold: WARN`.** 1의 INFO 요청 줄을 떨어뜨린다. GraphHopper
   `com.graphhopper.resources.RouteResource`가 route 요청마다 INFO로 **waypoint 자체**
   (`[37.57…,126.97…, …]`)를 찍는데, 그 줄을 막는 것은 이 threshold뿐이다. 그러므로 INFO 수준 appender를
   더하지 않는다: file appender, 더 낮은 threshold, `-Ddw.logging.appenders[0].threshold=INFO` 같은 기동 인자
   모두 안 된다. 하나라도 더하면 waypoint가 샌다.

profile 파일에 `server.request_log.appenders: []`를 직접 넣는 것은 **다음 graph 재빌드 때** 한다(M2-01k-e가
준비 중). profile 해시가 graph manifest(`profileConfigSha256`)와 graph id에 묶여 있어서, 지금 파일을
고치면 배포된 graph가 `PROFILE_CONFIG_MISMATCH`로 거절된다. 그전까지는 위 두 겹(기동 인자와 WARN
threshold)이 보호다. `RouteResource` logger를 WARN/OFF로 고정하는 일과 `POST /route` 검토는 후속 노드에서
한다. profile이 request log를 스스로 끄면 helper는 기동 인자를 자동으로 뺀다.

검증은 `node --import tsx scripts/probe-routing-engine-logs.mts --execute`다. 실제 jar를 이 helper로
띄우고, 심은 좌표가 엔진 stdout/stderr에 0건이어야 PASS다. `--console-threshold INFO`를 붙이면 기동 인자만의
보장을 본다. 요청 줄은 query를 담지 않아야 PASS이고, 이때 `RouteResource` 줄의 waypoint는 보고만 한다.
graph를 바꿀 때는 엔진 재시작과 API 재배포 **두 단계**다. 원자적이지 않다. 그 사이에는 API가
`graph_mismatch`(502)로 계산을 거절하며, 저장된 코스는 재계산되지 않는다. rollback도 같은 두 단계다.
identity harness에서 실제 엔진을 쓰려면 위 변수에 `IDENTITY_E2E_ROUTING=graphhopper`를 더한다
(기본은 fixture 엔진).
