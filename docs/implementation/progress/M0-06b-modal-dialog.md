# M0-06b-local · controlled modal 기본 컴포넌트

2026-10-09. `@workout/ui-foundation/modal-dialog`는 native `dialog.showModal()`에 top layer·배경 inert·Tab 이동을 위임한다. `open`, 최초 포커스와 복원 대상, 취소/닫기 요청은 소비자가 소유한다. 본문과 controls를 조합하며 도메인 저장·계획 승인·통신을 수행하지 않는다.

한 문서에 다른 열린 dialog가 있으면 `modal_already_open`, native API가 없거나 열기에 실패하면 `native_dialog_unavailable`을 보고한다. 이를 일반 창으로 대체해 modal 성공으로 표시하지 않는다. Escape는 소비자에게 취소를 요청하고 `open=false`가 될 때 닫는다. 연결되어 있고 비활성·hidden·inert가 아닌 복원 대상에만 포커스를 돌린다. 자신이 변경한 body overflow를 정리하며 외부 변경은 보존한다.

## 실제 검증

- focused RTL: 1개 파일, **13 통과·0 실패**, maxWorkers=1, exit 0.
- foundation TypeScript, 해당 source/test ESLint, Prettier: exit 0.
- Root는 source·CSS·13개 시험을 읽고 공개 subpath export를 연결했다. export 후 foundation typecheck도 실제 exit 0이었다.
- 최초 RTL은 12 통과·1 실패였다. jsdom CSSOM의 overflow priority 제한을 확인하고 기존 priority를 `setProperty`에 전달하는 단언과 브라우저 검증을 분리했다. 과거 실패는 보존한다.

RTL은 native dialog API mock을 이용한 controlled lifecycle·위임 검증이다. 실제 top layer·배경 inert·Tab loop·Escape·CSSOM priority·페이지 scroll 보존·320px reflow 및 제품 소비자 연결은 **not_executed**다. 모달 기본 컴포넌트만으로 전체 overlay 수용이나 M0-06b-local 완료를 주장하지 않는다. 실기기는 사용자 결정대로 모든 구현 뒤 실제 제품 앱에서 검증한다.

Source SHA-256: `b42abd4617ee99294e29c49b6fe56b17b95e897d1de7f0a7fe02d777463b1f32`. CSS: `e5735d39520f3fc31ccd56faa767228cd8c125b91d3521e2d5a2a1e113fad888`. Test: `4623a5cb91dee8416375bfe8282d6c12b488a778f04097e5fab447e4d0ae0c5b`.
