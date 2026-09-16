'use client';

import {
  plannedSessionSchema,
  type PlanDraft,
  type PlannedSession,
} from '@workout/contracts/planning';
import { Button } from '@workout/ui-foundation/button';
import { TextAreaField, TextField } from '@workout/ui-foundation/text-field';
import { addDays } from './lens';
import styles from './planning.module.css';

type Period = PlanDraft['periods'][number];
type Edit = (update: (draft: PlanDraft) => PlanDraft) => void;
const levels = ['season', 'wave', 'phase', 'block'] as const;
export function createPeriod(
  draft: PlanDraft,
  level: Period['level'],
  date: string,
  id: string,
): Period {
  const parentLevel = levels[levels.indexOf(level) - 1];
  const parent = [...draft.periods].reverse().find((period) => period.level === parentLevel);
  return {
    id,
    parentId: parent?.id ?? null,
    level,
    title: level,
    startDate: parent?.startDate ?? date,
    endDateExclusive:
      level === 'block'
        ? addDays(parent?.startDate ?? date, 10)
        : (parent?.endDateExclusive ?? addDays(date, 90)),
    timezone: draft.timezone,
    intent: '',
    isPartial: false,
  };
}
export function PeriodEditor({
  draft,
  edit,
  today,
  createId,
}: {
  draft: PlanDraft;
  edit: Edit;
  today: string;
  createId: () => string;
}) {
  function update(id: string, patch: Partial<Period>) {
    edit((current) => ({
      ...current,
      periods: current.periods.map((period) =>
        period.id === id ? { ...period, ...patch } : period,
      ),
    }));
  }
  return (
    <section aria-labelledby="period-editor-title">
      <h3 id="period-editor-title">기간 트리 초안</h3>
      <p>Block 기본값은 10일이며 수정할 수 있습니다. 종료일은 포함하지 않습니다.</p>
      <div className={styles.toolbar}>
        {levels.map((level) => (
          <Button
            key={level}
            variant="secondary"
            onClick={() =>
              edit((current) => ({
                ...current,
                periods: [...current.periods, createPeriod(current, level, today, createId())],
              }))
            }
          >
            {level} 추가
          </Button>
        ))}
      </div>
      {draft.periods.map((period) => (
        <fieldset key={period.id}>
          <legend>
            {period.level}: {period.title}
          </legend>
          <TextField
            label="기간 제목"
            value={period.title}
            onChange={(event) => update(period.id, { title: event.target.value })}
          />
          <label>
            상위 기간
            <select
              value={period.parentId ?? ''}
              onChange={(event) => update(period.id, { parentId: event.target.value || null })}
            >
              <option value="">없음</option>
              {draft.periods
                .filter(
                  (parent) =>
                    parent.id !== period.id &&
                    levels.indexOf(parent.level) === levels.indexOf(period.level) - 1,
                )
                .map((parent) => (
                  <option key={parent.id} value={parent.id}>
                    {parent.title}
                  </option>
                ))}
            </select>
          </label>
          <TextField
            label="기간 시작일"
            type="date"
            value={period.startDate}
            onChange={(event) => update(period.id, { startDate: event.target.value })}
          />
          <TextField
            label="기간 종료일 (미포함)"
            type="date"
            value={period.endDateExclusive}
            onChange={(event) => update(period.id, { endDateExclusive: event.target.value })}
          />
          <TextField
            label="기간 목적"
            value={period.intent}
            onChange={(event) => update(period.id, { intent: event.target.value })}
          />
          <TextField
            label="기간 시간대"
            value={period.timezone}
            onChange={(event) => update(period.id, { timezone: event.target.value })}
          />
          <label>
            <input
              type="checkbox"
              checked={period.isPartial}
              onChange={(event) => update(period.id, { isPartial: event.target.checked })}
            />
            부분 기간
          </label>
          <Button
            variant="danger"
            disabled={
              draft.periods.some((child) => child.parentId === period.id) ||
              draft.sessions.some((session) => session.blockId === period.id)
            }
            onClick={() =>
              edit((current) => ({
                ...current,
                periods: current.periods.filter((item) => item.id !== period.id),
              }))
            }
          >
            기간 삭제
          </Button>
          {draft.periods.some((child) => child.parentId === period.id) ||
          draft.sessions.some((session) => session.blockId === period.id) ? (
            <p>하위 기간과 세션을 먼저 이동하거나 삭제하세요.</p>
          ) : null}
        </fieldset>
      ))}
    </section>
  );
}

export function createSession(draft: PlanDraft, today: string, id: string): PlannedSession {
  const block = draft.periods.find((period) => period.level === 'block');
  return {
    id,
    blockId: block?.id ?? '',
    date: block?.startDate ?? today,
    localStartTime: null,
    title: '새 계획 세션',
    sport: 'running',
    durationSeconds: null,
    distanceMeters: null,
    purpose: '',
    notes: '',
    priority: 'normal',
    locks: { date: false, time: false, intensity: false },
    steps: [],
    targetRpe: null,
  };
}
function numberOrNull(value: string) {
  return value === '' ? null : Number(value);
}
export function SessionEditor({
  draft,
  baseline,
  edit,
  today,
  createId,
}: {
  draft: PlanDraft;
  baseline: PlanDraft | null;
  edit: Edit;
  today: string;
  createId: () => string;
}) {
  function update(id: string, patch: Partial<PlannedSession>) {
    edit((current) => ({
      ...current,
      sessions: current.sessions.map((session) =>
        session.id === id ? { ...session, ...patch } : session,
      ),
    }));
  }
  return (
    <section aria-labelledby="session-editor-title">
      <h3 id="session-editor-title">계획 세션 초안</h3>
      <Button
        variant="secondary"
        disabled={!draft.periods.some((period) => period.level === 'block')}
        onClick={() =>
          edit((current) => ({
            ...current,
            sessions: [...current.sessions, createSession(current, today, createId())],
          }))
        }
      >
        세션 추가
      </Button>
      {!draft.periods.some((period) => period.level === 'block') ? (
        <p>세션을 배치하려면 Block을 먼저 만드세요.</p>
      ) : null}
      {draft.sessions.map((session) => {
        const locked = baseline?.sessions.find((item) => item.id === session.id)?.locks;
        return (
          <fieldset key={session.id}>
            <legend>{session.title}</legend>
            <TextField
              label="세션 제목"
              value={session.title}
              onChange={(event) => update(session.id, { title: event.target.value })}
            />
            <label>
              소속 Block
              <select
                value={session.blockId}
                disabled={locked?.date}
                onChange={(event) => update(session.id, { blockId: event.target.value })}
              >
                {draft.periods
                  .filter((period) => period.level === 'block')
                  .map((block) => (
                    <option key={block.id} value={block.id}>
                      {block.title}
                    </option>
                  ))}
              </select>
            </label>
            <TextField
              label="세션 날짜"
              type="date"
              disabled={locked?.date}
              value={session.date}
              onChange={(event) => update(session.id, { date: event.target.value })}
            />
            <TextField
              label="시작 시각 (미정 가능)"
              type="time"
              disabled={locked?.time}
              value={session.localStartTime ?? ''}
              onChange={(event) =>
                update(session.id, { localStartTime: event.target.value || null })
              }
            />
            <label>
              종목
              <select
                disabled={locked?.intensity}
                value={session.sport}
                onChange={(event) =>
                  update(session.id, {
                    sport: plannedSessionSchema.shape.sport.parse(event.target.value),
                  })
                }
              >
                {['running', 'cycling', 'swimming', 'strength', 'other'].map((sport) => (
                  <option key={sport}>{sport}</option>
                ))}
              </select>
            </label>
            <TextField
              label="세션 목적"
              value={session.purpose}
              onChange={(event) => update(session.id, { purpose: event.target.value })}
            />
            <label>
              중요도
              <select
                value={session.priority}
                onChange={(event) =>
                  update(session.id, {
                    priority: plannedSessionSchema.shape.priority.parse(event.target.value),
                  })
                }
              >
                {['low', 'normal', 'high'].map((priority) => (
                  <option key={priority}>{priority}</option>
                ))}
              </select>
            </label>
            <TextField
              label="시간 (초, 미정 가능)"
              type="number"
              min="0"
              value={session.durationSeconds ?? ''}
              disabled={locked?.intensity}
              onChange={(event) =>
                update(session.id, { durationSeconds: numberOrNull(event.target.value) })
              }
            />
            <TextField
              label="거리 (m, 미정 가능)"
              disabled={locked?.intensity}
              type="number"
              min="0"
              value={session.distanceMeters ?? ''}
              onChange={(event) =>
                update(session.id, { distanceMeters: numberOrNull(event.target.value) })
              }
            />
            <TextField
              label="목표 RPE (0–10, 미정 가능)"
              type="number"
              min="0"
              max="10"
              disabled={locked?.intensity}
              value={session.targetRpe ?? ''}
              onChange={(event) =>
                update(session.id, { targetRpe: numberOrNull(event.target.value) })
              }
            />
            <TextAreaField
              label="세션 메모"
              value={session.notes}
              onChange={(event) => update(session.id, { notes: event.target.value })}
            />
            <div className={styles.toolbar}>
              {(['date', 'time', 'intensity'] as const).map((lock) => (
                <label key={lock}>
                  <input
                    type="checkbox"
                    checked={session.locks[lock]}
                    onChange={(event) =>
                      update(session.id, {
                        locks: { ...session.locks, [lock]: event.target.checked },
                      })
                    }
                  />
                  {lock} 잠금
                </label>
              ))}
            </div>
            {locked && Object.values(locked).some(Boolean) ? (
              <p>잠금을 해제해 버전으로 저장한 후 해당 필드를 수정할 수 있습니다.</p>
            ) : null}
            <fieldset disabled={locked?.intensity}>
              <legend>워밍업·반복·회복·쿨다운</legend>
              {session.steps.map((step) => (
                <div key={step.id} className={styles.step}>
                  <label>
                    단계 종류
                    <select
                      value={step.kind}
                      onChange={(event) =>
                        update(session.id, {
                          steps: session.steps.map((item) =>
                            item.id === step.id
                              ? {
                                  ...item,
                                  kind: plannedSessionSchema.shape.steps.element.shape.kind.parse(
                                    event.target.value,
                                  ),
                                }
                              : item,
                          ),
                        })
                      }
                    >
                      {['warmup', 'work', 'recovery', 'cooldown'].map((kind) => (
                        <option key={kind}>{kind}</option>
                      ))}
                    </select>
                  </label>
                  <TextField
                    label="단계 시간 (초)"
                    type="number"
                    min="0"
                    value={step.durationSeconds ?? ''}
                    onChange={(event) =>
                      update(session.id, {
                        steps: session.steps.map((item) =>
                          item.id === step.id
                            ? { ...item, durationSeconds: numberOrNull(event.target.value) }
                            : item,
                        ),
                      })
                    }
                  />
                  <TextField
                    label="단계 거리 (m)"
                    type="number"
                    min="0"
                    value={step.distanceMeters ?? ''}
                    onChange={(event) =>
                      update(session.id, {
                        steps: session.steps.map((item) =>
                          item.id === step.id
                            ? { ...item, distanceMeters: numberOrNull(event.target.value) }
                            : item,
                        ),
                      })
                    }
                  />
                  <TextField
                    label="반복 횟수"
                    type="number"
                    min="1"
                    value={step.repetitions}
                    onChange={(event) =>
                      update(session.id, {
                        steps: session.steps.map((item) =>
                          item.id === step.id
                            ? { ...item, repetitions: Number(event.target.value) }
                            : item,
                        ),
                      })
                    }
                  />
                  <Button
                    variant="danger"
                    onClick={() =>
                      update(session.id, {
                        steps: session.steps.filter((item) => item.id !== step.id),
                      })
                    }
                  >
                    단계 삭제
                  </Button>
                </div>
              ))}
              <Button
                variant="secondary"
                onClick={() =>
                  update(session.id, {
                    steps: [
                      ...session.steps,
                      {
                        id: createId(),
                        kind: 'work',
                        durationSeconds: null,
                        distanceMeters: null,
                        repetitions: 1,
                      },
                    ],
                  })
                }
              >
                단계 추가
              </Button>
            </fieldset>
            <Button
              variant="secondary"
              onClick={() =>
                edit((current) => ({
                  ...current,
                  sessions: [
                    ...current.sessions,
                    {
                      ...session,
                      id: createId(),
                      title: `${session.title} 복사`,
                      locks: { date: false, time: false, intensity: false },
                      steps: session.steps.map((step) => ({ ...step, id: createId() })),
                    },
                  ],
                }))
              }
            >
              세션 복제
            </Button>
            <Button
              variant="danger"
              disabled={locked && Object.values(locked).some(Boolean)}
              onClick={() =>
                edit((current) => ({
                  ...current,
                  sessions: current.sessions.filter((item) => item.id !== session.id),
                }))
              }
            >
              세션 삭제
            </Button>
          </fieldset>
        );
      })}
    </section>
  );
}
