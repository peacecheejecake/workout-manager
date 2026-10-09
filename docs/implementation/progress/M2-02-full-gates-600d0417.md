# M2-02 전체 검증 갱신 · 2026-10-09

검증 대상 HEAD는 `600d04179e753f64ada31501802a15b137eb9920`이다. main은 `1d55735865c827f3870e6fa4b2effd418ed63677`이며 독립 phase review와 병합은 미완료다. 보호된 EXT-HOSTING WIP는 이번 기록에 포함하지 않는다.

## 전체 정적·단위 검증

Node 24.12.0, pnpm 10.34.5에서 frozen/offline install, generated check, lint, typecheck, build, format을 실제 실행해 여섯 명령 모두 exit 0을 확인했다. 결과 SHA-256: `a7d565c670a03f46c2decab77a5034fb12bb722c524cb401dab28d577eb2f252`.

빌드 이후 전체 단위 시험 R9는 588개 파일, 9,509 통과·5 skip·실패 0/9,514 등록, exit 0이다. 소스·런타임·별도 geo 입력의 전후 drift는 0이다. 결과 SHA-256: `0594457a2b2395f4699e6d4b7ca87c5da6d6e9920bc4ed4cbc1c6f1c0446f4f5`. 기존 실패·skip을 소급 변경하지 않는다.

## 전체 normal PostgreSQL 17.6 · FAILED

새 소유 Docker tmpfs 클러스터에서 원 `pnpm test:integration`과 원 config/시간 제한/등록 roster를 실행했다. 업그레이드 선행은 1/1 통과다. 일반 모음은 304개 파일 중 297 통과·4 실패·3 skip이며, 시험은 **3,063 통과·7 실패·14 skip/3,084 등록**이다. 실제 terminal exit 1, 소요 약 36.9분이다. 입력 1,093개 전후 불변과 normal registry 107·FORCE RLS 확인은 전체 시험 성공을 뜻하지 않는다.

실패 위치는 `manual-pooled-dense-application`, `restore-check-in-exact-replay`, `restore-gallery-media-exact-replay`, `restore-resource-exact-replay` 네 파일이다. stack 위치 수를 실패 case 수로 세지 않는다. 현재 유한 오류 기록만으로 timeout·시계 정밀도 등 원인을 확정하지 않는다. 네 원본 전체 파일의 실제 진단과 근거에 따른 수정 후 전체 모음 갱신이 필요하다.

시험 뒤 DB 1·역할 17·slot 0이었다. 역할 잔존을 0으로 기록하지 않는다. 정확한 소유 container만 제거했고 정체를 모르는 역할을 개별 삭제하지 않았다. finite-terminal SHA-256 `25a295f74765e3127b23bff897b6b9a017f7845617a10a1a5ecc17ac13ded765`, lifecycle SHA-256 `14a5816dd8d3be782d45d959cea168f2475ea3bd24363e4d2b8e00ea79a76e4d`. 원본 오류/SQL/개인 자료는 보존하지 않고 스트림 해시·유한 결과만 기록했다.

## 별도 로컬 PostgreSQL 17.11 계약 검증

원 harness/config로 logical 1/1, pgoutput 24/24, foundation 13/13을 실제 확인했다. 세 실행 모두 입력 불변·exit 0·소유 scratch 정리 및 잔존 0이다. 이는 별도 계약 범위이며 위 17.6 전체 normal 실패를 해결하지 않는다.

logical 첫 v3 실행에서는 시험 1/1이 통과했지만 Node/tsx 캐시 두 디렉터리 잔존으로 wrapper exit 1이었다. 원 기록과 scratch는 보존한다. v4는 컴파일 캐시만 비활성화했고 시험·timeout·동작을 변경하지 않았다. 이 후속 성공을 첫 wrapper 실패의 삭제로 취급하지 않는다.

## 남은 gate

현재 whole normal은 failed이며 whole identity 두 회차, 독립 phase review, main 통합은 미완료다. 운영 백업·복원·HTTPS와 provider 수용도 별도다. 사용자 결정대로 모든 구현 후 실제 제품 앱으로 최종 iPhone 시험을 진행하며 미실행 기기 행은 not_executed로 유지한다.

## 네 원본 파일 실제 후속 진단

고정된 원본 소스/시간 제한으로 새 PostgreSQL 17.6에서 네 실패 파일 전체를 실행했다. **24/24 통과·실패/skip 0**, 네 module 전부 관측, 실제 exit 0, 약 122초였다. 유한 reporter SHA-256 `cb16df8fb90418b08916efb9b8744acd596ec23738e09e4a580c3b71f53e066b`. 소스 입력 전후 불변과 DB 1·역할 1·slot 0, pool 종료·정확 소유 container 제거를 확인했다.

이 실행에는 canonical preinstall/upgrade와 나머지 300파일의 선행 상태가 없다. 전체 모음 실패를 해결하거나 시계/timeout을 원인으로 확정하지 않는다. allowlisted dense 이벤트 1,030개에서 query error는 관측되지 않았으며 일부 workflow 약 41.7초·review 약 41.2초였다. 좁은 성공에 맞춰 guard·timeout·SQL·fixture를 변경하지 않는다. 원 전체 모음 재실행과 유한 관측을 통해 차이를 조사한다.

## 전체 normal 후속 v6 · FAILED

동일 원 `pnpm test:integration`과 등록 roster·config·시간 제한으로 새 소유 PostgreSQL 17.6 클러스터에서 실제 재실행했다. 업그레이드 1/1 통과 후 일반 모음은 **300파일 통과·1파일 실패·3파일 skip**, **3,069통과·1실패·14skip/3,084등록**이었다. 약 34.6분, terminal exit 1이다. 실패 위치는 `global-openai-budget.integration.test.ts:693:5`의 REASSIGN/retarget 시험이며 원인은 아직 확정하지 않는다. 이전 v5의 네 파일 실패와 별도 24/24 좁은 진단 성공은 그대로 보존한다.

소스 1,093개 freeze SHA `3ac2e0d5e2a0510446acdc6a9a434c5c7511974d5b33511664cb573998fa0497`는 전후 동일했다. normal registry 107/FORCE RLS 확인, 시험 뒤 역할 17·DB 1·slot 0, pool 종료와 정확 소유 container 제거를 확인했다. 원 오류 메시지·SQL·payload는 저장하지 않았고 유한 결과와 스트림 SHA만 보존했다. finite-terminal SHA `82f678a1c48062cb7d6f1511d04424bafc3fc95116cecb00d0063889e3110364`, lifecycle SHA `115ddd9df067c46f39b939ce389a57f3f032715caaf7cc23aa739e803c44e9ab`. 두 스트림은 drain 완료이며 dense/restore/timeout allowlisted marker는 0이다. 해당 marker 부재가 원인 부재나 실패 해결을 증명하지 않는다. 전체 normal·identity 두 회차·독립 phase review/main·운영/최종 제품 실기기 gate는 여전히 미완료다.
