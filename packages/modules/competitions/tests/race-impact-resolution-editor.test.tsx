import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { raceManualPublicImpactSchema } from '@workout/contracts/race-manual-public-impact';
import { RaceImpactResolutionEditor } from '../src/race-impact-resolution-editor';
afterEach(cleanup);
const id = (n: number) => `abcdefab-abcd-4abc-8abc-${String(n).padStart(12, '0')}`;
function fixture() {
  const race = {
    title: 'Race',
    localDate: '2026-10-09',
    localStartTime: null,
    timezone: 'UTC',
    distance: { kind: 'standard', class: '5k' },
    priority: null,
    participation: 'registered',
    targetSeconds: 0,
  };
  const item = {
    id: 'meal-식-' + 'x'.repeat(201),
    category: 'before',
    title: 'Meal',
    anchor: { kind: 'absolute', date: '2026-10-09', localTime: null, timezone: 'UTC' },
    foods: [
      {
        foodVersionId: null,
        description: 'Zero',
        quantity: 0,
        unit: 'g',
        sourceBasis: 'manual_total',
      },
      {
        foodVersionId: null,
        description: 'Unknown',
        quantity: null,
        unit: 'unspecified',
        sourceBasis: 'manual_total',
      },
    ],
    targets: [],
    instructions: 'Eat',
  };
  const plan = {
    period: { from: '2026-10-08', toInclusive: '2026-10-11' },
    purpose: 'Fuel',
    timezone: 'UTC',
    items: [item],
  };
  const unresolved = { state: 'unresolved', reason: 'missing_session_time' };
  return {
    schemaVersion: 1,
    status: 'projected',
    approvalAllowed: false,
    persistence: 'not_stored',
    freshness: 'not_checked',
    expectedEvent: { id: id(1), revision: 2 },
    intent: {
      expectedEvent: { id: id(1), revision: 2 },
      newLocalDate: '2026-10-10',
      selection: { kind: 'keep_plan' },
      resolutions: { nutrition: [], routines: [] },
    },
    beforeBasis: 'captured_snapshot',
    afterBasis: 'hypothetical',
    race: {
      eventId: id(1),
      expectedRevision: 2,
      before: race,
      after: { ...race, localDate: '2026-10-10' },
    },
    training: { state: 'absent' },
    recovery: { state: 'absent' },
    routines: { state: 'absent' },
    nutrition: {
      state: 'present',
      members: [
        {
          aggregateId: id(2),
          before: {
            ref: { versionId: id(3), version: 1 },
            plan,
            linkedTraining: { kind: 'absent' },
          },
          after: { plan: structuredClone(plan), linkedTraining: { kind: 'absent' } },
          timings: [
            {
              itemId: item.id,
              state: 'unchanged',
              before: unresolved,
              after: unresolved,
              resolution: 'absent',
              requirement: 'none',
            },
          ],
        },
      ],
    },
    retainedUnplanned: [],
    affected: [],
    resolutionRequirements: [],
    notices: [
      { domain: 'nutrition', aggregateId: id(2), itemId: item.id, code: 'UNCHANGED_UNRESOLVED' },
    ],
  };
}
function affectedNutrition() {
  const p = raceManualPublicImpactSchema.parse(fixture());
  if (p.status !== 'projected' || p.nutrition.state !== 'present') throw Error('fixture');
  const m = p.nutrition.members[0];
  const t = m?.timings[0];
  if (!m || !t) throw Error('fixture');
  t.state = 'affected';
  t.requirement = 'resolve_before_review';
  p.notices = [];
  p.affected = [{ domain: 'nutrition', aggregateId: m.aggregateId }];
  p.resolutionRequirements = [
    {
      domain: 'nutrition',
      aggregateId: m.aggregateId,
      planVersionId: m.before.ref.versionId,
      itemId: t.itemId,
      reason: 'affected_timing_unresolved',
      editor: 'replace_anchor',
    },
  ];
  return raceManualPublicImpactSchema.parse(p);
}
it('prepares exact long item input with untouched zero/null food and requests fresh diagnostics, not approval', async () => {
  const impact = affectedNutrition();
  if (impact.status !== 'projected') throw Error('fixture');
  const original = structuredClone(impact),
    onPrepared = vi.fn(),
    onDirty = vi.fn();
  render(
    <RaceImpactResolutionEditor
      impact={impact}
      prepare={{ schemaVersion: 1, intent: impact.intent }}
      disabled={false}
      onDirty={onDirty}
      onPrepared={onPrepared}
    />,
  );
  const item = impact.resolutionRequirements[0];
  if (!item || item.domain !== 'nutrition') throw Error('fixture');
  const title = `영양 ${item.itemId}`;
  fireEvent.change(screen.getByLabelText(`${title} 날짜`), { target: { value: '2026-10-10' } });
  fireEvent.change(screen.getByLabelText(`${title} 시각`), { target: { value: '08:30' } });
  fireEvent.change(screen.getByLabelText(`${title} 시간대`), { target: { value: 'Asia/Seoul' } });
  await userEvent.setup().click(screen.getByRole('button', { name: '해결 입력으로 다시 진단' }));
  expect(onDirty).toHaveBeenCalledTimes(3);
  expect(onPrepared).toHaveBeenCalledExactlyOnceWith({
    schemaVersion: 1,
    intent: {
      ...impact.intent,
      resolutions: {
        nutrition: [
          {
            planVersionId: item.planVersionId,
            itemId: item.itemId,
            action: 'replace_anchor',
            anchor: {
              kind: 'absolute',
              date: '2026-10-10',
              localTime: '08:30',
              timezone: 'Asia/Seoul',
            },
          },
        ],
        routines: [],
      },
    },
  });
  expect(impact).toEqual(original);
  expect(screen.queryByRole('button', { name: '계획 변경 승인' })).not.toBeInTheDocument();
});
it('keeps invalid inputs and IME composition without emitting a replacement', () => {
  const impact = affectedNutrition();
  if (impact.status !== 'projected') throw Error('fixture');
  const onPrepared = vi.fn();
  render(
    <RaceImpactResolutionEditor
      impact={impact}
      prepare={{ schemaVersion: 1, intent: impact.intent }}
      disabled={false}
      onDirty={vi.fn()}
      onPrepared={onPrepared}
    />,
  );
  const date = screen.getByLabelText(/ 날짜$/);
  fireEvent.change(date, { target: { value: '2026-10-10' } });
  const form = screen.getByRole('form', { name: '영향받는 미해결 계획 입력' });
  fireEvent.compositionStart(date);
  fireEvent.submit(form);
  expect(onPrepared).not.toHaveBeenCalled();
  fireEvent.compositionEnd(date);
  fireEvent.submit(form);
  expect(onPrepared).not.toHaveBeenCalled();
  expect(date).toHaveValue('2026-10-10');
  expect(screen.getByRole('alert')).toHaveTextContent('확인하세요');
});
function routineFixture() {
  const blueprint = {
    schemaVersion: 4,
    routineId: 'bp',
    versionId: 'bp-v1',
    title: 'Routine',
    intent: 'Check',
    status: 'published',
    tags: [],
    steps: [
      {
        id: 'step',
        title: 'Check',
        content: { kind: 'checklist', prompt: 'Ready?' },
        timing: { kind: 'user_scheduled' },
        required: true,
        choiceGroupId: null,
      },
    ],
    choiceGroups: [],
    estimatedDurationSeconds: 0,
    createdAt: '2026-10-08T00:00:00.123456Z',
  };
  const schedule = {
    schemaVersion: 4,
    id: id(4),
    versionId: 'schedule-old',
    blueprint: { id: 'bp', versionId: 'bp-v1' },
    window: {
      startDate: '2026-10-08',
      endDateExclusive: '2026-10-12',
      timezone: 'UTC',
      maxOccurrences: 10,
    },
    rule: { kind: 'period_days', periodId: 'p', offsetsDays: [0, 1], localTime: null },
    state: 'ended',
  };
  const side = {
    schedule,
    sourcePlanVersionId: null,
    expansion: { state: 'unresolved', reason: 'SOURCE_PLAN_REQUIRED' },
  };
  return {
    ...fixture(),
    routines: {
      state: 'present',
      members: [
        {
          aggregateId: id(4),
          state: 'retained_ended',
          blueprint,
          before: side,
          after: structuredClone(side),
          retainedStarted: [],
          storedOccurrences: [
            {
              occurrenceId: 'occ',
              schedule: { id: id(4), versionId: 'schedule-old' },
              blueprint: { id: 'bp', versionId: 'bp-v1' },
              sourcePlanVersionId: null,
              anchorKey: 'period:p:0',
              scheduledAt: null,
              timingStatus: 'unresolved',
              unresolvedReason: null,
            },
          ],
          resolution: 'absent',
          requirement: 'none',
        },
      ],
    },
    resolutionRequirements: [],
    notices: [
      ...fixture().notices,
      {
        domain: 'routine_schedule',
        aggregateId: id(4),
        itemId: null,
        code: 'ENDED_SCHEDULE_RETAINED',
      },
      {
        domain: 'routine_schedule',
        aggregateId: id(4),
        itemId: null,
        code: 'UNCHANGED_UNRESOLVED',
      },
    ],
  };
}

it('collects explicit dates and bounded window for exact active routine version, while ended remains frozen', async () => {
  const p = raceManualPublicImpactSchema.parse(routineFixture());
  if (p.status !== 'projected' || p.routines.state !== 'present') throw Error('fixture');
  const m = p.routines.members[0];
  if (!m) throw Error('fixture');
  m.state = 'affected';
  m.before.schedule.state = 'active';
  m.after.schedule.state = 'active';
  m.requirement = 'resolve_before_review';
  p.affected = [{ domain: 'routine_schedule', aggregateId: m.aggregateId }];
  p.notices = p.notices.filter((n) => n.domain !== 'routine_schedule');
  p.resolutionRequirements = [
    {
      domain: 'routine_schedule',
      aggregateId: m.aggregateId,
      scheduleVersionId: m.before.schedule.versionId,
      reason: 'affected_timing_unresolved',
      editor: 'replace_rule',
    },
  ];
  const impact = raceManualPublicImpactSchema.parse(p);
  if (impact.status !== 'projected') throw Error('fixture');
  const onPrepared = vi.fn();
  render(
    <RaceImpactResolutionEditor
      impact={impact}
      prepare={{ schemaVersion: 1, intent: impact.intent }}
      disabled={false}
      onDirty={vi.fn()}
      onPrepared={onPrepared}
    />,
  );
  for (const [label, value] of [
    ['날짜', '2026-10-10'],
    ['시각', '09:00'],
    ['시간대', 'UTC'],
    ['종료 날짜(미포함)', '2026-10-12'],
    ['최대 발생 수', '2'],
  ])
    fireEvent.change(screen.getByLabelText(`루틴 schedule-old ${label}`), { target: { value } });
  await userEvent.setup().click(screen.getByRole('button', { name: '해결 입력으로 다시 진단' }));
  expect(onPrepared.mock.calls[0]?.[0].intent.resolutions.routines).toEqual([
    {
      scheduleVersionId: 'schedule-old',
      action: 'replace_rule',
      rule: { kind: 'dates', dates: ['2026-10-10'], localTime: '09:00' },
      window: {
        startDate: '2026-10-10',
        endDateExclusive: '2026-10-12',
        timezone: 'UTC',
        maxOccurrences: 2,
      },
      sourcePlanVersionId: null,
    },
  ]);
  cleanup();
  const ended = raceManualPublicImpactSchema.parse(routineFixture());
  if (ended.status !== 'projected') throw Error('fixture');
  render(
    <RaceImpactResolutionEditor
      impact={ended}
      prepare={{ schemaVersion: 1, intent: ended.intent }}
      disabled={false}
      onDirty={vi.fn()}
      onPrepared={onPrepared}
    />,
  );
  expect(screen.queryByRole('button', { name: '해결 입력으로 다시 진단' })).not.toBeInTheDocument();
});
