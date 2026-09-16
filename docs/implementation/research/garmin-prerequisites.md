# Garmin 연결 선행 조건

확인일: 2026-09-16. 범위: M0-06a / FUT-04 / V2-F25–F28, F30–F31.
공개 문서 조사 완료이며 이 프로젝트의 신청·승인·실연동을 확인한 것은 아니다.

## 공개 근거와 프로젝트 상태

공식 [FAQ](https://developer.garmin.com/gc-developer-program/program-faq/)는 프로그램을 사업용으로 설명하며
신청·승인을 요구한다. OAuth 2.0을 사용하고, 일반 프로그램 접근 비용과 일부 지표의 상업 조건을 구분한다.
따라서 개인 Garmin 계정 보유나 공개 SDK 설치를 Activity/Health API 사용 권한으로 취급할 수 없다.
파트너 계정·계약별 비용은 확인되지 않았으며 견적을 추정하지 않는다.

[Activity API](https://developer.garmin.com/gc-developer-program/activity-api/)는 사용자 동의와 Connect 동기화 후
활동 파일(FIT/GPX/TCX), push 또는 ping/pull, backfill 도구와 승인 후 평가 환경을 설명한다.
[Health API](https://developer.garmin.com/gc-developer-program/health-api/)에는 심박·수면·스트레스·Body Battery 등이 소개된다.
이는 이 앱이 모든 기기·지표에 접근할 수 있다는 증거가 아니다. Training Readiness/Recovery Time 등은
실제 entitlement와 파트너 payload를 받기 전까지 미확인으로 남긴다.

앱 로그인은 구현된 표준 OIDC를 유지한다. Garmin OAuth는 별도 provider 연결이며,
공개 OAuth 2.0 안내만으로 OIDC 지원이나 특정 callback/token/webhook 규격을 추론하지 않는다.

## 권한 추적표

상태의 `미확인`은 미신청·거절을 뜻하지 않는다. 저장소와 이번 대화에 증빙이 없다는 의미다.
사용자 계정·메일·비밀 환경변수는 조사하지 않았고, 신청서나 외부 메시지를 보내지 않았다.

| 항목                          | 현재 상태   | 확보할 증거                                            | 후속 task |
| ----------------------------- | ----------- | ------------------------------------------------------ | --------- |
| 사업/제품 사용 목적·신청 자격 | 미확인      | 담당자 확인 및 신청 가능한 제품 설명                   | EXT-G     |
| 신청 접수·추가 자료·심사 결과 | 미확인      | 접수 일자/비밀이 아닌 증빙 참조와 승인 결과            | EXT-G     |
| Activity / Health entitlement | 각각 미확인 | 파트너 portal 권한과 허용된 데이터 범위                | EXT-G     |
| 평가 / production 접근        | 각각 미확인 | 환경별 권한과 테스트 계정 동의                         | EXT-G     |
| 지표별 상업 조건              | 미확인      | 적용 계약/견적·표시 의무 확인                          | EXT-G     |
| API 명세·변경 정책            | 미확인      | 승인된 문서의 버전/확인일                              | M1-06b    |
| 실제 FIT/JSON fixture         | 없음        | 동의받은 비식별 샘플과 provenance                      | M1-06b    |
| 자동 수집 회귀                | 미실행      | 연결→수신→정본→UI 및 철회·만료·중복·역순·backfill 결과 | M1-06b    |

문서·fixture에는 credential을 넣지 않는다. 비공개 계약 원문 대신 접근 통제된 증빙의 참조만 기록한다.
접수·승인·실연동 상태는 독립적으로 갱신하며 EXT-G는 실제 권한 증거 전까지 완료하지 않는다.

## 승인 뒤 구현 입력

다음은 공개 소개의 사실이 아니라 저장소 설계를 구현하기 위해 **필요한 확인 항목**이다.

- 환경별 authorize/token/revoke URL, redirect·scope·PKCE 지원, subject 식별과 refresh/철회 동작.
- 이벤트 인증 방법, 재전송·정렬·중복 식별, backfill 기간과 quota, 오류·retry-after 의미.
- 허용된 파일 URL origin/redirect/유효기간, 다운로드 크기와 content hash, 파일·JSON revision 관계.
- source ID·측정 시각·timezone·누락 필드 의미, Activity/Health별 capability와 데이터 사용 범위.
- token 암호화·회전/동시 refresh, queue 재시도, source suppression과 계정 전체 삭제 처리 시험.

Webhook 서명 형식·endpoint·payload를 가정해 production adapter를 만들지 않는다.
M1-03의 로컬 FIT JSON 가져오기는 계속 사용 가능하며 공식 자동 동기화와 구분한다.
