# M0-06b-odbl-places · 장소·고도 데이터셋 ODbL 고지

상태: 코드 phase 독립 재검토 APPROVE, 검토 결과 기록의 문서 refresh 전. 실제 서빙 산출물 재생성·호스팅은 EXT-HOSTING에 남는다. 법적 검토가 아니다.

## 구현

- `build-geo-datasets.mjs`가 장소·고도 dataset identity와 같은 원본 extract의 취득 기록, SHA-256, 크기, 필터, 도구·스크립트 해시로 `odbl-disclosure.json`을 만든다. `ATTRIBUTION.txt`는 이 기록에서 렌더링한다. 빌드 종료 전 두 산출물과 ODbL URI를 대조하고 불일치면 거부한다.
- API는 구성된 장소·고도 데이터의 identity와 고지의 identity·원본 해시·라이선스·정확한 notice를 대조한다. 데이터 없음, 이전 형식의 고지 없음, 불일치/읽기 실패, 공개 가능 상태를 구분한다. 고지에는 파일 경로나 비밀값을 싣지 않는다.
- 로그인 없는 `/map-data-licence`를 Next/Vite 두 셸에서 같은 상태로 표시한다. 장소 검색 결과와 고도 결과에도 OSM copyright, ODbL URI, 변경 방법 페이지 링크를 둔다. 이전 형식의 데이터는 공개 준비 완료로 표시하지 않는다.
- 계약과 빌드 도구의 notice 렌더링이 같은 바이트를 내는 시험과 URI·identity·notice 누락 및 변조 거부 시험을 추가했다.

## 검증

- `pnpm install --frozen-lockfile`, `uv sync --extra garmin`, `pnpm check:generated`, `pnpm lint`, `pnpm format:check`: 통과.
- `pnpm typecheck`: 초기 전체 실행에서 E2E fixture의 TypeScript union 선언 오류를 발견해 수정했고, 재실행 통과(34/34). `pnpm build`: 15/15 통과.
- 관련 단위 시험 94개 및 계약/빌더 교차 렌더링 시험 1개: 통과. 전체 단위 첫 시도는 여러 전체 검사를 동시에 돌린 과부하로 UI 시간 초과가 생겨 중단했다. 두 번째 시도는 sandbox의 로컬 공급자 fixture 연결 제한으로 중단했다. 연결 권한이 있는 환경에서 단독 재실행: **331 files passed, 1 skipped; 4050 passed, 7 skipped**.
- `pnpm test:integration`: 최초 시도는 sandbox가 PostgreSQL 공유 메모리를 거부해 initdb 시작 실패. 허용된 별도 실행에서 **80 files, 797/797 passed**.
- 합성 장소·고도 데이터 fixture로 Chrome에서 Next와 Vite 공개 페이지의 `disclosed` 상태, dataset id, 변경 방법을 확인했다. Playwright는 두 셸에서 각 2/2 통과했고 320px 재배치를 확인했다. Aside 업데이트가 `fetch failed`로 불가하여 AGENTS.md 순서대로 Chrome과 Playwright를 사용했다. 실제 데이터 재빌드나 공개 배포 증거가 아니다.

## 남은 gate

- 현재 운영용 장소·고도 산출물은 새 고지 형식으로 다시 빌드하지 않았다. EXT-HOSTING 때 실제 원본으로 재생성하고 공개 배포물을 검사한다.
- 실제 외부 호스팅과 법적 검토는 수행하지 않았다.

## 독립 검토 이력

- 첫 검토: main `c3455868fcc70b50b3f1e35c4bfd262fcd6a970f` 대비 phase HEAD `3a6f1091452e453c158b62c0ecf72c861296da92`, Codex CLI `gpt-6-sol` high, read-only. **승인 보류**. P1: 고도 파일의 `maxSourceDistanceMeters`와 변경 방법 기록이 결속되지 않아 낡은 고지를 공개 가능으로 판정할 수 있다. P2: 장소·고도 `outside_region` 화면에서 ODbL 고지가 빠진다.
- 수정 및 root 확인: P1 **FIXED** — 빌드 산출물 검사와 API가 실제 고도 lookup 거리를 기록 값과 비교하고, 같은 dataset ID에 거리만 바꾼 회귀 시험을 추가했다. P2 **FIXED** — 두 범위 밖 상태에 고지를 넣고 컴포넌트 시험과 Next/Vite 실제 브라우저 시험을 추가했다. 수정 관련 단위 4파일/80건, 전체 typecheck 34/34, lint, build 15/15를 통과했다. Next/Vite 범위 밖 E2E 각 1/1 통과(합성 API 응답, 실제 OIDC·PostgreSQL·두 셸). 첫 브라우저 시도는 응답 가로채기 전에 고도 값을 캐시해 실패했고 순서를 고쳐 재실행했다.
- 두 번째 검토: 같은 base `c3455868fcc70b50b3f1e35c4bfd262fcd6a970f` 대비 수정 HEAD `795647e2e383fe284d7977b6345d2044ac708384`, Codex CLI `gpt-6-sol` high, read-only. **APPROVE**, 이전 P1 **FIXED**, P2 **FIXED**, 새 차단 지적 없음. 검토자는 명령·브라우저를 재실행하지 않았고 위 실제 검증 기록을 확인했다. 이 검토 결과 기록을 추가하는 문서 커밋만 별도로 review refresh한다.
