# M2-03 S17 후속 구현

## 2026-10-09 요구 대조

기존 M2-03 완료는 당시 upload/private 원본·metadata·삭제/cleanup core 수용이다. 기존 기록의 미구현 목록과 S17/V2-F21/V2-A36을 대조하여 전체 viewer·앨범/날짜/코스 탐색·파생물 처리를 M2-03a~c로 명시한다. 원 완료 증거를 소급 변경하거나 미실행을 통과로 바꾸지 않는다. 전체 화면 M2-06이 세 후속을 요구하여 빠진 제품 기능이 출시 판정에서 누락되지 않게 한다.

- M2-03a: 자막 연결/선택/없음, 속도·fullscreen/inline, swipe와 버튼/키보드 대안, 실제 codec 오류/복구, private URL 수명과 삭제 무효화.
- M2-03b: 앨범 관리와 날짜/코스 탐색, tenant·timezone/null·paging 및 export/erase.
- M2-03c: 원본 불변/파생 lineage, EXIF/orientation·thumbnail/transcoding, 유한 worker 예산·처리 상태·삭제/복원/재시도 억제.

원본은 [M2-03 기록](M2-03.md)의 미구현 항목과 [화면 S17](../../.pre/01_product_screen_spec.md), [V2 요구/수용](../../.pre/05_implementation_requirements.md)을 따른다. 자동 자막 생성, 범용 carousel 설치, token streaming 또는 특정 미채택 후보 패키지의 설치를 추가 의무로 만들지 않는다. 현재 HTML video controls 존재만으로 host별 전체 재생 기능·decoder 오류 수용을 주장하지 않는다.

코드는 별도 phase/m2-03에, 공통 계약/DDL/registry는 Root가 직렬 배정한다. 준비 단계의 코드/모형은 실제 HTTP·저장·삭제/복원 수용을 대신하지 않는다. 실제 제품 앱 실기기 수용은 모든 구현 뒤 [최종 제품 계획](../device-validation-plan.md)에 따라 M3-03b에서 진행한다.
