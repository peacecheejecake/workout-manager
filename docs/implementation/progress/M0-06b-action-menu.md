# M0-06b controlled action menu

## 구현 범위

`@workout/ui-foundation/action-menu`는 명시적인 enabled/disabled action과 소유자의
open 상태를 받는다. native manual popover를 사용하고, 지원되지 않거나 열기에 실패하면
inline fallback을 제공한다. fallback은 clipping 회피를 보장하지 않는다.

키보드 탐색, typeahead, IME 이벤트 제외, 비활성 항목의 callback 차단, Escape와
Tab dismissal, 소유자 종료 및 항목 제거 때 focus 복구를 구현했다. Tab 후보는 실제
native modal 범위와 숨겨진 조상을 확인한다. UI는 계획 승인이나 서버 정책을 소유하지 않는다.

## 실제 검증 · 2026-10-09

Root가 public export 추가 후 Vitest를 실행했다: 1파일 13/13, skip 0, exit 0.
foundation typecheck와 변경 파일의 Prettier 검사도 exit 0이었다.
Agent의 최종 scoped lint/typecheck/format은 exit 0이며 Root가 소스와 교정 보고서를 읽었다.

초기 jsdom popover stub 시험의 3 pass / 6 fail과 교정 전 10 pass 기록은 보존한다.
최종 시험의 native `:modal` 판정과 popover 동작은 jsdom stub이다. 실제 브라우저의
top layer, clipping, native inert 및 focus policy 증거로 취급하지 않는다.
Next/Vite 조합 브라우저 검증과 최종 실제 제품 iPhone 수용은 아직 `not_executed`다.

Agent 교정 보고서: `/private/tmp/wm-action-menu-reviewfix-report-20261009.md`.
이 변경만으로 M0-06b 전체, phase 독립 검토 또는 출시 수용을 완료 처리하지 않는다.
