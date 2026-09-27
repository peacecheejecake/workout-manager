# M0-06c native host keyboard/Back 후속 · 2026-09-27

기준: `phase/m0-06c`, 시작 main `53563e3a262934b3df672b758051a47754355112`.
이 문서는 기존 [M0-06c 관측](M0-06c.md)을 수정하거나 과거 실패를 통과로 바꾸지 않는다.
제품 native host 통합은 사용자 결정에 따라 M3-01 범위다.

## 이번 probe 변경

- `SceneDelegate.swift`의 native host가 키보드 프레임과 WebView의 교차 높이를 구해 스크롤 inset에 반영한다. 키보드 표시와 표시 중 프레임 변경·회전 뒤 포커스된 입력 컨트롤을 보이는 `visualViewport` 안으로 스크롤하고, 키보드가 닫히면 원래 inset을 복원한다. Back 버튼도 native keyboard layout guide 위에 둔다.
- WebKit의 자동 back-forward edge gesture를 끄고 native 왼쪽 가장자리 제스처와 접근성 이름이 있는 native Back 버튼을 둔다. 입력 전 포커스 시점의 값을 WebView 메모리에서 기준으로 잡고 현재값이 다르면 변경사항 폐기 확인을 표시한다. 취소하면 머무르고 이동을 선택해야 `goBack()` 한다. 입력값·화면 문자열은 로그에 남기지 않는다.
- 이 변경은 feasibility probe에만 적용한다. 저장 완료 시점·서버 초안 상태·contenteditable 편집기의 정확한 dirty 계약과 제품의 Back UI는 M3-01에서 정해야 한다.

## 실행 증거와 한계

- `pnpm install --frozen-lockfile`은 registry DNS `ENOTFOUND`로 완료하지 못했다. 기존 main 작업 공간의 설치된 도구를 사용해 집중 Vitest 2파일·3시험을 실행했고 통과했다. JavaScript dirty 판정과 가로 화면의 포커스 이동 계산을 합성 DOM에서 검증했다.
- Xcode 27.0에서 Swift 구문 검사와 `swift-format lint --strict`가 통과했다. 임시 Capacitor 프로젝트 `prepare`에 성공했고, **unsigned iOS device 대상 빌드가 `BUILD SUCCEEDED`, error 0**으로 끝났다. 첫 sandbox 빌드는 SwiftPM/Clang cache 쓰기 거부로 실패했으며 접근 가능한 실행 환경에서 다시 빌드했다.
- `devicectl list devices`는 sandbox 안에서 CoreDeviceService 초기화 timeout이었다. 접근 가능한 환경에서 목록 조회는 성공했으나 등록된 physical device의 tunnel이 `unavailable`, 개발 서비스가 비가용이었다. 수정 앱의 서명·설치·가로 한국어 입력·Back 제스처/버튼 조작은 **not_executed**다. unsigned 컴파일과 합성 DOM 시험은 가로 가림 해소의 실기기 증거가 아니다.
- Aside CLI 업데이트는 `fetch failed`였다. 브라우저 검사는 native WKWebView 키보드·제스처의 대체 증거가 될 수 없다.

## 실기기에서 이어서 확인할 항목

1. 연결 기기의 개발 서비스가 복구되면 수정된 probe를 서명·설치한다. 세로·가로에서 한국어 메모를 입력하고 포커스/키보드 전환 때 입력란과 caret, Back 버튼의 가시성을 사람 관찰과 probe 기록으로 함께 확인한다.
2. 실제 내비게이션 이력이 있고 현재 화면에 미저장 입력이 있을 때 edge 제스처와 버튼을 각각 눌러 확인 표시, 취소 후 초안 보존, 이동 후 Back을 확인한다. 입력이 없을 때는 바로 이동하는지 확인한다.
3. HealthKit 표식 있는 합성 표본 쓰기·삭제 및 background delivery는 사용자 허용을 받았지만 이 변경에서 실행하지 않았다. 별도 bounded 실행 결과가 생기기 전까지 `not_executed`다.

## HealthKit 합성 표본·background delivery 후속 · 2026-09-27

사용자가 앱 표식이 있는 합성 표본 쓰기·삭제와 background delivery 실행을 허용했다. 기존 건강 기록은 읽거나 내보내지 않는 범위를 유지한다. 이번에는 실행용 probe 경로를 보강했으며, **실기기의 HealthKit 작업은 수행하지 않았다**.

- 합성 심박수 1건과 걷기 운동 1건은 2001-01-01 UTC에 `WMSyntheticProbe=M0-06c` 및 실행별 `WMProbeRunID`를 붙인다. 추가 중 한 유형이 실패하면 같은 실행 ID의 표식 있는 표본만 삭제를 시도한다.
- sample query와 삭제는 probe 앱의 `HKSource.default()`와 표식을 함께 요구한다. anchored·observer query는 그 범위와 영속적으로 추적한 앱 표본 UUID만 대상으로 한다. 최대 100개 변경씩 읽는다. v1/v2의 이전 범위 anchor·outbox는 v3로 전환하면서 버리고 이력 공백을 명시한다.
- `cleanup` 단계는 두 유형의 background delivery 해제와 앱 자신의 표식 있는 표본 삭제를 반복 실행할 수 있다. enable 중 일부 유형이 실패하면 모두 해제를 시도한다. 해제나 rollback이 실패할 가능성이 있으면 다음 시작에서도 observer를 등록하고 정리를 다시 시도하도록 상태를 보존한다. 결과는 API 호출 성공과 표식 query의 빈 결과를 따로 기록한다. HealthKit은 앱에 읽기 허용 여부를 알려주지 않으므로 빈 query만으로 완전 삭제를 단정하지 않는다.
- [Apple의 observer query 지침](https://developer.apple.com/documentation/healthkit/executing-observer-queries)에 맞춰 앱 시작 시 observer를 등록하고 변경 처리 후 completion을 호출한다. [Apple의 삭제 객체 설명](https://developer.apple.com/documentation/healthkit/hkdeletedobject/metadata)에 따르면 사용자 정의 metadata는 삭제 객체에 남지 않으므로, 표식 있는 추가 객체의 UUID를 anchor·outbox와 같은 상태 파일에 저장해 삭제 UUID와 대조한다. Simulator는 background delivery 증거가 아니다.

검사: Swift 구문·`swift-format lint --strict`, ESLint·Prettier·diff check, 범위/driver 집중 Vitest 2파일·8시험 통과. 임시 Capacitor `prepare`가 수정된 Swift 소스 SHA-256 `08dec3899c501590d6b37aa93e4cc0dbb52f1974f09e10ca31df47dc729f6185`을 복사했고 Xcode 27.0의 **unsigned device 빌드가 `BUILD SUCCEEDED`, error 0**이었다. 물리 기기는 목록에 1개 있으나 tunnel `unavailable`, developer services `false`여서 서명·설치·`add`·`collect`·`delete`·`cleanup`·background wake-up은 **not_executed**다. 이 컴파일 및 합성 시험으로 HealthKit 기능 통과를 판정하지 않는다.

## 독립 phase 검토 지적 수정 · 2026-09-27

1차 독립 검토는 main `17982f2` → phase `f9c9040`에서 **CHANGES_REQUESTED**였다. 아래 FIXED는 현재 코드와 집중 시험에 대한 구현자 확인이며, phase 재검토 승인이나 실기기 수용 판정이 아니다.

| 지적                                          | 현재 판정·근거                                                                                                                                                                                                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 삭제 객체의 사용자 정의 metadata 소실         | **FIXED** — 표식 있는 추가 UUID를 v3 state에 보관하고, anchor·outbox와 함께 갱신한다. 변경 query는 표식 또는 알려진 UUID로만 좁히고, 삭제 UUID를 보관된 UUID와 대조한다. `delete`는 삭제 전후 collect를 수행한다. v1/v2 anchor·outbox는 재사용하지 않고 `migrationHistoryIncomplete`를 노출한다. |
| React 제어형 textarea의 `defaultValue` 동기화 | **FIXED** — 포커스·pointerdown에서 현재 입력값을 WebView 메모리 기준으로 저장하고 native Back은 원문을 받지 않는 boolean 판정만 조회한다. 회귀 시험에서 React가 `value`와 `defaultValue`를 함께 바꿔도 확인 판정이 유지되고 원복 시 사라짐을 확인했다.                                           |
| 열린 키보드 상태에서 프레임 변경·회전         | **FIXED** — `keyboardDidChangeFrameNotification`에도 포커스 reveal을 실행하고, `willChangeFrame`의 지연 재확인은 가장 최근 키보드 프레임을 사용한다. 집중 시험은 해당 이벤트와 가로 viewport 계산을 확인한다.                                                                                    |

수정 후 `swift-format lint --strict`, Swift 구문 검사, ESLint·Prettier·diff check, 집중 Vitest 4파일·11시험 통과. 임시 Capacitor `prepare`는 `AppDelegate.swift` SHA-256 `8fe882c2944a30e8f7fec4d31e8174565b5623ce5b4c69cf949d826d177fecbc`, `SceneDelegate.swift` SHA-256 `f8cdfe72daedbc856c9a402657b6c2f3d4438dcc8e17f463cf41d6293c9dc1ae`를 복사했다. Xcode 27.0 unsigned iOS 빌드 **BUILD SUCCEEDED**, error 0. 실기기 목록은 물리 기기 1개, tunnel `unavailable`, 개발 서비스 비가용으로 재확인했다. 수정 앱의 서명·설치, 가로 IME·Back 사람 조작, HealthKit 추가·수집·삭제·정리·background wake-up은 모두 **not_executed**다.

## 2차 독립 phase 검토 지적 수정 · 2026-09-27

2차 읽기 전용 검토는 main `17982f2` → phase `23943d5`에서 **CHANGES_REQUESTED**였다. 이전 Back·키보드 지적은 검토자가 FIXED로 판정했다. 아래는 새 수정의 구현자 점검이며, 독립 재검토 승인이나 실기기 HealthKit 통과 판정이 아니다.

| 지적                                                       | 현재 판정·근거                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 수집 뒤 observer의 UUID 범위 미갱신                        | **FIXED** — 수집 전후의 표식 UUID 집합이 달라지면 상태 파일을 먼저 저장하고 기존 observer를 중지한 뒤 새 UUID predicate로 등록한다. 직접 `collect`와 background callback 모두 같은 경로를 쓴다.                                                                               |
| `collect`/`remember`/`send`/delivery 설정 간 상태 덮어쓰기 | **FIXED** — `ProbeStateGate`가 HealthKit await를 포함한 네 영속 상태 전환 전체를 직렬화한다. 추가 표본의 UUID 보관도 이 gate를 통과한다.                                                                                                                                      |
| 100건 뒤 중단 또는 실패 후 completion                      | **FIXED** — anchored query를 변화가 100건 미만인 페이지까지 반복하고 anchor 진행이 멈추면 실패시킨다. 어느 유형에서라도 실패하면 anchor·outbox 파일을 저장하지 않는다. observer는 파일 저장까지 성공한 경우에만 `completion()`을 호출하며, 실패는 retry 대기 사실로 기록한다. |

검사: Swift 구문·`swift-format lint --strict`, Node 24 ESLint, Prettier, diff check, 집중 Vitest 3파일·7시험 통과. 임시 Capacitor `prepare`가 수정 `AppDelegate.swift` SHA-256 `85fd476b863d7dbdbd9ba2805b3f84c4bcec647c6936f85e0d825e695d68e8f6`을 복사했고 Xcode 27.0의 **unsigned iOS device 빌드가 `BUILD SUCCEEDED`, error 0**이었다. 연결 목록의 physical iPhone은 `unavailable`, tunnel `unavailable`이므로 서명·설치 및 HealthKit 추가·수집·삭제·정리·background wake-up은 **not_executed**다. 소스 구조 시험과 빌드는 실기기 수집·재시도 동작의 증거가 아니다.

## 3차 독립 phase 검토 지적 수정 · 2026-09-27

3차 읽기 전용 검토는 main `17982f2` → phase `3895299`에서 **CHANGES_REQUESTED**였다. 2차의 UUID observer 갱신·상태 직렬화·전체 페이지 수집은 검토자가 FIXED로 판정했다. 아래 FIXED는 새 코드에 대한 구현자 점검이고, 독립 재검토 승인이나 실기기 수용 판정이 아니다.

| 지적                                                | 현재 판정·근거                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 실패한 수집의 영속 재시도 부재                      | **FIXED** — HealthKit query 전에 `collectionPending=true`를 상태 파일에 원자적으로 저장하고, 성공한 anchor·outbox 저장과 함께 해제한다. observer는 최대 2회 즉시 시도하고, 수집이 계속 실패해도 영속 pending이 확보된 경우에만 completion을 호출한다. 앱 시작과 foreground 복귀에서 pending 또는 활성 background delivery를 다시 수집한다. pending 기록 자체가 실패하면 completion을 보류하고 로그에 남긴다. |
| 사전 수집 실패 뒤에도 삭제 진행                     | **FIXED** — `deleteSynthetic`은 사전 수집의 영속 성공을 확인하지 못하면 HealthKit 삭제 API를 호출하지 않고 `deletionBlocked=preDeleteCollectionFailed`를 반환한다. 강제 삭제 경로를 추가하지 않았다.                                                                                                                                                                                                         |
| background delivery 해제 실패 후 재시작 재시도 부재 | **FIXED** — enable/disable의 OS 호출 전에 `backgroundCleanupPending=true`를 저장한다. 해제 또는 enable rollback 실패 시 pending을 유지한다. 시작·foreground 복구에서 해제를 재시도하고 성공 시 pending을 해제한다.                                                                                                                                                                                           |

직전 addendum의 “수집 성공 시에만 completion” 설명은 이 변경으로 **수집 성공 또는 영속 retry 작업 기록 성공 시에만 completion**으로 갱신된다. 실제 HealthKit 호출과 OS 재기동/foreground 복구는 연결된 물리 기기에서 검증해야 하므로 **not_executed**로 유지한다.

검사: Swift 구문·`swift-format lint --strict`, Node 24 ESLint, Prettier, diff check, 집중 Vitest 3파일·9시험 통과. 임시 Capacitor `prepare`는 `AppDelegate.swift` SHA-256 `ee5a91068c8a7979f679ca3591b9e86ad2c6ee9587030c2223c94d0402fe80f3`과 `SceneDelegate.swift` SHA-256 `2d770ac8a38345f8328c51734922ada8ef11a68bb167481ad8dac9a761a7f91d`를 복사했다. Xcode 27.0 unsigned iOS device 빌드 **BUILD SUCCEEDED**, error 0. 물리 iPhone은 다시 `unavailable`로 조회되어 서명·설치와 모든 실기기 HealthKit·keyboard·Back 조작은 **not_executed**다.

## 4차 독립 phase 검토 지적 수정 · 2026-09-27

4차 읽기 전용 검토는 main `7d54934` → phase `6e3d3f4`에서 **CHANGES_REQUESTED**였다. 앞선 지적은 검토자가 모두 FIXED로 판정했다. 새 지적의 구현자 판정은 다음과 같으며, 독립 재검토 승인이나 실기기 수용 판정이 아니다.

| 지적                                                       | 현재 판정·근거                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 복구 작업이 이후 명시적 background enable을 취소할 수 있음 | **FIXED** — `ProbeStateGate.retryPending`이 pending 상태를 같은 직렬 구간 안에서 다시 읽고, 여전히 필요할 때만 `setBackgroundDeliveryExclusive(false)`를 호출한다. 명시적 enable이 먼저 완료되면 복구는 건너뛴다. 복구가 먼저 실행되면 뒤의 enable이 최종 상태가 된다. 별도 Swift 동시 실행 시험에서 두 순서를 강제로 만들어 확인했다. |

실제 기기의 서명·설치, background delivery 재시작·foreground 복구, HealthKit 표본 변경과 keyboard/Back 조작은 여전히 **not_executed**다.

검사: Swift 구문·`swift-format lint --strict`, Node 24 ESLint·Prettier·diff check, 집중 Vitest 3파일·9시험, 실제 `ProbeStateGate` 코드를 추출해 실행한 Swift 동시 순서 시험 2경우가 통과했다. 임시 Capacitor `prepare`는 `AppDelegate.swift` SHA-256 `6e6281411d3793dca764cd04488de2c07239949ed15fb52d28bbc78177477bd4`를 복사했고 Xcode 27.0 unsigned iOS device 빌드 **BUILD SUCCEEDED**, error 0. 물리 iPhone은 이번에도 `unavailable`로 조회되어 실기기 결과는 추가되지 않았다.

## Codex 독립 phase review 최종 판정

Codex CLI `gpt-6-sol` high/read-only가 `main`
`7d54934a58862f3f2d8edc016a7e1f0b010ae82a` → `phase/m0-06c`
`76011606a12aea81e170abf9149f53c0e959980f` 전체 diff를 검토해
**APPROVE**했다. 4차 검토의 복구·활성화 경합 P2는 **FIXED**이며 새 지적은 없다.
기존 표식 UUID·삭제/observer 범위, 상태 직렬화, 전체 페이지 수집·영속 재시도,
삭제 전 수집 차단, background 정리 재시도, React 제어형 Back, 키보드 회전 경로에서도
회귀를 발견하지 못했다. 검토자는 `git diff --check`와 Swift SHA를 직접 확인하고
제시된 검사·집중 시험·unsigned 빌드를 근거로 삼았다. 실기기 서명·설치와 HealthKit·IME·Back·
background wake 검증은 모두 **not_executed**이며 M0-06c 노드는 `in_progress`다.

## 연결된 iPhone 실기기 후속 실행 · 2026-09-27

이 절은 위 검토 뒤 별도로 수행한 실행만 기록한다. 이전 시점의 `not_executed` 판정을 소급해서 바꾸지 않는다. 연결된 iPhone 15 Pro Max(iOS 27.0, 개발자 모드·터널 연결)의 device ID, HealthKit UUID, 입력 내용은 기록하지 않는다. 원본 실행 receipt와 화면 캡처는 Git 제외 `verification-logs/m0-06c-device/`에만 보관한다.

- `pnpm build` 15/15 통과 후 임시 Capacitor `prepare`를 실행했다. 처음의 `@workout/mobile-web` 단독 빌드는 의존 package의 미생성 `dist` 때문에 실패했다. Xcode 27의 device 빌드는 `BUILD SUCCEEDED`, error 0, codesign 검증 true였다. Apple Development team `XVT9A9T7RP`, HealthKit·background entitlement와 사용 설명 키가 포함된 `org.workoutmanager.feasibility.deviceprobe`를 실제 기기에 설치·실행했다. 앱 SHA-256은 `5fc12aefb3c8d973634f9d63922996ef1ce7238cade699379d417d6c41d70858`이다.
- 빈 기준 실행에서 앱 자신의 표식 있는 심박수·운동 표본은 각각 0건이었다. `add`는 2001-01-01 UTC로 날짜를 정한 합성 심박수·걷기 운동을 각각 1건 저장했고, `collect`는 anchor와 2건의 upsert outbox를 영속화했다. `send`는 이 2건을 로컬 대체 수신함에 기록·확인했다. 사용자 기존 건강 기록은 수집·저장·내보내지 않았다. Query가 거부한 범위 밖 삭제 객체는 처리하지 않았다.
- `enableBackground`는 심박수·운동 두 유형에서 HealthKit OS 호출 `ok`와 영속 상태 `enabled=true`를 반환했다. 앱이 active/inactive일 때 observer callback은 관측됐다. **앱이 중지된 동안 OS가 깨운 background wake는 관측하지 못했으므로 `not_executed`다.** 이후 `disableBackground`와 최종 `cleanup`에서 두 유형의 해제 호출이 `ok`였고, 재시작 뒤에도 `enabled=false`, `cleanupPending=false`였다.
- 첫 표본 쌍의 `delete`는 사전·사후 수집이 영속화되고 HealthKit 삭제 호출이 유형별 1건씩 성공했으며, 앱 표식 query는 이후 각각 0건이었다. `sendBeforeAck`에서 앱을 강제 종료하자 2건의 tombstone이 outbox에 남았다. 재실행 `send`가 둘을 ack했고 로컬 수신함은 중복 키를 만들지 않았다. 빈 query 단독으로 기기 전체에서 표본이 사라졌다고 단정하지 않으며, 삭제 API의 성공도 함께 기록했다.
- 둘째 표본 쌍에서는 `collectBeforePersist`로 강제 종료했다. 재실행 때 `collectionPending`에서 복구해 2건의 upsert를 영속화했고, 같은 서명 앱을 다시 설치한 뒤에도 outbox가 유지됐다. 전송·삭제·tombstone 전송을 끝낸 뒤 `cleanup`의 삭제 호출 성공, 표식 query 0/0, outbox 0을 확인했다. 최종 cold launch의 상태도 정리 대기 없음이었고, 별도로 다시 실행한 빈 기준 단계가 표식 표본 0/0으로 끝났다. 첫 빈 기준 호출은 이어진 재실행으로 중단되어 성공 증거에 넣지 않았다. 수신함은 로컬 대체 구현이며 서버 동기화 증거가 아니다.
- 세로 화면은 기기 캡처에서 확인했다. 가로에서는 probe 기록에 viewport 932×430, 키보드 열린 `visualViewport` 높이 172, 포커스 입력란 아래쪽 85, focus reveal 이벤트 15회와 한국어 입력 길이 변화가 남았다. 사용자는 입력란·커서 가시성과 Back 동작을 정상으로 보고했다. 기록에는 `unsavedInput=false`인 Back 시도만 있고 dirty Back 확인창의 선택·취소·이동 이벤트는 없다. 따라서 **가로 입력의 기기 telemetry와 사용자 관찰은 확보했지만, 미저장 Back 분기의 기계 기록은 미확보**다. 추가 반복 요청 없이 이 한계를 유지한다.
- 기존 `terminate` 명령은 Xcode 27 프로세스 목록에 bundle ID가 없어 `PROBE_PROCESS_IDENTITY_UNAVAILABLE`로 안전하게 멈췄다. 설치 앱 조회의 정확한 bundle ID·실행 파일 URL과 프로세스의 전체 URL을 일치시키도록 driver를 수정했다. 수정 명령은 실제 probe 프로세스 1개만 종료했고 두 번째 호출은 대상 0개였다. 다른 `App.app` 이름의 프로세스를 고르지 않는 회귀 시험을 추가했다.

Aside 업데이트는 `fetch failed`였으므로 native UI 증거는 `devicectl`·기기 캡처·사용자 관찰로 얻었다. sandbox의 첫 device 목록 조회는 CoreDeviceService timeout이었고, 접근 가능한 실행에서 재시도했다. 제품 native host 통합·실제 서버 동기화·실제 background wake는 여전히 별도 범위다. M0-06c는 `in_progress`를 유지한다.

### 실기기 후속 변경의 1차 독립 검토

Codex CLI `gpt-6-sol` high/read-only가 main `a96bfdc1ea240fe616a762bbc22e265e773ee28d` → phase `9f2adaa6006fed87a4254be323182a8dc323815e` 전체 diff를 검토해 **CHANGES_REQUESTED**를 냈다. P2: 프로세스 목록에 실행 파일 필드가 빠진 항목이 있어도 `terminate`가 대상 0개 성공으로 기록했다. 이전의 광범위한 `App.app` 종료 범위는 FIXED였지만, 신원 필드 누락 시 실패 조건은 NOT FIXED였다. 검토자는 실제 영수증을 열거나 실기기 실행을 재현하지 않았고 문서의 background wake·dirty Back 한계 표기는 적절하다고 확인했다.

수정: 실행 파일이 문자열이 아닌 프로세스가 하나라도 있으면 `PROBE_PROCESS_IDENTITY_UNAVAILABLE`로 닫는다. 누락 항목만 있는 목록과 정상 probe 항목에 누락 항목이 섞인 목록을 회귀 시험에 추가했다. 집중 Vitest 6/6, ESLint, Prettier, 구문·diff 검사가 통과했다. 수정 명령을 iPhone에서 다시 실행해 정확히 probe 프로세스 1개만 종료했고 이후 앱을 다시 실행했다. 이는 구현자 수정이며 다음 독립 재검토의 FIXED 판정을 기다린다.

2차 읽기 전용 검토는 같은 main `a96bfdc` → phase `22f00f3` 전체 diff에서 **CHANGES_REQUESTED**였다. 1차의 누락·비문자열 필드 P2는 FIXED로 판정했지만, `executable: ""`가 대상 0개 성공으로 기록되는 새 P2가 남았다. 구현자는 빈 문자열과 공백만 있는 문자열도 신원 확인 실패로 닫고, 단독·정상 probe와 혼합된 두 경우를 회귀 시험에 추가했다. 새 변경의 독립 재검토는 별도로 받는다.

3차 Codex CLI `gpt-6-sol` high/read-only 검토는 main `a96bfdc1ea240fe616a762bbc22e265e773ee28d` → phase `03fc839be5c815be3fd2d787b9b39040b9b480f5` 전체 diff에 **APPROVE**했다. 앞선 누락·비문자열 필드와 빈 문자열·공백 값 지적을 모두 **FIXED**, 광범위한 `App.app` 종료 범위와 이전 Swift·Back·키보드 지적도 FIXED 유지로 판정했다. 검토자가 직접 확인한 것은 구문·diff 검사이며, 기기 실행 receipt는 개인정보 보호를 위해 열지 않았다. 그 검토 중 다른 작업의 승인된 Garmin·출시 범위 문서가 main `d75fc94`까지 반영됐다. 이 phase에는 HANDOFF 충돌을 두 변경 모두 보존해 해결하고 새 main을 통합했다. 새 main 기준 diff는 다시 독립 검토한다.

새 main 기준 Codex CLI `gpt-6-sol` high/read-only 검토는 `d75fc94a34c549c6aa95b31dc32f202c8b009f6f` → `5ad1abd44b47faf484b5884e51313487b68ef8e7`의 4파일 전체 diff에 **APPROVE**했다. 이전 프로세스 신원 지적 모두 FIXED 유지, Swift HealthKit·키보드·Back 변경의 회귀 지적 없음, Garmin 이관과 `G2-PUBLIC` 보존을 확인했다. 검토자가 직접 수행한 것은 두 파일의 구문 검사와 diff check이고, 집중 시험·실기기 실행은 기록된 보고로 검토했다. 이 결과 기록을 더한 문서 변경은 별도 검토 refresh를 받는다. M0-06c는 실제 background wake와 dirty Back 기계 기록이 남아 `in_progress`다.

## 실제 background wake 재시도 · 2026-09-27

연결된 iPhone의 기존 서명 probe를 사용했다. 원본 영수증은 Git 제외 `verification-logs/m0-06c-device/pulled/`에 보관하고, 기기 식별자·HealthKit UUID·입력 내용은 기록하지 않는다.

- `enableBackground`에서 심박수·운동 유형의 OS 호출이 각각 `ok`, 영속 상태가 `enabled=true`, `cleanupRequired=false`였다. `add`는 2001-01-01 UTC의 표식 있는 합성 심박수 61회/분과 걷기 운동을 각 1건 저장했다. own-source 추적 수는 각 1건이었고 observer callback은 이때 **active** 상태에서만 기록됐다.
- 사용자가 Health 앱에서 출처가 WM Device Probe인 해당 심박수 1건을 삭제하고 Health 앱에 머물렀다. probe의 `didEnterBackground`는 04:58:25 UTC였다. 05:00:15, 05:01:24, 05:03:04 UTC에 기기 영수증을 가져왔으나 새 `launch`나 background `observerCallback`은 없었다. 05:03:35 UTC의 명시적 `devicectl launch collect` 뒤 `collectionRecovery`가 심박수 tombstone **1건**을 영속화했고 심박수 추적 수가 0건으로 바뀌었다. 삭제 변경은 확인됐지만 **OS에 의한 실제 background wake는 관측되지 않았다**. 명시적 launch를 wake 근거로 계산하지 않는다.
- `cleanup`에서 background delivery 두 유형 해제가 각각 `ok`, 표식 운동 1건 삭제 호출 성공, 최종 표식 query 심박수·운동 **0/0**, 정리 대기 `false`를 확인했다. 로컬 대체 수신함 전송 후 outbox도 **0건**이다. 사용자 기존 건강 기록은 읽거나 내보내지 않았다.

이번 재시도는 wake 조건을 실제로 시도했으나 수용 증거를 얻지 못했다. 원인은 OS 지연·삭제 알림 조건·probe 관측 한계 중 확정하지 않는다. `M0-06c`는 **in_progress**이고, 실제 background wake 수용과 미저장 Back 분기의 기계 기록은 여전히 미확보다. 과거 `not_executed`를 통과로 소급 변경하지 않는다.

독립 Codex CLI `gpt-6-sol` high/read-only phase 검토는 `main` `692d9ab927faec5cae23b55ff97c572ef6cafad1` → `phase/m0-06c` `a5d65363868bdea48fae4a86c8788ef10f72c152` 전체 diff를 **APPROVE**했고 지적 사항은 없었다. 검토자는 문서·상태·개인정보 표시와 변경 파일을 대조했으며, Git 제외 원본 기기 영수증을 읽거나 OS wake를 독립 재현하지 않았다. 이 검토 기록을 추가한 최종 diff는 별도로 refresh 검토한다.

## 별도 서명 작성 앱으로 실제 wake 확인 · 2026-09-27

사용자가 별도 시험용 표본 작성 앱 경로를 선택했다. `WM Wake Writer`는 HealthKit 심박수 **쓰기 권한만** 요청하고 기존 표본 읽기 권한은 요청하지 않는다. 앱 자신의 출처와 `WMWakeWriter=M0-06c` 표식이 모두 맞는 표본만 삭제한다. probe에는 이 고유 표식만 감지하는 별도 심박수 observer를 추가했다. 이 observer는 callback 시각·앱 상태만 기록하고 작성 앱 표본을 조회하거나 내보내지 않는다. 앱 둘의 원본 영수증은 Git 제외 `verification-logs/m0-06c-device/` 및 `verification-logs/m0-06c-writer/`에 남겼다.

- Xcode 27.0에서 probe와 writer의 iPhone용 서명 빌드가 각각 `BUILD SUCCEEDED`, error 0, codesign 검증 true였다. probe 서명에는 HealthKit/background delivery entitlement, writer 서명에는 HealthKit entitlement만 있었다. 각 bundle ID를 확인한 뒤 연결된 iPhone에 설치했다. 작성 앱의 권한 요청은 사용자 승인과 앱의 `requestCompleted=true`를 확인했다.
- probe의 심박수·운동 background delivery OS 호출은 각각 `ok`, 영속 상태 `enabled=true`, 정리 대기 `false`였다. 05:28:28 UTC에 정확한 probe 프로세스 **1개**를 종료했다. writer는 05:28:42 UTC에 2001-01-01의 표식 있는 합성 심박수 **1건 저장 성공**을 기록했다. 이 사이와 다음 영수증 조회 사이에 probe를 명시적으로 실행하지 않았다.
- probe는 05:28:57 UTC에 새 launch ID로 `appState=background`인 시작과 `writerObserverCallback`의 `appState=background`를 기록했다. 이는 별도 앱의 실제 표본 작성 뒤 OS가 probe를 깨운 **이 시험 범위의 실기기 증거**다. 앞선 Health 앱 삭제 자극에서 wake를 관측하지 못한 기록은 그대로 유지한다. 제품 앱의 장기 안정성이나 임의 HealthKit 변경의 전면 수용으로 확대하지 않는다.
- writer의 정리 호출은 표식 있는 자체 표본 **1건 삭제 성공**, 반복 정리는 **0건**이었다. probe의 정리는 심박수·운동 background delivery 해제가 각각 `ok`, 자체 표식 query 잔여 **0/0**, 정리 대기 `false`였다. writer 앱은 영수증을 가져온 뒤 기기에서 제거했다. 원래 있던 건강 기록은 조회하거나 내보내지 않았다.

이번 실행으로 M0-06c의 서명·권한·실기기 HealthKit·실제 background wake feasibility 범위는 검증됐다. 가로 한국어 입력과 Back 동작은 앞선 기기 계측·사용자 확인을 근거로 하되, **미저장 Back 확인창의 버튼별 기계 기록은 없다**. 사용자가 추가 반복을 원치 않아 이 한계를 명시하고 제품 native host의 정확한 Back 계약·통합은 M3-01로 넘긴다. 이전 시점의 `not_executed`는 소급 변경하지 않는다.

검사: Swift 구문·`swift-format lint --strict`, 전체 `pnpm check:generated`·`format:check`·`lint`, 집중 Vitest **3파일·10시험**, 두 앱의 실기기 서명 빌드와 실제 wake/정리 실행이 통과했다. Phase 전체 `pnpm install --frozen-lockfile --offline`은 로컬 저장소에 Fastify tarball이 없어 실패했고, 온라인 재시도도 registry DNS `ENOTFOUND`였다. 이에 따라 전체 `build`는 package별 의존성 부재, `typecheck`는 `@workout/contracts/routing` 해석 실패, `test`·`test:integration`은 `zod` 부재로 실패했다. `test:identity` 2회도 웹 서버의 `zod` 부재로 시작 전 실패했다. 이 전체 검사들을 통과로 계산하지 않는다. 집중 시험·Swift 빌드·실기기 관측의 성공 범위와 분리한다.

### 이번 phase 독립 검토

Codex CLI `gpt-6-sol` high/read-only가 main base `09cdcf1b3bd25751084c60eae2449417cc2d201e` 대비 phase HEAD `34982ae4e5230d5cee7bf144f6d596ff90267737` 전체 diff를 **APPROVE**했다. 선행 검토의 문서 시점 혼동, HANDOFF의 wake 미실행 안내, 완료된 EXT-BACKCHANNEL·P8 결정을 다음 작업으로 제시한 지적은 모두 **FIXED**로 재확인됐고 새 차단 지적은 없다. 검토자가 직접 확인한 검사는 `node --check`, 그래프 JSON 파싱, `git diff --check`다. Git 제외 원본 기기 영수증은 열지 않았고 전체 workspace 설치·build·typecheck·test·integration·identity의 실패를 통과로 간주하지 않았다. 이 검토 기록 추가분은 별도 refresh 대상이다.

## 전체 검사 후속 진단 · 2026-09-27

이 항목은 위 시점의 설치·전체 검사 실패를 소급 변경하지 않고, 별도 실행 결과를 추가한다. 설치 의존성이 있는 main 작업 공간에서 Node 24.12.0으로 `pnpm check:generated`, `pnpm build`(15/15), `pnpm typecheck`(34/34, 캐시 33개), PostgreSQL을 사용한 `pnpm test:integration`(81파일·804시험)이 통과했다. `pnpm test`는 첫 전체 실행에서 339파일 중 334파일이 통과하고 5파일이 실패했다. 로컬 서버를 쓰는 실패 파일은 접근 가능한 환경의 집중 재실행에서 통과했다. 남은 GraphHopper 검사 지연은 Git 제외 검증 로그와 지도 빌드 작업 폴더를 파일 탐색에서 제외한 뒤 집중 17/17이 통과했다. Prettier·ESLint가 중첩 worktree와 검증 로그를 훑지 않도록 범위를 바로잡은 phase 작업 공간의 `pnpm format:check`와 `pnpm lint`도 통과했다. 이 수정 뒤 **전체 `pnpm test` 재실행은 아직 하지 않았다**.

`pnpm test:identity`는 다른 phase의 개발 서버가 로컬 포트 3100·4200·4300을 사용 중이어서 시작 전 중단됐다. 다른 phase 서버로 시험하거나 서버를 종료하지 않았다. 따라서 요구된 2회 인증 시험은 **not_executed**이며, 포트가 해제된 뒤 별도로 실행해야 한다. 별도 phase 작업 공간의 `pnpm install --frozen-lockfile`은 여전히 registry 접근 제한 때문에 완료되지 않았고, 설치 성공으로 기록하지 않는다.

### Identity E2E 대체 포트 후속

사용자 요청으로 identity E2E의 웹·모바일·API·OIDC·Garmin fixture 포트를 각각 환경변수로 바꿀 수 있게 했다. 기본값 3100/4200/4300/4400/4500은 유지하고, 중복·범위 밖 포트는 시작 전에 거부한다. 브라우저 시험의 절대 주소와 provider redirect/CORS 주소도 같은 포트 설정을 사용한다. Next API 프록시가 빌드 결과에 포함되므로 바꾼 API origin으로 해당 작업 공간을 다시 빌드해야 한다.

별도 phase 작업 공간에 main의 설치 의존성을 로컬 복사해 사용했다. `WORKOUT_IDENTITY_*_PORT=3110/4210/4310/4410/4510`, `API_ORIGIN=http://127.0.0.1:4310` 설정에서 Node 24.12.0 루트 TypeScript 검사, Playwright 시험 목록 110파일·314시험 로드, 전체 빌드 15/15, 실제 OIDC 브라우저 시험 **2/2 통과**를 확인했다. 기존 phase `pnpm install --frozen-lockfile` 실패는 해결된 것으로 간주하지 않는다. 전체 identity E2E **2회 실행은 아직 하지 않았다**.

## 현재 main 통합 후 전체 검증 · 2026-09-28

후속 코드 `856a32f`·`0217ee9`를 포함한 phase 브랜치에 main `f04bda6870b8e3785918d59450b7a92e1560b254`를 충돌 없이 통합했다. 이 절은 위 과거 실패와 `not_executed`를 소급 변경하지 않고, 새 브랜치 상태의 실행만 적는다.

- Phase 공간의 `pnpm install --frozen-lockfile`은 npm registry DNS `ENOTFOUND`로 다시 완료되지 않았다. 같은 lockfile의 main 공간에 이미 설치된 의존성을 로컬 복사해 이후 검사를 실행했다. 이는 phase 공간의 frozen install 성공이 아니다.
- `pnpm check:generated`, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`(34/34), 대체 API 포트 `4310`으로 다시 빌드한 `pnpm build`(15/15), GraphHopper 집중 17/17이 통과했다.
- 전체 `pnpm test`의 첫 시도는 제한된 샌드박스가 로컬 OIDC·API fixture 수신을 막아 중단했다. 수신 권한을 갖춘 두 번째 시도는 Python 브리지 경로 미설정으로 338파일 통과 뒤 1파일 실패했다. 실제 `WORKOUT_PYTHON` 경로를 지정한 최종 전체 실행은 **339파일·4,131시험 통과, 1파일·7시험 건너뜀**이었다. `pnpm test:integration`은 별도 임시 PostgreSQL에서 **81파일·804시험 통과**했다.
- 대체 포트 첫 전체 `pnpm test:identity`는 **297 통과·13 건너뜀·4 실패**였다. 네 실패는 모두 Garmin 연결 화면이 기존 시험용 `3100 → 4500` 이동만 허용해 새 `3110 → 4510`을 거부한 것이었다. 제품의 공식 Garmin HTTPS 허용은 유지하고, 서버 shell이 전달한 명시적 로컬 포트 쌍만 인정하도록 수정했다. 해당 경계 단위 18/18과 실제 Garmin 브라우저 4/4가 통과했다.
- 수정 후 `pnpm lint`, `pnpm typecheck`(34/34), `pnpm build`(15/15), 전체 `pnpm test`(4,131 통과·7 건너뜀), 전체 `pnpm test:integration`(804 통과)을 다시 실행해 통과했다. 전체 identity E2E는 같은 대체 포트 묶음에서 순차로 **첫 회 301 통과·13 건너뜀·실패 0**, **두 번째 301 통과·13 건너뜀·실패 0**이었다. 각각 14.8분과 15.0분이 걸렸다.

이 검사는 로컬 합성 인증·Garmin fixture와 브라우저만 다룬다. 앞서 기록한 실기기 HealthKit 관찰이나 미저장 Back 버튼별 기계 기록을 새로 수행한 근거가 아니다.

### 현재 main 기준 1차 독립 검토 지적과 수정

Codex CLI `gpt-6-sol` high/read-only는 main base `f04bda6870b8e3785918d59450b7a92e1560b254` → phase HEAD `50474737e0c264658e01433f744c9680a8dc5cea`의 44파일 전체 diff에 **CHANGES_REQUESTED**를 냈다. P2: 웹 포트 또는 Garmin 포트 **하나만** 환경변수로 변경하면 계정 shell이 둘 다 설정된 경우에만 새 포트 쌍을 전달해 정상 fixture 이동을 거부했다. 위 전체 E2E 두 회는 다섯 포트를 모두 바꿨으므로 이 경우를 검증하지 못했다. 과거 프로세스 신원 관련 지적은 현재 코드에서 FIXED로 확인됐고, 다른 이전 지적 중 NOT FIXED로 확인된 것은 없었다. 검토자는 실기기 원본 영수증이나 외부 HealthKit을 재현하지 않았다.

구현자는 명시적으로 바뀐 포트에만 해당 값을 쓰고, 나머지는 각각 기존 `3100`·`4500`을 적용하도록 계정 shell을 수정했다. 수정 후 `WORKOUT_IDENTITY_GARMIN_PORT=4510`만 지정한 실제 Garmin 브라우저 4/4, `WORKOUT_IDENTITY_WEB_PORT=3110`만 지정한 실제 Garmin 브라우저 4/4가 각각 통과했다. 두 경우 모두 로컬 fixture의 네 연결·거절·계정 전환 시나리오를 실행했다. 생성물·포맷·린트, 전체 typecheck 34/34와 대체 API 포트 전체 build 15/15도 다시 통과했다. 이 FIXED 판정은 구현자 검증이며 최종 독립 재검토 결과가 아니다.
