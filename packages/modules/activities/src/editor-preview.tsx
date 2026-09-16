import type { Activity } from '@workout/contracts/activity';
import type { EditorFields } from './editor-store';
export function EditorPreview({ fields }: { fields: EditorFields }) {
  return (
    <section aria-label="활동 저장 미리보기">
      <h3>활동 저장 미리보기</h3>
      <dl>
        <dt>제목·종목</dt>
        <dd>
          {fields.title || '미확인'} · {fields.kind}
        </dd>
        <dt>시작 시각·시간대</dt>
        <dd>
          {fields.startedAt || '미확인'} · {fields.timezone || '미확인'}
        </dd>
        <dt>거리</dt>
        <dd>{fields.distance === '' ? '미확인' : `${fields.distance}m`}</dd>
        <dt>시간</dt>
        <dd>
          {fields.duration === '' ? '미확인' : `${fields.duration}초`} · {fields.durationKind}
        </dd>
        <dt>세션 RPE</dt>
        <dd>{fields.sessionRpe === '' ? '보고하지 않음' : fields.sessionRpe}</dd>
        <dt>메모</dt>
        <dd>{fields.note || '보고하지 않음'}</dd>
        <dt>계획 연결</dt>
        <dd>
          {fields.planLink
            ? `${fields.planLink.planVersionId} · ${fields.planLink.sessionId}`
            : '없음'}
        </dd>
        <dt>정정 사유</dt>
        <dd>{fields.reason || '해당 없음'}</dd>
      </dl>
    </section>
  );
}
export function RecordPreview({ record, label }: { record: Activity; label: string }) {
  return (
    <section aria-label={label}>
      <h3>
        {label} · 수정 {record.revision}
      </h3>
      <p>
        {record.effective.title ?? '제목 미확인'} · {record.effective.kind} ·{' '}
        {record.effective.startedAt ?? '시각 미확인'} ·{' '}
        {record.effective.timezone ?? '시간대 미확인'}
      </p>
      <p>
        거리 {record.effective.distanceMeters ?? '미확인'}m · 시간{' '}
        {record.effective.durationSeconds ?? '미확인'}초 ({record.effective.durationKind})
      </p>
      <p>
        RPE {record.userReport?.sessionRpe ?? '보고하지 않음'} ·{' '}
        {record.userReport?.note ?? '메모 보고하지 않음'}
      </p>
      <p>
        계획 연결{' '}
        {record.userReport?.planLink
          ? `${record.userReport.planLink.planVersionId} · ${record.userReport.planLink.sessionId}`
          : '없음'}
      </p>
      <p>
        출처 {record.source.kind} · 원본 수정 {record.source.revision}. 원본은 정정으로 덮어쓰지
        않습니다.
      </p>
      <p>
        원본 거리 {record.original.distanceMeters ?? '미확인'}m · 원본 시간{' '}
        {record.original.durationSeconds ?? '미확인'}초 ({record.original.durationKind})
      </p>
      {record.userReport ? (
        <p>
          사용자 자기 보고 · {record.userReport.definitionVersion} · RPE 보고 시각{' '}
          {record.userReport.rpeReportedAt ?? '미보고'}
        </p>
      ) : null}
    </section>
  );
}
