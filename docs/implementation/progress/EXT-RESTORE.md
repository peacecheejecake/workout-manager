# EXT-RESTORE · 현재 제품의 완전한 인증 복원

상태: **in_progress** (`EXT-RESTOREa` 로컬 구조 검증 구현 착수). 전체 gate와 운영 `EXT-RESTOREb`는 미완료다. 기존 M2-01k의 운영·삭제·복원 수용 공백을 명시적으로 추적한다. 새 제품 범위를 추가하거나 기존 요구를 완료 처리하지 않는다. G2-PUBLIC, EXT-HOSTING과 M2-01k는 이 gate를 기다린다.

## 현재 실제 증거와 공백

Historical authenticated family는 source100 → target102 → 정식 upgrade105를 지원한다. 이 경로의 실제 시험은 직접 source105 전체 복원 증거가 아니다. Ordinary source105 archive의 R14 107 checks와 R15 fault2/107 checks는 별도의 실제 로컬 증거다. 단일 SQL-origin AI 이벤트와 privileged dump/import는 complete authenticated tail·외부 witness·전체 plain-owner load 권한·admission reopening을 증명하지 않는다.

현재 historical family의 27개 relation 외에도 identity/동의/실제 기록/Activity/Track/Course/Resource/Gallery/객체/cleanup/outbox 등 전체 registry가 필요하다. SQL103 budget 6개, SQL104 settings 4개 relation 및 이후 M2-02의 변경을 현재 profile에 포함해야 한다. SQL101 processing control과 SQL102 stage/descriptor는 target-local authority이며 source archive로 덮어 권한을 만들지 않는다. 기존 093/100 registry와 source100/target102 protocol의 literal·checksum·HMAC domain은 보존한다.

## EXT-RESTOREa · 로컬 구현과 실제 수용

의존성은 M2-01k-v-c 및 M2-02i/j/k다. M2-02에서 영양 copied-source lifecycle과 공식 기록 schema가 확정되고 phase 통합된 뒤, 승인된 main의 정확한 schema를 기준으로 Root가 신규 DDL을 직렬 배정한다. **107 등 번호를 미리 예약하지 않는다.** 별도 `phase/ext-restore`에서 구현·검증·phase 검토한다.

필수 결과:

- 독립적으로 고정한 registry/checksum/catalog와 전체 relation·owner·row/object inventory. Archive 제공 schema나 관찰한 source 구조를 authority로 채택하지 않는다. Unknown/missing family와 명시 부재, bound·snapshot/slot/LSN correspondence를 검사한다.
- 기존 역사 protocol을 보존하는 새 version/domain의 typed full-family artifact와 loader. 실제 원본 row·epoch·catalog/settings history·receipt·consent/삭제 suppression 및 객체 provenance를 보존하며 target에서 임의 재생성하지 않는다.
- 모든 사용자 합산 budget의 정의·FX·가격·활성화·월·reservation/journal와 complete tail 복원. Ambiguous/dispatched 상태는 보존하고 외부 재전송·재청구를 복원 성공으로 정당화하지 않는다. 세션·토큰은 재인증을 요구하며 복원으로 살아나지 않는다.
- 완전한 baseline/tail/index/head와 source generation, 별도 target incarnation/nonce/CLOSED revision을 묶는 인증·postconditions. 부분 proof로 전체 completeness를 승격하지 않는다. 새로운 admission은 모든 조건을 실제 검증한 후 원자적으로 처리하며 기존 CLOSED guard를 우회하지 않는다.
- 정상 public migration·plain owner/restricted runtime의 실제 PG 수용: 전체 family 대응, retained facts/삭제된 source 비재생, receipt replay, foreign/충돌/부재·순서·latest-tail 거절, mixed-family 실패의 전체 rollback, owner/role·target binding·동시 close 검사. Unit이나 ordinary privileged import로 대체하지 않는다.

M2-05b/c의 complete freshness·budget 복원은 이 로컬 capability를 명시적으로 기다린다. 구현 전에는 항상 기존 제한이 유지된다.

## EXT-RESTOREb · 운영의 외부 증거

실제 AWS source의 snapshot/slot/LSN, 독립적으로 보존된 최신 baseline/tail/index/head/witness/ACK, 키·객체 retention 및 target identity가 필요하다. 검토된 정확한 스크립트와 필요한 사용자 승인으로 전체 백업·별도 격리 복원·원장/삭제/자격 증명 무효화·RPO/RTO와 admission을 실제 검증한다. 현재 공개 503 해제나 운영 복원은 완료하지 않았다.

Local signed fixture, 단일 이벤트 hash, 서버 health 응답, root 검토나 child completion 메시지는 이 외부 증거가 아니다. 미실행 항목은 not_executed로 남긴다. Local 구현과 운영 수용 모두 완료되기 전 EXT-RESTORE 및 제품 출시 gate를 완료하지 않는다.

## 2026-10-07 추적 검증

읽기 감사: `/private/tmp/wm-c-current105-authenticated-chain-gap-20261007.md`. Historical source100/target102와 현재105의 공백을 코드에서 대조한 문서이며 새 protocol 구현·PG·운영 결과가 아니다. Root는 기존 매핑 요구의 backup restore/삭제 suppression과 최신 v-c의 직접105 복원 미구현 기록을 확인했다. Graph는 기존 M2-02 하위 작업에 의존하며 parent M2-02 의존성을 추가하지 않아 순환을 만들지 않는다. 기존 모든 node/status와 미완료 요구를 보존한다.

## 2026-10-09 로컬 inventory precursor

`phase/ext-restore`는 M2-02 개발 입력 `a300ff3f`에서 분리했다. M2-02 전체 phase 검토/main 통합과 SQL143 최종 registry는 아직 미완료다. 새 `full-restore-inventory-v1` public port는 independently supplied exact registry/profile/catalog identity에 대해 unknown inventory를 bounded strict 검증한다. 전체 relation의 present/explicit-empty, 순서·중복·누락·추가·codec·column/order key·개별/합산 count와 bytes, target-local 제외를 검사한다. 결과는 detached/frozen `validated`이며 `authority: none`, `admissionAllowed: false`다. digest는 equality descriptor이며 물리 row SHA·서명·최신 tail·객체·실제 권한을 증명하지 않는다.

Root의 실제 Node24.12.0 기본 unit 모음 **14/14·1파일·skip0·exit0**, duration229ms, 전체 persistence TypeScript·scoped lint/format exit0이다. 새 worktree의 offline frozen38개 workspace 설치는805개 package·다운로드0·exit0이다. 초기 store 등록 EPERM은 허용된 동일 설치로 해소했고 msw ignored build script 경고는 보존한다. 첫 unit 실행의 기본 Node22 관측 뒤 Node24로 같은 시험을 실제 재실행했다. source SHA `9e9f05770bfa55c265ca7fc9cc241ec0139dc701c163b208d48ab06ef42e0d81`, test SHA `5303f568794990c3dd994f0a390d6c7f3310685622ee02e6d9333445300422f0`다.

이 입력은 synthetic registry이고 production 전체 inventory가 아니다. 최종 whole registry·물리 row/tail/crypto/loader·원자 admission·실제 plain-owner PG 15항목과 운영 외부/최종 제품 실기기 수용은 남는다. 기존 source333·역사 domain/literal/SQL101/142와 CLOSED guard는 변경하지 않았다.
