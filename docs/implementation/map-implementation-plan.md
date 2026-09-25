# 지도 뷰어·자체 경로 생성 구현 계획

결정일: 2026-09-21. 기준 HEAD: `3577f92a4c1fdc2f044de7c5c45bf537038541af`.
상태: **사용자 요청에 따른 실행 계획; 아래 신규 구현·수용 시험은 모두 not_started / not_executed**.
기계 판독 의존성은 [task-graph.json](task-graph.json), 현재 재개 지점은 [HANDOFF](HANDOFF.md)를 따른다.

## 1. 결정과 범위

외부 상용 지도·길찾기 API를 사용하지 않고 제품의 viewer·코스 편집·생성 로직을 구현한다.
MapLibre 같은 오픈소스 렌더러와 자체 운영하는 지도 데이터·경로 엔진은 사용할 수 있다.
‘API 없음’은 내부 Fastify API까지 없애거나 지도 렌더러·도로 탐색 알고리즘을 처음부터
새로 작성한다는 뜻이 아니다. 브라우저는 우리 서비스만 호출한다.

**기록 표시 → 활동 저장·분석 → 기록의 코스화 → 경유지 편집 → 목표 거리 후보 생성** 순서다.
지도 배경, 실제 GPS, 계획 코스, 경로 계산은 서로 다른 데이터와 책임이다.
공개 OSM tile 서버나 demo routing endpoint를 운영 fallback으로 사용하지 않는다.
주소 검색·고도 데이터도 외부 상용 API로 몰래 대체하지 않는다.

연관 요구: S09/S13/S14, V2-F13/F18/F19/F31/F35/F36, V2-A17/A18/A20/A34/A35,
[FUT-07](../.pre/06_follow_up_backlog.md#fut-07).
기존 [아키텍처](../.pre/02_frontend_architecture.md), [디자인](../.pre/03_design_system.md),
[반응형](../.pre/07_responsive_layout.md)을 유지한다. 이전 문서의 hosted routing 후보는
이 결정으로 현재 채택 경로에서 제외하지만 과거 조사·실패·미확인 증거는 보존한다.
공식 Garmin·Native·한국 보행 coverage·OS IME gate는 면제하지 않는다.

## 2. 현재 구현과 재사용 경계

독립 상태 조사와 계획 에이전트가 기존 대화 없이 저장소를 읽고 확인했다. 이번에는 앱 시험을
재실행하지 않았다. 변경 전 graph는 122개 노드(완료 108, 진행 2, 미착수 12)다.

| 기반                                             | 현재 상태                                                                    | 확장 방법                                                                      |
| ------------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `packages/experience/ui-spike/src/map-panel.tsx` | MapLibre 6.9.1, 배경 tile 없는 합성 선, worker/resize/remove·WebGL 실패 대안 | production geo-kit으로 검증된 패턴만 이식; 제품 viewer 완료로 간주하지 않음    |
| `packages/contracts/src/activity-details.ts`     | 상세 v1~3 record는 index/time/distance/HR만 허용; GPS는 strict 거절          | 별도 versioned track 계약과 명시적 연결; 구버전 hash와 해석 유지               |
| `src/workout_manager/activity_export.py`         | FIT 상세 export에 GPS 없음                                                   | 기존 producer 확장; parser/단위/원본 index의 공통 fixture                      |
| M1-04x/y/au, activities `detail-selection.ts`    | 상세 수입·chart/lap 선택·탭, source revision별 메모리 선택                   | 새 Activity나 중복 selection store를 만들지 않고 연결                          |
| `packages/server/media/src/object-storage.ts`    | private temporary/publish/open/delete port                                   | FIT/GPX/track 전용 검증·namespace 추가 필요; PDF/Markdown 검증을 우회하지 않음 |
| `routing-state.ts` 및 기존 연구                  | 합성 오류 복구와 공개 demo 관측; 한국 coverage는 not_reviewed                | 요청 revision/취소 패턴만 재사용; 자체 엔진 시험은 새 증거로 기록              |

현재 product geo-kit, Course/RouteRevision 원장, GPX parser, 실제 GPS viewer,
자체 tile·routing·geocoder 배포는 없다. 비공식 개인 Garmin FIT fetch는 보조 도구이며
공식 자동 연동 증거가 아니다. 기존 활동 목록·차트·원장 전체를 다시 구현하지 않는다.

## 3. 데이터와 계약

아래는 구현 계약의 요구 사항이지 TypeScript 초안만으로 완료되는 runtime schema가 아니다.
M2-01a에서 schema·producer·consumer·fixture·version compatibility를 함께 확정한다.

| 데이터                 | 정본·필수 관계                                                                                                 | 금지 사항                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| RawTrackFile           | 소유자, bytes/hash, 형식, 수입 ID·원본 출처, parser version; 비공개 원본                                       | 재파싱으로 원본 덮어쓰기, client storage key 신뢰    |
| RecordedTrack          | activity/source revision + track revision, 원본 sample ID, nullable 시간·위치·거리·속도·심박·고도·lap 관계     | 결손을 0 또는 추정 actual로 채움                     |
| TrackSegments          | 연속 연결 가능한 sample ID 목록, 단절 사유·분할 정책 version                                                   | 결손/이상점 삭제 뒤 앞뒤 직선 연결                   |
| MapPath                | recorded/planned/candidate 역할, GeoJSON, 원본 revision 및 vertex→sample/range mapping, simplification version | 표시 인덱스를 원본 시계열 인덱스로 사용              |
| Course / RouteRevision | 별도 ID, 불변 형상·경유점·생성 조건·출처 revision, 현재 head와 expected revision                               | 코스 편집이 과거 Activity 또는 승인 PlanVersion 수정 |

로컬 preview의 provenance는 `local-file`(파일 hash/parser version/stream/sample ID),
저장된 track은 `activity-source`(activity/source/track revision)로 판별하는 union을 둔다.
위 표의 Activity 관계는 저장된 track에 적용하며 preview에 가짜 Activity ID를 만들지 않는다.
서버 저장 시 명시적 import 결과로 provenance를 연결한다.

좌표는 WGS84 `[longitude, latitude]`, 유한 수·범위 검증을 적용한다. 시간/심박을 GeoJSON
추가 좌표 차원에 넣지 않는다. `sampleId`는 해당 원본 stream/revision에서 안정적으로 정하고
재파싱에서 대응이 달라지면 새 revision으로 취급한다. 좌표 없는 sample도 측정 관계를 유지한다.
경도 경계 횡단·극지 표시 한계·동일 좌표·시간 역전·중복 시각·한 점 segment를 명시 처리한다.
한 점은 선을 조작하지 않고 점/불충분 상태로 표시한다.

GPX `trkseg`와 FIT session/event·결측·시간 gap은 별도 segment로 남긴다. FIT semicircle과
invalid sentinel은 parser별 단위 변환 fixture로 검증한다. GPX track/route/waypoint를
구별하고 route를 기록된 실제 운동으로 자동 승격하지 않는다. 여러 track/session 파일은
명시 선택을 요구하며 하나의 실제 기록으로 임의 합치지 않는다.

기기 보고 거리, 원본 GPS 재계산 거리, 표시 선 길이, routing 예상 거리는 서로 다른 값이다.
기존 실제 요약의 출처 우선순위·계산 정의를 유지한다. 단순화·지도 zoom·map matching으로
시간/거리/페이스/훈련 집계를 변경하지 않는다. 맵 매칭은 초기 범위 밖이며 나중에도 별도 파생물이다.

## 4. 실행 DAG와 완료 조건

모든 신규 노드의 status는 `not_started`다. a와 d는 독립 착수 가능하다.
의존성은 AND이며 root가 공유 계약·migration·manifest를 직렬 통합한다.

| 작업                          | 선행 작업         | 결과·필수 수용                                                                                                            |
| ----------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| M2-01a Track 계약·정규화      | M1-04x            | bounded FIT/GPX parser, sample/segment/runtime DTO·구버전 호환; 손상·결손·단위·gap fixture                                |
| M2-01b 로컬 파일 viewer       | a                 | 파일 1개 선택→메모리 parse→RunMap, 시작/끝·전체 보기·기본 요약; 정상/gap/no-GPS/오류/취소 구분; 자동 upload 없음          |
| M2-01c private track 저장     | b, M2-04b         | 기존 ingestion에 원본/정규화/파생 object와 revision 연결; tenant·중복·suppression·삭제/export/복원                        |
| M2-01d 자체 지도 인프라 spike | M1c-04            | 작은 지역 basemap/style/glyph/sprite/worker 자체 배포, 엔진 후보 측정·운영 ADR; 외부 runtime 요청 0·license·CSP·장애 대안 |
| M2-01e 저장 활동 지도·차트    | c, d, M1-04au     | S09 재조회·chart/lap/sample 연결·두 shell·반응형·계정 전환; 실제 track와 basemap 검증                                     |
| M2-01f 기록→Course            | e                 | 명시 구간 선택·Course CRUD/불변 version·GPX export·private default; 원본 actual 불변·동시 수정 CAS                        |
| M2-01g 자체 보행 routing      | d                 | 고정 engine/profile/graph, 내부 adapter·bounded 계산·한국 독립 coverage 보고; 실패·취소·과부하·snap 제한                  |
| M2-01h 경유지 편집            | f, g              | S14 시작/경유/끝·잠금·undo/redo·목록/drag 대안; 최신 draft에만 결과 적용·검토 후 명시 저장                                |
| M2-01i 목표 거리 후보         | h                 | bounded loop/왕복 후보·seed·평가·중복 제거·거리 오차·후보 없음; 사용자 선택 전 저장/승인 안 함                            |
| M2-01j S13/S14 잔여 기능      | f, h              | GPX import/round-trip, 이름·즐겨찾기·마지막 사용, 자체 장소 검색·고도 출처, privacy trim 확인, 버전 참조                  |
| M2-01k 통합 수용·운영         | i, j              | S09/S13/S14 요구 대조, 실제 OIDC/DB/객체/E2E, 복구·삭제·성능·graph 교체 rollback                                          |
| M2-01 부모                    | M1c-04, M0-06b, k | 전체 코스·routing 수용; viewer만으로 완료 금지                                                                            |

b의 무배경 또는 합성 배경 표시는 초기 로컬 검증이다. 실제 배경 지도의 완료는 d/e에서
별도 검증한다. b의 로컬 파일은 저장 전 preview이며 서버 actual을 만들지 않는다.
브라우저 FIT SDK 채택은 크기·지원 runtime·license·worker 시험 후 확정한다. 저장 시 서버는
클라이언트 parse 결과를 신뢰하지 않고 같은 규칙으로 재검증/파싱한다.

M0-06b는 계속 진행 중이며 g의 coverage와 d/e/k의 증거를 합류한다. M0-06b를 g의 선행으로
두어 순환을 만들지 않는다. M2-02는 전체 M2-01 이후, M2-06은 기존 M0-06b를 계속 요구한다.
목표 거리 기능도 이번 확장 범위로 추적하되 LLM·공개 발견(검색·목록)·실시간 내비게이션은 포함하지 않는다.

## 5. 컴포넌트·서비스 경계와 UX

M2-01j의 S13 수용에는 지도 썸네일, 노면 정보의 확인 상태, 접근성 메모도 포함한다.
썸네일은 private 파생 위치 데이터로서 원본 코스의 권한·삭제·export 정책을 따른다.

`experience/geo-kit`은 SDK-free MapPath와 선택 위치·이벤트만 받는다. 내부 MapLibre adapter가
SDK 객체를 소유하며 FIT/GPX 출처나 서버 정책을 모른다. activities는 recorded viewer,
courses는 편집·후보 선택 use case를 소유한다. API는 인증과 검증 후 application port에
위임하고 routing adapter는 server/integrations, 파싱·파생물 작업은 worker에 둔다.
도메인에 React/Next/DB/MapLibre 객체를 들여오지 않는다.

지도는 client-only lazy leaf이며 두 shell이 재사용한다. React/Composition 지침에 따라
viewer/editor를 명시 조합하고 boolean mode props를 늘리지 않는다. 지도 instance는 mount 수명에
맞춰 유지하고 source 데이터와 선택 마커만 갱신한다. fitBounds는 최초/활동 전환/전체 보기 요청에만
수행한다. resize에서는 resize만, cursor 이동에서는 선택 마커만 갱신하며 전체 경로 재계산을 피한다.
선택·초안은 반응형 renderer 밖에 두고 SDK instance·worker·listener·요청·blob URL을 정리한다.

TanStack Query는 사용자+activity/source/track revision별 서버 캐시, 기존 selection store는
차트/지도 선택을 소유한다. 편집 초안은 사용자/코스별 메모리 provider에 둔다. GPS·초안을
localStorage나 서비스 worker에 기본 저장하지 않는다. 로그아웃/계정 전환에서 private cache,
worker 결과, map source, draft를 비우고 늦은 요청의 재유입을 차단한다.

S09 mobile 탭·tablet 선택 보기·desktop split, S13/S14 mobile sheet·tablet 접힘 목록·desktop
지도/목록을 기존 generated viewport/container 기준으로 구성한다. 목록으로 같은 위치/경유점 선택,
순서 변경·삭제·좌표 입력이 가능해야 한다. 키보드·single-pointer non-drag·visible focus·IME를
지원하며 지도 실패에도 요약/차트/목록을 사용할 수 있다. 오류·GPS 없음·부분 기록·배경 없음·
WebGL unavailable·미계산·계산 중·stale·저장 실패를 구별한다. 지도 pan이 페이지 스크롤을
영구 가로채지 않도록 제스처와 focus 탈출을 시험한다.

## 6. 자체 운영과 경로 생성

d에서 MapLibre 기존 고정 버전을 우선 검증한다. 배경은 허가된 지역 OSM 추출물에서 생성한
vector tile/스타일 자산을 직접 호스팅하는 방향이다. 파일 형식·tile builder·serving 도구는
아직 미선정이다. 공개 배경 자산과 private GPS object는 bucket/path/auth/cache 정책을 분리한다.
정적 배경 요청에도 관측 지역이 드러날 수 있어 tile access log·telemetry의 보존/최소화를 검토한다.

GraphHopper open-source, Valhalla, OSRM 중 보행·국내 데이터·자원 비용으로 하나를 검증·선정한다.
hosted GraphHopper Directions API 옵션이 자체 운영판에 그대로 있다고 가정하지 않는다.
round-trip capability가 없으면 명시 실패 또는 자체 bounded 후보 탐색을 설계하고 직선 성공은 금지한다.
장소 검색과 elevation은 자체 데이터/엔진·license·갱신·결손 정책을 j에서 검증한다.

운영 ADR 필수 항목: 대상 지역·extract 날짜/hash/출처, engine/profile/build version,
tile/style/glyph/sprite license와 attribution, 보관/배포 조건, CPU/RAM/disk·비용 상한,
build 주기·운영 담당, 원자적 graph 교체·이전 버전 rollback, health check·과부하 차단.
예산·호스팅 환경이 미정이면 준비 작업은 진행하되 운영 검증 완료는 보류한다.
경로 엔진은 외부 직접 접근을 막고 내부 API도 tenant별 rate/concurrency/waypoint/거리/응답점수/
deadline 한도를 둔다. 데이터 취득은 운영 allowlist로만 수행하며 사용자가 임의 URL을 넣지 못한다.

RouteRevision에는 실제 사용한 graph/profile/engine·조건·요청 revision·계산 시각·거리·warnings를
저장한다. 오래된 graph로 계산한 저장 코스를 새 graph로 조용히 덮어쓰지 않는다. 최신 요청 ID와
draft revision이 일치할 때만 결과를 반영한다. 취소는 서버 자원 상한과 함께 구현한다.
NoRoute/coverage 밖/과도한 snap/timeout/과부하를 구별하며 실패해도 미계산 초안을 보존한다.

목표 거리는 근사치다. 후보 수·시도 수·시간·지역 범위에 상한을 두고 seed와 평가 version을
기록한다. 연결성·목표 오차·중복/왕복 구간·알려진 접근 제한·경사 출처를 표시한다. 누락된
계단/노면/야간 통행 정보는 충족으로 판정하지 않는다. 엔진 결과나 과거 기록은 현재 통행의
안전 보장이 아니다. LLM이 좌표를 발명하거나 경로를 actual/승인 계획으로 적용하지 않는다.

## 7. 보안·수명주기

파일 bytes·sample/segment 수·XML depth/text·정규화 출력·파싱 시간·메모리·worker 동시성에
구체적 상한과 초과 오류를 a에서 확정하고 각 경계/초과값을 시험한다. 확장자/MIME만 신뢰하지
않고 FIT 무결성·GPX root/namespace를 검증한다. XML DTD/외부 엔티티·외부 참조는 차단하며
파일명·메타데이터의 control 문자와 XSS를 거절/안전 렌더한다. 초기에는 archive를 받지 않는다.

저장 소유자는 세션에서 도출하고 RLS·CSRF·인증 download를 적용한다. private 객체 key는
서버가 생성하며 경로 순회·symlink·hash/size 검증을 수행한다. temp/prepared/final 상태를 DB에
먼저 기록하고 publish 실패·DB rollback·중복/동시 upload를 기존 durable cleanup 패턴으로
처리한다. lease 시간은 DB 기준, 삭제 직전 live reference와 진행 upload를 재검증한다.
tenant bytes/intent quota·expiry·bounded reaper·dead-letter를 갖추고 API에서 임의 직접 삭제하지 않는다.

Activity 삭제는 기존 source/canonical/overlay·suppression 의미를 유지하면서 관련 raw track,
정규화·지도 파생물·cache를 회수한다. 기본 정책은 해당 Activity 좌표에서 파생된 Course revision도
회수하는 것이다. 독립 편집본도 lineage를 유지하며 개인정보 제거를 회피하는 복사 경로가 되지
않게 한다. 영향받는 코스를 삭제 확인에 표시하고 참조만 남은 곳은 unavailable로 처리한다.
다른 독립 원본을 공유하는 객체는 live reference를 확인하여 과잉 삭제하지 않는다.
계정 erasure는 모든 코스/파일/파생물/재시도까지 제거하며 restore 후 suppression을 재적용한다.
export는 새 collection/version·구버전 호환을 명시하고 권한 확인 시점의 snapshot과 삭제 경합을 시험한다.

원본 GPS·정확한 waypoint·객체 key·토큰·본문은 로그/trace에 넣지 않는다. privacy trim은 원본을
덮어쓰지 않는 명시적 파생 revision으로 만들며 서버 응답·GPX·메타데이터도 함께 처리한다.
출발/끝뿐 아니라 보호 구역 재진입을 검사한다. 공개 발견(검색·목록)은 두지 않는다. 코스 공유는
[M2-01k-o 요구](research/m2-01k-o-sharing-requirement.md)가 정한 만료·철회 가능한 보기 전용 unlisted 링크로만
허용하며, 독립 재식별 검토가 통과하기 전까지 기본값 꺼짐이다. 공유와 GPX 내보내기는 privacy trim 확인을
거친 revision만 내보내고, trim이 거절되는 코스는 내보내지도 공유하지도
않는다. 보호 구역이 없으면 소유자 GPX만 경고와 확인 뒤에 정확한 시작·끝을 싣고 링크 공유는 보호 구역이 하나 이상 있어야 하며, 보호 구역 안 좌표는 소유자가 경고 뒤 고른
자기 GPX에만 실리고 공유 링크로는 나가지 않는다. 공유와
GPX는 시각·활동 연결·코스 식별자·소유자 신원을 싣지 않는다. 계정 export는 공유가 아니며 이 확인 밖이다.
개인 export와 공유용 산출물을 혼동하지 않는다.

## 8. 검증 계획과 다음 착수

| 계층                 | 필수 증거                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 계약/parser          | FIT/GPX 손상·한도 경계·XXE·좌표 순서·timestamp null/역전·segment·날짜 경계·단일 점·다중 track; 구버전 상세 replay 동일   |
| 단순화/분석          | 원본 sample 매핑·gap 불연결, zoom/LOD 변경 전후 실제 요약·집계 동일                                                      |
| 실제 PostgreSQL/객체 | tenant/RLS·idempotency·CAS·동시 upload/삭제·publish 실패·lease race·cleanup 재실행·export/erasure·백업 복원              |
| UI/component         | 파일 교체/취소·stale 응답·차트 선택·초안 유지·계정 전환·WebGL 실패·키보드/목록 대안                                      |
| 실제 브라우저        | Aside 우선 후 불가 사유별 Chrome/Playwright; Next/Vite production, 320px·767/768·1279/1280·420px pane·회전/IME/touch     |
| 자체 운영            | 외부 runtime 요청 없음, CSP/worker·asset license·대표 장기 track의 시간/메모리/GPU 측정, graph 갱신/rollback·과부하      |
| 보행 coverage        | graph 신원 고정, 사전 기대 결과와 독립 검토자, 도심/횡단보도/다리/계단/공원/접근시간·음성 대조; HTTP 200만으로 통과 금지 |

실제 기기 성능 기준은 d에서 대표 track 크기와 함께 수치로 고정한다. 합성 CI는 외부 서비스를
호출하지 않으며 fixture 통과를 국내 실제 통행 검증으로 바꾸지 않는다. 앱 구현 후 관련
format/lint/typecheck/unit/integration/build/E2E와 backup drill을 실행한다.

다음 작업은 **M2-01a 계약·정규화**와 **M2-01d 자체 지도 인프라 spike**다. 계약 담당이 먼저
schema/sample linkage/한도를 확정하고 b parser worker·viewer와 c 저장 흐름에 전달한다.
이번 문서 작업은 구현·라이브러리 설치·데이터 다운로드·서버 배포·유료 서비스 계약을 하지 않았다.

## 9. 공식 참고 자료

커밋 전 독립 검토(2026-09-21): 현재 tab의 Herdr 분리 pane에서 `map-docs-review`가
읽기 전용 검토를 완료했다. 검토 base는 `3577f92a4c1fdc2f044de7c5c45bf537038541af`,
검토 staged binary diff SHA-256은
`6cb29699e205cc2067664c81e3083a6022ed6c5114a8dbded3e02ad99e6d534d`다.
결과: **“실행 가능한 지적 사항 없음.”** 문서 변경에 필요한 추가 검증 공백도 발견하지
못했다. 이 hash는 본 검토 기록 추가 전 7개 문서의 내용이며, 앱 구현 검증이나 coverage
승인을 뜻하지 않는다.

문서 변경 검증: 133개 노드의 ID·참조·비순환, 신규 11개 JSON/표 의존성 일치,
관련 문서의 저장소 내부 링크 56개, 새 계획/graph JSON Prettier, `git diff --check` 통과.
기존 README의 다른 저장소 절대경로 참조는 이 환경에 없어 검증에서 별도 제외했다.
계획 에이전트의 읽기 전용 재검토에서 local preview provenance와 S13 잔여 수용 항목을
보완했다. 앱 테스트·브라우저·실제 엔진 검증은 이번 문서 작업에서 실행하지 않았다.

2026-09-21 확인. 아래 기능 설명은 제품 검증 결과가 아니다.

- [MapLibre GeoJSONSource](https://maplibre.org/maplibre-gl-js/docs/API/classes/GeoJSONSource/): 표준 geometry 입력과 source 데이터 갱신 경계.
- [GraphHopper open-source engine](https://github.com/graphhopper/graphhopper): 자체 운영 엔진과 별도 commercial Directions API 구분.
- [OpenStreetMap 데이터 license](https://www.openstreetmap.org/copyright): ODbL·출처 표기 및 데이터 이용 조건. 배포 산출물별 의무를 d에서 대조한다.
- [기존 routing 선행 조사](research/routing-prerequisites.md), [공급자 조사](research/map-provider-review.md): 과거 조사로 보존; 이번 자체 운영 결정과 검증을 구분한다.
