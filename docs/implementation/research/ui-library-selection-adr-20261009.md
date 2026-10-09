# FUT-03 UI stack 선택·대체 ADR · 2026-10-09

상태: 구현 선택 기록. 로컬 수용과 운영·실기기 수용은 별도로 판정한다.
후보 미설치나 이름 변경은 시험 통과 또는 후보 실패가 아니다.
[FUT-03](../../.pre/06_follow_up_backlog.md#fut-03)의 public kit·Host 경계와 기존 수용 항목을 유지한다.

## 실행 후보 유지

MapLibre6.9.1, ECharts6.1.0, TanStack Table9.2.4, Tiptap3.31.3, dnd-kit0.5.0,
react-resizable-panels4.12.4의 현재 lock 조합을 유지한다. 구현 adapter가 두 Host에서 사용되므로
패키지 교체는 해당 경계의 검증 비용과 기존 초안·선택 수명에 영향을 준다.
이번에 버전을 올리거나 새 상업 extension을 채택하지 않는다.

정확 설치 production/peer closure와 원문 notice 근거는
[최신104-package 기록](../progress/M0-06b-local-license-slider-20261009.md)을 따른다.
외부100개·원103 metadata/notice는 동일하고 conversation-kit workspace만 추가됐다.
원101/103 기록은 역사 입력으로 유지한다. 설치된 manifest/notice의 license 선언 확인을
법적 승인이나 미채택 extension의 가격 확인으로 해석하지 않는다.

## 자체 구현을 선택한 범위

| 후보                               | 선택한 구현·이유                                                                                                                                                          | 실제 수용과 남은 범위                                                                                                                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Radix Primitives                   | ui-foundation의 native dialog/popover/menu/tooltip과 native range. DOM focus·portal·모바일 입력의 Host 경계를 현재 공개 primitive에서 처리한다.                           | [조합14case](../progress/M0-06b-overlay-composition.md)와 [실제 slider2case/Chrome](../progress/M0-06b-local-license-slider-20261009.md). OS touch/IME는 마지막 제품 기기 수용. Radix 자체 호환성은 미실행.                         |
| assistant-ui                       | conversation-kit transcript/composer·호출별 external store·StreamTranscript. 승인 정책·서버 cache를 presentation/store로 옮기지 않고 session/run/attempt 수명을 명시한다. | [제품 소비자](../progress/M0-06b-conversation-consumer.md), [stream 소비자](../progress/M0-06b-stream-consumer.md). 실제 provider transport/lease/동의·후보 승인 연결은 owning 코칭 구현 수용이며 fixture 성공으로 완료하지 않는다. |
| TanStack Table virtualization 보완 | public table-kit의 controlled roster/anchor/focus와 기존 고정 virtual-core3.17.11을 사용한다. virtualization과 정렬·도메인 선택 소유권을 분리한다.                        | [kit](../progress/M0-06b-table-kit.md)·[10k 소비자](../progress/M0-06b-table-virtualization-consumer.md). 실제 두 Host10case와 읽기 대안, null/zero를 검증했으며 기기 FPS는 미실행.                                                 |
| react-grid-layout                  | 기존 dashboard 자체 responsive 배치와 편집/저장 계약을 유지한다. 화면별 draft/명시 저장 수명을 공용 grid adapter가 소유하지 않는다.                                       | 기존 dashboard owning 수용을 따른다. 후보 자체 responsive·저장 호환 시험은 미실행.                                                                                                                                                  |
| FullCalendar                       | 기존 calendar/table/agenda의 renderer 독립 kernel과 controlled 선택·명시 날짜 이동을 유지한다. 동일 초안을 layout 전환 위에서 보존한다.                                   | 기존 M1-04n/o/t 구현·실제 수용. FullCalendar/premium 기능 채택·가격 수용은 미실행.                                                                                                                                                  |
| D3 hierarchy                       | 기존 period-orbit/explorer의 React SVG·키보드·목록 대안을 유지한다. 기간 lens/부모 복귀의 공개 계약이 navigation을 소유한다.                                              | 기존 M1-04am 수용. D3 실행 검증으로 표시하지 않는다.                                                                                                                                                                                |
| React DayPicker                    | 현재 owning date input과 날짜·시간대·미해결 anchor 계약을 유지한다. native 입력이 값/초안만 보내고 일정 승인·정본 계산을 하지 않는다.                                     | 기존 날짜 이동·명시 저장 수용. 범용 locale/range picker 후보의 모든 기능 수용은 미실행.                                                                                                                                             |
| Motion                             | 현재 CSS semantic token·reduced-motion 및 renderer의 gesture 취소를 유지한다. 초안이나 actual 기록을 animation completion으로 바꾸지 않는다.                              | 기존 owning 취소/감소 동작 수용. Motion 설치·WebView animation 성능 검증은 미실행.                                                                                                                                                  |

## Gallery 관련 후보와 제품 구현 연결

Embla·Yet Another React Lightbox·Media Chrome은 이번에 채택하지 않는다.
기존 Gallery module에서 controlled 선택, 이미지/video renderer, 버튼·키보드 대안과 native video
controls를 소유하게 한다. Private URL·자막·삭제·접근권·codec/worker 정책은 라이브러리 내부 상태로
이동하지 않는다. public module/transport/Host 계약은 유지한다.

해당 기능의 미완료는 **M2-03a/b/c**에서 계속 구현·검증한다. core upload/private metadata의
과거 완료를 full viewer·swipe/nested-scroll·caption/speed/fullscreen·album·파생물의 완료로
세지 않는다. 이 선택 기록은 carousel·lightbox·video 후보 자체 시험이나 제품 전체 수용이 아니다.
현재 own renderer가 필요한 동작을 제공하지 못하면 owning task에서 원인을 검증하고 adapter를
검토한다. 라이브러리 미설치 자체를 결함이나 구현 불가능의 근거로 사용하지 않는다.

## 검증 순서

선택된 stack의 새 전체 install/generated/lint/typecheck/build/unit/integration/identity×2/format과
두 Host 조합·새 소비자 회귀를 정확 phase HEAD에서 수행한 뒤 context-less 독립 phase 검토를
요청한다. 기존 좁은 성공으로 전체 phase를 통과시키지 않는다. 실제 WKWebView/GPU·touch/OS IME·
성능은 모든 구현과 운영/외부 수용 이후 **실제 제품 앱**에서 마지막에 검증한다.
public ODbL/HTTPS·위치 로그·provider/법률 gate는 그대로 남는다. standalone 합성 앱은 재개하지 않는다.
