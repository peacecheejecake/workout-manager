# M2-02 · 별도 phase branch의 고정 상태

아래 `5ecc48c2`는 당시 고정 기록이다. 후속 현재 branch HEAD는 `20b26bf8`이며 마지막 절에서 구분한다.

기준: `phase/m2-02` HEAD `5ecc48c28f7b8e4303d420a258a964046c8a5d99`, 2026-10-07. 이 문서는 Root 공통 graph의 별도 branch 상태 기록이다. M2-02 코드를 C나 main에 병합하거나 phase 검토를 통과한 기록이 아니다. 해당 branch의 기존 progress 문서와 실제 로그가 검증 범위의 원본이며, branch-qualified `git show <HEAD>:docs/implementation/progress/M2-02<suffix>.md`로 확인한다.

| 노드 | branch 로컬 상태 | 기록 범위                                                                        |
| ---- | ---------------- | -------------------------------------------------------------------------------- |
| b    | completed        | 저장 명령·runtime 계약                                                           |
| c    | completed        | tenant 원장·불변 revision·CAS·receipt/outbox                                     |
| d    | completed        | bounded 목록·privacy generation cursor                                           |
| e    | completed        | owner-scoped Fastify API·실제 PG                                                 |
| f    | completed        | 개별 삭제·suppression·PG14 복원                                                  |
| g    | completed        | 재사용 S15/S16 modules 로컬 수용                                                 |
| h    | completed        | 실제 인증/API/DB·Next/Vite browser·relation loader                               |
| i    | in_progress      | 날짜 영향 preview·승인: 영양 race timing V2 계약까지, 전체 쓰기/원자성/UI 미완료 |
| j    | in_progress      | 공식 확인 대회 기록만 PB; 공식 검증 방식·시간/거리 기준 추가 결정 대기           |
| k    | completed        | app 동의 실제 PG/HTTP/두 shell 수용                                              |

사용자 결정: 공식 확인된 대회 기록만 PB이며 기기 추정 split·수동 출처 기입은 검증이 아니다. 날짜 변경 후 영향받지 않은 기존 미해결 일정은 안내와 함께 보존하며 이번 변경으로 영향받은 미해결 일정은 승인 전에 해결한다.

`5ecc48c2`의 nutrition race timing V2 공개 계약은 기본 단위68/68와 관련 consumer/build 검증이다. 후속 시각 준비 helper의 단위17 및 실제 PG R1 4통과·2실패는 아직 이 HEAD 밖의 미커밋 작업이며 전체 저장/승인 완료로 계산하지 않는다. R1 원본 실패를 보존하고 fixture의 정상 공통 grant 누락을 조사 중이다.

부모 M2-02는 M2-01과 a~k 전체 수용을 요구하며 not_started를 유지한다. 전체 phase gate·독립 context-less review·main 병합·공개 운영·실기기는 이 기록으로 통과시키지 않는다. 별도 branch 간 통합 뒤에는 변경된 diff의 전체 검증과 독립 phase review를 새로 받아야 한다.

## 후속 실제 검증·커밋 · 2026-10-07

현재 `phase/m2-02` HEAD `20b26bf8`: `5b921bee`의 owned 시각 준비는 실제 PG6/6 및 단위17, `2a32e0fb`의 immutable pin projection/ISO year 계산은 Root 통합 단위104/104, `20b26bf8`의 legacy race/session UUID 충돌 차단은 정상106/plain-owner 실제 PG3파일40/40·skip0이다. Root는 마지막 회차의 271개 입력 전후 동일성과 여섯 source SHA·cleanup·실제 로그를 직접 대조했다. 최초 준비 R1의 공통 grant 누락 4통과/2실패와 UUID 검증 R1의 동일 run 재준비 39통과/1실패는 각각 원본에 보존했다.

현재 I/J는 여전히 in_progress다. V2 저장·역사 조회/lifecycle·완전 manifest·owned review/전체 atomic 승인·UI 및 공식 PB 구현은 완료하지 않았다. Copied-source 삭제 후 시각 처리와 PB 세부 정책의 사용자 답을 기다린다. 이 별도 branch 상태는 C/main에 해당 코드가 있다는 뜻이 아니다. 전체 인증 복원은 새 EXT-RESTORE의 최종 schema protocol/외부 수용으로 추적한다.

## 검토된 main의 후속 통합 · 2026-10-07

입력은 M2-02 `20b26bf8a7f3a637a4c2a5f1fcca91b58fb28f18`과 독립 phase 검토 APPROVE 후 main에 반영된 `1d55735865c827f3870e6fa4b2effd418ed63677`이다. Root는 8개 충돌에서 두 Host의 competitions/settings 의존성·navigation, race와 정확한 AI settings transport allowlist, coaching public exports, pgoutput 두 계약 suite를 모두 보존했다. 자동 병합으로 중복된 AppConsentPanel import 1개와 동일한 테스트 app handler 6개를 제거했다. main으로 M2-02를 병합하거나 M2-02 phase 검토를 완료한 기록이 아니다.

실제 R1 frozen install·root tsc·관련 unit 14파일332개는 exit0이지만 consumer typecheck는 duplicate import로 exit2, format은 exit1이었다. 실패 원본을 보존했다. 수정 후 R2 frozen install, 강제 consumer typecheck 36/36(cache0), root tsc, 동일 unit 14파일332/332(skip0), 변경 TS/JS 7파일 ESLint, 전체 format 및 diff check가 모두 exit0이었다. Root가 원본 logs/results와 전후 tracked SHA 변화0을 대조했다. R2 private evidence: `/private/tmp/wm-m202-merge-bounded-r2-2fa39b38`; R1: `/private/tmp/wm-m202-merge-bounded-4abcf3a5`.

이 통합 변경은 기존 검토된 두 구현을 합친 경계의 좁은 검증이다. 새 PG·build·browser·외부 provider·실기기·전체 M2-02 phase gate는 실행하지 않았으며 이전 실행을 새 HEAD 전체 수용으로 바꾸지 않는다. 자체 미커밋 PB 화면/진행 문서/fixture 5파일은 정확한 stash와 private SHA 백업으로 별도 보존한 뒤 통합 커밋 후 복원한다. I/J는 여전히 in_progress이고 공식 확인 producer/거리·시간 기준 및 전체 날짜 영향 승인은 미완료다.

## 현재 후속 범위와 결정 · 2026-10-07

위 HEAD와 정책은 각 당시 고정 기록이다. 최신 phase 구현 입력은 `c78b4e3e`이며 main은 `1d55735865c827f3870e6fa4b2effd418ed63677` 그대로이고 clean이다. Root 후속 phase 커밋 `6dcf9c39`(SQL110 lineage/retained reader), `74f1b23a`(legacy race read/PB 정책 안내), `57baa82e`(V4 standalone writer/V5 운영 시각 조회), `c78b4e3e`(명시 export35)를 기록했다. 실제 수용과 실패·skip·external NOT_EXECUTED는 I/J progress에 각각 보존한다.

최신 사용자 결정은 직접 입력한 대회 기록도 PB에 인정하며 링크·인증 자료 첨부 마크와 진위 확인 완료를 구분하는 것이다. 대회 삭제 후 음식·수량·실제 섭취를 보존하고 연결 해제 상태로 표시하며, 명시 재연결·재승인 전에는 대회 시각 사용을 중단한다. chip/gun·거리 분류 정책 질문은 답변 대기다.

후속 실제 PG는 lineage15/15·standalone writer11/11·legacy 운영 조회8/8·legacy race read6/6·export35 3/3이며 겹치는 집중 단위 수를 총수로 합산하지 않는다. PB 안내 identity2/2는 실제 합성 API/DB, 운영 안내 identity2/2는 실제 인증·계정 경로와 strictV5 integratedGET mock을 구분한다. 전체 race-date atomic 승인·private authenticated archive/restore·정식 migration registry/owner retarget·공개 V2/V4 transport/첨부·재연결/PB 화면은 완료되지 않았다. I/J 및 부모 phase in_progress, 전체 gate·독립 phase 검토·main 병합·push는 미실행이다.

남은 working tree는 AI identity fixture의 외부 일회용PG 연결/수명 관리 후속 및 compatible preview PG 시험 준비다. 이들은 이 상태 기록 커밋에 포함하지 않는다. 별도 stash `ae34d998accb9819d6d9d1e929d9ce620fd55598`도 보존한다.

### 외부 일회용 PG17 identity fixture 정리

앞서 보존한 AI fixture5파일은 opt-in localhost PG17의 무작위 시험 DB만 생성하고 실제 DB/owner/admin OID·direct maintenance admin capability·정상 migration checksum과 run 수명을 검증한다. 삭제는 현재 run에서 생성한 exact OID의 DB/roles만 수행하며 외부 PG service는 중단하지 않는다. URL parse 오류와 연결 실패는 자격 증명을 포함하지 않는 안정된 오류로 정제하고 pool을 닫는다. 기본 canonical fixture 경로는 유지한다.

Root 최신 동결 입력 unit **47/47**, 실제 정상 auth/planner2Host **2/2**, AI settings catalog 저장/재조회/CAS/철회2Host **2/2**, 별도 spec-only freshDB lifecycle **1/1·exit0**를 확인했다. 로그는 `/private/tmp/wm-external-pg17-root-{unit-r1,identity-r1,ai-settings-r1,ai-lifecycle-r2}-20261007.log`다. lifecycle 첫 회차는 SPEC_ONLY 실행 설정 누락으로 LIFECYCLE_NOT_ISOLATED 거절·exit1이었으며 guard를 약화하지 않고 올바른 dedicated 단일 spec 명령으로 재실행했다. 그 실패는 `...ai-lifecycle-r1...`에 보존한다. Root TS·scoped lint/format은 exit0이나 별도 script consumer TS는 기존 oidc-provider 선언 누락 TS7016로 exit2인 사실도 보존한다.

완료 후 실제 identity DB 잔존0 및 기본 owner/runtime roles 잔존0을 읽기 전용으로 확인했다. 정상 role/grants와 restore admission을 우회하지 않는다. 이는 합성 fixture와 lifecycle 경로의 결과이며 운영 복원·공개 HTTPS·기기 수용 또는 M2-02 전체 phase gate의 통과가 아니다.
