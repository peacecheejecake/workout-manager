# M0-06b-odbl · ODbL §4.2/§4.6 이행(라이선스 고지·파생 데이터베이스 변경 방법 공개 페이지)

상태: **완료(2026-09-26), `phase/m0-06`에 커밋.** 코드·시험·변이는 통과. 지금 서빙 중인 타일 배포(`ec81f3367889-mub8vb9q`)와 전국 graph(`92e0fa5f319a41df`)는 새 검사에서 `ODBL_NOTICE_MISSING`이라 배포 전에 다시 빌드해야 한다(사용자 결정 대기). identity 두 회차는 디스크 가득 참(ENOSPC)·고부하 중 각 3·1건 실패, 해당 spec 단독 재실행 20/20 통과. Codex phase review 전.

상태: **구현·검증 완료, 커밋하지 않음.** 기준: `phase/m0-06` `2c0d95d`(detached, 이 worktree). `task-graph.json`, 요구
매트릭스, `AGENTS.md`, `CLAUDE.md`, `.geo-build`와 기존 `.geo-build-routing/*` root는 바꾸지 않았다(`.geo-build`는 주
checkout의 것을 symlink, Git 제외). 새 산출물은 모두 이 worktree의 Git 제외 디렉터리 `.geo-build-odbl/`에 만들었다.
개인 FIT/GPS·토큰·자격 증명은 없다. 검토자는 띄우지 않았다(phase 리뷰는 root 몫).

**이것은 법적 검토가 아니다.** self-hosted-map-adr.md §6 "공개 배포 전 이행 절차"를 그 ADR이 읽은 대로 구현했다. 실제
호스팅·외부 공개는 하지 않았다.

출처: `task-graph.json` `M0-06b-odbl`, [ADR §6](../research/self-hosted-map-adr.md), [지도 구현 계획](../map-implementation-plan.md),
[M0-06b](M0-06b.md), [runbook](../operations-runbook.md), [M2-01ay](M2-01ay.md)(군사 경계 barrier 파생).

## 0. 결론

- **§4.2.** OSM copyright 링크와 ODbL 1.0 URI(`https://opendatacommons.org/licenses/odbl/1-0/`)를 모든 OSM 파생 산출물에
  싣는다: 배경 deployment의 `ATTRIBUTION.txt`(첫 문단), style source·`tiles.json`의 `attribution`/`attributionText`,
  routing graph 디렉터리의 새 `ATTRIBUTION.txt`. 화면: 지도 옆 평문 attribution(렌더러가 실패해도 남는 줄)은 geo-kit이
  두 링크를 보장하고, 경로 결과를 보여 주는 세 곳(경로 검토 요약, 목표 거리 후보 목록, 경로로 만든 코스 revision)에
  `RouteDataNotice`(두 링크 + 공개 페이지 링크)가 붙는다.
- **§4.6 방식 (b).** 변경 방법은 build 산출물에서 기계적으로 만든다. 배경: deployment 안 `odbl-disclosure.json`(build가
  이번에 쓴 값: extract URL·SHA-256·크기·Last-Modified와 그 출처, 레이어별 `osmium tags-filter`, export 형식, `tippecanoe`
  인자 전체, zoom·glyph, 도구 버전, build 스크립트 5개 SHA-256) → 그것을 렌더한 `ATTRIBUTION.txt`. graph: manifest의
  사실(엔진 버전·artifact 해시·프로필 해시·extract 해시·지역·크기·도로 데이터 시점)과 `edge-facts/derivation.json`(군사
  구역 경계 barrier 도구·해시·개수·osmChange·파생 extract 해시, 시간 조건 way 수, extract 취득 기록)을 렌더해 graph를
  hash하기 **전에** 디렉터리에 쓴다(content hash가 고지를 덮는다).
- **공개 페이지.** 두 셸의 `/map-data-licence`(로그인 불필요). 배경은 공개 정적 파일(`current.json` → deployment의
  `odbl-disclosure.json`), graph는 새 무인증 API `GET /bff/v1/map-data/licence`(활성 deployment의 검증된 파일에서 만든
  disclosure; blue/green 전환을 바로 따른다; 경로·호스트 없음).
- **실패하는 시험.** 산출물에 URI가 없거나 기록과 다르면 publish/import/점검이 실패한다(`ODBL_NOTICE_MISSING`,
  `ODBL_ATTRIBUTION_STALE`, `ODBL_DISCLOSURE_FOREIGN`). 읽기 전용 점검 `scripts/check-odbl-artifacts.mts`.
- **이 노드 이전 산출물은 점검을 통과하지 못한다(실측).** 공유 배경 `ec81f3367889-mub8vb9q`와 전국 graph
  `92e0fa5f319a41df` 모두 `ODBL_NOTICE_MISSING`(exit 1). 배포 전에 다시 만들어야 한다(§6 열린 일). 공개 페이지는 이 두
  산출물에 대해서도 build 기록의 변경 방법을 보여 주고, 산출물 안 고지가 없다고 표시한다.
- **새로 만든 산출물은 통과한다(실측).** 이 worktree에서 새 배경 deployment(`ebe407d9dcbe-mui895uc`, 실제 Seoul build)와
  작은 Seoul clip graph(`35702d7c4b3f8679`, 실제 GraphHopper import)를 만들었고 둘 다 점검 exit 0이다.

## 1. 설계

### 1.1 한 곳에서 정하는 URI

`packages/contracts/src/map-data-licence.ts`가 두 URI, `carriesOdblNotice`, 공개 페이지·API 경로, 두 disclosure 스키마를
정한다. 순수 Node 스크립트(`scripts/geo/odbl.mjs`)와 계약 패키지에 의존하지 않는 geo-kit은 같은 값을 복사해 두고,
시험이 계약 값과 같음을 확인한다(geo-build.test, courses map-data-licence.test).

### 1.2 배경 deployment

- `createBasemapDisclosure`가 build가 이번 run에 쓴 객체(`alterationMethod`, 도구 버전, extract 정보)를 그대로 받아
  disclosure를 만든다. build 보고서의 `alterationMethod`도 같은 객체다.
- `ATTRIBUTION.txt` = `renderBasemapAttribution(disclosure)`. 첫 문단(두 줄)이 화면 고지다. 셸은 첫 문단만 화면에
  쓴다(`sanitizeAttribution`), 나머지는 변경 방법이다.
- `verifyStagedBuild` → `verifyOdblArtifacts`: style 모든 source의 attribution, `tiles.json`의 두 attribution,
  `ATTRIBUTION.txt` 전체와 첫 문단에 두 URI; `ATTRIBUTION.txt`가 disclosure의 렌더와 바이트 동일; disclosure의
  deployment id가 `tiles.json` URL에 있는 이 deployment. 하나라도 어긋나면 publish하지 않는다.
- extract의 Last-Modified는 산출물에서만 온다: 이번 다운로드 응답 → 다운로드가 남긴 `<extract>.acquisition.json`
  (`fetchAllowedSource({ recordAcquisition: true })`, 새 옵션) → 같은 바이트를 받은 이전 build 보고서 run → 없으면 `null`.
  출처는 `recordedBy`로 남긴다.
- style revision 1 → 2(attribution 문구 변경으로 build id가 바뀐다). `BASEMAP_WORK_ROOT`(절대 경로, `.geo-build` 밖)로
  scratch build가 공유 deployment와 커밋된 보고서를 건드리지 않게 했다(이 노드의 실측 build에 사용).

### 1.3 routing graph

- `importRoutingGraph`가 engine을 멈추고 properties를 확인한 뒤, hash **전에** `writeRoutingGraphAttribution`으로
  `ATTRIBUTION.txt`를 쓰고, manifest를 쓴 뒤 `verifyRoutingGraphAttribution`으로 확인한다. 고지는 graph content hash에
  들어가므로 나중에 고치면 graph가 `GRAPH_CONTENT_CHANGED`로 거절된다. content hash·build id는 자기 자신을 담을 수 없어
  manifest를 가리킨다.
- `derivation.json`에 `source`(allowlist id·URL·Last-Modified·출처)를 더했다(`extractAcquisition`: 다운로드 기록이 이
  바이트를 설명할 때만, 아니면 URL만 두고 날짜 `null`).
- 로드(`loadRoutingDeployment`)는 고지를 요구하지 않는다. 요구하면 이 노드 이전 graph(현재 서빙 중인 전국 graph)를
  서빙할 수 없게 된다. 대신 disclosure의 `artifactNotice`가 `verified`/`missing`/`mismatch`를 말하고, 배포 전 점검이
  실패한다.

### 1.4 API와 공개 페이지

- `GET /bff/v1/map-data/licence`는 인증 plugin 밖에 등록한다(공유 코스 읽기와 같은 위치). 쿠키·세션·쿼리를 읽지 않고
  `cache-control: no-store`. 값은 `RoutingDeploymentSwitch.activeDisclosure`(각 deployment를 준비할 때 검증된 파일에서
  한 번 만든 것)를 요청마다 읽어 전환·rollback을 따른다. 문서에는 해시·버전·개수·공개 URL만 있다(시험: 임시 경로와
  엔진 주소가 응답에 없다).
- 모듈 `@workout/modules-courses/map-data-licence`의 `MapDataLicenceView`가 두 셸에 같은 화면을 준다. 읽기는
  `credentials: 'omit'`, `redirect: 'error'`, `no-store`. 상태를 섞지 않는다: 배경 없음 / 고지 기록 없는 배포본(배포 불가
  표시) / 다른 deployment의 기록(거절, 읽기 실패로 표시) / 읽기 실패, routing 없음 / 읽기 실패. Vite preview의 SPA
  fallback(HTML)이 pointer 자리에 오면 "배경 없음"이다. 긴 해시가 320px에서 넘치지 않게 `overflow-wrap: anywhere`.
- geo-kit `withOdblNotice`: deployment 문구에 두 링크가 없으면 고지를 덧붙이고, 있으면 그대로 둔다. `MapView`의 평문
  attribution 줄이 쓴다.

## 2. 사용자 결정 (2026-09-26) — 이 노드에서는 구현하지 않음

사용자가 두 가지를 결정했고, 이어서 **이 노드에서는 구현하지 말고 뒤 노드로 넘기라고 정정했다.** 그래서 코드·시험을
더하지 않았다(더했던 것도 없다). 열린 질문이 아니라 결정된 후속 작업이다.

1. **§4.6 스크립트 본문 공개.** 변경을 정의하는 build 스크립트 본문(osmium 필터 표현식, tippecanoe 인자, 군사 경계
   barrier 도구, routing graph build/파생 스크립트)을 서비스의 로그인 불필요 데이터 출처 페이지에서 내려받을 수 있는
   파일로 게시한다. 별도 공개 저장소는 두지 않는다. manifest가 기록한 SHA-256의 바이트를 그대로 서빙하고, 서빙한
   파일의 해시가 manifest와 같음을 시험한다.
2. **개인 GPX export.** 법적 판단 없이 보수적으로, 내보내는 GPX metadata에 OSM attribution과 ODbL 1.0 URI를 싣는다(경로
   형상이 OSM 파생 routing/타일에서 온 경우; 확실하지 않으면 모든 코스 GPX export). 시험과 변이를 붙인다.

## 3. 바꾼 파일

| 파일                                                                                                                                                                                                      | 내용                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/map-data-licence.ts`(신규), `package.json`                                                                                                                                        | URI·경로 상수, `carriesOdblNotice`, 두 disclosure·응답 스키마                                                                                                                                                                                                                                                                                                                                           |
| `scripts/geo/odbl.mjs`(신규)                                                                                                                                                                              | 배경 attribution 문구, `assertOdblNotice`, `resolveAcquisition`, `createBasemapDisclosure`, `renderBasemapAttribution`                                                                                                                                                                                                                                                                                  |
| `scripts/build-basemap.mjs`                                                                                                                                                                               | 새 문구, disclosure·`ATTRIBUTION.txt` 생성, `verifyOdblArtifacts`, `BASEMAP_WORK_ROOT`, style revision 2, 스크립트 해시에 `odbl.mjs`                                                                                                                                                                                                                                                                    |
| `scripts/geo/sources.mjs`                                                                                                                                                                                 | `recordAcquisition`, `readAcquisitionRecord`, `acquisitionRecordPath`                                                                                                                                                                                                                                                                                                                                   |
| `packages/server/integrations/src/routing/odbl-disclosure.ts`(신규), `index.ts`                                                                                                                           | `renderRoutingAttribution`, `verifyRoutingGraphAttribution`, `routingDataDisclosure`, derivation 스키마                                                                                                                                                                                                                                                                                                 |
| `scripts/build-routing-graph.mts`                                                                                                                                                                         | hash 전 `ATTRIBUTION.txt`, import 끝 점검, derivation `source`, `extractAcquisition`                                                                                                                                                                                                                                                                                                                    |
| `scripts/check-odbl-artifacts.mts`(신규)                                                                                                                                                                  | 읽기 전용 배포 전 점검 CLI                                                                                                                                                                                                                                                                                                                                                                              |
| `apps/api/src/map-data-licence-routes.ts`(신규), `app.ts`, `configured.ts`, `routing-deployment.ts`                                                                                                       | 무인증 disclosure 읽기, `activeDisclosure`                                                                                                                                                                                                                                                                                                                                                              |
| `scripts/identity-e2e.mts`                                                                                                                                                                                | 하네스가 graphhopper 모드에서 disclosure를 넘김                                                                                                                                                                                                                                                                                                                                                         |
| `packages/experience/geo-kit/src/basemap.ts`, `map-view.tsx`                                                                                                                                              | `withOdblNotice`, 평문 attribution 줄                                                                                                                                                                                                                                                                                                                                                                   |
| `apps/web/app/basemap-config.ts`, `apps/mobile-web/src/basemap.ts`                                                                                                                                        | 화면 고지는 `ATTRIBUTION.txt` 첫 문단                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/modules/courses/src/route-data-notice.tsx`, `map-data-licence.tsx`, `map-data-licence-api.ts`, `map-data-licence.module.css`(신규), `course-editor.tsx`, `course-workbench.tsx`, `package.json` | 경로 결과 고지, 공개 페이지                                                                                                                                                                                                                                                                                                                                                                             |
| `apps/web/app/map-data-licence/*`(신규), `apps/mobile-web/src/main.tsx`                                                                                                                                   | 두 셸의 `/map-data-licence`                                                                                                                                                                                                                                                                                                                                                                             |
| `playwright.identity.config.ts`                                                                                                                                                                           | `IDENTITY_E2E_BASEMAP_DIST_DIR`(scratch 배포본으로 보기, 기본값 불변)                                                                                                                                                                                                                                                                                                                                   |
| 시험                                                                                                                                                                                                      | 신규 `contracts/tests/map-data-licence.test.ts`, `integrations/tests/routing-odbl-disclosure.test.ts`, `apps/api/tests/map-data-licence-routes.test.ts`, `courses/tests/map-data-licence.test.tsx`, `tests/identity/map-data-licence.spec.ts`; 수정 `geo-build`, `geo-sources`, `build-routing-graph`, `routing-deployment`, `geo-kit`, `course-editor`, `course-candidates`, `activity-track-map.spec` |
| 문서                                                                                                                                                                                                      | runbook "ODbL 고지와 변경 방법 공개 — M0-06b-odbl" 절과 전국 extract 받기 명령(`recordAcquisition`), ADR §6 구현 상태, 이 문서                                                                                                                                                                                                                                                                          |

## 4. 실측 산출물 (이 worktree `.geo-build-odbl/`, Git 제외)

| 산출물                                                                                                                             | 결과                                                                                                                                                                                                                                                                                           | 시간·자원·load                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 배경 build `BASEMAP_WORK_ROOT=… build-basemap.mjs --execute --reuse`(extract는 공유 `.geo-build/source`의 파일을 symlink로 읽기만) | build `ebe407d9dcbe`, deployment `ebe407d9dcbe-mui895uc`, 타일 4,817, 90,404,947 bytes. `ATTRIBUTION.txt`의 스크립트 해시 5개 = 현재 파일 해시. Last-Modified `Sat, 19 Sep 2026 16:20:02 GMT`(`earlier-build-report`: 커밋된 build 보고서의 같은 바이트 다운로드). 커밋된 보고서는 바뀌지 않음 | 69.6 s real, 169 s user, 최대 RSS 2.23 GB, load 17.0 → 20.8                  |
| graph clip import(`importRoutingGraph`, Seoul bbox `126.96,37.55,127.00,37.59`, 포트 18991/18992, heap 1024 MiB)                   | graph `35702d7c4b3f8679`, `artifactNotice: verified`, barrier node 1·군사 면 5, 시간 조건 way 1                                                                                                                                                                                                | import 5.25 s, 6.7 s real, 최대 RSS 3.08 GB(프로세스 트리), load 21.5 → 21.9 |
| `check-odbl-artifacts.mts` 새 두 산출물                                                                                            | 둘 다 passed, exit 0                                                                                                                                                                                                                                                                           | —                                                                            |
| 같은 점검, 이 노드 이전 산출물(`ec81f3367889-mub8vb9q`, `92e0fa5f319a41df`)                                                        | 둘 다 `ODBL_NOTICE_MISSING`, exit 1                                                                                                                                                                                                                                                            | 읽기만                                                                       |
| 같은 점검, 새 deployment 복사본에서 `tiles.json`의 ODbL URI만 지움                                                                 | `ODBL_NOTICE_MISSING`, exit 1                                                                                                                                                                                                                                                                  | —                                                                            |

(같은 세션의 첫 두 build — `…-mui7hv0f`, `…-mui7v668` — 는 Playwright가 `test-results/`를 비울 때 로그와 함께 지워졌다.
결과는 위와 같았고 위 행이 보존된 run이다.)

전국 graph `92e0fa5f319a41df`의 disclosure(읽기 전용 검증 후 생성): 엔진 10.0, 프로필 `9b6fa80a…`, extract
`848daadc…`(South Korea, 286,403,403 bytes), 군사 경계 barrier(도구 `f5c55524…`, barrier node 4,220, way 2,764, 파생 extract
`623b6705…`), 시간 조건 way 77, `artifactNotice: missing`, extract 취득 기록 없음(`acquisition: null`).

## 5. 변이 (단일 anchor, 복원은 `cmp`로 확인)

`.geo-build-odbl/mutants.mjs`, 결과 `verification-logs/m0-06b-odbl/mutants.json`, 각 로그 `…/mutants/M*.log`. 15개 모두 죽었고
15개 모두 복원 후 원본과 바이트 동일.

| #   | 변이                                          | 파일                              | 결과                                                             |
| --- | --------------------------------------------- | --------------------------------- | ---------------------------------------------------------------- |
| M1  | `assertOdblNotice`가 ODbL URI를 요구하지 않음 | `scripts/geo/odbl.mjs`            | 죽음(2 실패)                                                     |
| M2  | 배경 `ATTRIBUTION.txt` 첫 문단에서 URI 제거   | `scripts/geo/odbl.mjs`            | 죽음(5)                                                          |
| M3  | 기록의 렌더가 아닌 `ATTRIBUTION.txt` 허용     | `scripts/build-basemap.mjs`       | 죽음(1)                                                          |
| M4  | graph 고지에서 URI 제거                       | `odbl-disclosure.ts`              | 죽음(5)                                                          |
| M5  | graph 고지를 항상 `verified`로 보고           | `odbl-disclosure.ts`              | 죽음(2)                                                          |
| M6  | build가 graph 고지를 derivation 없이 씀       | `scripts/build-routing-graph.mts` | 죽음(1)                                                          |
| M7  | 공개 읽기가 세션 쿠키를 요구                  | `map-data-licence-routes.ts`      | 죽음(3)                                                          |
| M8  | 전환 뒤에도 이전 deployment를 공개            | `routing-deployment.ts`           | 죽음(1)                                                          |
| M9  | 지도 평문 attribution에 링크를 보태지 않음    | geo-kit `basemap.ts`              | 죽음(3)                                                          |
| M10 | 경로 검토 요약에 고지 없음                    | `course-editor.tsx`               | 죽음(1)                                                          |
| M11 | 다른 deployment의 기록을 받아들임             | `map-data-licence-api.ts`         | 죽음(1)                                                          |
| M12 | `carriesOdblNotice`가 한 링크로 만족          | contracts                         | 죽음(1)                                                          |
| M13 | 페이지가 deployment id 자리에 build id 표시   | `map-data-licence.tsx`            | 죽음(1)                                                          |
| M14 | 경로로 만든 코스 revision에 고지 없음         | `course-workbench.tsx`            | 죽음(1) (처음엔 **살아남아** `course-editor.test`에 단언을 더함) |
| M15 | 목표 거리 후보 목록에 고지 없음               | `course-editor.tsx`               | 죽음(1) (`course-candidates.test`에 단언을 더함)                 |

기록한 한계: 셸 `sanitizeAttribution`의 "첫 문단만" 동작에는 단위 시험이 없다(두 셸 모두 앱 안 함수). 변이로 되돌려도
첫 400자 안에 두 URI가 들어가 화면 단언은 여전히 통과하므로 이 변이는 살아남는다고 본다(실행하지 않음).

## 6. 검증 수치

로그: `verification-logs/m0-06b-odbl/`(Git 제외). 기계는 다른 agent와 공유한다. 인위적 부하는 만들지 않았다. 18:58–19:06의
첫 한 벌 로그는 Playwright가 `test-results/`를 비울 때 지워져, 아래는 보존된 두 번째 한 벌이다(수치는 같았다: pnpm test
4,031/4,031 passed, integration 1 + 794 passed).

| 검사                                                                                                                                     | 결과                                                                                                                                                                                                                                                                                    | load average(1분) |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `pnpm install --frozen-lockfile`                                                                                                         | exit 0                                                                                                                                                                                                                                                                                  | 3.9               |
| `pnpm check:generated`                                                                                                                   | exit 0                                                                                                                                                                                                                                                                                  | 3.9               |
| `pnpm lint`                                                                                                                              | exit 0                                                                                                                                                                                                                                                                                  | 4.0               |
| `pnpm typecheck`                                                                                                                         | 34/34 tasks, exit 0                                                                                                                                                                                                                                                                     | 4.2               |
| `pnpm build`                                                                                                                             | 15/15 tasks, exit 0(Next 경로표에 `○ /map-data-licence`, Vite에 `map-data-licence-*` chunk)                                                                                                                                                                                             | 4.1               |
| `pnpm test` 1회차                                                                                                                        | 4,030 passed, **1 실패**: `graphhopper-launch.test.mjs` "go through the helper everywhere"가 5 s 제한 초과. 이 시험은 저장소 파일을 모두 훑는데, 그때 이 노드의 scratch 산출물(`.geo-build-odbl/`, 약 660 MB의 stage 포함)이 worktree에 있었다(load 4.1 → 21.5). stage를 지운 뒤 재실행 | 4.1 → 21.5        |
| `pnpm test` 2회차                                                                                                                        | **329 files, 4,031/4,031 passed**, exit 0                                                                                                                                                                                                                                               | 7.0 → 18.4        |
| `pnpm test:integration`(`TEST_DATABASE_*` 없음, runner가 만든 cluster)                                                                   | 1 + **794 passed**(80 files), exit 0                                                                                                                                                                                                                                                    | 21.5 → 11.3       |
| drill                                                                                                                                    | 해당 없음(저장·삭제·persistence 변경 없음)                                                                                                                                                                                                                                              | —                 |
| `pnpm test:identity` 1회차(잠금 안)                                                                                                      | 262 passed, 9 skipped, **3 failed**: `course-editor-layout`(API 500), `course-list-scroll`, `courses.spec` 767/768 레이아웃. 이 run 동안 디스크가 가득 찼다(ENOSPC, 여유 119 MiB, 다른 프로세스 포함)                                                                                   | 8.9 → 최대 34.8   |
| `pnpm test:identity` 2회차(잠금 안)                                                                                                      | 262 passed, 9 skipped, **1 failed**: `garmin-unofficial.spec` Next MFA 상태 문구 5 s 대기 초과(이 노드와 무관한 화면)                                                                                                                                                                   | 8.8 → 6.1         |
| 위 네 spec 재실행(잠금 안, 디스크 21 GiB 여유)                                                                                           | **20/20 passed**                                                                                                                                                                                                                                                                        | 4.5 → 6.8         |
| `map-data-licence.spec`                                                                                                                  | 1·2회차 모두 두 셸 passed(공유 `.geo-build/dist` = 고지 기록 없는 배포본 → "기록 없음" 표시, fixture routing → "경로 계산 안 함")                                                                                                                                                       | —                 |
| scratch 구성 identity(잠금 안): 새 배포본(`IDENTITY_E2E_BASEMAP_DIST_DIR`) + API가 전국 graph `92e0fa5f319a41df` disclosure(엔진 미기동) | `map-data-licence.spec` 두 셸 + `activity-track-map.spec` 7건 = **9/9 passed**(지도 옆 평문 attribution에 두 URI 단언 포함)                                                                                                                                                             | 7.1 → 8.4         |
| `pnpm format:check`(마지막)                                                                                                              | exit 0("All matched files use Prettier code style!")                                                                                                                                                                                                                                    | —                 |

identity 두 run의 실패는 서로 다른 spec이고, 이 노드가 바꾼 화면(`/map-data-licence`, 경로 고지)의 단언은 두 run 모두
통과했다. 실패 spec 넷은 재실행에서 모두 통과했다. 그래도 run 1·2 자체는 "전부 통과"가 아니다.

### UI 검증 (Aside → Chrome → Playwright)

- **Aside(사용).** 잠금 안에서 identity 하네스 API(graphhopper 모드, 전국 graph `92e0fa5f319a41df`, 엔진 미기동)와 두 셸
  (Next는 새 배포본 `ebe407d9dcbe-mui895uc`)을 띄우고 `aside repl`로 로그인 없이 `http://127.0.0.1:3100/map-data-licence`와
  `http://127.0.0.1:4200/map-data-licence`를 열었다. 두 셸 모두 접근성 트리에 고지 두 링크, 배포본
  `ebe407d9dcbe-mui895uc`와 레이어 필터·tippecanoe 인자·스크립트 해시 5개, graph `92e0fa5f319a41df`와 "산출물 안
  고지 파일 없음" 경고, 군사 경계 barrier 파생(도구 해시, barrier node 4,220, 파생 extract `623b6705…`), 시간 조건 way
  77이 보였다. `document.cookie`는 빈 문자열. 1440px 창에서 가로 넘침 없음(scrollWidth 1425). 스크린샷 저장은 디스크
  부족(ENOSPC)으로 실패해 남기지 못했다. 경로 결과 화면의 `RouteDataNotice`는 Aside로 보지 않았다(엔진을 띄우지
  않았고 저장된 경로 코스 fixture가 없음) — 단위 시험(M10·M14·M15)만 있다.
- **Chrome.** Aside가 확인했으므로 쓰지 않았다.
- **Playwright.** `map-data-licence.spec`(두 셸, 새 브라우저 context, 쿠키 없음, `/bff/v1/session` 요청 없음, 표시된
  배포본·graph가 공개 출처에서 따로 읽은 값과 같음, 320px에서 가로 넘침 없음)과 `activity-track-map.spec`(평문
  attribution의 두 URI).

## 7. 제안 매트릭스 판정 (root가 재판정; 매트릭스는 고치지 않았다)

| 행            | 현재         | 제안                             | 근거                                                                                                                                                                                                                                                                                  |
| ------------- | ------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FUT-07-4`    | not_executed | **not_executed 유지**(증거 추가) | 이 노드는 "표시 의무" 중 ODbL §4.2/§4.6만 이행했다(시험·변이 M1–M15, 실측 산출물 점검). 같은 행의 대표 지역 품질(P8-coverage failed), 이용 조건 전반, credential·좌표 최소화 검토는 여전히 수행되지 않았고, 서빙 중인 산출물은 점검에서 실패한다. 행 전체를 passed로 올릴 근거가 없다 |
| `P8-self-ops` | partial      | **partial 유지**(증거 추가)      | "asset license" 부분에 실행 증거가 더해졌다(배포본 attribution·disclosure 점검, publish 차단). 장기 track GPU 측정 등 나머지는 이 노드 범위 밖                                                                                                                                        |
| `P8-coverage` | failed       | 변화 없음                        | 이 노드와 무관                                                                                                                                                                                                                                                                        |

## 8. 열린 일

1. **배포 전 재생성.** 공유 배경 deployment와 전국 graph(`92e0fa5f319a41df`)는 산출물 안 고지가 없다. 배경은 다시
   build하면 된다(`.geo-build/dist`에 쓰므로 root/사용자 판단). graph는 새 root에 다시 import해야 하고 graph id가
   바뀌므로 M2-01ak 절차(rollout·성능 기준선·coverage 증거 재수집 여부)를 사람이 정해야 한다.
2. **전국 extract의 취득 기록.** `kr-260901*` root의 PBF 옆에 `.acquisition.json`이 없어 graph disclosure의 extract
   URL·Last-Modified는 "기록 없음"이다. 다시 받아(Geofabrik 월간 파일 보관 기간 안) 기록을 만들지, M2-01ak 진행 기록의
   값을 기록 파일로 옮길지(손으로 옮기는 것이 됨) 결정이 필요하다.
3. **§2의 두 사용자 결정**(스크립트 본문 게시, GPX export 고지)은 뒤 노드.
4. **장소·고도 dataset**(`build-geo-datasets.mjs`, M2-01j)도 같은 extract의 파생물이다. 화면 문구는
   `© OpenStreetMap contributors`와 copyright URL만 싣고 ODbL URI는 없다. 이 노드 scope에 명시되지 않아 바꾸지 않았다.
5. 법적 검토는 하지 않았다. 공개 공유 기능 활성화 전 재확인(ADR §6-4)은 그대로다.
6. 커밋 전 검토(phase 단위 Codex)는 root 몫. 이 노드는 검토자를 띄우지 않았다.

## Phase 독립 검토 · 2026-09-26

- 기준 `main` `5a4dfb5c98d99e88344f920da3ab14558a762ac8`, 검토 HEAD `b1933a9`의
  전체 diff를 Codex CLI `gpt-6-sol` high, read-only sandbox에서 검토했다. 결과는
  **CHANGES_REQUESTED**였다.
- 배경 지도 disclosure의 변경 방법 필드 누락 허용: **FIXED**. 배포 검사에서 필수 필드를
  런타임 검사하고, 고지 파일을 함께 바꾼 누락 변이도 거절하는 시험을 추가했다.
- graph의 extract URL 없는 배포 허용: **FIXED**. 신규 import에 취득 기록을 필수로 하고
  배포 검사는 출처 없는 graph를 거절한다. 별도 probe import 호출자도 기록을 넘긴다.
- 실기기 서명 빌드 원문 로그 저장: **FIXED**. 새 probe 실행은 계정·경로·인증서 원문을
  기록하지 않고 bounded 상태·오류 건수만 남긴다. 이전 worktree에 남은 Git 제외 원본
  로그는 수정하지 않았으며 이 검토의 제품 증거로 다시 사용하지 않는다.
- Xcode 종료 코드만으로 signed 성공 처리: **FIXED**. 서명 검증, team·bundle 식별자,
  HealthKit entitlement, embedded profile, Info.plist 사용 설명을 모두 확인한다.
- 수정된 HEAD의 독립 재검토는 대기 중이다. 실기기 실행 결과와 외부 gate 상태는
  이 코드 수정만으로 변경하지 않는다.
- root 재검증: Node 24.12.0에서 generated check·format·lint·typecheck는 통과했다.
  첫 전체 `pnpm test`는 기본 sandbox의 loopback `EPERM`과 worktree `.venv` 부재로 실패했다.
  `uv sync --extra garmin` 뒤 로컬 포트가 허용된 실행에서 330파일·4,034개 시험 통과,
  `pnpm build` 통과, 실제 PostgreSQL 통합 80파일·794개 시험 통과했다.
  `pnpm test:identity` 두 독립 실행은 각각 265 passed·9 skipped(13.3분 / 13.2분)였다.
  이는 기존 앱의 브라우저 회귀 증거이며 M0-06c 실기기 잔여 항목의 증거가 아니다.
- 재검토 HEAD `b58d528`에서 이전 네 건은 모두 **FIXED**였으나 **CHANGES_REQUESTED**였다.
  새 지적은 공유 코스 화면의 경로 데이터 고지 누락, 배포 검사가 허용한 disclosure를
  공개 계약이 거절하는 경로, 이전 서명 빌드 산출물 설치 가능성이다. 공유 snapshot에는
  비민감한 출처 고지 필요 여부만 투영하고, build 검증을 공개 schema에 맞추며,
  설치는 같은 앱 바이트의 검증된 signed build receipt를 요구한다. 수정 HEAD의
  전체 diff는 다시 검토받는다.
- 두 번째 검토의 새 지적에 대한 검증: 공유 링크 응답은 라우팅 graph 사용 여부만 고정
  snapshot에 싣고(imported course와 기존 snapshot은 필드 생략), 실제 PostgreSQL
  통합 80파일·795개 통과했다. Next·Vite 셸의 공유 화면은 배경 지도가 없는 조건에서
  라우팅 고지 표시/비표시 브라우저 시험 4개를 통과했다. 배포 disclosure의 공개 schema
  불일치 변이 12개와 서명 빌드 receipt 변이는 단위 시험에 추가했다. generated check,
  lint, typecheck, build, format check가 통과했다. 전체 단위 시험의 첫 실행은 다른
  빌드와 병행해 여러 무관한 화면 시험이 시간 초과되어 중단했고, 단독 재실행에서는
  330파일·4,037개가 통과했다. 변경 후 전체 `pnpm test:identity` 두 회차는 각각
  269 passed·9 skipped(14.3분 / 14.4분)였다. skipped 중 실제 OIDC 공급자 검사는
  이 실행의 환경 조건 밖이며 통과로 계산하지 않는다.
  Aside는 설치 지침의 `aside --update`가 네트워크 오류(`fetch failed`)로 실패해
  새 검증에 사용할 수 없었다. Chrome 앱은 열렸지만 검증 하네스의 응답 fixture를
  연결하지 못해 공유 화면 확인에는 Playwright를 사용했다. 이 브라우저 증거는
  native WKWebView·HealthKit 실기기 실행의 대체 증거가 아니다.
- 독립 재검토 HEAD `9be1962`는 **CHANGES_REQUESTED**였다. 새 링크의 공유 고지는
  고쳐졌으나 이전 snapshot에서 라우팅 출처 비트가 없어 고지가 빠짐(**NOT FIXED**),
  보호 구역으로 잘라낸 라우팅 코스의 소유자 화면 고지 누락, 이전 빌드 보고서의
  비허용 URL이 공개 기록으로 전파될 수 있음이 추가 지적됐다. 공개 schema 일치와
  오래된 signed 앱 설치 방지는 **FIXED**로 확인됐다. 현재 수정은 이전 공유 링크의
  저장 원본을 바꾸지 않고 고정된 코스 revision에서 출처를 읽어 응답 고지만 보강하고,
  graph ID가 남은 보호 구역 축소본에도 고지를 표시하며, 취득 URL은 허용 목록과
  정확히 일치할 때만 공개하도록 한다. 고정 revision 조회는 migration 056의
  읽기 전용 응답 경로이며 기존 snapshot은 수정하지 않는다. 격리 PostgreSQL
  통합 80파일·797개, 전체 단위 330파일·4,042개, generated check·lint·typecheck
  (34 작업)·build(15 작업)·format·diff check가 통과했다. 보호 구역 축소본의 실제
  Next/Vite 브라우저 검사 2개는 빌드 갱신 전 첫 실행에서 실패했고, 새 빌드 뒤
  두 독립 실행에서 각각 2개가 통과했다. 이 UI 증거도 실기기 증거는 아니다.
  수정 HEAD의 전체 diff 재검토는 대기 중이다.
