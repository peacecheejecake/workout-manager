# M2-05a~d · 저장 설정을 사용한 실제 코칭 실행

상태: 모두 not_started. 2026-10-07 기존 M2-01k-w-b~e의 미시작 범위를 일대일 이관했다. 역사 M2-05의 RAG 구현 완료와 구분하며 실제 실행 완료를 주장하지 않는다.

| 새 노드 | 원래 노드  | 선행 조건                     | 보존한 수용 범위                                                                                                                                                   |
| ------- | ---------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M2-05a  | M2-01k-w-b | M2-01k-w-a, M2-02, 역사 M2-05 | versioned command/receipt, immutable job·frozen selection, tenant/RLS, 삭제/export/restore, 원자적 outbox                                                          |
| M2-05b  | M2-01k-w-c | M2-05a                        | 같은 거래의 완전한 manifest, absent heads, actual/overlay/ACL/suppression, consent/policy/catalog, restore generation, authoritative outbox lease 재검증           |
| M2-05c  | M2-01k-w-d | M2-05b                        | 모든 사용자 합산 서울 월50,000원 reserve→fresh marker commit→거래 밖 HTTP→settle/finish, ambiguous 전송 재시도 금지, 취소/철회/lease loss, 완전한 budget 원장·복원 |
| M2-05d  | M2-01k-w-e | M2-05c, EXT-HOSTING           | 서버 키, 현재 모델 접근/가격/FX/tokenizer, 실제 API/청구·출력/citation 수용, 명시 Sol 코칭/Luna 합성 비교                                                          |

M2-05a는 대회 날짜·영양 시각 통합을 포함한 M2-02 이후 시작한다. 내부 전체 수용 M2-06은 M2-05c까지, 공개 G2-PUBLIC은 실제 외부 M2-05d까지 요구한다. 목표 범위의 축소나 외부 gate의 통과 선언이 아니다. 기존 역사 run에 자동 binding·모델 대체를 하지 않으며, CLOSED 우회 금지와 계획 적용의 별도 명시 승인을 유지한다. 요약·체크인·발췌의 사용자 전송 허가는 키·가격·실제 실행 증거를 대신하지 않는다.

M2-01k-w-a의 준비 결과는 `storage:not_persisted`, `sourceCompleteness:false`, `admissionAllowed:false`다. 설정 UI/API, deterministic fixture, 순수 helper를 실제 제공자 호출로 승격하지 않는다. 실제 외부 수용은 not_executed이며 historical failed 결과를 보존한다.

기존 `phase/m2-05` HEAD `dd974084fe008397fe2ab2963191de6bea9e0380`의 미검토 prototype 12개 커밋은 그대로 보존한다. 그 branch를 초기화하거나 자동 main 병합하지 않았다. 후속 구현 시작 때 승인된 최신 main 기준과 기존 prototype을 대조하고 전체 phase 검증·독립 검토를 새로 받는다. SQL 번호·공통 계약·grants·export/registry는 Root가 직렬 통합한다.

이번 변경의 검증은 graph 고유 ID·선행 ID·순환 검사와 문서 연결/format/diff다. 구현, PostgreSQL, 브라우저, 실제 제공자, phase review, main 병합은 실행하지 않았다.

## M2-05a 로컬 완료 · 2026-10-14

148 `ai_execution_job_store`의 불변 job·frozen selection·synthetic evidence 확인·복원 취소 disposition, tenant/RLS, 원자적 receipt/outbox,
account export V40 포함을 profile27로 설치·검증했다. 리뷰 r1 P27-p1-1(위조 catalog digest)을 148 guard의 canonical digest 비교로 고쳤다.
독립 phase 리뷰 r2 APPROVE 뒤 완료로 바꾼다. 실제 dispatch·complete freshness(M2-05b), 예산(M2-05c), 실제 OpenAI(M2-05d)는 미실행이며
worker job registry는 비어 있다. 근거: [profile27 기록](PROFILE27-local-20261013.md).
