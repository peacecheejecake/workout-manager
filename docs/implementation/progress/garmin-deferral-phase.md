# Garmin·호스팅 범위 분리 phase · 2026-09-27

기준 `main`: `a96bfdc1ea240fe616a762bbc22e265e773ee28d`. 브랜치:
`phase/garmin-deferral`. 공식 Garmin 연동은 [후속 계획](../research/garmin-official-deferred.md)에
보존하고, 활성 그래프의 M2-06은 완료된 소유자 한정 비공식 adapter의 fixture 회귀를
요구한다. `G2`는 내부 준비, `G2-PUBLIC`은 `G2`와 `EXT-HOSTING`을 요구하는 공개 출시
판정이다. `G3`도 `G2-PUBLIC`에 의존한다.

## 검증

- 변경은 규칙의 사용자 승인 범위와 문서·그래프에 한정한다. 앱·브라우저·실제 Garmin·HTTPS
  공급자 시험은 이 phase에서 실행하지 않았고 외부 증거 상태를 통과로 바꾸지 않았다.
- 변경 문서 Prettier 검사, `git diff --check`, JSON 파싱·195개 고유 노드·의존 ID 유효성·
  `G2`/`G2-PUBLIC`/`G3` 선행 조건 검사를 통과했다.

## 독립 phase 검토

1차: 읽기 전용 Codex CLI `gpt-6-sol`, reasoning high. `main`
`a96bfdc1ea240fe616a762bbc22e265e773ee28d` 대비 HEAD
`2281e1384e0884a32da3209bf58c4ee3cfc4723e` 전체 diff를 검토해
**CHANGES_REQUESTED**(P2 두 건)를 받았다.

| 지적                                                 | 현재 내용 평가                                                                                                              |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 공식 OAuth 설명이 비공식 경로의 비밀번호 전달을 가림 | **FIXED**: `README.md`에서 공식 OAuth만 앱이 비밀번호를 받지 않는다고 제한하고 비공식 worker 경로를 명시했다.               |
| 이전 공식 Garmin 출시 조건이 현재형으로 남음         | **FIXED**: `task-graph.md`는 이전 조건으로 표시하고 `task-graph.json`의 `EXT-G-tmp` 역사 결정을 현 G2/G2-PUBLIC과 분리했다. |

2차: 같은 `main` 대비 HEAD `a50e771e690f0f5aac102a0caefc1a909dfcec2f` 전체 diff의
읽기 전용 재검토는 이전 두 지적을 모두 **FIXED**로 확인하고, 운영 안내의 G2 설명
충돌(P2)을 새로 지적해 **CHANGES_REQUESTED**였다. 운영 안내는 현 G2의 fixture 회귀와
공식·실계정 증거를 구분하도록 수정했다. 과거 임시 gate·구현 기록에는 당시 조건임을
표시했다.

3차: 같은 `main` 대비 HEAD `4cb9d3c5cf36bc90e173584f066f1095c994dd27` 전체 diff를
읽기 전용 Codex CLI `gpt-6-sol` high로 다시 검토해 **APPROVE**를 받았다. 이전 지적
세 건은 각각 **FIXED**로 확인됐고 새 차단 지적은 없었다. 검토자는 195개 노드의
ID·의존성·순환과 G2/G2-PUBLIC/G3 조건, `git diff --check`를 확인했다. Prettier 통과는
이 phase 기록에서 확인했고 검토자가 재실행하지 않았다. 브라우저·실제 Garmin·HTTPS
배포 증거는 만들거나 통과로 판정하지 않았다. 이 결과 기록을 추가한 커밋은 승인된
HEAD 뒤의 변경이므로 `main` 병합 전에 검토를 갱신한다.
