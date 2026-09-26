# M2-01k · S14 공급자 분리 실행 증거

2026-09-27. `phase/m2-01k`의 `S14-providers` 행을 `partial`에서 `passed`로 바꾼 근거다. 요구는 MapLibre 렌더러와 routing·place search·tiles·elevation 공급자의 분리다. 이 판정은 공급자 경계에만 적용한다. 운영 호스팅과 데이터 coverage는 별도 행에서 계속 `partial`이다.

- `apps/api/tests/course-extras-routes.test.ts`: routing route가 없는 설정에서 장소 검색과 고도 profile은 각각 실제 fixture 데이터를 반환한다. 장소 또는 고도 데이터만 제거하면 해당 API만 `no_dataset`을 반환한다. phase 브랜치에 반영한 뒤 이 파일을 재실행해 **55/55 통과**했다.
- `tests/identity/course-provider-isolation.spec.ts`: 자체 운영 basemap 아티팩트가 실제로 존재하는 조건에서 장소·고도 데이터가 없어도 Next/Vite 지도의 선과 style 요청이 유지됐다(**2/2**). WebGL을 사용할 수 없는 조건에서는 지도 오류가 표시되지만, 로컬 장소·고도 아티팩트의 실제 API 결과는 전후 동일했다(**2/2**). 아티팩트가 없으면 전제 조건에 실패하며 통과나 skip으로 취급하지 않는다.
- 장소 검색을 고도 공급자 가용성에 잘못 묶는 임시 변형에서 새 API 시험이 실패했다. 변형은 되돌렸다. 분리 작업 공간에서 build **15/15**, typecheck **34/34**, ESLint, Prettier, diff 검사가 통과했다.

시험은 격리된 PostgreSQL과 로컬 `.geo-build` 자료를 사용했다. 외부 호스팅 배포나 일반 코스의 고도 coverage를 증명하지 않는다. 독립 작업 공간의 검증 커밋 `72a62cd`를 phase 브랜치에 `9b38f9a`로 반영했다. phase 전체에 대한 독립 검토는 별도로 받아야 한다.
