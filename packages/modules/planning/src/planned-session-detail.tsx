import type { PlanDraft } from '@workout/contracts/planning';
import { heartRateTargetLabel, paceTargetLabel } from './session-target-labels';
import { attendanceLockLabel } from './attendance-lock-label';
export function PlannedSessionDetail({
  source,
  selected,
  visibleIds,
  draft,
}: {
  source: PlanDraft | undefined;
  selected: string | null;
  visibleIds: string[] | null;
  draft: boolean;
}) {
  if (!selected) return <p>달력·표·agenda에서 계획 세션을 선택할 수 있습니다.</p>;
  const session = source?.sessions.find((value) => value.id === selected);
  return (
    <section aria-label="선택한 계획 세션">
      <h3>선택한 계획 세션</h3>
      {session ? (
        <>
          <p>
            {draft ? '미저장 초안' : '저장된 계획'} · {session.title} · {session.date} ·{' '}
            {session.localStartTime ?? '시각 미정'}
          </p>
          {visibleIds !== null && !visibleIds.includes(selected) ? (
            <p role="status">선택한 세션은 현재 조회 범위 밖에 있습니다. 선택을 유지합니다.</p>
          ) : null}
          <p>
            소속 Block:{' '}
            {source?.periods.find((value) => value.id === session.blockId)?.title ?? '미확인'} ·
            목적 {session.purpose || '미입력'}
          </p>
          <p>
            거리 {session.distanceMeters === null ? '미정' : `${session.distanceMeters}m`} · 시간{' '}
            {session.durationSeconds === null ? '미정' : `${session.durationSeconds}초`}
          </p>
          <p>
            강도 라벨: {session.intensityLabel ?? '미지정'} · 목표 RPE:{' '}
            {session.targetRpe ?? '미정'}
          </p>
          <p>
            목표 페이스: {paceTargetLabel(session.paceTarget)} · 목표 심박:{' '}
            {heartRateTargetLabel(session.heartRateTarget)}
          </p>
          <p>참석 잠금: {attendanceLockLabel(session.locks.attendance)}</p>
          {!draft ? (
            <p>수정하려면 계획 초안 편집을 시작하세요. 선택만으로 계획을 변경하지 않습니다.</p>
          ) : null}
        </>
      ) : (
        <p role="status">선택한 세션을 현재 계획에서 찾을 수 없습니다. 다른 세션을 선택하세요.</p>
      )}
    </section>
  );
}
