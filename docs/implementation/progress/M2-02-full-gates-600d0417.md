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
