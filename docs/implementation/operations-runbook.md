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
새 cluster와 source/restore DB를 생성한다. 별도 시험 runtime role, 합성 계정 두 개만 사용한다.
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

M1-04a부터 새 export artifact는 `schemaVersion: 2`다. 기존 v1 다운로드 파일은 변경하지 않으며
이번 앱은 과거 export를 다시 import하는 기능을 제공하지 않는다. v2는 기존 collection에
`checkIns`와 `checkInRevisions`를 추가한다. 원래 관측 시각·시간대·0/null·정정 이유와 이력을
내보내며 인증 정보·명령 receipt는 제외한다. 레코드 삭제는 건강 payload와 해당 정정 이력을 제거한다.
남는 tombstone의 opaque ID·revision·입력/삭제 시각은 재전송 억제용 메타데이터다.

Migration 007과 `grantCheckIns`를 API runtime에 적용한다. 계정 삭제와 백업 복구의 최신 삭제 원장
재적용 시 `check_in`, `check_in_revision`, `check_in_receipt`, `check_in_collection_head`도 함께
삭제해야 한다. 신규 보고서의 체크인 복구 검사는 실제 임시 DB 검증이며 운영 복구 서비스 배포 증거는 아니다.
