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

[M2-01o](progress/M2-01o.md)를 완료했다. **공유 저장소 층의 경로 탈출**을 막았다. 참조 경로 검증이 루트
**아래** 성분만 `lstat`하고 루트 자체는 커널이 따라가서, 저장소 루트가 symlink로 바뀌면 참조가 "부재"로
읽히는 데서 그치지 않았다 — **`writeTemporary`가 symlink 대상 안에 key 경로와 객체를 통째로 만들어 쓰기가
루트 밖으로 나갔고**, 루트가 저장소 사본을 가리키면 `delete`·`publish`가 **사본의 객체를 지우고 게시했다.**
이 층은 gallery·track·resource·URL 수집·썸네일 다섯 consumer가 공유한다.

이제 walk 전·답하기 전·**부작용 뒤마다** 루트를 다시 확인해, 탈출하는 연산은 **반드시 오류로 끝난다**
(쓰기 race 시험 8회 조용한 성공 0, 재확인을 하나씩 빼면 각각 8/8 실패). 탈출 자체를 완전히 막지는 못한다 —
**한 방향 swap만으로 탈출**하며 Node에 `openat`이 없어 경로 기반으로는 닫을 수 없다. 처음 판의 문서는 남은
위험을 "한 walk(µs), ABA, 읽기만"으로 **과소 기술**했고 독립 검토가 그것을 차단으로 잡았다(write 471/615
탈출 실측). 이제 사실대로 적었다.

재확인이 새로 만든 **시끄러운 거짓 양성**(swap이 마지막 경로 호출 뒤·재확인 전에 오면 실제 저장소에서
성공한 연산이 오류로 끝남)이 **누수를 만드는지** 독립 검토가 다섯 호출자를 코드로 추적했다 — 전부
reaper·큐·스윕·`already_present` 채택으로 결국 회수되며 영구 고아는 없다. grant 헬퍼의 REVOKE와 GRANT를
한 transaction으로 묶어 운영 DB에서 헬퍼를 돌릴 때의 `42501` 창도 닫았고(같은 모양의 헬퍼를 범위 밖에서
하나 더 찾음), publish의 해시·크기 검사가 서로를 대신해 통과하던 것(F6)을 각각 시험으로 고정했다.

병합 시 `migrate.ts`에서 M2-01p의 `migrationFileNames`와 이 노드의 `inOneGrantTransaction`이 같은 자리에서
충돌해 둘 다 살렸다.

## 다음 ready 작업

M2-01q는 검토 대응 중, M2-01r·v는 진행 중이다. M2-01w·M2-01x는 ready다. **M2-01t는 사용자 결정이 먼저**다.

## 남은 외부·실환경 gate

- M0-06b: 한국 보행 경로 coverage·접근 제한 독립 검토, 자체 운영 engine/data 선택·검증,
  OS 한글 IME/물리 touch/성능·배포 조건.
- M0-06c: 실제 WKWebView HTML 입력·한국어 IME·foreground/background 수명주기,
  실제 iPhone/서명/HealthKit 검증. 현재 실기기 작업은 보류 상태다.
- EXT-G/M1-06b: 공식 Garmin 권한과 허가된 실제 응답·자동 수집. 로컬 FIT,
  별도 OAuth fixture와 합성 데이터는 공식 연동 증거가 아니다.

다음 세션은 working tree와 위 계획을 확인하고 M2-01a/d부터 진행한다. 실제 외부·실환경
증거가 필요한 gate를 문서 검토나 합성 fixture로 완료 처리하지 않는다.
