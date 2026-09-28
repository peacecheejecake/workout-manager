# M0-06b-odbl-gpx · 코스 GPX의 OSM/ODbL 고지

상태: 구현·범위 검증 완료, phase 검토 대기. `M0-06b-odbl.md` §2의 2026-09-26 사용자 결정을 이행한다. 이 기록은 법적 판단이 아니다.

## 범위와 동작

- `writeCourseGpx`가 모든 코스 GPX 1.1의 `metadata`에 OSM 저작자 표시, OSM 저작권 페이지 링크, ODbL 1.0 URI를 기록한다. 고지는 이름 포함 여부와 관계없이 남는다.
- 기존 privacy trim과 이름 선택은 그대로 유지한다. `metadata/name` 및 waypoint/route 이름은 사용자가 켰을 때만 기록한다. 계정, 시각, course ID, revision, 제품 식별자는 추가하지 않는다.
- 기존의 확인 receipt 게이트와 API 라우트를 그대로 사용하므로, 확인 없는 GPX 응답은 계속 거절된다.

## 검증

2026-09-28, `phase/m0-06b` 작업 트리에서 수행했다. Node 24.19.0을 사용했다.

| 검사                                                   | 결과                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `pnpm --filter @workout/contracts build`               | 통과                                                                           |
| GPX·import 단위 시험 (`gpx.test.ts`, `import.test.ts`) | 32/32 통과. 실제 GPX parser 왕복, 이름 포함·제외 고지 검증                     |
| `course-sharing.integration.test.ts`                   | 격리된 임시 PostgreSQL에서 39/39 통과. 확인된 GPX API 응답 두 종류에 고지 포함 |
| `@workout/server-courses` 및 `@workout/api` typecheck  | 통과                                                                           |
| 변경 파일 ESLint, Prettier                             | 통과                                                                           |
| ODbL URI 제거 변이                                     | `gpx.test.ts`의 고지 단언 1건 실패(예상), 원본 복원 뒤 13/13 재통과            |

Root가 같은 GPX·import 시험 32/32를 별도로 재실행했다. 이 노드의 완료는 로컬 GPX 구현·검증 범위이며 실제 공개 배포나 새 ODbL 지도 산출물의 증거가 아니다.

일반 샌드박스에서 PostgreSQL `initdb`가 SysV 공유 메모리 권한으로 실패했으므로, API 시험은 권한을 높인 환경의 **새 임시 클러스터**에서 실행했다. 온라인 의존성 설치는 샌드박스의 registry DNS 조회 실패 뒤 상위 작업에서 완료했으며 lockfile 변경은 없다.

기준 요구: `M2-01k-o` A-1/R-3/R-6 및 `M0-06b-odbl` §2. 기존 `M2-01k-o`의 `metadata` allowlist 중 이름과 개인정보 제한은 보존하고, OSM/ODbL 고지 요소만 허용 목록에 추가했다.
