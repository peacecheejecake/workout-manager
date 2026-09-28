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

## 두 번째 검토 · BLOCK

- 같은 `main` 기준 `2463f83922468818f9be9c9225cefd678681b247`, phase HEAD `2a50881ffec25e7733eebdb104e8c936ca47becc`의 110개 변경 파일을 별도 Codex CLI `gpt-6-sol` high, read-only sandbox가 검토했다. 작업 트리는 깨끗했다.
- 이전 P1 #1 receipt 삭제와 P1 #2 계정 전환 outbox 소실은 각각 **FIXED**로 판정됐다. migration 063의 영수증 보존과 실제 DB 재전송 시험, 계정별 SQLite 격리와 Swift harness가 근거다.
- 새 P1 #3 **NOT FIXED**: 다른 기기에서 동의를 철회하고 다시 허용하는 동안 오프라인이었던 iPhone의 과거 배치가 재전송 때 409를 받는다. 첫 배치를 보류하면 뒤 배치와 재조정이 멈춘다. 철회 전 표본을 재사용하지 않으면서 과거 outbox를 폐기하고 새 설치 범위에서 다시 조회하는 복구 경로가 필요하다.
- 새 P1 #4 **NOT FIXED**: 제품 iPhone의 native origin에는 HealthKit 계정 패널만 있고 검토·명시적 생성/연결·공통 Activity 상세 화면으로 가는 인증된 경로가 없다.
- M3-02h는 이번에도 외부 gate로 제외됐으며 `not_executed`다. 두 새 P1이 해결되고 전체 phase를 다시 검토받기 전까지 `main`에 병합하지 않는다.

## 두 번째 검토 지적 수정 · 재검토 대기

- 새 P1 #3 **FIXED in current content**: native 저장소는 계정별 동의 revision을 배치와 함께 보존한다. 서버 동의 revision이 바뀌면 이전 outbox·anchor·알려진 표본을 원자적으로 폐기하고 installation ID를 회전한 뒤 현재 동의 아래에서 다시 조회한다. 업로드에는 revision 헤더가 필수이며 서버는 동의 행 잠금 안에서 현재 revision과 비교한다. `CONSENT_EPOCH_EXPIRED`만 이 복구를 시작하고 일반 409는 격리 상태를 유지한다. 실제 PostgreSQL 통합 시험은 842/842, Swift State·Uploader harness는 동의 경계 회전과 재전송을 통과했다.
- 새 P1 #4 **FIXED in current content**: native 계정 화면에서 공통 ActivityBrowser의 검토 표면으로 이동할 수 있다. 좁은 native bridge GET/POST 허용 경로가 검토 목록, 명시적 생성·연결 결정, Activity 상세의 개요·구간·출처에 연결된다. native host는 현재 bearer 소유자를 검사하고 응답 크기를 제한한다. 이전 계정의 늦은 401은 새 계정 범위를 지우지 않는다. 모바일 Chromium에서 모의 native bridge로 계정→검토→명시적 생성→공통 ActivityDetail 경로를 실행했고, 링크 및 늦은 401은 컴포넌트 시험에서 확인했다.
- 합본 검증: 전체 단위·컴포넌트 4235 통과·7건 건너뜀, PostgreSQL 통합 842/842, 브라우저 smoke E2E 4/4, generated/Prettier/ESLint/TypeScript 34/34/build 15/15, Swift harness와 SDK 타입 검사, 서명 없는 iOS Simulator 빌드 통과. 최종 iOS `public/index.html`은 mobile-web build와 SHA-256이 같다. 첫 포맷 검사에서 `native-bridge.ts` 서식 차이를 찾아 수정한 뒤 전체 포맷 재검사가 통과했다. 지도·고도 자료 경로를 지정한 전체 identity E2E 두 실행은 각각 304 통과·13건 건너뜀(14.3분, 14.4분)이었다.
- 모바일 UI 검사에서 Aside 설치 업데이트는 `fetch failed`, Chrome은 native 모의 진입을 제공하지 못해 Playwright mobile Chromium을 사용했다. 이 browser mock과 서명 없는 Simulator 빌드는 M3-02h의 서명된 제품 iPhone 실행을 대체하지 않는다. M3-02h는 계속 `not_executed`다.
- 위 평가는 자체 점검이며, 새 phase HEAD의 독립 읽기 전용 전체 검토가 승인하기 전까지 `main` 병합은 보류한다.
