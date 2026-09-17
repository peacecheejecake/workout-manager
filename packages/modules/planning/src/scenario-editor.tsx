import { useState } from 'react';
import { useStore } from 'zustand';
import { planDraftSchema, preservesSessionLocks } from '@workout/contracts/planning';
import { Button } from '@workout/ui-foundation/button';
import { TextField } from '@workout/ui-foundation/text-field';
import { PeriodEditor, SessionEditor } from './plan-fields';
import { validationGuidance } from './validation-guidance';
import type { ScenarioDraftStore } from './scenario-draft-store';
export function ScenarioEditor({
  store,
  disabled,
  today,
  createId,
  onPreview,
  completedSessionIds,
  canSave,
}: {
  store: ScenarioDraftStore;
  disabled: boolean;
  today: string;
  createId: () => string;
  onPreview: () => void;
  completedSessionIds: readonly string[];
  canSave: boolean;
}) {
  const draft = useStore(store, (state) => state.draft),
    source = useStore(store, (state) => state.source),
    undo = useStore(store, (state) => state.undo);
  const [selected, setSelected] = useState<string | null>(null);
  if (!draft || !source) return null;
  const validation = planDraftSchema.safeParse(draft);
  const edit = store.getState().edit;
  const locked = !preservesSessionLocks(source.draft, draft);
  return (
    <section aria-label="시나리오 초안 편집">
      <h3>
        시나리오 {source.label} · 수정 {source.revision}에서 만든 미저장 초안
      </h3>
      <p>
        현재 계획을 수정하지 않습니다. 적용할 때 최신 계획의 잠금과 완료 확인을 다시 검사합니다.
      </p>
      <fieldset disabled={disabled}>
        <legend>대안 계획 편집</legend>
        <TextField
          label="시나리오 계획 제목"
          value={draft.title}
          onChange={(event) => edit((value) => ({ ...value, title: event.target.value }))}
        />
        <TextField
          disabled={
            completedSessionIds.length > 0 ||
            source.draft.sessions.some((session) => session.locks.date || session.locks.time)
          }
          label="시나리오 계획 시간대"
          value={draft.timezone}
          onChange={(event) =>
            edit((value) => ({
              ...value,
              timezone: event.target.value,
              periods: value.periods.map((period) => ({ ...period, timezone: event.target.value })),
            }))
          }
        />
        <PeriodEditor draft={draft} edit={edit} today={today} createId={createId} />
        <label>
          시나리오 편집 세션
          <select
            value={selected ?? ''}
            onChange={(event) => setSelected(event.target.value || null)}
          >
            <option value="">모든 세션</option>
            {draft.sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.title}
              </option>
            ))}
          </select>
        </label>
        <SessionEditor
          draft={draft}
          baseline={source.draft}
          completedSessionIds={completedSessionIds}
          edit={edit}
          today={today}
          createId={createId}
          selectedId={selected}
          onDuplicate={setSelected}
        />
        <Button disabled={!validation.success || locked || !canSave} onClick={onPreview}>
          시나리오 저장 미리보기
        </Button>
        <Button
          variant="secondary"
          disabled={!undo.length}
          onClick={() => store.getState().undoEdit()}
        >
          시나리오 실행 취소
        </Button>
        <Button variant="secondary" onClick={() => store.getState().reset()}>
          시나리오 초안 버리기
        </Button>
      </fieldset>
      {locked ? (
        <p role="alert">저장된 시나리오의 잠금과 충돌합니다. 먼저 잠금 해제를 별도 저장하세요.</p>
      ) : null}
      {!validation.success ? (
        <div role="status">
          <p>저장 미리보기 전에 입력을 수정하세요.</p>
          <ul>
            {validation.error.issues.slice(0, 20).map((issue, index) => (
              <li key={index}>{validationGuidance(issue)}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
