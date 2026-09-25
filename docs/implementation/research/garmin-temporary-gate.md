# 임시 Garmin gate (비공식, `garminconnect`)

작성일: 2026-09-25. 범위: 새 노드 `EXT-G-tmp`(결정 기록)와 `M1-06b-tmp`(임시 앱 내 수집).

## 사용자 결정 (2026-09-25)

사용자가 질문 답으로 다음을 정했다.

- 공식 Garmin 권한(`EXT-G`)을 기다리는 동안 **`python-garminconnect`로 만든 임시 gate를 쓰고, 나중에 원래 계획(공식
  연동)으로 갈아 끼운다.**
- 임시 경로의 범위는 **앱 내 수집까지**다. 기존 개인용 `workout-manager fetch` CLI에 더해, 소유자 자신의 Garmin
  계정에서 새 활동을 앱이 가져오는 임시 server adapter를 만든다. 출시 검증(`M2-07`)과 Web MVP gate(`G2`)는 임시
  경로로 통과시키지 **않는다**.
- 기록 방식은 **별도 임시 노드**다. 공식 `EXT-G`, `M0-07b`, `M1-06b`, `M2-07`은 `not_started`로 남기고, 임시 노드는
  공식 노드가 끝나면 은퇴한다.
- 자격 증명은 **앱의 credential 저장소**를 쓴다. 사용자가 앱 설정에서 Garmin 로그인을 한 번 입력하고, 그 결과
  session token만 암호화해 저장한다.

## 이것이 무엇이 아닌가

- **공식 연동이 아니다.** [공식 전환 설계](garmin-official-transition.md) 1절의 이유(권한 주체, 명세, 동의·철회 원장,
  운영 정당성)는 그대로다. `EXT-G`의 요구(공식 entitlement·파트너 명세·검증 계정)를 충족하지 않으며 `EXT-G`의 증거가
  아니다.
- **출시된 제품 기능이 아니다.** 앞선 기록([공식 전환 설계](garmin-official-transition.md) 1절, [비공식 fetch
  기록](../progress/garmin-unofficial-fetch.md))은 비공식 경로를 개인이 자기 데이터를 내려받는 용도로만 두었다.
  2026-09-25 결정은 그 범위를 **배포 소유자 한 명의 앱 내 adapter**까지만 넓힌다. 여전히 출시 기능이 아니고 `EXT-G`의
  증거가 아니다.
- **출시 근거가 아니다.** AGENTS.md의 "Web MVP includes the specified official Garmin integration"은 바뀌지 않는다.
  `G2`는 여전히 `M2-07`(공식 연동)을 거친다. `M1-06b-tmp`는 어떤 공식 노드나 gate의 `dependsOn`도 충족하지 않는다.
- **다른 사용자에게 쓰지 않는다.** 배포 설정이 지정한 소유자 앱 계정 하나만 연결할 수 있고, 그 계정은 처음 연결한
  Garmin 계정 하나에만 묶인다(조건 3).

## 받아들인 위험 (사용자 결정의 전제)

[비공식 fetch 기록](../progress/garmin-unofficial-fetch.md)이 확인한 사실을 그대로 옮긴다.

- Garmin 약관 위반 가능성, rate limit 또는 계정 조치.
- 문서화되지 않은 endpoint를 쓰므로 Garmin이 바꾸면 사전 고지 없이 깨진다.
- 로그인은 라이브러리 소스에 하드코딩된 Garmin 자체 앱 client 식별자(`GCM_ANDROID_DARK`, `GCM_IOS_DARK`,
  `GarminConnect`)와 `curl_cffi`의 `impersonate="chrome"` TLS 지문을 쓴다.
- 앱 내 수집에서는 비밀번호가 로그인 동안 server를 지나간다(저장하지 않는다).
- **저장한 session token은 Garmin 계정 전체 권한이다.** 쓰기·삭제도 된다. 읽기 전용 wrapper는 보안 경계가 아니다
  (fetch 기록의 시험이 같은 프로세스 안에서 도달 가능함을 단언한다). token을 server에 두면 CLI의 로컬 파일보다 server
  침해 때의 피해 범위가 넓다.
- **연결 해제로 Garmin 쪽 세션을 끊을 수 없다.** 비공식 경로에는 철회 endpoint가 없으므로 로컬 token 삭제 뒤에도
  Garmin 세션은 유효할 수 있다.

## 임시 경로가 지켜야 할 조건 (`M1-06b-tmp` 수용 기준의 근거)

1. **표시.** 화면·동기화 상태·내보내기 어디에서도 공식 연동으로 보이지 않는다. 연결 화면과 활동 출처에 "비공식 임시
   연결"과 위험을 적는다. FUT-04가 금지한 대로 파일 가져오기나 mock을 자동 수집으로 표시하지 않는다. 동기화 상태와
   실패는 공식 연동 상태와 분리해 보인다.
2. **자격 증명.**
   - (a) **전송 중 비밀번호.** 로그인 요청 한 번에만 쓴다. request/body 로그(Fastify 포함)·trace·오류 추적·outbox·job
     payload에 남지 않는다. Python 쪽으로는 argv·환경변수가 아니라 stdin pipe 같은 경로로만 넘긴다.
   - (b) **MFA.** 대기 중인 MFA 상태(`garminconnect`의 `return_on_mfa`/`resume_login` 등)는 메모리에만 두고, 앱 session에
     묶고, 짧은 TTL을 두며, 영속하지 않는다.
   - (c) **로그인 endpoint 한도.** rate limit과 실패 시 lockout backoff를 두어 소유자의 Garmin 계정을 보호한다.
   - (d) **라이브러리 자체 token 파일 금지.** 기본 `~/.garminconnect` 저장소를 끄고, token은 암호화 저장소에서만
     읽으며 갱신된 token도 그곳에만 되쓴다(M1-06c의 refresh lease/CAS).
   - (e) **키 위치.** M1-06c와 같은 AES-256-GCM 방식과 keyring/secret manager를 쓰고 키는 저장소·DB에 두지 않는다.
     AAD에 별도 purpose 값을 넣어 비공식 token이 공식 credential로 복호화·사용될 수 없게 한다.
   - (f) **철회 불가 안내.** 연결 해제·계정 말소 화면은 Garmin 쪽 세션이 남을 수 있음을 알리고 끊는 방법(비밀번호 변경,
     세션 로그아웃)을 안내한다. M1-06c의 원격 철회 정리 queue는 비공식 token에 대해 돌지 않는다.
   - (g) **export와 복원.** export 결과에는 token이 없다. 백업 복원은 백업의 token이나 시도를 다시 쓰지 않는다
     (M1-06c의 기존 규칙). 연결 해제·계정 말소 때 token을 삭제한다.
3. **소유자 한정.** 배포 설정이 소유자 앱 계정(tenant) 하나를 지정하며 기본값은 꺼짐이다. 설정이 없거나 CI에서는
   adapter가 꺼진다. 다른 앱 계정의 연결 요청은 일정한 403을 받는다. 첫 로그인 성공 때 Garmin profile ID를 고정하고,
   다른 Garmin profile로의 로그인은 거절한다.
4. **수집 실행과 실패.** 수집은 사용자의 "지금 가져오기"와 예약 실행 둘 다 가능하되, 예약 실행은 소유자가 켤 때만 돈다.
   - 연결당 한 번에 하나의 run만 돈다(lease와 중복 방지).
   - DB 트랜잭션 안에서 provider를 호출하지 않는다.
   - 429를 받으면 멈추고 `Retry-After`를 따르며 예약을 멈춘다.
   - 인증·MFA 실패는 재시도하지 않고 "다시 연결 필요" 상태로 둔다. 일시 오류와 영구 오류를 구분한다.
   - 기존 fetch의 경계(기간·건수·페이지 예산, 직렬 요청과 최소 간격, 허용 host, 응답 크기 상한, CRC 검증)를 재사용한다.
5. **가져온 데이터.** ORIGINAL FIT을 기존 import 경로(M0-07a·M1-03)로 넣는다. 중복 import는 기존 idempotency로
   막고, 삭제한 활동과 삭제 억제(suppression)를 이후 run이 우회해 다시 가져오지 않는다. 출처는
   `garmin-connect-unofficial`, `official: false`로 남긴다. provider payload·cookie는 AGENTS.md의 log redaction 규칙을
   따른다.
6. **교체 가능성.** 공식 adapter(`M1-06b`)와 같은 수집 interface 뒤에 둔다. 공식 adapter가 같은 활동을 다시 가져오지
   않도록 provider 간 중복 판정을 둔다. 공식 연동이 오면 임시 adapter와 저장된 token을 지우는 절차를 runbook에 둔다.
7. **Python 의존.** `garminconnect==0.3.16`은 Python이다. 앱 server(TypeScript)에서 쓰는 방식(별도 Python worker,
   child process 등)은 `M1-06b-tmp`에서 정하되, 선택 의존성으로 두어 기본 설치·CI가 스크래핑 라이브러리를 받지 않게
   한다.
8. **증거.** 합성 fixture 시험은 구현 증거이고, 실제 Garmin 계정 실행은 사용자가 앱에서 로그인해야 하는 별도 증거다.
   실제 실행 전까지 그 항목은 `not_executed`로 적는다.
9. **비공허성(변이).** 다음이 각각 실패해야 한다: 비소유자 앱 계정의 연결 허용, 다른 Garmin profile 허용, 비밀번호가
   job payload·argv·request 로그에 남음, token 평문 저장, token 파일이 디스크에 쓰임, 말소 뒤 token 잔존, 비공식 표시 제거,
   삭제한 활동의 재수집.

## 공식 연동으로 갈아 끼울 때

`EXT-G`가 풀리면 공식 노드(`M0-07b`, `M1-06b`, `M2-07`)를 원래 범위대로 진행한다. 공식 adapter가 착지하면 임시
adapter를 끄고, 저장된 비공식 token을 삭제하고, 소유자에게 Garmin 쪽 세션 정리를 다시 안내한다. task graph의 상태 값은
completed·in_progress·not_started뿐이므로, 임시 노드의 "은퇴"는 scope 끝에 "은퇴(날짜, 대체 노드)"를 덧붙여 기록한다.
비공식 출처로 들어온 활동은 사용자 데이터로 남고 출처 표시는 그대로 둔다.
