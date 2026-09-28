# M3-02 phase 독립 검토

## 첫 검토 · BLOCK

- 기준 `main` `2463f83922468818f9be9c9225cefd678681b247`, phase HEAD `04c5168bc63144175a9745222c2b28dc974ee366`. 작업 트리는 깨끗했고 변경 경로 108개였다.
- 별도 Codex CLI `gpt-6-sol` high, read-only sandbox가 전체 diff를 검토했다. 판정: **BLOCK**. 이 HEAD는 `main`에 병합하지 않는다.
- P1 #1 **NOT FIXED**: HealthKit 소유 Activity 로컬 삭제의 raw 정리 trigger가 같은 계정의 모든 batch receipt digest를 purge한다. 서버 저장 뒤 ACK를 잃은 native 배치가 409를 받아 뒤의 outbox까지 영구 보류될 수 있다. 로컬 삭제와 무관한 receipt를 보존하거나 안전한 재조정 경로 및 실제 DB/native 재전송 시험이 필요하다.
- P1 #2 **NOT FIXED**: 계정 전환이 이전 계정의 미전송 `HKDeletedObject`를 포함한 outbox와 cursor를 지운다. 서버에 남은 이전 계정의 canonical Activity 삭제가 전달되지 않는다. 계정별로 보존하되 새 계정의 인증으로 재전송하지 않는 격리 경로와 native 시험이 필요하다.
- 검토자는 M3-02h의 서명된 제품 iPhone 실행을 외부 gate로 별도 제외할 수 있다고 판단했다. M3-02h의 실제 실행은 `not_executed`이며 M3-02 부모도 미완료다. 이는 위 BLOCK 이유와 별개다.

## 지적 사항 수정 · 재검토 대기

- P1 #1 **FIXED in current content**: migration 063은 로컬 Activity 삭제와 absent-Activity 재생에서 계정의 HealthKit batch receipt를 지우지 않는다. raw 표본 삭제 상태와 lineage suppression은 유지한다. 실제 PostgreSQL 시험에서 ACK를 잃은 동일 배치 재전송, 다른 본문 충돌, 후속 배치, 삭제 표본의 재생성 방지, 타 계정 격리를 검증했다. 062가 이미 지운 과거 receipt는 복구할 수 없지만 이 phase는 아직 `main`에 병합되지 않아 제품 배포 이력이 없다.
- P1 #2 **FIXED in current content**: native SQLite outbox/cursor를 계정별 보호된 파일로 격리하고 로그아웃에서 메모리 소유자만 해제한다. 다른 계정에서는 이전 계정 배치를 볼 수 없으며, 이전 계정으로 다시 로그인하면 같은 본문으로 재전송할 수 있다. 기존 단일 소유자 파일도 해당 계정에 유지한다. Swift harness는 오프라인 삭제 대기, 계정 전환, 프로세스 재시작, ACK를 확인했다.
- 수정 통합 검증: PostgreSQL 통합 시험 841/841, 전체 단위·컴포넌트 시험 4229 통과·7건 건너뜀, Swift harness 통과, iOS SDK 타입 검사 통과, 서명 없는 iOS Simulator 빌드 통과, generated/Prettier/ESLint/TypeScript/build 통과. 처음 전체 단위 시험은 로컬 서버 바인딩이 제한된 실행 환경에서 35건 실패했으며, 권한을 갖춘 동일 코드 재실행에서 위 결과로 통과했다.
- 이 평가는 수정된 작업 트리의 자체 점검이다. 별도 `gpt-6-sol` high read-only 검토가 새 phase HEAD를 승인하기 전까지 BLOCK 판정을 유지하고 `main`에 병합하지 않는다.
