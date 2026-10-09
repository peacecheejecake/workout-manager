# M2-01k-local opt-in 실제 관측 · 2026-10-09

Root는 TMP runner/library 전체 및 원lifecycle successor diff를 읽고 source/build4227,
Seoulgraph9, JAR/profile/extract, basemap4829/geo2와 helpers를 새 freeze로 고정했다.
원명령 --list는 실제 graph6/missing-data2/no-webgl2를 등록했다. 별도 소유PG170006과
복사그래프의 원Java17.0.15 launcher로 원시험을 실행했다. 모의HTTP/시험 앱 결과가 아니다.

## 실제 결과

- graph_samples_background: exit0,5passed/기존1skip. 같은6제목·위치·Host census 대응.
- missing_data: exit1,Next1passed/Vite1failed. Vite의 원spec44 basemap필수전제에서 실패했다.
- no_webgl: 앞선실패후미실행. 미실행을 성공으로 바꾸지 않았다.

현재 Vite preview는 raw/copy basemap 공개를 막는 deny-preview-basemap 정책을 사용한다.
identity config의 예전주석·BASEMAP_ORIGIN은 이 정책과 다르게 preview배경을 기대한다.
Root가 원정책/unit/Next guarded serving route를 읽었고 assert/skip/guard를 완화하지 않았다.
후속은 제품 guard를 사용하는 별도 로컬 fixture host 구성을 검토한다.

source/build/geo/original·복사graph전후동일, Java 소유프로세스 종료·포트free, 각fixture
DB0/roles0/slots0/clients0 및 clusterDB1/roles1을 확인했다. Rootlifecycle로 정확소유container제거.
실패artifacts는 자기TMP만 정리했고 rawGPS/health/cookies/SQL/error본문을 저장하지 않았다.

- freeze SHA: `66ef29ad274f136b931e1eb080b21ef049a2b2407b715be0cac9945a7552aab0`
- aggregate: `/private/tmp/wm-m2-01k-local-optin-actual-20261009-result.json`
- aggregate SHA: `f8d10b773473df585b0e32c8dd4e1f842ce857df54ffd32bb866271ef63bd1bf`
- cleanup SHA: `aa140676ffada7a39d6bcd3ca64bcc4bde6263bc936560312998337a38618323`

## 한계

aggregate accepted=false. 기존110행93pass/13partial/3not_executed/1failed와 canonical12skip은
그대로다. mandatory 재식별 독립검토/전체phase검토·운영OIDC·ODbL공개·최종제품실기기 증거가
아니며 graph완료상태/main/push는 갱신하지 않았다.

## 고정 Next guard를 사용하는 identity mobile 시험 호스트 후속

기존 Vite public basemap deny를 유지했다. 새 identity-only Node host는 고정 loopback Next
basemap guard에 GET/HEAD만 전달하고, 내부 Vite preview는 기존 BFF/CSP/공개 basemap 차단을
유지한다. 사용자 cookie/auth를 basemap으로 전달하지 않고 redirect·foreign Host·비정상 경로·
16MiB 초과·10초 초과를 거절한다. 일반 authenticated BFF 동작의 timeout을 변경하지 않는다.
shared identity config의 mobile command만 이 test host로 연결했다. 제품 mobile 배포를 바꾸지 않는다.

Root가 source와27 tests 전체를 검토하고 기존 Vite policy regression1을 함께 실행해
28/28·skip0·exit0을 확인했다. owning tooling TS/scoped ESLint/format 및 root strict TS exit0이다.
이는 실제 Host 수용과 구분된다. 이후 source/build4230, geo4831와 원 Seoul graph/JAR를 고정해
원 opt-in 세 명령을 actual PostgreSQL17.6·plain owner의 전용 클러스터와 자체 GraphHopper에서
순서대로 실행했다. 단언/timeout/workers1/retry0/roster를 변경하지 않았다.

| 실제 recipe              | 결과              |
| ------------------------ | ----------------- |
| graph_samples_background | 6pass/0skip/0fail |
| missing_data (Next/Vite) | 2pass/0skip/0fail |
| no_webgl (Next/Vite)     | 2pass/0skip/0fail |

원10등록 전부 통과·flaky0·exit0이다. 이전 graph5pass/1skip, missing-data Vite1fail,
no-WebGL not_executed는 역사로 유지하며 이번 새 결과로 소급 변경하지 않는다.
기존 build Next1035/mobile111/contracts156은 전후 동일했다. test-host/config는 source tsx로
실행했으며 새 product build를 수행했다고 쓰지 않는다. Root가 finite records 전수를 읽어
exact roster/오류0와 source/build/geo/graph 불변을 확인했다. 각 명령 DB/role/slot/client 잔존0,
protected5 ports/engine2 ports 반환, 자기 Java group 종료143, 자기 artifacts/TMP 정리를 확인했다.
Root가 고정 actor 결과와 exact container name/label/image/tmpfs 소유권을 확인하고 이번
컨테이너·private handoff만 제거했다. 기존3 TMP와 EXT-HOSTING WIP4줄은 보존했다.

- final manifest SHA: `5a33415efb560e00f3b2465905fc877ccda81e4ce6130b18bf82317b8a723623`.
- actual `/private/tmp/wm-m2-01k-local-optin-mobile-host-actual-20261009-result.json`, SHA `4ba68c9d28e86f96edcca53890b305529e303b389eb0dace3a84cff604141ec9`.
- graph finite SHA: `463f47ab9b832c6a3addf0470c88c0ac2c6b818133a1d4d1b4ae5be4e8c4352b`.
- missing finite SHA: `e00a8eb779474db6a2daad60d38728635c65979daca768bbc52100cd2deae04d`.
- no-WebGL finite SHA: `71519441507daa2bd62578daf21a8b024aa08bcd3ae9f378c34df752b8901897`.
- cleanup `/private/tmp/wm-m2-01k-local-optin-mobile-host-owned-cleanup-20261009.json`, SHA `d4d7137c3ba779d31eeca0e312b0e074abac820f99dae5034f3c3e277cf0f81a`.

Canonical358 whole identity·independent phase review·operational/native acceptance는 이10case
검증과 별개다. authority none을 유지하며 task graph 전체 수용·main 병합·출시를 선언하지 않는다.
