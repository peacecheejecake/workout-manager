# 최종 제품 앱 실기기 검증 계획

## 사용자 결정 · 2026-10-09

모든 구현을 먼저 완료하고 실기기 테스트는 마지막에 실제 제품 앱 `org.workoutmanager.app`으로 진행한다. standalone 합성 시험 앱의 추가 구현·빌드·설치·실행·측정을 중단한다. 로컬 단위·브라우저·실DB·통합 E2E·독립 phase 검토는 구현 중 계속 진행한다. 운영 호스팅·복원·제공자 조건과 기존 출시 수용 기준은 유지한다.

## 실행 순서 · 추가 승인 2026-10-09

1. **전체 구현**: task graph의 로컬 선행만 충족한 ready 작업을 비중복 scope로 병렬 구현한다. M2-01k-local/M2-01-local, EXT-BACKCHANNEL-local, M3-02o-local은 기존 전체 수용과 구분한다. M3-03a의 실제 제품 shell 통합도 운영 전환 전에 구현·로컬 검증한다.
2. **로컬 통합·독립 phase 검토**: 각 phase의 runnable 구현을 검증·커밋하고 전체 install/generated/lint/typecheck/build/unit/integration/identity 두 회차/format 및 applicable local drills를 수행한다. context-less gpt-6-sol high 읽기 전용 검토에 base/head·실제 변경·검증 결과·외부 미실행을 제공한다. 승인 후 main 통합을 LOCAL-REVIEW에서 확인한다. Push는 사용자 작업이다.
3. **운영 백업·복원 및 HTTPS 전환**: LOCAL-REVIEW 뒤 EXT-RESTOREb의 독립 witness·최신 전체 백업/격리 복원·target-bound admission을 검증하고 EXT-HOSTING의 HTTPS 전환을 수행한다. 실제 운영 변경은 검토된 정확한 script와 필요한 승인 범위로만 실행한다. 기존 503·실패 기록을 완료로 바꾸지 않는다.
4. **외부 수용**: 실제 OIDC·logout/back-channel·공개 ODbL 응답·OpenAI API/청구·HealthKit 등록 운영 감사/안전 배포/rollback 증거를 G2-EXTERNAL에서 대조한다. 로컬 fixture·타입 검사·문서 검토로 외부 성공을 만들지 않는다.
5. **실제 제품 앱 실기기 검증**: G2-EXTERNAL 뒤 M3-02h에서 제품 HealthKit 전체 경로를, M3-03b에서 touch/가로 넘침·지도 성능·메모리·IME/back/offline/lifecycle/접근성을 검증한다. org.workoutmanager.app을 사용하고 자동화·사용자 관측을 구분한다. Standalone 시험 앱 작업은 재개하지 않는다.
6. **출시**: M3-03b 및 기존 전체 지도 수용·M0-06b를 포함해 G2-PUBLIC과 G3를 판정한다. G2-EXTERNAL은 제품 시험용 운영 준비/외부 수용 gate이며 공개 출시 판정이 아니다. 최종 기기 수용과 공개 gate 사이의 순환을 만들지 않는다.

## 로컬·운영 수용 분리 원칙

- M2-01k의 EXT-RESTORE 전체 의존성은 부모에 보존하고, 독립 대회·AI 구현은 지도 로컬 합류를 사용한다. EXT-RESTOREa의 authoritative freshness·CLOSED·tail/loader 구현처럼 실제 기술적 선행인 로컬 의존성은 유지한다.
- M3-02o의 실제 운영 감사·배포/rollback은 M3-02o-ops에서 검증하며 M3-03a의 로컬 통합 선행을 막지 않는다. M3-02h/M3-03b는 G2-EXTERNAL을 계속 요구한다.
- 기존 노드의 completed/failed/partial/not_executed와 원본 로그·SHA를 변경하지 않는다. 분리한 새 노드는 not_started에서 실제 증거 대조 후 진행한다. 재분류는 과거 시험 앱·mock·문서 검토를 제품 통과로 승격하는 행위가 아니다.
- 배포 전 관련 phase의 검토 이후 변경이 있으면 해당 diff의 검토를 갱신한다. 로컬 정상 target fixture는 복원 target의 processing admission을 우회하지 않는다.

## 보존할 관측과 미완료

이전 시험 앱의 실패·서명·설치·화면 관측과 측정 기록은 역사로 보존한다. HTTP 응답 수정 후 지도 표시, 아래로 스크롤한 경로 영역 표시, 두 손가락 이동 정상은 사용자 관측이다. 가로 overflow와 한 손가락 이동 시 페이지 스크롤 우선도 발견된 이슈로 남긴다. 제안된 시험 앱 UX 수정은 착수하지 않았다.

clean 시험 앱 보고서의 첫 navigation 1065ms·pan 0·frame 0은 최종 제품 성능 수용이 아니다. 20회 navigation, native RSS, retained JS heap은 완료하지 않았다. 기존 미실행을 passed로 바꾸지 않는다. 기존 HealthKit 허가·계정 귀속·삭제/재등록 결정을 유지하며 실제 개인 건강 자료 접근 범위를 이번 계획 변경으로 확대하지 않는다.

별도 canonical identity E2E는 HEAD `6a00c113`에서 두 회차 실행됐다. 첫 회차 346 통과·12 skip, 둘째 344 통과·2 실패·12 skip이다. 두 실패는 Next/Vite의 영양 초기 approve-v4 HTTP 500으로 재연결 UI 전에 발생했다. 정확 등록·skip multiset은 두 회차 모두 기존 기준과 일치한다. 원인은 조사 중이며 phase 검토/main 병합은 아직 진행하지 않는다.
