# M1c-01~03 · 운영 런타임 권한 합류

상태: **완료 (권한 코드·격리 DB 검증)**. 2026-09-19 사용자 승인에 따라 루틴,
스트레칭, 회복의 새 원장에 필요한 최소 runtime DML helper를 추가했다. 기존
임시 E2E fixture의 개별 GRANT도 같은 helper 호출로 교체해 테스트와 배포 경로가
같은 권한 집합을 사용한다. 실제 운영 DB에 적용하는 배포 작업은 수행하지 않았다.

- 불변 version·revision·receipt에는 SELECT·INSERT만 허용한다.
- 현재 head·run·timer·log에는 SELECT·INSERT·UPDATE만 허용한다.
- 새 테이블에 DELETE는 허용하지 않는다. 모든 새 테이블의 FORCE RLS를 유지한다.
- Migration 025 뒤 `grantOperations`를 재실행해 최신
  `public.erase_account(text)` wrapper의 EXECUTE를 runtime 역할에 부여한다.
  이전 wrapper 진입점은 허용하지 않는다.
- `createDatabase`의 소유자 역할 거절 검사에 새 원장 테이블을 추가했다.

[배포 명령](../oidc-setup.md#m1c-루틴스트레칭회복-운영-권한)과 각
[루틴](M1c-01.md)·[스트레칭](M1c-02.md)·[회복](M1c-03.md) 기록에 권한 범위와
후속 한계를 남겼다. 세 task는 수동 core와 권한 코드 범위에서 완료했고,
네 도메인 원자 승인 M1c-04 및 실제 운영 배포는 별개다.

검증: 전체 `pnpm check`의 포맷·lint·24개 패키지 타입 검사와 191개 파일/1,978개
단위 테스트, 격리 PostgreSQL 34개 파일/276개 테스트, 전체 production build,
실제 OIDC·임시 PostgreSQL·Chromium 루틴/스트레칭/회복 E2E 3개가 통과했다.
권한 실DB 시험은 19개 새 테이블의 DML·FORCE RLS, 타인 기록 접근 거절,
최신 말소 함수 실행과 이전 wrapper 직접 실행 거절을 확인했다.

Herdr split-pane 독립 리뷰는 base
`77520581ab663bce9c4b44c3c1c391f25b88a72a`와 이 기록 추가 전 staged diff
SHA-256 `7ff0ecd01f0ce62c771d89fbbf7429fef44436b1d1451b2373ffe7bb249fdcb7`를
검토했고 actionable finding이 없었다. 리뷰어는 테스트를 재실행하거나 파일·index를
변경하지 않았다.
