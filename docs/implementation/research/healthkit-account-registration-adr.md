# HealthKit 계정별 운동 선택·등록 ADR (2026-10-05)

상태: **제품 방향 결정 / 서버 부분 구현**. 계정별 운동 선택·등록·해제·철회 정책은 확정됐다. M3-02j의 등록/목록 runtime 계약과 M3-02k의 서버 원장·수신 gate가 부분 구현됐으며, 현재 구현·검증 범위는 [M3-02k 기록](../progress/M3-02k.md)을 따른다. 이 ADR 자체는 구현이나 검증 결과가 아니다. 개인 운동이 있는 현재 iPhone에서 Release collector를 실행하지 않는다. [M3-02h](../progress/M3-02h.md)의 제품 실기기 수용은 `not_executed`다.

## 설계 당시 경계와 위협 모델

- 제품 `HealthKitWorkoutCollector.swift`의 `HKObserverQuery`와 `HKAnchoredObjectQuery`는 모두 `predicate: nil`이다. B의 계정별 cursor가 처음 열리면 A의 운동을 포함한 같은 HealthKit 저장소 전체를 다시 볼 수 있다. 계정별 SQLite 파일은 이전 계정의 outbox/anchor 전송을 막지만 표본 귀속을 증명하지 않는다.
- 서버 `healthkit_workout_sample`의 기본키는 `(athlete_id, sample_id)`이며, 설계 당시 배치 수신은 tenant·동의 revision·계정별 batch receipt를 확인하지만 전 계정에서 UUID의 단일 귀속을 검사하지 않는다. 따라서 같은 UUID를 A와 B의 raw로 저장할 수 있다.
- HealthKit 표본의 source·시각·운동 종류는 제품 계정 식별자가 아니다. 날짜 cutoff, source 필터, 계정별 `known_sample`만으로 A의 미수집 운동과 B의 운동을 구별할 수 없다. `HKDeletedObject`는 UUID는 남기지만 사용자 정의 metadata를 보존하지 않는다. 빈 조회는 읽기 허용·표본 부재·삭제 증거가 아니다.
- 공격·오류 사례: A→B 전환, 동시 A/B 등록, 오래된 앱의 무등록 배치, 오프라인 재전송, 재설치 후 로컬 소유권 손실, 서버 철회/말소, 같은 UUID의 삭제 뒤 늦은 upsert, 잘못 선택한 계정, 손상된 로컬 상태, 권한 거부 중 cursor 전진. API 요청과 로컬 파일·HealthKit 결과는 모두 검증 대상이다.
- 목표 보장: **제품이 자동으로 미등록 UUID를 어느 계정으로도 업로드하지 않으며, 활성 A 등록 UUID를 B가 등록·업로드할 수 없다.** 미등록 외부 운동의 실제 인간 소유권은 HealthKit 필드만으로 검증할 수 없다.

## 사용자 결정과 보장 범위

1. **명시적 선택은 사용자 선언.** 사용자가 선택한 `HKWorkout` UUID를 현재 제품 계정에 귀속한다는 선언으로 취급한다. HealthKit 자체는 인간 소유권을 확인하지 못한다. A가 아직 등록하지 않은 실제 A 운동을 B 사용자가 선택하면 앱은 이를 독립 검증할 수 없다. 선택 UI는 현재 계정, 운동 요약, 서버 업로드 범위를 명확히 보여 주고 등록 전 명시 확인을 받는다.
2. **계정 삭제 후 재등록 허용.** 계정 말소는 그 계정의 UUID 귀속 원장도 삭제한다. 이후 같은 HealthKit UUID를 다른 계정이 명시적으로 선택·등록할 수 있다. 따라서 계정 간 중복 등록 차단은 **활성 귀속 동안**의 보장이고, 삭제된 계정의 과거 UUID에 대한 영구 차단은 아니다. 백업·복원도 말소된 귀속을 되살리지 않도록 기존 삭제 억제 계약과 함께 설계·검증한다.

3. **개별 등록 해제는 관련 기록 삭제 후 해제.** 사용자가 운동 등록을 해제하면 그 UUID의 제품 내 관련 기록을 삭제·정리한 뒤 귀속을 해제한다. 다른 계정의 명시 재등록은 정리가 완료된 뒤에만 허용한다. HealthKit 원본 삭제를 뜻하지 않는다. raw·lineage·HealthKit 소유 Activity·파생/인용·미ACK outbox의 구체적 정리와 실패/재시도 경계는 runtime 계약과 구현에서 검증한다. Garmin/수동 Activity의 별도 정본을 지우는 것으로 해석하지 않는다.
4. **동의 철회도 귀속 삭제.** 계정이 남아 있어도 HealthKit 동의를 철회하면 관련 자료 정리와 함께 그 계정의 UUID 귀속을 삭제한다. 정리 완료 후 다른 계정은 유효 동의와 새로운 명시 선언으로 같은 UUID를 등록할 수 있다. 과거 receipt·outbox나 백업이 철회된 귀속과 자료를 되살리지 않아야 한다.

2026-10-05 사용자 답변으로 위 네 정책을 확정했다. 개별 등록 해제 runtime DTO/API·native 동작은 아직 구현하지 않았으며 정책 결정만으로 해당 수용을 완료 처리하지 않는다.

## 구현 경계와 배포 순서

### R0. 배치 수신 차단을 먼저 배포

- 서버에 기능 gate를 추가하여 **등록되지 않은 UUID가 하나라도 있는 배치 전체를 receipt/raw 기록 전에 원자적으로 거절**한다. 초기 gate는 등록 API가 준비되기 전에는 모든 신규 HealthKit 배치를 거절한다. 구형 native 클라이언트가 v1 본문을 보내도 우회할 수 없어야 한다. 기존 receipt의 정확한 멱등 재생 처리와 동의 epoch 만료 순서는 별도 규칙으로 명시하고 실제 DB에서 검증한다. 이전 미ACK 배치는 등록 증명이 없으면 자동 재전송하지 않고 해당 계정에서 보류·재선택 경로를 제공한다.
- 계정 충돌의 외부 응답은 타 계정 존재를 드러내지 않는 안정적인 코드로 정한다. native uploader는 이를 기존 임의 409와 구분해 무한 재시도하지 않고 사용자에게 보류 상태를 표시한다. 서버 배포 이후 native 배포 전의 HealthKit 동기화 중단은 의도된 안전 상태로 UI/운영에 명시한다.
- 롤백에서도 서버 gate를 제거하지 않는다. 구형 서버로 되돌려 미등록 배치를 다시 허용하는 롤백은 금지한다. schema/data 변경은 additive migration 후 gate를 유지한 채 애플리케이션 기능만 되돌리는 방식을 우선한다.

### R1. UUID 귀속 원장·등록 API

- 전 계정에서 UUID 하나의 활성 owner만 허용하는 서버 원장을 둔다. 예: `sample_id` 전역 unique, `owner_athlete_id`, 등록 상태/epoch, 명시 선택의 idempotency key, consent revision, 생성·해제 시각. 원장에는 운동 본문·위치·경로를 저장하지 않는다. UUID도 건강 자료 연결 식별자이므로 접근·보존·말소 정책을 적용하고 계정 말소 거래에서 지운다. 삭제 후 타 계정 재등록은 새로운 사용자 선언과 유효 동의를 다시 요구한다.
- 고정 bearer 경로로 제한된 등록/조회 API를 둔다. 등록은 인증에서 계정을 유도하고, 서버 동의 revision·개별 UUID 형식·개수 상한·idempotency를 검증한다. 다른 계정 소유 UUID 등록은 비공개 충돌 응답; 같은 계정의 동일 요청은 원 결과. API는 native에게 그 계정의 등록 UUID/epoch만 돌려주고 WebView에는 raw UUID를 전달하지 않는다. 개별 운동 등록 해제 API는 확정된 관련 기록 삭제 후 귀속 해제 정책에 따라 별도 runtime 계약으로 추가한다. 삭제 중에는 귀속을 유지해 타 계정 재등록을 막고 정리 완료 뒤에만 해제를 알린다.
- DB transaction에서 tenant command lock, consent row lock, UUID claim lock/unique 제약의 순서를 정한다. A/B 동시 등록·철회·말소·배치 수신이 직렬화되어야 한다. RLS만으로 전 계정 uniqueness를 판단할 수 없으므로 좁은 SECURITY DEFINER 경계 또는 DB 전역 unique 제약을 사용하고, 함수 권한·search_path·타 계정 존재 비공개를 검증한다.
- 배치 수신은 모든 upsert/delete UUID가 현재 계정의 활성 등록이며 해당 등록 epoch가 유효함을 거래 안에서 확인한다. 이 확인과 receipt/raw 저장은 같은 transaction이다. 삭제 이벤트는 등록 UUID에만 허용하고, 기존 tombstone은 지연 upsert로 부활하지 않는다. 등록 해제는 미ACK outbox와 raw/lineage/HealthKit 소유 Activity·파생 자료 정리가 완료된 뒤 귀속을 해제하는 수명주기를 구현·검증한 뒤 제공한다.

### R2. 기존 자료 이행과 재설치 복구

- 배포 전 전체 `healthkit_workout_sample`과 receipt에서 동일 UUID의 계정 중복, legacy 수신, tombstone/동의 상태를 비식별 건수로 감사한다. 이전 raw 행은 계정 귀속을 입증하지 못하므로 **자동 claim backfill 금지**. 충돌·불확실 행은 검토/격리하고, 기존 canonical 연결과 삭제 억제에 미치는 영향을 별도로 조사한다. 필요한 정리는 사용자 선택 및 기존 삭제 계약에 따라 진행한다.
- 서버 원장이 재설치 후 권위 있는 등록 목록이다. native는 로그인·동의 확인 뒤 해당 계정 목록을 내려받고, 확인된 UUID만 로컬 보호 저장소에 재구성한다. 서버에 닿지 않거나 응답이 모호하면 새 수집·등록·전송은 중단한다. 계정 A의 기존 미ACK outbox는 A의 로컬 파일에 유지하고 B 세션에서는 읽거나 전송하지 않는다.
- 로컬 등록 목록과 cursor/outbox의 전환은 원자화한다. UUID 추가·해제·epoch 변경 때 기존 predicate용 anchor를 다른 predicate에 재사용하지 않는다. 권한 미확인/빈 page가 서버 tombstone을 생성하지 않는다. 재설치 전에 유실된 미전송 삭제는 조회 결과만으로 복원했다고 주장하지 않는다.

### R3. native 선택·등록·수집

- 사용자가 제품 계정과 서버 HealthKit 동의를 확인한 뒤 별도의 명시적 운동 읽기 요청을 수행한다. native 선택 화면은 HealthKit에서 제한된 목록을 **기기 안에서만** 조회하고 운동 종류·시각 등 필요한 최소 요약을 보여 준다. 목록 표시와 등록/업로드는 별개의 액션이다. 선택 전 원본 운동·UUID를 서버나 WebView에 보내지 않는다. 개인 운동이 있는 현재 기기를 검증 기기로 사용하지 않는다.
- 선택한 UUID는 온라인 서버 등록 ACK 뒤에만 collector의 허용 목록에 들어간다. collector의 observer/anchored query는 등록 UUID predicate로만 구성한다. UUID 목록을 bounded chunk로 나눌 경우 chunk별 predicate·anchor를 관리하고 등록 변경/재설치/동의 재시작 시 cursor 규칙을 명시한다. unscoped `predicate: nil`로 fallback하지 않는다.
- 살아 있는 `HKWorkout`은 UUID가 현재 계정 등록 목록에 있으며 출처/측정값 계약을 통과할 때만 upsert한다. `HKDeletedObject`는 metadata/source를 추론하지 않고 UUID 등록 목록과 정확히 대조해 tombstone을 만든다. 사용자 선택 취소·계정 전환·철회·인증 실패와 진행 중 query callback의 generation을 검사한다. 등록/동의 실패, 상태 손상, stale epoch에서는 fail closed다.
- WebView bridge는 선택 시작·제한된 건수/상태만 제공한다. UUID·anchor·토큰·원본·정밀 시각은 native 경계 안에 둔다. account panel은 선택 대기, 등록 중, 등록 완료, 동기화 보류/충돌, 권한 미확인, offline, 철회 상태를 구분한다. 키보드·VoiceOver·비터치 대안을 제공한다.

## 제안 작업 그래프 (기존 M3-02h 전에 추가할 하위 노드)

| 노드                    | 선행                          | 산출물·주 소유 파일                                                                                                                         | 완료 조건                                                                                                         |
| ----------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| M3-02j 정책·계약        | 사용자 결정 완료              | 등록/삭제 보존 계약, `packages/contracts/src/healthkit-*.ts`, `native-bridge.ts`, 계약 테스트                                               | 선택 선언·계정 말소/재등록·epoch·오류 코드·구형 앱 정책을 명시; 계약 검증/consumer typecheck                      |
| M3-02k 서버 gate·원장   | j                             | 새 migration, `packages/server/persistence/src/healthkit-registration.ts`, `healthkit-ingestion.ts`, 실DB 테스트                            | 무등록 v1 거절, 전역 단일 owner, 동시 등록/철회/삭제·RLS·receipt 원자성                                           |
| M3-02l API 경계         | k                             | `apps/api/src/healthkit-registration-routes.ts`, ingestion route, API 테스트                                                                | 등록·조회·해제 bearer/tenant/consent/입력 제한, 정리 후 해제·재등록, 비공개 충돌, 안정적 오류·idempotency         |
| M3-02m native 상태·수집 | l                             | `HealthKitWorkoutCollector.swift`, `HealthKitWorkoutState.swift`, `NativeAuth.swift`, Swift harness                                         | 등록 UUID predicate만 조회, 계정 전환·재설치·삭제·outbox·anchor 검증                                              |
| M3-02n 선택 UX·bridge   | j 계약 및 m native 인터페이스 | `WorkoutNativeBridge.swift`, `packages/platform/src/native-bridge-client.ts`, `packages/modules/identity/src/healthkit-panel*`, 대응 테스트 | 명시 선택/등록·접근성·상태/오류 복구; bridge가 비밀값·UUID를 노출하지 않음                                        |
| M3-02o 통합·안전 배포   | k–n                           | root의 그래프/진행 기록, 통합 검증                                                                                                          | legacy/기존 raw 감사, 서버 선배포·safe rollback, 전체 phase checks와 독립 phase review 후 M3-02h 실기기 gate 준비 |

루트가 shared contract exports, `migrate.ts`, DB 권한, `apps/api/src/product-routes.ts`/`configured.ts`, lockfile, graph/progress를 직렬 통합한다. 개별 구현 에이전트의 파일 소유권은 서로 겹치지 않게 지정한다. 기존 M3-02h는 `M3-02o`에 의존하도록 작업 그래프를 갱신해야 한다. 이 ADR만으로 구현 노드를 완료/검증 상태로 표시하지 않는다.

## 검증·수용 기준

- 계약/API: 유효·무효 UUID/epoch, 과대 요청, 중복·취소·401/403/409, 타 계정 정보 비노출, browser/native bridge allowlist와 로그 redaction.
- 실제 PostgreSQL: A/B 동시 등록 중 정확히 한 계정만 성공; A UUID의 B 등록과 B 배치 거절; 어느 실패에서도 receipt/raw 파생 변경 0; 동일 등록/배치 재호출은 원 결과; 말소·동의 철회 시 A claim/raw/receipt 삭제 후 B의 새 명시 등록 가능; 개별 해제 정리 중 B 등록 거절·정리 완료 뒤 허용; 철회·삭제·지연 upsert·RLS·복원/upgrade·legacy migration 감사.
- 합성 native harness/Simulator: 서버 ACK 전 업로드 0; A 등록 UUID는 B predicate·배치에 0; B 등록 UUID 정상 수집; A 미ACK 본문/ID는 A 복귀 후 그대로 ACK; 등록된 삭제 UUID만 tombstone; 빈/거부/실패 조회로 삭제 추정 0; 목록·predicate 변경과 앱 재시작/재설치의 anchor 처리; 손상·offline·stale consent에서 fail closed.
- UI: 명시 선택/확인과 비선택 데이터 비전송, 로그인/계정 전환, 키보드·접근성, 실패·pending-sync 복구를 자동 시험과 브라우저/Simulator에서 확인한다.
- 실기기 M3-02h: HTTPS·로그인 등 외부 게이트가 열린 뒤 **개인 자료가 없는 격리된 시험 HealthKit 저장소**에서 사용자 허용 합성 표본만 사용한다. 실제 UUID의 등록→upsert→ACK→삭제 tombstone→A/B 전환→offline/reinstall 흐름을 한 표본씩 연결한다. 실행 전까지 모든 실기기 행은 `not_executed`다.

## 참고 현행 경로

- `apps/mobile/ios/App/App/HealthKitWorkoutCollector.swift`, `HealthKitWorkoutState.swift`, `HealthKitWorkoutDebugProbe.swift`
- `packages/contracts/src/healthkit-ingestion.ts`, `native-bridge.ts`
- `packages/server/persistence/src/healthkit-ingestion.ts`, `migrations/059_healthkit_ingestion.sql`
- `apps/api/src/healthkit-ingestion-routes.ts`, `packages/modules/identity/src/healthkit-panel.tsx`
- [M3-02h](../progress/M3-02h.md)의 개인 iPhone 실행 금지와 계정 교차 수용 gate
