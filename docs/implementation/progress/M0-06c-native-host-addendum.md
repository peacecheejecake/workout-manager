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
