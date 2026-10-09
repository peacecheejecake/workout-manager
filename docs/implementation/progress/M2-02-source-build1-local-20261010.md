# M2-02 source-build1 등록과 최신 로컬 검증 · 2026-10-10

새 compiler/verifier는 strict bounded manifest와 source/import closure를 검사하며, 이전 V9 asset/pin과 source_drift 거절을 그대로 보존한다. 새 readiness는 실제 catalog 읽기와 COMMIT·정리가 끝난 뒤 source build를 검증한다. profile25 선택은 Root 등록 함수의 고정 import로 결정되며 요청/env로 증거나 fallback을 선택하지 않는다. 개별 command의 admission 검증은 유지한다. configured host·영양 actual HTTP·identity E2E host를 같은 등록 함수로 연결했다.

Root는 전체 source/test 후보와 역사 호환을 읽고 집중136/136 단위 검증을 확인했다. 최종 identity dependency 두줄 변경을 포함해 R5 stage415/current347/runtime340/역사268/entrypoint13/closure185를 독립 대조하고 compiler를 정확1회 실행했다. Asset SHA `b770b9131aa9ba0415ee4f52b1691114263856df219c9b0d610524106c3abf7d`, pin SHA `6b7f4b3ef63148fe5941abe13ed4bd41af44318b5dbfe63e0969df1f955f5718`. 실제 no-args verifier는 verified_build_evidence지만 asset currentFunctionalExecution은 not_executed, configuredWholeExternalAst는 not_verified, authority/restoreAuthority none·approvalAllowed false다. 실제 suite 결과는 별도 증거로 기록하며 역사268을 새 실행으로 바꾸지 않는다.

## 실제 검증

- Full static7: frozen offline install/generated/lint/typecheck/build/format/unit 모두 exit0. Unit601파일·9703통과·5skip·실패0; skip는 통과가 아니다. Source2989 전후동일, jar 동일, build1302→1330 변경을 관측해 PG와 이후 identity용 fresh freeze를 다시 만들었다.
- Actual configured5: 원5개·원시간 제한을 실제 PostgreSQL17.6 normal107/namedV9에서 실행, 5/5통과·skip0·exit0. 초기 성공 cold gate 및 오류/권한 경계의 원 단언 유지.
- Actual nutrition HTTP1: 원1case/90s·setup180s/cleanup30s, 실제 HTTP/CSRF/등록 factory와 DB의 긴 ID·zero/unknown·승인/Intake 보존 단언이 통과, skip0·exit0. 인증만 합성이고 실제 OIDC/proxy 수용이 아니다.
- 두 실제 PG 실행의 source/build/geo 전후동일, DB1/role1/slot0/otherclients0·fixture TMP 잔존0, pool 종료·정확 소유 container 제거를 확인했다. 원 source와 빌드를 시험 중 변경하지 않았다.

- `/private/tmp/wm-source-build1-static-seven-actual-r4-20261010-terminal.json`: SHA `7a271de98aa1f790290f09a2d7866c75d060b1c78138fc02b8a7affb43f10f1c`.
- `/private/tmp/wm-source-build1-configured5-d347ed79-89ee-4285-8b01-c98d41403dbf/finite-command-result.json`: SHA `6f827c3567a2dc00d9ebe5ea617c06643e5ce3890f24c916715d42d687f3b5c2`.
- `/private/tmp/wm-source-build1-nutrition_http1-3f80ff24-fc72-4273-8f93-9dd57a54286f/finite-command-result.json`: SHA `38e7c5c3b54ab1f8ce3ad4d6cde997014a9128d2dccd245d1c4f69478666dfcb`.

## 보존한 실패와 관측 한계

Static 첫 R3는 install exit1·원인 unknown으로 중단했고 이후6명령은 미실행이다. 같은 frozen 소스의 R4 실행만 위 성공이다. PG5 초기 R3는 Docker가 명시 PATH에 없어 ENOENT·실제DB시험0, R4는 unquoted otherClients alias가 실제 otherclients와 달라 시험 전에 중단했다. R4 정리 관측의 containerRemoved false도 원문 유지하고, Root 별도 정확ID inspect로 실제 부재를 확인했다. PATH/field name/No such container 또는 object+empty[] 관측을 고친 R5 실행만 실제5개 성공이다. 시험 단언·시간·scope를 완화하지 않았다. 이전 static/unit/integration/identity 실패·skip와 external 미실행은 모두 보존했다.

전체 integration·canonical identity 두 회차·적용 drill·독립 whole-phase review는 아직 새 source/build에 대해 미완료다. main/push/운영 backup·restore/HTTPS 공개/외부 OIDC/실제 제품 iPhone 수용을 승격하지 않는다. 보호 EXT-HOSTING4줄과 각 stash는 유지한다.

## 2026-10-10 R7 dense 통합 및 실제 전체·좁은 검증

Dense 입력을 invocation마다 bounded plain/strict V3로 한 번 해석해 logical/pooled 형태에 재사용하는 source4·test1을 검증했다. unknown wire 검증·역변환·SQL·권한·원 시간 제한은 유지한다. 순수37/37, persistence typecheck/lint/format exit0, 별도 원 dense8 실제 PG17.6 시험8passed/failed0/skip0이었다. actual `/private/tmp/wm-densediagnostic176-29bf2c15-eec1-4a7b-885e-c7a087e472d5`, finite SHA `6bcdd2b355da12d6c15f2903f16b506e9faef9537791bc7522f6e2544c23670f`; Root 평가 SHA `8065dac29245b4370004915eca89538e2102865f0e73596d50106e85e6e080ff`. first prepare34727ms/public review34187ms는 단일 실행 관측이며 일반 성능 보장은 아니다.

R6 raw asset/pin은 새 역사 archive2에 보존했다. R7 runtime342/history268/closure185/current fixtures10의 새 asset SHA `b202a629313a2823f16d0beccccf0eb96a32b3b5c8ad779c927a12727f696bde`, pin SHA `f5508eb6294b748636511e90093745250cd13824cabfd4143dc470bde59a04a7`. `currentFunctionalExecution:not_executed`, authority/restoreAuthority none, approvalAllowed false는 그대로이며 아래 실제 시험은 별도 증거다.

R7 로컬 static7은 모두 terminal0, unit603파일9719passed/failed0/skip5였다. 첫 install exit1의 원인 unknown 기록은 보존하며 후속 동일 offline install 성공으로 삭제하지 않는다. Root 평가 `/private/tmp/wm-central-r7-static-root-assessment-20261010.json`, SHA `cb32a2605ddd7182606f4f2c74f246e217053b6d0709c11890d7de866088ef53`.

**R7 whole canonical integration은 실패**했다. actual `/private/tmp/wm-source-build1-fullnormalr7-176-d0795906-8e67-4faf-adaf-d1f8324b9143`: upgrade1pass; normal304files 중298pass/3fail/3skip, cases3068pass/4fail/14skip, unhandled1, exit1. 원3파일(check-in/resource exact replay, manual-source personal export)의 실패와 RESTORE 표식은 보존한다. 성공시에만 실행하는 역할 정리가 SUITE_ROLE_CANONICAL_NOT_SUCCESSFUL로 거절됐고 제거 전 roles17/DB1/slot0이었다. 이는 시험 원인으로 단정하지 않는다. source/build4326 전후 동일·poolclose·소유 container 제거는 실제 확인했다. Root 평가 SHA `34eb8ffc2b74bd626338aa2c1b3b56f0f6c985e3d31e7acd658d162a6b85c155`.

같은 원3파일의 후속 좁은 baseline은 실제25cases 중23pass/2fail/skip0였다. manual12와 resource6은 모두 통과했고 check-in7 중 absent233/erasure292가 INVALID_ENTRY로 실패했다. runner의 선언21=실제cases21 가정은 it.each 확장을 누락해 BASELINE_ORIGINAL_21CASES_NOT_OBSERVED를 추가로 발생시켰다. 이 harness 오류와 실제2fail을 분리한다. clock bracket before0..3ms/after-6..0ms만 관측했으며 실패 시각 guard의 원인은 미확정이다. actual `/private/tmp/wm-failedthree176-c013b9f9-8bbc-4877-bfe1-d6c83bc19f10`; Root 평가 SHA `a46697f5575ac53c6ce4efa7ed72933e2e90e4b952446763ebb6c55eebd30c30`. 원본 source 전후동일, 제거 전 roles1/DB1/slot0, poolclose·소유 container 제거를 확인했다. 개인 내보내기 원 broad 실패는 이번에 재현되지 않았다는 의미이며 소급 통과하지 않는다.

HANDOFF의 이전 dense804 위치 설명도 정정한다:804는 원 시험 호출 위치이고 cleanup pending drain은439다. 원 역사 문구는 보존하며 cleanup을804의 원 실패라고 취급하지 않는다. 현재 source에 대한 identity 두 회차·전체 integration 통과·독립 phase review·main 병합은 미완료다. 보호 EXT-HOSTING4줄은 이 작업에 포함하지 않는다. 운영 backup/restore·HTTPS·외부 수용·실제 제품 iPhone·출시 선행조건은 유지한다. 사용자의 주간 잔여량 제한 해제 결정에 따라 로컬 작업을 계속한다.
