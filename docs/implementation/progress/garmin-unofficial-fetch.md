# 비공식 Garmin 개인 다운로드 (`workout-manager fetch`)

**task-graph 노드가 아니다.** 사용자의 명시적 지시로 추가한 개인용 보조 경로이며
`docs/implementation/task-graph.json`은 수정하지 않았다. EXT-G, M0-07b, M1-06b는 `not_started`로 유지한다.

작성일: 2026-09-21. 상태: **구현·로컬 검증 완료, 실제 Garmin 실행 미수행**.

## 이것이 무엇이고 무엇이 아닌가

사용자가 **자기 Garmin 계정의 자기 활동**을 ORIGINAL FIT로 내려받아 기존
[M0-07a 로컬 FIT batch](M0-07a.md)에 넣기 위한 **비공식** 경로다. 제3자 라이브러리
`garminconnect`로 문서화되지 않은 Garmin Connect endpoint를 사용한다.

**공식 Garmin 연동이 아니다.** 제품 기능이 아니고, 자동 동기화가 아니며,
[FUT-04](../../.pre/06_follow_up_backlog.md)가 금지한 대로 파일 가져오기나 mock을 자동 수집으로 표시하지 않는다.
공식 전환 설계는 [garmin-official-transition.md](../research/garmin-official-transition.md)에 분리해 기록했다.

CLI 도움말과 명령의 첫 로그 줄에 다음 위험을 그대로 표시한다: Garmin 약관 위반 가능성, Garmin의 rate limit
또는 계정 조치, Garmin이 endpoint를 바꾸면 즉시 깨짐, 그리고 로그인이 라이브러리 소스에 하드코딩된 Garmin
자체 앱 client 식별자(`GCM_ANDROID_DARK`, `GCM_IOS_DARK`, `GarminConnect`)를 사용하고 `curl_cffi`의
`impersonate="chrome"`으로 브라우저와 유사한 TLS 지문을 제시해 봇 차단을 통과한다는 점.
(first-party client와 "구별 불가"라고는 쓰지 않는다. 확인한 것은 식별자와 TLS 지문까지다.)

이 사실들은 설치본 `garminconnect` 0.3.16의 `client.py`를 직접 읽어 확인했다. 0.3.16에는 `garth` 의존성이
없고(모듈 자체가 설치되지 않는다) 제3자 호스팅 OAuth consumer credential을 받아오지 않는다.
이전에 전달받은 `garth`/S3 기반 설명은 설치본과 달라 채택하지 않았다.

## 구현

- `src/workout_manager/garmin_fetch.py`, CLI `fetch` 하위 명령.
- **선택 의존성.** `garminconnect==0.3.16`은 `[project.optional-dependencies].garmin` 추가 extra다.
  기본 `uv sync`와 CI는 스크래핑 라이브러리도 `curl_cffi`도 설치하지 않는다. `convert`/`export-activity`는
  이 라이브러리를 import하지 않는다. 미설치 상태에서 `fetch`를 실행하면 raw `ImportError` 대신
  설치 명령(`uv sync --extra garmin`)을 담은 안내와 종료 코드 2를 반환한다.
  private 세션 구조와 token 파일 이름에 의존하므로 버전을 정확히 고정했다.
- **읽기 전용 표면은 실수 방지 장치이지 보안 경계가 아니다.** `GarminReadOnlySource`는 불투명 handle
  문자열 하나만 보관한다(`__slots__ = ("_handle",)`). 두 읽기 호출은 module-level 함수이며 private
  레지스트리에서 provider를 찾아 쓴다. 따라서 wrapper에서 속성·`__self__`·`__closure__`·`__wrapped__`·
  `__dict__`를 따라가도 provider 객체나 `upload_activity`/`delete_activity`/`set_activity_*`/
  `add_weigh_in`/`schedule_workout` 같은 변경 메서드에 닿지 않는다.
  **그러나 같은 프로세스 안에서는 숨길 수 없다.** `_read_activities.__globals__`, 예외 traceback,
  모듈 직접 import로 provider에 도달할 수 있고 `release()`는 이미 보유된 참조를 지우지 못한다.
  이 한계를 문서로만 적지 않고 테스트로 고정했다: 속성·closure 경로 순회는 도달 불가를, `__globals__`
  순회는 도달 가능을 각각 단언한다. 격리·샌드박스·보장이라고 쓰지 않는다.
  초기 구현은 bound method를 보관해 `_list.__self__`로 provider에 되돌아갈 수 있었고, 리뷰에서 실제로
  `delete_activity()` 호출이 재현되어 고쳤다. 회귀 순회는 그 설계에 대해 여전히 도달을 검출한다.
  획득·해제는 context manager(`read_only_session`, `login_read_only_session`)로 묶어 대입과 `try`
  사이의 창을 없앴다.
- **경계.** `--start`/`--end`/`--limit`이 모두 필수다. 최대 366일, 최대 200건, 목록 페이지 예산 25페이지.
  기본 "전체 다운로드"가 없다. 예산을 넘기면 조용히 잘라내지 않고 불완전함을 경고로 알린다.
- **transport 정책의 적용 범위(0.3.16 기준, 실제 소스 확인).** 적용되는 곳은 장수명 API 세션 두 개
  (`client.cs`, `client._api_session`)와 DI token 교환·갱신(`client._http_post`)이다.
  **적용되지 않는 곳은 로그인 전략들이다.** 0.3.16은 전략마다 `curl_cffi`/`requests` 세션을 내부에서
  새로 만들어 쓰며 이는 라이브러리 자체 경로라 이 adapter가 통제하지 못한다. 이 범위 문구는 코드
  상수 `COVERAGE_NOTE`로도 남기고 로그인 성공 시 로그에 출력한다.
- **DI token 갱신은 세션을 타지 않는다.** 0.3.16은 module-level `requests.post`/`curl_cffi.requests.post`로
  `diauth.garmin.com`에 POST한다(client.py `_http_post`, 1329·1387). module 함수를 패치하면 프로세스 전체에
  영향을 주므로 인스턴스 메서드를 감쌌다: host 허용목록(+`diauth.garmin.com`), timeout 상한,
  `allow_redirects=False`와 redirect 응답 거부, 1 MiB 응답 상한. 이 경로는 본문이 이미 읽힌 뒤라
  결과 크기만 제한하며 peak memory를 제한하지 않는다.
- **fail closed와 재적용.** 기대 세션이 없거나 request callable을 붙일 수 없으면 실행을 거부한다.
  다만 로그인 후에는 **교체를 거부하지 않고 다시 적용한다**: 0.3.16은 DI 교환 실패 시 JWT_WEB으로
  대체하며 `client.cs`를 **교체한다**(client.py:1280). 교체를 거부하면 실제로 성공한 로그인을 실패시키므로,
  현재 존재하는 세션에 정책을 다시 붙이고 붙일 수 없을 때만 거부한다.
- **timeout은 기본값이 아니라 상한이다.** 라이브러리가 `timeout=None`이나 더 큰 값을 넘겨도 30초로
  대체한다. 더 작은 양수만 그대로 둔다.
- **cross-host redirect는 따라가지 않고 거부한다.** 세션의 자동 redirect를 끄고 hop을 직접 따르되,
  출발 host와 다른 host나 http로의 hop은 요청 자체를 만들지 않고 거부한다. host 집합이 작고 알려져 있으므로
  cross-host hop은 따라갈 목적지가 아니라 이상 신호다. 덕분에 Authorization·Cookie·CSRF 헤더가 다른 host로
  재전송되는 문제와 POST→GET 본문 처리 문제가 함께 사라진다. same-host hop은 최대 3회까지 따른다.
  hop마다, 거부 시에도, hop 한도 초과 시에도 이전 응답을 `close()`한다(`stream=True` 응답은 연결을 잡고 있다).
- **응답 크기는 chunk 단위로 제한한다.** `stream=True`로 헤더를 먼저 보고 `Content-Length`가 64 MiB를
  넘으면 본문을 읽지 않고 닫는다. 길이 헤더가 없거나 거짓으로 작아도 `iter_content()`를 chunk 단위로 읽어
  상한을 넘는 즉시 중단하고 닫는다. 스트리밍 중 오류가 나도 응답을 닫는다. 읽은 본문은 응답에 다시 캐시해
  라이브러리의 `.content`가 동작하게 하고 연결을 돌려준다. `iter_content`가 없는 객체(실무상 테스트 fake)는
  사후 길이 검사만 하며 **peak memory를 제한하지 않는다**.
- **설치 판정은 `is` 비교다.** attribute 비교(위조 가능)를 weak set 멤버십으로 바꿨지만, 집합 멤버십은
  후보의 `__eq__`/`__hash__`를 거치므로 동치를 위조한 callable이 통과했다(리뷰가 재현). 이제 이 모듈이
  설치한 wrapper의 weak reference 목록을 `is`로 직접 비교한다. attribute는 디버깅용 표시로만 남는다.
  그 이전 구현은 세션의 `_workout_manager_request` attribute가 현재 `request`와 같은지만 봤기 때문에,
  그 attribute를 아무 callable로 설정해 두면 "이미 적용됨"으로 통과해 wrapping을 건너뛸 수 있었다.
  이미 우리가 설치한 callable을 들고 있는 세션은 건드리지 않고, 아닌 세션에는 다시 붙인다.
- **다운로드 규칙.** 허용 host(`connectapi.garmin.com`, `connect.garmin.com`)와 HTTPS 검증,
  zip 해제 시 FIT 멤버 1개·64 MiB 상한, temp 파일 fsync 후 원자적 교체(0600), SHA-256,
  `download-manifest.json` 재개 manifest. 실패는 활동별로 격리하고 manifest에 기록하며 run을 중단하지 않는다.
- **CRC를 실제로 검증한다.** framing만 보는 `fit_streams()`로는 header/data CRC가 깨진 파일이 통과해
  `status: success`로 기록되고 resume에서 정상으로 취급된다. M0-07a와 같은 기준으로 검증하도록
  `fit_batch.validate_fit_bytes()`를 추가해 parser CRC 검사를 거치게 했다(회귀 테스트 포함).
- **manifest는 M0-07a 규약을 재사용한다.** `{"version": 1, "entries": {...}}`, `attempts`, `status`,
  `sha256`, `provider`, `activity_id`. 다운로드 항목은 `provider: "garmin-connect-unofficial"`,
  `official: false`를 갖는다. 새 포맷을 만들지 않았다. `output_lock()`에 잠금 파일 이름 인자만 추가했다.
- **429는 목록·다운로드에서만 "재시도 없이 중단"이다.** 429 판정은 예외 클래스 이름과
  `response.status_code`로 하며 선택 의존성을 import하지 않는다. 다운로드에서 429를 만나면 해당 항목을
  실패로 기록하고 `Retry-After`를 redact해 알린 뒤 run을 중단하며 남은 항목은 시도하지 않는다.
  목록 조회의 429도 같은 경로를 거친다(목록 단계에는 기록할 manifest 항목이 없다).
  **로그인은 다르다.** 0.3.16은 429를 받아도 다음 impersonation과 다음 전략으로 계속 시도한다
  (client.py:550·604·974). 이는 `Garmin.login()` 내부 동작이라 이 adapter가 막지 못한다.
  우리 쪽은 로그인을 한 번만 호출하며(테스트로 확인), 라이브러리 내부 재시도는 **미검증**이다.
  요청은 직렬이며 최소 간격 기본 2초, 하한 1초다. 간격은 유한한 값이어야 하며 `nan`은 거부한다
  (`nan`은 모든 비교가 거짓이라 pacing을 통째로 무력화한다).
- **credential.** CLI 인자로 받지 않는다(shell history·프로세스 목록 유출 방지). `GARMIN_EMAIL`/
  `GARMIN_PASSWORD` 환경변수 또는 대화형 입력만 사용하고, MFA는 라이브러리 콜백으로 처리한다.
  `--start`/`--end`/`--limit` 경계는 자격 증명을 읽기 전에 검증한다.
  token 캐시 디렉터리는 0700이고, 마지막 경로뿐 아니라 **상위 경로 전체**에서 symlink를 거부한다.
  라이브러리도 같은 검사를 하지만 `Garmin.login()`이 token load/dump 오류를 삼키고 계속 진행하므로
  그 검사에 의존할 수 없다. 이 검사는 자격 증명을 읽기 전에 실행되며, 검사와 사용 사이의
  TOCTOU는 막지 못한다(최종 경로의 `O_NOFOLLOW`와 사후 0600 확인이 남은 방어다). **umask에 의존하지 않는다**(process 전역이라
  중첩·동시 사용에서 서로를 망가뜨린다). 대신 로그인 전에 token 파일을
  `O_CREAT|O_EXCL|O_NOFOLLOW`·0600으로 미리 만들고, 이미 있으면 그 자리에서 권한을 확인한다
  (생성 시 모드는 기존 파일을 고치지 못하므로). 로그인 성공·실패·인터럽트(`BaseException`) 모두에서
  다시 확인하며, 0600으로 만들 수 없으면 삭제하고 실행을 거부한다. 삭제까지 실패하면 "삭제했다"고 쓰지 않고
  파일이 그대로 남아 있음을 사실대로 알린다. token store 안의 symlink는 건너뛰지 않고 거부한다.
  이 adapter가 직접 만드는 로그에도 token·cookie·비밀번호·계정 메일을 싣지 않으려 하지만, 이것 역시
  **best effort이며 보장이 아니다.** 오류 문구는 패턴 기반 `redact()`와 값 치환 `scrub()`을 거치는데,
  키워드가 붙지 않은 짧은 토큰과 변형된 값(URL 인코딩·잘림·해시)은 **어느 쪽도 잡지 못한다.**
  라이브러리가 스스로 남기는 로그도 아래 filter가 best effort로 덮을 뿐이다.
- **라이브러리 자체 로그도 필터를 거친다.** 0.3.16은 로그인 전략 내부에서 경고를 직접 남기고
  (client.py:585 등) 그 `_sanitize_exception_text()`는 URL query 값만 지우므로, provider HTML(페이지
  제목 등)이 그대로 로그에 실릴 수 있다. 이 레코드들은 우리 오류 경계를 통과하지 않으므로
  `garminconnect` 로거에 scrubbing filter를 붙이고 로그인 동안 propagate를 끈다. 호출자가 이미 붙여 둔
  handler는 제거하지 않고 같은 filter를 추가해 계속 받게 하며, 종료 시 handler·filter·propagate를 모두
  원래대로 되돌린다(context manager).
  **filter와 handler는 로그인마다가 아니라 하나를 공유한다.** 가장 바깥 context만 설치·복원하고, 각
  context는 자기 비밀 값을 공유 filter에 등록·해제하며 filter는 **현재 활성인 모든 비밀 값의 합집합**으로
  치환한다. 로그인마다 filter를 따로 두던 구현에서는, 두 로그인이 겹칠 때 한쪽 레코드가 다른 쪽
  handler(자기 비밀 값만 아는)를 먼저 통과해 비밀번호가 그대로 출력되는 **실제 유출**이 있었다.
  **진입 자체도 원자적이어야 한다.** 등록·depth 증가까지만 lock을 잡고 설치 전에 놓아 주던 구현에서는,
  그 사이에 들어온 두 번째 context가 "바깥이 아님"으로 판단해 아무것도 설치하지 않고 본문으로 진입했고,
  공유 filter가 아직 로거에 붙지 않은 상태에서 남긴 레코드가 그대로 나갔다(리뷰가 재현).
  지금은 등록·depth 증가·설치를 하나의 lock 구간에서 처리하고, 로그인 본문은 lock 밖에서 돈다.
  두 유출 모두 스레드 없는 순차 테스트로는 드러나지 않는다. 앞의 것은 두 스레드가 동시에 활성인 상태로,
  뒤의 것은 **진입 창 안에서** 첫 스레드를 멈춰 세우는 방식으로 각각 회귀 테스트한다.
  두 재현 스크립트 모두 이전 구현에서 `leaked True`, 현재 구현에서 `leaked False`를 낸다.
  depth로 설치·복원 시점을 정하므로 바깥 context가 먼저 끝나도 안쪽이 살아 있는 동안은 그대로 두고,
  마지막 종료만 원래 handler 목록과 `propagate`를 되돌린다. filter 추가는 `try` 안에서 하므로 어떤
  handler의 `addFilter()`가 실패해도 앞서 추가한 filter가 남지 않는다. 다만 **root 로거**에만 handler를
  둔 구성은 로그인 동안 provider 레코드를 받지 못하고, 이 로거가 **다른 로거와 공유하는 handler**가
  있다면 로그인 동안 그 handler의 무관한 레코드에도 이 filter가 적용된다. **best effort이며 보장이 아니다**
  (직접 출력·다른 로거 이름·설치 이전 레코드는 덮지 못한다). 자격 증명 값은 로그인이 끝나면 버린다.
- **자격 증명은 예외를 올리는 프레임에 없다.** 이전 구현은 로그인 프레임에서 sanitize한 예외를 올려
  `__traceback__.tb_frame.f_locals`에 평문 비밀번호와 (비밀번호를 보관하는) api 객체가 그대로 남았다.
  이제 자격 증명을 다루는 프레임은 내부 함수 하나로 분리했고, 그 함수는 예외가 아니라 `LoginOutcome`
  값을 돌려준다. 실제 raise는 email·password를 한 번도 가진 적 없는 바깥 프레임에서 일어나며,
  내부 프레임은 `finally`에서 자격 증명 지역변수를 지우고 실패 시 api 참조도 버린다.
  라이브러리 오류 문구가 키워드 없이 비밀번호를 그대로 echo하는 경우까지 막기 위해 실제 값을
  문자열 치환(`scrub()`)한다. 치환은 **`redact()`보다 먼저**, 정규화되지 않은 원문에 적용한다
  (`redact()`가 공백을 정규화하므로 개행이 든 비밀번호는 그 뒤에는 원형으로 남지 않는다).
  코드에서는 `redact(scrub(raw, password, email))` 순서다.
  너무 짧아 안전하게 치환할 수 없는 비밀번호(8자 미만)는 조용히 넘기지 않고 거부한다. 검사는
  `read_credentials()`가 아니라 자격 증명이 실제로 들어오는 지점(`_perform_login`)에서 하므로
  주입된 `credentials` 콜백도 우회할 수 없다. Garmin 공식 계정 생성·비밀번호 재설정 문서가 8자 이상을
  요구하므로 오늘 Garmin이 받아들일 비밀번호를 막지는 않는다. 다만 기존 계정이 더 짧은 비밀번호를
  유지할 수 있는지는 확인하지 못했다.
  정확 일치만 잡으므로 URL 인코딩·잘림·분할·해시 같은 변형은 잡지 못한다. 로그인 중 인터럽트는 라이브러리 프레임을 지울 수 없으므로
  **원본 traceback을 의도적으로 버리고** 바깥 프레임에서 새 `KeyboardInterrupt`를 올린다.
  참고: 라이브러리는 로그인 성공 후 `self.password = None`으로 평문을 지운다(`__init__.py`:948).
- **공급자 예외는 한 곳에서만, 컨텍스트 없이 밖으로 나간다.** 목록·다운로드·로그인·CLI의 공급자 예외는
  (인터럽트는 예외다. 새 `KeyboardInterrupt`로 올라간다)
  `provider_failure()`/`redact()`를 거쳐 **새로 만든** `UnofficialFetchError`가 되고, `except` 블록을
  **벗어난 뒤에** raise된다. `raise ... from None`은 표시만 감출 뿐 `__context__`에 원본 예외와 그
  traceback(응답·쿠키·헤더까지)을 남기므로 쓰지 않는다. 테스트가 `__context__`·`__cause__`와 traceback
  순회로 원본 예외가 도달 불가임을 확인한다.
- **resume 해시는 경계가 있다.** 기존 출력 파일을 통째로 읽지 않고 크기를 먼저 확인한 뒤 스트리밍으로 해시한다.
- **기본이 안전.** `--execute` 없이는 네트워크에 접근하지 않고 안내만 출력하며 종료 코드 2다
  (`scripts/probe-routing.mjs`, `scripts/backup-restore-drill.mts`와 같은 규약). `CI` 환경변수가 있으면 거부한다.
- `.gitignore`에는 token 캐시 경로와 다운로드 출력 디렉터리(`garmin-downloads/`)만 추가했다.
  `download-manifest.json`을 전역으로 무시하면 나중에 공식 경로 manifest 커밋을 막으므로 넣지 않았다.
  개인 FIT/GPS·token은 커밋하지 않는다.

## 실제 검증 결과

| 실행                         | 결과                                             |
| ---------------------------- | ------------------------------------------------ |
| `uv run ruff check .`        | All checks passed                                |
| `uv run ruff format --check` | 231 files already formatted                      |
| `uv run pytest`              | 213개 통과(기존 75개 + 이번 138개), extra 미설치 |
| `pnpm format:check`          | All matched files use Prettier code style        |

테스트는 전부 합성 fixture와 fake source를 사용하며 `garminconnect`를 import하지 않는다. 위 pytest 결과는
`garmin` extra를 **설치하지 않은** 환경에서 얻었다. 자격 증명·live provider·네트워크가 필요 없다.
선택·검증·쓰기를 분리해 각각 단독으로 검증했다. **단정적으로 쓴 주장은 아래에 근거 테스트를 명시한다.
근거를 댈 수 없는 문장은 이 표에 넣지 않고 본문에서도 약하게 쓴다.**

| 주장                                                                                                                                                                                           | 근거 테스트                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 속성·`__self__`·`__closure__`·`__wrapped__`·`__dict__` 경로로 provider에 도달하지 못한다                                                                                                       | `test_provider_is_not_reachable_by_attribute_or_closure_paths`                                                                                                                                                                                                                             |
| 단, `__globals__`로는 도달한다(보안 경계가 아님)                                                                                                                                               | `test_module_globals_do_reach_the_provider_this_is_not_a_boundary`                                                                                                                                                                                                                         |
| wrapper 클래스 표면은 세 메서드뿐이다                                                                                                                                                          | `test_the_wrapper_class_exposes_nothing_beyond_the_allowlist`                                                                                                                                                                                                                              |
| 설치 판정은 `is` 비교이며 marker·동치 위조가 통과하지 못한다                                                                                                                                   | `test_a_forged_marker_does_not_pass_as_hardened`, `test_a_callable_forging_equality_does_not_pass_as_hardened`                                                                                                                                                                             |
| 세션 집합이 부분적으로만 적용되면 거부한다                                                                                                                                                     | `test_harden_client_fails_closed_on_partial_application`                                                                                                                                                                                                                                   |
| 로그인 중 교체된 세션은 거부가 아니라 재적용한다                                                                                                                                               | `test_a_session_replaced_during_login_is_rehardened_not_rejected`                                                                                                                                                                                                                          |
| cross-host redirect는 요청 자체가 발생하지 않는다                                                                                                                                              | `test_a_cross_host_redirect_is_refused_and_never_requested`                                                                                                                                                                                                                                |
| timeout은 기본값이 아니라 상한이다                                                                                                                                                             | `test_timeout_is_enforced_not_defaulted`, `test_hardened_session_overrides_a_larger_provider_timeout`                                                                                                                                                                                      |
| token 교환에서 `allow_redirects=True`는 무시된다                                                                                                                                               | `test_the_token_exchange_enforces_rather_than_defaults_redirect_policy`                                                                                                                                                                                                                    |
| 응답 크기는 chunk 단위로 제한되며 거짓 `Content-Length`도 통하지 않는다                                                                                                                        | `test_a_body_past_the_cap_aborts_mid_stream_and_closes`, `test_a_falsely_small_content_length_does_not_defeat_the_cap`                                                                                                                                                                     |
| CRC가 깨진 FIT은 success로 기록되지 않는다                                                                                                                                                     | `test_crc_corrupt_download_is_never_recorded_as_success`                                                                                                                                                                                                                                   |
| 올라가는 예외에 provider 예외가 `__context__`/traceback으로 남지 않는다                                                                                                                        | `test_a_sanitized_failure_carries_no_provider_context`, `test_an_aborted_download_carries_no_provider_context`                                                                                                                                                                             |
| 로그인 실패·인터럽트 시 메시지·프레임 지역변수·예외 보존 경로에서, 비밀번호를 **부분 문자열로 포함한** 값도 없다(str·bytes 같은 규칙, 컨테이너 1단계와 함수 기본값 포함)                       | `test_a_login_failure_leaks_no_credentials_in_message_or_traceback`, `test_an_interrupt_during_login_clears_the_credential_locals`                                                                                                                                                         |
| 치환은 정규화 이전 원문에 적용된다                                                                                                                                                             | `test_scrub_runs_before_normalization_can_hide_a_secret`                                                                                                                                                                                                                                   |
| 8자 미만 비밀번호는 거부한다                                                                                                                                                                   | `test_a_password_too_short_to_scrub_is_refused`                                                                                                                                                                                                                                            |
| token 파일은 로그인 전에 0600으로 만들어지고 기존 느슨한 권한도 잡힌다                                                                                                                         | `test_the_token_file_is_created_owner_only_before_login`, `test_a_pre_existing_loose_token_file_is_caught_before_login`                                                                                                                                                                    |
| 0600을 만들 수 없으면 삭제·거부하고, 삭제까지 실패하면 사실대로 보고한다                                                                                                                       | `test_a_loose_token_file_is_removed_and_the_run_refused`, `test_an_unremovable_loose_token_file_is_reported_truthfully`                                                                                                                                                                    |
| token 경로의 상위 symlink를 거부한다                                                                                                                                                           | `test_a_symlinked_parent_in_the_token_path_is_refused`                                                                                                                                                                                                                                     |
| 라이브러리 로거를 필터링하고, 정상 종료·중첩(겹침) 종료·filter 추가 실패에서 handler·propagate·filter를 원상복구하며, 동시 활성 로그인과 **진입 창 안에서도** 서로의 비밀 값을 유출하지 않는다 | `test_the_provider_logger_is_scrubbed`, `test_overlapping_scrubbing_contexts_restore_the_original_state`, `test_a_handler_that_refuses_a_filter_leaves_nothing_behind`, `test_concurrent_logins_do_not_leak_each_others_secrets`, `test_a_second_login_cannot_log_inside_the_entry_window` |
| 경계 검증이 자격 증명보다 먼저 실행된다                                                                                                                                                        | `test_bounds_are_rejected_before_any_credential_work`                                                                                                                                                                                                                                      |
| 로그인 429에서 우리 쪽은 재시도하지 않는다                                                                                                                                                     | `test_our_login_path_does_not_retry_after_a_429`                                                                                                                                                                                                                                           |
| `nan` 간격을 거부한다                                                                                                                                                                          | `test_rate_limiter_refuses_an_unusable_interval`, `test_cli_refuses_a_nan_min_interval`                                                                                                                                                                                                    |
| `--execute` 없이는 네트워크에 접근하지 않고 CI에서는 거부한다                                                                                                                                  | `test_fetch_requires_the_execute_opt_in`, `test_fetch_is_disabled_in_ci`                                                                                                                                                                                                                   |
| 자격 증명 유사 flag가 축약으로 통과하지 않는다                                                                                                                                                 | `test_fetch_takes_no_credential_arguments`                                                                                                                                                                                                                                                 |

나머지(목록 페이지 예산, manifest 재개, 항목별 실패 격리, zip 구조 거부, extra 미설치 안내, hop 한도,
스트리밍 중 오류 시 close, 도움말 문구 등)도 같은 파일의 테스트로 덮여 있으나 단정적 주장은 아니다.

extra를 설치한 환경에서도 pytest 213개가 통과했다. 실제 `garminconnect` 0.3.16 `Garmin` 객체(네트워크
호출 없이 생성만)에 대해 직접 확인한 것은 다음이다: `harden_client()`가 세션 2개에 정책을 적용하고,
`harden_token_exchange()`가 `client._http_post`를 실제로 교체하며, `reharden_after_login()`이 다시 2를
반환하고, 세 callable 모두 `is_installed_by_us()`로 참이며, 실제 wrapper에서 네 참조 경로를 순회해도
provider 객체와 `delete_activity`에 도달하지 못한다. 같은 순회를 초기(결함) 설계에 적용하면 둘 다
도달하고, 실제 traceback 지역변수도 순회에 잡히므로 이 테스트는 무의미하지 않다.

## 검증하지 못한 것

- **실제 Garmin 계정에 대한 다운로드를 실행하지 않았다.** 사용자의 실제 자격 증명을 사용하지 않았다.
  로그인 흐름, MFA 콜백, 실제 목록 응답 필드, ORIGINAL zip의 실제 내용, 실제 429·`Retry-After` 동작,
  token 캐시 재사용은 **모두 미검증**이다.
- `garminconnect` 0.3.16의 내부 동작(재시도·backoff·client 식별자)은 설치본 코드를 읽어 확인했을 뿐
  실행으로 확인하지 않았다. 버전이 오르면 다시 확인해야 한다.
- 개인 FIT/GPS 자료는 검증·커밋에 사용하지 않았다.
- `stream=True`와 `iter_content()` 소비, 그리고 본문을 응답에 되돌려 캐시하는 처리(`_content`,
  `_content_consumed`)가 라이브러리의 모든 호출 경로에서 올바른지는 실제 네트워크로 확인하지 않았다.
  이는 `requests.Response`의 private 속성에 의존한다.
- 로그인 전략 내부의 `curl_cffi`/`requests` 세션에는 timeout·host·redirect·크기 정책이 적용되지 않는다.
  로그인 429 이후 라이브러리가 impersonation·전략을 바꿔가며 재시도하는 동작도 **미검증**이며 우리가
  막을 수 없다. 429가 반복되면 Garmin 쪽 rate limit을 더 자극할 수 있다.
- DI token 교환 wrapper는 `client._http_post`라는 private 메서드에 의존한다. 실제 token 갱신이
  이 wrapper를 통과하는지는 실행으로 확인하지 않았다.
- 상위 경로 symlink 검사는 검사 시점 기준이며 TOCTOU를 막지 못한다.
- token 파일 이름(`garmin_tokens.json`)은 고정된 0.3.16의 `token_file_path()`와 일치함을 실제 함수로
  대조해 확인했으나, 실제 로그인이 그 파일을 쓰는 것은 실행으로 확인하지 않았다.
- transport 정책의 적용 범위는 `client.cs`, `client._api_session`, `client._http_post` 세 곳이다.
  로그인 전략이 내부에서 만드는 `curl_cffi`/`requests` 세션에는 적용되지 않는다.
  `harden_client()`·`harden_token_exchange()`는 로그인 전에, `reharden_after_login()`은 로그인 후에 돈다.
- 라이브러리 로그 scrubbing은 **best effort**다. `garminconnect` 로거로 나가는 레코드만 필터를 거치며,
  라이브러리가 직접 출력하거나 다른 이름으로 로깅하거나 필터 설치 이전에 남기는 것은 덮지 못한다.
  값 치환도 정확 일치만 잡는다. URL 인코딩·잘림·분할·해시·대소문자 변형은 잡지 못한다.
- `sso.garmin.com`과 `mobile.integration.garmin.com`을 허용 목록에 넣어 JWT_WEB fallback과 legacy 갱신
  요청이 거부되지 않게 했다. 다만 **cross-host redirect는 여전히 거부**하므로, 그 흐름이 host를 넘나드는
  redirect를 쓴다면 실패할 수 있고 라이브러리가 예외를 삼켜 조용히 실패한다. 실제 로그인 검증 전까지
  이는 알려진 기능적 한계다.
- 인터럽트의 원본 traceback은 자격 증명 보호를 위해 버린다. 대신 지역변수 없는 위치 요약
  (파일:줄:함수)만 로그에 남기므로, 실제 hang 원인 분석에 쓸 정보는 그만큼 줄어든다.

## 범위 밖

공식 entitlement, 파트너 명세, 자동 수집, webhook, 제품 화면 연결은 구현하지 않았다.
이 문서와 구현은 EXT-G·M0-07b·M1-06b의 완료 증거가 아니며 세 노드의 상태를 바꾸지 않는다.
