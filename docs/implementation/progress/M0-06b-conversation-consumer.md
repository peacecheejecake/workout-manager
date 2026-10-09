# M0-06b 상담 화면의 conversation kit 연결 · 2026-10-09

공개 transcript/composer를 실제 coaching module에 연결했다. user/session/thread별 transcript 수명, 서버 revision과 고정 command/key, 기존 동의 경계를 유지한다. afterRevision API는 더 최신 메시지 탐색이므로 과거 기록으로 표시하지 않는다. 일반 Enter는 줄바꿈이며 Ctrl+Enter를 자동 저장으로 등록하지 않는다. 명시 저장 이후 서버 응답으로 성공을 표시한다.

## 실제 검증

- 컴포넌트 모음: consumer 16 + kit 12, 합계 28/28 통과. typecheck·scoped lint·포맷 exit 0.
- 원 전체 `pnpm build`: exit 0, 추적 소스 2,301개 전후 drift 0. 이는 브라우저/API/기기 검증을 대신하지 않는다.
- 원 shells Playwright spec, Next desktop와 Vite mobile 두 프로젝트: **2/2 통과, 실패·skip·flaky 0**, 각 1회 실행, 원 workers/config/timeouts 유지.
- 320/767/768/1279/1280px에서 초안 값·포커스·가로 reflow, 한국어 다중 줄 문자열, Enter 줄바꿈·Ctrl+Enter 비저장, 명시 저장 revision 2, 교체된 세션의 개인 메시지 제거를 확인했다.
- 실행 전후 소스·빌드 불변, 두 서버 포트 정리 완료, 원문 응답·trace·screenshot 보존 0. 유한 결과 SHA-256 `028d37b16579b2f506441e327a23d70073e77af2e3fd249332a03bc590b1d4eb`.

## 보존된 실패와 도구 한계

Aside는 daemon challenge/browser not running 오류로 검증할 수 없었다. Chrome extension 선택은 성공했지만 독립 Chrome 탭에는 Playwright의 HTTP fixture가 없어 같은 scenario로 사용할 수 없다. 실제 자동 검증 도구는 Playwright다. 첫 sandbox 포트 관측은 PORT_UNAVAILABLE로 실행 전 중단했다. 첫 실제 실행은 child exit 0이었으나 결과 파서가 정상 testDir 상대 파일명을 허용하지 않아 wrapper failed로 남겼다. SHA-256 `8cc63e8ab13de37f232bc5f1c60bb20b036084211c30601657367ac7dc556207`. parser를 고쳐 같은 소스/빌드에서 후속 실제 두 프로젝트 결과를 확인했으며 첫 실패는 보존한다.

HTTP는 합성 DTO fixture다. 실제 API/DB/OIDC, OS 한국어 IME와 WKWebView·HealthKit 실기기 증거로 승격하지 않는다. 전체 M0-06b-local와 phase review는 아직 미완료다. 실기기는 모든 구현 완료 후 실제 제품 앱으로 마지막에 진행한다. 기존 성능 WIP와 측정 자료는 이 커밋에 포함하지 않는다.
