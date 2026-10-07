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
