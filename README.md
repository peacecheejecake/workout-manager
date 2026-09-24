# Workout Manager

Adaptive Training Coach 구현 저장소입니다. 제품 명세는 [docs/.pre](docs/.pre/README.md),
실행 순서는 [구현 계획](docs/implementation/README.md)과 [작업 DAG](docs/implementation/task-graph.md)를 따릅니다.

개발 기반과 표준 OIDC 인증, 수동 계획 버전 편집, FIT JSON 활동 가져오기를 구현했습니다.
task별 범위와 검증 기록은 [작업 DAG](docs/implementation/task-graph.json)를 참고하세요.
홈의 개발 활동과 별도 React tooling fixture는 실제 기록과 구분됩니다. Python은 별도 uv 환경을 사용합니다.

## 개발 환경

Node.js **24.12.0**, pnpm **10.34.5**를 사용합니다. 저장소의 `.nvmrc` / `packageManager`가 기준입니다.

```bash
nvm use
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm dev:fixture
```

`http://127.0.0.1:4173`에서 fixture를 확인할 수 있습니다. 설치된 전역 pnpm 버전이 다르면
`corepack pnpm`으로 실행하세요. Turbo와 Playwright가 하위 프로세스에서 호출하는 `pnpm`도 고정 버전을 사용하도록 Corepack shim을 활성화합니다.
Node 설치 디렉터리에 쓰기 권한이 없다면 사용자 writable 디렉터리에 `corepack enable --install-directory <directory>`로 생성하고 PATH 앞에 둡니다.

## 검증 명령

```bash
corepack pnpm check          # Prettier + ESLint + TypeScript + Vitest
corepack pnpm test:coverage
corepack pnpm build          # contracts + fixture + Next/Vite + Storybook build
corepack pnpm exec playwright install chromium
corepack pnpm test:e2e       # desktop/mobile fixture, 실제 로컬 HTTP
```

`pnpm format`은 관리 대상 파일을 포맷합니다. 제공 설계 원본 `docs/.pre`, vendored skill,
생성물·개인 데이터는 일괄 포맷에서 제외합니다.

`pnpm test:integration`은 실제 PostgreSQL migration/RLS/동의/outbox/API 통합 테스트를 실행합니다.
로컬 PostgreSQL 바이너리를 사용해 폐기 가능한 임시 클러스터를 생성하며, 관리자/runtime URL을 직접
지정할 때는 별도 테스트 DB만 사용합니다. [실행·범위](docs/implementation/progress/M0-05.md)를 확인하세요.
OIDC 인증·동의·계획·활동 web/API/DB E2E는 `pnpm test:identity`로 실행합니다. 전체 훈련 제품 E2E와 native gate는 후속 작업입니다.

## 구조와 작업 규칙

- `packages/tooling`: strict TypeScript 설정, ESLint 경계 규칙, React/HTTP smoke fixture와 검증 기반.
- `tests/e2e`: Playwright fixture 시나리오. 제품 E2E는 첫 수직 slice에서 추가합니다.
- `.agents/skills/vercel-react-best-practices`, `.agents/skills/vercel-composition-patterns`: 같은 revision을 고정한 upstream React 기본 skill.
- `packages/contracts`: Zod runtime 계약과 inferred TypeScript. [버전 호환성·검증 범위](docs/implementation/progress/M0-02.md).
- `src/workout_manager`, `scripts/fitparse.py`: 로컬 FIT batch 변환. [검증 기록](docs/implementation/progress/M0-07a.md).

작업 분해·배정·통합은 **Codex native orchestration**, 커밋 전 독립 peer review는 **Herdr split pane**을
사용합니다. 상세 규칙과 브라우저 검증 순서는 [AGENTS.md](AGENTS.md)를 따릅니다.

## 로컬 FIT 변환

Python 3.13과 uv를 사용합니다. macOS/Linux의 파일 잠금을 사용하며 Windows는 검증하지 않았습니다.

```bash
uv sync --locked
uv run workout-manager convert /path/to/fit-input --output-dir /path/to/fit-output --format parquet --recursive
uv run workout-manager convert /path/to/fit-input --output-dir /path/to/fit-output --format parquet --recursive --resume
uv run ruff check .
uv run ruff format --check .
uv run pytest
```

`--format csv`도 지원합니다. 출력 디렉터리는 입력 디렉터리 밖에 둡니다. 파일마다 record/lap/session과
manifest를 만들며 원본 FIT를 변경하지 않습니다. 기본값은 기존 출력을 덮어쓰지 않습니다.
`--resume`은 원본·출력 SHA-256이 모두 일치하는 성공 항목만 건너뜁니다. 변경·손상·중단된 출력을
재생성하려면 `--resume --overwrite`를 명시합니다. 하나라도 실패하면 종료 코드 1, 설정 오류는 2입니다.
호환 entry point `uv run python scripts/fitparse.py /path/to/activity.fit`도 실제 Parquet를 생성합니다.

이 명령은 로컬 변환만 수행합니다. 아래 활동 JSON 가져오기는 별도 명령이며 공식 Garmin 자동 수집은 아직 없습니다.

## 비공식 개인 Garmin 다운로드 (`fetch`)

`workout-manager fetch`는 **공식 Garmin 연동이 아닙니다.** 사용자가 자기 계정의 자기 활동을 ORIGINAL FIT로
내려받아 위 `convert`에 넣기 위한 비공식 보조 경로이며, 문서화되지 않은 Garmin Connect endpoint를 사용합니다.
Garmin 약관 위반 가능성, 계정 조치, Garmin의 endpoint 변경 시 즉시 중단을 전제로 합니다. 로그인은 라이브러리
소스에 하드코딩된 Garmin 자체 앱 client 식별자(`GCM_ANDROID_DARK`, `GCM_IOS_DARK`, `GarminConnect`)를 쓰고,
`curl_cffi`의 `impersonate="chrome"`으로 브라우저와 유사한 TLS 지문을 제시해 봇 차단을 통과합니다.
타인 계정에 사용하지 않습니다.

이 경로는 선택 의존성입니다. `convert`/`export-activity`는 이것 없이 그대로 동작하며, 기본 `uv sync`는
스크래핑 라이브러리와 `curl_cffi`를 설치하지 않습니다.

```bash
uv sync --extra garmin   # 이 명령에만 필요합니다. 미설치 시 설치 방법을 안내하고 종료합니다.
export GARMIN_EMAIL=...   # 자격 증명은 CLI 인자로 받지 않습니다. 미설정 시 대화형으로 입력합니다.
uv run workout-manager fetch --output-dir /path/to/fit-input --start 2026-09-01 --end 2026-09-21 --limit 20 --execute
```

`--start`/`--end`/`--limit`은 필수이며 최대 366일·200건입니다. 경계는 자격 증명을 읽기 전에 검증합니다.
`--execute` 없이는 네트워크에 접근하지 않고 CI에서는 거부합니다. 요청은 직렬이며 최소 간격 기본 2초
(유한한 값이어야 하며 `nan`은 거부합니다). **목록·다운로드**에서 429를 만나면 재시도 없이 중단합니다.
**로그인은 예외입니다**: `garminconnect` 0.3.16은 429 뒤에도 다음 impersonation과 전략으로 계속 시도하며,
이는 라이브러리 내부 동작이라 이 명령이 막지 못합니다.

token 파일은 로그인 전에 0600으로 미리 만들고 로그인 성공·실패·중단 모두에서 다시 확인하며, 0600을
보장할 수 없으면 파일을 지우고 실행을 거부합니다(지우지 못하면 그 사실을 그대로 알립니다). token 경로는
상위 경로까지 symlink를 거부합니다. 다른 host로의 redirect는 따라가지 않고 거부하며, 응답은 chunk 단위로
64 MiB까지만 읽습니다. 이 정책은 장수명 API 세션 두 개와 DI token 교환에 적용되며, **로그인 전략이 내부에서
만드는 세션에는 적용되지 않습니다.** 오류 문구와 라이브러리 자체 로그 모두 scrubbing을 거치지만 **best effort이며 보장이 아닙니다**
(키워드 없는 짧은 토큰이나 변형된 값은 잡지 못합니다). 비밀번호는 8자 이상이어야 합니다(그보다 짧으면 provider 오류에서 안전하게 지울 수 없어
거부합니다). 다운로드는 CRC까지 검증한 뒤에만 성공으로 기록하고, 실패는 활동별로
격리해 `download-manifest.json`에 남기며 재실행 시 검증된 파일은 건너뜁니다. provider 접근은 두 개의 읽기
호출만 노출하는 wrapper를 거칩니다 — **실수 방지 장치이며 보안 경계가 아닙니다.** 같은 프로세스의 코드는
모듈 전역과 예외 traceback으로 provider에 접근할 수 있습니다. 자세한 내용과 검증 한계는
[구현 기록](docs/implementation/progress/garmin-unofficial-fetch.md), 공식 전환 설계는
[전환 문서](docs/implementation/research/garmin-official-transition.md)를 참고합니다.

## API·DB 기반

`apps/api`는 인증·동의 port를 주입받는 Fastify factory, `packages/server/persistence`는
PostgreSQL migration/RLS·동의 revision·outbox 기반입니다. 표준 OIDC bootstrap과 계정/동의 화면도 구현했습니다.

```bash
pnpm test:integration
```

[검증·설계 범위](docs/implementation/progress/M0-05.md)를 참고하세요.

## 두 shell 실행

같은 ActivityList와 scoped Zustand/Query provider를 Next와 Vite에 조합했습니다.
현재 화면의 활동·계정은 개발 fixture이며 실제 로그인이나 API 적재 결과가 아닙니다.

```bash
pnpm dev:web         # http://127.0.0.1:3100
pnpm dev:mobile-web  # http://127.0.0.1:4200
pnpm build
pnpm test:shells     # 위 production build 후, 두 포트가 비어 있을 때 실행
```

[검증 기록](docs/implementation/progress/M0-03.md): 계정/세션 초기화, SSR, 재시도와 메모 보존,
Playwright 및 Aside 실 브라우저 확인. UI controls·semantic tokens·Storybook·반응형 생성기는 [M0-04](docs/implementation/progress/M0-04.md)에 구현했습니다.

```bash
pnpm dev:storybook
pnpm check:generated
```

두 shell의 `/ui-spike`와 Storybook에서 지도·차트·표·편집기·정렬·분할 패널의 합성 데이터
검증 화면을 실행할 수 있습니다. [M0-06b 기록](docs/implementation/progress/M0-06b.md)에
실행 범위와 남은 routing coverage·실기기 검증을 구분했습니다.

## 표준 OIDC 로그인·AI 동의

`/account`에서 표준 OIDC 로그인과 AI 동의 허용/철회, 로그아웃을 제공합니다.
같은 설정 화면에서 별도의 **Garmin 연결** OAuth 흐름을 제공합니다. 앱 로그인은 OIDC로 유지하며,
Garmin 앱 자격 증명이 없으면 연결 시작은 비활성화됩니다. [Garmin 설정·철회 worker](docs/implementation/garmin-setup.md)를
참고하세요. 로컬 OAuth fixture 검증과 실제 Garmin 연동은 구분하며 자동 활동 수집은 아직 연결하지 않았습니다.
실제 공급자 설정·DB grants는 [OIDC 설정](docs/implementation/oidc-setup.md),
검증 결과와 범위는 [M1-01](docs/implementation/progress/M1-01.md)을 참고하세요.
홈 화면의 개발 활동은 아직 인증된 실제 기록과 연결되지 않았습니다.

```bash
pnpm build
pnpm test:identity  # 독립 임시 PostgreSQL + 로컬 OIDC + Fastify + production Next
pnpm dev:api        # 실제 공급자/DB 환경변수 구성 후
```

### Identity E2E diagnostics

재현되지 않는 브라우저 정지를 추적할 때만 켭니다. 끄면(기본) 설정 파일이 진단 모듈을 import만 하고 설치하지 않으며,
reporter도 추가하지 않으므로 실행이 느려지지 않습니다.

```bash
IDENTITY_E2E_DIAGNOSTICS=1 pnpm test:identity [spec.ts:line ...]
```

- worker마다 Playwright의 `pw:api`·`pw:protocol`·`pw:browser` 로그(`DEBUG=pw:…`와 같은 내용)와 1초 간격의
  worker event-loop 지연을 `playwright-report/identity-diagnostics/<run id>/protocol-<pid>.log`에 남깁니다.
  CDP가 옮기는 응답 본문·`page.evaluate` 인자와 결과도 함께 기록되며, 한 줄(메시지 하나)은 2,000자까지 남깁니다.
  cookie·CSRF·session·token·password 값과 OIDC code·state·nonce는 가립니다(`tests/identity/diagnostics/protocol-lines.ts`).
  가리지 못하는 형태가 있을 수 있으므로 결과를 공유하기 전에 확인하세요.
- reporter가 2초마다 load average, 여유 메모리, OS 메모리 압박 수준, CPU 상위 프로세스를 기록합니다.
- 실패한 시험마다 `<run id>/<spec>-<line>-<title>-retry<n>/`에 `protocol.log`(그 시험의 줄만),
  `pressure.log`(시작 30초 전부터 끝까지), `summary.txt`를 씁니다. `summary.txt`에는 응답이 없던 CDP 명령,
  1초 이상 걸린 CDP 명령, worker의 최대 event-loop 지연, 압박 최고치, trace 경로가 들어갑니다.
  trace는 설정의 `retain-on-failure`로 `test-results/`에 남습니다. **trace에는 진단과 별개로 session cookie 등이 가려지지
  않은 채 들어 있습니다**(Playwright 기본 동작).
- 판독: CDP 명령이 보내졌는데 답이 없고 worker 지연이 작으면 브라우저(renderer) 쪽 정지이고, worker 지연이
  크면 test worker 프로세스가 CPU를 받지 못한 것입니다. 압박 기록으로 기계 전체의 부하를 함께 봅니다.
- 명령줄에 `--reporter`를 주면 설정의 reporter 목록이 대체되어 진단 reporter가 빠집니다(worker 기록은 남지만
  실패별 요약은 만들어지지 않습니다). 진단을 쓸 때는 `--reporter`를 주지 마세요.
- 실패가 없으면 원본 `protocol-*.log`를 지웁니다. 실패가 있으면 원본(시험 하나에 약 1 MB)도 남기므로 다 본 뒤
  디렉터리를 지우세요.

외부 AI 전송은 연결되지 않았습니다. 동의 저장 성공을 AI 코칭 기능의 구현 완료로 간주하지 않습니다.

## 수동 계획·활동 가져오기

로그인 후 `/planner`에서 기간과 세션을 편집하고 미리보기를 확인하면 새 계획 버전이 저장됩니다.
미저장 초안은 메모리에만 유지됩니다. [M1-02 검증 기록](docs/implementation/progress/M1-02.md).

```bash
uv run workout-manager export-activity /path/to/activity.fit --output /path/to/activity.json --timezone Asia/Seoul
```

구간·심박·거리 시계열과 출처 세션 평균·최대 심박을 함께 가져오려면 `--include-details`를 추가합니다.
기존 요약 파일은 그대로 지원하며, 상세 파일은 같은 활동의 원본 revision을 갱신합니다.
앱에서 파일을 선택해 미리보기를 확인한 뒤 명시적으로 가져오세요.

새 상세 파일은 export v3 / details v2 / source revision 3입니다. 기존 export v1/v2도 읽습니다.
활동 상세의 페이스는 원본과 정정 반영 거리·시간으로 각각 계산하며 시간 정의를 함께 표시합니다.
세션 심박은 출처 관측값이며 레코드·랩으로 추정하지 않습니다.
[요약 형식·검증 기록](docs/implementation/progress/M1-04as.md).

```bash
uv run workout-manager export-activity /path/to/activity.fit --output /path/to/activity-details.json --timezone Asia/Seoul --include-details
```

세션별 record 20,000개·lap 1,000개, 전체 JSON 파일 16 MiB까지 지원합니다.
여러 세션의 관측 소속이 모호하거나 상한을 넘으면 데이터를 잘라내지 않고 실패합니다.
현재 상세 형식에는 GPS가 포함되지 않습니다. [상세 수입 검증 기록](docs/implementation/progress/M1-04x.md).

`/activities`에서 JSON을 선택하고 확인하면 활동을 가져옵니다. 같은 파일의 재수입, 원본과 정정 분리,
로컬 삭제 후 재수입 억제를 지원합니다. timezone 생략은 미확인, 기존 출력 파일은 덮어쓰지 않습니다.
공식 Garmin sync는 후속 작업입니다. [M1-03 검증 기록](docs/implementation/progress/M1-03.md).

## 내 데이터·운영 상태

`/account`에서 내부 처리 상태, 최근 작업 이력, 현재 계정의 JSON 내보내기와 앱 계정 삭제를 제공합니다.
삭제는 확인 문구 입력과 명시적 버튼을 요구하며 외부 로그인 공급자의 계정을 삭제하지 않습니다.
[M1-06a 구현·검증](docs/implementation/progress/M1-06a.md)과 [복구 실행 기록](docs/implementation/operations-runbook.md)을 참고하세요.

```bash
pnpm exec tsx scripts/backup-restore-drill.mts --execute # 합성 자료로 만든 새 임시 PostgreSQL만 사용
```
