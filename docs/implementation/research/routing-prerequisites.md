# Routing 선행 조건 조사

확인일: 2026-09-16. 범위: M0-06a, FUT-07, V2-F18/F19, V2-A34, S13/S14.
상태: **공식 문서 조사 완료. 공급자 선정·한국 coverage·실제 routing·지도 브라우저 검증은 미수행.**

기준은 [FUT-07](../../.pre/06_follow_up_backlog.md#fut-07)과 [코스 설계](../../.pre/04_integrations_metrics_rag.md)다. 아래 제안은 구현·검증 준비 자료이며 저장소 규칙이나 공급자 선정 ADR을 변경하지 않는다. 계정 생성, 유료 계약, API key 발급, 실제 위치 데이터 전송은 수행하지 않았다.

## 역할과 후보

| 계층·후보                  | 공식 문서에서 확인한 점                                                                                                                                                                                                                                                       | 프로젝트 적용 전 남은 조건                                                                                                                                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MapLibre GL JS             | WebGL 기반 지도 renderer이며 style과 tile source를 사용한다. 문서 예제의 MapTiler 데이터는 별도 key가 필요하다. [공식 소개](https://maplibre.org/maplibre-gl-js/docs/)                                                                                                        | 도로 탐색 engine으로 취급하지 않는다. 별도 tile/style/glyph/sprite 제공자, 데이터 출처 표시, 배포 origin, 모바일 GPU·메모리 검증 필요                                                                                                                        |
| OSRM                       | car/bicycle/foot profile이 있으며 profile은 **데이터 전처리 시** 적용된다. 같은 OSM 입력이라도 profile별 전처리 산출물을 구분한다. [Profiles](https://project-osrm.org/docs/v26.4.0/profiles)                                                                                 | foot 그래프·추출 범위·데이터 날짜·profile hash를 확보해야 보행 시험 가능. URL의 profile 이름만 바꾸어 자동차 그래프를 보행으로 간주하지 않는다. 자체 운영 비용·재빌드 주기·배포 용량 산정 필요                                                               |
| Valhalla                   | 런타임 costing과 pedestrian/bicycle 등을 제공하는 routing engine이다. 데이터 출처별 요건도 별도로 확인하도록 안내한다. [공식 문서](https://valhalla.github.io/valhalla/)                                                                                                      | 운영 endpoint, 한국 graph 추출물, pedestrian 옵션·고도 원본·갱신 주기·컴퓨팅 예산을 먼저 정해야 비교 가능                                                                                                                                                    |
| GraphHopper Directions API | 관리형 routing 후보. 확인 당시 요금표는 Free 500 credits/day, 비상업용 한정; Basic 예시는 월 €69와 5,000 credits/day를 제시한다. credits는 호출 수와 동일한 단위로 가정하지 않는다. [요금·제한](https://www.graphhopper.com/pricing/)                                         | 상업 서비스 적합 plan·실제 필요한 보행 profile·월/연 결제 및 VAT·burst 한도·재시도 비용·key 관리 확정 필요. 이 가격은 견적이나 구매 승인 아님                                                                                                                |
| openrouteservice           | Directions endpoint를 제공하며 hosted API는 waypoint·거리·대안 경로 등 별도 제한을 둔다. 확인 당시 waypoint 한도는 50이다. [Directions](https://giscience.github.io/openrouteservice/api-reference/endpoints/directions/), [제한](https://openrouteservice.org/restrictions/) | 계정/key와 해당 plan의 호출 quota·용도·표시 조건 확인 필요. [plans](https://openrouteservice.org/plans/)와 [약관](https://openrouteservice.org/terms-of-service/)은 HeiGIT 계정 사이트로 이동했고 이번 읽기 도구로 본문을 확보하지 못했으므로 조건 확정 보류 |

한국 coverage는 위 기능 목록이나 전 세계 지도 표시로 입증되지 않는다. engine, hosted API 운영자, 도로 데이터, profile 조합마다 별도 시험한다. 자체 운영 후보도 CPU/RAM/storage/전송량/데이터 갱신 비용을 산정해야 한다. 아직 특정 후보를 우선 공급자로 선정하지 않았다.

Tile, routing, geocoding, elevation은 별도 계약 항목이다. 지도 스타일이 보인다는 이유로 routing 권한·고도 정확도·주소 검색 quota까지 확보되었다고 보지 않는다. OSM의 공개 표준 raster tile 서비스는 attribution, 캐시, 식별 가능한 요청 등 사용 정책이 있고 bulk/offline 다운로드는 허용하지 않는다. 무료 데이터와 무제한 tile 호스팅을 구분한다. 벡터 tile 공급자는 해당 별도 정책을 확인한다. [OSMF Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/)

## 브라우저와 서버 검증 준비

현재 MapLibre 공식 문서는 v6 ESM worker 배포를 설명한다. Vite에서는 worker 번들 처리가 필요하고 Next에서는 worker와 shared 파일을 함께 배포하는 예를 제시한다. CSP 예시는 `worker-src 'self'`, `img-src data: blob: 'self'`이며 CDN 자동 worker와 strict CSP의 차이도 설명한다. **실제 채택할 버전을 먼저 고정하고 해당 버전의 production 빌드로 재검증한다.** 이 조사는 패키지 설치나 CSP 변경을 수행하지 않았다. [설치·CSP](https://maplibre.org/maplibre-gl-js/docs/#csp-directives)

제안하는 확인 항목:

- Next/Vite 양쪽에서 worker·shared chunk·style·glyph·sprite·tile 요청의 실제 origin과 CORS 결과를 수집한다. 해당 출처만 `connect-src`/`img-src`/`worker-src`에 반영하고 광범위 허용으로 문제를 숨기지 않는다.
- attribution은 renderer, OSM 원본 데이터, tile/style, routing 서비스 계약을 각각 대조한다. GraphHopper 표시 할인·white-label 선택이 다른 데이터 공급자의 표시 의무까지 제거한다고 가정하지 않는다. [GraphHopper 조건](https://www.graphhopper.com/pricing/)
- routing secret은 서버 adapter에만 둔다. 브라우저 공개 사용이 명시적으로 허용된 tile key는 제공자가 지원하는 origin 제한과 별도 quota를 확인한다. 서버 outbound origin·redirect 허용 목록과 timeout·최대 waypoint·응답 geometry 크기를 고정한다.
- 요청마다 draft revision과 요청 순서를 보존한다. 이전 요청의 지연 응답, 429, timeout, 경로 없음, 취소, 부분 실패 시 draft와 오류 상태를 유지한다. 실패를 두 waypoint의 직선 geometry로 바꾸어 `computed`로 표시하지 않는다.
- provider 응답에 실제 제공된 engine/version/profile/data timestamp/geometry/distance/elevationSource/warnings만 기록한다. engine version이나 elevation source가 없으면 `unknown`으로 남긴다. 개인 GPS·signed URL·key는 로그와 조사 결과에 넣지 않는다.

## 재현 가능한 공개 합성 coverage matrix 제안

다음 좌표는 사용자 활동이 아닌 **고정 합성 probe**다. 순서는 `[longitude, latitude]`, CRS는 WGS84다. 번호·좌표를 고정하면 같은 요청을 반복할 수 있지만, 해당 좌표가 특정 보행로·공원 입구·통행 가능한 교량에 정확히 놓였다는 검증은 아직 없다. 실제 통행 판단의 정답으로 사용하지 않는다.

| Case       | 고정 waypoint 입력                                | 먼저 확인할 대상                                                     | 현재 결과    |
| ---------- | ------------------------------------------------- | -------------------------------------------------------------------- | ------------ |
| KR-SYN-01  | `[126.978,37.566] → [126.982,37.566]`             | 서울 도심 후보의 snap 위치, 보행망 연결, 교차로 우회                 | not_executed |
| KR-SYN-02  | `[126.930,37.525] → [126.932,37.537]`             | 한강 양안 후보의 연결 방식, 보행 금지 구간 포함 여부                 | not_executed |
| KR-SYN-03  | `[129.158,35.159] → [129.164,35.161]`             | 부산 해안 도시 후보의 도로·보행로 profile 차이                       | not_executed |
| KR-SYN-04  | `[126.528,33.499] → [126.533,33.500]`             | 제주 도심 후보의 데이터 누락·접근 제한                               | not_executed |
| NEG-SYN-01 | `[0,0] → [0.001,0.001]`                           | 육상 보행 경로를 찾지 못하는 경우의 명시적 실패·과도한 snap 거부     | not_executed |
| NEG-SYN-02 | KR-SYN-01과 같은 입력, adapter에 429/timeout 주입 | draft 보존, stale 응답 무시, 재시도 상한; 실제 quota를 소진하지 않음 | not_executed |

각 후보의 보행 profile로 모든 case를 실행하고 자전거 profile을 비교군으로만 기록한다. profile이 없으면 `unsupported`, key/graph가 없으면 `blocked`, 호출하지 않았으면 `not_executed`다. 성공 HTTP 응답만으로 `coverage_pass`를 부여하지 않는다.

재현 기록의 최소 필드 제안:

```text
caseId, caseRevision, waypoints, requestedProfile, options, requestHash,
provider, endpointOrigin, engineVersion|null, graphDate|null, executedAt,
httpStatus, providerCode, snappedWaypoints, geometryHash, distanceMeters|null,
warnings, latencyMs, chargedCredits|null, result, reviewerEvidence
```

실제 한국 coverage 승인에는 위 probe 외에 공개 지도에서 검토한 **보행로·횡단보도·다리·지하도/계단·공원 출입구·야간 통행 제한** 사례가 각각 필요하다. 선정자는 공개 source URL/way ID, 좌표, 검토 날짜, 예상 허용·금지 구간과 근거를 별도 fixture로 고정한다. 불명확한 출입 시간·통행 조건은 미확인으로 남긴다. 합성 probe는 이 현지 검토를 대체하지 않는다.

## M0-06b용 공개 demo 후보 추가 확인

FOSSGIS 운영자 소개 페이지가 연결하는 [공식 frontend 설정](https://raw.githubusercontent.com/fossgis-routing-server/osrm-frontend/master/src/leaflet_options.js)에서 Foot backend가 `https://routing.openstreetmap.de/routed-foot/route/v1`임을 확인했다. endpoint를 추측한 결과가 아니다. [운영자 안내](https://routing.openstreetmap.de/about.html)는 foot 데이터 범위를 worldwide로 설명하지만 이는 한국 보행 품질 통과 증거가 아니다. 같은 안내에는 초당 최대 1회, 애플리케이션을 식별하는 User-Agent, 적절한 Referrer, attribution·지도 오류 제보 링크, 대량 사용 금지가 명시되어 있으며 요청이 서버 로그에 남는다고 설명한다.

[운영 정책](https://fossgis.de/arbeitsgruppen/osm-server/nutzungsbedingungen/)의 검색 인덱스 본문에서는 스크립트 단일 연결, 웹사이트 운영자 연락 이메일, 상업 서비스의 핵심 기능 및 높은 트래픽에 대한 제한도 확인했다. 원문 직접 열기는 이번 도구에서 Anubis 접근 차단을 반환했으므로 실제 사용 전 원문 재확인이 남는다. 이를 제품용 무제한 무료 API나 가용성 보장으로 채택하지 않는다.

M0-06b에서는 조건을 충족하는 제한적 수동 조사로 공개 합성 좌표 1~3건을 순차 실행하는 방안을 검토할 수 있다. 표시에는 [OpenStreetMap 데이터 출처](https://www.openstreetmap.org/copyright)와 [오류 제보](https://www.openstreetmap.org/fixthemap)를 포함하고 개인 GPS는 보내지 않는다. **이번 M0-06a에서는 routing 요청을 실행하지 않았다.** 실제 응답·snap·거리·형상과 한국 통행 적합성 판정은 후속 증거로 분리하고 반복 CI는 외부 demo를 호출하지 않는 fixture로 구성하는 제안이다.

## 다음 작업을 열기 위한 외부 조건

1. routing/tile/geocoding/elevation 각각의 후보·운영 방식·사용 목적·비용 상한 결정. Hosted는 승인된 key/계약, self-hosted는 데이터 추출물·배포 환경·갱신 담당 확보.
2. 공급자별 실제 지원 profile, 한국 graph 범위·날짜, export/cache/표시 조건, SLA·burst·일/월 quota 기록. openrouteservice의 계정 plan/약관 본문은 추가 확인 필요.
3. 공개 지역 검토 fixture 및 검토 담당 확보. 공원·야간·계단 접근의 미확인 항목을 기록할 판정 절차 확정.
4. `server/integrations/routing` adapter와 `experience/geo-kit` production spike, 두 shell의 CSP/WebGL/반응형/접근성 검증 실행.
5. V2-A34의 실패 복구와 Course/RouteRevision 저장·GPX 내보내기를 실제 응답으로 시험. 이 문서 작성만으로 FUT-07 또는 M2 routing 완료 상태를 변경하지 않음.
