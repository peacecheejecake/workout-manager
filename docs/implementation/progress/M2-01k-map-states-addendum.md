# M2-01k · 지도 편집 상태 검증 보완

기준: `phase/m2-01k` `e45c50c`. 이 기록은 `P5-states`의 일부 증거를 보강한다.
이전 매트릭스 판정과 round 기록은 보존하며, 행 판정은 **partial 유지**다.

## 실행한 수용 단언

`tests/identity/map-states.spec.ts`에 Next와 Vite를 각각 실행하는 코스 새 초안
시험을 추가했다. fixture OIDC, 실제 API·격리 PostgreSQL, Playwright Chromium의
지도 renderer를 사용한다. 계산 응답은 실제 `/bff/v1/courses/route-previews` 요청으로
얻고, 브라우저 경계에서 전달만 잠깐 보류해 `computing`을 관찰한다.

- 두 경유점으로 시작한 미계산 초안의 상태는 `uncomputed`이고, 실제 지도 선 역할도
  `uncomputed`다.
- 응답 전달을 보류하는 동안 `computing`이 표시되고 계산 결과 검토 그룹은 없다.
  응답을 놓으면 `computed`와 검토 그룹, renderer의 `candidate` 선이 나타난다.
- 경유지를 다시 편집하면 이전 계산은 현재 초안에 맞지 않는 `stale`로 표시된다.
  검토 그룹이 사라지고 선의 generation이 바뀌며, 실제 renderer의 역할이 다시
  `uncomputed`가 된다. 이 전 과정에서 코스 본문 POST는 0회다.

두 셸을 빌드한 뒤 새 시험 **2/2 통과**(Next 3.5초, Vite 3.3초; 전체 17.4초).
코스 상태 판별에서 `stale`을 의도적으로 `uncomputed`로 바꿔 두 셸을 다시 빌드하자,
같은 시험이 **2/2 실패**했다. 두 실패 모두 상태 단언에서 실제값 `uncomputed`와
기대값 `stale`의 차이를 보였다. 변이를 원복하고 다시 빌드한 뒤 위 2/2 통과를
확인했다. 제품 코드 diff는 남지 않았다.

이번 실행은 fixture OIDC와 routing 엔진을 사용한다. 운영 공급자나 실기기
HealthKit/WKWebView의 증거가 아니다. Aside는 앞선 반응형 검증에서
`aside --update`의 `fetch failed`로 사용할 수 없었고, Chrome에서는 두 셸의
코스 편집 화면을 확인했다. 상태 전환의 실제 브라우저 단언은 Playwright로 수행했다.

전체 `map-states.spec.ts`를 실행하면서 기존 배경 지도 시험의 환경 판별 결함도
확인했다. Vite는 배경 지도 proxy가 없을 때 `current.json`에 HTML fallback을
**200**으로 돌려준다. 기존 시험은 상태 코드만 보고 배경이 배포됐다고 오판해
"배경 위" 문구를 기다리다 실패했다(재실행에서도 같은 실패). 포인터를 JSON으로
읽고 유효한 deployment ID와 비어 있지 않은 attribution 파일이 있을 때만 해당
시험을 실행하도록 전제조건을 수정했다. 다시 실행한 전체 파일은 **6 passed,
2 skipped**(두 셸의 배경 지도 배포 시험)다. 배경 지도 자체의 동작을 통과로
간주하지 않는다.

## 판정

`P5-states`에 있던 아홉 상태 중 `미계산`, `계산 중`, `stale`을 같은 실제
브라우저 흐름에서 이어 확인했고, 이번 판별 변이로 `stale` 구분이 비공허함을
증명했다. 이전 `M2-01k-c1`이 별도로 검증한 `부분 기록`, `배경 없음`,
`저장 실패`와 합쳐도 나머지 `오류`, `GPS 없음`, `WebGL unavailable`의 현 트리
renderer 단언과 결함 변이를 같은 기준으로 다시 대조하지 않았다. 따라서
`P5-states`는 **partial**이다. `R-S09`는 chart/map zoom 양방향 공유의
구현·증명이 남아 **partial**이다. 외부 `not_executed` 행은 바꾸지 않는다.
