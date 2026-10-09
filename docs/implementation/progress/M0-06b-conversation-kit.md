# M0-06b-local 대화 UI 공통 kit · 2026-10-09

상태: 도메인 정책 없는 presentation kit 구현·집중 검증. M0-06b-local 전체 수용·제품 consumer 연결·실브라우저는 미완료다. 실기기는 모든 구현 뒤 실제 제품 앱에서 마지막에 진행한다.

## 구현

`@workout/conversation-kit/transcript`와 `/composer`는 controlled props와 명시 상태·composition slots를 제공한다. transport/Query/Zustand/provider/승인/저장/토큰은 owning module에 남기고 kit에는 도입하지 않았다. Transcript는 plain text와 stable message ID, 사용자/thread lifetime key로 private DOM을 교체한다. 사용자가 읽는 위치를 보존하고 bottom일 때만 append를 따라간다. 이전 page prepend의 보이는 메시지 anchor를 유지하며 새 메시지·위/아래 읽기 버튼을 제공한다. 모듈이 제공한 loading/error/unavailable와 이전 page 요청을 구분한다.

Composer는 값·최대 길이·동작 상태를 caller가 소유한다. 기본 Enter는 줄바꿈이며 opt-in Ctrl/Meta+Enter만 제출한다. IME 조합·keyCode229·repeat·추가 수정키와 빈/초과 입력·submitting/uncertain/conflict/unavailable에서 제출을 차단한다. 실패/보류 때 초안을 비우지 않는다. 도움말/상태는 안정 ID의 aria-describedby에 연결하고 실제 버튼·입력에 기존 --accent/--focus 토큰을 적용한다. API의 idempotency·CAS·동의·권한은 kit 단독 검증으로 증명하지 않는다.

## 실제 검증

Root가 기존 React19.3.0 resolution을 그대로 쓰는 신규 package/tsconfig/public exports와 additive lock importer를 연결했다. Node24/pnpm10.34.5 frozen/offline 설치 session42587은 exit0이며 37 workspace project, resolution/download 추가 없이 연결했다. 기존 MSW build script 제외 정책은 그대로 보고되었다.

최초 R1은 dependency link 누락으로 import 단계 2 suites 실패·0case였다. R2는 3pass/4fail이며 이전 viewport selector와 기대 문자열 fixture 오류였다. 교정 후 R3은 7/7이었다. Root 접근성 검토 후 실제 textarea description 정리·blocked 상태 시험을 추가한 R4는 정확2files/12pass/0fail/0skip·exit0(1.88s), Node24 typecheck·lint·format은 각 exit0다. 원 실패 로그를 Git 밖에 보존한다. 최종 여섯 소스/시험 SHA는 Root가 독립 대조했다. 기록 `wm-conversation-kit-review-final-freeze-20261009.json` SHA `5e3058370be2ae623c228e559acecf32caab54011991f3cf60f9893f332dafc4`.

## 남은 수용

실제 coaching module 연결, 두 shell build·320px/반응형·focus/IME·실브라우저 수용, 전체 overlay 조합은 남아 있다. 기존 user-only message JSON API에는 token streaming·attachment 업로드가 없으며 UI slot 존재로 해당 실환경 기능을 완료 처리하지 않는다. Evidence/Decision/Proposal/PlanVersion과 승인 버튼은 도메인 모듈에 유지한다. historical iPhone 시험 WIP와 기존 M0-06b 진행 문서는 수정·커밋하지 않았다. 이 commit은 phase 전체 검토나 main 통합이 아니다.
