# M0-06b · Streaming 표시 consumer 로컬 수용

## 구현

공개 `StreamTranscript`가 invocation별 presentation store를 `useSyncExternalStore`로 구독한다. SSR은 factory의 안정된 빈 snapshot을 사용하고 live 비공개 text를 서버 snapshot에 노출하지 않는다. 텍스트와 도구 결과는 plain text·읽기 전용이며 생성 완료와 계획 승인·실제 수행을 구분한다.

UI spike의 lazy panel은 합성 입력만 사용한다. 같은 세션의 실행 교체는 표시를 지우고 초안은 유지하며, 세션 변경은 초안도 비운다. 이전 실행의 늦은 event를 거절하고 unmount 시 store를 dispose한다. 실제 제공자 전송·서버 저장·계획 승인 권한은 없다.

## 실제 검증

Root는 기존 composer/transcript 및 새 component 모음18/18, 기존 pure store15/15를 확인했다. 첫 component 수집은 react-dom/server 부재로0case·exit1이었고 해당 kit의 정확 react-dom19.3.0 dev dependency 및 frozen offline lock 설치 후 재검증했다. 전체 build15/15·cache0·exit0, 기존 build warnings는 보존했다. 마지막 kit/UI-spike typecheck·변경 TS/TSX lint·포맷은 모두 exit0이다.

원 shell Playwright config의 Next desktop/Vite mobile6행동씩 **12/12·0실패·0flaky·0skip·exit0**을 실제 실행했다. 320/767/768/1279/1280 경계·초안 focus·합성 composition·plain text XSS·실행/세션 수명·늦은 입력·명시 초안 확인을 다룬다. source1,877/build1,168 freeze 전후 동일, 포트3100/4200 및 소유 artifacts 정리 완료다. finite result SHA `a2dc5530c172950bfb6dc855a655541c7844c23f6314705549a8949edca551d4`, freeze SHA `f307d041797d45c50f4feb2f9eb7b2439a2691a1e6774c8b0d5feb163e34b38e`다.

Aside1.26.916.1741는 daemon authentication challenge fetch 실패/미실행으로 사용할 수 없었다. fallback 실제 Chrome에서 Vite preview를 열어 텍스트·도구 결과가 markup을 실행하지 않고 생성 완료 후 초안과 확인횟수0을 보존하는지 관찰했다. 새 실행은 표시를 비우고 초안을 유지하며 늦은 입력을 거절했고 세션 변경은 초안을 비웠다. 검증 탭과 소유 preview process를 닫고4200 LISTEN 없음도 확인했다. 최초 loopback 서버 실행은 sandbox EPERM으로 미실행, exact scoped 재실행으로 관찰했다. Aside 결과로 주장하지 않는다.

Root는 반환된5source/test SHA와 보호된 기존 WIP14파일이 불변임을 확인했다. 기존 iPhone 성능 WIP·역사 기록은 이 커밋에 포함하지 않는다.

## 남은 수용

합성 composition은 실제 OS IME 증거가 아니다. 실제 provider stream transport·운영 AI 및 제품 승인 연결은 별도 구현·검증이 필요하다. 전체 phase gate·독립 검토·main 통합과 기존 실기기/운영 미실행은 유지한다. 최종 실기기는 모든 구현 뒤 실제 `org.workoutmanager.app`으로 진행하며 별도 시험 앱으로 대체하지 않는다.
