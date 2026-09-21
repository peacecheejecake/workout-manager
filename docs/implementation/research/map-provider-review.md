# 지도·경로 provider 검토

후속 결정(2026-09-21): 사용자는 외부 상용 지도·길찾기 API 없이 자체 구현·운영하는 방향을
선택했다. 현재 실행 계획은 [지도 뷰어·자체 경로 생성](../map-implementation-plan.md)을 따른다.
아래 비교는 당시 조사로 보존하며 채택 승인이나 coverage 통과로 해석하지 않는다.

확인일: 2026-09-20. 범위: M0-06b의 남은 두 항목 — (a) 한국 도보 경로 coverage의 독립 근거 검토, (b) 운영 provider 선정.
상태: **결정 자료. 이 문서는 한국 coverage를 승인하지 않으며, `coverageReview`는 계속 `not_reviewed`다.**
(b) 운영 provider 선정은 계약·비용·개인정보 처리 책임을 수반하므로 사용자의 결정 사항이다. 이 문서는 후보를 좁히고
결정에 필요한 입력을 명시할 뿐이며, 계정 생성·요금 계약·API key 발급·실제 위치 데이터 전송을 수행하지 않았다.

기준은 [routing 선행 조사](routing-prerequisites.md), [M0-06b 진행 기록](../progress/M0-06b.md),
[실행 결과](routing-sample-results.json)다. 기존 기록의 관측은 바꾸지 않는다.

## 근거의 등급 구분

이 문서는 세 가지를 구분한다. 혼동하면 공급자 홍보 문구가 검증으로 둔갑한다.

- **확인**: 공급자 공식 문서·약관·정부/표준 문서 본문을 이번 조사에서 직접 읽어 인용한 것.
- **2차 보도**: 언론 기사로만 확인한 것. 시행 시점·적용 범위는 원 문서로 재확인이 필요하다.
- **미확인**: 본문 접근 실패, 로그인·제휴 뒤에 있음, 또는 공개 자료에 수치가 없음. 추정하지 않고 미확인으로 남긴다.

이번 조사에서 본문을 확보하지 못한 항목: TMAP 보행자 경로안내 API의 **보행 전용 무료 제공량과 단가**
([제품 페이지](https://openapi.sk.com/products/detail?linkMenuSeq=45)와
[요금 페이지](https://openapi.sk.com/products/calc?svcSeq=4&menuSeq=5)는 메뉴만 반환),
브이월드의 **전체 오픈API 목록**([소개](https://www.vworld.kr/dev/v4dv_apiuse_s001.do),
[가이드](https://www.vworld.kr/dev/v4dv_dhapiguide_s001.do)에서 목록 미노출),
국가공간정보포털의 보행자 길찾기 데이터셋(`data.nsdi.go.kr` DNS 해석 실패),
한국 지역 OSM 태그 통계 수치([taginfo 지역 페이지](https://taginfo.geofabrik.de/asia:south-korea/tags/highway=footway)는
기준일 `2026-09-19 19:53 UTC`만 확인되고 수치 본문 미확보).

## 비교표

| 후보                                             | 도보(보행) 경로                                                                             | 한국 coverage 근거                                                   | 결과 저장·캐싱                                  | 무료/요금                                | 자체 운영 | 이 제품 적합성                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------- | --------- | ------------------------------------------- |
| 카카오맵 API (`dapi.kakao.com`)                  | **제공**. `GET /v2/routing/walk`, 경유지 최대 5, `BROAD_FIRST`/`SHORTEST`/`ACCESSIBLE` 모드 | 국내 상용 보행망 기반(품질 수치 미확인)                              | **DB 저장 금지**. 안내 종료 시 즉시 폐기만 허용 | 1앱 한정 일 1,000건 무료, 초과 건당 10원 | 불가      | 경로를 코스로 **저장**하는 제품과 정면 충돌 |
| 카카오모빌리티 도보 길찾기                       | 제공(`/affiliate/walking/v1/directions`)                                                    | 위와 동일 계열                                                       | 미확인(제휴 계약 사항)                          | **제휴 계약 필수**, 요금 미공개          | 불가      | 계약 없이는 평가 자체가 불가                |
| NCP Maps Directions 5                            | **미제공**. 공식 문서가 "자동차에 한해서만" 명시                                            | 해당 없음                                                            | 미확인                                          | 해당 없음                                | 불가      | 보행 용도로 **탈락**                        |
| TMAP (SK) 보행자 경로안내                        | **제공**(제품 목록에 명시)                                                                  | 국내 내비 데이터 기반(품질 수치 미확인)                              | **저장 후 24시간 초과 사용 금지**               | 기능별 상이, 보행 단가 미확인            | 불가      | 24시간 제한이 코스 영구 저장과 충돌         |
| Google Maps Platform                             | Routes API에 walking 모드 있음                                                              | **coverage 표에서 KR은 운전·도보·자전거 모두 `—`** (2026-09-20 확인) | 원칙적 캐싱 금지, 예외적 30일                   | 별도                                     | 불가      | 2026-02 반출 승인에도 **현재 미지원**       |
| Mapbox Directions                                | `mapbox/walking` 프로필 제공(OSRM/Valhalla 기반)                                            | OSM 기반 → 아래 (a) 항목과 동일한 한계                               | 저장·캐싱 금지, 단말 30일 예외                  | 월 10만 요청 무료, 이후 1,000건당 $2.00  | 불가      | 저장 제약이 코스 저장과 충돌                |
| 자체 운영 OSRM / Valhalla / GraphHopper + OSM KR | 제공(foot/pedestrian 프로필)                                                                | **OSM 한국 보행망 완성도가 곧 품질**. 공개 수치 미확인               | **제약 없음**(ODbL 표시 의무는 별도)            | 소프트웨어 무료, 인프라·운영 비용 발생   | **가능**  | 저장·프라이버시·CSP 요건과 가장 잘 맞음     |
| 브이월드 / 국가공간정보                          | **라우팅 API 확인 불가**                                                                    | —                                                                    | —                                               | 지도 API 무료로 소개됨                   | 불가      | 배경지도·행정 데이터 보조 용도로만 검토     |

## 후보별 검토

### 카카오맵 API — 기능은 맞고 약관이 막는다

2026년 7월 21일 카카오맵 API 정책이 바뀌어 **대중교통·도보·자전거 경로 조회와 정적 지도 4종이 추가**되었고,
기존의 "추가 기능 신청 및 관리자 심사"가 폐지되어 앱 관리 페이지 활성화와 비즈월렛 연결만으로 쓸 수 있다.
무료 쿼터는 개발자 계정 기준 **첫 번째 활성화 앱에만 일 1,000건**, 초과 시 경로 API는 **건당 10원**,
정적 지도는 건당 2원이다. [변경 공지](https://devtalk.kakao.com/t/api-notice-on-new-kakao-map-api-features-and-free-quota-policy/150222)

도보 경로는 `GET https://dapi.kakao.com/v2/routing/walk`이며 경유지 최대 5개, 좌표계 선택(WGS84/WTM/TM/WCONGNAMUL),
`route_mode`로 넓은 길 우선·최단·편안한 길을 고를 수 있다. 응답은 `totalDistance`, `totalTime`, 단계별 `guidance`와
`path.points`를 준다. 상태 코드에 `START_LINK_NOT_FOUND`, `END_LINK_NOT_FOUND`, `TOO_FAR_AWAY`,
`ROUTE_RESULT_NOT_FOUND`가 분리되어 있다.
[REST API 문서](https://developers.kakao.com/docs/ko/kakaomap/rest-api),
[시작하기](https://developers.kakao.com/docs/ko/kakaomap/common)

문제는 운영정책이다. 카카오 담당자는 공개 문의에서 **"1회 호출 결과를 이동 안내 동안에 임시 유지 후 안내 종료 시
즉시 폐기하는 구조"만 허용**되고 **"결과값 기반의 가공 데이터의 DB저장 및 활용은 허용되지 않습니다"**라고 답했다.
개발 환경의 샘플 저장도 폐기 대상으로 명시했다.
[경로 API 문의](https://devtalk.kakao.com/t/api/151736)
다른 문의에서는 **"어떠한 경우에도 실시간 호출이 아닌 형태로는 이용할 수 없습니다"**, **"기존 저장 데이터는 즉각
삭제해 주셔야 합니다"**, 한시적 활용도 허용하지 않는다고 답했고 실제 계정 제재 사례가 공개 스레드에 남아 있다.
[로컬 API 저장 문의](https://devtalk.kakao.com/t/api/151343)

이 제품은 **코스를 저장하고 나중에 다시 여는 것**이 요구사항이므로(S13/S14, FUT-07), 카카오 경로 응답의 geometry를
PlanVersion이나 Activity에 보존하는 순간 약관 위반이다. 실시간 표시만 하는 절충안은 기술적으로 가능하지만,
저장된 코스를 열 때마다 재호출이 필요하고 오프라인·기록 재생이 불가능해진다.
이 해석은 공개 스레드의 담당자 답변에 근거하며, 이 제품의 구체적 구조에 대한 카카오의 공식 확인은 **미확인**이다.

### 카카오모빌리티 도보 길찾기 — 제휴 전제

`GET https://apis-navi.kakaomobility.com/affiliate/walking/v1/directions`이며 경유지 최대 5개다.
**제휴 파트너 전용 API이며 사전 제휴 계약이 필요**하다고 문서에 명시되어 있다.
[도보 길찾기](https://developers.kakaomobility.com/affiliate/walking/directions),
[길찾기 API 제품](https://developers.kakaomobility.com/product/naviapi.html)
요금·저장 조건·한국 coverage 지표는 계약 문서에 있을 것이므로 공개 조사로는 **미확인**이다.
계약 전에는 후보 비교에 넣을 수 있는 근거가 없다.

### NCP Maps Directions 5 — 보행 미제공으로 탈락

공식 문서가 **"Direction 5 API가 제공하는 경로 정보는 자동차에 한해서만 제공됩니다"**라고 명시한다.
[API 참조서](https://apidocs.ncloud.com/ko/ai-naver/maps_directions/),
[사용 가이드](https://guide.ncloud-docs.com/docs/maps-direction5-api)
네이버 지도 앱에 도보 모드가 있다는 사실은 API 제공 근거가 아니다. 보행 routing 후보에서 제외한다.
배경지도(Web Dynamic Map)는 별도 상품이므로 tile 후보로는 남을 수 있으나 이번에 약관을 확인하지 않았다.

### TMAP (SK) — 보행 API는 있으나 24시간 저장 상한

SK open API 제품 목록에 "보행자 경로 안내"가 있다.
[제품 페이지](https://openapi.sk.com/products/detail?linkMenuSeq=45),
[TMAP API 가이드](https://tmapapi.tmapmobility.com/)
약관은 **"TMAP Open API를 이용하여 얻어진 데이터는 저장 후 24시간 이상 사용할 수 없습니다"**,
**"동일한 서비스를 위하여 다수의 프로젝트를 생성하여 사용하는 경우에는 불법 사용으로 간주"**라고 규정한다.
무료 제공량은 기능별로 다르며 약관 페이지에서 지도보기 100,000건/일, POI 검색 20,000건/일,
지오코딩 20,000건/일을 확인했다. **보행자 경로안내 자체의 무료 제공량과 종량제 단가는 이번에 확인하지 못했다.**
[TMAP API 약관](https://tmapapi.tmapmobility.com/terms.html)

24시간 상한은 카카오보다는 느슨하지만, 승인된 코스를 영구 보존하는 이 제품의 불변식과는 여전히 충돌한다.
"사용자가 직접 그린 코스"와 "TMAP이 계산해 준 geometry"를 데이터 모델에서 분리할 수 있는지가 관건이며,
이는 약관 해석이므로 SK 측 서면 확인 없이는 진행하지 않는 것이 안전하다. 서면 확인 여부는 **미확인**이다.

### Google Maps Platform — 반출 승인과 실제 제공은 별개다

2026년 2월 27일 한국 정부 협의체가 **1:5,000 축척 고정밀 지도 데이터의 국외 반출을 조건부 승인**했다.
조건에는 군사·보안시설 블러 처리, 국내 영토 좌표 표시 제한, 국내 서버 처리, 국내 컴플라이언스 담당자 배치,
위반 시 승인 정지·취소가 포함된다. 2007년·2016년 요청은 거부되었고 2025년 2월의 세 번째 요청이 세 차례
연기 끝에 승인되었다. 이는 **2차 보도**다.
[Korea Herald](https://www.koreaherald.com/article/10684189),
[JURIST](https://www.jurist.org/news/2026/02/south-korea-conditionally-approves-googles-high-precision-map-data-export/),
[Wikipedia 요약](https://en.wikipedia.org/wiki/Restrictions_on_geographic_data_in_South_Korea)
2026년 8월 보도는 구글이 턴바이턴 내비게이션을 한국에 도입할 계획이라고만 전하며 모드별 시점은 밝히지 않았다.
[9to5Google](https://9to5google.com/2026/08/27/google-maps-turn-by-turn-navigation-south-korea/)

그러나 **2026-09-20 현재 Google Maps Platform 공식 coverage 표에서 South Korea(KR)의 운전·도보·자전거 경로는
모두 `—`(해당 지역에서 기능을 사용할 수 없거나 데이터 품질이 낮음)** 이다.
[Google Maps Platform coverage](https://developers.google.com/maps/coverage)
즉 정책 승인은 났지만 플랫폼 API의 한국 보행 경로는 아직 제공되지 않는다. 승인 기사를 근거로
"이제 구글로 하면 된다"고 판단해서는 안 된다. 언제 표가 바뀔지는 **미확인**이며, 정기적으로 이 표를 재확인해야 한다.

약관상 Google Maps Content는 원칙적으로 캐싱·선인출·색인·저장·재호스팅이 금지되며, 서비스별 약관이 허용하는
범위에서만 최대 30일 임시 캐싱이 가능하다.
[Maps Service Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms)
경로 geometry를 코스로 영구 저장하는 용도는 이 예외에 들어가지 않는다고 보는 것이 타당하나, 이 해석에 대한
구글의 서면 확인은 **미확인**이다.

### Mapbox — 기술은 맞지만 저장 제약과 데이터 출처가 겹친다

`mapbox/walking` 프로필을 제공하며 최대 25개 waypoint를 지원한다. 엔진은 OSRM과 Valhalla다.
[Directions API](https://docs.mapbox.com/api/navigation/directions/),
[동작 설명](https://docs.mapbox.com/help/dive-deeper/directions/)
요금은 Directions 월 10만 요청 무료, 이후 1,000건당 $2.00부터이며, 웹 지도 로드는 월 5만 무료,
이후 1,000건당 $5.00부터다. [Mapbox pricing](https://www.mapbox.com/pricing)
Product Terms는 Licensed Map Content의 내보내기·다운로드·캐싱·저장을 금지하고, 단말 내 캐싱만 동일 단말 기준
30일로 제한하며, 캐시·프록시·스크린샷을 통한 재배포도 금지한다.
[Product Terms](https://www.mapbox.com/legal/product-terms), [ToS](https://www.mapbox.com/legal/tos)

중요한 점은 Mapbox의 한국 보행 경로 품질이 결국 **OSM 한국 보행망**에 기반한다는 것이다. 즉 자체 운영 OSRM과
데이터 리스크가 상당 부분 겹치면서, 저장 제약과 요금은 추가로 진다. 다만 인프라 운영 부담이 없다는 점은 분명한 장점이다.
Mapbox가 한국에 대해 별도 상용 데이터를 혼합하는지는 **미확인**이다.

### 자체 운영 OSRM / Valhalla / GraphHopper + OSM 한국 데이터

라이선스는 OSRM이 BSD-2-Clause, Valhalla와 GraphHopper가 Apache-2.0으로 상업 제품 내 사용·수정·배포에
사용료가 없다. Valhalla는 런타임 costing으로 pedestrian 프로필을 지원한다.
[Valhalla](https://github.com/valhalla/valhalla),
[OSRM 개요](https://en.wikipedia.org/wiki/Open_Source_Routing_Machine),
[OSRM profiles](https://project-osrm.org/docs/v26.4.0/profiles)
데이터는 Geofabrik의 South Korea extract를 쓸 수 있고, 확인 시점 최신 파일은
`all OSM data up to 2026-09-19T20:22:34Z`, PBF 274 MB, 라이선스는 **ODbL 1.0**, 갱신은 일 단위다.
[Geofabrik South Korea](https://download.geofabrik.de/asia/south-korea.html)

이 경로의 장점은 이 저장소의 제약과 정확히 맞물린다는 것이다. 결과 저장 금지 조항이 없으므로 코스를 영구 보존할 수
있고, 요청이 자체 서버로 가므로 정밀 GPS가 외부 공급자에 노출되지 않으며, tile도 자체 origin에서 서빙하면
`connect-src 'self'` 기조를 유지할 수 있다. 공개 demo endpoint 의존도 사라진다.
단점은 **품질 책임이 전부 우리에게 온다**는 점이다. ODbL은 표시 의무와, 파생 데이터베이스 배포 시 share-alike
의무를 수반하므로 "공짜"가 아니다. 그래프 재빌드 주기·CPU/RAM/디스크·장애 대응도 우리 몫이다.
구체적 인프라 비용은 산정하지 않았으므로 **미확인**이다.

### 브이월드 / 국가공간정보 — 라우팅 제공 여부 확인 실패

브이월드의 오픈API 소개·가이드·레퍼런스 페이지 어디에서도 경로탐색 API 목록을 확인하지 못했다.
[소개](https://www.vworld.kr/dev/v4dv_apiuse_s001.do), [가이드](https://www.vworld.kr/dev/v4dv_dhapiguide_s001.do),
[오픈API](https://www.vworld.kr/dev/v4api.do)
국가공간정보포털 오픈마켓에 민간 사업자가 등록한 "보행자 길찾기 API" 항목이 검색 결과에 보이나
(`data.nsdi.go.kr/dataset/14825`), 이번 조사에서 해당 호스트의 DNS 해석에 실패해 제공기관·이용 조건·가격을
확인하지 못했다. **브이월드를 라우팅 후보로 넣을 근거도, 배제할 근거도 확보하지 못했다.**
배경지도·행정경계·주소 보조 용도로는 재검토 가치가 있다.

## 한국 법·규제 맥락

두 가지가 별개로 작동하므로 분리해 다뤄야 한다.

**지도 데이터 국외 반출**은 「공간정보의 구축 및 관리 등에 관한 법률」이 규율하며, 국가 주도 측량 성과의 국외 반출을
제한한다. 2026-02-27 구글에 대한 조건부 승인은 이 제한의 **개별 예외**이지 제도 자체의 폐지가 아니다.
[Wikipedia](https://en.wikipedia.org/wiki/Restrictions_on_geographic_data_in_South_Korea)
OSM 한국 위키도 **국가공간정보포털 제공 데이터의 OSM 업로드는 금지**되어 있고, 네이버·카카오 등 상용 지도의
복사는 위법이며 위성 이미지에서의 도로·건물 트레이싱은 적법하다고 안내한다.
[OSM South Korea](https://wiki.openstreetmap.org/wiki/South_Korea)
자체 운영을 택하더라도 "공공 데이터를 OSM에 넣어 품질을 메운다"는 선택지는 현재 열려 있지 않다.

**위치정보 사업 신고**는 별개다. 기기에서 GPS를 직접 수집해 서비스에 쓰면 위치기반서비스사업 신고 대상이라는
해설이 다수이고, 2025-10-01부터 소관이 방송통신위원회에서 방송미디어통신위원회로 이관되었다는 서술도 있다.
미신고 운영에 형사·과태료 제재가 언급된다. 이는 법률 자문이 아니라 공개 해설이며 이 제품의 구조에 대한 판단이
아니다. [위치정보지원센터](https://www.lbsc.kr/front/content/contentViewer.do?contentId=CONTENT_0000081),
[해설](https://www.veatlaw.kr/main/board_detail/1599)
이 항목은 provider 선택과 무관하게 필요하며, 외부 provider에 정밀 GPS를 보내는 구조는 제3자 제공 고지 범위를
추가로 넓힌다. 저장소의 정밀 GPS 로그 redaction 방침과도 직접 연결된다.

## (a) OSM 한국 보행망에 대한 공개 근거와 방어 가능한 coverage 검토

### 지금 공개 근거로 말할 수 있는 것

- 데이터는 매일 갱신되며 특정 시점 스냅샷을 고정할 수 있다. 확인한 최신 extract 기준 시각은 `2026-09-19T20:22:34Z`,
  라이선스는 ODbL 1.0이다. [Geofabrik](https://download.geofabrik.de/asia/south-korea.html)
- 한국 OSM 위키는 주요 도시가 정비되었다고 서술하면서도 **보행로 세부 데이터에 대한 완성도 기술은 없다**.
  공공 데이터 임포트가 금지되어 있으므로 보행망은 개인 기여자의 조사·위성 트레이싱에 의존한다.
  [South Korea](https://wiki.openstreetmap.org/wiki/South_Korea),
  [Mapping Guide](https://wiki.openstreetmap.org/wiki/South_Korea_Mapping_Guide)
- 보도 태깅에는 두 방식(별도 way vs 도로에 `sidewalk=*` 태그)이 공존하며 지역별로 관행이 다르다.
  횡단보도는 `highway=footway` + `footway=crossing`으로 별도 way를 그리는 방식과 노드 방식이 섞인다.
  이 혼재는 **엔진이 보도-차도 연결을 인식하지 못하는 실패를 직접 유발한다**.
  [Sidewalks](https://wiki.openstreetmap.org/wiki/Sidewalks), [Key:sidewalk](https://wiki.openstreetmap.org/wiki/Key:sidewalk),
  [footway=crossing](https://wiki.openstreetmap.org/wiki/Tag:footway=crossing)
- 한국 커뮤니티 포럼에도 횡단보도 태깅 방식에 대한 미결 논의가 남아 있다.
  [커뮤니티 논의](https://community.openstreetmap.org/t/topic/107299),
  [한국 포럼](https://community.openstreetmap.org/c/communities/ko/74)
- OSM 보도 데이터의 커버리지가 전반적으로 고르지 않다는 지적은 일반적 서술 수준으로 확인된다.
  [speedwalk](https://github.com/a-b-street/speedwalk)

### 말할 수 없는 것

한국 지역의 `highway=footway`, `footway=crossing`, `highway=steps`, `sidewalk=*` 객체 수와 그 시계열은
이번 조사에서 **수치를 확보하지 못했다**. 따라서 "OSM 한국 보행망이 충분하다/불충분하다"는 정량 주장은
현재 근거가 없다. 전국 단위 완성도 주장보다 **제품이 실제로 쓰일 지역·시나리오 단위의 표본 검토**가 현실적이다.

### 방어 가능한 coverage 검토의 요건

다음을 모두 갖춘 검토만 `not_reviewed`를 벗어날 자격이 있다. 합성 probe 3건은 이 검토를 대체하지 않는다.

1. **그래프 신원 고정**: 사용한 extract의 기준 시각, 파일 해시, 엔진 버전, 프로필 파일 해시를 기록한다.
   공급자 API를 쓰는 경우 응답에 없으면 `unknown`으로 남기고 추정하지 않는다.
2. **표본의 정답을 먼저 정의**: 좌표를 고르기 **전에** 각 지점의 실제 보행 가능 여부를 공개 근거
   (OSM way ID와 태그, 국토지리정보원 정사영상 등 합법적 출처)로 문서화하고 기대 결과를 고정한다.
   응답을 본 뒤 기대를 맞추면 검토가 아니다.
3. **실패 유형별 표본**: 최소한 (i) 보도 있는 일반 가로, (ii) 신호 횡단보도, (iii) 보행 가능 교량,
   (iv) 지하도·육교·계단, (v) 공원 내부 산책로와 출입구, (vi) 개방 시간이 제한된 구간 각각에 대해
   양성·음성 표본을 둔다. 특히 (vi)은 `opening_hours`·`access`·`conditional` 태그의 유무 자체를 기록한다.
4. **음성 대조군의 자격**: 실제 보행 불가 구간에서 엔진이 **경로를 만들지 않는지**를 본다.
   `InvalidOptions`, 전송 오류, 비정상 HTTP 상태는 대조군 근거로 인정하지 않는다(기존 규칙 유지).
5. **형상 대조**: 거리·소요시간이 아니라 geometry가 실제 보행 가능한 선을 따르는지 좌표 단위로 본다.
   HTTP 200과 `Ok`는 경로가 존재한다는 뜻일 뿐 보행 적합성의 증거가 아니다.
6. **검토자와 날짜 기록**: 각 표본의 판정 근거 URL·way ID·검토일·불확실 표시를 남긴다. 불명확한 통행 조건은
   끝까지 미확인으로 남긴다.

### 기존 probe 결과의 해석과 오류 구분

기존 관측은 그대로 유지한다. 다만 원인 해석은 다음과 같이 구분해야 한다.

| 관측                                   | 가장 가능성 높은 의미                                                                                                                | 아닌 것                                               | 구분 방법                                                                                                                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KR-SYN-02` HTTP 400 `NoSegment`       | 요청 좌표에서 100m 안에 **해당 프로필 그래프의 간선이 없음**. 강변 좌표가 보행망에서 떨어졌거나, 그 구간 보행망 자체가 데이터에 없음 | 양안이 끊겨 있다는 판정도, 교량 통행 불가 판정도 아님 | 같은 좌표를 `radiuses`를 키워 재요청하고, 별도로 `nearest` 조회로 snap 후보와 거리를 본다. 같은 좌표를 bicycle·car 프로필로 보내 프로필 한정 문제인지 좌표 문제인지 가른다. 좌표 근처의 OSM way를 직접 조회해 보행 태그 유무를 확인한다 |
| `NEG-SYN-01` HTTP 200 `InvalidOptions` | **공급자가 입력을 거절**. `(0,0)` 좌표를 별도로 거절하는 것이 후속 진단에서 확인됨                                                   | 경로 없음의 음성 대조 성립이 아님                     | 대조군을 비영점 해양 좌표로 바꾼다. 실제로 `NEG-SYN-03`은 `NoSegment`를 반환했다. 옵션 거절과 탐색 실패를 응답 코드로 분리해 기록한다                                                                                                   |
| `KR-SYN-01` HTTP 200 `Ok` 468.6m       | 그 좌표쌍에 대해 엔진이 경로를 계산했다                                                                                              | 그 경로가 실제로 걸을 수 있다는 근거가 아님           | geometry를 좌표 단위로 공개 지도와 대조하고, 통과한 way의 태그를 확인한다                                                                                                                                                               |

**공급자 한계와 프로브 오류를 가르는 일반 원칙**: 같은 입력을 (1) 다른 프로필, (2) 다른 snap 반경,
(3) 다른 엔진/공급자, (4) 같은 공급자의 다른 시점에 보내 결과가 갈리는 축을 찾는다. 네 축에서 모두 동일하게
실패하면 데이터 결손 쪽 가설이 강해지고, 한 축만 바꿔 성공하면 프로브 구성 문제다.
어느 쪽도 한 번의 호출로는 결론 나지 않는다. 카카오 API가 `START_LINK_NOT_FOUND`/`END_LINK_NOT_FOUND`를
`ROUTE_RESULT_NOT_FOUND`와 분리해 두는 것도 같은 구분이며, 상용 공급자에서도 snap 실패와 탐색 실패는 별개다.
[카카오 상태 코드](https://developers.kakao.com/docs/ko/kakaomap/rest-api)

## 권고와 절충

**권고: 자체 운영 OSM 기반 보행 라우팅(Valhalla 우선, OSRM 차선)을 운영 provider로 삼고, 배경지도도 자체 origin에서
서빙한다. 국내 상용 API는 "저장하지 않는 실시간 보조 기능"이 필요해질 때 별도로 다시 평가한다.**

이 권고의 근거는 품질이 더 낫다는 것이 **아니다**. 오히려 품질은 상용 국내 API가 나을 가능성이 높다.
근거는 이 제품의 불변식과 약관이 양립하는 후보가 사실상 이것뿐이라는 점이다. 카카오는 DB 저장을 명시적으로 금지하고,
TMAP은 24시간 상한을 두며, Google·Mapbox도 캐싱을 제한한다. 승인된 계획과 실제 활동을 버전으로 보존해야 하는
이 저장소의 규칙과 정면으로 충돌한다. 여기에 더해 자체 운영은 정밀 GPS를 외부로 내보내지 않고,
`connect-src 'self'` 기조를 유지하며, 공개 demo endpoint 의존을 제거한다.

절충으로 받아들여야 하는 것:

- **보행망 품질 리스크를 우리가 진다.** 보도·횡단보도·계단·공원 출입구 데이터가 빈 지역에서 경로가 나빠지거나
  아예 안 나온다. 위 (a)의 표본 검토로 어느 정도인지 먼저 측정해야 하며, 측정 전에는 채택도 배제도 성립하지 않는다.
- **운영 비용과 재빌드 주기가 생긴다.** CPU/RAM/디스크, 그래프 재빌드, 장애 시 사용자에게 보여줄 저하 상태가 필요하다.
  비용 수치는 이번에 산정하지 않았다.
- **ODbL 의무가 따라온다.** 표시 의무와, 파생 데이터베이스를 배포할 경우의 share-alike 조건을 확인해야 한다.
- **Valhalla vs OSRM**: Valhalla는 런타임 costing이라 보행 옵션 조정과 프로필 재빌드 부담이 적고 isochrone·map
  matching도 함께 제공된다. OSRM은 프로필이 전처리 시점에 고정되므로 보행 옵션 변경마다 재빌드가 필요하다.
  대신 OSRM은 이미 이 저장소가 probe로 응답 형식을 다뤄 봤다. 둘 다 실측 비교 전에는 확정하지 않는다.
- **차선책**은 Mapbox다. 인프라 운영을 없애는 대신 저장 제약과 요금을 진다. 코스 geometry를 사용자 소유 데이터로
  보존할 수 없다는 점은 동일하게 남으므로, 이 제품 요구사항이 바뀌지 않는 한 권고로 올리지 않는다.
- **국내 상용 API를 굳이 택한다면** TMAP이 카카오보다 조건이 덜 빡빡하나, 24시간 상한 해석에 대한 SK의 서면 확인이
  선행되어야 한다. 서면 확인 없이 "24시간마다 재호출하면 된다"고 설계하지 않는다.

이것은 권고일 뿐 선정이 아니다. 아래 입력이 사용자로부터 확정되기 전까지 어떤 후보도 채택하지 않는다.

## 진행하려면 사용자에게서 받아야 할 것

1. **코스 geometry 영구 저장이 제품 요구사항으로 확정인지**. 확정이면 카카오는 현 약관에서 탈락, TMAP·Google·Mapbox는
   조건부다. 실시간 표시만으로 충분하다면 후보군이 완전히 달라진다.
2. **인프라 운영을 감수할지에 대한 결정과 예산 상한**. 자체 운영 서버 비용·재빌드 주기·장애 대응 담당을 정해야
   Valhalla/OSRM 비교를 실측으로 진행할 수 있다.
3. **서비스 대상 지역의 우선순위**. 전국을 한 번에 검증할 수 없다. 우선 지역이 정해져야 (a)의 표본을 구성한다.
4. **국내 상용 API 계약 의사**. 카카오모빌리티 제휴 문의, SK 종량제/정액제 문의, 약관 해석 서면 확인을 진행할지 여부.
   이는 외부 연락이므로 사용자 승인 없이 수행하지 않는다.
5. **위치정보 관련 법적 검토 주체**. 위치기반서비스사업 신고 대상 여부와 제3자 제공 고지 범위는 법률 판단이며
   이 문서의 범위를 벗어난다.
6. **ODbL 표시·share-alike 수용 여부**(자체 운영을 택할 경우).

## M0-06b가 `not_reviewed`를 벗어나기 위한 항목별 증거

| 남은 항목               | 필요한 증거                                                                                                                                                                       | 현재 상태                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 운영 provider 선정      | 위 6개 입력에 대한 사용자 결정과, 선정 근거를 기록한 ADR                                                                                                                          | 미수행(사용자 결정 대기)                                        |
| 한국 보행 coverage 검토 | 위 (a) 6개 요건을 충족한 표본 fixture: 좌표, 기대 판정, 근거 URL/way ID, 검토일, 실제 응답, geometry 대조 결과. 보도·횡단보도·교량·계단/지하도·공원·시간제한 6유형 각각 양성·음성 | `not_reviewed`. 합성 3건은 재현성만 입증                        |
| `KR-SYN-02` 원인 규명   | 동일 좌표의 snap 반경 변경, `nearest` 조회, 프로필 교차 비교, 해당 좌표 주변 OSM way 태그 확인 결과                                                                               | 미수행                                                          |
| 음성 대조군             | 비영점 육상 보행 불가 구간에서의 `NoRoute`/`NoSegment` 관측. `InvalidOptions`·전송 오류는 불인정                                                                                  | `NEG-SYN-03`이 해양 좌표 `NoSegment` 관측. 육상 대조군은 미수행 |
| 엔진·그래프 신원        | engine version, graph 생성일, extract 기준 시각·해시, 프로필 해시                                                                                                                 | 공개 demo 응답에 없어 `null` 유지                               |
| 실제 adapter 검증       | 서버 adapter를 통한 실제 provider 호출의 성공·429·timeout·NoRoute·취소 경로. 합성 fixture 패널은 대체 불가                                                                        | 미수행                                                          |
| tile·style 배포         | 선정된 tile 출처의 origin, CSP 실제 지시문, attribution, 라이선스 표시                                                                                                            | 현재 합성 선만 렌더링                                           |
| OS IME·실기기           | 기존 M0-06b 기록의 미완 항목 유지                                                                                                                                                 | 미수행                                                          |

이 표의 어느 항목도 이 문서로 충족되지 않는다. 이 문서는 조사이며 검증이 아니다.
