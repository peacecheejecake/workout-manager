# M0-06b · 설치된 UI 후보 라이선스 추가 검토

확인일: 2026-09-16. `murmurhash-js@1.0.0`의 MIT 고지는 설치된 README에서 확인했다.
기존 inventory의 `missingNoticeFiles`는 정해진 이름의 root 파일이 없다는 뜻이며,
라이선스 본문 자체가 없다는 뜻은 아니다. 후보와 전이 의존성의 실제 배포 고지 검증은 별도로 남는다.
이 기록은 출처·조건 확인 결과이며 제품 전체에 대한 법적 사용 승인이나 M0-06b 완료 판정이 아니다.

## 범위와 재현 결과

[기존 inventory](ui-spike-license-inventory.json), [후보 기록](ui-spike-packages.json),
[수집 코드](../../../scripts/audit-ui-licenses.mjs)를 읽고 설치된 package 파일을 대조했다.
기존 보고서는 보존했다. 수집 코드의 root를 현재 작업 경로로 고정하고 출력 경로만
`/tmp/workout-ui-license-inventory-review.json`으로 바꾼 임시 실행을 수행했다.

- 재확인 시각: `2026-09-16T08:28:48.706Z`.
- 현재 lockfile SHA-256: `f243600c5ee0a3d6f4597ad4487431ac977caf949b7297148f5ab0d3d28a9bbd`.
- 101개 package 중 외부 99개, 내부 workspace 2개다. 기존 보고서의 `packages` 및
  `unresolved` 배열과 새 수집 결과가 동일했다. 설치된 root notice 파일 99개의 SHA-256도 모두 일치했다.
- 외부 metadata는 MIT 81, ISC 8, BSD-3-Clause 4, BSD-2-Clause 2, 0BSD 2,
  Apache-2.0 1, `(MIT OR Apache-2.0)` 1개다. 이는 package metadata 분류이며 포함 소스의 조건 전체를 뜻하지 않는다.
- 필수 dependency 누락은 없고 선택적 Zustand peer `immer`만 미설치다.
  이 검토에서 설치하지 않았다.
- 수집기는 root의 LICENSE/LICENCE/COPYING/NOTICE 이름만 검사한다. README 안의 고지,
  하위 `licenses/` 경로, 번들에 포함된 소스와 지도 데이터·호스팅 약관은 자동 검사 범위 밖이다.

## murmurhash-js 출처 확인

설치 경로는 `node_modules/.pnpm/murmurhash-js@1.0.0/node_modules/murmurhash-js/`다.
`package.json`은 MIT, author Gary Court, repository `mikolalysenko/murmurhash-js`,
`gitHead` `72aabce3f52cb8f16245692a69fd35951e165af0`를 기록한다.
`README.md`의 `License (MIT)` 절에 Gary Court의 2011년 저작권과 MIT 허가·조건·면책 본문이 있다.
[배포 fork README](https://github.com/mikolalysenko/murmurhash-js#license-mit)와
[원저자 README](https://github.com/garycourt/murmurhash-js#license-mit)에서도 같은 고지를 확인했다.

고정 revision의 [원본 README](https://raw.githubusercontent.com/mikolalysenko/murmurhash-js/72aabce3f52cb8f16245692a69fd35951e165af0/README.md)를
HTTPS로 받아 설치본과 대조했다. 전체 README는 두 설치/API 예제의 package 이름이 달라 해시가 다르지만,
`## License (MIT)` 뒤 본문을 양끝 공백 제거한 결과는 byte 단위로 같았다.
따라서 `gitHead`를 설치 README 전체의 동일성 증거로 오인하지 않는다.

| 확인 대상                                               | SHA-256                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| 설치 `README.md` 전체                                   | `e137ced8967fc334ec9b5fc5c8500992f9e49d2e9cc0f6e2439e46af2f2481a4` |
| 고정 revision의 README 전체                             | `a6df412756139a6706db058a33f8aa39b9e280facf7f1587e86f6680f9e5cbb6` |
| 두 README의 MIT 본문, heading 제외·양끝 공백 제거·UTF-8 | `00309875dc165cf120f89b6d04ff97b9958bbc7b9db1a26457a602dcf4e35937` |
| 설치 `package.json`                                     | `e4b3531abcc7da48f732a058112686b44af66004c38d98a8014619542e767cb4` |

**출처 미확인 항목은 해소됐다.** 배포 notice를 만들 때 이 README의 MIT 절을 포함하는 작업은
아직 수행하지 않았다. 기존 inventory의 root 파일 부재 관측을 삭제하거나 성공값으로 바꾸지 않았다.

## 후보별 확인과 적용 한계

| 설치 후보                               | 확인한 본문 및 후속 배포 확인                                                                                                                                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MapLibre GL JS 6.9.1                    | `LICENSE.txt`에 MapLibre BSD-3-Clause뿐 아니라 Mapbox GL JS v1.13 이전 코드, glfx.js MIT, d3-color BSD 고지가 함께 있다. 일부 heading만 추출하지 않고 해당 고지 전체를 보존하는 배포 확인이 필요하다.                   |
| ECharts 6.1.0                           | `LICENSE`의 Apache-2.0 및 subcomponents 절, `NOTICE`, `licenses/LICENSE-d3`를 확인했다. root metadata만으로 d3 BSD 고지가 사라지지 않는다. 적용되는 Apache 고지·수정 표시와 하위 고지의 배포 포함 여부를 확인해야 한다. |
| TanStack React Table 9.2.4              | 설치 `LICENSE`는 MIT다. 실제 배포되는 package와 하위 의존성의 저작권·허가 고지 보존을 확인해야 한다.                                                                                                                    |
| Tiptap React/Core/PM/Starter Kit 3.31.3 | 설치된 네 package의 `LICENSE` 또는 `LICENSE.md`는 MIT다. 이 결과를 설치하지 않은 유료 확장·Cloud 서비스·UI template 조건에 확대하지 않는다.                                                                             |
| dnd-kit React 0.5.0                     | 설치 `LICENSE`는 MIT다. 설치된 dnd-kit 하위 package 고지도 inventory에 있다. 제품 번들에서의 보존 여부는 미검증이다.                                                                                                    |
| react-resizable-panels 4.12.4           | 설치 `LICENSE.md`는 MIT다. 제품 번들에서의 저작권·허가 고지 보존 여부는 미검증이다.                                                                                                                                     |

위 표는 설치본을 기준으로 한다. upstream의
[MapLibre LICENSE](https://github.com/maplibre/maplibre-gl-js/blob/main/LICENSE.txt),
[ECharts NOTICE](https://github.com/apache/echarts/blob/master/NOTICE),
[TanStack LICENSE](https://github.com/TanStack/table/blob/main/LICENSE),
[dnd-kit 저장소](https://github.com/clauderic/dnd-kit),
[resizable panels LICENSE](https://github.com/bvaughn/react-resizable-panels/blob/main/LICENSE.md)를 추가 확인했다.
branch URL은 변경될 수 있으므로 설치 버전의 증거는 기존 inventory 해시를 따른다.
[Tiptap 공식 문서](https://tiptap.dev/docs/editor/getting-started/overview)는 MIT 공개 코드와 유료 확장을 구분한다.
[Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)의 §4는 라이선스 사본,
해당 고지 유지 및 수정 표시 조건을 규정한다. 이 문서는 그 조건의 포괄적 법률 해석을 제공하지 않는다.

추가로 읽은 ECharts `licenses/LICENSE-d3`의 SHA-256은
`e1211892da0b0e0585b7aebe8f98c1274fba15bafe47fa1f4ee8a7a502c06304`다.
root 파일만 수집하는 기존 inventory에는 이 파일이 없으므로 여기 별도로 기록한다.

## 남은 항목

- Next/Vite/native 실제 배포물의 third-party notice 산출·동봉·사용자 접근 경로를 검증하지 않았다.
  README 및 중첩 고지를 포함한 최종 번들 범위의 검토가 필요하다.
- MapLibre 코드 라이선스는 tile·style·font·routing 데이터의 사용 조건을 대신하지 않는다.
  현재 합성 지도 검증은 외부 지도 서비스의 상업 이용·attribution·rate limit 검토 결과가 아니다.
- 유료 확장은 설치·구매하지 않았으며 조건을 승인하지 않았다. 새 dependency나 버전으로 바꾸면
  해당 설치본과 새 lockfile을 기준으로 재검토해야 한다.
- OS IME·touch·성능·routing coverage는 이 문서의 검증 범위 밖이다. 이 기록만으로
  [M0-06b](../progress/M0-06b.md)의 gate나 후속 작업 의존성을 해제하지 않는다.

문서 추가 외에 코드·패키지·규칙·기존 증거를 수정하지 않았다. 앱 실행이나 테스트 결과를
이 라이선스 조사에서 새로 통과했다고 기록하지 않는다.

## 배포 고지 후속 구현 · 2026-09-18

위 내용은 최초 조사 당시 기록이다. 후속 구현에서는 `generate-ui-notices.mjs`가 설치된
`@workout/ui-spike`의 production dependency 및 설치된 peer 전체에서 고지를 수집한다.
root LICENSE/LICENCE/COPYING/NOTICE 본문을 그대로 포함하고, ECharts의 `licenses/LICENSE-d3`와
murmurhash-js README의 MIT 절을 추가한다. 두 보충 파일은 확인한 버전·원문 해시가 달라지면
재검토가 필요하도록 생성에 실패한다. 본문이 없는 외부 package나 필수 dependency 누락도 실패한다.

과거 inventory를 갱신하지 않고, `THIRD_PARTY_NOTICES.txt`와 `manifest.json`을
각 shell의 `public/dist/notices`에 생성한다. manifest에는 package/version, package 내부 상대
출처 경로, 원문·포함 본문 해시와 lockfile·전체 고지 해시를 기록한다. 시간이나 절대 설치 경로는
포함하지 않는다. 필수 검증을 끝낸 뒤 파일을 작성하고 build/dev 명령은 실패 시 다음 단계를 실행하지 않는다.

Next·Vite·Storybook build/dev에 생성을 연결했다. build cache는 생성 스크립트와 lockfile 변경을
입력으로 추적한다. `/ui-spike`의 “오픈소스 라이선스 고지” 링크는 같은 origin의 생성된 텍스트를 연다.
이 산출물은 설치된 UI 후보 dependency 범위이며 tree-shaking 후의 정확한 번들 목록이나 전체 앱의
모든 의존성·지도 데이터·서비스 약관 검토를 대신하지 않는다. Native 앱의 실제 동봉 검증은 남아 있다.

[산출물 검증 기록](ui-spike-notice-distribution.json): 외부 package 99개·고지 101개,
UTF-8 149,988 bytes다. root·중첩 notice 파일명을 추가 탐색한 101개 package/5,942개 항목에서
이미 포함한 ECharts 하위 고지 외의 추가 후보는 없었으며 symlink로 제외된 항목도 없었다.
이는 파일명 기반 수록 점검이며 모든 소스 주석이나 전체 제품의 법적 조건 검토는 아니다.

각 포함 본문과 원문 해시를 다시 계산했다. Next public, Vite public/dist, Storybook public/dist
다섯 산출물 사본의 본문 및 manifest는 byte 단위로 같다. Turbo dry-run에서 세 shell의 build
입력에 생성 스크립트·collector·lockfile이 포함된 것을 확인했다. 기존 inventory는 byte 단위로 유지됐다.

전체 검사 1,463 tests/133 files, production build 7개, 두 shell의 UI E2E 24개를 통과했다.
새 E2E는 링크 focus·이동, HTTP 200/text/plain, 필요한 고지 본문 및 전체 manifest 해시를 확인한다.
Aside에서도 두 shell 링크의 실제 같은 origin 응답 200·149,988 bytes와 동일 본문을 확인했다.
Next 화면의 `ui-notices-next.png`를 직접 검토했다(Aside 세션 `2026-09-17_VL6gkWAp84sonbHw`).
고지 생성 단위 테스트 6개는 deterministic output, 보충 원문 보존, 누락·변조·경로 이탈·파일 크기
거절과 검증 실패 시 기존 산출물 보존을 포함한다. Herdr 독립 리뷰의 base/tree는 커밋 본문에 남긴다.
