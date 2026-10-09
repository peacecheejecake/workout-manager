# M0-06b shared table virtualization kit

Planning의 framework adapter를 `@workout/table-kit`의 작은 public subpath로 추출했다.
Core source는 이전 구현과 byte equal이며 private adapter는 public re-export로 바꿨다.
Planning의 도메인 store·선택·URL·승인과 기존 viewport 호출 ABI는 유지한다.
공통 hook은 전체 ordered roster, 동적 측정과 focus range, 명시 virtual/all mode 및
caller가 소유한 scroll anchor 상태를 사용한다. Singleton이나 개인 저장소는 추가하지 않는다.

## 실제 검증 · 2026-10-09

Agent kit 5개와 기존 planning 27개 시험: 32/32, skip 0, exit 0.
Kit/planning typecheck와 scoped lint/format도 exit 0이다. Root가 source·bridge·manifest·
lock diff를 읽고 같은 4파일을 재실행했다: **32/32**, skip 0, exit 0, 2.39s.
Root의 manifest/lock format 검사와 offline frozen install도 exit 0이었다.
기존 planning 시험 3파일의 원문은 유지한다.

첫 설치의 non-TTY abort와 offline metadata 부재는 실패로 보존했다. 기존 설치의 store를
재사용하고 이미 고정된 planning React/virtual-core lock 항목만 새 importer에 재사용해
frozen offline 설치를 검증했다. 새 외부 library 버전이나 integrity를 만들지 않았다.

Agent의 구 Node 0-case 실패, 10k all-DOM jsdom timeout, lint 오류 및 format 도중 실행도
`/private/tmp/wm-table-kit-applied-final-freeze-20261009.json`에 분리했다. 최종 all-mode
unit은 hook이 반환하는 10,000행 전체 keys·indices·null/zero를 검증한다. 실제 전체 DOM
reading mode의 성능·접근성 검증은 별도 consumer/browser 수용이며 아직 미실행이다.

Geometry stub 기반 unit은 실제 viewport·native touch 증거가 아니다. 원 1,000행 spike와
그 단언은 유지한다. 새 10k consumer·두 웹 호스트, 전체 M0 phase 검토와 마지막 실제
제품 iPhone 수용은 남아 있다.
