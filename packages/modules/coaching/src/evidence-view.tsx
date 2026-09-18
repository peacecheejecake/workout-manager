import type { Activity } from '@workout/contracts/activity';
import {
  coreEvidenceSnapshotDefinition,
  coreEvidenceSnapshotV2Definition,
  type CoreEvidenceBody,
  type CoreEvidenceSnapshot,
} from '@workout/contracts/evidence-snapshots';
import { sessionCompletionDefinition } from '@workout/contracts/session-completion';
import { checkInDefinition } from '@workout/contracts/check-ins';
import { coachingConstraintDefinition } from '@workout/contracts/coaching-constraints';
import { ScopeView } from './scope-view';
import styles from './evidence-view.module.css';

type ActivityValues = Activity['effective'];
const excludedLabels: Record<(typeof coreEvidenceSnapshotDefinition.excluded)[number], string> = {
  activity_details: '활동 상세 레코드·랩',
  provider_heads: '공급자 동기화 상태',
  resource_passages: '자료 원문 발췌',
  global_preferences: '전체 사용자 선호',
  global_constraints: '전체 사용자 제약',
  coaching_policy: '코칭 정책',
  model_output: 'AI 생성 결과',
  approval_authority: '계획 승인 권한',
};
const quantity = (value: number | null, unit = '') =>
  value === null ? '미보고' : `${value}${unit}`;
const durationLabels: Record<ActivityValues['durationKind'], string> = {
  timer: '타이머 시간',
  elapsed: '경과 시간',
  moving: '이동 시간',
  unknown: '정의 미확인',
};
function ActivityValuesView({ values }: { values: ActivityValues }) {
  return (
    <dl>
      <dt>제목·종목</dt>
      <dd>
        {values.title ?? '제목 미확인'} · {values.kind}
      </dd>
      <dt>시작 시각</dt>
      <dd>
        {values.startedAt ?? '시각 미확인'} · 시간대 {values.timezone ?? '미확인'}
      </dd>
      <dt>거리</dt>
      <dd>{quantity(values.distanceMeters, ' m')}</dd>
      <dt>시간</dt>
      <dd>
        {quantity(values.durationSeconds, ' 초')} · {durationLabels[values.durationKind]}
      </dd>
    </dl>
  );
}
function Activities({ items }: { items: CoreEvidenceBody['activities'] }) {
  return (
    <details className={styles.group}>
      <summary>실제 활동 {items.length}개</summary>
      <p>
        조회 날짜는 저장된 근거의 시간대로 환산했습니다. 시각 미확인 활동은 날짜 범위에 속한다고
        판단하지 않고 별도로 포함했습니다.
      </p>
      {items.length === 0 ? (
        <p>포함된 활동이 없습니다. 실제 수행이 없었다는 증거는 아닙니다.</p>
      ) : null}
      <ul>
        {items.map(({ localDate, record }) => (
          <li key={record.id}>
            <article aria-label={`근거 활동 ${record.id}`}>
              <h4>{record.effective.title ?? '제목 미확인'}</h4>
              <p>
                {localDate === null
                  ? '날짜 미확인 · 범위 포함 여부 미확인'
                  : `조회 시간대 날짜: ${localDate} · 조회 범위 안`}
              </p>
              <p>
                활동 ID {record.id} · 기록 버전 {record.revision}
              </p>
              <p>
                출처 {record.source.kind} · 원본 ID {record.source.sourceId} · 원본 버전{' '}
                {record.source.revision}
              </p>
              <ActivityValuesView values={record.effective} />
              <details>
                <summary>원본 값과 사용자 정정</summary>
                <ActivityValuesView values={record.original} />
                <p>원본 내용 해시: {record.source.contentHash}</p>
                <p>정정 사유: {record.overlay.reason ?? '기록 없음'}</p>
                <p>
                  로컬 태그:{' '}
                  {record.overlay.tags === undefined
                    ? '미기록'
                    : record.overlay.tags.length
                      ? record.overlay.tags.join(', ')
                      : '명시된 태그 없음'}
                </p>
                {record.userReport ? (
                  <>
                    <p>
                      사용자 보고 RPE: {quantity(record.userReport.sessionRpe)} · 보고 시각{' '}
                      {record.userReport.rpeReportedAt ?? '미기록'}
                    </p>
                    <p className={styles.text}>사용자 메모: {record.userReport.note ?? '미기록'}</p>
                    <p>
                      명시적 계획 연결:{' '}
                      {record.userReport.planLink
                        ? `${record.userReport.planLink.planVersionId} / ${record.userReport.planLink.sessionId}`
                        : '없음'}
                    </p>
                  </>
                ) : (
                  <p>활동 사용자 보고: 미기록</p>
                )}
              </details>
            </article>
          </li>
        ))}
      </ul>
    </details>
  );
}
function CheckIns({ items }: { items: CoreEvidenceBody['checkIns'] }) {
  return (
    <details className={styles.group}>
      <summary>체크인 사용자 보고 {items.length}개</summary>
      <p>피로·불편감은 0~10 사용자 보고입니다. {checkInDefinition.limitation}</p>
      {items.length === 0 ? (
        <p>포함된 체크인이 없습니다. 상태가 좋거나 불편감이 없다는 뜻은 아닙니다.</p>
      ) : null}
      <ul>
        {items.map(({ localDate, record }) => (
          <li key={record.id}>
            <h4>
              체크인 {record.id} · 기록 버전 {record.revision}
            </h4>
            <p>
              조회 시간대 날짜: {localDate} · 원래 기록 날짜: {record.localDate} (
              {record.values.timezone})
            </p>
            <p>관측 시각: {record.values.observedAt}</p>
            <p>
              피로: {quantity(record.values.fatigue)} · 불편감: {quantity(record.values.discomfort)}{' '}
              · 신체 부위: {record.values.bodyLocation ?? '미보고'}
            </p>
            <p className={styles.text}>메모: {record.values.note ?? '미기록'}</p>
            <p>
              사용자 자기보고 · 처음 기록 {record.recordedAt} · 마지막 정정 {record.updatedAt}
            </p>
          </li>
        ))}
      </ul>
    </details>
  );
}
function Completions({ items }: { items: CoreEvidenceBody['sessionCompletions'] }) {
  return (
    <details className={styles.group}>
      <summary>세션 완료 사용자 보고 {items.length}개</summary>
      <p>
        {sessionCompletionDefinition.meaning} {sessionCompletionDefinition.timing}
      </p>
      <p>
        상담에 고정된 계획 전체 세션의 보고입니다. 위 활동 조회 날짜 범위로 제한하지 않았습니다.
      </p>
      {items.length === 0 ? <p>{sessionCompletionDefinition.missing}</p> : null}
      <ul>
        {items.map((report) => (
          <li key={report.sessionId}>
            <h4>
              {report.sessionId} ·{' '}
              {report.status === 'completed' ? '사용자 완료 확인' : '완료 확인 철회'}
            </h4>
            <p>
              기록 버전 {report.revision} · 확인 시각 {report.reportedAt}
            </p>
            <p>
              보고 당시 계획 {report.planVersionId} · Block {report.schedule.blockId}
            </p>
            <p>
              보고 당시 일정 {report.schedule.date} ·{' '}
              {report.schedule.localStartTime ?? '시각 미정'} · {report.schedule.timezone}
            </p>
            <p className={styles.text}>사유: {report.reason ?? '미기록'}</p>
          </li>
        ))}
      </ul>
    </details>
  );
}
function UserConstraints({ body }: { body: CoreEvidenceBody }) {
  return (
    <section className={styles.group} aria-label="필수 사용자 제약 근거">
      <h4>필수 사용자 제약 근거</h4>
      {body.schemaVersion === 1 ? (
        <p>
          이전 근거 v1에는 사용자 제약 원장이 포함되지 않았습니다. 제약이 없었다는 뜻은 아니며, 현재
          제약으로 과거 근거를 채우지 않습니다.
        </p>
      ) : (
        <>
          <p>
            저장 당시 전체 사용자 제약입니다. 활동 조회 날짜와 상담 범위에 관계없이 필수로 포함하며,
            이 근거에서 숨기거나 제외할 수 없습니다.
          </p>
          <p>{coachingConstraintDefinition.meaning}</p>
          {body.dependencies.userConstraints.kind === 'absent' ? (
            <p>저장 당시 제약 미기록 · 사용자 제약 원장의 변경 기준 없음</p>
          ) : (
            <>
              <p>저장 당시 제약 원장 버전 {body.dependencies.userConstraints.revision}</p>
              {body.userConstraints.items.length === 0 ? (
                <p>저장 당시 명시적으로 비운 제약 원장 · 확인된 제약 문장 0개</p>
              ) : (
                <ul>
                  {body.userConstraints.items.map((item) => (
                    <li key={item.id}>
                      <p className={styles.text}>{item.text}</p>
                      <p>
                        제약 ID {item.id} · 기록 버전 {item.revision}
                      </p>
                      <p>
                        사용자 확인 시각:{' '}
                        <time dateTime={item.confirmedAt}>{item.confirmedAt}</time>
                      </p>
                      <p>
                        마지막 수정 시각: <time dateTime={item.updatedAt}>{item.updatedAt}</time>
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          <p>저장된 문장과 확인 시각이며, 현재 제약 원장의 최신 상태를 뜻하지 않습니다.</p>
        </>
      )}
    </section>
  );
}
function Dependencies({ body }: { body: CoreEvidenceBody }) {
  const stamps = body.dependencies;
  const definition =
    body.schemaVersion === 1 ? coreEvidenceSnapshotDefinition : coreEvidenceSnapshotV2Definition;
  const head = (value: CoreEvidenceBody['dependencies']['checkIns']) =>
    value.kind === 'absent' ? '저장 당시 기록 없음' : `저장 당시 전체 기록 버전 ${value.revision}`;
  return (
    <details className={styles.group}>
      <summary>저장 당시 근거 범위와 변경 기준</summary>
      <p>
        이 값들은 저장 당시 상태입니다. 현재 최신 여부나 계획 승인 가능 여부를 판정하지 않습니다.
      </p>
      <dl>
        <dt>기준을 읽은 시각</dt>
        <dd>{stamps.capturedAt}</dd>
        <dt>활동 전체 변경 기준</dt>
        <dd>
          {stamps.activities.count}개 · 기록 버전 합 {stamps.activities.revisionSum} (삭제 흔적
          포함, 위 조회 활동 수와 다름)
        </dd>
        <dt>체크인 변경 기준</dt>
        <dd>{head(stamps.checkIns)}</dd>
        <dt>완료 보고 변경 기준</dt>
        <dd>{head(stamps.sessionCompletions)}</dd>
        <dt>AI 동의 당시 상태</dt>
        <dd>
          {stamps.aiConsent.kind === 'absent'
            ? '동의 기록 없음'
            : `${stamps.aiConsent.granted ? '허용' : '허용하지 않음'} · 동의 기록 버전 ${stamps.aiConsent.revision}`}
        </dd>
      </dl>
      <p>이 버전의 근거에 다음 항목은 포함하지 않았습니다.</p>
      <ul>
        {definition.excluded.map((key) => (
          <li key={key}>{excludedLabels[key]}</li>
        ))}
      </ul>
      <p>이 근거 저장은 AI 전송 동의나 계획 변경·승인이 아닙니다.</p>
    </details>
  );
}
/** Pure frozen evidence presentation. Never fetches newer records or manufactures freshness. */
export function EvidenceView({ snapshot }: { snapshot: CoreEvidenceSnapshot }) {
  return (
    <section className={styles.view} aria-label="저장된 근거 상세">
      <h3>저장된 근거</h3>
      <p>
        저장 시각: <time dateTime={snapshot.createdAt}>{snapshot.createdAt}</time>
      </p>
      <p>
        근거 ID {snapshot.id} · 상담 ID {snapshot.threadId}
      </p>
      {snapshot.status === 'purged' ? (
        <p role="status">
          근거 본문이 폐기되었습니다.{' '}
          {snapshot.reason === 'source_deleted'
            ? '포함된 원본 기록 또는 사용자 제약이 삭제되었습니다.'
            : 'AI 동의 철회에 따라 저장된 본문을 폐기했습니다.'}{' '}
          기존 근거는 다시 복원되지 않습니다.
        </p>
      ) : (
        <>
          <p>
            조회 범위: {snapshot.body.window.from} 이상 ~ {snapshot.body.window.toExclusive} 미만 ·{' '}
            {snapshot.body.window.timezone}
          </p>
          <p>
            상담에 고정된 계획: v{snapshot.body.plan.version} · {snapshot.body.plan.id}
          </p>
          <p>
            근거 저장 당시 현재 계획:{' '}
            {snapshot.body.dependencies.trainingPlan.kind === 'absent'
              ? '없음'
              : snapshot.body.dependencies.trainingPlan.versionId}
          </p>
          <ScopeView plan={snapshot.body.plan} scope={snapshot.body.thread.scope} />
          <UserConstraints body={snapshot.body} />
          <details className={styles.group}>
            <summary>사용자 메시지 전체 {snapshot.body.messages.length}개</summary>
            <ol>
              {snapshot.body.messages.map((message) => (
                <li key={message.id}>
                  <p>
                    사용자 · 기록 {message.revision} · {message.createdAt}
                  </p>
                  <p className={styles.text}>{message.content}</p>
                </li>
              ))}
            </ol>
          </details>
          <Activities items={snapshot.body.activities} />
          <CheckIns items={snapshot.body.checkIns} />
          <Completions items={snapshot.body.sessionCompletions} />
          <Dependencies body={snapshot.body} />
        </>
      )}
    </section>
  );
}
