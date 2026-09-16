# Native·HealthKit 선행 조건 조사

조사일: 2026-09-16. 범위: M0-06a 공개 문서·로컬 도구 확인. **M0-06c 실기기 feasibility와 FUT-05/M3 구현·검증은 미완료**다. 이 문서는 구현 규칙 변경이 아닌 조사 증거다.

설계 기준: [FUT-05](../../.pre/06_follow_up_backlog.md#fut-05), [HealthKit 수집·삭제·privacy 경계](../../.pre/04_integrations_metrics_rag.md). 연관 수용 범위는 V2-A04–A06, A26–A30, A47–A50이다.

## 확인한 공식 API 조건

| 항목              | 공식 문서에서 확인한 사실                                                                                                                                                                                                              | 이 저장소에 대한 판단                                                                                                                                                                                                                                                                                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native shell      | Capacitor v8은 WKWebView를 사용하며 iOS 15 이상, Xcode 26 이상을 지원 조건으로 명시한다. Node는 22 이상이다. SPM이 권장되고 CocoaPods는 선택 사항이다.                                                                                 | 설치된 Node/Xcode 버전은 문서상 최소 조건을 충족한다. Capacitor 버전 채택·플러그인 호환·실제 빌드 성공은 미확인이다. [iOS](https://capacitorjs.com/docs/ios), [환경](https://capacitorjs.com/docs/getting-started/environment-setup)                                                                                                                                             |
| 권한과 capability | `com.apple.developer.healthkit` capability와 사용자 유형별 권한이 필요하다. 읽기 설명은 `NSHealthShareUsageDescription`, 쓰기 설명은 `NSHealthUpdateUsageDescription`으로 구분한다.                                                    | 요청할 데이터 유형·읽기/쓰기 범위와 앱의 entitlement/설명 문자열은 아직 생성·검증하지 않았다. 읽기 수집만을 위해 쓰기 동의가 필요하다고 가정하지 않는다. [설정](https://developer.apple.com/documentation/xcode/configuring-healthkit-access), [privacy](https://developer.apple.com/documentation/healthkit/protecting_user_privacy)                                            |
| 읽기 거절         | HealthKit은 읽기 허용·거절 여부를 앱에 확정적으로 알려주지 않는다. `authorizationStatus(for:)`는 저장 권한 상태다.                                                                                                                     | 빈 결과를 권한 거절 또는 실제 0으로 바꾸면 안 된다는 기존 설계를 뒷받침한다. UI의 요청 완료·관측 데이터·미확인 상태를 실험에서 따로 확인할 필요가 있다. [권한 요청](https://developer.apple.com/documentation/healthkit/authorizing-access-to-health-data), [authorizationStatus](<https://developer.apple.com/documentation/healthkit/hkhealthstore/authorizationstatus(for:)>) |
| 증분·삭제         | `HKAnchoredObjectQuery`는 새 sample, 삭제 object, 다음 anchor를 제공한다. 삭제 object는 임시로 보존되며 언제든 정리될 수 있다. Observer 자체는 삭제 목록을 주지 않는다.                                                                | native outbox 영속화 후 anchor 전진, batch ack 분리, UUID/source 멱등 처리라는 기존 설계에 맞는다. 재설치 후 전체 삭제 이력을 무한 복원할 수 있다는 주장은 할 수 없다. [Anchored query](https://developer.apple.com/documentation/healthkit/hkanchoredobjectquery), [Deleted object](https://developer.apple.com/documentation/healthkit/hkdeletedobject)                        |
| Background        | iOS 15/watchOS 8 이후 background delivery entitlement가 필요하다. 지정 주기는 최대 통지 빈도이며 타입별 제한이 있다. Observer 처리 완료 callback이 필요하다. Background query는 Simulator에서 지원되지 않아 실제 기기 시험이 필요하다. | 실시간 수집 보장이나 Simulator 결과만으로 background 완료를 표시할 수 없다. foreground 재조정·네트워크 단절·재전송 확인은 남아 있다. [Background delivery](<https://developer.apple.com/documentation/healthkit/hkhealthstore/enablebackgrounddelivery(for:frequency:withcompletion:)>), [Observer](https://developer.apple.com/documentation/healthkit/hkobserverquery)         |
| 서명·실기기       | 실기기 실행은 Xcode 계정, 프로젝트 team, 연결된 기기의 provisioning 준비가 필요하다. Simulator는 실기기의 모든 기능·성능을 재현하지 않는다.                                                                                            | 계정·서명 자격·승인된 테스트 기기 준비 여부는 이번에 조사하지 않았다. 준비되지 않았다고 단정하지 않으며, 이 프로젝트의 서명된 실행 증거가 없는 상태다. [실기기 실행](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices)                                                                                                          |

## App Store 출시 시 확인할 항목

Apple의 공개 심사 지침 5.1.2·5.1.3은 건강 데이터의 광고·마케팅 이용을 제한하고, 수집하는 구체적인 건강 정보 공개를 요구한다. 부정확한 HealthKit 쓰기와 개인 건강 정보의 iCloud 저장도 금지한다. 제3자 AI에 개인 정보를 전달하려면 공유 대상·사용을 명확히 알리고 명시적 허락을 받아야 한다. 이는 현재 AI 동의 UI만으로 HealthKit 전송·출시 심사가 완료되었다는 뜻이 아니다. [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/#health-and-health-research)

원본 건강 데이터는 native collector에서 서버로 보내고 bridge에는 제한된 상태·요약만 제공한다는 저장소 설계는 유지한다. 읽을 데이터 유형, 보관·삭제 범위, raw/GPS의 외부 AI 전송 여부는 제품 정책과 실기기 검증 대상이며 이 조사에서 추가 전송을 구현하거나 허가하지 않았다.

## 로컬 읽기 전용 확인 결과

| 확인 명령·경로                                                             | 관측 결과                                                          | 증명하지 않는 사항                   |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------ |
| `xcode-select -p`                                                          | `/Applications/Xcode.app/Contents/Developer`                       | 프로젝트 서명·빌드                   |
| `xcodebuild -version`                                                      | Xcode 26.2, build 17C52                                            | 앱 entitlement 적합성                |
| `xcodebuild -showsdks`                                                     | iOS 26.2, iOS Simulator 26.2 SDK 표시                              | 최소 지원 OS에서 실행 성공           |
| `xcrun --find simctl`                                                      | Xcode 내부 `simctl` 존재                                           | Simulator 앱 실행                    |
| `xcrun simctl list runtimes -j`                                            | iOS 26.2 (23C54), watchOS 26.2 (23S303), 둘 다 `isAvailable: true` | HealthKit background·실기기 동작     |
| 프로젝트용 Node 직접 실행 `--version`                                      | v24.12.0                                                           | Capacitor 설치·번들 호환             |
| `package.json`, `pnpm-lock.yaml`, `apps/*/package.json`의 `capacitor` 검색 | 일치 없음                                                          | 전역 설치 여부는 조사하지 않음       |
| `apps`, `packages` 파일 검색                                               | Capacitor 설정, Xcode 프로젝트, entitlements, Info.plist 없음      | iOS shell 구현 완료                  |
| `command -v pod`                                                           | 현재 PATH에서 찾지 못함                                            | SPM 사용 경로까지 막혔다는 뜻은 아님 |

첫 runtime 조회는 sandbox의 CoreSimulator 연결·로그 접근 제한으로 실패했다. 같은 읽기 전용 명령을 승인된 sandbox 밖에서 재실행해 위 runtime 목록을 확인했다. Simulator를 부팅하거나 앱을 설치하지 않았다. 개인 기기 목록·건강 데이터·Keychain·서명 자산·Apple 계정에는 접근하지 않았다.

## M0-06c에서 필요한 별도 증거

아래는 이번 조사 결과가 아닌 후속 검증 범위다.

1. 선택한 Capacitor 버전과 iOS target으로 Vite 공통 module의 native build/run, HealthKit capability와 목적 설명, 필요한 유형별 API 지원을 확인한 기록.
2. 승인된 실기기와 해당 앱 서명으로 권한 요청, 제한된 관측·빈 결과, 사용자 계정 전환, foreground 복귀를 재현한 기록.
3. 합성 또는 명시적으로 허용된 테스트 자료로 sample 추가·삭제 → native outbox → anchor → 서버 ack 흐름을 확인하고, 중단·오프라인·재시작·재설치 재조정에서 누락·중복 여부를 비교한 기록.
4. 실제 기기에서 background 지연·Observer 완료 처리, WKWebView의 safe area·IME·back·수명주기, credential/raw-data bridge 경계를 검증한 기록.

현재 상태는 **도구·공개 요구사항 확인 완료 / native 앱 미구현 / 실기기·서명·HealthKit 수집 시험 미수행**이다. 브라우저 E2E·계약 테스트·이 조사 문서로 FUT-05 수용 기준을 통과 처리하지 않는다.
