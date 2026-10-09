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
