# Workout Manager

Adaptive Training Coach 구현 저장소입니다. 제품 명세는 [docs/.pre](docs/.pre/README.md),
실행 순서는 [구현 계획](docs/implementation/README.md)과 [작업 DAG](docs/implementation/task-graph.md)를 따릅니다.

M0-01 개발 도구 기반을 구현하고 로컬 검증을 마쳤습니다. [검증 기록](docs/implementation/progress/M0-01.md)을 참고하세요. React tooling fixture는 테스트·빌드 구성을 검증하는 화면이며
훈련 기록·승인·인증·DB가 연결된 제품 앱이 아닙니다. 공유 runtime 계약과 로컬 FIT batch CLI도 구현했습니다. Python은 별도 uv 환경을 사용합니다.

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
corepack pnpm build          # contracts + tooling fixture production build
corepack pnpm exec playwright install chromium
corepack pnpm test:e2e       # desktop/mobile fixture, 실제 로컬 HTTP
```

`pnpm format`은 관리 대상 파일을 포맷합니다. 제공 설계 원본 `docs/.pre`, vendored skill,
생성물·개인 데이터는 일괄 포맷에서 제외합니다.

`pnpm test:integration`은 M0-05 API/DB 기반 구현 전까지 **실패 종료**하여 미구현 검증을 통과로 오인하지
않게 합니다. CI는 이 검증과 제품 E2E·native gate가 아직 미실행임을 요약에 표시합니다.
각 기능의 구현 단계부터 해당 실제 검증을 필수 CI job으로 추가해야 합니다.

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

이 명령은 로컬 변환만 수행합니다. Garmin 다운로드·인증·제품 DB 적재는 아직 구현하지 않았습니다.
