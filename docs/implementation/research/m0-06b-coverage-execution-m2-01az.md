# P8-coverage M2-01az · 새 기준 이후 실행 증거

상태: **실제 엔진 probe 2회 완료, 별도 독립 채점 완료.** [채점 기록](m0-06b-coverage-review-grading-m2-01az.md)은 새 기준에서 `adequate`(75.5/82)로 판정했다. 과거 사전등록의 `P8-coverage: failed` 및 M2-01ay 검토자의 `inadequate`는 변하지 않는다.

## 실행 입력과 신원

| 항목         | 고정 값                                                                                                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 새 판정 기준 | [`m0-06b-coverage-review-preregistration-m2-01az.txt`](m0-06b-coverage-review-preregistration-m2-01az.txt), SHA-256 `6dbcdba572f0739ed006bd30d5cbd7348ee633bd42d62ad02d92d449896c956e` |
| 82쌍 표본    | [`m0-06b-coverage-review-pairs.json`](m0-06b-coverage-review-pairs.json), SHA-256 `603f6149384e2f532875bb24c4d29118b8d0f04815fdab1f2a9873d311b6cebf`                                   |
| 실행 코드    | `scripts/probe-routing-korea-coverage.mts`, 이 branch의 시작 HEAD `c3455868fcc70b50b3f1e35c4bfd262fcd6a970f`; `WalkingRouteService` + `GraphHopperRoutingAdapter` 경유                 |
| graph root   | 주 checkout의 `.geo-build-routing/kr-260901-m2-01ay-r1`을 읽고 검증한 뒤 임시 복사본에서 GraphHopper 실행. 이 root를 실제 서비스 중인 graph라고 주장하지 않는다                        |
| graph        | build ID `92e0fa5f319a41df`, content SHA-256 `52f05e6784284bec2b385d570144bcf1c14dac5ceec91e79a2e037e26295fef2`                                                                        |
| profile      | `foot-v1`, config SHA-256 `9b6fa80a6aa83f49ac0ebc115871858864aa431602b3d30e4c43d2917364ef8c`                                                                                           |
| extract      | allowlist `osm-extract-south-korea`, 재계산 SHA-256 `848daadc56b2c2a808b30b2778f834c2802097ab382805c9fd42f248f4d6284b`; road data `2026-09-01T20:20:50Z`                               |
| engine       | GraphHopper 10.0, jar SHA-256 `e5a1268f2cd6b1e4ef849b9237e98b651bf3c31adf4a3766c6d9f5feb241bb41`                                                                                       |

`ROUTING_GRAPH_ROOT`와 `ROUTING_EXTRACT_SOURCE=osm-extract-south-korea`를 고정하고, 공유 harness lock 아래 loopback 8997/8998에서 아래 명령을 각 결과 이름으로 실행했다. Node 24.12.0, `osmium`, Java 17을 사용했다. 첫 일반 sandbox 시도는 loopback bind `EPERM`으로 결과를 쓰기 전에 중단했다. 로컬 loopback 실행 권한으로 다시 실행했다.

```sh
node --import tsx scripts/probe-routing-korea-coverage.mts --execute \
  --pairs docs/implementation/research/m0-06b-coverage-review-pairs.json \
  --report-name m0-06b-coverage-review-results-m2-01az-run1.json
```

두 번째 실행에서는 `--report-name`만 `m0-06b-coverage-review-results-m2-01az-run2.json`으로 바꿨다. 스크립트의 내장 graph 검증이 두 run 모두 통과했다. 각 결과의 `graph` 항목에서 content SHA-256이 실행 전후 같고 디렉터리 목록도 같다고 기록했다. 입력 graph와 과거 결과 파일에는 쓰지 않았다.

## 두 실행의 관측

| 결과                                                      | UTC 시작–종료                | `executedAt`               | SHA-256                                                            |
| --------------------------------------------------------- | ---------------------------- | -------------------------- | ------------------------------------------------------------------ |
| [run 1](m0-06b-coverage-review-results-m2-01az-run1.json) | 2026-09-26 16:05:46–16:06:13 | `2026-09-26T16:06:13.784Z` | `07552505ab49cf60b993133751570134081c63061539d19f1977564ef1fafae5` |
| [run 2](m0-06b-coverage-review-results-m2-01az-run2.json) | 2026-09-26 16:06:13–16:06:33 | `2026-09-26T16:06:33.108Z` | `82724f4fd1f7b995e6b350b0cfa2dfe829245a96f7a086ed1cf6afa06c329f91` |

두 결과 JSON은 probe가 기록한 직후 Prettier로 공백만 정리했으며, 표의 SHA-256은 정리한 최종 바이트다. 두 run 모두 82쌍, `problems: []`다. outcome 분포는 `route_computed` 66, `snap_too_far` 7, `outside_coverage` 7, `no_route` 1, `rejected_before_engine` 1로 같다. 82쌍 각각의 outcome·경고·거리·snap·geometry·태그 대조·엔진 detail은 동일하다. 79쌍의 `latencyMs`만 다르다. graph 신원과 표본 신원도 일치한다.

이번 결과의 쌍별 증거는 [과거 M2-01ay 결과](m0-06b-coverage-review-results-m2-01ay.json)와도 `latencyMs`를 제외하면 동일하다. 같은 graph에서 같은 표본을 다시 돌린 결과이므로 경로 품질이 새로 개선됐다는 뜻이 아니다. 새 기준은 그 과거 결과를 본 뒤 승인됐으므로 맹검 사전등록이 아니다. 지도 태그와 엔진 detail만으로 현장 접근성, 페리 운항, 실제 보행 안전을 입증할 수 없다.

구현과 분리된 Codex CLI `gpt-6-sol` high 읽기 전용 검토자가 [새 기준](m0-06b-coverage-review-preregistration-m2-01az.txt)과 두 결과를 받아 82쌍·23개 층·실격·총점을 직접 채점했다. [채점 기록](m0-06b-coverage-review-grading-m2-01az.md)에 쌍별 등급과 산술, 신원 검증 범위, 기존 결과 공개 후 기준을 정한 한계를 남겼다.
