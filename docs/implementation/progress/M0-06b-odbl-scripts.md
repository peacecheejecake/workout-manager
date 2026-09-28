# M0-06b-odbl-scripts · 공개 빌드 스크립트 원문

2026-09-28. 사용자 결정은 [M0-06b-odbl §2](M0-06b-odbl.md)의 첫 항목이다. 별도 공개 저장소 없이 익명 `/map-data-licence`에서 현재 제공 중인 데이터의 변경 스크립트 원문을 받는다. 법적 검토와 실제 공개 호스팅은 이 작업에 포함하지 않는다.

## 구현

- 배경 지도, 장소·고도, routing graph의 새 빌드는 disclosure에 적은 스크립트 SHA-256과 동일한 원문 바이트를 산출물의 `odbl-scripts/<index>.txt`에 함께 복사한다. Routing에는 graph import, 경계 barrier 도구, serving profile, engine launch 스크립트를 derivation에 기록한다. 배경 지도 필터·tippecanoe 설정은 기존 build 스크립트와 disclosure에서 온다.
- 공개 페이지는 disclosure에 있는 경로와 해시 옆에 다운로드 링크를 제공한다. 경로는 URL 인자로 받지 않고 정렬된 manifest의 숫자 인덱스만 받는다.
- Next 배경 지도 읽기는 매 요청의 `current.json`과 disclosure deployment ID가 같아야 하며, 파일 해시가 disclosure와 다르면 404다. API는 현재 routing deployment의 disclosure와 디렉터리를 한 번에 읽고 graph ID를 비교한다. 장소·고도는 로드된 dataset disclosure의 ID와 비교한다. 파일은 크기 상한, 디렉터리 포함 관계, 일반 파일 여부, SHA-256을 확인한다. 없는 원문을 저장소의 현재 파일로 대체하지 않는다.
- 이전 배포 산출물에는 원문 묶음이 없으므로 링크는 404다. 새 빌드와 실제 호스팅 확인은 `EXT-HOSTING`에 남는다.

## 검증

- Node 24.12.0, `pnpm typecheck`: 34/34 작업 통과.
- 집중 Vitest: 7파일·28시험 통과. 원문 변조, 범위 밖 인덱스, 경로 순회, 심볼릭 링크, 이전 graph ID 거절을 포함한다. 산출물 복사 시험은 세 빌더가 쓰는 공통 복사 함수를 세 종류의 manifest 형태로 실행한다. 대용량 실제 지도·graph를 다시 빌드한 시험은 아니다.
- 변경 파일 ESLint, Next·Vite production build 통과. `map-data-licence` 정적 페이지와 배경 지도 동적 route가 빌드됐다.
- Aside CLI 업데이트는 `fetch failed`로 실패했다. 기본 sandbox의 Playwright identity는 격리 PostgreSQL 시작 전에 중단됐다. 격리 서버 실행이 허용된 환경에서 다시 실행해 Next·Vite 공개 페이지의 기존 identity와 fixture 원문 링크/바이트 SHA-256 시험 **4/4 통과**했다. 브라우저의 fixture 다운로드 응답 확인이므로 실제 호스팅 배포 증거는 아니다.
- Root 합본 재검증: 생성물·전체 Prettier·ESLint·TypeScript 34/34, 단위·컴포넌트 **4,242 통과·7 건너뜀**, 격리 PostgreSQL 통합 **844/844**, 전체 build **15/15**를 확인했다. 전체 identity 브라우저는 두 실행 모두 **306 통과·13 건너뜀**(14.6분, 14.5분)이었다. 첫 전체 단위 실행은 일반 sandbox의 로컬 fixture 접속 제한과 worktree Python 환경 부재로 35건 실패·27건 건너뜀을 기록했고, 같은 코드에 로컬 접속 권한과 `WORKOUT_PYTHON`을 제공한 재실행이 위 수치로 통과했다. 처음 실패를 통과로 취급하지 않는다.

## 남은 배포 확인

활성 지도·graph·장소/고도 산출물을 새 코드로 다시 빌드한 뒤, 공개 페이지의 링크마다 응답 바이트의 SHA-256이 활성 disclosure와 같은지 실제 HTTPS 호스트에서 확인한다. 배포 전 ODbL 고지 및 coverage gate는 기존 기록을 따른다.
