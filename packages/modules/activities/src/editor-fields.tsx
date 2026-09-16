import type { PlanRead } from '@workout/contracts/planning';
import type { EditorFields as Fields } from './editor-store';
export function EditorFields({
  fields,
  editing,
  plans,
  change,
}: {
  fields: Fields;
  editing: boolean;
  plans: PlanRead | undefined;
  change<K extends keyof Fields>(name: K, value: Fields[K]): void;
}) {
  const choices = plans?.head?.draft.sessions ?? [];
  const selection = fields.planLink ? JSON.stringify(fields.planLink) : '';
  const currentExists = choices.some(
    (session) =>
      fields.planLink?.planVersionId === plans?.head?.id &&
      fields.planLink?.sessionId === session.id,
  );
  return (
    <>
      <label>
        활동 제목
        <input
          maxLength={200}
          value={fields.title}
          onChange={(e) => change('title', e.target.value)}
        />
      </label>
      <label>
        활동 종목
        <select
          value={fields.kind}
          onChange={(e) => {
            const value = e.target.value;
            if (
              value === 'running' ||
              value === 'cycling' ||
              value === 'walking' ||
              value === 'strength' ||
              value === 'other' ||
              value === 'unknown'
            )
              change('kind', value);
          }}
        >
          {Object.entries({
            running: '달리기',
            cycling: '자전거',
            walking: '걷기',
            strength: '근력',
            other: '기타',
            unknown: '미확인',
          }).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        활동 시작 시각 (시간차 포함 ISO)
        <input
          value={fields.startedAt}
          onChange={(e) => change('startedAt', e.target.value)}
          placeholder="2026-09-16T09:00:00+09:00"
        />
      </label>
      <label>
        활동 시간대
        <input
          value={fields.timezone}
          onChange={(e) => change('timezone', e.target.value)}
          placeholder="Asia/Seoul"
        />
      </label>
      <label>
        활동 거리 (m)
        <input
          type="number"
          min="0"
          step="any"
          value={fields.distance}
          onChange={(e) => change('distance', e.target.value)}
        />
      </label>
      <label>
        활동 시간 (초)
        <input
          type="number"
          min="0"
          step="any"
          value={fields.duration}
          onChange={(e) => change('duration', e.target.value)}
        />
      </label>
      <label>
        시간 정의
        <select
          value={fields.durationKind}
          onChange={(e) => {
            const value = e.target.value;
            if (
              value === 'timer' ||
              value === 'elapsed' ||
              value === 'moving' ||
              value === 'unknown'
            )
              change('durationKind', value);
          }}
        >
          <option value="unknown">정의 미확인</option>
          <option value="timer">타이머 시간</option>
          <option value="elapsed">경과 시간</option>
          <option value="moving">이동 시간</option>
        </select>
      </label>
      <label>
        세션 체감 강도 (RPE 0~10)
        <input
          type="number"
          min="0"
          max="10"
          step="any"
          value={fields.sessionRpe}
          onChange={(e) => change('sessionRpe', e.target.value)}
        />
      </label>
      <p>
        세션 전체의 체감 강도를 직접 보고합니다. 빈 값은 미보고, 0은 보고한 0입니다. 기기 측정이나
        운동 허가를 의미하지 않습니다.
      </p>
      <label>
        활동 메모
        <textarea
          maxLength={4000}
          value={fields.note}
          onChange={(e) => change('note', e.target.value)}
        />
      </label>
      <label>
        연결할 계획 세션
        <select
          value={selection}
          onChange={(e) => {
            if (!e.target.value) change('planLink', null);
            else {
              const selected = choices.find(
                (session) =>
                  JSON.stringify({ planVersionId: plans?.head?.id, sessionId: session.id }) ===
                  e.target.value,
              );
              if (selected && plans?.head)
                change('planLink', { planVersionId: plans.head.id, sessionId: selected.id });
            }
          }}
        >
          <option value="">연결하지 않음</option>
          {fields.planLink && !currentExists ? (
            <option value={selection}>기존 계획 연결 유지 · {fields.planLink.sessionId}</option>
          ) : null}
          {choices.map((session) => (
            <option
              key={session.id}
              value={JSON.stringify({ planVersionId: plans?.head?.id, sessionId: session.id })}
            >
              {session.date} · {session.title}
            </option>
          ))}
        </select>
      </label>
      <p>계획 연결은 기록 간 연결입니다. 계획을 실제 수행으로 자동 기록하거나 승인하지 않습니다.</p>
      {editing ? (
        <label>
          활동 정정 사유
          <textarea
            maxLength={500}
            value={fields.reason}
            onChange={(e) => change('reason', e.target.value)}
          />
        </label>
      ) : null}
    </>
  );
}
