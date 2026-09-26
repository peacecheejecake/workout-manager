# M0-06b · 한국 보행 경로 독립 coverage 검토 (P8-coverage)

작성일: 2026-09-26. 기준 HEAD: `a2ab2ec`. 대상 게이트: [M0-06b](../progress/M0-06b.md)와 요구 매트릭스 행
`P8-coverage`(그리고 `FUT-07-4`의 coverage 부분). 진행 기록: [M0-06b-coverage](../progress/M0-06b-coverage.md).

**결론: 독립 검토자의 판정은 `inadequate`(부족)다.** 검토자가 결과를 보기 전에 스스로 정한 기준을 그대로 적용한
결과다. 총점 68/82(기준 70 이상, 검토자 자신의 산술 정정 반영. 첫 기록은 69), 필수 층 7개가 기준 미달, 실격 조건 4건(ACC-MIL-01, ACC-PRV-01, FRY-03,
NEG-MIL-02). 검토자는 기준 두 가지를 바꾸고 싶다고 명시했지만, 바꿔도 판정은 `inadequate`로 같다고 스스로 적었다.

게이트 문구(`map-implementation-plan.md:206`): "보행 coverage — graph 신원 고정, 사전 기대 결과와 독립 검토자,
도심/횡단보도/다리/계단/공원/접근시간·음성 대조; HTTP 200만으로 통과 금지". 이 검토는 그 절차를 모두 밟았다.
절차가 성립했다는 것과 coverage가 충분하다는 것은 다르다. 판정은 후자에 대해 "부족"이다.

## 1. graph 신원과 extract pin

| 항목           | 값                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------- |
| graphBuildId   | **`188b65effcc6ef5c`** (결과 JSON `graph.graphBuildId`, 82쌍 모든 계산의 `graphBuildId`)            |
| 배포 위치      | `<ROUTING_GRAPH_ROOT>/foot` = 주 checkout의 `.geo-build-routing/kr-260901/foot` (읽기만 함)         |
| graph content  | `138a1978…d130f085`, 실행 전후 동일, 디렉터리 목록 동일(`deployedDirectoryListingUnchanged: true`)  |
| 엔진           | GraphHopper 10.0, jar sha256 `e5a1268f…41bb41`                                                      |
| profile        | `foot-v1`, `profileConfigSha256 54b9ba78…1712d7`                                                    |
| extract        | allowlist `osm-extract-south-korea`, Geofabrik `south-korea-260901`, 286,403,403 bytes              |
| extract sha256 | `848daadc56b2c2a808b30b2778f834c2802097ab382805c9fd42f248f4d6284b` (이번 실행에서 다시 계산해 일치) |
| road data      | `2026-09-01T20:20:50Z`, import `2026-09-25T09:36:36Z`                                               |
| 실행 경로      | 운영 `WalkingRouteService` + `GraphHopperRoutingAdapter`(snap 120 m, deadline 8 s, 방문 노드 100만) |

엔진은 배포 graph의 검증된 임시 복사본에서 돌았다(기존 probe 방식 그대로). `.geo-build`와 `.geo-build-routing`에는
쓰지 않았다.

## 2. 표본 설계

- **입력 파일(blinded):** [m0-06b-coverage-review-pairs.json](m0-06b-coverage-review-pairs.json). pair id, 층,
  지역, 랜드마크 설명, 출발·도착 좌표, 그리고 계약(결과 class, 한도)만 있다. 엔진 결과와 기대 결과는 없다.
- **82쌍** = 기존 38쌍(좌표·id 그대로, `--list-pairs`로 스크립트에서 뽑음) + 새 44쌍. 기존 38쌍의 설명은 Seoul
  graph 시절의 검토 메모(“배포 extract 밖 …의 응답 형태” 같은 결과 암시)를 지우고 중립적인 랜드마크 설명으로
  바꿨다. 기존 층 이름도 검토 층으로 다시 붙였다(예: UND-02 → crosswalk).
- **필수 층(각 3쌍 이상):** urban-core 11, crosswalk 5, bridge-pedestrian 5, bridge-motorway-only 4, stairs 5,
  park 6, access-time 4, 음성 대조 16(negative-sea-island 6, negative-military 3, negative-expressway-only 3,
  negative-outside-coverage 3, negative-request-limit 1). 그 밖에 suburban 4, mountain-trail 3, rural 2,
  riverside 4, campus-apartment 4, military-avoidance 2, ferry 3, access-restricted·bridge-foot-restricted·
  underpass·elevated-walkway 각 1.
- **지역:** 서울 29, 부산 10, 경기 7(+경기 북부·경기·충남·서울·경기), 제주 5, 수원 3, 강원 3(설악산·강릉 2),
  경북 3(+울릉 독도), 인천 3, 대구 3, 광주 1, 대전 1, 충남 1, 경남(거가대교) 1, 해상 3, 역외(북한 2, 일본 1).
- **새 좌표를 고른 방법:** 공개 랜드마크 이름을 같은 전국 extract에서 osmium으로 찾아 좌표를 반올림했다. 엔진은
  쓰지 않았다. 그다음 **OSM만으로** 각 점에서 가장 가까운 보행 가능(태그 기준) highway까지의 거리를 쟀고, 경로가
  나와야 할 쌍 중 80 m를 넘는 점 5개를 가까운 도로 위로 옮겼다: BRG-MW-02 도착(영종도, 400 m 안에 도로 없음),
  BRG-MW-03 출발(236 m), BRG-MW-04 양끝(264 m·116 m), PRK-04 도착(86 m). 음성 대조(바다, 활주로, 군 영내,
  고속도로 상판)와 TIM-03 도착(창덕궁 후원 부용지: 가까운 길이 모두 `access=permit`이라 일부러 둠)은 옮기지
  않았다. 이 조정은 사전 등록 전에 끝났고 엔진 응답과 무관하다.
- 개인 GPS 자료는 없다. 모든 좌표는 공개 랜드마크 근처의 합성 점이다.

## 3. 사전 등록(pre-registration)

| 항목              | 값                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 검토자            | Codex CLI 0.157.0, `codex exec -s read-only -c model="gpt-6-sol" -c model_reasoning_effort="high"`, session `01a0db81-a9cb-7f83-bcc9-4624cdfe8ed4`                             |
| 작업 디렉터리     | 빈 임시 디렉터리(scratchpad `codex-prereg/`, 실행 전 `ls -A` 결과 없음). 저장소가 아니다                                                                                       |
| 입력              | 프롬프트 하나에 blinded 표본 전체를 넣었다. 명령 실행·파일 읽기 금지를 지시했고, 로그에 `exec` 항목이 0건이다(명령을 하나도 실행하지 않았다)                                   |
| 시작 / 완료 (UTC) | **2026-09-26T02:18:22Z / 02:22:22Z**. 엔진 실행은 그 뒤 02:22:59Z에 시작했다                                                                                                   |
| 출력 sha256       | **`98ef1ceec76c7039be805c771b6b95fa0698d7eb34f623c3a58ed8c2e28a214b`** — [m0-06b-coverage-review-preregistration.txt](m0-06b-coverage-review-preregistration.txt)(원문 그대로) |
| 프롬프트          | [m0-06b-coverage-review-preregistration-prompt.txt](m0-06b-coverage-review-preregistration-prompt.txt), sha256 `7d956f21…6e2bf792`                                             |
| 표본 hash         | 프롬프트에 넣은 표본 sha256 `7857c23f…f85678`. 저장소 파일은 그 뒤 Prettier로 공백만 바꿨다(`603f6149…b6cebf`). `JSON.parse` 결과가 같음을 확인했다                            |

등록된 기대 결과 분포: `route_computed` 64, `no_route` 7, `outside_coverage` 6, `snap_too_far` 4,
`rejected_before_engine` 1. 쌍마다 대안 결과, 거리 범위, must/mustNot 조건, 확신도, 근거가 있다.

**사전 등록된 판정 기준(요약, 원문은 파일):**

- pair: 기대 결과 + 모든 조건 + 거리 범위 + snap ≤120 m이면 match(1). 명시한 대안 결과이거나 거리가 범위 끝에서
  25% 이내로 벗어나면 partial(0.5). 그 밖은 mismatch(0). foot=no 미터, access=private/no 미터, 제한 node 통과,
  허가 없는 군사 영역 통과, 연결되지 않은 수면 횡단, 보행 금지 교량 통과가 있는 경로는 무조건 mismatch.
- 층: 점수가 쌍 수의 75% 이상(0.5 단위 올림)이면 기준 충족. 1쌍 층은 full match여야 한다. 23개 층 모두 필수.
- 실격: 위 금지 사항 중 하나라도 있는 경로, 군사 영역 진입, NEG-LIM-01이 `rejected_before_engine`이 아님,
  먼바다·역외 대조군에서 경로 계산.
- 전체: `adequate` = 실격 없음 + 총점 ≥70 + 모든 층 충족. `adequate with limits` = 실격 없음 + 총점 ≥62 + 다리·
  횡단보도·군사·음성 대조 10개 층 충족 + 그 밖 미달 층 3개 이하. 그 밖은 `inadequate`.

## 4. 실행

`scripts/probe-routing-korea-coverage.mts`를 두 가지만 넓혔다(엔진·graph에 대해서는 여전히 읽기 전용).

1. `--pairs <file>`: blinded 파일을 입력으로 받는다. `--report-name`이 필수이고 정본 보고서 이름은 거절한다.
   파일 sha256과 이름을 보고서 `sample`에 적는다. `--list-pairs`는 내장 38쌍을 같은 형식으로 출력만 한다.
2. 새 관측 필드: 보조 요청에 `street_name`(교량·거리 이름), 태그 대조에 `footway=crossing` way 미터,
   `highway=crossing` node 수, 시간 조건(`access:conditional`/`foot:conditional`/`opening_hours`) way 미터.
   crossing node가 전국 76,711개라 node 대조를 격자 색인으로 바꿨다. 기존 `restrictedNodesPassed`는 접근 태그
   node만 센다(의미 그대로).

실행은 harness lock(`M0-06b-coverage <pid>`, trap 해제, 3100/4200/4300/4400/8997/8998 비어 있음 확인) 안에서 했다.

| run | UTC                 | 결과                   | 시간·자원                                             |
| --- | ------------------- | ---------------------- | ----------------------------------------------------- |
| 1   | 02:22:59 – 02:23:12 | 82쌍, `problems` []    | 12.9 s real, 최대 RSS 2.26 GB(JVM 포함), load 2.7–3.2 |
| 2   | 02:23:55 – 02:24:07 | run 1과 82쌍 모두 동일 | outcome·거리·geometry hash·태그 대조·detail 전부 일치 |

- 결과: [m0-06b-coverage-review-results.json](m0-06b-coverage-review-results.json)(run 1, Prettier로 공백만 정리.
  검토자에게 준 원본 sha256 `07cd7ca8…2a925f77`, 저장소 파일 `9a2bf66c…50281380`, `JSON.parse` 결과 동일). 호스트
  경로·이름 0건.
- 요약: `route_computed` 66, `outside_coverage` 7, `snap_too_far` 7, `engine_contract_violation` 1(STR-04),
  `rejected_before_engine` 1(NEG-LIM-01).
- 기존 38쌍은 M2-01ak 기록(같은 graph)과 outcome·거리가 모두 같다. 10쌍은 geometry 정점 수가 1–4개 다르다(거리는
  같다). 원인은 보조 요청에 `street_name` detail을 더해 GraphHopper가 이름 경계에서 정점을 더 내놓기 때문으로
  보인다(확인하지 않음). run 1과 run 2 사이에는 차이가 없다.
- 로그: `test-results/m0-06b-coverage/probe-run{1,2}.log`, Codex 로그 `prereg-log.txt`, `grade-log.txt`(Git 제외).

## 5. 결과와 검토자 판정 (쌍별)

"사전 기대"와 "거리 범위"는 검토자가 결과 전에 등록한 값이다. "판정"은 검토자의 채점이다. snap은 실패한
쌍이면 보조 요청 값이다.

| pair          | 층                        | 지역      | 사전 기대(대안)                                    | 사전 거리 범위 m | 결과                      | 엔진 거리 m | snap m          | 판정                          |
| ------------- | ------------------------- | --------- | -------------------------------------------------- | ---------------- | ------------------------- | ----------: | --------------- | ----------------------------- |
| URB-SEL-01    | urban-core                | 서울      | route_computed                                     | 750–2200         | route_computed            |       851.8 | 1.54 / 6.77     | match                         |
| URB-SEL-02    | urban-core                | 서울      | route_computed                                     | 900–3000         | route_computed            |      1429.9 | 5.1 / 30.11     | match                         |
| URB-SEL-03    | urban-core                | 서울      | route_computed                                     | 1100–3000        | route_computed            |        1469 | 5.01 / 3.35     | match                         |
| URB-SEL-04    | urban-core                | 서울      | route_computed                                     | 8500–20000       | route_computed            |      9905.2 | 39.81 / 1.54    | match                         |
| URB-BSN-01    | urban-core                | 부산      | route_computed                                     | 500–1700         | route_computed            |       770.4 | 6.67 / 1.91     | match                         |
| URB-BSN-02    | urban-core                | 부산      | route_computed                                     | 450–1600         | route_computed            |       584.3 | 29.99 / 1.42    | match                         |
| SUB-01        | suburban                  | 경기      | route_computed                                     | 1000–3000        | route_computed            |      1243.8 | 49.08 / 12.58   | match                         |
| SUB-02        | suburban                  | 경기      | route_computed                                     | 800–3000         | route_computed            |      1156.2 | 6.84 / 73.38    | match                         |
| SUB-03        | suburban                  | 경기      | route_computed                                     | 900–3000         | route_computed            |      1320.6 | 28.35 / 2.87    | match                         |
| SUB-04        | suburban                  | 수원      | route_computed                                     | 500–2200         | route_computed            |         687 | 57.8 / 0.89     | match                         |
| MTN-01        | mountain-trail            | 서울·경기 | route_computed (no_route, snap_too_far)            | 2800–11000       | snap_too_far              |           – | 1.82 / 121.13   | partial                       |
| MTN-02        | mountain-trail            | 서울      | route_computed (no_route, snap_too_far)            | 3500–13000       | route_computed            |        5133 | 35.99 / 7.98    | match                         |
| MTN-03        | mountain-trail            | 경기      | route_computed                                     | 850–3500         | route_computed            |      1376.8 | 44.94 / 10.48   | match                         |
| RUR-01        | rural                     | 강원      | route_computed (no_route, snap_too_far)            | 2200–7500        | snap_too_far              |           – | 8.51 / 363.26   | partial                       |
| RUR-02        | rural                     | 경북      | route_computed (no_route)                          | 3000–40000       | route_computed            |      1620.3 | 9.41 / 98.69    | mismatch                      |
| RIV-01        | riverside                 | 서울      | route_computed                                     | 1700–5000        | route_computed            |      2185.7 | 7.38 / 19.49    | match                         |
| RIV-02        | riverside                 | 서울      | route_computed                                     | 1200–4500        | route_computed            |      1594.5 | 8.13 / 0.85     | match                         |
| RIV-03        | riverside                 | 경기      | route_computed                                     | 1800–5500        | route_computed            |      2362.4 | 10.01 / 3.45    | match                         |
| RIV-04        | riverside                 | 부산      | route_computed                                     | 1700–5500        | route_computed            |      2026.3 | 23.17 / 9.93    | match                         |
| UNI-01        | campus-apartment          | 서울      | route_computed (no_route)                          | 800–3500         | route_computed            |       953.5 | 2.99 / 0.14     | match                         |
| UNI-02        | campus-apartment          | 서울      | route_computed (no_route)                          | 850–3500         | route_computed            |       816.3 | 2.38 / 2.64     | partial (정정: 원 기록 match) |
| APT-01        | campus-apartment          | 서울      | route_computed (no_route, snap_too_far)            | 550–2800         | route_computed            |      1070.2 | 1.17 / 2.64     | match                         |
| APT-02        | campus-apartment          | 서울      | route_computed (no_route, snap_too_far)            | 650–3000         | route_computed            |       763.5 | 30.92 / 3.11    | match                         |
| ACC-MIL-01    | military-avoidance        | 서울      | route_computed                                     | 1800–6500        | route_computed            |      2300.6 | 1.37 / 11.65    | mismatch **(실격 조건)**      |
| ACC-MIL-02    | military-avoidance        | 경기      | route_computed (no_route)                          | 4000–20000       | route_computed            |      6447.2 | 33.12 / 0.21    | match                         |
| ACC-PRV-01    | access-restricted         | 서울      | route_computed (no_route)                          | 950–5000         | route_computed            |      1896.4 | 3.11 / 3.32     | mismatch **(실격 조건)**      |
| ACC-FOOTNO-01 | bridge-foot-restricted    | 서울      | route_computed (no_route)                          | 2200–11000       | route_computed            |      2599.2 | 21.43 / 13.69   | match                         |
| STR-01        | stairs                    | 서울      | route_computed                                     | 250–1400         | route_computed            |       311.7 | 11.32 / 4.12    | match                         |
| STR-02        | stairs                    | 서울      | route_computed (snap_too_far)                      | 300–2200         | route_computed            |        1093 | 7.35 / 4.47     | match                         |
| UND-01        | underpass                 | 서울      | route_computed                                     | 450–1800         | route_computed            |       676.9 | 0.88 / 2.04     | match                         |
| UND-02        | crosswalk                 | 서울      | route_computed                                     | 180–1100         | route_computed            |       377.8 | 15.38 / 22.84   | match                         |
| BRG-01        | bridge-pedestrian         | 서울      | route_computed (no_route)                          | 950–3000         | route_computed            |      3059.4 | 7.38 / 4.45     | mismatch                      |
| BRG-02        | elevated-walkway          | 서울      | route_computed                                     | 850–3200         | route_computed            |         952 | 0.53 / 13.41    | match                         |
| BRG-03        | bridge-pedestrian         | 서울      | route_computed (no_route)                          | 550–2400         | route_computed            |      1377.6 | 47.15 / 6.89    | match                         |
| FRY-01        | ferry                     | 인천      | route_computed (no_route)                          | 2200–15000       | route_computed            |      2815.7 | 54.19 / 31.77   | match                         |
| FRY-03        | ferry                     | 서울      | route_computed                                     | 7500–25000       | route_computed            |     10777.5 | 0.66 / 1.37     | mismatch **(실격 조건)**      |
| FRY-02        | ferry                     | 제주      | route_computed (no_route)                          | 2800–12000       | route_computed            |      3305.8 | 107.32 / 8.45   | match                         |
| NEG-OFFSHORE  | negative-sea-island       | 서해      | outside_coverage (snap_too_far)                    | –                | outside_coverage          |           – | –               | match                         |
| URB-DGU-01    | urban-core                | 대구      | route_computed                                     | 750–2200         | route_computed            |      1426.4 | 3.3 / 8.98      | match                         |
| URB-GJ-01     | urban-core                | 광주      | route_computed                                     | 650–2200         | route_computed            |       721.7 | 3.02 / 54.03    | match                         |
| URB-DJ-01     | urban-core                | 대전      | route_computed                                     | 700–2200         | route_computed            |       912.1 | 0 / 3.53        | match                         |
| URB-JJ-01     | urban-core                | 제주      | route_computed                                     | 1450–3900        | route_computed            |      1837.6 | 28.24 / 2.81    | match                         |
| URB-GNG-01    | urban-core                | 강원      | route_computed                                     | 950–2900         | route_computed            |      1304.4 | 11.31 / 22.65   | match                         |
| XWK-01        | crosswalk                 | 서울      | route_computed                                     | 220–1200         | route_computed            |       312.5 | 37.14 / 43.45   | match                         |
| XWK-02        | crosswalk                 | 서울      | route_computed                                     | 120–900          | route_computed            |       484.7 | 3.2 / 10.4      | match                         |
| XWK-03        | crosswalk                 | 부산      | route_computed                                     | 180–1100         | route_computed            |        1116 | 18.19 / 12.75   | partial                       |
| XWK-04        | crosswalk                 | 수원      | route_computed                                     | 180–1100         | route_computed            |       186.6 | 10.61 / 34.23   | match                         |
| BRG-04        | bridge-pedestrian         | 서울      | route_computed                                     | 1100–3000        | route_computed            |      1170.8 | 3.98 / 0.11     | match                         |
| BRG-05        | bridge-pedestrian         | 부산      | route_computed                                     | 550–2300         | route_computed            |       512.6 | 4.62 / 18.25    | partial                       |
| BRG-06        | bridge-pedestrian         | 경북      | route_computed (snap_too_far)                      | 420–1800         | route_computed            |       722.8 | 2.66 / 15.26    | match                         |
| BRG-MW-01     | bridge-motorway-only      | 부산      | route_computed                                     | 3500–13000       | route_computed            |      3336.7 | 17.79 / 39.31   | partial                       |
| BRG-MW-02     | bridge-motorway-only      | 인천      | route_computed (no_route, compute_budget_exceeded) | 15000–150000     | route_computed            |     20962.2 | 18.64 / 3.56    | match                         |
| BRG-MW-03     | bridge-motorway-only      | 경기·충남 | route_computed (no_route, compute_budget_exceeded) | 25000–180000     | route_computed            |     45033.3 | 1.49 / 20.76    | match                         |
| BRG-MW-04     | bridge-motorway-only      | 부산·경남 | no_route (route_computed, compute_budget_exceeded) | –                | route_computed            |    143854.3 | 5.2 / 3.48      | partial                       |
| STR-03        | stairs                    | 부산      | route_computed (snap_too_far)                      | 150–1900         | route_computed            |       165.2 | 11.92 / 14.51   | match                         |
| STR-04        | stairs                    | 부산      | route_computed                                     | 70–900           | engine_contract_violation |           – | 1.89 / 11.52    | mismatch                      |
| STR-05        | stairs                    | 대구      | route_computed                                     | 130–1200         | route_computed            |       142.6 | 15.54 / 22.15   | match                         |
| PRK-01        | park                      | 서울      | route_computed                                     | 600–2400         | route_computed            |       709.8 | 5.75 / 3.49     | match                         |
| PRK-02        | park                      | 부산      | route_computed                                     | 950–3300         | route_computed            |      1804.8 | 35.34 / 7.1     | match                         |
| PRK-03        | park                      | 수원      | route_computed                                     | 1500–6000        | route_computed            |      1888.6 | 4.52 / 13.69    | match                         |
| PRK-04        | park                      | 대구      | route_computed                                     | 850–3500         | route_computed            |      1248.3 | 5.16 / 10.29    | match                         |
| PRK-05        | park                      | 제주      | route_computed (no_route)                          | 650–2800         | route_computed            |      1363.7 | 12.13 / 29.13   | match                         |
| PRK-06        | park                      | 강원      | route_computed                                     | 1500–5400        | route_computed            |      2304.4 | 8.02 / 37.26    | match                         |
| TIM-01        | access-time               | 서울      | route_computed (no_route)                          | 1000–4000        | route_computed            |      1926.2 | 3.54 / 57.24    | mismatch                      |
| TIM-02        | access-time               | 서울      | route_computed (no_route, snap_too_far)            | 850–3900         | route_computed            |      1157.9 | 0.09 / 34.48    | match                         |
| TIM-03        | access-time               | 서울      | no_route (route_computed, snap_too_far)            | –                | route_computed            |      1504.1 | 4.64 / 108.65   | partial                       |
| TIM-04        | access-time               | 경북      | route_computed (no_route, snap_too_far)            | 450–2800         | route_computed            |       777.9 | 1.05 / 19.93    | match                         |
| NEG-SEA-02    | negative-sea-island       | 동해      | outside_coverage (snap_too_far)                    | –                | outside_coverage          |           – | –               | match                         |
| NEG-SEA-03    | negative-sea-island       | 제주 남쪽 | outside_coverage (snap_too_far)                    | –                | outside_coverage          |           – | –               | match                         |
| NEG-ISL-01    | negative-sea-island       | 경북 울릉 | no_route (outside_coverage, snap_too_far)          | –                | route_computed            |        1054 | 1.86 / 7.55     | mismatch                      |
| NEG-ISL-02    | negative-sea-island       | 제주      | no_route (outside_coverage, snap_too_far)          | –                | outside_coverage          |           – | –               | match                         |
| NEG-ISL-03    | negative-sea-island       | 제주      | no_route (route_computed, snap_too_far)            | –                | route_computed            |     19384.1 | 17.67 / 0.44    | partial                       |
| NEG-MIL-01    | negative-military         | 충남      | no_route (snap_too_far, outside_coverage)          | –                | snap_too_far              |           – | 11.45 / 559.76  | partial                       |
| NEG-MIL-02    | negative-military         | 경기 북부 | no_route (snap_too_far, outside_coverage)          | –                | route_computed            |     27944.8 | 26.92 / 71.36   | mismatch **(실격 조건)**      |
| NEG-MIL-03    | negative-military         | 경기      | snap_too_far (no_route, outside_coverage)          | –                | snap_too_far              |           – | 206.45 / 21.59  | match                         |
| NEG-EXP-01    | negative-expressway-only  | 인천      | snap_too_far (outside_coverage, no_route)          | –                | snap_too_far              |           – | 9.69 / 1093.5   | match                         |
| NEG-EXP-02    | negative-expressway-only  | 부산      | snap_too_far (outside_coverage, no_route)          | –                | snap_too_far              |           – | 950.09 / 597.37 | match                         |
| NEG-EXP-03    | negative-expressway-only  | 경기·충남 | snap_too_far (outside_coverage, no_route)          | –                | snap_too_far              |           – | 752.47 / 471.33 | match                         |
| NEG-OUT-01    | negative-outside-coverage | 북한      | outside_coverage (snap_too_far)                    | –                | outside_coverage          |           – | –               | match                         |
| NEG-OUT-02    | negative-outside-coverage | 일본      | outside_coverage (snap_too_far)                    | –                | outside_coverage          |           – | –               | match                         |
| NEG-OUT-03    | negative-outside-coverage | 북한      | outside_coverage (snap_too_far)                    | –                | outside_coverage          |           – | –               | match                         |
| NEG-LIM-01    | negative-request-limit    | 서울·수원 | rejected_before_engine                             | –                | rejected_before_engine    |           – | 39.81 / 59.41   | match                         |

## 6. 검토자의 층별·전체 판정

채점: Codex CLI(같은 모델·설정), 빈 임시 디렉터리 `codex-grade/`에 세 파일(사전 등록, blinded 표본, 결과)만 두고
실행했다. 02:24:55Z–02:30:34Z. 로그상 읽은 파일은 그 세 개뿐이다(`filesRead`와 로그의 `open(...)` 대상 일치). 원문:
[m0-06b-coverage-review-grading.txt](m0-06b-coverage-review-grading.txt)(sha256 `e59f64cb…55deee`), 프롬프트
[m0-06b-coverage-review-grading-prompt.txt](m0-06b-coverage-review-grading-prompt.txt).

**산술 정정.** 첫 채점의 `totalScore` 69와 `negative-military` 2는 검토자 자신의 쌍별 점수 합(68.5, 1.5)과
맞지 않았다. 조정자는 채점하지 않고 불일치만 알렸다. 같은 검토자가 새 빈 디렉터리(네 파일)에서 다시 확인해
UNI-02를 "근거 문장은 partial인데 match로 잘못 적었다"고 정정했다(02:32:50Z–02:34:09Z, 원문
[m0-06b-coverage-review-grading-correction.txt](m0-06b-coverage-review-grading-correction.txt), sha256
`952b1011…2b272cc`). 다른 쌍의 채점과 기준은 바꾸지 않았다. **정정 후 총점 68, 판정 `inadequate` 그대로.**

| 층                        |  쌍 | 점수 | 기준 | 충족   |
| ------------------------- | --: | ---: | ---: | ------ |
| urban-core                |  11 |   11 |  8.5 | 예     |
| suburban                  |   4 |    4 |    3 | 예     |
| mountain-trail            |   3 |  2.5 |  2.5 | 예     |
| rural                     |   2 |  0.5 |  1.5 | 아니오 |
| riverside                 |   4 |    4 |    3 | 예     |
| campus-apartment          |   4 |  3.5 |    3 | 예     |
| military-avoidance        |   2 |    1 |  1.5 | 아니오 |
| access-restricted         |   1 |    0 |    1 | 아니오 |
| bridge-foot-restricted    |   1 |    1 |    1 | 예     |
| stairs                    |   5 |    4 |    4 | 예     |
| underpass                 |   1 |    1 |    1 | 예     |
| crosswalk                 |   5 |  4.5 |    4 | 예     |
| bridge-pedestrian         |   5 |  3.5 |    4 | 아니오 |
| elevated-walkway          |   1 |    1 |    1 | 예     |
| ferry                     |   3 |    2 |  2.5 | 아니오 |
| negative-sea-island       |   6 |  4.5 |  4.5 | 예     |
| bridge-motorway-only      |   4 |    3 |    3 | 예     |
| park                      |   6 |    6 |  4.5 | 예     |
| access-time               |   4 |  2.5 |    3 | 아니오 |
| negative-military         |   3 |  1.5 |  2.5 | 아니오 |
| negative-expressway-only  |   3 |    3 |  2.5 | 예     |
| negative-outside-coverage |   3 |    3 |  2.5 | 예     |
| negative-request-limit    |   1 |    1 |    1 | 예     |

- **총점 68/82**(match 63, partial 10, mismatch 9). `adequate`는 ≥70, `adequate with limits`는 ≥62이지만 둘 다
  실격 없음과 핵심 층 충족이 조건이다.
- **실격 4건:** ACC-MIL-01(용산기지 `landuse=military` 영역 안 15.8 m), ACC-PRV-01(`barrier=gate, access=no,
foot=yes` node 통과), FRY-03(`foot=no` 교량 way와 기하 대조 28.6 m), NEG-MIL-02(임진각→판문점 경로 27.9 km,
  군사 영역 안 18.0 km, 그중 공동경비구역 307.6 m).
- **미달 층 7개:** rural, military-avoidance, access-restricted, bridge-pedestrian, ferry, access-time,
  negative-military. military-avoidance와 negative-military는 `adequate with limits`에도 필요한 핵심 층이다.
- **검토자가 바꾸고 싶다고 밝힌 기준(적용하지 않음, 판정에 불리하게 계산):** (1) RUR-02의 최소 거리 3,000 m →
  1,500 m(하회마을–부용대 도선 129 m를 몰랐다), (2) `access=no`+`foot=yes` gate는 보행 허용으로 본다. 검토자는 둘을
  모두 바꿔도 판정은 `inadequate`라고 적었다.

### 6.1 검토자가 적은 결함 (원문 요약)

| pair       | 심각도  | 종류           | 결함                                                                                     | 근거 필드                                               |
| ---------- | ------- | -------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| NEG-MIL-02 | blocker | engine/profile | 판문점까지 통제 군사 지역을 지나는 보행 경로를 제한 없이 낸다                            | `militaryAreaMeters` 18036.4(공동경비구역 307.6)        |
| ACC-MIL-01 | blocker | engine/profile | 용산기지 군사 영역 안으로 들어간다. 경계와 겹친 공개 둘레길일 수 있어 확인 필요          | `militaryAreaMeters` 15.8, area `a12129267`             |
| FRY-03     | blocker | engine/profile | `foot=no` 통과로 표시. 나란한 다른 way의 오대조일 수 있어 way 단위 확인 필요             | `footNoMeters` 28.6 on `w37395728`, trunk road_class 0  |
| BRG-01     | major   | engine/profile | 잠수교를 건넜다는 증거가 없다(반포대로/녹사평대로·primary 1,885 m). 거리도 최대 초과     | `street_name`, `road_class.primary`                     |
| STR-04     | major   | adapter        | 엔진이 낸 짧은 계단 경로(93.4 m, steps 21.6 m)를 adapter가 계약 위반으로 거절한다        | `outcome=engine_contract_violation`, `engineDetailView` |
| TIM-01     | major   | adapter        | 시간 조건 way(`access:conditional=yes @ 6:00-24:00`) 246.9 m를 지나지만 답에 경고가 없다 | `timeConditionMeters` 246.9, `warnings` []              |
| ACC-PRV-01 | minor   | sample-design  | 보행 허용 gate를 사전 기준이 제한 node로 셌다(기준 인공물, gate 현장 확인 필요)          | node `n3792105220`                                      |
| NEG-ISL-01 | minor   | sample-design  | 독도 동도–서도 사이에 OSM `route=ferry`가 있어 "연결 없음" 전제가 틀렸다. 채점은 그대로  | `ferryMeters` 273.7, `서도-동도`                        |
| RUR-02     | minor   | sample-design  | 사전 최소 거리가 실제 도선 경로보다 컸다                                                 | `ferryMeters` 129.3                                     |

검토자가 적은 한계: 82쌍 표적 표본이지 전국 유병률 추정이 아니다. snap 120 m 안의 반올림 좌표라 목적지 "근처"까지만
보인다(TIM-03 도착 snap 108.65 m). 태그 대조는 기하 근접이라 교량 아래·옆 way나 군사 영역 경계의 오대조가 가능하다.
detail view는 층 연결성이나 태그 없는 도로의 실제 통행 가능 여부를 증명하지 않는다. 출발 시각·입장 자격을 주지
않았으므로 공원·궁궐·도선의 실제 이용 가능성은 모른다. 두 번의 동일 결과는 이 graph·표본에서의 재현성이지, graph
갱신 뒤의 정확성이 아니다. 실패한 pair의 detail view는 엔진이 낼 수 있었던 경로이지 운영 adapter의 답이 아니다.

## 7. 제안 매트릭스 판정 (root가 다시 판정한다. 매트릭스는 고치지 않았다)

| 행            | 현재         | 제안                              | 근거                                                                                                                                                                                         |
| ------------- | ------------ | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `P8-coverage` | not_executed | **failed** (검토 수행, 결과 부족) | 게이트가 요구한 절차(graph 신원 고정, 사전 등록, 독립 검토자, 필수 층, 음성 대조)는 이번에 실제로 수행됐다. 그 검토자의 사전 기준에 따른 판정이 `inadequate`다. `passed`로 올릴 근거는 없다. |
| `FUT-07-4`    | not_executed | **not_executed 유지**             | coverage 부분은 위와 같이 부족 판정이다. 게다가 이 행은 ODbL §4.2(URI 제공)·§4.6(파생 DB 공개) 이행과 약관 검토도 요구하는데, 이 작업은 그 부분을 다루지 않았다                              |

## 8. 이 검토의 한계 (조정자 기록)

- 조정자(이 문서 작성자)는 채점하지 않았다. 표·요약은 검토자 출력을 옮긴 것이며, 산술 불일치는 검토자에게 되돌려
  검토자가 정정했다.
- 사전 등록 전에 조정자는 OSM(엔진 아님)으로 5개 점을 옮겼다(§2). 이 조정은 표본을 "경로가 나오기 쉽게" 만든 것이
  아니라 좌표가 도로에서 멀어 판정 불가가 되는 것을 막으려는 것이다. 그래도 표본 설계의 자유도로 남긴다.
- 검토자는 한 명(한 모델)이다. 현장 조사, 실제 통행 확인, 사람 검토는 없다. 판정 근거는 OSM 태그와 엔진 응답이다.
- 이 채점은 사전 기준을 엄격하게 적용했다. 검토자 스스로 결함 중 3건(ACC-PRV-01, NEG-ISL-01, RUR-02)을 표본·기준
  인공물로 분류했다. 그러나 NEG-MIL-02(판문점)와 STR-04(adapter 거절), TIM-01(시간 조건 경고 없음), BRG-01은 표본
  인공물이 아니라고 분류했고, 기준을 바꿔도 판정은 같다.
- STR-04에서 adapter가 어느 계약 검사(거리–geometry 일치, waypoint 순서, detail 범위 등)로 거절했는지는 이번에 진단하지
  않았다.
- NEG-EXP-02·03의 보조 요청은 각각 먼 곳의 도선(`日照 - 平泽`)이나 갈맷길로 snap해 경로를 보여 준다. adapter는
  `snap_too_far`로 거절했으므로 운영 답은 아니다.
- 기존 38쌍 중 10쌍의 geometry 정점 수가 M2-01ak 기록과 조금 다르다(§4). outcome과 거리는 같다.

## 9. 파일

| 파일                                                                                                         | 내용                                     |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| [m0-06b-coverage-review-pairs.json](m0-06b-coverage-review-pairs.json)                                       | blinded 표본(82쌍), probe 입력           |
| [m0-06b-coverage-review-preregistration-prompt.txt](m0-06b-coverage-review-preregistration-prompt.txt)       | 사전 등록 프롬프트(표본 포함)            |
| [m0-06b-coverage-review-preregistration.txt](m0-06b-coverage-review-preregistration.txt)                     | 사전 등록 원문(sha256 `98ef1cee…8a214b`) |
| [m0-06b-coverage-review-results.json](m0-06b-coverage-review-results.json)                                   | 엔진 결과(graph `188b65effcc6ef5c`)      |
| [m0-06b-coverage-review-grading-prompt.txt](m0-06b-coverage-review-grading-prompt.txt)                       | 채점 프롬프트                            |
| [m0-06b-coverage-review-grading.txt](m0-06b-coverage-review-grading.txt)                                     | 채점 원문                                |
| [m0-06b-coverage-review-grading-correction-prompt.txt](m0-06b-coverage-review-grading-correction-prompt.txt) | 산술 확인 요청                           |
| [m0-06b-coverage-review-grading-correction.txt](m0-06b-coverage-review-grading-correction.txt)               | 검토자 정정(UNI-02, 총점 68)             |

재현(harness lock 안에서):

```sh
ROUTING_GRAPH_ROOT=<main checkout>/.geo-build-routing/kr-260901 ROUTING_EXTRACT_SOURCE=osm-extract-south-korea \
  node --import tsx scripts/probe-routing-korea-coverage.mts --execute \
  --pairs docs/implementation/research/m0-06b-coverage-review-pairs.json \
  --report-name m0-06b-coverage-review-results.json
```

## 10. M2-01ay 재채점 (이 문서의 위 절은 바꾸지 않았다)

M2-01ay가 결함을 고친 새 graph `92e0fa5f319a41df`에서 **같은 blinded 표본**을 두 번 돌렸고(82쌍 모두 같음), **같은
검토자**가 **같은 사전 등록**(sha256 `98ef1cee…8a214b`)으로 빈 디렉터리에서 다시 채점했다. 판정은 여전히
**`inadequate`**, 73.5/82, 실격 조건 0건, 미달 층 3개(rural, bridge-pedestrian, negative-sea-island; 검토자 분류로 모두
sample-design). 이의 두 건(FRY-03, ACC-PRV-01)은 검토자가 받아들였다. 기준은 바꾸지 않았다.

- 결과: [m0-06b-coverage-review-results-m2-01ay.json](m0-06b-coverage-review-results-m2-01ay.json)
- 프롬프트·이의·채점 원문: [prompt](m0-06b-coverage-regrade-m2-01ay-prompt.txt),
  [objections](m0-06b-coverage-regrade-m2-01ay-objections.txt), [grading](m0-06b-coverage-regrade-m2-01ay-grading.txt)
- 수정 내용과 근거: [M2-01ay](../progress/M2-01ay.md)
