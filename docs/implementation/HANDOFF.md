# 다음 세션 handoff · 2026-09-23

최신 상태는 [task-graph.json](task-graph.json), 요구·수용 기준은
[docs/.pre](../.pre/README.md), 작업 규칙은 [AGENTS.md](../../AGENTS.md)를 우선 확인한다.
재개할 때 `git log -1`, `git status --short`, 원격 동기화를 다시 확인한다.

## 사용자 결정과 작업 방식

- 브랜치는 `main`이다. 사용자는 본인 관리 원격 저장소로 task별 peer review, commit,
  `git push origin main`과 다음 ready 작업 계속 진행을 승인했다. 일반적인 push 실패는 기록하고
  다음 ready 작업을 진행한다.
- AGENTS·skill 규칙은 명시적 규칙 변경 요청 없이 수정하지 않는다. 사용자 변경과 untracked 파일을
  보존한다.
- 구현 분해는 Codex native orchestration, 커밋 전 독립 검토는 같은 tab의 Herdr split pane을 사용한다.
  UI 검증은 Aside → Chrome → Playwright 순서를 지킨다.
- JavaScript workspace는 Node 24.12.0과 pnpm 10.34.5로 검증했다.

## 완료된 최신 작업

[M2-01u](progress/M2-01u.md)를 완료했다. **fixture가 숨기고 있던 인증 보안 결함을 찾아 고쳤다.**
앱에서 로그아웃한 뒤 "OIDC로 로그인"을 누르면 실제 OP가 자기 SSO 세션으로 답해 **자격 증명을 묻지
않고 이전 사용자를 다시 로그인**시켰다 — 공용 브라우저에서 다음 사람이 앞 사람 계정에 들어간다.
지금까지 시험하던 fixture OP(`scripts/fixtures/oidc-provider.ts`)는 세션이 없어 매번 선택 화면을
보여 줬고 그래서 기존 시험이 초록이었다. 로그아웃이 표식 쿠키를 심고, 표식이나 세션 쿠키가 있으면
다음 로그인이 `prompt=login`을 보낸다. 표식 없는 첫 로그인은 SSO를 유지한다.

**운영 IdP는 외부 gate다(EXT-OIDC).** IdP가 선택되지 않았다(사용자 결정 "표준 OIDC, 공급자
비종속"). 대신 OpenID Certified OP(panva `oidc-provider`, 시험 전용 devDependency)를 운영 등록과
같은 설정으로 로컬에서 띄워 제품의 실제 RP 코드를 끝까지 돌렸다. **이것은 로컬 certified OP의
증거이지 운영 IdP의 증거가 아니다** — M2-01k의 `K-oidc` 행은 not_executed로 남는다.

**수정을 우회하는 경로를 독립 검토가 두 번 찾았다.** 첫째, 세션이 이미 만료된 상태의 로그아웃은
`preValidation`에서 401이 나 표식이 남지 않았다(공용 브라우저에서 자리를 비운 뒤 로그아웃 — 결함이
가장 해로운 시나리오). 그것을 401에도 표식을 심어 고치자, **둘째로 그 수정이 새 회귀를 만들었다**:
세션 쿠키가 `SameSite=Lax`라 cross-site POST에 실리지 않으므로 **로그인 중인 피해자도 서버에는
"세션 없음"**으로 보였고, 401 분기가 Origin·CSRF 없이 세션 쿠키를 지워 **어떤 사이트든 로그인
사용자를 로그아웃시킬 수 있었다.** 검토자가 실제 Chromium에서 재현했다. 구현자가 적은 "이미 무효인
쿠키만 지운다"는 CSRF 근거는 **실측 없는 추론이었고 거짓**이었다. 이제 401 분기는 **표식만** 심고
세션 쿠키는 건드리지 않으며(a), **허용된 origin에서 온 경우에만** 심는다(b). 검토자가 자기 재현으로
공격 변형 8가지(top-level, popup, referrer를 끄는 세 방식, sandbox iframe 둘, no-cors fetch)를
시도해 전부 막혔다.

**교훈**: 보안 근거를 추론으로 쓰지 말고 실측할 것. 그럴듯한 추론이 `SameSite=Lax`의 한 성질에서
무너졌다.

**분리한 노드**: EXT-OIDC(운영 IdP 외부 gate), M2-01w(OIDC 운영 견고성 — OP가 내려가면 API가
뜨지 않음, OP에서 비활성화한 계정이 최대 8시간 앱 세션 유지, 취소 시 날것의 401 JSON, `auth_time`
미확인. 마지막은 코드만으로 가능하지만 IdP가 `prompt=login`을 지원하지 않으면 로그아웃 뒤 로그인이
아예 실패하므로 IdP 선택에 달렸다).

## 다음 ready 작업

M2-01s·o는 독립 검토를 통과해 병합 대기, M2-01q는 검토 대응 중, M2-01r·v는 진행 중이다.
**M2-01t는 사용자 결정이 먼저**다. M2-01w는 ready다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 자체 운영 engine/data 선택·검증,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 working tree와 위 계획을 확인하고 M2-01a/d부터 진행한다. 실제 외부·실환경
증거가 필요한 gate를 문서 검토나 합성 fixture로 완료 처리하지 않는다.
