# M0-06b-local · 설명 tooltip 기본 컴포넌트

2026-10-09. 디자인 시스템 §5의 설명 tooltip 요구를 `@workout/ui-foundation/help-tooltip`으로 구현했다. `label`, 순수 텍스트 `description`, available/dragging 상태만 받으며 저장·승인 action과 도메인 정책을 소유하지 않는다.

마우스 hover 250ms 열림·100ms 닫힘, keyboard focus/click·touch click·Escape를 지원한다. trigger에서 설명까지의 실제 box 기반 삼각 corridor는 출구 거리 16px 이내와 가까워지는 움직임에 한정하며 unrelated/receding 움직임에서는 닫는다. drag 시작 때 닫고 종료만으로 다시 열지 않는다. timer·pointer/scroll/resize listener와 native popover를 정리한다. SSR에는 공유 mutable 상태를 두지 않으며 native API가 없거나 열기에 실패하면 인라인 설명 대안으로 구분한다. 대안은 native overlay 통과가 아니다.

Root는 source·CSS·시험 전체를 읽고 outer span의 phrasing content에 맞도록 설명 본문 div를 span으로 수정하도록 요청했다. agent는 source/ref와 DOM 단언만 수정해 다시 검증했으며 CSS는 보존했다.

## 실제 검증과 남은 조건

- 최종 focused RTL: **14 통과·0 실패**, maxWorkers=1, exit 0 (session 54845).
- foundation typecheck·해당 source/test lint·Prettier: exit 0.
- 최초 RTL 8/12, 시험 spy의 this 타입 오류와 effect-state lint 오류는 과거 실패로 보존한다. native UA display mock·타입·instance capability 처리를 수정했으며 규칙은 비활성화하지 않았다.
- Source SHA `334e398317d8a8d800068196e9fca503de3e471d09b070b661dc698f9b26fda1`, CSS `de3690fb75e3bc01794c1307588a28d9b225f8e1a659ca0b4fae029cb1b1bbe4`, test `779753d7b35bbb60eb2c0aad9bef364ae3f4d2ff03649d30e0d83d24038f7671`을 Root가 독립 대조했다.

Root 공개 export 후 foundation typecheck도 exit 0 (session 13704)이며 modal/tooltip 결합 RTL은 **2파일·27 통과·0 실패·0 skip**, exit 0 (session 84512)이다. RTL의 geometry와 native popover는 합성 mock이다. 실제 pointer 경로·top layer/clipping·viewport 배치·320px reflow·scroll·reduced-motion CSS·제품 소비자 연결은 **not_executed**다. 이 기본 컴포넌트는 dropdown/drawer나 전체 M0-06b-local 수용을 완료하지 않는다. 실기기는 모든 구현 후 실제 제품 앱에서 진행한다.
