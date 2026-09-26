# M2-01az · P8 새 기준 독립 채점

검토: Codex CLI `gpt-6-sol` high, read-only, 2026-09-27 KST. 이 요구사항 채점은 별도의 phase 코드 검토를 대체하지 않는다.

## 독립 채점 결과

**새 M2-01az 기준의 82쌍 채점을 완료했습니다. 판정은 `adequate`입니다.** `match` 69쌍, `partial` 13쌍, `mismatch` 0쌍으로 **69 + 13×0.5 = 75.5/82점**입니다. 확인된 실격 조건은 0건이며, 필수 23개 층이 모두 기준점에 도달했습니다. 이는 이번 표본과 새 기준에 따른 판정입니다. **기존 기준에서 기록된 P8 `failed`·`inadequate` 판정은 바뀌지 않으며, 이 검토는 향후 단계 코드 리뷰가 아닙니다.**

[새 기준](m0-06b-coverage-review-preregistration-m2-01az.txt), [82쌍 표본](m0-06b-coverage-review-pairs.json), [run 1](m0-06b-coverage-review-results-m2-01az-run1.json), [run 2](m0-06b-coverage-review-results-m2-01az-run2.json)를 직접 읽고 채점했습니다.

### 입력 신원과 재현성

| 파일      | 확인한 SHA-256                                                     |
| --------- | ------------------------------------------------------------------ |
| 새 기준   | `6dbcdba572f0739ed006bd30d5cbd7348ee633bd42d62ad02d92d449896c956e` |
| 82쌍 표본 | `603f6149384e2f532875bb24c4d29118b8d0f04815fdab1f2a9873d311b6cebf` |
| run 1     | `07552505ab49cf60b993133751570134081c63061539d19f1977564ef1fafae5` |
| run 2     | `82724f4fd1f7b995e6b350b0cfa2dfe829245a96f7a086ed1cf6afa06c329f91` |

네 해시는 모두 요청값과 일치합니다. 새 기준과 원래 기준을 구조적으로 비교하면 공통 `acceptanceCriteria`는 동일하고, 변경된 페어는 **RUR-02, BRG-01, NEG-ISL-01뿐**입니다. 두 결과는 각각 고유한 82개 페어를 표본과 같은 순서·좌표로 담고 있으며 `problems: []`입니다. `executedAt`과 79개 페어의 `latencyMs`를 제외한 두 JSON은 같습니다. 결과에 기록된 graph build ID는 `92e0fa5f319a41df`, graph content SHA-256은 `52f05e6784284bec2b385d570144bcf1c14dac5ceec91e79a2e037e26295fef2`로 두 run에서 같고, 기록상 실행 전후 content hash도 같습니다. 저장소의 profile 파일 해시는 결과에 적힌 `9b6fa80a…36a4ef8c`와 일치합니다.

이 신원 검사는 **결과 파일과 저장소 profile**에 대한 확인입니다. 별도 위치의 graph 원본·extract·GraphHopper jar 바이트를 이번 읽기 전용 검토에서 다시 해시하지 않았으므로, 그 값은 [실행 기록](m0-06b-coverage-execution-m2-01az.md)과 결과 JSON의 검증 기록에 근거합니다. 이 graph를 현재 서비스 중인 graph로 판정하지도 않습니다.

### 쟁점 세 페어

- **RUR-02 — `match` 1점.** 계산 거리 **1,620.3m**는 새 범위 `[1,500, 40,000]m` 안에 있습니다. 양 끝 snap은 9.41m·98.69m입니다. 엔진 way ID `w77108380`의 지도상 `route=ferry` 구간 **129.3m**로 낙동강을 건넜고 페리 경고가 보고됐습니다.
- **BRG-01 — `partial` 0.5점.** 엔진의 순서 있는 way 목록에 `foot=yes`, `bridge=yes`인 `w37928409` **626.8m**와 `w1091571410` **857.4m**가 연속해 있으며, geometry가 남안에서 북안으로 이어집니다. 이는 가까이 있는 평행 way의 기하 대조만이 아니라 **실제로 경로에 사용된 way ID**의 증거입니다. 페리 구간은 없습니다. 다만 **3,059.4m**는 등록 상한 3,000m를 59.4m 초과합니다. 25% 거리 허용 범위 안이므로 만점이 아닌 `partial`입니다.
- **NEG-ISL-01 — `partial` 0.5점.** 주 결과 `no_route` 대신 명시된 대안 `route_computed`가 나왔습니다. 엔진 way 순서와 geometry에서 동도–서도 수면 구간 **218.9m 전체**가 `w1127529698`(`서도-동도`, `route=ferry`)에 있으며, 인접한 **22.3m**도 `foot=yes`, `route=ferry`인 `w379686824`에 있습니다. 고정된 `foot-v1` profile은 `foot=no`가 없는 지도상 페리를 보행 경로로 허용하며, 이 경로에는 `foot=no` 구간이 없습니다. 따라서 지도와 profile 수준에서 보행 허용 페리 대안 조건을 충족합니다. 거리 **1,054m**는 대안 경로 한도 250,000m 이내입니다. **음성 페어의 계산 경로 대안은 `match`가 아니라 `partial`**이라는 공통 규칙을 적용했습니다. 실제 운항·승선 허용을 확인했다는 뜻은 아닙니다.

### 82쌍별 등급과 층별 산술

`M=match(1)`, `P=partial(0.5)`, `X=mismatch(0)`. 아래 목록은 페어 ID별 기계 판독 가능한 채점 매핑입니다. 기준점은 쌍 수의 75%를 0.5점 단위로 올림한 값이며, 한 쌍짜리 층은 1점입니다.

| 층                        | 페어별 등급                                                                                                                                           | 점수/쌍 | 기준점 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------: | -----: |
| urban-core                | URB-SEL-01:M, URB-SEL-02:M, URB-SEL-03:M, URB-SEL-04:M, URB-BSN-01:M, URB-BSN-02:M, URB-DGU-01:M, URB-GJ-01:M, URB-DJ-01:M, URB-JJ-01:M, URB-GNG-01:M |   11/11 |    8.5 |
| suburban                  | SUB-01:M, SUB-02:M, SUB-03:M, SUB-04:M                                                                                                                |     4/4 |      3 |
| mountain-trail            | MTN-01:P, MTN-02:M, MTN-03:M                                                                                                                          |   2.5/3 |    2.5 |
| rural                     | RUR-01:P, RUR-02:M                                                                                                                                    |   1.5/2 |    1.5 |
| riverside                 | RIV-01:M, RIV-02:M, RIV-03:M, RIV-04:M                                                                                                                |     4/4 |      3 |
| campus-apartment          | UNI-01:M, UNI-02:P, APT-01:M, APT-02:M                                                                                                                |   3.5/4 |      3 |
| military-avoidance        | ACC-MIL-01:M, ACC-MIL-02:M                                                                                                                            |     2/2 |    1.5 |
| access-restricted         | ACC-PRV-01:M                                                                                                                                          |     1/1 |      1 |
| bridge-foot-restricted    | ACC-FOOTNO-01:M                                                                                                                                       |     1/1 |      1 |
| stairs                    | STR-01:M, STR-02:M, STR-03:M, STR-04:M, STR-05:M                                                                                                      |     5/5 |      4 |
| underpass                 | UND-01:M                                                                                                                                              |     1/1 |      1 |
| crosswalk                 | UND-02:M, XWK-01:M, XWK-02:M, XWK-03:P, XWK-04:M                                                                                                      |   4.5/5 |      4 |
| bridge-pedestrian         | BRG-01:P, BRG-03:M, BRG-04:M, BRG-05:P, BRG-06:M                                                                                                      |     4/5 |      4 |
| elevated-walkway          | BRG-02:M                                                                                                                                              |     1/1 |      1 |
| ferry                     | FRY-01:M, FRY-03:M, FRY-02:M                                                                                                                          |     3/3 |    2.5 |
| negative-sea-island       | NEG-OFFSHORE:M, NEG-SEA-02:M, NEG-SEA-03:M, NEG-ISL-01:P, NEG-ISL-02:P, NEG-ISL-03:P                                                                  |   4.5/6 |    4.5 |
| bridge-motorway-only      | BRG-MW-01:P, BRG-MW-02:M, BRG-MW-03:M, BRG-MW-04:P                                                                                                    |     3/4 |      3 |
| park                      | PRK-01:M, PRK-02:M, PRK-03:M, PRK-04:M, PRK-05:M, PRK-06:M                                                                                            |     6/6 |    4.5 |
| access-time               | TIM-01:M, TIM-02:M, TIM-03:P, TIM-04:M                                                                                                                |   3.5/4 |      3 |
| negative-military         | NEG-MIL-01:P, NEG-MIL-02:M, NEG-MIL-03:M                                                                                                              |   2.5/3 |    2.5 |
| negative-expressway-only  | NEG-EXP-01:M, NEG-EXP-02:M, NEG-EXP-03:M                                                                                                              |     3/3 |    2.5 |
| negative-outside-coverage | NEG-OUT-01:M, NEG-OUT-02:M, NEG-OUT-03:M                                                                                                              |     3/3 |    2.5 |
| negative-request-limit    | NEG-LIM-01:M                                                                                                                                          |     1/1 |      1 |

나머지 `partial`의 근거도 확인했습니다. MTN-01·RUR-01·NEG-MIL-01은 등록된 대안 `snap_too_far`, NEG-ISL-02는 대안 `outside_coverage`입니다. UNI-02, XWK-03, BRG-05, BRG-MW-01은 각각 등록 거리 경계에서 25% 이내로 벗어납니다. BRG-MW-04, TIM-03, NEG-ISL-03은 조건을 충족하는 등록 대안 `route_computed`이며 각각 250,000m 한도 이내입니다. 비경로 결과에 보행 geometry가 붙은 사례는 없습니다.

실격 검사에서 계산된 66개 경로 모두 `footNoMeters`, **보행 허용 override가 없는** `accessPrivateOrNoWithoutFootOverrideMeters`, `footRestrictedNodesPassed`, `militaryAreaMeters`가 0입니다. 엔진 상세의 계산 경로에는 motorway·trunk 구간이 없고, 범위 밖·원해상 음성 대조는 계산 경로를 반환하지 않았습니다. `NEG-LIM-01`의 **서비스 결과**는 `ROUTING_LEG_TOO_LONG`에 의한 `rejected_before_engine`입니다. 보조 엔진 상세 요청이 별도로 계산한 경로를 서비스 결과로 세지 않았습니다. `ACC-PRV-01`의 gate와 `UNI-02`의 `access=private` way는 각각 명시적 `foot=yes`가 있어 결과의 보행 접근 판정상 제한으로 세지 않았습니다. 시간 조건 구간이 있는 BRG-03·FRY-03·TIM-01에는 모두 해당 경고가 있습니다.

### 판정의 범위

새 기준은 **이번 82쌍을 판정하는 규칙으로 적용 가능하며**, 그 규칙상 `adequate`의 세 조건인 **70점 이상, 실격 0건, 전 필수 층 기준 충족**을 모두 만족합니다. 다만 [기준 설명](m0-06b-coverage-criteria-m2-01az.md)에 기록됐듯 세 변경은 이전 결과를 본 뒤 채택됐습니다. 이번 결과의 페어별 비지연 값도 M2-01ay의 같은 graph 결과와 동일합니다. 따라서 **맹검 사전등록 성과나 새로운 graph 품질 향상으로 해석할 수 없습니다.**

이 표본은 전국 경로 품질의 추정치가 아닙니다. 최대 120m snap은 목적지 자체의 도달을 보증하지 않으며, OSM way 태그와 엔진 연결성은 현장 통행 가능성·페리 운항·시간별 폐쇄·물리적 안전을 증명하지 않습니다. 이 한계 아래에서 **독립적인 새 기준 채점은 완료**됐습니다. 요청대로 파일 수정·stage·commit·라우팅 엔진 실행은 하지 않았습니다.
