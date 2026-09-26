# M0-06c native host keyboard/Back 후속 · 2026-09-27

기준: `phase/m0-06c`, 시작 main `53563e3a262934b3df672b758051a47754355112`.
이 문서는 기존 [M0-06c 관측](M0-06c.md)을 수정하거나 과거 실패를 통과로 바꾸지 않는다.
제품 native host 통합은 사용자 결정에 따라 M3-01 범위다.

## 이번 probe 변경

- `SceneDelegate.swift`의 native host가 키보드 프레임과 WebView의 교차 높이를 구해 스크롤 inset에 반영한다. 키보드가 완전히 표시된 뒤 포커스된 입력 컨트롤을 보이는 `visualViewport` 안으로 스크롤하고, 키보드가 닫히면 원래 inset을 복원한다. Back 버튼도 native keyboard layout guide 위에 둔다.
- WebKit의 자동 back-forward edge gesture를 끄고 native 왼쪽 가장자리 제스처와 접근성 이름이 있는 native Back 버튼을 둔다. 현재 페이지의 입력값이 초기값과 다르면 변경사항 폐기 확인을 표시한다. 취소하면 머무르고 이동을 선택해야 `goBack()` 한다. 입력값·화면 문자열은 로그에 남기지 않는다.
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
