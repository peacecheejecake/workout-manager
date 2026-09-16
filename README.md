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

이 명령은 로컬 변환만 수행합니다. 아래 활동 JSON 가져오기는 별도 명령이며 Garmin 자동 다운로드는 아직 없습니다.

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
실제 공급자 설정·DB grants는 [OIDC 설정](docs/implementation/oidc-setup.md),
검증 결과와 범위는 [M1-01](docs/implementation/progress/M1-01.md)을 참고하세요.
홈 화면의 개발 활동은 아직 인증된 실제 기록과 연결되지 않았습니다.

```bash
pnpm build
pnpm test:identity  # 독립 임시 PostgreSQL + 로컬 OIDC + Fastify + production Next
pnpm dev:api        # 실제 공급자/DB 환경변수 구성 후
```

외부 AI 전송은 연결되지 않았습니다. 동의 저장 성공을 AI 코칭 기능의 구현 완료로 간주하지 않습니다.

## 수동 계획·활동 가져오기

로그인 후 `/planner`에서 기간과 세션을 편집하고 미리보기를 확인하면 새 계획 버전이 저장됩니다.
미저장 초안은 메모리에만 유지됩니다. [M1-02 검증 기록](docs/implementation/progress/M1-02.md).

```bash
uv run workout-manager export-activity /path/to/activity.fit --output /path/to/activity.json --timezone Asia/Seoul
```

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
