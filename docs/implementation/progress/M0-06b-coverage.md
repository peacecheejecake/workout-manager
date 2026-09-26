# M0-06b-coverage · 독립 한국 보행 coverage 검토 (P8-coverage)

기준 HEAD: `a2ab2ec`. 증거 문서: [m0-06b-coverage-review.md](../research/m0-06b-coverage-review.md). 커밋하지 않았다.
`task-graph.json`, 요구 매트릭스, `AGENTS.md`, `CLAUDE.md`, `.geo-build`, `.geo-build-routing`은 바꾸지 않았다.
`.geo-build`는 저장소 루트의 것을 symlink했다(Git 제외). 개인 FIT/GPS, 토큰, 자격 증명은 없다. UI를 바꾸지 않아
브라우저 검증은 해당 없다(Aside·Chrome·Playwright 모두 쓰지 않았다).

## 결과

독립 검토자(Codex CLI, `gpt-6-sol`, reasoning high, read-only sandbox)의 판정은 **`inadequate`**다.
정정 후 총점 68/82, 필수 층 7개 미달, 실격 조건 4건(ACC-MIL-01, ACC-PRV-01, FRY-03, NEG-MIL-02). 검토자는 사전 등록한
기준으로 채점했다. 바꾸고 싶다고 밝힌 기준 두 가지를 적용해도 판정은 같다고 적었다.

## 설계 근거

- **순서가 증거다.** blinded 표본 → 사전 등록(빈 디렉터리, 명령 실행 0건, 02:22:22Z 완료, sha256
  `98ef1ceec76c7039be805c771b6b95fa0698d7eb34f623c3a58ed8c2e28a214b`) → 엔진 실행(02:22:59Z) → 채점(빈 디렉터리,
  세 파일만) → 산술 정정(검토자 본인). 조정자는 어느 단계에서도 채점하지 않았다.
- **표본.** 기존 38쌍 + 새 44쌍 = 82쌍. 필수 층(도심·횡단보도·보행 교량·자동차 전용 교량·계단·공원·접근 시간)은
  각각 4–11쌍, 음성 대조는 16쌍(바다·섬, 군사, 고속도로 상판, 역외, 계약 한도). 서울·부산·대구·광주·대전·수원·
  인천·강원·경북·제주·충남·경남·경기 북부를 덮는다. 새 좌표는 OSM 이름 검색으로 정했고, 엔진 없이 OSM만으로 가까운
  보행 도로 거리를 재서 5개 점을 도로 위로 옮겼다(음성 대조와 TIM-03은 그대로).
- **graph 신원 고정.** 전국 graph `188b65effcc6ef5c`, extract sha256 `848daadc…f4d6284b`(실행 중 다시 계산해 일치),
  실행 전후 graph content·목록 불변.
- **probe 확장(읽기 전용 유지).** `--pairs`(외부 표본, `--report-name` 필수, 정본 이름 거절), `--list-pairs`,
  `street_name` detail, crossing way/node와 시간 조건 way 대조, node 격자 색인.

## 바꾼 파일

| 파일                                                                      | 내용                                                              |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `scripts/probe-routing-korea-coverage.mts`                                | `--pairs`, `--list-pairs`, `street_name`, crossing·시간 조건 대조 |
| `docs/implementation/research/m0-06b-coverage-review.md` (신규)           | 증거 문서                                                         |
| `docs/implementation/research/m0-06b-coverage-review-pairs.json` (신규)   | blinded 표본                                                      |
| `docs/implementation/research/m0-06b-coverage-review-results.json` (신규) | 엔진 결과                                                         |
| `docs/implementation/research/m0-06b-coverage-review-*.txt` (신규 6)      | 사전 등록·채점·정정의 프롬프트와 원문                             |
| `docs/implementation/progress/M0-06b-coverage.md` (신규)                  | 이 문서                                                           |

## 검증

| 항목                                        | 결과                                                                                               |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `uv sync`, `pnpm install --frozen-lockfile` | 통과                                                                                               |
| probe run 1 (lock 안)                       | 82쌍, `problems` [], 12.9 s, 최대 RSS 2.26 GB, load 2.7–3.2                                        |
| probe run 2 (lock 안)                       | run 1과 82쌍 전부 동일(outcome·거리·geometry hash·태그 대조·detail)                                |
| ESLint `--max-warnings 0` (probe)           | 통과                                                                                               |
| strict `tsc --noEmit` (probe)               | 통과(루트 bundler tsconfig를 확장한 임시 설정, `test-results/m0-06b-coverage/tsconfig.probe.json`) |
| `pnpm lint` (ESLint `--max-warnings 0`)     | 통과                                                                                               |
| `pnpm format:check` (마지막)                | 통과                                                                                               |

단위 시험: 제품 코드를 바꾸지 않았다. probe는 증거 수집 스크립트이고 판정 기능이 없어 기능 mutant를 기록하지 않았다.
로그: `test-results/m0-06b-coverage/`(probe run 1·2, Codex 세 로그, Git 제외).

## 제안 매트릭스 판정 (root가 다시 판정한다)

| 행            | 현재         | 제안                  | 근거                                                                                             |
| ------------- | ------------ | --------------------- | ------------------------------------------------------------------------------------------------ |
| `P8-coverage` | not_executed | **failed**            | 게이트 절차를 실제로 수행했고, 독립 검토자가 사전 기준으로 `inadequate` 판정. 통과 근거 없음     |
| `FUT-07-4`    | not_executed | **not_executed 유지** | coverage 부분은 부족 판정. ODbL §4.2/§4.6 이행과 약관 검토는 이 작업 범위 밖이며 수행하지 않았다 |

## 남은 일

1. blocker 결함: NEG-MIL-02(판문점까지 군사 영역을 지나는 경로), ACC-MIL-01(용산기지 영역 15.8 m), FRY-03
   (`foot=no` 교량 기하 대조 — 오대조 여부 확인 필요). 군사 영역 회피는 profile 또는 adapter의 정책 결정이 필요하다.
2. major: STR-04(adapter가 짧은 계단 경로를 `engine_contract_violation`으로 거절, 어느 검사인지 미진단), TIM-01(시간
   조건 way 통과를 알리지 않음), BRG-01(잠수교 사용 미확인). 도선(`route=ferry`)을 보행 경로에 넣는 문제(FRY-01·03,
   BRG-MW-02, NEG-ISL-01·03)도 검토자 채점에서 반복해 나타났다.
3. 결함을 고친 뒤 재검토는 같은 blinded 표본·같은 사전 등록으로 다시 채점받아야 한다(기준 이동 금지).
4. ODbL §4.2/§4.6, 약관 검토(FUT-07-4의 나머지).
5. 이 작업의 커밋 전 peer review(CLAUDE.md 임시 규칙: 구현하지 않은 별도 Claude subagent). 이 노드에서는 받지 않았다.
