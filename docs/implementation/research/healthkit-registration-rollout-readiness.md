# M3-02o 안전 배포 준비 · 2026-10-06

상태: **준비 문서 / 운영 실행 불가 상태**. 저장소 기준 `phase/m3-02` HEAD `07e235f7`, main `173d8d6`. 이후 native/web 관리 구현은 별도 진행 중이다. 이 문서는 명령 실행 승인이나 배포·감사·복원 통과가 아니다. AWS/서버/iPhone/Git mutation 없이 저장소와 기존 기록만 읽었다.

## 1. 기록된 서버와 현재 코드의 차이

| 구분                 | 마지막 기록 / 로컬 후보                                                                                                                                              | 필요한 새 실제 증거                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 운영 DB              | migration 65, PostgreSQL 17.6, wal_level=replica                                                                                                                     | 원격 현재 migration 목록·해시, DB identity, 역할/정책/권한 재확인                          |
| 준비 source          | d9a53dd 기반 source 준비 + uidtimer 후속 preflight; v4 1회 성공. 준비 파일 교체와 container 실행본은 다름                                                            | 원본 source manifest·Compose·env/pin 지문, 실제 image digest·container ID·restart·UID 기록 |
| 준비 image           | `workout-manager/app:472770d0-r1`, `graphhopper:472770d0-r1`; 현재 M3 구현을 포함하지 않는 과거 후보                                                                 | 최종 독립 검토 HEAD로 만든 immutable release, 이미지 digest·producer/consumer 버전         |
| 실제 서비스          | 2026-10-05 v3 1회 실행은 권한 제거 후 실패; 기존 세 container stopped/restart=no, 소유권 전환 미도달. apex 직접307→persona200/Workout503/TLS0, timer masked/inactive | 재측정된 현재 health·TLS·writer/timer/fence 상태                                           |
| 새로운 DB/API/worker | migration094~~097과 066~~093의 미적용 차이 전체가 존재. 095 v2 protocol fence, 096 exact receipt membership·해제, 097 leased cleanup wrapper                         | 65→최종전체 migration 적용·권한 구성·복원/정책 retarget·DB fence 실제 수용                 |
| native               | m/n은 explicit registration UUID/epoch만 수집, v2만 전송; 관리 구현은 진행 중                                                                                        | 최종 signed build/source identity, 제품 HTTPS handshake 및 합성 실기기 수용                |

`d9a53dd` source 준비, `472770d0-r1` image 준비, 실제 container/DB65를 같은 버전으로 간주하지 않는다. source 준비 성공은 migration·제품 공개·백업 fence 성공을 뜻하지 않는다. 095~097만 따로 적용해서 65의 나머지 선행 migration을 건너뛰지 않는다.

## 2. 먼저 충족해야 할 운영 선행 조건

1. EXT-HOSTING의 정확한 UID/container/fence 전환 후보를 현재 설치 상태와 대조한다. 최신 v4 실행은 준비 설치만 완료했으며 새 Compose에 대해 기존 backup fence는 stale이다. v3의 정확한 실행 승인은 1회 사용됐으며 전체 v3 재실행 승인은 없다. 복구 v2 후보는 별도 독립 artifact 검토를 받았지만 현재 Linux 재관측과 새 정확한 실행 승인이 남는다.
2. 복구 접근, 독립 스냅샷 available, 운영 writer 배제·timer mask·reviewed pin·권한·양쪽 lock·일관성 있는 백업 창을 실제 증거로 수용한다. 기존 사이트도 보호한다. 스냅샷 하나나 과거 DB65 dump가 새 운영 백업의 신선도를 대체하지 않는다.
3. 새 전체 DB+private objects 백업, 원격 보관 identity/hash, 독립 삭제 원장 config/key/slot/publication/signed head와 연속 tail, coverage complete, 격리 복원·suppression exact replay·재개 fence를 실제로 검증한다. `wal_level=logical` 전환과 WAL 상한은 별도 검토·승인·측정 대상이다. 가짜 ledger env나 빈 manifest로 대체하지 않는다.
4. 공개 ingress는 계속503 또는 명시 유지보수로 막고 제품 HealthKit 요청·새 개인 자료 유입을 허용하지 않는다. 실제 백업·복원·원장이 미준비인 현재 상태에서는 후보 배포 준비를 실행 가능한 전환으로 설명할 수 없다.

## 3. 원본 자료 감사 경로와 권한 경계

현재 운영 다섯 역할은 NOSUPERUSER/NOBYPASSRLS이고 테이블은 FORCE RLS다. 새 `auditHealthKitRegistration`은 정확한 다섯 테이블 session owner를 요구하며 row_security=off로 부분 RLS 집계를 거절한다. plain table owner 거절은 의도된 안전 동작이며 실제 합성 PG로 검증됐다. **운영 workout_owner로 직접 전체 감사가 가능하지 않다.** 운영 권한 확대·정책 약화는 하지 않는다.

준비 경로는 **검증된 신선한 전체 백업과 독립 삭제 원장 tail → 네트워크/제품 writer가 차단된 격리 복원 clone → 삭제·철회·해제 replay와 resume fence 수용 → clone 내부의 정확한 table owner/global reader로 감사**다. 단순 부분 계정 export는 전 계정 동일 UUID 충돌 감사의 입력을 대체하지 않는다. clone/restore 역할과 FORCE RLS 정책 retarget도 검증해야 한다. 실제 clone 생성·백업 반출·원본 접근 권한은 이 문서로 승인되지 않는다.

감사 결과는 version/countCeiling/건수·saturated/historicalOwnershipProven:false만 보관한다. UUID·계정·원본·payload·정밀시각·토큰을 stdout/WebView/공유 문서에 쓰지 않는다. 포화 건수는 하한이고 정확 총계가 아니다. unknown membership이 존재하면 알려진 UUID 중복0을 전체 중복 없음이나 소유권 확정으로 해석하지 않는다. timeout/RLS/권한 오류는 감사 실패이며 0으로 치환하지 않는다. 운영 자료가 없다는 진단도 신선한 전체 범위 증거 없이 만들지 않는다.

원본·clone·백업은 기존 사용자 동의·삭제 억제·보존/삭제 정책을 따른다. 임시 clone의 안전한 폐기와 접근·파일 보호 기록도 필요하다. 운영 원본의 claim backfill, 자료 격리·삭제·receipt purge는 이 감사에 포함하지 않는다.

## 4. 서버 우선 전환과 호환성

1. 모든 runnable 로컬 phase 노드 결합 검증, full gates, 새 context-less gpt-6-sol high 독립 phase 검토 완료 → 승인 HEAD만 main fast-forward. 새 배포 후보는 이 최종 검토 identity로 고정한다. HEAD07e235f7은 아직 phase 검토 완료 identity가 아니다.
2. 검토된 동일 release의 격리 clone에 전체 additive migration을 순서대로 적용하고 API·cleanup worker 최소 권한을 구성한다. 등록/list/해제는 bearer principal 소유권·consent/head/epoch를 확인한다. API runtime은 finalize를 실행하지 못하며 worker는 lease/token/tenant와 실제 cleanup DB facts가 일치할 때만 release한다.
3. 원본 legacy raw/receipt를 귀속 증거로 사용하지 않는다. receipt v1 또는 역사적 미상 membership은 보존한다. v2 exact original digest retry만 이미 알려진 v2 membership을 복구할 수 있고 v1 변환·다른 계정 재귀속·자동 purge는 금지한다.
4. clone에서 무등록 v2·구형 v1이 receipt/raw 쓰기 전 원자 거절되는지, stale epoch/consent·타 owner·중복 idempotency·동시 철회/말소를 검증한다. 검토된 서버/API/worker를 먼저 전환하고 native 구형 배치 차단 상태를 표시한다. 그 후 새 native를 배포해 명시 등록 ACK 및 전체 목록 이후에만 observer/anchor/outbox/upload를 허용한다.
5. 미ACK legacy local outbox는 해당 계정에서 보류하며 B가 A의 body를 읽거나 전송하지 않는다. epoch가 해제/재등록되면 옛 anchor나 immutable body를 새 epoch로 재작성하지 않는다. 원장 restore에서도 과거 claim epoch를 현재 유효 등록으로 추정하지 않는다.
6. `RECEIPT_MEMBERSHIP_REQUIRED`는 legacy_blocked다. 일반 해제 요청으로 원본/claim/receipt/operation/head/outbox를 일부만 정리할 수 없다. 사용자 해제·철회·계정 삭제 정책에 따른 별도 정리 수용 없이 released로 표시하지 않는다.
7. 실제 HTTPS 등록 ACK/list·계정 전환·미저장 입력·관리 pending/released·재로그인/로그아웃·back-channel을 확인하고 검토된 Caddy 후보의 공개 전환 조건을 충족한 후 제품 공개 여부를 결정한다. proxy/TLS/200만으로 로그인·DB 자료수용 통과를 주장하지 않는다.

## 5. 안전 rollback의 의미

- 배포 전 DB65의 과거 snapshot 복원 리허설은 새 등록/해제 체계의 운영 rollback 증거가 아니다.
- DB094~097 및 나머지 additive migration, 095 receipt protocol fence, claim epoch/원장과 immutable history/삭제 suppression은 유지한다. 새 자료를 수신한 DB를65로 되돌리거나 다운 migration을 적용하지 않는다.
- rollback 후보 app도 v2 fence를 준수해야 한다. 과거 app 이미지로 역전환하면 구형 batch가 DB에서 거절됨을 사전에 격리 clone에서 증명해야 한다. app health200은 기존 앱의 receipt/raw/API 호환성을 증명하지 않는다. 안전한 예전 호환 이미지가 없으면 공개/HealthKit 쓰기를 닫고 검토된 새 서버를 유지하며 fix-forward한다.
- 실행본/image/env/pin/container identity·DB/postgres·worker lease/cleanup pending·원장 tail·HTTPS baseline을 기록한 뒤 정확한 실패 주입/재개 절차를 검토한다. rollback에서 client finalize·owner replay를 대신 실행하거나 미정리 claim을 release하지 않는다.
- 전체 백업 복구는 별도 disaster-recovery 흐름이다. 최신 원장 tail로 철회/말소/UUID pending/released facts를 정확히 replay하고 모든 closure와 resume fence를 검증해야 재개할 수 있다. stale65 복원+옛앱재개는 안전 rollback이 아니다.

## 6. 수용·phase·외부 gate의 순서

| 증거                 | 현재 분류                                           | 후속 필요 증거                                                                                      |
| -------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| audit syntheticPG    | 실제3파일19시험 통과; runtime/plainowner failclosed | 신선한 운영전체 clone audit, coverage/원본 불변·폐기                                                |
| k/l rollback/cleanup | 실제합성PG·filesystem; DBfence/localrollback        | 검토된 최종 이미지 + migrated clone + 운영backup/ledger수용                                         |
| m/n native           | 실제Swift harness/SDK compile; 웹fixture/브라우저   | 최종관리소비자 결합·signed product·합성격리실기기                                                   |
| phase release        | 진행중 로컬phase·미리뷰 변경                        | fullinstall/generated/lint/typecheck/build/test/integration/identityx2/format+drills, 독립phase검토 |
| 공개HTTPS/실기기     | not_executed                                        | EXT-HOSTING 공개조건, 제품OIDC/서버동의, 계정A/B 합성현장증거                                       |

M3-02o graph scope는 운영 감사·서버 선배포·safe rollback까지 요구하지만 main은 runnable phase 작업 완료와 독립 검토 뒤에만 병합된다. **운영 gate 때문에 전체o/h를 완료로 꾸미지 않는다.** root가 로컬 구현/준비 완료와 외부 운영 수용 미실행을 구분하여 phase review 대상과 externally blocked nodes를 명확히 정해야 한다. 운영조건을 phase review 전에 통과시키려고 미검토 code를 main에 넣거나 skip을 pass로 세지 않는다. h는 o의 local readiness와 실제공개 조건을 모두 확인한 뒤 실기기 실행 가능하며, 선행 문서의 당시 predicate:nil 위험 기록은 보존한다. 새 scoped collector 구현을 그 과거 실기기 증거로 소급 사용하지 않는다.

## 7. 사용자 결정·실행 승인 경계

이미 정한 정책은 재질문하지 않는다: 명시 선택=귀속선언, 개별 해제=관련자료정리후release, 철회/계정삭제후타계정재등록허용, 서울 AWS/계정전체월10만원. 신규 audit만으로 추가 제품정책 결정은 없다.

실행 전 필요한 것은 최종 exact release/archive/destination·서버명령·migration/container/UID/fence/원장/백업복원·공개전환 및 기기/합성HealthKit 범위에 대한 실제 준비와 해당 승인이다. 기존 v4 준비1회 승인은 새로운 실행을 포괄하지 않는다. 운영 audit에서 충돌/미상자료가 나오면 자동정리하지 않고 구체적 대상을 비식별 집계로 설명한 뒤 기존삭제정책 적용과 추가결정이 필요한지를 root가 확인한다. secrets/keys·백업자료 전송도 기존의 정확한 승인 범위를 벗어나지 않는다. push는 사용자 작업이다.

## 8. 읽은 근거와 이 문서 검증

- AGENTS.md: Codex orchestration, whole-phase independent review before main, external not_executed 보존.
- docs/implementation/HANDOFF.md: DB65와 v4 준비 설치·운영 미실행 기록.
- progress/EXT-HOSTING.md: 472770d0 이미지, d9a53dd/uidtimer 준비, snapshot/clone rollback의 과거 범위, 최종 v4/fence/503 미완료.
- research/healthkit-account-registration-adr.md: R0→R3, 자동backfill 금지, unknownownership·계정귀속정책.
- progress/M3-02k/l/m/n/o/h.md, task-graph.json: local evidence 및 외부수용 구분.
- persistence/src/migrate.ts, audit.ts; migrations094~097; API product-routes/configured wiring·worker resource-cleanup-worker: 현재계약/producer/권한경계 읽기.

새 시험을 실행하지 않았고 운영에 접속하지 않았다. 이 문서의 파일경로·버전·기록을 저장소에서 대조했으며 코드/main/graph 변경은 없다. 기록된 서버상태는 현재 실측으로 간주하지 않는다.

## 루트 통합 기록

준비 원문을 루트가 저장소에 보존하고, v3 부분 실행 이후 stopped/restart=no·apex307→persona200의 최신 실제 기록을 반영했다. 원문 조사 당시 HEAD와 모든 외부 미실행 분류는 유지한다. 이후 새 관리 구현 검증과 phase 리뷰 identity는 해당 progress에 따로 기록한다.
