# ADR · 자체 지도 배경과 보행 경로 엔진 운영

결정일: 2026-09-21. 대상 작업: [M2-01d](../progress/M2-01d.md). 기준 계획:
[지도 구현 계획](../map-implementation-plan.md) 1·6·8절.

상태: **엔진·타일 형식·배포 형태는 결정. 운영 검증은 보류.**
예산과 호스팅 환경이 정해지지 않았으므로 준비 작업(빌드·측정·경계)만 수행했고,
실제 배포·용량 산정·SLO·비용 계약은 하지 않았다. 아래 "보류" 절이 그 범위를 명시한다.

측정 원본: [basemap 빌드 기록](self-hosted-basemap-build.json),
[엔진 측정](routing-engine-measurements.json),
[브라우저 측정](self-hosted-map-performance.json). 모두 같은 개발 기기(darwin/arm64,
8 core, 34.4 GB RAM)에서 실행했고 재실행 이력은 각 파일의 `previousRuns`에 남는다.

## 1. 결정 요약

| 항목        | 결정                                                                | 근거 절 |
| ----------- | ------------------------------------------------------------------- | ------- |
| 렌더러      | MapLibre GL JS **6.9.1** (기존 고정 버전 그대로)                    | 2       |
| 대상 지역   | Seoul BBBike city extract                                           | 3       |
| 타일 빌더   | `osmium tags-filter/export` → `tippecanoe`                          | 4       |
| 빌드 산출물 | MBTiles(SQLite) 1개                                                 | 4       |
| 배포 형태   | gzip 그대로의 정적 XYZ 피라미드 + style/glyph/sprite, 버전 디렉터리 | 4·5     |
| glyph       | Noto Sans Regular SDF 3구간 자체 호스팅 + 한글은 기기 로컬 렌더     | 6       |
| sprite      | 저장소에서 직접 생성(PNG 인코더 자체 구현)                          | 6       |
| 보행 엔진   | **GraphHopper 10.0 open-source**                                    | 7       |

## 2. 렌더러

계획 6절대로 기존 고정 버전을 먼저 검증했다. MapLibre **6.9.1**(M0-06b에서 고정,
BSD-3-Clause)이 자체 생성 타일·style·glyph·sprite를 모두 렌더했고 버전을 올릴 이유를
찾지 못했다. 실제 화면 증거는 M2-01d 진행 기록의 Aside 절에 있다.

검증 중 확인한 MapLibre의 제약 두 가지를 기록한다.

- `sprite`·`glyphs`·`sources[].tiles`는 **절대 URL이어야 한다**. 상대 경로면
  `Invalid sprite URL ... must be absolute`로 style 적용이 실패한다. 그래서 style에는
  같은 origin의 절대 **경로**(`/map/basemap/<deploymentId>/…`)를 저장하고, geo-kit adapter가
  style을 직접 받아 외부 참조가 없는지 확인한 뒤 **우리 프로토콜 접두사**
  (`geokit-self://self`)를 붙여 넘긴다(아래 참조). origin 판정은 실제 URL 파서로 하고,
  치환자를 보존해야 하므로 접두사 결합 자체는 문자열 연결로 한다(`new URL()`은
  `{fontstack}`·`{z}/{x}/{y}`를 percent-encoding 한다).
- **attribution은 sanitize되지 않는다고 봐야 한다.** 설치된 6.9.1 번들의 `sanitize`는
  `script`/`iframe` 제거와 `javascript:`·`data:` src/href, `srcdoc`, `on*` 속성 차단만 한다
  (번들 직접 확인). `<img src="https://…">`는 그대로 남아 외부 요청이 되며 `transformRequest`를
  거치지 않는다. 그래서 style의 attribution은 평문과 `<a href>`만 허용한다. **TileJSON도 같은
  경로다**: 렌더러는 TileJSON의 `attribution`을 source에 합치므로, 자산 loader가
  `type: 'json'`으로 받은 응답에 같은 검사를 적용하고(객체면 전부, 배열이면 외부 참조 검사)
  TileJSON의 `tiles` 배열도 transport로 재작성한다.
- **renderer가 어떤 자산도 직접 받아오게 두지 않는다.** request hook은 **처음 URL만** 보고
  renderer는 redirect를 따라가므로, 같은 origin의 타일·glyph·sprite endpoint가 302로 외부를
  가리키면 그대로 옮겨 간다. style URL 요청은 hook을 아예 통과하지도 않는다. 그래서 style의
  모든 자산 URL을 `geokit-self://self/…`로 바꾸고 그 프로토콜 loader에서만 실제 fetch를
  수행한다(`redirect: 'error'` + 응답 origin 재확인). MapLibre worker는 모르는 프로토콜
  요청을 main thread로 넘기므로 타일도 같은 loader를 지난다. 라이브러리는 소비자의 CSP를
  보장할 수 없으므로, 이 방어는 CSP와 **독립적으로** 성립해야 한다.
  대가: 타일 fetch가 main thread에서 일어나고 바이트가 worker 경계를 한 번 더 건넌다.
- MapLibre 6의 worker는 별도 ESM 파일(`maplibre-gl-worker.mjs` + `maplibre-gl-shared.mjs`)
  이며 번들러가 자동으로 내보내지 않는다. 두 파일을 같은 origin에 복사하고
  `setWorkerUrl`로 지정해야 vector tile 요청 자체가 발생한다(worker가 없으면 style·sprite만
  받고 타일 요청이 0건이라 조용히 배경 없는 지도가 된다). 기존 UI spike가
  `scripts/copy-map-worker.mjs`로 쓰는 방식과 같다.

## 3. 대상 지역과 데이터 출처

| 항목      | 값                                                                  |
| --------- | ------------------------------------------------------------------- |
| 지역      | Seoul (BBBike city extract)                                         |
| URL       | `https://download.bbbike.org/osm/bbbike/Seoul/Seoul.osm.pbf`        |
| 크기      | 51,884,841 bytes                                                    |
| SHA-256   | `7e13e2adf1025f9a85fa0ecc052c142e51473ba5ab894f01797b1a83f06e0eea`  |
| 서버 표기 | `Last-Modified: Sat, 19 Sep 2026 16:20:02 GMT`, `ETag "2533873529"` |
| 라이선스  | ODbL 1.0 (OpenStreetMap contributors)                               |
| 취득 경로 | `scripts/geo/sources.mjs`의 운영 allowlist                          |
| 좌표 bbox | 126.734, 37.413 – 127.269, 37.715                                   |
| tile zoom | z9–z15                                                              |

**실제 측정을 지탱하는 가장 작은 지역**이라는 이유로 전국 extract 대신 도시 extract를
선택했다. 한국 전체나 다른 지역의 비용은 이 수치에서 선형으로 추정하지 않는다.

취득은 allowlist id로만 가능하다. 스크립트는 URL을 인자로 받지 않으므로 사용자가 임의
주소를 넣을 수 없고, `{range}`(숫자-숫자)만 치환 가능하다. **redirect는 따라가지 않는다**
(`--max-redirs 0`, `--location` 없음): `--location`은 목적지를 allowlist로 제한하지
못하므로 다른 HTTPS 호스트로 옮겨 갈 수 있다. 위 날짜·ETag는 그 요청의 응답 헤더를
그대로 기록한 값이고, 해시가 있는 항목(GraphHopper jar)은 다운로드 후와 재사용 전에
모두 대조한다. 내려받은 extract와 모든 빌드
산출물은 `.geo-build/`에 들어가며 `.gitignore`·`.prettierignore`·ESLint ignore에 등록했다.

## 4. 타일 형식·빌더·배포 형태

### 선택

`osmium tags-filter` → `osmium export`(GeoJSONSeq) → `tippecanoe` → **MBTiles** →
gzip 그대로 꺼낸 **정적 XYZ 피라미드**. 산출물은 staging에서 검증한 뒤 rename으로
게시하고 `dist/current.json` 포인터를 바꾼다(8절).

### 실측 (2026-09-21, 같은 기기, buildId `ec81f3367889`)

| 단계                         | 시간    | peak RSS |
| ---------------------------- | ------- | -------- |
| 추출물 다운로드              | 26.88 s | –        |
| tags-filter (roads)          | 0.71 s  | 2.05 GB  |
| export (roads)               | 1.25 s  | 128 MB   |
| tags-filter (water)          | 0.61 s  | 2.08 GB  |
| export (water)               | 0.10 s  | 23 MB    |
| tags-filter (structures)     | 0.93 s  | 2.25 GB  |
| export (structures)          | 3.72 s  | 201 MB   |
| tippecanoe (z9–15, 3 레이어) | 54.99 s | 1.03 GB  |
| MBTiles → 정적 피라미드      | 0.46 s  | –        |

**측정된 단계의 합계 89.7 s**(다운로드 26.9 s 포함). 이 합계에 glyph 다운로드·staging 검증·
게시 시간은 들어 있지 않다(단계로 재지 않는다). 산출물: MBTiles 93.7 MB, 배포본 90.4 MB / 4,828 파일 /
**타일 4,817개**. `osmium`의 peak RSS는 pbf를 mmap 하므로 실제 할당량보다 크게 보인다
(상한 산정에는 tippecanoe의 1.03 GB를 쓴다).

### 왜 이 조합인가

- **tippecanoe**: bottle로 설치되고(BSD-2-Clause) 도시 규모 입력에서 약 1 GB RSS로
  1분 안에 끝났다. 실제로 실행해서 얻은 수치다.
- **osmium**: 레이어별 태그 선별과 GeoJSONSeq 내보내기를 한 번에 한다.
  GPL-3.0-or-later이지만 **빌드 시점 도구**일 뿐 제품에 포함·배포하지 않는다.
- **MBTiles(SQLite)**: 단일 파일이라 원자적 교체와 해시 검증이 쉽고, Node 24의 내장
  `node:sqlite`로 추가 의존성 없이 읽는다.
- **정적 XYZ 피라미드로 배포**: 브라우저 쪽 추가 라이브러리가 0이다. 타일은 MBTiles가
  담고 있던 gzip 바이트 그대로 저장하고 서빙 계층이 `Content-Encoding: gzip`을 붙인다.

### 채택하지 않은 것

- **PMTiles**: 단일 파일 range 요청이라 교체는 더 깔끔하지만, 브라우저에 protocol
  라이브러리를 추가해야 하고 range 요청이라는 새 경계가 생긴다. 이번 범위에서는 이득이
  비용을 넘지 않는다고 판단했다. 객체 스토리지 직접 서빙으로 옮길 때 다시 평가한다.
- **planetiler**: OpenMapTiles 프로필이 전역 water polygon·Natural Earth 보조 데이터
  (수백 MB) 다운로드를 요구해 "가장 작은 지역" 조건과 맞지 않았다. **실행하지 않았다.**
- **tilemaker**: 이 기기의 Homebrew에 formula가 없었다. **실행하지 않았다.**
- **타일 서버 프로세스(tileserver-gl 등)**: 정적 파일로 충분한 범위에서 운영할 프로세스를
  늘리지 않는다.

## 5. 공개 배경 자산과 private GPS 객체의 분리

| 구분      | 배경 타일·style·glyph·sprite            | GPS/track 객체                                      |
| --------- | --------------------------------------- | --------------------------------------------------- |
| 경로      | `/map/basemap/<deploymentId>/…`         | 기존 private object storage namespace (M2-01c 소관) |
| 인증      | 없음(공개 정적 자산)                    | 세션에서 도출한 소유자, 인증 download               |
| 캐시      | `public, max-age=604800, immutable`     | `no-store` / 인증된 단기 서명                       |
| 버킷/버전 | deployment 디렉터리(불변), 이전 것 보존 | 소유자별 key, 서버 생성                             |
| 내용      | 지역 전체 공통. 사용자별 차이 없음      | 개인 위치                                           |

같은 origin이지만 경로·인증·캐시 정책이 다르다. 배경 자산 경로에 개인 데이터가 섞이지
않도록 **deployment 디렉터리 하위만** 배경으로 서빙하고, 그 밖의 경로는 이 핸들러가 다루지
않는다. 측정용 서버(`scripts/probe-map-performance.mts`)는 이 정책을 그대로 구현한다:
배경만 `public, max-age=604800, immutable`이고 private 객체 자리에 있는 합성 트랙 문서를
포함해 나머지는 모두 `no-store`다.

### 타일 접근 로그와 telemetry

정적 배경 요청도 **사용자가 어느 지역을 보고 있는지 드러낸다**. z/x/y 자체가 좌표다.
따라서 운영 시 다음을 요구한다(현재는 요구사항이며 구현·검증 전이다).

- 배경 자산 요청에 대한 접근 로그는 **기본 비활성**. 켜야 한다면 z/x/y와 client IP를
  함께 남기지 않는다(둘 중 하나만, 또는 둘 다 절삭).
- 보존 기간은 운영 장애 분석에 필요한 최소 기간으로 제한하고 사용자 식별자와 결합 금지.
- CDN/역프록시 로그도 같은 규칙 대상. 기본 로그 포맷을 그대로 쓰지 않는다.
- 클라이언트 telemetry에 타일 좌표·viewport 중심을 보내지 않는다.
- 이미 적용된 AGENTS 규칙(정확한 GPS·객체 key·토큰을 로그/trace에 넣지 않음)과 동일선상.

## 6. 라이선스·귀속 의무 (배포 산출물별)

| 산출물                       | 출처                                  | 라이선스                        | 배포 시 의무                                                              |
| ---------------------------- | ------------------------------------- | ------------------------------- | ------------------------------------------------------------------------- |
| vector tile (`tiles/**.pbf`) | Seoul OSM extract에서 생성            | **ODbL 1.0 파생물**             | `© OpenStreetMap contributors` 표기 + 라이선스 링크. share-alike 대상     |
| `style.json`, `tiles.json`   | 저장소에서 생성(태그 필터·색만 포함)  | 저장소 소유                     | `attribution` 필드에 위 문구를 실어 나른다                                |
| glyph `*.pbf`                | protomaps/basemaps-assets 고정 commit | **OFL-1.1** (Noto Sans)         | 라이선스 전문 동봉(`glyphs/OFL.txt`), 폰트 이름을 파생물 홍보에 사용 금지 |
| sprite `*.png` / `*.json`    | 이 저장소 스크립트가 직접 생성        | 저장소 소유                     | 제3자 의무 없음                                                           |
| routing graph                | 같은 OSM extract에서 생성             | **ODbL 1.0 파생물**             | 경로 응답을 사용자에게 보여줄 때도 OSM 귀속 필요                          |
| GraphHopper 엔진             | Maven Central `graphhopper-web 10.0`  | Apache-2.0                      | 자체 운영은 자유. 재배포 시 NOTICE 유지                                   |
| osmium / tippecanoe          | Homebrew bottle                       | GPL-3.0-or-later / BSD-2-Clause | **빌드 도구, 배포물 아님**                                                |

- 배포 디렉터리에 `ATTRIBUTION.txt`를 함께 만든다(빌드가 자동 생성).
- geo-kit은 `BasemapDescriptor.attribution`을 **평문**으로 받아 지도 실패 시에도 화면에
  남긴다. MapLibre 자체 attribution control은 style의 HTML 문구를 쓴다. 두 경로 모두
  실제 화면에서 확인했다.
- ODbL share-alike는 타일과 graph 같은 **파생 데이터베이스**에 걸린다. 사용자 개인 export
  (GPX 등)와 공개 배포물의 의무는 다르며, 공개 공유 기능은 계획 7절대로 여전히 비활성이다.
- 이 표는 사용한 파일의 명시 라이선스를 대조한 결과이고 **법적 검토 결과가 아니다.**

### 공개 배포 전 이행 절차 (ODbL §4.2 / §4.6)

귀속 문구와 share-alike 표만으로는 부족하다. 외부에 배포하기 전에 아래를 갖춘다.
현재는 **절차 정의만 했고 어느 항목도 수행하지 않았다**(배포 자체를 하지 않았다).

1. **§4.2 라이선스 고지.** 배포물마다 ODbL 1.0 라이선스 URI를 직접 제공한다
   (`https://opendatacommons.org/licenses/odbl/1-0/`). 지금 배포 디렉터리의
   `ATTRIBUTION.txt`와 style `attribution`은 OSM copyright 페이지만 가리키므로,
   공개 배포 시 라이선스 URI를 함께 싣도록 빌드 산출물을 고친다.
2. **§4.6 파생 데이터베이스 제공.** 타일과 routing graph는 파생 데이터베이스이므로,
   공개 배포 시 (a) 파생 데이터베이스 자체를 ODbL로 내려받을 수 있게 하거나
   (b) 원본 extract에 적용한 **변경 방법**을 공개한다. (b)를 택한다면 필요한 값은
   빌드 manifest의 `alterationMethod`가 run마다 기록한다: 레이어별 `osmium tags-filter`
   표현식, `osmium export` 형식, `tippecanoe` 호출 인자 전체(staging 경로만 `<stage>`로 치환),
   zoom 범위, glyph 구간, 그리고 빌드
   스크립트 4개의 SHA-256(버전 고정). `source`의 추출물 URL·SHA-256·`Last-Modified`와 함께
   게시하면 제3자가 같은 파생물을 재현할 수 있다. routing graph 쪽은
   `routing-engine-measurements.json`의 `identity`(엔진 버전·프로필 해시·추출물 해시)를 쓴다.
   **스크립트 본문 자체의 공개 위치는 아직 정하지 않았다**(현재는 이 저장소 안에만 있다).
3. **게시 위치.** 위 두 가지를 배포 아티팩트 안(`ATTRIBUTION.txt`)과 서비스의 공개
   페이지 양쪽에 둔다. 지도 화면의 attribution control 문구만으로는 §4.6을 대체하지 않는다.
4. **검토 시점.** 공개 공유 기능(계획 7절)이 활성화되기 전에 다시 확인한다. 개인 export는
   배포가 아닐 수 있으나 그 판단은 여기서 내리지 않는다.

## 7. 보행 경로 엔진 선정

세 후보 중 **두 개를 같은 extract로 실제 빌드·질의**했다. 모든 요청은 loopback 서버에
갔고 외부 라우팅 서비스는 호출하지 않았다.

| 항목                   | OSRM v26.9.0 (foot.lua, MLD)                      | GraphHopper 10.0 (foot, CH 없음) | Valhalla   |
| ---------------------- | ------------------------------------------------- | -------------------------------- | ---------- |
| 빌드 시간              | extract 8.6 s + partition 4.4 s + customize 1.6 s | import+기동 합계 6.8 s           | **미실행** |
| 빌드 peak RSS          | 1.29 GB / 699 MB / 600 MB                         | 미측정(JVM 내부)                 | 미실행     |
| graph 디스크           | **455 MB**                                        | **43 MB**                        | 미실행     |
| 서버 RSS(기동 직후)    | 309 MB                                            | 1.74 GB (JVM `-Xms1g -Xmx4g`)    | 미실행     |
| 질의 지연(3건)         | 3 / 2 / 2 ms                                      | 52 / 6 / 7 ms (첫 건은 워밍업)   | 미실행     |
| 목표 거리 왕복         | **없음**                                          | `algorithm=round_trip` 동작      | 미실행     |
| 음성 대조군(서해 좌표) | **HTTP 200 `Ok`, 거리 0 m**                       | HTTP 400 `Cannot find point 0`   | 미실행     |

### 결정: GraphHopper open-source (Maven `graphhopper-web` 10.0, jar SHA-256 `e5a1268f…`)

엔진이 기동 로그에 버전 문자열을 찍지 않아 `version` 필드는 `null`로 남겼다. 신원은
아티팩트 URL과 jar 해시로 고정하며, 릴리스 이름을 로그에서 읽었다고 주장하지 않는다.

1. **목표 거리 왕복이 실제로 있다.** 5,000 m 목표에 4,428.8 m / 157점 경로를 반환했다
   (오차 −11.4 %). OSRM의 `/trip`은 주어진 경유지의 TSP이지 목표 거리 루프가 아니다.
   계획 6절이 요구한 "round-trip이 없으면 명시 실패 또는 자체 bounded 후보 탐색"을
   엔진 기능으로 덮을 수 있다.
2. **음성 대조군에서 조용히 성공하지 않는다.** OSRM은 extract 밖 해상 좌표 두 개를
   같은 지점으로 snap 해 `code: "Ok"`, 거리 0 m, 좌표 2개를 돌려줬다. 이것이 계획이
   금지한 "직선을 성공으로 보고하는" 형태다. 상한 snap 반경 설정으로 완화할 수는 있으나,
   기본 동작이 fail-open인 엔진보다 fail-closed인 쪽이 안전하다.
3. **graph가 10배 이상 작다**(43 MB vs 455 MB). 지역 확장 시 디스크·교체 비용에 직접 영향.

포기한 것: OSRM의 2–3 ms 질의 지연과 훨씬 작은 상주 메모리. GraphHopper의 1.74 GB RSS는
우리가 준 `-Xms1g -Xmx4g` 때문이며 **튜닝 전 수치**다. 힙 상한을 낮춘 실측은 하지 않았다.

Valhalla는 이 기기에 Homebrew formula가 없고 Docker daemon이 꺼져 있어 **빌드도 질의도
하지 않았다.** "Valhalla보다 낫다"고 주장하지 않는다. 보행/자전거 프로필의 세밀함과
tile 기반 graph 교체가 장점으로 알려져 있으므로 운영 환경이 정해지면 재평가 대상이다.

### 경계 (M2-01g에서 구현·검증)

- 엔진은 외부에서 직접 접근할 수 없고 내부 API만 호출한다.
- 내부 API에 tenant별 rate/concurrency/waypoint 수/거리/응답 점 수/deadline 상한을 둔다.
- `NoRoute` / coverage 밖 / 과도한 snap / timeout / 과부하를 구별한다. **직선 대체 금지.**
- `RouteRevision`에 engine/profile/graph build id, 요청 revision, 계산 시각, 거리, warning을
  저장한다. 오래된 graph로 계산한 코스를 새 graph로 조용히 덮어쓰지 않는다.
- round_trip은 근사치다. 후보 수·시도 수·시간·지역 범위 상한과 seed·평가 version을 기록한다.

## 8. 빌드 주기·교체·롤백·health check

아래 항목 대부분은 **요구사항**이며 운영 환경에서 검증하지 않았다. 예외는 버전 식별·원자적
교체·롤백 세 가지로, 구현하고 로컬에서 시험했다(그래도 운영 리허설은 아니다).

- **버전 식별.** `buildId = sha256(extract sha256 + region + 레이어 필터 + 도구 버전 +
serving prefix + style revision)`의 앞 12자. 현재 게시된 빌드는 `ec81f3367889`(deployment `ec81f3367889-mub8vb9q`). 같은 입력이면 같은 id가 나온다.
- **원자적 교체(구현·시험 완료).** 빌드는 staging에 쓰고, `verifyStagedBuild`가 style의 외부
  참조 없음과 필수 산출물 11종의 존재·비어 있지 않음을 확인한 뒤에야 **한 번의 rename**으로
  `dist/<deploymentId>/`로 들어간다. `deploymentId`는 매 배포마다 새로 만들어 그 경로는
  그 전에 존재한 적이 없다. 따라서 배포된 경로가 사라지는 구간도, 중간에 죽어 반쯤 교체된
  상태도 없다. 포인터 `dist/current.json`은 임시 파일 + rename으로 바꾼다.
  rename·포인터 쓰기·오래된 deployment 회수는 배포 디렉터리 lock 하나 안에서만 일어나고,
  회수는 그 lock 안에서 **다시 읽은** 포인터만 믿으며 dot으로 시작하는 디렉터리(다른 빌드의
  staging)는 건드리지 않는다. 회귀 시험은
  `packages/tooling/tests/geo-build.test.mjs` 16건이다.
- **롤백.** `current.json`의 `previousDeploymentId`가 이전 배포를 가리키고 그 디렉터리는
  손대지 않았으므로, 롤백은 포인터를 다시 쓰는 것이고 **옛 바이트를 준다**. 같은 buildId를
  다시 빌드해도 deployment id가 다르므로 그 성질이 유지된다(테스트로 고정). 브라우저 캐시가
  `immutable`이어도 경로가 deployment id로 구분되므로 섞이지 않는다.
  **운영 환경에서의 실제 롤백 리허설은 아직 없고**, 객체 스토리지/CDN에는 디렉터리 rename이
  없으므로 그 환경에서는 다시 설계·검증해야 한다.
- **buildId에 serving prefix를 포함한다.** style·tiles.json에는 `<serving prefix>/<deploymentId>`
  가 박히고 prefix는 buildId 해시의 입력이므로, 다른 prefix로 만든 내용이 같은 immutable
  경로를 차지하지 못한다.
- **routing graph 교체.** 새 graph를 별도 디렉터리에 만들고 새 프로세스를 띄워 health
  check를 통과시킨 뒤 트래픽을 옮긴다. 이전 graph 디렉터리와 프로세스를 한 주기 유지한다.
  기존에 저장된 `RouteRevision`은 이전 graph id를 계속 가리킨다.
- **health check.** 배경: `style.json`과 고정 z/x/y 타일 1개의 200·해시 확인. 엔진:
  `/health`와 고정 좌표 1건의 경로 계산 성공. 두 가지 모두 고정 입력이어야 한다.
- **과부하 차단.** 엔진 앞단에 동시 요청 상한과 큐 길이 상한, 초과 시 즉시 거절(대기 금지).
  타일은 정적 파일이므로 서빙 계층의 일반 상한을 따른다.
- **빌드 주기(제안).** 월 1회 + OSM 데이터 문제 신고 시 임시 빌드. 배경과 graph는 **같은
  extract sha256에서** 함께 만들어 화면과 경로가 다른 날짜의 데이터를 쓰지 않게 한다.
- **운영 담당.** 미정. 호스팅 환경이 정해질 때 root가 지정한다.

## 9. 자원·비용 상한

측정값 기반 **제안치**이며 계약·구매는 하지 않았다.

| 항목             | 측정값 (Seoul, 이 기기)                 | 제안 상한                               |
| ---------------- | --------------------------------------- | --------------------------------------- |
| 측정 단계 합계   | 배경 89.7 s(다운로드 포함), graph 6.8 s | 지역 1개 빌드당 30분                    |
| 빌드 RAM         | tippecanoe 1.03 GB                      | 4 GB                                    |
| 빌드 디스크      | `du` 관측 약 1.2 GB(JSON 미기록)        | 20 GB (extract + 중간물 + 2세대 배포본) |
| 배경 배포본      | 90.4 MB / 4,817 타일                    | 세대당 1 GB                             |
| graph 디스크     | 43 MB                                   | 세대당 2 GB                             |
| 엔진 상주 메모리 | 1.74 GB (JVM 힙 상한 4 GB 기준)         | 컨테이너 2 GB (힙 상한 재조정 필요)     |
| 월 비용          | **미산정**                              | 호스팅 결정 후 별도 승인                |

Seoul 수치를 전국으로 선형 확대하지 않는다. 확대 시 다시 측정한다.

## 10. 브라우저 측 증거

`scripts/probe-map-performance.mts`가 `dist/current.json`이 가리키는 배포본을 loopback에서
CSP와 함께 서빙하고 Playwright Chromium으로 측정한다. CSP는
`default-src 'self'; script-src 'self'; worker-src 'self' blob:; connect-src 'self';
img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self';
frame-ancestors 'none'; base-uri 'none'`이다.

측정은 **통과 조건을 만족할 때만** 통과다. 조건 11개(외부 요청 0, CSP 위반 0, ready 유지,
renderer 오류 0, 타일 HTTP 200 ≥ 1, style·sprite·glyph HTTP 200, 같은 origin 요청이 모두
성공 상태로 완료, 경로가 실제로 그려진 idle, redirect 대조 3건)가 모두 만족돼야
`passed: true`이며, 하나라도 실패하면 보고서에 실패 목록을 남기고 **프로세스가 exit 1**로
끝난다. 상태·진단·CSP 위반은 pan **이후에 다시 읽어** 판정하고, 응답이 없던 요청도 실패로
센다. worker 파일이 빠지면 타일 요청이 0건이 되는데, 예전 판에서는 그것이 성공과 구별되지 않았다.

deployment `ec81f3367889-mub8vb9q`에 대한 마지막 실행 결과.

- **외부 요청 0건.** route 가로채기로 외부 origin 요청을 차단·집계하고, 그와 별개로
  **모든 redirect hop의 `request` 이벤트**까지 세는데(origin 비교는 `startsWith`가 아니라
  파싱 후 정확 비교) 양쪽 합계가 0이었다. 같은 origin 요청 20건
  (harness 6, track 1, style 1, sprite 2, tile 9, glyph 1). CSP 위반 이벤트 0건.
- **redirect 음성 대조(CSP 미전송).** `/tiles/` 경로만 `https://tiles.example.com/…`으로 302를
  주는 서버를 **CSP 헤더 없이** 띄우고 같은 페이지를 열면, 외부 요청 시도 **0건**이고 타일
  6건이 실패로 기록된다(다른 자산은 정상). CSP가 아니라 자산 transport가 막는다는 뜻이다.
- **그 대조의 양성 통제.** 같은 페이지를 `?permissive=1`로 한 번 더 연다. 이때 harness가
  일부러 **redirect를 따라가는** transport를 설치하며, 그 실행에서는 외부 시도 **6건**
  (`https://tiles.example.com/hijacked.pbf`)이 관측된다. 외부 요청은 route 가로채기뿐 아니라
  **모든 redirect hop의 `request` 이벤트**로 세므로(Playwright의 route는 chain의 첫 URL에서만
  호출된다) 0이 관측 실패가 아님을 이 대조가 보인다.
- **초기화 알림까지 285 ms** — 이 시점에는 경로 source가 **비어 있다**. 트랙도 viewport
  맞춤도 아직 없다. 이 수치를 "지도 표시 완료"로 읽으면 안 된다.
- **트랙과 배경이 실제로 그려진 idle까지 2,281 ms** (그려진 경로 feature 4개). 이것이
  "합성 20,000점 트랙 + 배경 지도 표시"에 해당하는 수치다.
- `usedJSHeapSize` 44.7 MB.
- 스크립트 pan 중 프레임 간격 p50 100.1 ms / p95 133.4 ms (111 프레임). 이 실행의 WebGL
  renderer는 `ANGLE (Google, Vulkan 1.3.0 (SwiftShader ...))` 즉 **소프트웨어 렌더링**이다.
  이 수치를 실제 GPU 성능으로 읽으면 안 된다.
- 음성 대조(조건 11개 판정으로 실행): 배포본의 `tiles/`를 잠시 치우고 같은 명령을 실행하면
  `passed: false`와 실패 항목 5개(ready 유지, renderer 오류 `SELF_HOSTED_REQUEST_FAILED_404`,
  타일 200건 0, glyph 0, 같은 origin 요청 `net::ERR_ABORTED` 6건)가 나오고 종료 코드가
  **1**이다. 복구 후 재실행은
  **0**이다.
- 실제 GPU 브라우저(Aside, `ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro)`)에서는
  같은 페이지가 정상 렌더되고 모든 resource origin이 loopback 하나였다. 자세한 내용은
  [M2-01d 진행 기록](../progress/M2-01d.md).

## 11. 보류 (운영 검증 미완)

계획 6절의 "예산·호스팅 환경이 미정이면 준비 작업은 진행하되 운영 검증 완료는 보류한다"를
그대로 적용한다. 다음은 **수행하지 않았다.**

- 실제 호스팅에 배포, 도메인·CDN·TLS 구성, 유료 서비스 계약(전혀 하지 않았다).
- 부하·동시성·과부하 차단 실측, graph 교체/rollback 리허설.
- 한국 보행 coverage 판정 — 계획대로 `not_reviewed`이며 M2-01g·M0-06b 소관이다.
  HTTP 200과 계산된 형상은 통행 가능·안전의 증거가 아니다.
- Valhalla 빌드·측정.
- 전국 또는 다른 지역 확장 비용, 타일 갱신 파이프라인 자동화.
- 실기기(저사양 모바일) 성능, 물리 GPU 프레임 예산.
