'use client';
import { useRef, useState, type FormEvent } from 'react';
import type { RaceManualPublicPrepare } from '@workout/contracts/race-manual-public';
import type { RaceManualPublicImpact } from '@workout/contracts/race-manual-public-impact';
import { prepareRaceManualImpactResolutions } from './race-manual-impact-resolutions';
import styles from './race-impact-resolution-editor.module.css';
type Projected = Extract<RaceManualPublicImpact, { status: 'projected' }>;
type Draft = { date: string; time: string; timezone: string; end: string; count: string };
const empty = (): Draft => ({ date: '', time: '', timezone: '', end: '', count: '' });
/** Edits exact diagnostic references only. This prepares another server diagnostic;
 * it never confirms recovery, reconnects nutrition or certifies resolved timing. */
export function RaceImpactResolutionEditor({
  impact,
  prepare,
  disabled,
  onDirty,
  onPrepared,
}: {
  impact: Projected;
  prepare: RaceManualPublicPrepare;
  disabled: boolean;
  onDirty: () => void;
  onPrepared: (prepare: RaceManualPublicPrepare) => void;
}) {
  const [drafts, setDrafts] = useState<Readonly<Record<string, Draft>>>({});
  const composing = useRef(false);
  const [error, setError] = useState('');
  function change(key: string, field: keyof Draft, value: string) {
    onDirty();
    setDrafts((old) => ({ ...old, [key]: { ...(old[key] ?? empty()), [field]: value } }));
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled || composing.current) return;
    const nutrition = [...prepare.intent.resolutions.nutrition];
    const routines = [...prepare.intent.resolutions.routines];
    try {
      for (const requirement of impact.resolutionRequirements) {
        const key = JSON.stringify(requirement);
        const draft = drafts[key];
        if (!draft) continue;
        if (!draft.date) {
          if (Object.values(draft).some(Boolean)) throw Error('Required');
          continue;
        }
        if (requirement.domain === 'nutrition') {
          if (!draft.time || !draft.timezone) throw Error('Required');
          const resolution = {
            planVersionId: requirement.planVersionId,
            itemId: requirement.itemId,
            action: 'replace_anchor' as const,
            anchor: {
              kind: 'absolute' as const,
              date: draft.date,
              localTime: draft.time,
              timezone: draft.timezone,
            },
          };
          const index = nutrition.findIndex(
            (r) => r.planVersionId === resolution.planVersionId && r.itemId === resolution.itemId,
          );
          if (index < 0) nutrition.push(resolution);
          else nutrition[index] = resolution;
        } else if (
          requirement.domain === 'routine_schedule' &&
          requirement.editor === 'replace_rule'
        ) {
          if (
            !draft.time ||
            !draft.timezone ||
            !draft.end ||
            !/^\d+$/.test(draft.count) ||
            Number(draft.count) > 1000
          )
            throw Error('Required');
          const resolution = {
            scheduleVersionId: requirement.scheduleVersionId,
            action: 'replace_rule' as const,
            rule: { kind: 'dates' as const, dates: [draft.date], localTime: draft.time },
            window: {
              startDate: draft.date,
              endDateExclusive: draft.end,
              timezone: draft.timezone,
              maxOccurrences: Number(draft.count),
            },
            sourcePlanVersionId: null,
          };
          const index = routines.findIndex(
            (r) => r.scheduleVersionId === resolution.scheduleVersionId,
          );
          if (index < 0) routines.push(resolution);
          else routines[index] = resolution;
        }
      }
      const prepared = prepareRaceManualImpactResolutions(prepare, impact, { nutrition, routines });
      setError('');
      onPrepared(prepared.prepare);
    } catch {
      setError('해결 입력의 날짜·시각·시간대·유한 범위를 확인하세요. 승인하지 않았습니다.');
    }
  }
  if (!impact.resolutionRequirements.length)
    return <p>영향받는 미해결 항목 없음. 저장 검토와 승인은 별도 동작입니다.</p>;
  return (
    <form
      className={styles.editor}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
      }}
      onSubmit={submit}
      aria-label="영향받는 미해결 계획 입력"
    >
      <h3>영향받는 미해결 항목 해결 입력</h3>
      <p>음식·수량·목표·실제 섭취는 바꾸지 않습니다. 입력 후 서버에서 다시 진단합니다.</p>
      <fieldset disabled={disabled}>
        {impact.resolutionRequirements.map((requirement) => {
          const key = JSON.stringify(requirement),
            draft = drafts[key] ?? empty();
          if (requirement.domain === 'recovery')
            return (
              <p key={key}>
                회복 화면에서 실제 선택·확인을 완료한 뒤 새 영향 진단을 요청하세요. 여기서는 회복을
                확인하지 않습니다.
              </p>
            );
          if (requirement.domain === 'routine_schedule' && requirement.editor !== 'replace_rule')
            return <p key={key}>종료된 고정 일정은 편집하지 않습니다.</p>;
          const title =
            requirement.domain === 'nutrition'
              ? `영양 ${requirement.itemId}`
              : `루틴 ${requirement.scheduleVersionId}`;
          return (
            <fieldset key={key}>
              <legend>{title}</legend>
              <p>
                고정 버전:{' '}
                {requirement.domain === 'nutrition'
                  ? requirement.planVersionId
                  : requirement.scheduleVersionId}
              </p>
              <label>
                {title} 날짜
                <input
                  type="date"
                  value={draft.date}
                  onChange={(e) => change(key, 'date', e.target.value)}
                />
              </label>
              <label>
                {title} 시각
                <input
                  type="time"
                  value={draft.time}
                  onChange={(e) => change(key, 'time', e.target.value)}
                />
              </label>
              <label>
                {title} 시간대
                <input
                  value={draft.timezone}
                  placeholder="Asia/Seoul"
                  onChange={(e) => change(key, 'timezone', e.target.value)}
                />
              </label>
              {requirement.domain === 'routine_schedule' ? (
                <>
                  <p>명시한 단일 날짜 규칙으로 교체합니다. 기존 실행은 변경하지 않습니다.</p>
                  <label>
                    {title} 종료 날짜(미포함)
                    <input
                      type="date"
                      value={draft.end}
                      onChange={(e) => change(key, 'end', e.target.value)}
                    />
                  </label>
                  <label>
                    {title} 최대 발생 수
                    <input
                      type="number"
                      min="1"
                      max="1000"
                      value={draft.count}
                      onChange={(e) => change(key, 'count', e.target.value)}
                    />
                  </label>
                </>
              ) : null}
            </fieldset>
          );
        })}
        <button type="submit">해결 입력으로 다시 진단</button>
      </fieldset>
      <p role="alert">{error}</p>
    </form>
  );
}
