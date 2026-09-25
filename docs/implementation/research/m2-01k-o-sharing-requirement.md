# M2-01k-o 코스 공유와 privacy 확인 — 요구

작성일: 2026-09-25. 상태: **재식별 독립 검토 반영(2026-09-25), 사용자 최종 승인 대기. 제품 코드는 없다.** 검토 대상은 이 문서의 이전 판(sha256
`5ac5e7d4…`)이며, 반영 내역은 부록 B.
사용자 결정(2026-09-25): "Draft requirement first". 순서는 이 요구 작성 → 사용자 승인 → **구현자가 아닌 독립 검토자**의
재식별 검토 → 구현이다. 링크 공유(B)는 그 검토가 통과할 때까지 **기본값 꺼짐**으로 출하한다(task-graph `M2-01k-o` root 병합 추가
(a)·(b)).

범위는 **A(확인 뒤 소유자 GPX export) + B(보기 전용 unlisted 링크, 기본 꺼짐)**다(§9 D1). 채택하지 않은 선택지는 부록 A에만 있다.
§6의 재식별 항목은 이 문서 작성자가 판정한 결과가 아니라 **독립 검토가 답해야 할 질문**이다.
`task-graph.json`·`m2-01k-requirement-matrix.json`·계획 문서는 이 단계에서 바꾸지 않았다(§7은 root가 할 개정의 내용이다).

이 문서가 보고하는 두 발견:

- **(a)** 백업 뒤 삭제한 코스가 복원으로 되살아난다. 공유와 무관한 일반 gap이며 share epoch는 공유만 막는다 — 별도 노드로 제안(§4).
- **(b)** 현재 GPX의 `metadata/desc`·`metadata/time`이 코스 id·revision·생성 시각을 싣는다(`gpx.ts:67-68`). 내보내는 GPX는 이 둘을
  싣지 않는다(§2 A, T8, V6b·V6c).

근거:

- 노드: `docs/implementation/task-graph.json`의 `M2-01k-o`(scope 전문과 root 병합 추가 (a)–(d)), 출처
  [M2-01k.md §13.6](../progress/M2-01k.md).
- 매트릭스 행(`m2-01k-requirement-matrix.json`): `S14-privacy-share`(partial — "Trim works; there is no confirmation
  step before a GPX export and no sharing feature"), `P7-no-public-share`(passed), `P7-privacy-trim`(passed).
- 계획 문장: `docs/implementation/map-implementation-plan.md:185-188`(§7 끝 문단). 관련 문장 `:104`.
- 사양 문장: `docs/.pre/01_product_screen_spec.md:165` "정확한 시작·끝 위치 공유에는 privacy trim/확인 화면이 필요하다."
- 사양 개정 선례: [M2-01t](../progress/M2-01t.md)(사용자 결정 인용 → diff → 구현 대조표 → 매트릭스 `amendments` 기록).

## 0. 현재 코드의 사실(인용)

아래는 이 요구가 딛고 서는 현재 상태다. 요구의 각 절은 이 사실을 바꾸거나 유지한다.

| 사실                                                                                                                                                                                                                                                                  | 위치                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 코스 visibility는 `'private'` literal뿐이고 공유 필드가 없다. DB도 `CHECK (visibility='private')`이며 visibility 변경을 막는다                                                                                                                                        | `packages/contracts/src/courses.ts:26-28,622,632`; `packages/server/persistence/migrations/034_course_ledger.sql:10-11,19,122`                 |
| 코스 라우트에는 공유 라우트·ACL 파라미터·공개 URL이 없고, 코스는 소유자의 인증된 GPX export로만 나간다                                                                                                                                                                | `apps/api/src/course-routes.ts:578-581`; `packages/modules/courses/src/course-api.ts:23`                                                       |
| `/bff/v1` 아래 제품 라우트는 모두 `preValidation`에서 인증을 요구한다. 인증 밖에 있는 것은 `/health`, 로그인·callback, Garmin callback뿐이다                                                                                                                          | `apps/api/src/app.ts:199-200,201-228,233`                                                                                                      |
| 모든 API 응답에 `cache-control: no-store`                                                                                                                                                                                                                             | `apps/api/src/app.ts:179-182`                                                                                                                  |
| GPX export(`GET /courses/:courseId/export.gpx`)는 **head revision을 확인 없이** 그대로 쓴다. 응답은 `private, no-store`                                                                                                                                               | `apps/api/src/course-routes.ts:871-903`                                                                                                        |
| GPX 본문: `creator="workout-manager/course-v1"`, `metadata/desc`에 `course <courseId> revision <n>`, `metadata/time`에 revision `createdAt`, 좌표 소수 7자리, `ele` 없음, waypoint 이름 포함                                                                          | `packages/server/courses/src/gpx.ts:20-24,58-87`; `packages/contracts/src/courses.ts:891`                                                      |
| 화면의 "GPX 내보내기"는 확인 단계 없이 인증된 fetch로 바로 받는다                                                                                                                                                                                                     | `packages/modules/courses/src/course-workbench.tsx:144-175,578-606`                                                                            |
| privacy trim은 **파생 revision**을 덧붙인다. 양 끝의 보호 구역 안 정점만 잘라내고, 중간 재진입(`SPLITS_THE_LINE`)·선이 구역을 지나감(`LINE_CROSSES_AREA`)·전부 제거·변화 없음은 이름 붙은 오류로 거절한다. 구역 안 via waypoint는 이름째 제거, 새 시작·끝은 이름 없음 | `packages/server/courses/src/privacy-trim.ts:131-202`                                                                                          |
| trim 요청은 화면이 본 구역 집합의 digest를 싣고, 서버가 트랜잭션 밖·안에서 두 번 비교한다(stale이면 409)                                                                                                                                                              | `apps/api/src/course-routes.ts:779-830`                                                                                                        |
| 구역 집합 digest는 zone id·반경만 담고 **중심은 담지 않는다.** 그래서 중심 이동은 digest에 보이지 않으며, 이를 안전하게 하는 것은 이동 경로가 없고 runtime role에 UPDATE가 없다는 사실이다                                                                            | `packages/server/courses/src/privacy-trim.ts:52-73`                                                                                            |
| trim revision의 `generation`에는 `zoneSetDigest`, `appliedZoneCount`, `removedVertexCount`, `removedLeading/TrailingVertexCount`, `removedWaypointCount`가 남는다                                                                                                     | `packages/server/courses/src/privacy-trim.ts:178-195`                                                                                          |
| 보호 구역: tenant당 20개, 반경 50–5,000 m. 중심은 소유자 인증 응답 밖으로 나가지 않는다                                                                                                                                                                               | `packages/contracts/src/courses.ts:53-57,1353-1370`; 라우트 `apps/api/src/course-extras-routes.ts:290-320`                                     |
| 화면: 보호 구역 목록·추가·삭제, "보호 구역 제거본 만들기" 버튼. trim은 **선택 사항**이며 공유·내보내기와 연결되어 있지 않다                                                                                                                                           | `packages/modules/courses/src/course-extras.tsx:580-655`                                                                                       |
| 코스 revision은 `recorded-segment`면 `activityId`·`trackId`를 싣고, `lineage`에도 활동 id가 남는다                                                                                                                                                                    | `packages/contracts/src/courses.ts:352-362,548-558,585`                                                                                        |
| 고도는 자체 DEM에서 코스별로 따로 조회(`/courses/:courseId/elevation`)하며 GPX에는 들어가지 않는다                                                                                                                                                                    | `apps/api/src/course-extras-routes.ts:342-358`; `gpx.ts:20-22`                                                                                 |
| 코스 삭제는 `delete_course`가 revision과 head 행을 **물리 삭제**한다. 활동 삭제는 코스를 `unavailable`로 두고 revision을 지운다                                                                                                                                       | `034_course_ledger.sql:163-188,239-260`                                                                                                        |
| 계정 말소는 `erase_account` 체인에 링크를 이름 바꿔 덧붙이는 방식으로 확장된다(예: 보호 구역)                                                                                                                                                                         | `packages/server/persistence/migrations/037_course_preferences_and_privacy_zones.sql:61-91`                                                    |
| 계정 export v19–v22: 코스 **기하는 제외**(GPX로 받음), 보호 구역 **중심은 포함**(되살릴 수 없는 입력이므로)                                                                                                                                                           | `packages/contracts/src/operations.ts:167-243`                                                                                                 |
| 백업 복원 drill은 백업 **뒤**의 말소(`tenant_erasure`)·활동 삭제를 **DB 밖 원장 파일**로 따로 캡처해 복원 뒤 재생한다. 백업 뒤 **코스 단위 삭제**를 캡처·재생하는 원장은 drill에서 찾지 못했다(`delete_course`·`courses.remove` grep 0건)                             | `scripts/backup-restore-drill.mts:518-524,2702-2768,2956-`                                                                                     |
| 말소 후 tenant prefix purge(M2-01x), 활동·코스 디렉터리 purge(M2-01y), purge 가시성(M2-01z)                                                                                                                                                                           | `044_tenant_object_purge.sql`, `045_tenant_object_purge_visibility.sql`, `046_object_scope_purge.sql`; progress `M2-01x/y/z.md`                |
| 공유(명명된 대상) 선례: 자료 공유 `resource_share`(grantee는 `coach`만, 소유자≠대상, active/revoked 상태, 감사 사실은 운영 로그와 분리). 자료 RLS 정책이 `resource_share`를 읽는다                                                                                    | `030_resource_access_sharing.sql:20-72`; `packages/server/persistence/src/migrate.ts:229-231`; `apps/api/src/resource-access-routes.ts:83-111` |
| 로그: Fastify 요청 로그 꺼짐, `req`/`res` serializer 비움, `err`는 `redacted`. M2-01k-c2가 로그 stream을 보관·감사하는 `log-audit` helper를 만들었고 **M2-01k-o가 공유 링크·정확한 위치를 이 helper로 단언하도록** 적었다                                             | `apps/api/src/app.ts:161,171-175`; `packages/server/courses/src/log-audit.ts:36,144-192,312,361,387`; `progress/M2-01k-c2.md` §2.1             |
| 좌표를 요청 줄에 싣지 않으려고 장소 검색은 POST다("request lines are logged")                                                                                                                                                                                         | `apps/api/src/course-extras-routes.ts:322-331`                                                                                                 |
| basemap 자산은 자체 origin, `referrer-policy: no-referrer`, 배포별 자산은 `public, max-age=604800, immutable`                                                                                                                                                         | `apps/web/app/map/basemap/[...path]/route.ts:72-77`                                                                                            |
| 현재 "공유 없음" 단언: E2E `course-extras.spec.ts:201-204`(`공유`·`링크 복사`·`공개` 버튼 0개), 단위 `course-workbench.test.tsx:124`, `course-extras.test.tsx:1103`                                                                                                   | 매트릭스 `P7-no-public-share` evidence                                                                                                         |

## 1. 목적과 비목표

**목적.** 소유자가 (A) 자기 코스를 GPX로 내보내고, (B) 자기가 고른 사람에게 **보기 전용 링크**로 보여 줄 수 있게 한다. 둘 다
사양 `01_product_screen_spec.md:165`가 요구하는 대로 privacy trim 확인을 거친다. 확인 없이는 정확한 위치가 앱 밖으로 나가지
않는다 — 공유 보기에도 GPX에도.

**비목표.**

- 공개 발견(검색·목록)이 없다. 공유된 코스는 어떤 색인·sitemap·검색·"인기 코스"·지도 overlay에도 나타나지 않는다.
- 소셜 피드·팔로우·좋아요·댓글·조회수 표시가 없다.
- 등록 사용자 지정 공유(C)는 이번 범위가 아니다(D1, 부록 A).
- 링크를 받은 사람은 **보기만** 한다. GPX 다운로드·편집·소유자 원장 쓰기·자기 코스로 복사가 없다(D5, D8).
- 활동(실제 기록 track)·사진·기록·심박 등 코스 밖 데이터는 공유하지 않는다. 공유 대상은 **코스 revision 하나**다.
- 실시간 위치 공유·내비게이션은 계획 `:104`대로 범위 밖이다.
- 이미 넘겨준 사본(소유자가 내보낸 GPX 파일, 받은 사람의 스크린샷)은 회수할 수 없다. 철회는 **서버가 더 이상 내주지 않는
  것**까지다. 확인 화면이 이 사실을 말한다(§5).
- 계정 export(데이터 이동권 산출물)는 공유가 아니며 확인 gate 밖이다(D4). 계정 export는 코스 기하를 싣지 않는다
  (`operations.ts:167-172`). 계획 `:188` "개인 export와 공유용 산출물을 혼동하지 않는다"를 유지한다.

## 2. 공유 범위 — A + B

**사용자 결정(2026-09-25, D1):** A는 항상 만든다. B는 기본값 꺼짐 flag 뒤에 두고 **독립 재식별 검토가 통과한 뒤에만** 켠다.
C는 미룬다(비교와 기각 사유는 부록 A).

### 공개되는 것

| 항목                                     | 현재 GPX export                     | A. 확인 뒤 소유자 GPX                                                                                                                                 | B. 보기 전용 unlisted link                                                                           |
| ---------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 받는 사람                                | 소유자 본인                         | 소유자 본인(이후 소유자가 파일을 전달할 수 있음)                                                                                                      | 링크를 가진 누구나(로그인 불필요), **화면 보기만**                                                   |
| 정확한 시작·끝                           | 그대로                              | 끝이 보호 구역 안이면 기본은 제거본. 경고 뒤 소유자가 **정확한 선**을 고를 수 있다(이 export에만, D3b). 선이 어느 구역과도 닿지 않으면 확인 뒤 그대로 | 끝이 구역 안이면 **항상 제거본**. 정확한 선 선택지 없음(D3b). 선이 구역과 닿지 않으면 확인 뒤 그대로 |
| 보호 구역 없음                           | 그대로 나감                         | **경고 뒤 확인하면 허용**("보호 구역이 없어 정확한 시작·끝이 포함됩니다", D3a)                                                                        | **링크 불가**(D3c): 공유 버튼 대신 "보호 구역을 먼저 추가하세요" + 구역 추가 바로가기                |
| trim 거절(재진입·선이 구역 통과)         | 그대로 나감                         | **차단**(D3)                                                                                                                                          | **차단**(D3)                                                                                         |
| 전체 선                                  | 전부(7자리)                         | 확인된 revision 전부. 좌표 소수 5자리(정확한 선 `owner-exact`만 7자리 유지, R-2)                                                                      | **공유용 확장 원**(§3, B-1)으로 자른 불변 스냅샷, 소수 5자리(R-2)                                    |
| 시각                                     | `metadata/time`=revision 생성 시각  | **없음**(§6 R3, 발견 (b))                                                                                                                             | 없음. 보는 사람에게 만료 **날짜**만                                                                  |
| 활동 연결(`activityId`·`lineage`·sample) | 없음                                | 없음                                                                                                                                                  | 없음. 공유 읽기 모델은 **allowlist**(§3)                                                             |
| 코스 id·revision                         | `metadata/desc`에 노출(`gpx.ts:67`) | **없음**(발견 (b))                                                                                                                                    | 없음. 링크마다 독립 opaque token                                                                     |
| 소유자 신원                              | 해당 없음                           | 파일에 없음                                                                                                                                           | 없음(이름·athlete id·이메일 없음)                                                                    |
| 코스 이름·waypoint 이름                  | 포함                                | **기본 포함**, 확인 화면에서 끌 수 있음(D6)                                                                                                           | **기본 제외**, 확인 화면에서 켤 수 있음(D6)                                                          |
| 고도 profile                             | 없음                                | 없음                                                                                                                                                  | 없음(§6 R4)                                                                                          |
| 철회                                     | 불가(파일)                          | 불가(파일)                                                                                                                                            | 가능(서버가 내주기를 멈춤), 만료 기본 7일·최대 30일(D2)                                              |

### A. 확인 뒤 소유자 GPX export

- 지금의 `export.gpx`에 확인 gate를 넣는다. 서버는 유효한 확인 receipt(§5) 없이는 GPX를 내주지 않는다. **이것은 현재 동작의
  변경**이다: 지금은 head를 확인 없이 내보낸다(`course-routes.ts:871-903`). 보호 구역이 없는 소유자도 경고와 확인을 거치면
  내보낼 수 있다(D3a). 기존 E2E `course-acceptance.spec.ts` step 6/8(GPX export)은 확인 화면을 한 번 거치도록 고치면 계속 동작한다.
- 끝이 보호 구역 안인 코스는 기본으로 제거본을 내보내지만, 소유자는 경고 뒤 **정확한 선**을 고를 수 있다. 이 선택은 소유자 자신의
  GPX export에만 있고 링크 공유에는 없다(D3b).
- GPX 본문은 `metadata/desc`·`metadata/time`을 쓰지 않는다(발견 (b)). 코스 이름·waypoint 이름은 **기본 포함**이며 확인 화면에서 끌 수 있다(D6).

### B. 보기 전용 unlisted capability link

- 소유자가 **확인된 revision**에 대해 링크를 만든다(D3 고정). 링크는 추측 불가 token(256비트 CSPRNG, base64url)이며 보기 전용이고
  만료가 있다. 받는 사람은 로그인 없이 공유 보기 화면에서 선을 본다. GPX 다운로드는 없다(D5).
- **D5에 대한 사양 확인:** 사양은 받는 사람의 다운로드를 요구하지 않는다. `01_product_screen_spec.md:163`의 "GPX import/export"는
  S14 편집 화면(소유자)의 기능이고, `:165`는 공유 전에 trim/확인 화면을 요구할 뿐 공유의 형태를 정하지 않는다. 그래서 보기 전용이
  사양과 충돌하지 않는다.
- 대가: **이 제품 최초의 비인증 데이터 응답**이 된다(현재 인증 밖은 `/health`·로그인·callback뿐, `app.ts:199-228`). token이 곧
  자격이므로 유출(메신저 미리보기 봇, 브라우저 기록, 프록시 로그, 화면 공유)이 곧 노출이다. 비인증 경로에 rate limit·enumeration
  방지·캐시 금지를 새로 세운다(§3). 보기 전용이어도 화면의 좌표는 받는 사람이 기록할 수 있다 — 보기 전용은 공개를 줄이지만
  없애지 않는다.

## 3. 접근 제어 모델

공통 원칙:

- 공유 **관리**(만들기·목록·철회)는 소유자 전용이며 기존 인증 라우트 규칙을 그대로 따른다: 소유자는 세션에서 도출, CSRF, body
  한도, 멱등 키, `expectedRevision` CAS. 다른 tenant의 코스·공유 id는 **404**(존재 여부를 말하지 않음).
- 공유 **읽기 모델은 allowlist 스키마**(`strictObject`)다: 선 좌표, (켰을 때만, 기본 꺼짐) 코스 이름·waypoint 이름, 거리, 만료 날짜. `courseId`,
  `revisionId`, `createdAt`, `generation`(trim 통계·`zoneSetDigest` 포함), `lineage`, `activityId`, `sourceSampleId`, thumbnail key,
  소유자 식별자는 **스키마에 없다**. 코스 읽기 스키마를 재사용하지 않는다.
  waypoint 필드는 `role`·`position`·(켰을 때만) `name`뿐이다. trim 여부·`exposure`·제거 거리·적용 구역 수 등 **잘렸다는 사실을
  알려 주는 필드와 보기 화면 문구가 없다**(잘렸다는 사실이 곧 '끝 근처에 보호 장소가 있다'는 단서다). 만료는 날짜(또는 남은
  일수)만이며 시각이 없다. (B-3)
- **사용자 결정(D3):** 공유는 확인된 revision에 **고정**된다. 코스를 편집해도 받는 사람이 보는 것은 바뀌지 않는다. 새 판을 공유하려면
  새 확인과 새 링크가 필요하다.
- 기능 flag(서버 설정, **기본 off**, D1): off면 공유 관리 라우트가 등록되지 않고(선례: `services.walkingRoutes` 조건부 등록,
  `course-routes.ts:975`), 화면에 공유 control이 없으며, 읽기 라우트는 모든 입력에 404를 준다. 이미 만든 링크도 off가 되면 즉시
  404다(kill switch). **A는 flag와 무관하게 항상 켜져 있다.**
- **사용자 결정(D3c):** 링크 공유에는 보호 구역이 1개 이상 있어야 한다. 구역이 0개면 링크 생성은 409이고, 화면의 공유 버튼 자리에
  "보호 구역을 먼저 추가하세요"와 구역 추가 바로가기를 둔다. 소유자 GPX는 D3a대로 경고 뒤 허용한다.

### A — 소유자 GPX

| 항목          | 요구                                                                                                                                                                                                                                |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 누가 읽나     | 소유자 본인(기존 인증)                                                                                                                                                                                                              |
| 인가          | 기존 RLS + 새 조건: 요청이 이 revision·현재 구역 집합에 대한 유효한 확인 receipt를 가리켜야 한다. 없거나 stale이면 **409 `COURSE_EXPORT_NOT_CONFIRMED`**, trim 거절이면 **409 `COURSE_EXPORT_BLOCKED`**(소유자에게는 이유를 말한다) |
| 비인가 사용자 | 타 tenant: 기존대로 404                                                                                                                                                                                                             |
| rate limit    | 기존 인증 라우트 한도                                                                                                                                                                                                               |
| enumeration   | 해당 없음(소유자 전용)                                                                                                                                                                                                              |

### B — 보기 전용 capability link

| 항목        | 요구                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| token       | 256비트 CSPRNG, base64url. **서버는 SHA-256 digest만 저장**한다(평문 token은 만들 때 응답 한 번만). digest는 unique index로 조회하므로 prefix 비교 타이밍이 생기지 않는다                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| URL 모양    | `/<shell>/shared/course#<token>` — token은 **fragment**에 둔다. fragment는 HTTP 요청·Referer·서버/프록시 access log에 실리지 않는다. 보기 화면의 JS가 fragment를 읽어 **POST body**로 읽기 API에 보낸다(요청 줄에 싣지 않는다는 장소 검색 선례, `course-extras-routes.ts:322-331`). 읽은 뒤 `history.replaceState`로 fragment를 지운다                                                                                                                                                                                                                                                                               |
| 누가 읽나   | token을 가진 누구나. 로그인 불필요. 로그인했더라도 세션을 쓰지 않는다(세션 쿠키·session header를 이 라우트는 읽지 않음)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 무엇을 받나 | allowlist 읽기 모델(JSON)만. **GPX·다운로드 라우트가 없다**(D5). 보기 화면에 다운로드 control이 없다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 공유 trim   | 링크의 선은 소유자 구역이 아니라 **공유용 확장 원**으로 계산한다. 구역마다 S = max(r, 200 m), 반지름 R_eff = 1.5·S, 중심 = 구역 중심 + δ. δ는 반지름 0.5·S 원판에서 균일하게 뽑아 구역 생성 시 한 번 저장하는 **서버 전용 비밀**이다(링크마다 다시 뽑지 않음; 어떤 응답·로그에도 없음; 구역 삭제·말소와 함께 삭제). 경우 판정(구역과 닿지 않음·양 끝·재진입·선 통과)도 확장 원 기준이다. 공유 선은 불변 스냅샷으로 저장하고 원 revision에 FK `ON DELETE CASCADE`로 묶는다 (B-1)                                                                                                                                      |
| 유효 조건   | 모두 참일 때만 200: flag on ∧ digest 일치 ∧ state=active ∧ `now < expires_at`(DB 시각) ∧ 공유의 epoch = 현재 share epoch(§4) ∧ 코스 존재·available ∧ 고정 revision 존재 ∧ 소유자 tenant 미말소                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 비인가 응답 | 위 조건 중 하나라도 거짓이면 **같은 404 본문**(`{error:{code:'NOT_FOUND'}}`, 기존 notFound handler와 같은 모양 `app.ts:191-193`). 만료·철회·삭제·말소·epoch 불일치·형식 오류를 구별하지 않는다(형식 오류도 400이 아니라 404)                                                                                                                                                                                                                                                                                                                                                                                         |
| rate limit  | **기본값(권고안 채택, D7):** client 주소는 설정된 신뢰 프록시 hop/주소 allowlist로만 `X-Forwarded-For`에서 도출하고(설정 없으면 socket 주소), 신뢰하지 않은 출처의 헤더는 무시한다. 카운터 키는 IP의 keyed HMAC이며 창이 지나면 지운다(보존 ≤ 2시간). IP·HMAC은 로그에 싣지 않는다. (B-4) 한도: client당 분당 30, 공유당 분당 60(**읽기가 공유에 맞았을 때만** 세고 키는 share id — 없는 digest마다 행을 만들지 않는다, R-5), 실패(404) client당 시간당 100 — 넘으면 그 창 동안 전부 404. 여러 API 인스턴스가 공유하도록 PostgreSQL 카운터(선례: routing admission `047_routing_admission.sql`, 단 그쪽은 tenant 키) |
| enumeration | 목록·검색 라우트 없음. 공유 id·코스 id가 URL·응답에 없음. token 공간 2^256. 404는 본문·헤더·상태가 같고, 존재하는 digest 여부에 따라 DB 작업량이 달라지지 않게 한 번의 index 조회로 끝낸다(타이밍: **없는 token과 형식 오류 token만** 서로 구별되지 않으면 된다. 만료·철회된 token과의 차이는 그 token을 이미 가진 사람만 관찰할 수 있어 허용한다, R8 조건)                                                                                                                                                                                                                                                          |
| 한도        | **기본값(권고안 채택, D2):** 만료 기본 7일, 최대 30일(생성 요청에 필수, 최대 초과는 400). active 링크는 소유자당 20, 코스당 5(초과는 409)                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 응답 헤더   | `cache-control: no-store, private`(전역 `app.ts:179-182`에 더해 명시), `referrer-policy: no-referrer`, `x-robots-tag: noindex, nofollow, noarchive`, `x-content-type-options: nosniff`. 보기 화면 HTML에도 `<meta name="robots" content="noindex">`와 같은 referrer 정책                                                                                                                                                                                                                                                                                                                                             |
| 보기 화면   | "코스 보기"를 누르기 전에는 fragment를 읽지 않고 API·tile·지도 chunk를 하나도 불러오지 않는다(메신저 미리보기 봇이 링크를 열어도 아무것도 받지 않는다). OG 태그는 모든 링크에 같은 정적·일반 문구이며 `og:image`가 없다. 외부 링크는 ODbL 저작자 표시 하나뿐(R7) (R-4)                                                                                                                                                                                                                                                                                                                                               |

## 4. 철회

| 사건                           | 요구                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 시험                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 명시 철회                      | 소유자가 철회하면 같은 트랜잭션에서 state=revoked. 그 뒤 첫 요청부터 404. 철회는 되돌릴 수 없다(다시 공유하려면 새 확인·새 token). 감사 사실(공유 생성·철회 시각, 코스 id)은 운영 로그와 분리된 표에 남기되 token·digest·좌표는 넣지 않는다(`030` 감사 표 선례). 소유자 화면에 **"모든 링크 끄기"** control을 두어 active 링크를 한 번에 철회한다(R-6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | T5                                                               |
| 만료                           | `expires_at`은 생성 시 필수(기본 7일, 최대 30일). 비교는 DB 시각. 만료된 행은 bounded reaper가 지운다(지우기 전에도 읽기는 404)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | T4                                                               |
| 코스 삭제                      | `delete_course`(`034:242-260`)가 revision·head를 지울 때 공유 행도 같이 사라진다(FK `ON DELETE CASCADE` to `course_revision`). 활동 삭제로 코스가 `unavailable`이 되며 revision이 지워지는 경로(`034:163-188`)도 같은 cascade로 공유를 회수한다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | T6                                                               |
| 코스 편집                      | 공유는 고정 revision을 계속 보인다(D3). 편집은 공유를 바꾸지도 철회하지도 않는다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | T15                                                              |
| 보호 구역 추가                 | 공유 스냅샷이 새 구역의 공유용 확장 원과 닿는지 (B-6) 서버가 같은 트랜잭션에서 다시 검사하고, 닿으면 그 공유를 자동 철회한다(구역이 늘었는데 옛 공유가 새 구역을 계속 보여 주는 것을 막는다). 기존 receipt는 구역 집합 digest가 달라져 GPX export에 쓸 수 없다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | T7                                                               |
| 보호 구역 삭제·재생성          | 구역을 지우면 δ도 지워지고 그 구역과 닿던 공유 스냅샷의 근거가 사라지므로 그 구역을 쓰던 공유를 철회한다. 삭제 화면은 "같은 곳에 구역을 다시 만들면 공유용 오프셋이 바뀝니다. 두 오프셋의 공유를 모으면 범위가 좁혀질 수 있습니다."라고 경고한다 (R-7)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | T7                                                               |
| 구역 이동·크기·이름 변경(미래) | 지금은 경로가 없다(`privacy-trim.ts:60-65`). 앞으로 생기면 그 변경은 그 구역의 모든 공유와 receipt를 철회한다 (R-8)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 경로가 생길 때 시험 추가                                         |
| 계정 말소                      | `erase_account` 체인에 공유·receipt 회수 링크를 추가(`037:61-91` 방식). tenant prefix purge(M2-01x)와 독립적으로 행 기반 회수가 일어난다. 공유 감사 표도 같은 `erase_account` 체인에 넣어 지운다(R-6). 구역의 δ는 구역과 함께 지운다(B-1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | T6                                                               |
| flag off                       | 모든 링크 즉시 404(행은 유지; 다시 켜면 만료·철회 규칙대로)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | T9                                                               |
| **백업 복원(drill check)**     | **기본값(권고안 채택, D7): epoch 무효화.** 복원된 DB에는 백업 시점의 active 공유 행이 있다. 복원 절차는 runtime 접근 **전에** DB 밖 설정에 둔 share epoch를 올린다. 공유 행은 생성 시 epoch를 저장하고, 불일치면 404다. 그래서 복원 전에 만든 **모든** 링크가 무효가 된다 — 백업 뒤에 철회·만료·코스 삭제·말소된 공유도 여기에 포함되므로 원장 재생 없이 fail-closed다. 소유자에게는 "복원으로 링크가 무효화됨"을 알리고 새 확인·새 링크를 요구한다. drill check 세 개: `revoked_share_not_served_after_restore`, `erased_tenant_share_not_served_after_restore`, `deleted_course_share_not_served_after_restore`(각각 복원 cluster에 행이 active로 남아 있음을 먼저 보이고, 그래도 404임을 단언). flag on인데 share epoch 설정이 없으면 API는 시작을 거부한다(기본값 없음). DB에 현재 설정보다 큰 epoch의 공유 행이 있으면(설정이 되돌려짐) 공유 읽기를 전부 404로 둔다. 복원 runbook은 PITR·호스팅 snapshot 복원을 포함한 모든 복원 경로에서 epoch 증가를 요구한다. (B-5) | T10                                                              |
| 캐시·CDN                       | 읽기 응답은 `no-store, private`. 읽기는 POST(기본적으로 공유 캐시 불가). 배포에 CDN·reverse proxy가 있다면 `/bff/v1/shared/*`를 캐시 우회로 명시하고, 철회 후 CDN을 거친 요청이 404임을 운영 probe로 확인한다. 보기 화면 HTML·JS는 데이터가 없는 정적 자산이라 캐시돼도 된다. service worker가 생긴다면 이 경로를 캐시하지 않는다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | T11 헤더 단언. 운영 probe는 CDN이 없으면 `not_executed`로 남긴다 |
| 계정 export                    | 확인 gate 밖(D4). export에 공유 행을 넣는다면 **token·digest 없이** 사실(코스 id, revision, 생성·만료·철회 시각, 상태)만. export에서 복원할 때 공유는 **되살리지 않는다**. 구역의 δ는 export에 포함한다(되살릴 수 없는 서버 입력이며, 복원 뒤 같은 확장 원을 유지하기 위해, R-7). export 버전은 v23로 올리고 구버전 호환 규칙(`operations.ts:245`)을 따른다                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | T13                                                              |

### 발견 (a) — 백업 뒤 삭제한 코스가 복원으로 되살아난다(별도 노드로 보고)

백업 복원 drill은 백업 **뒤**의 말소(`tenant_erasure`)와 활동 삭제를 DB 밖 원장으로 캡처해 복원 뒤 재생한다
(`backup-restore-drill.mts:518-524,2702-2768`). 소유자가 백업 뒤 **코스만** 삭제한 경우(`delete_course`, `034:242-260`, 물리 삭제)를
캡처·재생하는 원장은 drill에서 찾지 못했다(`delete_course`·`courses.remove` grep 0건). 그래서 그 코스는 복원 뒤 소유자 목록에
다시 나타난다(추론. drill로 재현하지는 않았다). share epoch는 **공유만** 막는다: 되살아난 코스의 옛 링크는 epoch 불일치로 404지만,
코스 자체(좌표 포함)는 소유자에게 되살아난다. 이것은 공유와 무관한 일반 gap이며, 계획 7절 "restore 후 suppression을 재적용한다"에
걸린다. **root에게 별도 gap 노드로 제안한다**(범위 예: 코스 삭제 원장 캡처·복원 재생, drill의 dump와 archive 사이 틈 포함, 과잉 삭제
금지). M2-01k-o는 이 gap을 닫지 않으며, 완료 조건도 이 gap에 기대지 않는다.

## 5. privacy trim 확인 흐름

### 흐름

1. 소유자가 "GPX 내보내기" 또는 (flag on일 때) "링크로 공유"를 누른다. 둘 다 **같은 확인 화면**으로 간다(내보내기가 확인을
   우회하지 않는다).
2. 서버가 현재 head와 소유자의 보호 구역으로 판정을 계산한다(`trimCourseForPrivacy`를 저장하지 않고 미리보기로 실행). **사용자
   결정(D3, D3a, D3b)**에 따라 경우는 넷이다:

   | 경우                                                                  | A. 소유자 GPX                                                                                                                                                                                                | B. 링크 공유                                                                                                       |
   | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
   | 보호 구역 없음                                                        | 경고 뒤 확인 가능: "보호 구역이 없어 정확한 시작·끝이 포함됩니다." 명시 체크 필요 + 보호 구역 추가 바로가기. 대상은 현재 revision(D3a)                                                                       | **링크 불가**(D3c). 공유 버튼 대신 "보호 구역을 먼저 추가하세요" + 구역 추가 바로가기                              |
   | trim 거절(`SPLITS_THE_LINE`·`LINE_CROSSES_AREA`·`REMOVES_EVERYTHING`) | **차단.** 이유를 기존 문구(`course-extras.tsx:88-100`)로 말하고 "보호 구역을 지나지 않게 코스를 고치세요"를 안내                                                                                             | **차단**(같음)                                                                                                     |
   | 선이 어느 구역과도 닿지 않음(`CHANGES_NOTHING`)                       | 확인 가능. "이 코스는 보호 구역을 지나지 않습니다. 시작·끝이 그대로 나갑니다." — 대상은 현재 revision                                                                                                        | 확인 가능. 판정은 **확장 원 기준**(B-1) — 소유자 구역과 닿지 않아도 확장 원과 닿으면 아래 줄의 규칙을 따른다       |
   | 양 끝만 구역 안                                                       | 기본 선택은 **제거본**(trim revision을 덧붙이고 그것이 대상). 경고("보호 구역 안의 좌표가 파일에 포함됩니다. 이 파일은 철회할 수 없습니다.")와 명시 체크 뒤 **정확한 선**(현재 revision)도 고를 수 있다(D3b) | **제거본만(확장 원 기준).** 정확한 선 선택지가 화면에 없고, 서버도 정확한 선 receipt로는 링크를 만들지 않는다(D3b) |

   이 표는 사용자 결정(2026-09-25, D3a·D3b)을 그대로 옮긴 것이다. 첫째 줄과 넷째 줄 A의 정확한 선은 이전 초안의 "차단"·"제거본만"을 대체한다. 첫째 줄 B는 D3c(재식별 검토 뒤 사용자 결정)다.

   A의 기본 선택(제거본)은 소유자 **원 구역** 기준으로 자른다(R-1 불채택, D10). 이 확인은 소유자 코스의 head에 trim revision을
   **덧붙인다**(원 revision은 그대로 남는다). 확인 화면이 이 사실을 말한다(R-10). B의 확장 원 스냅샷은 소유자 원장에 revision을
   만들지 않는다(B-1).

3. 소유자가 공개 항목을 고른다: 코스 이름, waypoint 이름 — A는 **기본 켜짐**, B는 **기본 꺼짐**(D6). B라면 만료(기본 7일, 최대 30일).
4. 서버가 **확인 receipt**를 기록한다: `(courseId, revisionId, zoneSetDigest, purpose(export|share), exposure(trimmed|no-zone-intersection|no-zones-exact|owner-exact), 공개 항목, confirmedAt)`. GPX export와 공유 생성은
   receipt를 요구하고, 트랜잭션 안에서 receipt의 revision·digest가 현재와 같은지 다시 본다(trim의 이중 검사 선례
   `course-routes.ts:785-830`). 다르면 409 stale → 확인 화면으로 돌아간다. trim 거절(표 둘째 줄)에는 receipt가 만들어지지 않는다. `exposure=owner-exact` receipt는 `purpose=export`로만 만들어지고, 링크 생성은 이 receipt를 거절한다(409).

### 확인 화면이 정확히 설명할 것

화면은 지도와 목록을 함께 쓴다(지도만으로 정보를 전달하지 않는다). 항목:

1. **무엇이 나가는가:** "선 전체(정점 N개, 약 X km)" + 공개 항목과 그 기본값(GPX는 이름 포함, 링크는 이름 제외)을 말하는 문장.
2. **시작·끝:** 나갈 시작점·끝점을 지도와 목록에 표시하고, 제거본이면 원래 끝에서 몇 m 떨어졌는지.
   - 보호 구역이 없으면(GPX만): "보호 구역이 없어 정확한 시작·끝이 포함됩니다." — 체크하지 않으면 진행 버튼이 비활성(D3a). 링크는
     "보호 구역을 먼저 추가하세요"(D3c).
   - GPX에서 정확한 선을 고르면: "보호 구역 안의 좌표가 파일에 포함됩니다. 이 파일은 철회할 수 없습니다." — 체크 필요(D3b).
   - 링크 공유에서는 끝이 구역 안이면 "링크는 항상 보호 구역을 제거한 선을 보여 줍니다."를 보이고 정확한 선 선택지를 두지 않는다.
3. **보호 구역과의 관계:** 적용된 구역 수와 이름(소유자에게만 보이는 화면), 각 구역에서 제거된 정점 수. 구역 **중심 좌표는
   나가지 않는다**는 문장.
4. **남는 위험(정직한 한계):** "보호 구역 가장자리에서 선이 시작됩니다. 같은 곳에서 출발한 코스를 여러 번 공유하면 구역 중심을
   추정할 수 있습니다." "반복해서 달리는 경로는 시작·끝을 지워도 동네를 드러낼 수 있습니다." GPX 제거본에는 추가로 "내보낸 제거본 파일 3개 이상이면 집 위치를 몇 m 안으로 계산할 수 있습니다." (D10, R-1 불채택)
5. **나가지 않는 것:** 시각, 활동 연결, 코스 id, 기기 정보, 소유자 이름·계정.
6. **철회 한계:** GPX는 "내보낸 파일은 철회할 수 없습니다." 링크는 "링크는 언제든 끌 수 있고 N일 뒤 만료되지만, 받은 사람이 이미
   본 화면을 기록했다면 되돌릴 수 없습니다. 받은 사람은 파일을 받을 수 없습니다. 브라우저 기록에 링크가 남을 수 있습니다." (R-9)
7. **고정:** 링크는 "지금 확인한 판을 보여 줍니다. 코스를 고쳐도 링크의 내용은 바뀌지 않습니다."

### 불변식

- 확인 receipt 없이는 공유 읽기 응답도 GPX 본문도 나가지 않는다. **서버가 강제**한다(화면의 버튼 비활성만으로는 부족하다).
- trim이 거절되는 코스에는 receipt가 만들어지지 않는다.
- **공유 링크로 나가는** 모든 정점과 waypoint는 모든 공유용 확장 원(§3 공유 trim) 밖이고, 모든 선분이 확장 원과 닿지 않는다. 예외 없음(D3b, B-1). 좌표 반올림 뒤에도 성립한다(T25).
- 소유자 GPX가 구역 안 좌표를 싣는 것은 `exposure=owner-exact` receipt가 있을 때뿐이다. 구역이 없는 코스의 정확한 시작·끝은
  `exposure=no-zones-exact` receipt가 있을 때뿐이며, 이 receipt는 `purpose=export`로만 만들어진다(D3c).
- receipt는 revision·구역 집합에 묶여 있어 구역을 추가하면 기존 receipt로는 export·공유가 안 된다.
- 내보낸 GPX에는 `metadata/desc`·`metadata/time`이 없다(발견 (b)).

## 6. 재식별 검토 항목 — 독립 검토가 답할 질문

각 항목은 **위험 → 제안 완화 → 시험 방법 → 검토자가 답할 질문**이다. 검토자는 구현자가 아니어야 하며, 합성 데이터만 쓴다
(개인 FIT/GPS 금지, AGENTS.md). 검토 결과는 항목마다 `충분 / 조건부 / 불충분`과 근거로 남긴다. 한 항목이라도 `불충분`이면 B는
flag off로 남는다(A는 영향받지 않지만, A에 해당하는 완화 — R2 정밀도, R3·R5·R6 메타데이터 — 는 검토 결과를 따른다).

**검토 결과(2026-09-25, 대상 sha256 `5ac5e7d4…`):** 이 규칙에 따라 B는 **B-1~~B-8이 구현되고 T22~~T25가 통과하면** flag 뒤에서
출하할 수 있다. A의 차단 항목은 A-1이다. 반영 내역은 부록 B.

### R1. 시작·끝과 반복 경로에서 집·직장 추론

- 위험: trim은 구역 **밖 첫 정점**에서 선을 자른다(`privacy-trim.ts:143-150`). 따라서 새 시작점은 구역 원 둘레 바로 밖에 놓인다.
  같은 집에서 방향을 달리한 코스 3개 이상을 공유하면 끝점들이 한 원 위에 놓여 **원의 중심 = 집**을 계산할 수 있다(잘 알려진
  privacy zone 삼각측량). 최소 반경 50 m(`courses.ts:56`)는 주택 단위를 가리기에 작을 수 있다. 구역이 없으면 경고 뒤 시작·끝이 그대로 나간다 — 소유자 GPX에만 해당하고(D3a), 링크 공유는 구역이 없으면 만들 수 없다(D3c).
- 완화 후보: (a) 공유·export용 trim은 구역 반경에 **구역마다 고정된 비밀 난수 여유**(예: 반경의 0–50%)를 더해 자른다 — 링크마다
  다른 난수는 반복 공유로 평균이 새므로 쓰지 않는다. (b) 구역을 만들 때 최소 반경을 더 크게(예: 200 m) 권고. (c) 끝점을 가장
  가까운 교차로·공공 지점으로 snap.
- 시험: 합성 집 좌표 하나와 방향이 다른 합성 코스 N개(3, 5, 10)로 공유본을 만들고, 최소제곱 원 맞춤으로 중심을 추정해 오차
  분포를 잰다. 완화 전·후 비교.
- 검토 결과(채택): 링크는 (a)를 구체화한 **공유용 확장 원**을 쓴다 — S = max(r, 200 m), R_eff = 1.5·S, 중심 + δ(반지름 0.5·S 원판에서
  균일, 구역당 한 번, 서버 전용 비밀). 규범은 §3 "공유 trim"(B-1), 시험은 T22. 구역 없는 링크 공유는 불가(D3c).
- 소유자 GPX 제거본은 확장 원을 쓰지 않고 원 구역으로 자른다(R-1 불채택, D10). **받아들인 잔여 위험:** 소유자가 GPX 제거본을
  전달하면, 받은 파일들의 끝점으로 원 구역 중심을 추정할 수 있고, 이는 링크의 오프셋(δ)이 주는 보호를 되돌린다. 확인 화면이
  GPX에 대해 이를 고지한다(§5 항목 4).
- 근거 — 검토자의 시뮬레이션 표(**합성 데이터**; 개인 위치를 쓰지 않은 합성 구역·합성 코스의 원 맞춤 결과):

  평면 모형, 집은 원점, 무작위 구불구불한 코스(정점 간격 3 m; 20 m도 같은 양상), 구역을 처음 벗어나는 정점에서 자름(현재 trim
  규칙), 공유 N개의 끝점에 최소제곱 원 맞춤. 값은 추정 중심 오차의 중앙값이고 괄호는 90백분위다(검토 기록에 있는 칸만).

  | 설정(정점 간격 3 m)          | 공유 1개                   | N=3               | N=5    | N=10   |
  | ---------------------------- | -------------------------- | ----------------- | ------ | ------ |
  | r=50 m, 완화 없음            | ≈51 m (집은 시작점에서 ≈r) | 2–3 m (p90 18–27) | 1 m    | 1 m    |
  | r=200 m, 오프셋 없음         | ≈201 m                     | 2 m (p90 13)      | 1 m    | 1 m    |
  | 공유 원, 비밀 오프셋 ≤ 100 m | –                          | ≈70 m (p90 ≈96)   | ≈75 m  | ≈70 m  |
  | 공유 원, 비밀 오프셋 ≤ 200 m | –                          | ≈145 m            | ≈145 m | ≈145 m |

  반지름만 키우면 삼각측량을 막지 못하고, 구역마다 고정한 비밀 오프셋은 공유 수가 늘어도 줄지 않는 오차 하한을 만든다. 링크마다
  새로 뽑는 무작위는 링크가 쌓이면 평균으로 사라지므로 쓰지 않는다. 시뮬레이션 script는 검토자의 scratchpad에 있고 저장소에
  넣지 않았다.

### R2. 잘렸지만 특이한 모양

- 위험: 양 끝 수백 m를 잘라도 나머지 선이 특이하면(드문 공원 한 바퀴, 특정 단지 둘레) 동네가 드러난다. 좌표 7자리(약 1 cm,
  `gpx.ts:24`)는 필요 이상의 정밀도다.
- 완화(요구로 채택, R-2): 공유 응답과 GPX(정확한 선 `owner-exact` 제외)의 좌표를 5자리(약 1 m)로 반올림하고, 반올림 **뒤에**
  구역·확장 원 조건을 다시 검사한다(T25). 단순화(정점 간격 하한)는 검토 질문으로 남긴다. 확인 화면의 한계 문구(§5 항목 4).
- 시험: 반올림·단순화 전후 선의 최대 편차(m) 측정, 반올림 후에도 모든 정점·선분이 구역 밖인지 재검사(반올림이 구역 안으로
  밀어 넣을 수 있다).
- 질문: 모양 자체의 식별성은 기술로 막을 수 없는 잔여 위험으로 받아들이고 고지로 처리하는가? 정밀도는 몇 자리가 적절한가?

### R3. 시각

- 위험: GPX `metadata/time`은 revision `createdAt`(`gpx.ts:68`). 기록에서 잘라 만든 코스(`recorded-segment`)는 달린 직후에
  만들어지는 경우가 많아 **활동 시각의 근사치**가 된다(발견 (b)). 공유 생성 시각도 소유자의 생활 시간대를 드러낼 수 있다.
- 완화(요구로 채택): GPX·공유 읽기 모델에서 시각 제거. 보는 사람에게 만료는 날짜 단위로만.
- 시험: T8.
- 질문: 만료 날짜 표시만으로 생성 시각이 역산되는가(기본 7일이면 생성일 = 만료일 − 7)? 역산이 문제라면 날짜를 더 거칠게 할 것인가?

### R4. 고도 profile

- 위험: 공유 보기에서 DEM 고도(`course-extras-routes.ts:342-358`)를 보이면 고도 요청이 **소유자 권한 없이 서버 자원을 쓰는** 새
  비인증 경로가 된다. 식별 단서는 선으로 다시 계산 가능하므로 늘어나지 않는다고 본다.
- 완화(요구로 채택): 공유본에 고도를 넣지 않는다. 비인증 고도 라우트를 만들지 않는다.
- 시험: T8(읽기 모델에 고도 필드 부재), 비인증 라우트 목록에 고도 부재.
- 질문: 나중에 고도를 넣을 때 새로 생기는 식별성은 없다고 볼 수 있는가?

### R5. 여러 공유 사이의 연결

- 위험: 공유·파일 사이에 공통 식별자가 있으면 여러 링크·파일을 한 사람으로 묶을 수 있다. 후보: GPX `desc`의 `courseId`·revision
  (`gpx.ts:67`, 발견 (b)), trim `generation`의 `zoneSetDigest`·`appliedZoneCount`(`privacy-trim.ts:184-185`) — 같은 digest면 같은
  사람의 같은 구역 집합이다, 코스 이름, waypoint 이름, 파일 이름(`courseGpxFileName`, `gpx.ts:90-97`), 공유 URL의 규칙성.
- 완화(요구로 채택): 공유 읽기 모델·GPX에서 식별자 전부 제거(§3 allowlist), 이름은 링크에서 기본 제외, 소유자 GPX에서 기본 포함(D6).
  GPX 파일 이름(`Content-Disposition`)은 이름을 포함했을 때만 이름 기반, 아니면 `course.gpx`이며 어느 경우에도 revision 번호(현재 `courseGpxFileName`의 `-r<n>`)를 붙이지 않는다. (A-1) token은 링크마다 독립.
- 시험: 같은 소유자의 두 코스·두 링크의 응답·GPX를 비교해 공통 부분 문자열이 좌표·켠 이름 외에 없음을 단언. 응답에 UUID·hex
  digest 패턴이 없음을 단언(T8).
- 질문: 이름을 켰을 때의 연결 위험 고지는 충분한가? 소유자 GPX의 이름 기본 포함(D6)은 소유자가 파일을 전달할 때 문제가 되는가?

### R6. GPX 메타데이터(creator, 시각, 기기)

- 위험: `creator="workout-manager/course-v1"`(`courses.ts:891`)는 앱을 식별한다(사용자 수가 적으면 사람을 좁힌다). `metadata/desc`는
  코스 id·revision, `metadata/time`은 생성 시각을 싣는다(`gpx.ts:65-69`, 발견 (b)). 코스 GPX에는 현재 기기 정보·`trk`·점별 `time`이
  없다(`rte`만, `gpx.ts:10-23`) — 이 사실이 유지돼야 한다.
- 완화(요구로 채택): `metadata`는 이름을 포함할 때 `name`만(GPX 기본 포함), 아니면 `metadata` 없음. `desc`·`time`·`extensions` 금지. `creator`
  (`courseGpxCreator`)는 제품을 식별하지 않는 중립 값으로 바꾼다(`workout-manager`를 포함하지 않음, R-3).
- 시험: GPX를 XML로 파싱해 요소·속성 **allowlist** 대조(`gpx/metadata/name?`, `wpt[@lat,@lon]/(name?,type)`,
  `rte/(name?,rtept[@lat,@lon])`), 그 밖의 요소가 있으면 실패(T8).
- 질문: `creator` 값은 중립 값으로 바꿔야 하는가?

### R7. 지도 tile·referrer 누출

- 위험: 공유 보기 화면이 지도를 그리면 tile 요청의 z/x/y가 **보는 영역**을 서버·프록시 access log에 남긴다. basemap 자산은 자체
  origin이고 `referrer-policy: no-referrer`지만 배포 자산은 `public, max-age=604800, immutable`(`route.ts:72-77`)이라 CDN을 두면 CDN
  log에도 남는다. Referer로 공유 URL이 외부에 새는 경로(외부 링크, 외부 자원). token이 fragment에 있으면 Referer에 실리지 않는다.
- 완화: 보기 화면 전체 `Referrer-Policy: no-referrer`, 외부 origin 요청 0(M2-01k-d의 `page.route` 외부 요청 단언을 공유 화면에도),
  외부 링크는 ODbL 저작자 표시 링크 하나뿐이며 `rel="noreferrer noopener"`(또는 일반 텍스트). (B-8) tile 요청 log는 IP와 함께 남지 않게 하거나 보존 기간을 제한.
- 시험: T14.
- 질문: 자체 tile 서버·프록시의 access log에 남는 z/x/y+IP를 위험으로 볼 것인가, 보존 정책으로 충분한가?

### R8. 공유 token의 로그·기록(M2-01k-c2 의존)

- 위험: token이 API·web shell·프록시·브라우저 기록·오류 보고·감사 표에 남으면 로그 열람자가 공유를 연다.
- 완화: token은 fragment와 POST body에만. 소유자 client는 생성 응답의 평문 token을 어떤 저장소에도 지속하지 않는다(localStorage·
  sessionStorage·IndexedDB·지속 query cache, T24). 보기 화면에서 `replaceState` 전에 `location.href`를 수집하는 client 오류
  보고·분석은 없다(T24). API 요청 로그는 이미 꺼져 있고 serializer가 비어 있다(`app.ts:161,171-175`). 감사 표·
  운영 로그에는 token·digest를 넣지 않는다. 404 경로도 입력을 로그에 싣지 않는다.
- 시험: T11 — M2-01k-c2의 `createLogCapture`·`auditLogLines`·`valueProbes('token', …)`(`log-audit.ts:312,361,387`)와
  `coordinateProbes`(`log-audit.ts:349`). T11은 rate limit 초과 응답과 404 경로를 반드시 포함한다. 타이밍: **없는 token과 형식 오류 token**의 404 응답 시간 분포가 구별되지
  않음만 요구한다(만료·철회 token과의 차이는 허용).
- 질문: web shell(Next·Vite)과 앞단 프록시의 access log도 감사 대상에 포함했는가? (검토 조건 반영: 타이밍 요구는 없는 token·형식 오류 token 구별 불가로 완화.)

### R9. 공유 읽기 모델의 우회 누출

- 위험: 코스 읽기 스키마를 재사용하면 `generation`(제거 정점 수 = 구역 안에 있던 선 길이 단서), `lineage.activityId`,
  `sourceSampleId`, thumbnail이 딸려 나간다.
- 완화: 공유 전용 `strictObject` 스키마, 응답을 그 스키마로 `parse`.
- 시험: T8.
- 질문: allowlist에 더 뺄 것이 있는가?

## 7. 계획 문장 개정(M2-01t 방식)

M2-01t처럼 **사용자 결정 인용 → diff → 구현 대조 → 매트릭스 `amendments` 기록** 순서를 따른다. 개정은 이 요구가 승인되는 단계에서
root가 한다(root 병합 추가 (a)). 개정 뒤에도 B는 재식별 검토 통과 전까지 꺼져 있으므로, 개정 자체가 B의 제품 동작을 바꾸지 않는다.
A(export gate)는 구현이 착지할 때 동작이 바뀐다.

### 대상 1: `docs/implementation/map-implementation-plan.md:185-188`

```diff
-… 출발/끝뿐 아니라 보호 구역 재진입을 검사한다. 공개 공유는 별도 요구·ACL·재식별 검토 전까지
-비활성이다. 개인 export와 공개 공유용 산출물을 혼동하지 않는다.
+… 출발/끝뿐 아니라 보호 구역 재진입을 검사한다. 공개 발견(검색·목록)은 두지 않는다. 코스 공유는
+[M2-01k-o 요구](research/m2-01k-o-sharing-requirement.md)가 정한 만료·철회 가능한 보기 전용 unlisted 링크로만
+허용하며, 독립 재식별 검토가 통과하기 전까지 기본값 꺼짐이다. 공유와 GPX 내보내기는 privacy trim 확인을
+거친 revision만 내보내고, trim이 거절되는 코스는 내보내지도 공유하지도
+않는다. 보호 구역이 없으면 소유자 GPX만 경고와 확인 뒤에 정확한 시작·끝을 싣고 링크 공유는 보호 구역이 하나 이상 있어야 하며, 보호 구역 안 좌표는 소유자가 경고 뒤 고른
+자기 GPX에만 실리고 공유 링크로는 나가지 않는다. 공유와
+GPX는 시각·활동 연결·코스 식별자·소유자 신원을 싣지 않는다. 계정 export는 공유가 아니며 이 확인 밖이다.
+개인 export와 공유용 산출물을 혼동하지 않는다.
```

### 대상 2: `docs/implementation/map-implementation-plan.md:104` (기본값(권고안 채택), D9)

```diff
-… LLM·공개 공유·실시간 내비게이션은 포함하지 않는다.
+… LLM·공개 발견(검색·목록)·실시간 내비게이션은 포함하지 않는다.
```

코드 주석(`courses.ts:26-28`, `034_course_ledger.sql:10-11`, `course-routes.ts:578-581`, `course-api.ts:23`, `gpx.ts:55-56`)은 구현
단계에서 바뀌며 이 단계에서는 건드리지 않는다. 당시 기록인 progress 문서는 보존한다.

### 재판정

판정 규칙은 매트릭스 헤더와 같다: 이 노드에서 실행한 시험이 핵심을 단언하고, 기능이 없으면 실패함을 변이로 보인다.

- **P7-no-public-share**
  - quote를 개정 문장으로 바꾼다(M2-01t가 `S09-indoor-tab`에 한 것처럼).
  - 개정 직후(구현 전): 동작은 그대로다. 기존 증거 세 건(`course-extras.spec.ts:201-204`, `course-workbench.test.tsx:124`,
    `course-extras.test.tsx:1103`)이 "공유 없음"을 여전히 증명하므로 이 노드에서 **재실행해 통과하면** passed 유지, 재실행하지 못하면
    판정을 바꾸지 않는다.
  - 착지 후: passed 조건은 (1) flag off(기본)에서 공유 control 0개·읽기 라우트 404(기존 세 시험을 flag off로 유지, T9), (2) flag on에서
    목록·검색 라우트 부재, 비인증 404 균일성(T4), 받는 사람 다운로드 부재(T16), (3) 독립 재식별 검토 기록이 `불충분` 0. 검토가 없거나
    `불충분`이 있으면 flag on 증거로는 판정하지 않고 (1)만으로 passed를 유지하되 reason에 "공유 미출하"를 적는다.
- **P7-privacy-trim**
  - 문장("서버 응답·GPX·메타데이터도 함께 처리한다")의 범위가 확인 gate, 공유 읽기 응답, GPX 메타데이터로 넓어진다.
  - passed 조건에 추가: 공유 응답·GPX에 보호 좌표 0(T3), trim 거절 차단(T17), 공유에 정확한 선 선택지 부재(T20), 구역 없음 경고·확인(T21), GPX 메타데이터 allowlist와
    `desc`·`time` 부재(T8), 각 변이 실패. 현재 GPX가 `desc`·`time`을 싣는 것(발견 (b))은 "메타데이터도 함께 처리한다"에 비추어
    이미 약점이므로, 이 노드가 착지하면 새 증거로만 passed를 유지한다.
- **S14-privacy-share**(이 노드가 닫는 행): §8의 시험 전부가 실행·통과하고 변이가 모두 실패하면 partial → passed. B의 시험(T4·T5·
  T10·T11·T14 등)은 flag를 켠 시험 환경에서 실행한다. flag를 켠 출하는 재식별 검토 통과가 조건이며 행 판정과는 별개다.
- `amendments`에 `{node: "M2-01k-o", date, rows, decision(사용자 문장 인용), change, executed}`를 더한다. counts는 행 집계와 맞춘다.

## 8. 수용 시험과 변이

노드 완료 조건을 A+B와 §9의 결정에 맞춰 옮기고 root 병합 추가 (b)–(d)를 붙였다. E2E는 두 shell(Next·Vite)에서, 실제 OIDC fixture
로그인과 합성 코스·합성 보호 구역으로 돌린다. B의 시험은 시험 환경에서 flag를 켜고 돌리며, T9만 flag 기본값(off)을 쓴다. UI 확인은
AGENTS.md 순서(Aside → Chrome → Playwright)를 따르고 쓰지 못한 도구는 이유를 적는다.

### 시험

| #   | 종류                | 단언                                                                                                                                                                                                                                                                                                                                                                                                   | 대응                                             |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| T1  | E2E ×2 shell        | 확인 전: GPX 다운로드와 링크 생성이 막힌다(버튼이 확인 화면으로 가고, API 직접 호출도 409 `COURSE_EXPORT_NOT_CONFIRMED`). 네트워크에 GPX 본문·공유 token이 오지 않는다                                                                                                                                                                                                                                 | 확인 전 차단                                     |
| T2  | E2E ×2 shell        | 확인 화면이 보호 구역(수·이름), 시작·끝 노출 여부, 제거 거리, 남는 위험, 철회 한계, 고정, 이름 기본값(GPX 포함·링크 제외)을 설명한다(문구·지도 표시·목록 대안)                                                                                                                                                                                                                                         | 설명                                             |
| T3  | E2E ×2 shell        | 양 끝이 구역 안인 코스를 **기본 선택(제거본)**으로 확인하면 다운로드한 GPX의 모든 정점·waypoint가 소유자 구역 밖이고 모든 선분이 구역과 닿지 않는다(합성 구역 중심·반경으로 계산). 공유 응답·보기 화면은 확장 원 기준(같은 조건을 §3 공유 trim의 확장 원으로 계산, B-1)                                                                                                                                | 보호 좌표 없음                                   |
| T4  | 통합(실제 PG)       | 비인가 404: 없는 token, 형식 오류 token, 다른 코스의 token, 만료, 철회, epoch 불일치, flag off — 본문·상태가 같다. 타 tenant가 소유자 공유 관리 라우트에 접근하면 404                                                                                                                                                                                                                                  | ACL                                              |
| T5  | 통합                | 철회 직후 같은 token 404. 철회는 되돌릴 수 없다                                                                                                                                                                                                                                                                                                                                                        | 철회                                             |
| T6  | 통합                | 코스 삭제(`delete_course`), 활동 삭제로 인한 코스 회수, 계정 말소 각각 뒤 404, 공유·receipt 행 0                                                                                                                                                                                                                                                                                                       | 삭제·말소 회수                                   |
| T7  | 통합                | 보호 구역 추가 뒤 그 구역과 닿는 공유는 404, 기존 receipt로 GPX export 409                                                                                                                                                                                                                                                                                                                             | 확인 stale                                       |
| T8  | 통합                | 공유 읽기 응답 key 집합 = allowlist(고도·`generation`·`lineage`·id 없음). GPX XML 요소 allowlist, **`metadata/desc`·`metadata/time` 없음**, 본문에 courseId·UUID·hex digest·ISO 시각 없음(R3·R5·R6·R9, 발견 (b)). `Content-Disposition` 파일 이름에 revision 번호·courseId 없음(A-1). trim·exposure 표시 부재, 보기 화면 DOM에 '보호 구역' 문구 부재(B-3). GPX `creator`에 `workout-manager` 없음(R-3) | 메타데이터                                       |
| T9  | 통합 + E2E          | flag 설정이 없으면 공유 관리 라우트 미등록, 읽기 404, 화면에 공유 control 0(기존 세 시험 유지). A(export gate)는 flag와 무관하게 동작                                                                                                                                                                                                                                                                  | (b) 기본값 꺼짐                                  |
| T10 | drill               | `revoked_share_not_served_after_restore`, `erased_tenant_share_not_served_after_restore`, `deleted_course_share_not_served_after_restore` — 복원 cluster에 행이 active로 남아 있어도 epoch로 404                                                                                                                                                                                                       | (c)                                              |
| T11 | 통합(로그)          | c2 helper로 API·worker·web shell stream 보관, 확인·export·생성·읽기·철회·**404·rate limit 초과** 경로(둘 다 필수, R8 조건)에서 token 평문·digest·정확한 좌표 0, `reqId`·`version` 존재. 읽기 응답 헤더(`no-store, private` 등)                                                                                                                                                                         | (d)                                              |
| T12 | 통합                | rate limit: client 분당 30·공유당 분당 60·실패 client 시간당 100 경계(29/30/31 등), 두 API 인스턴스가 카운터 공유. 공유당 카운터는 맞은 읽기만 세고 share id로 키를 둔다 — 없는 digest 1,000개 요청 뒤 카운터 행 증가 0(R-5)                                                                                                                                                                           | enumeration 방지                                 |
| T13 | 통합                | 계정 export는 receipt 없이 동작(gate 밖), v23에 token·digest 없음, export 재import 뒤 활성 공유 0                                                                                                                                                                                                                                                                                                      | export                                           |
| T14 | E2E ×2 shell        | 공유 보기 화면: 외부 origin 요청 0, 모든 요청 URL·Referer에 token 없음, fragment가 읽은 뒤 제거됨, `noindex`. "코스 보기" 클릭 전 API·tile·지도 chunk 요청 0, OG 태그 정적·`og:image` 없음(R-4). 외부 링크는 ODbL 표시 하나이며 `noreferrer`(B-8)                                                                                                                                                      | R7                                               |
| T15 | 통합 + E2E          | 링크를 만든 뒤 소유자가 코스를 편집(이름 변경·재경로)해도 링크는 확인한 revision을 그대로 보인다                                                                                                                                                                                                                                                                                                       | 고정(D3)                                         |
| T16 | 통합 + E2E          | 받는 사람 쪽에 GPX·다운로드 라우트가 없고(비인증 라우트 목록 대조) 보기 화면에 다운로드 control이 없다                                                                                                                                                                                                                                                                                                 | 보기 전용(D5)                                    |
| T17 | 통합 + E2E          | `SPLITS_THE_LINE`, `LINE_CROSSES_AREA`, `REMOVES_EVERYTHING` 각각에서 확인 불가·GPX 409 `COURSE_EXPORT_BLOCKED`·링크 생성 409                                                                                                                                                                                                                                                                          | trim 거절 차단(D3)                               |
| T18 | 통합 + E2E          | 링크: 이름을 켜지 않으면 공유 응답·보기 화면에 코스 이름·waypoint 이름이 없고, 켜면 있다. 소유자 GPX: 끄지 않으면 GPX에 코스 이름·waypoint 이름이 **있고**(`metadata/name`·`rte/name`·`wpt/name`), 끄면 없다                                                                                                                                                                                           | 이름 기본값(D6)                                  |
| T19 | 통합                | 만료 생략 시 7일, 30일 초과 400. active 링크 소유자당 21번째·코스당 6번째 409                                                                                                                                                                                                                                                                                                                          | 한도(D2)                                         |
| T20 | 통합 + E2E ×2 shell | 양 끝이 구역 안인 코스: (1) GPX 흐름에서 경고·체크 뒤 **정확한 선**을 고르면 다운로드한 GPX의 양 끝이 원 revision의 양 끝과 같다(구역 안 좌표 포함). (2) 링크 흐름의 확인 화면에는 정확한 선 선택지가 없다. (3) API로 `exposure=owner-exact` receipt를 링크 생성에 쓰면 409이고 링크가 만들어지지 않는다. (4) 링크 흐름에서 `exposure=owner-exact` receipt 생성 요청 자체가 400                        | 소유자 전용 정확한 선(D3b)                       |
| T21 | 통합 + E2E ×2 shell | 보호 구역 0개인 소유자: 확인 화면이 "보호 구역이 없어 정확한 시작·끝이 포함됩니다"를 보이고, 체크 전에는 진행 버튼 비활성·API 409 `COURSE_EXPORT_NOT_CONFIRMED`, 체크 뒤 GPX 다운로드 성공(양 끝 = 원 revision 양 끝)·(flag on) 링크 생성 409, 링크 control 비활성. `course-acceptance.spec.ts` GPX step이 이 흐름으로 통과                                                                            | 구역 없음: GPX 경고 뒤 허용(D3a), 링크 불가(D3c) |
| T22 | 통합(합성)          | 합성 구역 500개 × 구역마다 공유 N∈{3,5,10,20}개의 끝점으로 최소제곱 원 맞춤 → 중심 추정 오차의 중앙값 ≥ 0.3·S, 10백분위 ≥ 0.1·S. 같은 구역의 두 링크가 같은 δ를 쓴다                                                                                                                                                                                                                                   | R1                                               |
| T23 | 통합                | 비신뢰 출처가 보낸 위조 `X-Forwarded-For`로 한도를 우회할 수 없다. 신뢰 프록시 뒤 두 client가 서로의 한도를 쓰지 않는다. 카운터 행에 평문 IP 없음                                                                                                                                                                                                                                                      | B-4                                              |
| T24 | E2E ×2 shell        | 보기 화면은 fragment를 읽기 전 어떤 오류 보고·분석 호출에도 URL을 넘기지 않는다. 소유자 화면은 생성 응답의 token을 localStorage·sessionStorage·IndexedDB·지속 query cache에 남기지 않는다                                                                                                                                                                                                              | B-7, R8                                          |
| T25 | 통합                | 공유 응답 좌표 반올림 뒤에도 T3 조건 유지                                                                                                                                                                                                                                                                                                                                                              | B-7, R-2                                         |

### 변이(각각 단일 anchor, 원복 후 `cmp` 동일 확인)

| 변이 | 내용                                                                              | 실패해야 할 시험    |
| ---- | --------------------------------------------------------------------------------- | ------------------- |
| V1   | 서버의 receipt 검사를 건너뜀                                                      | T1                  |
| V1b  | 화면의 확인 단계를 건너뛰고 바로 다운로드·링크 생성                               | T1, T2              |
| V2   | trim 판정을 무시하고 원 revision을 export·공유                                    | T3, T17             |
| V3   | 공유 읽기에서 token digest 검사 제거(코스 id만으로 반환)                          | T4                  |
| V3b  | 만료 비교 제거                                                                    | T4                  |
| V4   | 철회를 no-op으로(state 갱신 생략)                                                 | T5                  |
| V5   | 공유→revision FK cascade 제거                                                     | T6                  |
| V5b  | `erase_account` 공유 회수 링크 제거                                               | T6                  |
| V6   | 공유 읽기 응답을 코스 읽기 스키마로 반환                                          | T8                  |
| V6b  | GPX writer에 `metadata/desc`(courseId·revision)를 되돌림                          | T8                  |
| V6c  | GPX writer에 `metadata/time`을 되돌림                                             | T8                  |
| V6d  | 파일 이름에 `-r<n>`을 되돌림                                                      | T8                  |
| V7   | flag 기본값을 on으로                                                              | T9                  |
| V8   | 복원 절차의 epoch 증가 생략                                                       | T10                 |
| V8b  | 읽기의 epoch 비교 제거                                                            | T4, T10             |
| V9   | token을 로그 필드에 넣음                                                          | T11                 |
| V10  | 404를 만료·철회별로 다른 code로                                                   | T4                  |
| V11  | 구역 추가 시 공유 자동 철회 생략                                                  | T7                  |
| V12  | 공유가 head를 따라가게 함(고정 revision 대신 현재 head 조회)                      | T15                 |
| V13  | 받는 사람용 GPX 라우트 추가                                                       | T16                 |
| V14  | 보호 구역 없음일 때 경고 체크 없이 receipt 발급(또는 구역 없음을 차단으로 되돌림) | T21                 |
| V14b | trim 거절(`SPLITS_THE_LINE`)일 때 원 revision receipt 허용                        | T17                 |
| V14c | 구역 0개로 링크 생성 허용                                                         | T21                 |
| V15  | 링크 이름 기본값을 켬                                                             | T18                 |
| V15b | 소유자 GPX 이름 기본값을 끔(GPX writer가 이름을 빼도록)                           | T18                 |
| V16  | 만료 최대 검사 제거                                                               | T19                 |
| V16b | 소유자·코스당 링크 상한 검사 제거                                                 | T19                 |
| V17  | rate limit 카운터를 인스턴스 메모리로(공유하지 않음)                              | T12                 |
| V18  | 링크 생성이 `exposure=owner-exact` receipt를 받아들임                             | T20                 |
| V18b | 링크 흐름 확인 화면에 정확한 선 선택지를 노출                                     | T20                 |
| V18c | GPX 흐름에서 정확한 선을 골라도 제거본을 내보냄(선택 무시)                        | T20                 |
| V19  | δ를 0으로                                                                         | T22                 |
| V19b | 링크마다 δ를 새로 뽑음                                                            | T22(N=20 오차 붕괴) |

## 9. 결정 기록

모두 2026-09-25. "사용자 결정"은 사용자가 직접 정한 것, "기본값(권고안 채택)"은 사용자가 이 문서 초안의 권고를 그대로 채택하라고 한
것이다(coordinator 전달).

| #   | 결정                                                                                                                                                                                                                                                                                                     | 구분                          | 반영                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | --------------------- |
| D1  | 범위 **A + B.** A는 항상 만든다. B는 기본값 꺼짐 flag 뒤에 두고 독립 재식별 검토 통과 뒤에만 켠다. C는 미룬다                                                                                                                                                                                            | 사용자 결정                   | §2, §3, 부록 A        |
| D2  | 링크 만료 기본 7일·최대 30일. active 링크 소유자당 20·코스당 5                                                                                                                                                                                                                                           | 기본값(권고안 채택)           | §3, §4, T19           |
| D3  | 공유는 확인한 revision에 **고정**. 편집은 받는 사람이 보는 것을 바꾸지 않고, 새 판 공유는 새 확인이 필요. 소유자 자신의 GPX export도 gate 대상(현재 동작 변경). trim이 거절(재진입·선이 구역 통과)되면 공유·export 모두 차단                                                                             | 사용자 결정                   | §3, §4, §5, T15, T17  |
| D4  | 계정 export는 gate 밖                                                                                                                                                                                                                                                                                    | 사용자 결정                   | §1, §4, T13           |
| D5  | 받는 사람은 **보기만**(GPX 다운로드는 소유자에게만). 사양이 다운로드를 요구하지 않음을 확인(§2 B)                                                                                                                                                                                                        | 사용자 결정(낮은 공개 기본값) | §2, §3, T16           |
| D6  | 이름 기본값: **링크 공유는 기본 제외**(확인 화면에서 켤 수 있음), **소유자 GPX는 기본 포함**(끌 수 있음). 이전 초안의 "둘 다 기본 제외" 해석을 대체                                                                                                                                                      | 사용자 결정(2026-09-25)       | §2, §5, T18           |
| D7  | 비인증 rate limit IP 분당 30·digest 분당 60·실패 IP 시간당 100. 복원 시 epoch로 모든 링크 무효화                                                                                                                                                                                                         | 기본값(권고안 채택)           | §3, §4, T10, T12      |
| D8  | 받는 사람의 "내 코스로 복사"는 범위 밖                                                                                                                                                                                                                                                                   | 기본값(권고안 채택)           | §1                    |
| D9  | 계획 `:104`의 "공개 공유"를 "공개 발견(검색·목록)"으로                                                                                                                                                                                                                                                   | 기본값(권고안 채택)           | §7                    |
| D3a | 보호 구역이 없으면 **경고 뒤 허용.** 확인 화면이 "보호 구역이 없어 정확한 시작·끝이 포함됩니다"를 말하고, 명시 확인 뒤 export·공유가 진행된다. 차단은 trim 거절만. 이전 초안의 "구역 없음 → 차단"을 대체. **B(링크)에 대해서는 D3c가 대체한다**(재식별 검토 뒤)                                          | 사용자 결정(2026-09-25)       | §2, §5, T21           |
| D3b | 양 끝이 구역 안이면 소유자는 경고 뒤 **자기 GPX export에서만** 정확한 선을 고를 수 있다. 링크 공유는 항상 제거본이며, 구역 안 좌표는 공유 링크로 절대 나가지 않는다. 이전 초안의 "제거본만" 해석을 대체                                                                                                  | 사용자 결정(2026-09-25)       | §2, §5, T3, T20       |
| D3c | 링크 공유(B)에는 보호 구역이 1개 이상 필요하다(재식별 검토의 선택지 (ii)). 구역이 없으면 공유 버튼 대신 "보호 구역을 먼저 추가하세요"와 구역 추가 바로가기. 소유자 GPX의 D3a(경고 뒤 허용)는 그대로. D3a의 "공유가 진행된다"를 B에 대해 대체                                                             | 사용자 결정(2026-09-25)       | §2, §3, §5, T21, V14c |
| D10 | 재식별 검토 권고 R-1(소유자 GPX 제거본도 확장 원으로)을 **채택하지 않는다.** 소유자 GPX 제거본은 원 구역으로 자르고, 확인 화면에 "내보낸 제거본 파일 3개 이상이면 집 위치를 몇 m 안으로 계산할 수 있습니다."를 고지한다. **받아들인 잔여 위험:** 전달된 GPX 제거본들은 링크의 오프셋(δ)을 되돌릴 수 있다 | 사용자 결정(2026-09-25)       | §5, §6 R1             |

이전 판이 해석으로 정했던 세 가지(구역 없음 차단, 양 끝 구역 안 제거본만, 이름 기본 제외를 GPX에도 적용)는 위 D3a·D3b·D6으로 모두
사용자가 답했다. 남은 해석은 없다.

재식별 검토(2026-09-25)의 항목별 반영은 부록 B. 남은 것: 이 문서의 사용자 최종 승인,
발견 (a)의 별도 노드 등록(root).

## 부록 A. 채택하지 않은 선택지(기록 보존)

규범이 아니다. 2026-09-25 초안의 비교를 결정 근거로 남긴다.

### C. 앱의 등록 사용자 지정 공유 — 미룸(D1)

- 무엇: 소유자가 다른 등록 사용자를 지정하고, 대상은 로그인해 "나에게 공유된 코스"에서 읽는다. `resource_share` 모델
  (`030_resource_access_sharing.sql:20-47`)과 같은 모양: owner≠grantee, active/revoked, 감사 사실 분리.
- 장점: 링크 유출이 곧 노출이 아니다. 누가 볼 수 있는지 소유자가 정확히 안다.
- 미룬 이유: 대상을 **지정할 방법**이 없다(사용자 디렉터리·초대 없음, `resource_share`의 `grantee_principal_id`는 이미 아는
  principal을 전제). 이메일·아이디 조회는 가입 여부 enumeration oracle이 된다. 교차 tenant 읽기를 RLS에 여는 첫 코스 경로가
  된다(자료 RLS가 `resource_share`를 읽는 선례, `migrate.ts:229-231`). 대상의 말소·소유자의 말소 양쪽이 공유를 회수해야 한다.
- 다시 열 때의 요구 초안: grantee 로그인 필요, RLS는 공유 전용 view만(코스 원장에 교차 SELECT 없음), 비인가 404(다른 사용자·철회·
  만료 구별 없음), 대상 식별 입력에는 가입 여부와 무관하게 같은 응답, 소유자당 생성 한도, grantee 말소 시 회수, 대상에게 소유자
  표시 이름 공개.

### 받는 사람의 GPX 다운로드 — 기각(D5)

받는 사람이 파일을 가져가면 철회·만료가 의미를 잃고, 파일이 앱 밖으로 복제된다. 사양이 요구하지 않는다(§2 B).

### head를 따라가는 공유 — 기각(D3)

head가 바뀔 때마다 확인하지 않은 선이 나가거나, 매번 재확인을 요구해야 한다. 고정이 더 단순하고 공개가 예측 가능하다.

### trim이 거절된 코스를 "그래도 진행"으로 내보내는 선택지 — 기각(D3)

재진입·선이 구역 통과로 trim이 거절된 코스를 명시 확인 뒤 그대로 내보내는 안. 기각했다. (보호 구역이 없는 경우와, 양 끝이 구역 안인
코스의 소유자 GPX는 D3a·D3b로 경고 뒤 허용한다 — 이 항목과 다르다.)

### 보호 구역 없음 → 차단, 양 끝 구역 안 → 제거본만, 이름 기본 제외를 GPX에도 — 대체됨(D3a·D3b·D6)

2026-09-25 둘째 판이 해석으로 정했던 규칙들이다. 같은 날 사용자 결정으로 대체되었다.

### 복원 시 백업 뒤 철회 원장 재생 — 기각(D7)

drill의 다른 원장처럼(`backup-restore-drill.mts:2702-2768`) 백업 뒤 철회·삭제를 DB 밖에 캡처해 재생하는 안. 링크는 복원 뒤에도
살아남지만, 캡처 누락이 곧 되살아남이다(발견 (a)가 그 예). epoch 무효화는 소유자에게 재발급 비용을 지우는 대신 fail-closed다.

## 부록 B. 재식별 검토 반영(2026-09-25)

독립 재식별 검토(대상: 이 문서의 이전 판, sha256 `5ac5e7d4…`)의 항목과 사용자 결정을 반영한 위치다. 정확한 문언이 주어진 항목은
그대로 옮겼다.

| 항목         | 구분                | 반영                                                                                                                                    |
| ------------ | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| D3a for B    | 사용자 결정 (ii)    | D3c. §2 표, §3 공통 원칙, §5 표 첫째 줄·항목 2, 불변식, T21 문언 변경, V14c                                                             |
| R-1          | 불채택(사용자 결정) | D10. §5 표 아래 문단과 항목 4 GPX 고지, §6 R1 잔여 위험                                                                                 |
| A-1 (차단 A) | 채택                | §6 R5 완화 문언 교체, T8 추가 단언, V6d                                                                                                 |
| B-1 (차단 B) | 채택                | §3 B "공유 trim" 행, §5 불변식·표 넷째 줄 B, §2 표 전체 선, T3 B 절, T22, V19·V19b, §6 R1 근거(검토 기록의 표를 root가 옮김)            |
| B-3 (차단 B) | 채택                | §3 공통 원칙 allowlist 문단, T8 추가 단언                                                                                               |
| B-4 (차단 B) | 채택                | §3 B rate limit 행, T23                                                                                                                 |
| B-5 (차단 B) | 채택                | §4 백업 복원 행                                                                                                                         |
| B-6 (차단 B) | 채택                | §4 보호 구역 추가 행                                                                                                                    |
| B-7 (차단 B) | 채택                | T24, T25                                                                                                                                |
| B-8 (차단 B) | 채택                | §6 R7 완화, §3 B 보기 화면 행, T14                                                                                                      |
| R8 조건      | 채택                | §6 R8 완화·시험(T11에 rate limit·404 필수, token 비지속, `replaceState` 전 `location.href` 수집 금지, 타이밍 완화), §3 B enumeration 행 |
| R-2          | 채택                | §6 R2 완화(5자리, `owner-exact` 제외, 반올림 뒤 재검사), §2 표, T25                                                                     |
| R-3          | 채택                | §6 R6 완화(중립 `courseGpxCreator`), T8                                                                                                 |
| R-4          | 채택                | §3 B 보기 화면 행, T14                                                                                                                  |
| R-5          | 채택                | §3 B rate limit 행(맞은 읽기만, share id 키), T12                                                                                       |
| R-6          | 채택                | §4 명시 철회 행("모든 링크 끄기"), 계정 말소 행(감사 표)                                                                                |
| R-7          | 채택                | §4 계정 export 행(δ 포함, v23), 보호 구역 삭제·재생성 행                                                                                |
| R-8          | 채택                | §4 구역 이동·크기·이름 변경 행                                                                                                          |
| R-9          | 채택                | §5 항목 6                                                                                                                               |
| R-10         | 채택                | §5 표 아래 문단                                                                                                                         |
