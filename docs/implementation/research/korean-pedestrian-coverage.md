# 한국 보행 coverage 관측 (M2-01g)

상태: **`not_reviewed`. 이 문서는 통과 판정이 아니다.**
기계 판독 기록: [routing-coverage-korea.json](routing-coverage-korea.json).
실행 도구: `node --import tsx scripts/build-routing-graph.mts --execute` 로 graph를 빌드한 뒤
`node --import tsx scripts/probe-routing-coverage.mts --execute`.
실행 환경: Node v24.12.0, darwin/arm64, 8 CPU, 32 GiB.

계획 [8절](../map-implementation-plan.md)의 보행 coverage 증거 요건은 **graph 신원 고정,
사전 기대 결과, 독립 검토자, 도심/횡단보도/다리/계단/공원/접근시간 대조, 음성 대조,
그리고 HTTP 200만으로 통과 금지**다. 이번 작업은 앞의 두 가지와 음성 대조를 충족했고,
**독립 검토자와 대조 근거(ground truth)는 충족하지 못했다.** 그래서 상태는 그대로
`not_reviewed`이며, M0-06b가 요구하는 승인은 여전히 미완이다.

## 1. 고정한 graph 신원

신원은 **graph를 빌드한 시점에 manifest로 기록하고, 적재 시점에 다시 검증한다.** 설정
파일에 적은 해시는 운영자의 의도일 뿐 엔진이 실제로 읽은 바이트가 아니므로, 아래 값들은
빌드 과정이 계산하고(`routing-graph-manifest.json`) 이번 측정이 디스크에서 다시 계산해
대조한 것이다.

| 항목                   | 값                                                                    |
| ---------------------- | --------------------------------------------------------------------- |
| engine                 | GraphHopper open-source, 빌드 시 `/info`가 보고한 `version: "10.0"`   |
| engine jar SHA-256     | `e5a1268f2cd6b1e4ef849b9237e98b651bf3c31adf4a3766c6d9f5feb241bb41`    |
| profile 설정           | `scripts/geo/graphhopper-foot-serving.yml`, SHA-256 `e72537c1…30e37d` |
| profile id             | `foot-v1` (엔진 내부 profile 이름 `foot`)                             |
| extract SHA-256        | `7e13e2adf1025f9a85fa0ecc052c142e51473ba5ab894f01797b1a83f06e0eea`    |
| extract 크기           | 51,884,841 B, Seoul (BBBike city extract)                             |
| **graph 파일 SHA-256** | `c5fbcdecf780a5052c97e6e063ab88294523b38f691b2cf3b6a8629578a12499`    |
| `graphBuildId`         | `c57f12f5975347e8` (manifest의 모든 항목에서 파생)                    |
| graph `import_date`    | 2026-09-21T14:09:12Z (graph의 `properties.txt`에서 읽음)              |
| graph `data_date`      | 2026-09-18T23:00:00Z (같은 곳)                                        |

적재 시 `loadRoutingDeployment`가 graph 디렉터리뿐 아니라 **이 run이 실제로 실행할 엔진
jar와 profile 설정 파일까지** 해싱해 manifest와 대조하고, 하나라도 다르면 거절한다. 어댑터는 **캐시 없이 매 계산마다** `/info`의 `version`·`data_date`·**`import_date`** 를
manifest 값과 대조하며, 재수입된 graph는 같은 설정이라도 다른 배포로 보고
`graph_mismatch`를 돌려준다(아래 CTL-GRAPH).

측정 전후로 graph 파일 해시가 같음을 이번 run이 스스로 확인했다
(`graphContentVerifiedBeforeRun` == `graphContentVerifiedAfterRun` == `c5fbcdec…`).
그래서 아래 결과는 이 graph에 귀속된다.

## 2. 사전 기대와 관측 (6건)

기대값은 **실행 전에** `scripts/probe-routing-coverage.mts`에 적었다. 기대와 어긋나면
probe가 mismatch를 기록하고 **exit 1**로 끝난다. 한 건(KRC-03)은 케이스가 주장한 상황을
만들지 못해 좌표와 기대값을 한 번 고쳤고, 그 사실과 원래 값은 아래와 JSON의
`expectationRevision`에 남아 있다. 그 외에는 결과를 보고 기대값을 바꾸지 않았다.

| id     | 주제      | 사전 기대                       | 관측                             | 최대 snap | 지연  |
| ------ | --------- | ------------------------------- | -------------------------------- | --------- | ----- |
| KRC-01 | 도심 도로 | `route_computed`, 1,000–2,000 m | `route_computed` 1,281.8 m, 48점 | 10.01 m   | 77 ms |
| KRC-02 | 횡단보도  | `route_computed`, 180–1,500 m   | `route_computed` 200.4 m, 9점    | 7.91 m    | 9 ms  |
| KRC-03 | 교량      | `route_computed`, 1,500–5,000 m | `route_computed` 2,169.3 m, 32점 | 14.56 m   | 9 ms  |
| KRC-04 | 계단·경사 | `route_computed`, 400–4,000 m   | `route_computed` 1,299.5 m, 83점 | 31.02 m   | 10 ms |
| KRC-05 | 공원      | `route_computed`, 300–3,000 m   | `route_computed` 750.7 m, 33점   | 15.05 m   | 7 ms  |
| KRC-06 | 접근 시간 | `route_computed`, 800–4,000 m   | `route_computed` 1,340.3 m, 31점 | 4.35 m    | 7 ms  |

**각 결과의 좌표 전체가 JSON의 `geometry`에 들어 있다**(`snappedWaypoints`와 snap 거리도
함께). 검토자가 해시와 점 개수를 믿지 않고 직접 지도에 올려 대조할 수 있어야 하기 때문이다.
**여섯 건 모두 `coverageReview`는 `not_reviewed`다.** 엔진이 답했다는 사실은 그 길을 실제로
걸을 수 있다는 뜻이 아니다.

### 기대값을 고친 한 건과 그 이유

KRC-03은 처음에 여의도 부근 `[126.93, 37.525] → [126.932, 37.537]`을 쓰고
`route_computed` 1,000–4,000 m를 기대했으나 관측은 `snap_too_far`였다. 북측 지점이
보행 네트워크에서 120 m 넘게 떨어져 있어서, **그 케이스가 주장한 상황(교량 통과)을
애초에 만들지 못한 것**이 원인이다. 그래서 좌표를 동작대교 남·북단으로 옮기고
(옮기기 전 snap 거리 14.6 m / 2.0 m를 먼저 확인했다) 기대값을 다시 적었다. 엔진 동작이
기대와 달라서 기대를 낮춘 것이 아니다.

### KRC-02에 대한 유보

직선 거리 약 176 m 구간에서 200.4 m가 나왔다. 횡단보도를 실제로 경유했는지, 아니면
차도를 가로지르는 way를 탔는지 **이 문서는 판정하지 않는다.** 어댑터는 `road_class`
상세를 받아 형상 전체를 덮는지만 검사하고 그 값을 결과에 담지 않는다. 검토자가 JSON의
좌표로 직접 확인해야 할 항목이다.

## 3. 대조군 9건 — 측정이 비어 있지 않다는 증거

전부 같은 run에서 **실제 엔진**(CTL-ECHO 제외)에 대해 관측했고, 9건 모두 사전 기대와 일치했다.

| id                | 조건                                        | 관측                            |
| ----------------- | ------------------------------------------- | ------------------------------- |
| CTL-OFFSHORE      | 서해 좌표 2점                               | `outside_coverage`              |
| CTL-ECHO          | 요청 좌표와 0 m를 돌려주는 stub 엔진        | `engine_contract_violation`     |
| CTL-GRAPH         | 같은 엔진을 버전 `9.9`로 고정               | `graph_mismatch`                |
| CTL-SNAP          | 네트워크에서 ~90 m 떨어진 점, snap 상한 5 m | `snap_too_far`                  |
| CTL-BUDGET        | `max_visited_nodes=10`                      | `compute_budget_exceeded`       |
| CTL-DEADLINE      | 호출자 deadline 1 ms                        | `timeout`                       |
| CTL-CANCEL        | 호출자가 abort                              | `cancelled`                     |
| CTL-OVERLOAD      | 한 tenant가 rate window 초과                | `overloaded` (retry-after 60 s) |
| CTL-REQUEST-BOUND | 직선 leg 상한 초과                          | 엔진 호출 전 거절               |

판정이 비어 있지 않다는 것도 확인했다: KRC-01의 기대 거리를 일부러
90,000–95,000 m로 바꿔 돌린 실행에서 probe가 mismatch를 보고하고 **exit 1**로 끝났다
(관측 1,281.8 m). 원래 기대로 되돌린 실행은 exit 0이다.

## 4. 이번에 측정한 엔진 동작 (GraphHopper 10.0)

아래 셋은 **같은 probe가 엔진을 다시 띄워 직접 관측**하고 원본 응답을 JSON의
`engineObservations`에 남긴 것이다. 터미널에서 본 것을 옮겨 적은 서술이 아니다.

| 실험                         | 설정 변경                                         | 관측                                                         |
| ---------------------------- | ------------------------------------------------- | ------------------------------------------------------------ |
| `EXP-TIMEOUT-AS-NOROUTE`     | `routing.timeout_ms: 30000` → `1`                 | HTTP 400 `ConnectionNotFoundException`                       |
| `EXP-CONFIG-KEY-IGNORED`     | `routing.non_ch.max_visited_nodes: 10` 추가       | HTTP 200, 경로 반환 1,281.844 m, `visited_nodes.sum` **722** |
| `EXP-REQUEST-PARAM-ENFORCED` | 없음(운영 profile), 요청에 `max_visited_nodes=10` | HTTP 400 `MaximumNodesExceededException`                     |

읽는 방법:

- **서버 timeout은 NoRoute와 구별되지 않는다.** 그래서 운영 profile의 `routing.timeout_ms`는
  호출자 deadline(8초)보다 훨씬 큰 30초로 두고, 그 값이 발동했을 가능성을 `no_route` 결과에
  `no_route_may_be_engine_budget` warning으로 남긴다.
- **설정 키는 무시되고 요청 파라미터는 강제된다.** 그래서 엔진 측 자원 상한은 profile 파일이
  아니라 어댑터가 매 요청에 실어 보내는 `max_visited_nodes`다.
- `/info`가 버전 문자열을 준다. M2-01d는 기동 로그에서 읽지 못해 `null`로 남겼다.

추가로, **서울 도심에서 120 m snap 상한은 거의 발동하지 않는다.** 네트워크가 촘촘해 멀리
떨어진 점도 수십 m 안에 붙고, 더 먼 점은 엔진 자체 location index 한계로 `PointNotFound`가
된다. 그래서 live `snap_too_far`는 상한을 5 m로 낮춘 대조군으로만 관측했다.

## 5. 충족하지 못한 것 — 승인에 남은 공백

`coverageStatus`가 `not_reviewed`로 남는 이유다. 아래가 채워지기 전에는 통과가 아니다.

1. **독립 검토자가 없다.** 구현자가 기대값을 쓰고 구현자가 실행했다. 계획 8절은 독립
   검토자를 요구한다.
2. **대조 근거가 없다.** 여섯 경로 중 어느 것도 공식 자료나 현장 확인과 대조하지 않았다.
   경로 형상이 그럴듯하다는 것은 근거가 아니다. (좌표는 JSON에 있으므로 대조 자체는 가능하다.)
3. **서울 밖은 전혀 보지 않았다.** 고정한 extract가 BBBike Seoul이다. 이 측정은 한국
   전역 coverage에 대해 아무 말도 하지 않는다.
4. **접근 시간·야간 통행·일시 폐쇄 모델이 없다.** KRC-06은 경로를 돌려줬지만 profile에
   시간대 개념 자체가 없다. 결과 어디에도 개장 시간 필드가 없다. 누락은 충족이 아니다.
5. **계단·무단차 대안·노면 판단이 없다.** 어댑터는 `road_class` 상세를 검증에만 쓰고
   결과에 담지 않으므로, KRC-04가 계단을 지나는지 결과만 보고는 알 수 없다.
6. **횡단보도 경유 여부를 결과로 판정하지 못한다**(2절의 KRC-02 유보).
7. **표본이 6건뿐이고 전부 합성 좌표다.** 사용자 GPS는 쓰지 않았고, 통계적 대표성도 없다.

## 6. 이 문서가 주장하지 않는 것

- 통행 가능·안전·접근성에 대한 어떤 보장도 하지 않는다.
- 운영 배포, 부하, graph 교체 리허설을 하지 않았다. 측정은 개발 기기의 loopback 엔진이다.
- 외부 routing 서비스를 호출하지 않았고, 유료 서비스를 계약하지 않았다.
- manifest는 graph·extract·profile·엔진 아티팩트를 **서로** 묶을 뿐, 그 extract가 운영자가
  의도한 것임을 외부 권위에 대해 증명하지는 못한다. graph와 manifest를 함께 다시 만든
  경우도 구별하지 못한다.
- M0-06b의 coverage 승인 상태를 바꾸지 않는다. 그 상태는 여전히 `not_reviewed`다.
