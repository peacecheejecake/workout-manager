# M0-06b FUT-03 streaming 표시 store 실험 · 2026-10-09

호출별 external store factory를 추가하고 공개 subpath 및 기본 Vitest node 수집에 연결했다. account/session/run/attempt별 immutable snapshot, 순서·중복·gap·terminal 이후 이벤트 거절, UTF-8 누적 provisional text와 read-only tool result bounds, dispose 시 private 표시 자료 삭제를 구현한다. tool identity/label/완료 결과를 보존하며 terminal 상태를 running으로 되돌리지 않는다. bounds는 호출자가 명시한다.

이것은 이미 검증된 표시 이벤트의 프런트엔드 실험이다. unknown provider parser, 실제 token/tool transport, 서버 권한·동의·lease, 저장·승인 또는 계획 적용을 제공하지 않는다. React consumer/SSR hydration은 후속이며 이 순수 시험으로 수용하지 않는다.

agent v2 source SHA-256 `61c01a0b2fed46f8dcd53d9a06855ba02605b559d78b53f9fff4265038c4ec41`, test SHA-256 `3e3e5712c2e38ccb46cd1ae39789ef73eb082762b7642c1e2ea3da6b161f5d25`. `/private/tmp/wm-stream-presentation-store-v2-freeze-20261009.json`은 실제 15/15·skip 0와 kit TS/lint/format exit 0을 기록한다. 이전 progress-only 11/11 입력은 보존한다.

Root는 코드와 결과를 읽고 공개 export·기본 node test 수집 후 15/15, skip 0, exit 0, 149ms를 직접 확인했다. kit typecheck와 scoped ESLint도 exit 0이다. 최종 제품 실기기 검증은 전체 구현 이후 실제 제품 앱에서 진행한다. 전체 M0 phase gate·독립 검토·main 병합은 별도다.
