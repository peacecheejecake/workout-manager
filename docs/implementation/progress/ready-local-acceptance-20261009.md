# Back-channel·HealthKit 로컬 수용 연결 · 2026-10-09

Root 판정: `EXT-BACKCHANNEL-local`, `M3-02o-local`의 구현·로컬 수용 완료.
실제 공급자·운영·실기기 수용과 독립 phase 검토를 통과했다는 뜻은 아니다.
역사 실패·미실행과 기존 부모 노드의 운영 상태는 보존한다.

## 현재 입력과 실제 검증

Root는 읽기 전용 감사의 핵심 source14개를 현재 중앙 phase 입력과 다시 SHA 대조하여 drift0을
확인했다. 해당 actual DB 시험5파일은 원 전체 integration roster에 포함되고 skip/todo가 없다.
최신 전체 실행은 upgrade1/1·normal3072 passed/14 skipped·301 passed/3 skipped files·exit0이다.
Aggregate 범위를 개별 시험의 새 독립 기록으로 과장하지 않는다. skip는 통과가 아니다.

- DB terminal SHA `397d173b659fdbc29e2ebf46c0342a4b6f35b1dbe96190d42fbdc5c26c6d034a`.
- DB source1093 freeze SHA `94e1e5f049346d07b14031cda2faaa91daf908e9081e7a5f4f0d16ff6b54f879`.
- install/generated/lint/typecheck/build/format/unit7단계 exit0, unit9509 passed/5 skipped.
  terminal SHA `25416207e33b058e09836aa262933d3dc38f17b2fb892e2411012ad8d6066681`.
- postbuild canonical identity 실제 두 회차 각각 원358 census·346 passed/12 skipped·unexpected/flaky0,
  4개 원 recipe 유지. aggregate SHA `86781e6f4ba86befd6cd1f2f05efca6ab6cb7c9fd8c57ece3825fe503c9fb422`.
- identity 정확 소유 cleanup SHA `36ee23c69df1cc135d0a609a5ae89b0116611cb5252b04feda5f8a31f0973a91`.

## EXT-BACKCHANNEL-local

[기존 구현·수용](EXT-BACKCHANNEL.md)의 표준 token 검사, jti replay, 원자 session 철회,
tenant 격리, callback 경합·구형 7인자 차단은 현재 단위·실DB·합성 IdP/HTTP 실행에 연결된다.
원 source/057의 역사 독립 APPROVE를 변경된 전체 인접 API closure의 새 승인으로 사용하지 않는다.
새 phase 검토는 별도다. 실제 Zitadel session/subject/계정 정지 전파는
`EXT-BACKCHANNEL-external`에서 계속 **not_executed**이며 잔존 상한8시간 조건을 유지한다.

## M3-02o-local

[기존 통합](M3-02o.md)의 비식별 감사·개별 해제·rollback fence는 실제 합성 PG19시험과
현재 전체 DB 실행에 연결된다. 기존 management/web contract66시험 및 실제12 browser 시나리오의
owning panel 입력은 현재와 동일하다. [배포 준비](../research/healthkit-registration-rollout-readiness.md)의
서버 우선 전환·legacy hold·DB fence 유지/fix-forward 절차는 준비 자료이며 실제 실행은 아니다.

최신 State/Management harness 실제92/72단언, current production13 Swift의 unsigned
arm64 iOS15 compile/link 두 조건 exit0을 Root가 재확인했다. 설치 Capacitor8.5.2 source106개와
TMP framework/source 입력62개를 독립 재해시하여 drift0을 확인했다. framework는 로컬 Debug build다.
Release라는 시험 이름은 `swiftc`의 `-D DEBUG` 없는 조건을 뜻하며 signed product Xcode Release
빌드·공식 SPM artifact 동일성·실제 제품 패키지 해석을 증명하지 않는다.

- native input62 SHA `8b42d84eb9ec3642ca3d0ffd7ea51dbf757c17229d480096de2e79c2998b5d9a`.
- native result SHA `3e3c96039425d1a58a712c412ce5def82f0e08ebdca568491d088469fcd76a1f`.
- installed dependency106 input SHA `ff8b436d78e493a95df42ed22227d3129b7ea53a93bcd2118864e429dfcdd642`.
- dependency R2 result SHA `16daa346e63ace48afaaff4dadb3a95143224347ecccec0fac8adbfadeb4f49f`.

이 범위는 로컬 코드·계약·SDK/harness·브라우저 및 배포 절차 수용이다.
실제 운영전체 감사·배포·이미지 rollback은 `M3-02o-ops`; HealthKit 실제 I/O·UIKit/VoiceOver와
최종 signed 실제 제품 iPhone은 `M3-02h`/`M3-03b`에서 미실행을 유지한다.

## 재현 자료와 판정 한계

읽기 전용 입력 감사 `/private/tmp/wm-ready-backchannel-healthkit-local-evidence-audit-20261009.md`,
native 실행 보고 `/private/tmp/wm-m3o-local-native-sdk-recovery-report-20261009.md`와
[현재 전체 gate](M2-02-current-full-gates-20261009.md)를 함께 따른다.
local completed를 phase APPROVE/main 병합·전체239 인증 복원 또는 공개 출시로 해석하지 않는다.
