# M0-06b-local · 최신 license closure와 native chart slider 수용

2026-10-09. Root가 배정한 phase/m0-06b 입력 HEAD `52f6579e`에서 원 package/lock/UI source를 변경하지 않고 기존 shell spec에 키보드 행동 시험 하나만 추가했다. 기존 M0-06b.md·103-package 성공 기록·14개 보호 WIP·stash는 수정하지 않았다. Git/DB/Docker/기기 작업은 하지 않았다. 전체 M0/local 완료나 독립 phase 검토를 선언하지 않는다.

## 최신 lock의 실제 production/peer closure

기존 `collectUiLicenseInventory`와 `generateUiNotices`의 공개 함수를 Node v24.12.0에서 호출했다. 네트워크 없이 실제 설치된 production dependencies·installed peers와 notice bytes를 읽고 새 산출물은 own TMP에만 썼다.

- 현재 **104 packages / 외부 100**, required unresolved **0**, optional unresolved **1**(미설치 immer optional peer).
- 이전103과 비교해 workspace `@workout/conversation-kit@0.0.0` 하나만 추가됐다. 기존103 metadata/notice SHA 변경0·삭제0, 외부100개와 license 선언은 그대로다. 기존103 성공을104 성공으로 소급 수정하지 않는다.
- 이전 inventory lock `e9d283b4eb76f9114030be7a3d95d9550fcc2f2490143d0a87ce24dd3d06f165`와 현재 lock `bbabb56dc23270a59c98ca8189817406352d53402dc80898156ffa8cda7de5b2`를 별도 기록했다.
- 현재 Web/mobile-web/Storybook 각각의 notice **manifest 전체 / packages / lock / bundle bytes**가 최신 TMP generation과 모두 정확 일치했다. bundle SHA `b8234435241c195578b0145ccdd6f51e15a707591e234a72417ea9617ec8a8d0`, 세 manifest SHA `4056f80ac944e749ad3a9a18572305cf664c39c390ca10022c64f71780f96b0a`다.
- 현재 inventory SHA `39f864f702fb3dc6339e224bbcb4ec896b8d348ccf1fffc8df4a252b2d9e8462`. 원 murmurhash-js root notice 부재와 README MIT supplement 검증, ECharts supplement 검증은 generator 원규칙을 유지했다.

실제 수집·비교는 `/private/tmp/wm-m0-native-slider-license-current-20261009/{inventory.json,license-comparison.json,notices}`다. 라이선스 법적 승인·유료 extension·전체 tree-shaken 앱 소스 또는 지도/provider 데이터 권한 검토가 아니다. 기존 central101 closure와 별도 M0 branch104를 혼동하지 않는다.

## native slider의 의미 있는 새 원본 시험

`tests/shells/ui-spike.spec.ts`에 `native chart range keyboard controls preserve the percent window and focus` 사례를 추가했다. 기존9사례와 UI source는 그대로다. 입력을 setValue/fill하거나 내부 ECharts store를 조작하지 않고 실제 DOM focus 후 keyboard Home/ArrowRight/ArrowLeft/End/Home을 누른다.

각 0/1/0/80/0% 값·min0/max80·focus 유지와 **실제 렌더링된 SVG의 합성 대량 행 label 범위**를 함께 검증한다. 20%-wide window 밖 label이 남으면 실패한다. 320px 전환 뒤 focus/value와 표의 원래1000행도 확인한다. 표 행 수를 줄이거나 source/timeout/retry/config를 바꾸지 않았다.

## 브라우저 및 실패 이력

1. Aside skill/guide/repl을 먼저 읽었다. 실제 `aside skills list`는 daemon authentication challenge fetch 실패/Aside 미실행으로 exit1이었다. Aside 통과로 기록하지 않는다.
2. 최초 서버 시작은 자동 승인 검토가 이전 identity 보호 포트3100/4200 충돌 위험으로 거절했다. 서버 시작0이었다. Root가 identity40875 terminal·cleanup SHA `36ee23c69df1cc135d0a609a5ae89b0116611cb5252b04feda5f8a31f0973a91` 및 포트 독점 이전을 명시한 뒤 재개했다. 직전 ECONNREFUSED만 free로 허용했다.
3. 실제 **Chrome**에서 Next와 Vite를 각각 열어 위5키를 조작했다. 두 Host 동일 관측: native value0/1/0/80/0, focus 전부 true, 각14 rendered labels; min/max1–196 /16–211 /1–196 /813–995 /1–196. 새 검증 탭을 닫았고 소유 서버 handle46769 terminal0·양포트 free를 확인했다. raw health/GPS/auth 출력은 없었다.
4. 첫 Playwright R1은 anchored `--grep`가 full title과 맞지 않아 등록0·terminal1이었다. 같은 CLI의 실제 `--list`에서 anchored0등록/exit1, unanchored 같은 unique title만 Next/Vite 정확2등록/exit0임을 확인했다. R1 실패 result SHA `b2dbb671472cc00fc442e97db7fea167104e3d584dc3c909930bda73d652aaf7`를 보존한다. 시험 단언 실패나 source 회귀로 귀속하지 않는다.
5. TMP v2는 grep anchor만 교정했다. 원 `playwright.shells.config.ts`의 두 project/workers/timeout/retry0를 유지하고 기존9사례를 반복하지 않았다. 실제 focused **2등록/2통과/실패0/skip0/flaky0/retry0**, terminal exit0. Actor `6793ms`, Playwright6049.77ms다.

Actual result `/private/tmp/wm-m0-slider-actual-r2-20261009/result.json` SHA `da8d1d4e503e92ec752652eb589f83211e8f1a903df4dd53e4e6cd0445057ce6`. source1877/build1168 전후 동일, freeze SHA `cd417f88b5c28ffc318fb0798e604603e254290dc505f002a5f2a1ff69153a7c`. 이전 stream freeze의 code/config roster를 재해시했으며 Git 명령은 사용하지 않았다. docs 및 native untracked WIP는 code/build census 밖이다. 원 stdout/stderr는 byte count/SHA 및 closed scenario/status/location만 남기고 폐기했다. 새 Playwright artifact 삭제·소유 webServer 종료·양포트 ECONNREFUSED/free 모두 true, 기존/unknown process kill0, DEBUG/preload/시험인증환경 inheritance0이다.

## 정적 검사와 한계

- 새 spec scoped TypeScript(noEmit, 원 tsconfig 확장·해당 spec만 포함), ESLint, Prettier: 실제 exit0.
- TMP runner node --check exit0, finite parser fixtures6/6(정확2·duplicate/unknown/retry/count 거절·skip 불수용). 이는 실제 browser pass의 대체 증거가 아니다.
- spec SHA `6c1682dc0e755f78240dad09a3b433fab8f27c5314ec6939f43f7e78a056943a`.

새source UI 변경은 없으므로 production build를 반복하지 않았다. 기존52f6579e stream 전체build15/15의 동일1168 output을 사용하고 두Host 실제 렌더링을 확인했다. 이번 scoped2pass를 원전체 shell20case 재실행 또는 모든 후보/전체 M0 phase 통과로 주장하지 않는다. 최종 제품 실기기·OS IME·물리touch/GPU/성능 예산·운영HTTPS·provider·법률/지도데이터 권한은 별도 미실행이다. 전체 구현/로컬통합/독립phase검토 후 마지막 실제 `org.workoutmanager.app` 수용 순서를 유지하며 standalone 시험 앱은 실행하지 않았다.
