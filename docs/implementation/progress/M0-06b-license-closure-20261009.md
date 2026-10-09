# M0-06b 최신 UI dependency·notice closure

2026-10-09, 입력 phase HEAD `f7849f268edd04f1d4c6e9e99112aa7df2e37be3`. 기존 inventory와 검토 기록은 보존하고 새 [inventory](../research/ui-spike-license-inventory-20261009.json)를 별도로 작성했다. 공식 registry/network 없이 설치된 production dependency와 설치 peer, 실제 package notice bytes를 기존 collector로 읽었다.

## 실제 결과

- 현재 closure **103 packages**, 외부 **100**, required unresolved 0, optional unresolved 1(기존 Zustand의 미설치 immer optional peer).
- 과거 101개 항목은 metadata/notice SHA가 모두 동일하다. 추가된 항목은 workspace `@workout/table-kit@0.0.0`과 외부 `@tanstack/virtual-core@3.17.11`뿐이다. 삭제/기존 변경은 0이다.
- 외부 선언 license 집계: MIT82, ISC8, BSD-3-Clause4, BSD-2-Clause2, 0BSD2, Apache-2.0 1, (MIT OR Apache-2.0)1. 새 virtual-core는 실제 설치 package의 MIT 선언과 LICENSE 원문 SHA를 inventory에 기록했다.
- 원 murmurhash-js의 root notice 부재는 과거와 동일하다. 기존 generator의 정확 README license body/supplement SHA 검증을 실제 통과했다. root notice 부재를 보이지 않게 지우지 않는다.
- 같은 generator를 own TMP에서 다시 실행해 외부 100개의 notice bundle과 manifest를 만들었다. Web/mobile-web/Storybook의 현재 세 배포 입력 manifest와 notice bundle은 모두 정확 일치했다. 원 script/고정 supplemental notice/배포 bytes는 수정하지 않았다.

Inventory raw JSON SHA `54cc2d2d2743910946af5ad0079f425044e471dfe29b2c4505dc2596b7a1d644`(format 적용 전), 실제 lock SHA `e9d283b4eb76f9114030be7a3d95d9550fcc2f2490143d0a87ce24dd3d06f165`, notice bundle SHA `b8234435241c195578b0145ccdd6f51e15a707591e234a72417ea9617ec8a8d0`. 실제 비교 기록은 `/private/tmp/wm-m0-license-20261009-QneR4l/comparison.json`이다. 실행 exit0이며 비교는 manifest 전체와 bundle bytes hash를 단언한다.

최종 Prettier 적용 inventory SHA `ab1c916463f0c839fe232cafb0dbbf6362cfc7e47eaba600faeb9dd91458c595`도 별도로 기록한다. 원 JSON 의미·package/notice 목록은 유지한다.

## 범위

이 검증은 설치 production/peer closure와 실제 고지 일치다. 전체 앱의 tree-shaken bundle 목록, 미채택 후보의 유료 extension·상업 조건, 지도/provider 데이터 권한 또는 법적 승인을 증명하지 않는다. SSR/runtime/기기 수용은 각각 실제 테스트 범위를 따른다. 전체 M0 phase gate·선택/대체 ADR·conversation streaming/tool-result·M2-03 기능 연결과 최종 제품 iPhone gate는 남아 있다.
