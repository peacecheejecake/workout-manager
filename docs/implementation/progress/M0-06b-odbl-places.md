# M0-06b-odbl-places · 장소·고도 데이터셋 ODbL 고지

상태: 구현·검증 완료, phase 독립 검토 전. 실제 서빙 산출물 재생성·호스팅은 EXT-HOSTING에 남는다. 법적 검토가 아니다.

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
