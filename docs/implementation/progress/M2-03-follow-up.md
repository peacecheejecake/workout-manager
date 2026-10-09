# M2-03 S17 후속 구현

## 2026-10-09 요구 대조

기존 M2-03 완료는 당시 upload/private 원본·metadata·삭제/cleanup core 수용이다. 기존 기록의 미구현 목록과 S17/V2-F21/V2-A36을 대조하여 전체 viewer·앨범/날짜/코스 탐색·파생물 처리를 M2-03a~c로 명시한다. 원 완료 증거를 소급 변경하거나 미실행을 통과로 바꾸지 않는다. 전체 화면 M2-06이 세 후속을 요구하여 빠진 제품 기능이 출시 판정에서 누락되지 않게 한다.

- M2-03a: 자막 연결/선택/없음, 속도·fullscreen/inline, swipe와 버튼/키보드 대안, 실제 codec 오류/복구, private URL 수명과 삭제 무효화.
- M2-03b: 앨범 관리와 날짜/코스 탐색, tenant·timezone/null·paging 및 export/erase.
- M2-03c: 원본 불변/파생 lineage, EXIF/orientation·thumbnail/transcoding, 유한 worker 예산·처리 상태·삭제/복원/재시도 억제.

원본은 [M2-03 기록](M2-03.md)의 미구현 항목과 [화면 S17](../../.pre/01_product_screen_spec.md), [V2 요구/수용](../../.pre/05_implementation_requirements.md)을 따른다. 자동 자막 생성, 범용 carousel 설치, token streaming 또는 특정 미채택 후보 패키지의 설치를 추가 의무로 만들지 않는다. 현재 HTML video controls 존재만으로 host별 전체 재생 기능·decoder 오류 수용을 주장하지 않는다.

코드는 별도 phase/m2-03에, 공통 계약/DDL/registry는 Root가 직렬 배정한다. 준비 단계의 코드/모형은 실제 HTTP·저장·삭제/복원 수용을 대신하지 않는다. 실제 제품 앱 실기기 수용은 모든 구현 뒤 [최종 제품 계획](../device-validation-plan.md)에 따라 M3-03b에서 진행한다.

## 첫 구현 slice · 2026-10-09

별도 phase/m2-03에서 a의 viewer·timed subtitle 응답 계약/포트와 b의 앨범/날짜/정확 코스 버전·keyset navigation 계약을 병렬 구현했다. b의 계약 단위17/17 및 TS/lint/format 실제 로그를 Root가 확인했고 기존 gallery DTO는 변경하지 않았다. a는 agent가 집중56/56·계약 build·소비자 TS/lint/format을 보고했으며 Root 전체 파일 검토와 실제 제품 브라우저 수용은 아직 미완료다. 공통 contracts public subpath 둘은 Root가 직렬 등록했다. 이 codec/컴포넌트 slice로 실제 owned album/자막 저장·HTTP·삭제/export/restore 또는 파생물 수용을 완료하지 않는다. a/b 상태는 in_progress, c는 not_started다. main 및 physical test는 변경하지 않았다.
