# M2-01k · P5-states 남은 상태 재검증

기준: `phase/m2-01k` `88cf0ed`. 이전
`M2-01k-map-states-addendum.md`의 **partial** 판정 이후 남아 있던
`오류`, `GPS 없음`, `WebGL unavailable` 세 상태를 현재 트리에서 다시 실행했다.
과거 판정과 당시 실행 기록은 그대로 둔다.

## 두 셸의 실제 화면

Playwright Chromium, fixture OIDC, 격리 PostgreSQL과 실제 화면을 사용했다.
Next와 Vite 모두 아래 세 시험이 통과했다(**6/6**).

| 상태            | 현재 트리의 단언                                                                                                                                                                               | 시험                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| GPS 없음        | 위치 없는 합성 FIT을 API에 저장하고 route 탭으로 이동한다. 서버 `map_path` 좌표·표본 ID가 비어 있으며, 화면에 이유와 요약이 나타나고 MapView·canvas·렌더된 선은 생기지 않는다.                 | `activity-track-no-position.spec.ts` |
| 지도 오류       | MapLibre worker 요청을 막는다. 코스·저장된 활동·로컬 미리보기 세 화면에서 `not-drawn`과 전용 오류 문구, 렌더된 선 0개 및 좌표/표본 대안을 단언한다. 어느 화면도 선을 그렸다고 보고하지 않는다. | `map-render.spec.ts`                 |
| WebGL 사용 불가 | canvas가 WebGL context를 반환하지 않는 브라우저로 코스 화면을 연다. `unavailable`과 WebGL 전용 문구가 나타난다.                                                                                | `map-render.spec.ts`                 |

각 핵심을 깨는 임시 제품 변이를 넣고 두 셸을 다시 빌드했다. 위치 표본 수가
0이어도 MapView를 mount하도록 바꾸면 GPS 없음 시험이 **2/2 실패**했고,
`not-drawn`의 오류 문구를 `지도 준비 중`으로 바꾸면 오류 시험이 **2/2 실패**했다.
WebGL 불가의 문구를 같은 준비 중 문구로 바꾸면 WebGL 시험도 **2/2 실패**했다.
각 실패는 겨냥한 화면 단언에서 발생했다. 세 변이를 모두 되돌리고 두 셸을
다시 빌드한 뒤 같은 여섯 시험 **6/6 통과**를 확인했다. 제품 파일에는 diff가
남지 않았다.

앞선 `M2-01k-c1`의 부분 기록·배경 없음·저장 실패의 실제 브라우저 단언과
PR1/NB1/SF1–SF3 결함 변이, `M2-01k-map-states-addendum.md`의
미계산·계산 중·stale 상태 흐름과 stale 결함 변이를 합치면 요구 원문에 적힌
아홉 상태가 각각 구별된다. 이에 `P5-states`만 **partial → passed**로
재판정한다. 요구 매트릭스 합계는 passed 88, partial 17, failed 1,
not_executed 4다. 실제 배경 지도 배포가 없는 이 환경에서 그 배포가 필요한
시험 두 개는 skipped이며, 이 판정의 통과 증거로 세지 않는다.

이 검증은 운영 OIDC·실기기 지도/WebGL·HealthKit 증거가 아니다.
`R-S09` chart/map zoom 공유는 계속 partial이고 외부 `not_executed` 행도
유지한다. M2-01k 부모와 phase 독립 검토는 완료되지 않았다.
