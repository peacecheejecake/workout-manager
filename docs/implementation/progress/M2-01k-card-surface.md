# M2-01k · S13 카드 노면 출처 보강 (2026-09-27)

## 판정과 경계

`S13-card-surface`를 `partial`에서 `passed`로 다시 판정했다. 저장된 `target-distance-loop`의 평가 버전 2가 GraphHopper 경로 세부값으로 **양수의 알려진 노면 길이**를 갖는 경우에만 카드가 `graph-reported`를 표시한다. 카드에는 노면 태그별 길이, 값이 없는 길이, 그래프 빌드 ID, OpenStreetMap 출처·ODbL 링크가 함께 나온다. 이는 제공자 지도 자료의 기록이며 현장 노면 상태, 통행 허가 또는 안전 확인이 아니다.

기록 구간, 경유점 경로, 가져온 파일, 보호 구역 제거본, 버전 1 평가, `not_reported`, 양수 길이가 없는 버전 2 평가는 계속 `unknown`이다. 기존의 엄격한 카드 클라이언트를 위해 `GET /courses/cards` 기본 응답도 `unknown`을 유지한다. 새 웹 클라이언트만 `?surface=graph-v1`을 요청한다. 카드의 두 생성 경로(전체 head read와 batched card source)가 같은 노면 도출 함수를 쓴다. 새 저장 필드나 마이그레이션은 없다.

## 실제 검증

- Vercel React Best Practices와 Composition Patterns를 먼저 읽었다. 설치된 upstream revision은 `063bee94c3f4df8453406c830b0a7df0f2860278`이다. Aside `SKILL.md` 확인 뒤 `aside --update`를 시도했으나 `fetch failed`였다. 하위 에이전트의 Chrome CUA는 root 전용 elicitation 때문에 사용할 수 없어 실제 브라우저 확인은 Playwright Chromium으로 수행했다. Native 기기 증거는 없다.
- 서울 GraphHopper 10.0을 저장소 helper로 실행하고, 격리 PostgreSQL·실제 OIDC fixture·Next/Vite production shell에서 `course-list-cards.spec.ts`를 실행했다. 두 shell에서 가져온 코스로 목표 거리 후보를 실제 엔진에서 만들고 명시적으로 저장한 후, 저장된 평가의 양수 노면 길이·미기록 길이·그래프 ID와 S13 카드 문구가 일치함을 확인했다. 기본 카드 API 응답은 같은 코스에 대해 여전히 `{confirmation:"unknown"}`이었다. 전체 카드 파일은 **4 passed, 2 skipped**였다. skipped 둘은 이 worktree에 고도 데이터셋이 없는 별도 고도 배포 검사다.
- `courseCardSurface`가 항상 `unknown`을 돌려주도록 바꾼 임시 변이에서 양쪽 shell 검사가 각각 `graph-reported` 기대와 실제 `unknown` 차이로 실패했다. 변이를 복구한 뒤 위 전체 카드 파일을 다시 실행하여 통과했다.
- 서버·카드 컴포넌트 focused unit **23/23** 통과. `@workout/contracts`, `@workout/server-courses`, `@workout/api`, Next, Vite build 통과. 전체 workspace typecheck **34 packages + root**, 변경 파일 ESLint, Prettier, `git diff --check` 통과.

브라우저의 실 graph 검사는 `IDENTITY_E2E_ROUTING=graphhopper`와 검증된 로컬 서울 graph/JAR가 있어야 실행한다. fixture-only CI에서는 positive 검사가 **skipped**로 남는다. 이 실행은 지도의 태그를 현장에서 검증한 증거가 아니다. 기존 매트릭스의 실패·외부 `not_executed`와 이전 회차 기록은 유지했다.
