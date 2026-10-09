# M2-02 현재 로컬 전체 검사 · 2026-10-09

검증 입력은 `phase/m2-02`의 `839ce7f2` 기준이다. 아래 결과는 각각 실제 실행이며 과거 실패,
skip와 외부 `not_executed`를 대체하지 않는다. Phase 완료와 독립 검토 승인은 별도다.

## 정적 검사·unit·실DB

Static R3의 offline frozen install/generated/lint/typecheck/build/format/unit 7단계는 각각 exit0다.
Unit은 588파일·9,509통과·5skip이었다. 기록
`/private/tmp/wm-current-static-six-unit-actual-r3-20261009-terminal.json`과 source/lock/proof 입력을
따르며, 앞선 offline 의존성 부재·기본 Node 버전·network sandbox 실패는 보존한다.

전체 PostgreSQL17.6 v10의 upgrade1/1과 normal3,072통과·14skip이 실제 terminal0였다.
Source1093 동결과 소유 자원 정리를 확인한 별도 기록이다. Finite terminal SHA
`397d173b659fdbc29e2ebf46c0342a4b6f35b1dbe96190d42fbdc5c26c6d034a`, lifecycle SHA
`37a101c1b36409de1de853a6ca61b0c038c9708f7edd0dacb90c20a63f7abf12`를 따른다.
이 DB 검사에 후속 EXT-RESTORE/Gallery 별도 브랜치 구성요소를 포함했다고 주장하지 않는다.

## Postbuild canonical identity 두 회차

Root actor handle40875는 실제 두 회차를 끝내고 terminal exit0였다. 각 회차는 original canonical
4개 recipe의 exact358 census를 실행했다: general319통과·12skip, app-consent4통과,
AI-settings-lifecycle1통과, current-manual22통과. 합계 **346통과·12skip**, unexpected/flaky0,
미실행 recipe0다. Source/build/geo 입력 전후가 같고 각 회차 PG170006의 시험 DB/role/slot/client
잔존0, 전체 기본 DB1/role1을 관측했다. Source 동결 중 중앙 파일을 수정하지 않았다.

- Run1 998,592ms, SHA `7dd31ebda2749fcc7a483bc936fbbc25d130546760254a8de4d8f37da6eba37b`.
- Run2 995,290ms, SHA `12308bd172a8748c8dfa934a195546e7078b23819b91983cad731def7daf2db3`.
- Aggregate `/private/tmp/wm-current-identity-postbuild-resume-actual-20261009-result.json` SHA
  `86781e6f4ba86befd6cd1f2f05efca6ab6cb7c9fd8c57ece3825fe503c9fb422`.

Root는 exact owned lifecycle wrapper로 소유권·종료 포트·기본 클러스터 상태를 다시 확인한 뒤
그 컨테이너만 제거했다. 실제 cleanup terminal0, 결과 SHA
`36ee23c69df1cc135d0a609a5ae89b0116611cb5252b04feda5f8a31f0973a91`,
`otherClustersAccessed=false`. 임시 private handoff도 제거했다. 초기 sandbox 포트/Docker 접근
실패는 별도 기록으로 남는다. 둘째 회차가 없던 준비 기록을 두 회차 성공으로 덮어쓰지 않는다.

## 남은 수용

현재 전체 검사 결과를 Root가 로컬 노드 요구사항과 대조하고 phase base/head를 고정해야 한다.
Context-less `gpt-6-sol` high의 독립 phase review는 아직 미완료이며 main은 `1d557358`이다.
Whole239 복원 protocol·운영 백업/복원·HTTPS·실제 IdP 전파·최종 제품 실기기는 남는다.
Local 검사 통과는 운영/출시/복원 authority가 아니며 모든 기존 skip는 skip로 유지한다.
