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

### 최신 실행 checkpoint

구현 입력 `8e42d124`: 앞선 `867914c4`는 disposable identity PG17 fixture 실제unit47·catalog2Host2·scope2Host2·isolated lifecycle1 수용, `2aa010bd`는 legacy PATCH 증빙 보존 실제PG7·unit41·후속 identity2Host2, `8e42d124`는 consumed read-scope unit51·실제PG5의 결과다. Context는 기존 blocked/complete:false를 유지한다. 후속 compatible preview actualPG3와 모든 실패·fixture 수정 및 외부 한계는 I/J progress에 기록했다.

Root의 최신 AWS non-root workout-admin STS 조회는 SSO token expired/refresh failed·exit255다. 운영 쓰기는 실행하지 않았고 pending 로그인/정확 recovery script 승인은 재사용하지 않는다. main은 `1d557358`을 유지한다. Graph 부모/I/J는 in_progress이며 full manifest/원자 승인, registry/private restore, PB/첨부·재연결 화면, 전체 phase gate/독립 검토 및 운영/기기 수용은 계속 남아 있다.

## 현재 phase 검증 checkpoint · 2026-10-09

위 과거 I/J 진행·정책 대기 기록은 해당 시점의 상태다. 현재 graph a~m은 completed, 부모 M2-02는 M2-01 외부 의존성 때문에 in_progress다. 공식 거리별 PB는 직접 입력도 인정하고 증빙 표시와 검증을 구분하며 Chip 우선·없는 경우 Gun으로 비교한다. 신규 계획 생성·사용은 계속하고 FUT-09 역사 원문 이식만 별도 대기한다.

최종 runtime source proof/핀은 faf85c59에, 날짜 변경 승인 guard를 보존한 영양 fixture는 a097b4e5에 커밋했다. 실제 whole unit R5 9,499통과·12skip와 install/generated/lint/typecheck/build/format 여섯 exit0 기록을 보존한다. 후속 canonical full normal R2는 3,068통과·14skip·실패0, 별도 upgrade1/1·exit0·1,091개 입력 불변·소유 클러스터 정리 완료였다. Native baseline107 logical1+pgoutput24+foundation13도 실제38/38이며 진단 wrapper 실패와 보충 정리를 별개로 기록했다.

전체 identity R1은 general302통과·13실패·16skip, 나머지 모음/전체 R2는 미실행이다. 실제 원본 focused 재현으로 오래된 대회 버튼 locator와 export31 기대의 drift를 확인했다. 최종 fixture는 대회 라벨 한곳·기본 export34만 교정하고 원 네트워크/DTO/URL/UI·CAS·tenant·동의 검증을 보존해 두 Host4/4·skip0을 실제 확인했다. 제품 navigation 결함이라는 최초 귀속은 철회했으며 과거 실패를 덮어쓰지 않는다.

누락된 ignored .geo-build 링크를 복구하고 코드/빌드와 별도의4,831파일 환경 SHA를 고정했다. Geo undisclosed·basemap licence not_checked 및 실기기/provider/운영/최신 인증 복원 gate는 유지한다. 현재 환경의 전체 unit 갱신과 corrected whole identity 두 회차, 이후 독립 whole phase review가 남아 있다. 정확한 결과 SHA·시간·cleanup과 실패 정정은 [HANDOFF의 최신 기록](../HANDOFF.md#2026-10-09-전체-normal-통과와-identity-fixture-교정)에 따른다. main은1d557358, protected EXT-HOSTING WIP·stash는 보존하며 push는 사용자 작업이다.

후속 실제 whole unit R6는9,506통과·5skip·실패0·588파일 통과·exit0이었다. source2,917개 전후 동일, Java/JAR 및 합성 TMP 정리를 확인했다. 이전 R5 skip를 소급 변경하지 않는다. 실제 결과 SHA `8201e8bf…58d40`와 HANDOFF의 [환경 갱신 기록](../HANDOFF.md#2026-10-09-복구한-환경의-전체-단위-갱신)을 따른다. Whole identity 두 회·독립 검토/main은 아직 미완료이며 sourceproof·normal R2 입력은 불변이다.

후속 corrected canonical identity는 실제 두 회차를 실행했지만 두 번째 current-manual webServer startup에서 실패했다. 첫 회차346통과·12skip, 두 번째 general319·app4·AI1 통과 뒤 current-manual 단언0이다. 별도 AI→current 전환 진단23/23·skip0은 원 실패를 재현하지 못했고 whole x2 통과를 대체하지 않는다. 두 소유 tmpfs 클러스터는 각각 정확한 정리 기록으로 제거했으며 기존 varfolders TMP는 보존했다. 원인 미확정·실패 기록은 유지한다. SHA·cleanup·서명/기기 한계는 [HANDOFF의 새 실제 기록](../HANDOFF.md#2026-10-09-corrected-identity-두-회차-실패와-전환-진단)을 따른다. 새 whole x2 검증 뒤 독립 phase review가 필요하며 main 병합은 아직 수행하지 않았다.

후속 canonical 관측 실행은 general318통과·1timeout·12skip로 실패했고 후속 모음/두 번째 실행은 not_executed다. Controlled app 동의409 경쟁 시험의 단언1통과와 actor 정리 실패(DB1·역할5·TMP1)는 별개이며, 정확한 소유 클러스터만 별도 폐기했다. OIDC 보류 목록에 app 동의 한 줄을 추가한 뒤 실제 focused2/2·skip0·retry0·exit0을 확인했다. TMP 부모 종료 관측의 child code0/signalnull과 즉시 잔존0은 진단 범위의 증거이며 원 timeout/정리 실패 원인은 미확정이다. 제품·timeout·runtime333·빌드는 변경하지 않았다. 실제 SHA와 native signed artifact 유효/기기 미연결 한계는 [HANDOFF의 새 기록](../HANDOFF.md#2026-10-09-oidc-경쟁-fixture-교정과-종료-관측)에 따른다. 관측 없는 whole x2·독립 phase 검토/main은 여전히 미완료다.

후속 `f26bc4a5` canonical 전체 실행은 general318통과·course-extras1실패·12skip였다. 원본 focused1통과와 별도 controlled1실패는 구분한다. 실제 controlled에서 보호 구역 POST200 뒤 새 목록 GET 완료 전에 enabled 버튼의 PATCH가 나가 서버409 stale 거절을 받았으며 기존 수정본은 보존됐다. 만든 구역2개·임시 spec 정리, 원4,219개 입력과 자원 정리는 완료했다. 서버 guard를 보존하는 scoped 화면 수정·회귀 검증은 진행 중이며 full x2·독립 review/main은 미완료다. 실제 SHA·관측 한계·AWS CLI 인증 복구·iPhone 정확 합성 앱 설치 성공 뒤 LOCKED 실행 중단은 [HANDOFF의 새 기록](../HANDOFF.md#2026-10-09-보호-구역-갱신-경합의-실제-재현)을 따른다. 잠금 해제 전 성능 측정은 not_executed다.

### 2026-10-09 보호 구역 갱신 대기 교정

[HANDOFF의 새 검증 기록](../HANDOFF.md#2026-10-09-보호-구역-갱신-대기-교정과-실제-ui-확인)을 따른다. Component48/48, 전체 정적6개 exit0, 전체 unit9509통과·5skip, 실제 Cua IAB 합성 UI/320·768·1280 reflow를 확인했다. Controlled R2는 시험1건 통과와 actor 유효성 오류를 구분해 보존했다. canonical identity x2·독립 phase review·main 병합은 미완료이며 graph 상태를 올리지 않는다.
