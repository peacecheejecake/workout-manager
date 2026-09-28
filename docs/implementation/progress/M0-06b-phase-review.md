# M0-06b ODbL 후속 phase 독립 검토

기준 `main` 및 merge base `82f2919293a54430755bb3a89bdf3c367914e181` →
`phase/m0-06b` HEAD `952cddaa45541ceee03a890e5d6bc259afe0c352`의 전체 28파일 diff를
별도 Codex CLI `gpt-6-sol` high, read-only sandbox에서 검토했다. 작업 트리는 깨끗했고
변경된 미추적 파일은 없었다. 판정은 **APPROVE**이며, 새 차단 지적은 없었다.

검토 범위는 GPX 이름 제외·위치 trim·개인정보 메타데이터 경계, 공개 원문 다운로드의
활성 배포 신원과 manifest SHA-256, 경로·symlink·크기 제한, 계약·패키지 경계·회귀
시험이었다. 독립 검토자는 명령을 다시 실행하지 않았고 아래 root 결과를 코드와 대조했다.

- 잠금 파일 고정 설치, 생성물·전체 Prettier·ESLint·TypeScript 34/34, 전체 build 15/15 통과.
- 단위·컴포넌트 4,242 통과·7건 건너뜀. 일반 sandbox의 첫 실행에서 로컬 fixture 접속
  제한과 Python 환경 부재로 35건 실패·27건 건너뜀을 기록했고, 로컬 접속과 Python을
  연결한 재실행에서 위 결과를 확인했다. 앞선 실패를 통과로 바꾸지 않는다.
- 격리 PostgreSQL 통합 844/844, 전체 identity 브라우저 두 실행 각각
  306 통과·13건 건너뜀(14.6분, 14.5분). GPX API 집중 39/39, 공개 링크의
  Next·Vite 익명 fixture 다운로드와 SHA-256 확인 4/4.
- Aside 업데이트는 `fetch failed`여서 UI 검사는 Playwright를 사용했다.
  실제 대용량 배포 산출물 재빌드와 HTTPS 공개 호스팅은 실행하지 않았다.

검토자는 Vite 운영 호스트가 `/map/basemap/**`를 직접 서빙할 경우 Next 동적 route의
활성 포인터·해시 검사를 우회할 수 있으므로, 배포 환경에서 동일한 제한을 확인하라고
남겼다. 이는 `EXT-HOSTING`의 실제 배포 수용 조건으로 추적한다. iPhone의 OS IME·물리
touch·성능 증거는 별도 M0-06b 외부 gate이며, 과거 `P8-coverage: failed` 기록은 유지한다.

이 승인 기록과 외부 gate 문구를 추가한 phase HEAD는 새 diff이므로 최종 읽기 전용
검토 갱신 후에만 `main`으로 fast-forward한다.
