# M0-06b · 한국 보행 경로 evidence pack (독립 coverage 검토용)

작성일: 2026-09-25. 대상 작업: [M0-06b](../progress/M0-06b.md). 기준 HEAD: `d22f760`.
상태: **증거 준비만 했다. coverage 판정은 하지 않았다(`not_reviewed`).** 판정은 root가 따로 정하는 독립
검토자가 한다. 이 문서의 표는 "통과"나 "충분"을 뜻하지 않는다. 사실로 적은 것도 OSM 태그와 엔진 응답에 대한
사실일 뿐 현장 사실이 아니다.

> **검토자가 먼저 알아야 할 것: 결정 문구와 실제 데이터 범위가 다르다.** 사용자 결정(2026-09-25)은 "현재
> 쓰고 있는 self-hosted GraphHopper 10.0과 **OSM 한국 extract**"를 채택한다고 적었다. 그런데 실제로 쓰는
> extract는 **한국 전체가 아니라 BBBike의 Seoul 도시 extract**다. 근거는 세 곳이다. allowlist
> `scripts/geo/sources.mjs:25-26`, graph manifest의 `extractRegion: "Seoul (BBBike city extract)"`, ADR
> `self-hosted-map-adr.md:20,68`. PBF 헤더 bbox는 `126.58,37.35 – 127.31,37.72`다. 서울, 인천 서부 해안,
> 경기 일부만 들어 있다. 그래서 부산·수원·강원·경북·제주 표본은 이 graph로 계산할 수 없고, 결과도 그렇게
> 나왔다(§3.3). 결정 문구와 데이터 범위 중 어느 쪽을 고칠지는 root와 사용자가 정한다. 이 문서는 둘 다 바꾸지
> 않았다.

## 1. 결정 기록

| 항목            | 값                                                                                                                                                                                            | 근거                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 엔진            | GraphHopper open-source **10.0** (Maven `graphhopper-web-10.0.jar`, Apache-2.0). hosted Directions API가 아니다                                                                               | `scripts/geo/sources.mjs:58-70`, ADR `self-hosted-map-adr.md:26,225-228`                          |
| jar SHA-256     | `e5a1268f2cd6b1e4ef849b9237e98b651bf3c31adf4a3766c6d9f5feb241bb41` (allowlist pin, 재사용 전 대조)                                                                                            | `sources.mjs:65`, `build-routing-graph.mts:259`                                                   |
| profile         | `foot-v1`, 엔진 profile `foot`, `custom_model_files: [foot.json]`(jar 내장). CH·LM 없음(flexible). `import.osm.ignored_highways: motorway,trunk`                                              | `scripts/geo/graphhopper-foot-serving.yml:15-34`                                                  |
| profile SHA-256 | `profileConfigSha256 = e72537c13ecc3fd70dc2197822ff1c247fa5fd8ab37763683419174b2730e37d` (저장소 파일, `.geo-build` 복사본, manifest 세 값 일치를 이번에 다시 확인)                           | `build-routing-graph.mts:261`, `graph-manifest.ts` schema                                         |
| 데이터 출처     | OpenStreetMap, BBBike Seoul extract `https://download.bbbike.org/osm/bbbike/Seoul/Seoul.osm.pbf`                                                                                              | `sources.mjs:24-34`                                                                               |
| extract         | 51,884,841 bytes, SHA-256 `7e13e2adf1025f9a85fa0ecc052c142e51473ba5ab894f01797b1a83f06e0eea`(이번 실행에서 다시 계산해 일치), 헤더 `osmosis_replication_timestamp=2026-09-18T23:00:00Z`       | ADR `self-hosted-map-adr.md:64-76`, 결과 JSON `graph.extractSha256Recomputed`                     |
| 데이터 날짜     | `roadDataAt 2026-09-18T23:00:00Z`(graph가 기록), 서버 `Last-Modified: Sat, 19 Sep 2026 16:20:02 GMT`                                                                                          | manifest, ADR `:72`                                                                               |
| 라이선스        | ODbL 1.0. 표기 `© OpenStreetMap contributors`. routing graph는 ODbL 파생 DB. 경로를 보여줄 때도 OSM 귀속이 필요하다. §4.2 URI 제공과 §4.6 파생 DB 공개 절차는 **정의만 했고 수행하지 않았다** | `sources.mjs:28-32`, ADR `:166-208`                                                               |
| 배포 graph id   | `graphBuildId c57f12f5975347e8` (A), `graphContentSha256 c5fbcdec…a12499`, import `2026-09-21T14:09:12Z`                                                                                      | `.geo-build/routing-graph/foot/routing-graph-manifest.json`, `routing-swap-and-bounds.json:14-22` |
| 다른 graph id   | B `f2448701c8f6e2da`(같은 extract 재import, 교체 시험용), C `1373f16b44750e14`(Seoul extract의 clip `126.90,37.49,127.06,37.62`, 교체 시험용). 둘 다 새 지도 데이터가 아니다                  | `routing-operational-acceptance.json:14-26`, `routing-swap-and-bounds.json:23-39`                 |
| 호스팅 모델     | 엔진은 loopback에만 bind한다. API만 엔진을 부른다. 기동은 `graphhopperJavaArguments`로 한다(`-Ddw.server.request_log.type=external`과 콘솔 WARN threshold로 waypoint 로그를 막는다)           | runbook `operations-runbook.md:483-536`, `scripts/geo/graphhopper-launch.mjs:43,67-86`            |
| 교체            | blue/green: green 엔진을 다른 port로 띄우고 API가 SIGHUP으로 참조 하나를 바꾼다. rollback은 직전 배포로 돌아간다. **원자성은 API 프로세스 하나 안에서만** 성립한다                            | runbook `:541-574`, `progress/M2-01k-e.md:14-56`                                                  |
| 단일 profile    | profile은 `foot-v1` 하나다(contract `z.literal('foot-v1')`). 여러 인스턴스 limiter는 M2-01ah가 풀었다. graph 교체의 원자성은 여전히 한 인스턴스 전제다                                        | `packages/contracts/src/routing.ts:66`, runbook `:590-593`, `progress/M2-01ah.md:3-6`             |
| 한도            | waypoint 2–12, leg 직선 30 km, snap 120 m, deadline 8 s, 방문 노드 1,000,000, 응답 정점 20,000                                                                                                | `packages/contracts/src/routing.ts:21-49`, runbook `:576-589`                                     |

**왜 GraphHopper인가**(ADR `self-hosted-map-adr.md:210-245`의 요약, 이번에 새로 판단하지 않았다):

1. 목표 거리 왕복(`algorithm=round_trip`)이 자체 운영판에 실제로 있다. OSRM `/trip`은 TSP다(`:230-233`).
2. 음성 대조군에서 조용히 성공하지 않는다. OSRM은 해상 좌표에 HTTP 200·0 m를 돌려줬다(`:234-237`).
3. graph가 43 MB로 OSRM의 455 MB보다 10배 이상 작다(`:238`).
4. 포기한 것은 OSRM의 2–3 ms 지연과 작은 RSS다. Valhalla는 빌드조차 하지 않았다(`:240-245`). "Valhalla보다
   낫다"는 주장은 없다.

**Seoul extract를 고른 이유**(ADR `:78-79`): "실제 측정을 지탱하는 가장 작은 지역". 전국 extract는 allowlist에
없다. 전국 비용은 Seoul 수치로 선형 추정하지 않는다(`:306`).

## 2. 데이터 provenance 사슬

```
allowlist id osm-extract-seoul (sources.mjs:24-34, URL 고정, redirect 불허, 크기 상한 300 MiB)
  → fetchAllowedSource: curl --disable --max-redirs 0, 2xx만 허용, Last-Modified/ETag 기록 (sources.mjs:119-183)
  → .geo-build/source/region.osm.pbf  sha256 7e13e2ad…6e0eea
  │   (extract에는 allowlist pin이 없다. jar만 sha256 pin이 있다: sources.mjs:65. extract의 해시는
  │    manifest가 사후에 기록한 값이다.)
  → build-routing-graph.mts --execute
       verifyAllowedSourceFile('graphhopper-web-jar')  jar pin 대조 (:259)
       sha256(extract), sha256(serving profile) 계산 (:260-261)
       serving profile을 .geo-build/routing-graph/config-serving.yml로 복사
       importRoutingGraph: 엔진 import → 엔진 종료 후 graph 파일 해시 (:150-230)
  → routing-graph-manifest.json
       engineVersion 10.0, engineArtifactSha256 e5a1268f…, profileConfigSha256 e72537c1…,
       extractSha256 7e13e2ad…, graphContentSha256 c5fbcdec…, graphImportedAt/roadDataAt (graph properties.txt)
  → graphBuildId c57f12f5975347e8 = manifest에서 유도 (graph-manifest.ts:133 graphBuildIdFromManifest)
  → 기동/요청 시 loadRoutingDeployment: graph 파일·jar·profile 세 해시를 다시 계산해 manifest와 대조,
     불일치면 GRAPH_CONTENT_CHANGED / ENGINE_ARTIFACT_MISMATCH / PROFILE_CONFIG_MISMATCH로 거절
     (packages/server/integrations/src/routing/deployment.ts:155-190)
  → adapter는 엔진 /info로 실행 중 graph 신원을 확인한다. 다르면 graph_mismatch
     (대조군 CTL-GRAPH, routing-coverage-korea.json)
  → RouteRevision에 graph 신원(엔진·버전·jar·profile·extract·graph 해시·build id)이 저장된다
```

manifest가 증명하지 못하는 것(`graph-manifest.ts:19-21`): extract가 운영자가 의도한 파일이었는지, 누군가
graph와 manifest를 함께 다시 만들지 않았는지. 부분들을 서로 묶을 뿐 외부 권위에 묶지 않는다.

이번 실행에서 다시 확인한 것(결과 JSON `graph`): extract 해시를 다시 계산해 manifest와 같았다. 배포 graph
디렉터리의 content hash는 실행 전후 모두 `c5fbcdec…a12499`였고 파일 목록(이름·크기)도 같았다. profile 파일의
해시 세 개(저장소, `.geo-build` 복사본, manifest)도 같았다.

## 3. Coverage evidence set (등급 없음)

### 3.1 방법

- **스크립트:** `scripts/probe-routing-korea-coverage.mts`. 명시 실행(`--execute`)만 동작하고 CI에서는 거절한다.
- **결과:** [`m0-06b-routing-korea-coverage.json`](m0-06b-routing-korea-coverage.json). 호스트 경로와 호스트
  이름은 넣지 않는다. 경로는 `.geo-build/...` 상대 표기만 쓴다. 기계 정보는 platform·arch·cpu 수·메모리·Node
  버전만 싣는다.
- **엔진:** 배포 graph `.geo-build/routing-graph/foot`를 manifest와 대조해 검증했다. 그다음 graph 파일을 임시
  디렉터리에 복사하고, 복사본도 같은 manifest로 다시 검증했다. graphBuildId가 같아야 진행한다. 엔진은
  복사본에서 돌렸다. 이유는 GraphHopper가 적재하는 graph 디렉터리에 lock 파일을 만들기 때문이다. 이 작업은
  `.geo-build`에 쓰지 않는다. 기동은 `startEngine`으로 했다. `startEngine`은 runbook과 같은
  `graphhopperJavaArguments`를 쓴다. port는 8997/8998이다(runbook의 blue 8991, green 8993과 겹치지 않는다).
- **요청 경로:** 운영 `WalkingRouteService`와 `GraphHopperRoutingAdapter`를 기본 한도(snap 120 m, deadline 8 s)로
  썼다. 한 번의 직렬 실행이 tenant 창에 걸리지 않도록 admission 창만 1000건/60초, 동시성 1로 넓혔다.
- **보조 요청:** pair마다 같은 엔진에 `/route`를 한 번 더 보냈다. `details=road_class, road_environment,
road_access, surface`를 붙였다. 실패한 pair의 snap 거리와 class별 미터를 얻기 위해서다. adapter 거리와 1 m
  넘게 다르면 `problems`에 기록한다(이번 실행은 0건). **`road_access`는 GraphHopper 10.0에서 자동차 제한
  key(`motorcar, motor_vehicle, vehicle, access`)로 만든다.** jar 바이트코드 `DefaultImportRegistry`에서
  `OSMRoadAccessParser`에 `TransportationMode.CAR`를 넘기는 것을 확인했다. 따라서 `road_access=no/private`는
  보행 금지를 뜻하지 않는다. 예를 들어 서울로7017은 차량 access=no다.
- **태그 대조:** 같은 extract에서 `osmium tags-filter/export`로 세 가지를 뽑았다. foot·access 태그가 있는
  way와 `route=ferry`, foot·access·barrier node, military 영역이다. 판정 규칙은 다음과 같다.
  - route 선분이 태그 way를 따른다: 선분 중점이 way 선분에서 1.5 m 이내이고 방향 차가 20° 이하.
  - route가 node를 지난다: route 정점이 node에서 1.0 m 이내.
  - route가 military 영역에 들어간다: route 선분 중점이 영역 안.

  이 판정은 기하 대조다. 나란히 놓인 다른 way(교량 아래 보도, 차도 옆 보도)를 잘못 잡을 수 있다(§3.4 FRY-03).

- **좌표:** 공개 랜드마크 근처에서 손으로 고른 반올림 좌표다. 일부러 대략적으로 골랐다. 엔진이 snap하고
  그 거리를 보고한다. 개인 GPS 자료는 쓰지 않았다. FRY-01 도착점만 첫 실행 전에 한 번 고쳤다. 처음 짐작한
  좌표가 선착장에서 약 1.2 km 떨어져 있었다. extract의 `route=ferry` way 끝점으로 선착장 위치를 확인했고,
  엔진 응답은 보지 않았다(스크립트 주석에 기록).
- **실행:** harness lock 안에서 실행했다(`M0-06b <pid>`, trap으로 해제). 실행 전에 3100/4200/4300/4400/8997/8998
  port가 비어 있는지 확인했다. 실행 시간은 약 5초였고 부하는 load average 5.1–10.7(run 2·3, 공유 기계)이었다. 인공 부하는
  만들지 않았다. 로그는 `test-results/m0-06b/`(Git 제외)에 있다.

### 3.2 표본 설계(층화)

38쌍이다(계산 29, snap_too_far 1, outside_coverage 8). 층별로 서울 안(extract 안)과 extract 밖을 섞었다. 표본은 재현할 수 있다. 좌표·순서·id는
스크립트에 고정되어 있다.

| 층                          | pair                                                                                         | extract 안/밖 |
| --------------------------- | -------------------------------------------------------------------------------------------- | ------------- |
| 도심 서울                   | URB-SEL-01–04 (강남·명동·홍대·서울역→강남 9.9 km)                                            | 안            |
| 도심 부산                   | URB-BSN-01–02 (서면·해운대)                                                                  | 밖            |
| 교외                        | SUB-01–03 (분당·일산·평촌), SUB-04 (수원)                                                    | 안 3 / 밖 1   |
| 산악 탐방로                 | MTN-01 북한산 백운대, MTN-02 관악산 연주대, MTN-03 남한산성                                  | 안            |
| 농촌                        | RUR-01 설악산, RUR-02 안동 하회                                                              | 밖            |
| 하천변                      | RIV-01 한강 남안, RIV-02 안양천, RIV-03 탄천, RIV-04 부산 온천천                             | 안 3 / 밖 1   |
| 대학·아파트 단지(사유 도로) | UNI-01 서울대, UNI-02 연세대, APT-01 압구정, APT-02 잠실                                     | 안            |
| 접근 제한(군·사유·foot=no)  | ACC-MIL-01 옛 용산기지, ACC-MIL-02 서울공항, ACC-PRV-01 청와대, ACC-FOOTNO-01 청담 한강 횡단 | 안            |
| 계단·지하도·보행교          | STR-01–02, UND-01–02, BRG-01–03                                                              | 안            |
| 도선                        | FRY-01 월미도→영종도, FRY-03 한강버스 구간, FRY-02 제주 우도                                 | 안 2 / 밖 1   |
| 음성 대조                   | NEG-OFFSHORE 서해                                                                            | 밖            |

### 3.3 결과 (등급 없음)

열 설명: 직선 거리(m), 엔진 거리(m), snap 거리(출발/도착 m), 태그 대조 요약(foot=no m / access=private·no
(foot override 없음) m / access 제한+foot override m / ferry m / 제한 node 수 / military 영역 m).
실패한 pair의 snap은 보조 요청 값이다. `road_class`와 `road_environment`는 보조 요청의 class별 미터 중 눈에 띄는
것만 옮겼다. 전체는 JSON에 있다.

| pair          | 구간                                          | 결과                                                                 |   직선 | 엔진 거리 | snap 출발/도착 | 태그 대조 (foot=no / private·no / 제한+foot override / ferry / node / military) | 눈에 띄는 edge class·환경                            |
| ------------- | --------------------------------------------- | -------------------------------------------------------------------- | -----: | --------: | -------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------- |
| URB-SEL-01    | 강남역 → 역삼역                               | route_computed                                                       |  832.3 |     851.8 | 1.54 / 6.77    | 0 / 0 / 0 / 0 / 0 / 0                                                           | primary 113.5                                        |
| URB-SEL-02    | 명동성당 → 남대문시장                         | route_computed                                                       |  945.7 |    1429.9 | 5.1 / 30.11    | 0 / 0 / 0 / 0 / 0 / 0                                                           | steps 23.6, primary 13.9                             |
| URB-SEL-03    | 홍대입구역 → 합정역                           | route_computed                                                       | 1259.9 |      1469 | 5.01 / 3.35    | 0 / 0 / 35.3 / 0 / 0 / 0                                                        | primary 39.1                                         |
| URB-SEL-04    | 서울역 → 강남역                               | route_computed                                                       | 8066.5 |    9905.2 | 39.81 / 1.54   | 0 / 0 / 77.3 / 0 / 0 / 0                                                        | steps 122.2, path 1015.3, primary 218.5, bridge 1032 |
| URB-BSN-01    | 부산 서면역 → 부산 전포카페거리               | outside_coverage; 엔진: `Point 0 is out of bounds` [extract bbox 밖] |  569.7 |         – | –              | –                                                                               | –                                                    |
| URB-BSN-02    | 해운대해수욕장 → 해운대역                     | outside_coverage; 엔진: `Point 0 is out of bounds` [extract bbox 밖] |  529.4 |         – | –              | –                                                                               | –                                                    |
| SUB-01        | 성남 서현역 → 성남 수내역                     | route_computed                                                       | 1067.1 |    1243.8 | 49.08 / 12.58  | 0 / 0 / 0 / 0 / 0 / 0                                                           | steps 31.3, bridge 151.4                             |
| SUB-02        | 고양 정발산역 → 일산호수공원                  | route_computed (snap_distance_notable)                               |  902.6 |    1156.2 | 6.84 / 73.38   | 0 / 0 / 0 / 0 / 0 / 0                                                           | primary 51.5, bridge 59.3                            |
| SUB-03        | 안양 범계역 → 안양 평촌역                     | route_computed                                                       |  929.7 |    1320.6 | 28.35 / 2.87   | 0 / 0 / 0 / 0 / 0 / 0                                                           | –                                                    |
| SUB-04        | 수원 화성행궁 → 수원 팔달문                   | outside_coverage; 엔진: `Cannot find point 0` [extract bbox 밖]      |  593.4 |         – | –              | –                                                                               | –                                                    |
| MTN-01        | 북한산 북한산성 탐방지원센터 → 북한산 백운대  | snap_too_far                                                         | 2623.5 |         – | 1.82 / 121.13  | –                                                                               | path 3280.9                                          |
| MTN-02        | 관악산 공원 입구 → 관악산 연주대              | route_computed                                                       | 3204.8 |      5133 | 35.99 / 7.98   | 0 / 0 / 0 / 0 / 0 / 0                                                           | path 2858.4, primary 202.6, tunnel 29.5              |
| MTN-03        | 남한산성 남문 → 남한산성 행궁                 | route_computed                                                       |  923.3 |    1376.8 | 44.94 / 10.48  | 0 / 0 / 0 / 0 / 0 / 0                                                           | path 743.5, bridge 5.2, tunnel 10.3                  |
| RUR-01        | 설악산 소공원 → 설악산 비선대                 | outside_coverage; 엔진: `Point 0 is out of bounds` [extract bbox 밖] | 1683.8 |         – | –              | –                                                                               | –                                                    |
| RUR-02        | 안동 하회마을 → 안동 부용대                   | outside_coverage; 엔진: `Point 0 is out of bounds` [extract bbox 밖] |  566.7 |         – | –              | –                                                                               | –                                                    |
| RIV-01        | 반포한강공원 → 잠원한강공원                   | route_computed                                                       | 1802.7 |    2185.7 | 7.38 / 19.49   | 0 / 0 / 0 / 0 / 0 / 0                                                           | tunnel 54.6                                          |
| RIV-02        | 안양천 오목교 → 안양천 신정교                 | route_computed                                                       | 1213.8 |    1594.5 | 8.13 / 0.85    | 0 / 0 / 0 / 0 / 0 / 0                                                           | –                                                    |
| RIV-03        | 성남 정자역 → 성남 미금역                     | route_computed                                                       | 1904.2 |    2362.4 | 10.01 / 3.45   | 0 / 0 / 0 / 0 / 0 / 0                                                           | primary 5.4, bridge 106.1                            |
| RIV-04        | 부산 동래역 → 부산 온천장역                   | outside_coverage; 엔진: `Point 0 is out of bounds` [extract bbox 밖] | 1784.7 |         – | –              | –                                                                               | –                                                    |
| UNI-01        | 서울대 정문 → 서울대 중앙도서관               | route_computed                                                       |  758.6 |     953.5 | 2.99 / 0.14    | 0 / 0 / 0 / 0 / 0 / 0                                                           | tunnel 29.5                                          |
| UNI-02        | 연세대 정문 → 연세대 언더우드관               | route_computed                                                       |  780.6 |     816.3 | 2.38 / 2.64    | 0 / 0 / 557.6 / 0 / 0 / 0                                                       | path 4.9                                             |
| APT-01        | 압구정 현대아파트 단지 내부 → 압구정역        | route_computed                                                       |  583.3 |    1070.2 | 1.17 / 2.64    | 0 / 0 / 22.2 / 0 / 0 / 0                                                        | primary 547.7, bridge 547.7                          |
| APT-02        | 잠실 아파트 단지 내부 → 잠실새내역            | route_computed                                                       |  624.4 |     752.5 | 30.92 / 8.9    | 0 / 0 / 0 / 0 / 0 / 0                                                           | primary 49.2                                         |
| ACC-MIL-01    | 삼각지역 → 이촌역                             | route_computed                                                       | 1468.4 |    2300.6 | 1.37 / 11.65   | 0 / 0 / 0 / 0 / 0 / 15.8                                                        | primary 44.2                                         |
| ACC-MIL-02    | 서울공항 서측 → 서울공항 동측                 | route_computed                                                       | 2844.7 |    6447.2 | 33.12 / 0.21   | 0 / 0 / 0 / 0 / 0 / 0                                                           | primary 1289.3, bridge 109.2                         |
| ACC-PRV-01    | 청와대로 → 삼청공원                           | route_computed                                                       | 1050.1 |    1896.4 | 3.11 / 3.32    | 0 / 0 / 0 / 0 / 1 / 0                                                           | steps 1.8, tunnel 10                                 |
| ACC-FOOTNO-01 | 뚝섬한강공원 → 청담동 한강변                  | route_computed                                                       | 1385.7 |    2599.2 | 21.43 / 13.69  | 0 / 0 / 13 / 0 / 0 / 0                                                          | steps 26.4, primary 416.8, bridge 863.9              |
| STR-01        | 이화마을 → 낙산공원                           | route_computed                                                       |  303.4 |     311.7 | 11.32 / 4.12   | 0 / 0 / 0 / 0 / 0 / 0                                                           | –                                                    |
| STR-02        | 해방촌 108계단 아래 → 해방촌 108계단 위       | route_computed                                                       |  329.2 |      1093 | 7.35 / 4.47    | 0 / 0 / 0 / 0 / 0 / 0                                                           | primary 508.7, tunnel 273                            |
| UND-01        | 시청역 → 을지로입구역                         | route_computed                                                       |  494.7 |     680.4 | 0.88 / 1.77    | 0 / 0 / 0 / 0 / 0 / 0                                                           | primary 137                                          |
| UND-02        | 강남대로 서측(강남역) → 강남대로 동측(강남역) | route_computed                                                       |  189.8 |     377.8 | 15.38 / 22.84  | 0 / 0 / 0 / 0 / 0 / 0                                                           | steps 22.6, primary 100.3, tunnel 123.2              |
| BRG-01        | 반포한강공원 → 잠수교 북단                    | route_computed                                                       | 1004.6 |    3059.4 | 7.38 / 4.45    | 0 / 0 / 0 / 0 / 0 / 0                                                           | primary 1910.2, bridge 1484.2, tunnel 239.8          |
| BRG-02        | 서울역 서부 → 회현역                          | route_computed                                                       |  882.4 |       952 | 0.53 / 13.41   | 0 / 0 / 0 / 0 / 0 / 0                                                           | primary 274.3, bridge 641.4                          |
| BRG-03        | 선유도공원 → 양화한강공원                     | route_computed                                                       |  567.6 |    1377.6 | 47.15 / 6.89   | 0 / 0 / 0 / 0 / 0 / 0                                                           | steps 56.8, bridge 310.5                             |
| FRY-01        | 인천 월미도 선착장 → 영종도 구읍뱃터          | route_computed                                                       | 2286.8 |    2815.7 | 54.19 / 31.77  | 0 / 0 / 0 / 2630.4 / 0 / 0                                                      | other 2630.4, ferry 2630.4                           |
| FRY-03        | 여의도한강공원 선착장 → 압구정 한강 선착장    | route_computed                                                       |   7604 |   10777.5 | 0.66 / 1.37    | 28.6 / 0 / 334.8 / 455 / 0 / 0                                                  | path 638, other 426.6, bridge 1048.7, ferry 426.6    |
| FRY-02        | 제주 성산포항 → 우도 천진항                   | outside_coverage; 엔진: `Point 0 is out of bounds` [extract bbox 밖] | 3022.4 |         – | –              | –                                                                               | –                                                    |
| NEG-OFFSHORE  | 서해 해상 → 서해 해상                         | outside_coverage; 엔진: `Cannot find point 0` [extract bbox 밖]      | 2853.2 |         – | –              | –                                                                               | –                                                    |

실행: 2026-09-25 00:49 UTC(run 3). 00:08 UTC run 2와 pair별 결과·거리가 같다(요약 줄 `cmp` 일치). run 2 다음에
sac_scale 통계만 추가했다.

### 3.4 검토자에게 넘기는 관측 (판정 아님)

아래는 결과 JSON에서 바로 읽을 수 있는 사실이다. 검토자가 볼 곳을 가리킬 뿐이며, 어느 것도 옳다 그르다고
판정하지 않았다.

- **extract 밖 8쌍은 경로를 계산하지 않는다.** 부산·수원·강원·경북·제주와 해상 대조군이다. 엔진 메시지는
  두 가지로 나뉜다.
  - `Point 0 is out of bounds`: graph bbox(`117.81–127.35, 33.53–40.28`) 밖. 이 bbox가 Seoul extract보다
    훨씬 넓은 이유는 인천–중국 `route=ferry` way가 graph에 들어 있기 때문이다.
  - `Cannot find point 0`: bbox 안이지만 가까운 edge가 없다(수원, 해상).

  adapter는 둘 다 `outside_coverage`로 답했다.

- **MTN-01(북한산 백운대)은 `snap_too_far`다.** 보조 요청에서 도착점 snap이 121.13 m로 한도 120 m를 넘었다.
  foot.json은 `hike_rating >= 2`(`sac_scale=mountain_hiking` 이상)의 priority를 0으로 만든다(§4.4). extract의
  sac_scale 통계는 JSON `extractTagStatistics`에 있다. 정상부 탐방로가 이 규칙으로 빠졌는지는 확인하지
  않았다.
- **FRY-01과 FRY-03은 `route=ferry` 구간을 보행 경로에 넣었다.**
  - FRY-01: 월미도–영종도 2,630 m.
  - FRY-03: 여의도→압구정 구간에서 한강버스 426.6 m와 28.4 m.

  profile에는 운항 시간·요금·운항 여부 모델이 없다. 보조 요청의 `road_class`는 `other`, `road_environment`는
  `ferry`다.

- **FRY-03의 `foot=no` 28.6 m는 기하 대조 결과다.** 대상 way는 `w37395728`(`highway=trunk, foot=no,
bridge=yes`)다. profile은 trunk를 import에서 제외한다(`ignored_highways: motorway,trunk`). 그래서 route가 이
  way의 edge를 썼을 수 없다. 교량 아래나 옆으로 나란히 놓인 다른 way가 1.5 m·20° 기준에 걸렸을 가능성이
  크다. 검토자가 형상을 확인해야 한다.
- **`access=no/private` + `foot=yes/designated`**(foot override) way를 쓴 pair: URB-SEL-03, URB-SEL-04,
  UNI-02(연세대 `highway=pedestrian, access=private, foot=yes` 557.6 m), APT-01, ACC-FOOTNO-01, FRY-03. foot
  override가 없는 `access=private/no` 구간은 모든 pair에서 0 m였다.
- **ACC-PRV-01은 gate node `n3792105220`(`barrier=gate, access=no, foot=yes`)를 지난다.** 청와대 권역의 현재
  개방 상태는 확인하지 않았다.
- **ACC-MIL-01은 `landuse=military` 영역 `a12129267` 안을 15.8 m 지난다.** ACC-MIL-02(서울공항)는 military
  영역 0 m이고 6,447 m로 우회했다(직선 2,845 m). 군사 시설은 OSM에서 일부만 그려져 있을 수 있다(§4.1).
- **도로 터널·교량 구간:** STR-02 primary 경로 중 tunnel 273 m, APT-01 primary bridge 547.7 m, BRG-01 primary
  1,910 m / bridge 1,484 m(잠수교인지 반포대교 상판인지 확인 필요), UND-02 tunnel 123.2 m. 보행자가 실제로 쓸 수
  있는 보도인지 확인해야 한다.
- **STR-01·STR-02의 steps 미터는 0이다.** 이 두 pair의 `road_class`에 `steps`가 없다. 계단을 피했는지, 표본
  위치가 계단에 닿지 않았는지는 형상으로 판단해야 한다.
- **snap 30 m 이상인 pair:** URB-SEL-02 도착 30.1, URB-SEL-04 출발 39.8, SUB-01 출발 49.1, SUB-02 도착
  73.4(`snap_distance_notable`), MTN-02 출발 36.0, MTN-03 출발 44.9, APT-02 출발 30.9, ACC-MIL-02 출발 33.1, BRG-03
  출발 47.2, FRY-01 54.2/31.8. 좌표를 대략적으로 고른 탓일 수 있다.
- 이전 M2-01g 표본 6건(KRC-01–06, [routing-coverage-korea.json](routing-coverage-korea.json))도 같은 graph
  `c57f12f5975347e8`로 계산했고 `not_reviewed`로 남아 있다. 검토 범위에 함께 넣을 수 있다.

### 3.5 재현

```sh
# harness lock 안에서, .geo-build가 있는 worktree에서
node --import tsx scripts/probe-routing-korea-coverage.mts --execute
```

- 필요한 것: `osmium`(이번 실행 1.19.1), Java 17, `@workout/contracts` build 산출물. 첫 시도는 contracts
  `dist`가 없어 모듈 로드 단계에서 실패했다(로그 `test-results/m0-06b/probe-run1-module-not-found.log`).
  `turbo run build --filter=@workout/server-integrations^...` 뒤에 다시 실행했다.
- 같은 graph에서 경로 형상은 `geometrySha256`으로 비교한다.
- 실행이 끝나면 `problems`가 비어 있어야 한다. 조건은 네 가지다: 배포 graph 해시·목록 불변, pair 전부 실행,
  경로 하나 이상, adapter 거리와 보조 요청 거리 일치. 하나라도 어기면 exit 1이다. 이것은 "측정이 되었는가"의
  검사이고 coverage 판정이 아니다.

## 4. 알려진 공백

### 4.1 공개 자료로 알려진 한국 OSM 품질 문제

- OSM wiki "South Korea"는 한국 지도가 초기보다 나아졌다고 적는다. 도시마다 완성도가 다르고, 서울은 간선과
  이면도로가 양호하다고 적는다. 반면 강릉처럼 도심 밖이 불완전한 도시가 남아 있다고 한다. 네이버·카카오
  지도의 복제는 공간정보관리법 위반이다. 국가공간정보포털 자료의 업로드도 지도 반출에 해당해 금지다.
  허용되는 것은 위성영상 기반 작도다. <https://wiki.openstreetmap.org/wiki/South_Korea>(2026-09-25 확인).
  → 권위 있는 국가 데이터를 넣을 수 없다. 보행 세부(보도·횡단보도·계단)는 자원자의 영상 판독과 현장 조사에
  달려 있다.
- 같은 문서의 "Security zone" 절은 보안 구역을 한국 안보법 때문에 지우지 말라고 적는다. 군사 시설이 지도에
  있거나 없는 방식이 일관되지 않을 수 있다. 이번 extract의 military 영역은 `landuse=military` 338개,
  `military=*` 63개다(JSON `extractTagStatistics`). 실제 제한 구역과 대조하지 않았다.
- SotM 2021 발표 "OpenStreetMap and the neglected pedestrian"(Edoardo Neerhut)는 다섯 도시의 보행 데이터를
  비교했다. 그중 하나가 충남 예산이다. 결론은 도시마다 보행 데이터 품질이 크게 다르고, 차량 중심의 매핑이
  보행 정보를 소홀히 한다는 것이다.
  <https://media.ccc.de/v/sotm2021-10029-openstreetmap-and-the-neglected-pedestrian>.
- OSM wiki "Sidewalks"에 따르면 보도를 그리는 방식은 두 가지다. `sidewalk=*` 도로 태그와 별도
  `highway=footway` + `footway=sidewalk` way다. 별도 way 방식은 횡단 지점을 따로 그리지 않으면 경로 문제가
  생긴다. <https://wiki.openstreetmap.org/wiki/Sidewalks>. 이번 extract에는 `highway=steps` 5,425개
  (130 km)가 있다. 보도 매핑 방식의 비율은 측정하지 않았다.

### 4.2 접근 태그 (이번 extract의 실제 분포)

`extractTagStatistics`에서 옮겼다. highway way 수와 길이다.

| 태그                                       | 수            | km            | GraphHopper 10.0 foot에서                                                                                                                                                     |
| ------------------------------------------ | ------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `foot=no`                                  | 1,829         | 467.6         | 통행 불가(`foot_access=false`)                                                                                                                                                |
| `access=no` (foot 없음)                    | 688           | 140.7         | 통행 불가                                                                                                                                                                     |
| `access=private` (foot 없음)               | 667           | 148.2         | 통행 불가(`block_private` 기본 true)                                                                                                                                          |
| `access=permit`                            | 117           | 22.2          | 통행 불가(restricted 값에 `permit` 포함)                                                                                                                                      |
| `access=no` + `foot=yes/designated`        | 396           | 41.6          | 통행 가능(더 구체적인 `foot`가 이긴다)                                                                                                                                        |
| `access=private` + `foot=yes` 등           | 12            | 3.0           | 통행 가능                                                                                                                                                                     |
| `access=destination/customers` (foot 없음) | 38            | 4.0           | 통행 가능(restricted 값이 아니다)                                                                                                                                             |
| `highway=trunk` / `trunk_link`             | 2,098 / 2,213 | 938.2 / 416.2 | trunk는 import 제외, trunk_link는 제외 목록에 없다                                                                                                                            |
| `highway=corridor`                         | 442           | 11.0          | foot 허용 highway 목록에 없어 graph에 없다                                                                                                                                    |
| `sac_scale=mountain_hiking` 이상           | 172           | 63.1          | 통행 불가(foot.json `hike_rating >= 2` → priority 0). 철자가 표준과 다른 값 2개(`alpine_hike`, `demanding_mountain_hike`)는 매핑되지 않아 제외되지 않는 것으로 보인다(미확인) |

- 한국 아파트 단지와 대학 내부 도로에는 access 태그가 없는 경우가 많을 수 있다. 태그가 없으면 엔진은
  통행 가능으로 본다. 이번 APT-01·APT-02 경로의 단지 도로에는 access 태그 매치가 없었다. 실제 출입 통제
  여부는 확인하지 않았다.
- 시간 제한(`access:conditional`, 공원 개방 시간, 침수 통제)은 반영되지 않는다. `foot_temporal_access`
  encoded value는 jar에 있지만 serving profile의 `graph.encoded_values`에 없다(`graphhopper-foot-serving.yml:18`).

### 4.3 실내 통로

- `highway=corridor` 442개(11.0 km)는 foot 허용 highway 목록에 없다. 목록은 jar 바이트코드
  `FootAccessParser`의 `allowedHighwayTags`에서 읽었다: footway, path, steps, pedestrian, living_street, track,
  residential, service, platform, trunk(+link), primary(+link), secondary(+link), tertiary(+link), cycleway,
  unclassified, road. 그래서 지하상가나 역 연결 통로가 `corridor`로 그려져 있으면 경로에 쓰이지 않는다.
- `indoor=yes`인 highway way 560개(13.5 km)는 `highway`가 허용 목록에 있으면 쓰일 수 있다. 층(`level`) 구분은
  하지 않는다. UND-01(시청→을지로입구) 경로의 `road_environment`에는 tunnel이 0 m다. 지하상가 대신 지상 edge만 썼다는 뜻으로 보인다. 올바른지는
  검토자가 본다.
- 엘리베이터, 개찰구, 역사 운영 시간은 모델에 없다.

### 4.4 엔진 profile이 `access=private`와 `foot=no`를 처리하는 방식

GraphHopper 10.0 소스와, 배포에 쓴 jar(sha256 `e5a1268f…`)의 바이트코드 두 곳에서 확인했다.

1. `FootAccessParser(EncodedValueLookup, PMap)` 생성자는 `blockPrivate(properties.getBool("block_private", true))`,
   `blockFords(getBool("block_fords", false))`를 호출한다. serving profile은 둘 다 설정하지 않는다. 따라서
   private는 막고 ford는 허용한다.
2. `AbstractAccessParser`의 restricted 값은 `no, restricted, military, emergency, private, permit`이다.
   restriction key는 `OSMRoadAccessParser.toOSMRestrictions(FOOT)`의 결과로 `foot, access` 순서다.
   `getFirstIndex`를 쓰므로 먼저 나오는 `foot` 값이 우선한다. 결과는 이렇다.
   - `foot=no`는 언제나 막는다.
   - `access=private` + `foot=yes`는 통행 가능이다.
   - `access=destination/customers/delivery`는 restricted 값이 아니므로 통행 가능이다.
3. 막힌 way는 `foot_access=false`가 된다. `foot.json`의 첫 규칙 `if !foot_access || hike_rating >= 2 → priority
0`이 그 edge를 쓰지 못하게 한다. 같은 규칙이 `sac_scale=mountain_hiking` 이상(hike_rating 2+)과
   `mtb_rating > 2`도 막는다. `OSMHikeRatingParser`의 매핑은 hiking=1, mountain_hiking=2 … 이고 바이트코드로
   확인했다.
4. barrier node(`access=no|private` gate 등)는 `handleBarrierEdge`가 해당 edge의 접근을 끈다. 그러나 node에
   `foot=yes`가 있으면 통과한다(ACC-PRV-01의 gate).
5. `road_access` encoded value는 자동차 key로 만든다(§3.1). 경로 응답의 `road_access`로 보행 제한을 추론하면
   안 된다.
6. `import.osm.ignored_highways: motorway,trunk`는 trunk에 `sidewalk=*`나 `foot=yes`가 있어도 import에서
   빼 버린다. `FootAccessParser` 자체는 trunk를 허용 목록에 두고, sidewalk가 있으면 WAY로 인정한다. 따라서 이
   제외는 profile의 선택이다. 이번 extract에서 `trunk` + `foot=yes`는 1개(3.5 km)이고 `trunk` + `sidewalk`는
   0개다. `trunk_link` + `sidewalk`는 6개다. 한국 도심 대로가 `trunk`로 그려진 구간의 옆 보도는 별도
   `footway`로 그려져 있어야 경로에 쓰인다.

출처: <https://raw.githubusercontent.com/graphhopper/graphhopper/10.0/core/src/main/java/com/graphhopper/routing/util/parsers/FootAccessParser.java>,
`OSMRoadAccessParser.java`(같은 tag), jar 내 `com/graphhopper/custom_models/foot.json`, `javap -c -constants`로 본
`FootAccessParser`, `AbstractAccessParser`, `OSMHikeRatingParser`, `DefaultImportRegistry` 클래스.

## 5. 다른 증거가 필요한 항목

사용자 지시에 따라 실기기 작업은 보류 상태다. Simulator·데스크톱 증거로 실기기 증거를 대신하지 않는다.

| 항목                | 있는 증거                                                                                                                                                                                                   | 증거의 종류                             | 상태                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| OS 한글 IME         | 합성 composition event 시험(`tests/identity/courses.spec.ts:220`, UI spike Playwright). Aside·Chrome으로 OS IME를 시도했지만 입력 대상 창을 안정적으로 잡지 못했다(`progress/M0-06b.md` "OS IME 추가 시도") | 데스크톱 브라우저 합성 이벤트           | **not_executed** (matrix `R-touch-ime` not_executed, `P5-keyboard-ime` partial)                         |
| 물리 touch          | Playwright의 pointer/touch 모사, 위/아래 버튼 대안, 키보드 드래그 취소(`progress/M0-06b.md` 상호작용 절). iOS Simulator 회전·키보드 표시(`progress/M0-06c.md:88-176`)                                       | 데스크톱 모사 / **Simulator 전용**      | **not_executed** (실제 손가락 입력 없음)                                                                |
| WKWebView 입력·IME  | Simulator에서 키보드 표시·닫힘과 회전만 확인. 실제 입력·IME 조합은 없음(`progress/M0-06c.md:175-182`)                                                                                                       | **Simulator 전용**                      | **not_executed** (M0-06c gate)                                                                          |
| 클라이언트 성능     | `performance-budget.json` desktop 예산(headless Chromium, 공유 기계), `ui-spike-performance-result.json`(CDP CPU 4배 감속)                                                                                  | **데스크톱 전용**                       | 실기기 `realDevice.status = not_executed`, 예산 없음(`performance-budget.json:528-553`)                 |
| 서버·엔진 성능      | `performance-budget-result.json`(engine idle/load RSS, route under load), `course-performance.json`, `routing-operational-acceptance.json`                                                                  | 개발 기기(darwin/arm64, 8 CPU) loopback | 운영 호스트 측정 없음. `ROUTING_ENGINE_CONCURRENCY` 기본 8은 측정된 최적값이 아니다(runbook `:581-584`) |
| 배포 조건           | ADR 8·9절 요구사항, blue/green·한도·공유 limiter 구현(runbook `:541-645`)                                                                                                                                   | 로컬 구현·시험                          | 실제 호스팅, TLS·CDN, SLO, 비용, 운영 rollback 리허설은 **미수행**(ADR `:354-365`)                      |
| ODbL 공개 배포 의무 | 절차 정의(ADR `:186-208`)                                                                                                                                                                                   | 문서                                    | **미수행**(matrix `FUT-07-4` not_executed)                                                              |
| 한국 coverage 판정  | 이 문서와 JSON, M2-01g의 KRC 6건                                                                                                                                                                            | 엔진 응답 + OSM 태그                    | **not_reviewed**. 독립 검토자 판정 전(matrix `P8-coverage` not_executed)                                |

## 6. 이 문서가 하지 않은 것

- coverage가 충분하다거나 부족하다고 판정하지 않았다. 표본의 기대 결과도 적지 않았다.
- 결정 문구("한국 extract")와 실제 데이터(Seoul extract)의 차이를 해소하지 않았다. 전국 extract를 allowlist에
  넣거나 graph를 다시 만들지 않았다. `.geo-build`에는 쓰지 않았다.
- task-graph 상태와 요구 매트릭스를 바꾸지 않았다. 실기기·OS IME 증거를 만들지 않았다.
