# M0-06b independent table virtualization consumer

`@workout/table-kit` public viewport를 별도 lazy UI entry에 연결했다. 기존 1,000행 chart/table spike와 단언은 유지한다. 새 불변 합성 10,000행 roster는 null과 zero, controlled 정렬/검색, stable ID, 명시 jump/selection, focus pin, 동적 행 측정, scroll anchor 및 전체 행 읽기 대안을 사용한다. 외부 요청·개인 저장·승인을 하지 않는다.

## 초기 실제 검증 · 2026-10-09

Dependency는 이미 고정된 workspace link만 추가했다. 기존 store의 offline frozen install은 753ms, exit 0이었다. 첫 restricted symlink 실패는 보존하며 store나 node_modules를 purge하지 않았다. Consumer와 Root의 실제 typecheck·scoped lint·format은 exit 0이다. 전체 build session13958은 **15/15**, cache 0, exit 0, 20.625s였다. Vite use-client/sourcemap와 Turbo no-output warning은 그대로다.

Aside skill/guide/repl를 확인했으나 skills list 및 availability가 daemon auth challenge fetch 실패/Aside 미실행으로 exit 1이었다. Chrome 실제 탐색에서 lazy entry와 패널 로드, 10,000행 상태·원본 null/zero·화면 근처 행·명시 controls를 관측했다. 생성한 Chrome 탭만 닫았다. 이를 responsive/touch 전체 수용으로 확대하지 않는다.

원 Playwright 두 host config/workers/retries/timeouts에서 정확한 5 scenario × 2의 초기 실제 실행은 **8통과·2실패·skip/flaky 0**, exit 1, 35.604s였다. Vite mobile의 dynamic-resize-anchor 단언(line147)과 all-rows-touch timeout(line18)이 실패했다. 아직 원인을 확정하지 않으며 성공으로 기록하지 않는다. Source 1,871개와 build 1,163개는 전후 동일했고 자체 서버/artifacts는 정리됐다. Freeze SHA `bb7e27104c433fbea84edda02740ceb4ca3e843fe537ca558666c4426067e082`, result SHA `2a18d3e66f9c2893067bdac8c402b982ae2c7276588df92a0edb2ed2f9ae5666`.

실제 두 host 통과·planning 추출 회귀·전체 M0 phase review/main과 최종 실제 제품 iPhone 수용은 남아 있다. Desktop/Pixel emulation은 physical WKWebView/IME/HealthKit 증거가 아니다.

## 교정 후 실제 양 host 검증

Keyboard jump 검증은 명시 focus+Enter로 실행했다. 전체 읽기 mode는 10,000개의 실제 행·ID·aria row index/count·전체 한글 메모·null/zero·선택 상태를 유지하고, 행별 반복 버튼을 공통 대상 번호 선택/이동과 focus 가능한 row header로 대체했다. Virtual mode의 행별 동작과 동적 측정/focus pin은 유지한다. 행 수·scenario·기존 시간 제한/workers/retry는 줄이거나 늘리지 않았다.

최종 consumer/spec TypeScript·lint·format은 exit 0이다. Root의 교정 후 전체 build session29389는 **15/15**, 12 cache, exit 0, 8.167s였다. 새 freeze source1,871/build1,163 SHA `eacef6bcde4badff0898e7632f90c3c159fe79f498649524695c8e82a2f1ca32`로 실제 원 10개 브라우저 시험을 다시 실행했다. **10/10, 실패/skip/flaky 0**, terminal exit 0, 12.367s였고 source/build 전후 동일, 자체 ports/artifacts cleanup을 확인했다. Result SHA `cf53781132c478138e666e31cc011433362850285cd24d356148588020968a84`.

실제 단언은 전체 10k DOM 읽기와 상태 보존, dynamic ResizeObserver 높이, wheel/offscreen focus, null/zero·정렬 tie break·검색, 320/767/768/1279/1280 reflow·anchor·명시 touch 대안이다. Root가 추출 kit/planning 원 4파일도 다시 실행해 **32/32, skip0, exit0, 2.36s**를 확인했다. 기존 v1 실패는 그대로 보존한다. 이 결과는 desktop/Pixel emulated browser의 범위이며 native iPhone/OS IME/HealthKit/성능 예산을 통과시킨 증거가 아니다. 전체 M0 phase gate/review/main과 최종 실제 제품 수용은 남아 있다.
