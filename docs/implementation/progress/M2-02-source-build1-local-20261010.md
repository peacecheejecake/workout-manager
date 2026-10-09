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
