import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { raceEventSchema } from '@workout/contracts/races';
import { planSnapshotSchema } from '@workout/contracts/planning';
import { nutritionPlanVersionSchema } from '@workout/contracts/nutrition-core';
import {
  routineBlueprintVersionSchema,
  routineScheduleVersionSchema,
  routineOccurrenceSchema,
  routineRunSchema,
} from '@workout/contracts/routines';
import type {
  RaceRelativeScheduleImpactInput,
  RaceScheduleCalculationPorts,
} from '../src/race-relative-schedule-impact.js';
import { assembleRaceManualReviewCandidate } from '../src/race-manual-review-candidate.js';
import { verifyRaceManualReviewIntegrity } from '../src/race-manual-review-integrity.js';
function required<T>(value: T | undefined | null): T {
  if (value == null) throw new Error('Missing fixture');
  return value;
}
// Synthetic domain DTO fixtures derived from the existing producer tests.
// These tests exercise the real pure producer; calculation ports are unit fixtures,
// not the persistence calculator, authenticated collector, or actual PostgreSQL.
const planId = '10000000-0000-4000-8000-000000000001',
  eventId = '20000000-0000-4000-8000-000000000001';
function fixture(): RaceRelativeScheduleImpactInput {
  const levels = ['season', 'wave', 'phase', 'block'] as const;
  const plan = planSnapshotSchema.parse({
    id: planId,
    version: 1,
    createdAt: '2026-03-01T00:00:00Z',
    draft: {
      title: 'Synthetic',
      timezone: 'America/New_York',
      periods: levels.map((level, index) => ({
        id: level,
        parentId: index === 0 ? null : levels[index - 1],
        level,
        title: level,
        startDate: '2026-03-01',
        endDateExclusive: '2026-04-01',
        timezone: 'America/New_York',
        intent: '',
        isPartial: false,
      })),
      sessions: [
        {
          id: eventId,
          blockId: 'block',
          date: '2026-03-07',
          localStartTime: '07:00:00',
          title: 'Synthetic planned',
          sport: 'running',
          durationSeconds: null,
          distanceMeters: 0,
          targetRpe: null,
          purpose: '',
          notes: '',
          priority: 'normal',
          locks: { date: false, time: false, intensity: false },
          steps: [],
        },
      ],
    },
  });
  const event = raceEventSchema.parse({
    id: eventId,
    revision: 1,
    title: 'Synthetic race',
    localDate: '2026-03-07',
    localStartTime: '07:00:00',
    timezone: 'America/New_York',
    locationName: null,
    distance: { kind: 'standard', class: '10k' },
    priority: null,
    participation: 'registered',
    officialUrl: null,
    course: null,
    targetSeconds: 0,
    planVersionId: planId,
  });
  const versionId = '30000000-0000-4000-8000-000000000001';
  const record = nutritionPlanVersionSchema.parse({
    planId: '30000000-0000-4000-8000-000000000002',
    versionId,
    version: 1,
    previousVersionId: null,
    period: { from: '2026-03-01', toInclusive: '2026-03-31' },
    timezone: 'America/New_York',
    purpose: 'Synthetic',
    linkedTrainingPlanVersionId: planId,
    approvedAt: '2026-03-01T00:00:00Z',
    approvalId: '30000000-0000-4000-8000-000000000003',
    items: [
      ['race-start', 'race', 'start', eventId],
      ['session', 'session', 'start', eventId],
      ['race-end', 'race', 'end', eventId],
      ['unrelated', 'race', 'start', '20000000-0000-4000-8000-000000000002'],
    ].map(([id, entity, point, entityId]) => ({
      id,
      planVersionId: versionId,
      category: 'before',
      title: 'Synthetic timing',
      anchor: { kind: 'relative', entity, entityId, point, offsetMinutes: 0 },
      foods: [],
      targets: [],
      instructions: 'Review timing',
      evidenceIds: [],
      source: 'user_confirmed',
    })),
  });
  return {
    event,
    newLocalDate: '2026-03-09',
    currentPlan: plan,
    sourcePlans: [],
    completionReports: [],
    selection: { kind: 'keep_plan' },
    nutrition: [
      {
        record,
        timings: record.items.map((item) => ({
          itemId: item.id,
          timing:
            item.id === 'unrelated' || item.id === 'race-end'
              ? { state: 'unresolved', reason: 'missing_anchor' }
              : { state: 'resolved', date: '2026-03-07', localTime: '07:00:00' },
        })),
      },
    ],
    routines: [],
    resolutions: { nutrition: [], routines: [] },
  };
}
function moved() {
  const input = fixture();
  input.selection = {
    kind: 'move_period',
    expectedCurrentPlanVersionId: planId,
    periodId: 'season',
    newStartDate: '2026-03-03',
    scope: 'descendants_and_sessions',
  };
  return input;
}
function routine() {
  const blueprint = routineBlueprintVersionSchema.parse({
    schemaVersion: 4,
    routineId: 'blueprint',
    versionId: 'blueprint-v1',
    title: 'Frozen',
    intent: '',
    status: 'published',
    tags: [],
    steps: [
      {
        id: 'step',
        title: 'Checklist',
        content: { kind: 'checklist', prompt: 'Synthetic' },
        timing: { kind: 'user_scheduled' },
        required: true,
        choiceGroupId: null,
      },
    ],
    choiceGroups: [],
    estimatedDurationSeconds: null,
    createdAt: '2026-03-01T00:00:00Z',
  });
  const record = routineScheduleVersionSchema.parse({
    schemaVersion: 4,
    id: 'schedule',
    versionId: 'schedule-v1',
    blueprint: { id: blueprint.routineId, versionId: blueprint.versionId },
    window: {
      startDate: '2026-03-01',
      endDateExclusive: '2026-04-01',
      timezone: 'America/New_York',
      maxOccurrences: 2,
    },
    rule: { kind: 'session_links', sessionIds: [eventId], point: 'start', offsetMinutes: 0 },
    state: 'active',
  });
  const occurrence = routineOccurrenceSchema.parse({
    id: 'occurrence',
    schedule: { id: record.id, versionId: record.versionId },
    blueprint: record.blueprint,
    anchorKey: `${eventId}:start`,
    scheduledAt: '2026-03-07T12:00:00Z',
    timingStatus: 'resolved',
    stepBindings: [],
    selectedChoices: {},
  });
  return { record, sourcePlanVersionId: planId, blueprint, occurrences: [occurrence], runs: [] };
}

const athleteId = 'synthetic-owner';
const calculations: RaceScheduleCalculationPorts = {
  resolveNutrition({ item, event }) {
    if (item.anchor.kind === 'absolute')
      return { state: 'resolved', date: item.anchor.date, localTime: item.anchor.localTime };
    return { state: 'resolved', date: event.localDate, localTime: '07:00:00' };
  },
  expandRoutine() {
    return { state: 'expanded', occurrences: [] };
  },
};
function source(projectionInput = fixture()) {
  return {
    athleteId,
    projectionInput,
    sourceFacts: {
      ownerAthleteId: athleteId,
      nutritionRacePins: projectionInput.nutrition.flatMap((context) =>
        context.record.items.flatMap((item) =>
          item.anchor.kind === 'relative' && item.anchor.entity === 'race'
            ? [
                {
                  nutritionVersionId: context.record.versionId,
                  itemId: item.id,
                  binding: { state: 'pinned', ref: { eventId: item.anchor.entityId, revision: 1 } },
                },
              ]
            : [],
        ),
      ),
    },
  };
}
function input(sourceInput = source()) {
  const candidate = assembleRaceManualReviewCandidate(sourceInput, calculations);
  if (candidate.status !== 'assembled') throw new Error(candidate.reason);
  const binding = {
    athleteId,
    event: {
      id: sourceInput.projectionInput.event.id,
      revision: sourceInput.projectionInput.event.revision,
    },
    readSetDigest: 'a'.repeat(64),
  };
  return structuredClone({
    candidate: { ...candidate },
    sourceInput,
    capturedBinding: structuredClone(binding),
    expectedBinding: structuredClone(binding),
  });
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Invalid fixture');
  return encoded;
}
function redigest(candidate: ReturnType<typeof input>['candidate']) {
  candidate.digest = createHash('sha256').update(canonical(candidate.body)).digest('hex');
}
it('matches an actual immutable producer without authorizing processing or approval', () => {
  const raw = input(),
    before = structuredClone(raw);
  const result = verifyRaceManualReviewIntegrity(raw, calculations);
  expect(result).toMatchObject({
    status: 'consistent',
    admissionAllowed: false,
    sourceCompleteness: 'unverified',
    resolution: 'requires_resolution',
    candidate: { storage: 'not_persisted', approval: { status: 'blocked' } },
  });
  expect(raw).toEqual(before);
  if (result.status !== 'consistent') throw new Error('Expected consistent');
  expect(Object.isFrozen(result.candidate.body)).toBe(true);
});
it('accepts object key reordering but preserves semantic body arrays', () => {
  const raw = input();
  raw.candidate.body.event = { ...raw.candidate.body.event, title: raw.candidate.body.event.title };
  expect(
    verifyRaceManualReviewIntegrity(JSON.parse(JSON.stringify(raw)), calculations).status,
  ).toBe('consistent');
});
it('rejects mismatched read-set, account and independent event tuples', () => {
  for (const field of ['digest', 'owner', 'event'] as const) {
    const raw = input();
    if (field === 'digest') raw.capturedBinding.readSetDigest = 'b'.repeat(64);
    if (field === 'owner') {
      raw.expectedBinding.athleteId = 'foreign';
      raw.capturedBinding.athleteId = 'foreign';
    }
    if (field === 'event') {
      raw.expectedBinding.event.revision++;
      raw.capturedBinding.event.revision++;
    }
    expect(verifyRaceManualReviewIntegrity(raw, calculations)).toMatchObject({
      status: 'rejected',
      reason: 'context_mismatch',
    });
  }
});
it('rejects raw digest tamper and self-rehashed extra body fields', () => {
  const raw = input();
  raw.candidate.body.event.title = 'Tamper';
  expect(verifyRaceManualReviewIntegrity(raw, calculations)).toMatchObject({
    reason: 'digest_mismatch',
  });
  const extra = { ...input().candidate.body, clientVerified: true };
  const changed = input();
  const candidate = {
    ...changed.candidate,
    body: extra,
    digest: createHash('sha256').update(canonical(extra)).digest('hex'),
  };
  expect(verifyRaceManualReviewIntegrity({ ...changed, candidate }, calculations)).toMatchObject({
    reason: 'candidate_mismatch',
  });
});
it('rejects changed event write intent even when attacker rehashes it', () => {
  const raw = input();
  required(raw.candidate.body.writeIntents.event).expectedNextRevision = 3;
  redigest(raw.candidate);
  expect(verifyRaceManualReviewIntegrity(raw, calculations)).toMatchObject({
    reason: 'candidate_mismatch',
  });
});
it('rejects future or duplicate source pin facts through the original strict producer', () => {
  const future = input();
  required(future.sourceInput.sourceFacts.nutritionRacePins[0]).binding.ref.revision = 2;
  expect(verifyRaceManualReviewIntegrity(future, calculations)).toMatchObject({
    reason: 'source_rejected',
  });
  const duplicate = input();
  duplicate.sourceInput.sourceFacts.nutritionRacePins.push(
    required(duplicate.sourceInput.sourceFacts.nutritionRacePins[0]),
  );
  expect(verifyRaceManualReviewIntegrity(duplicate, calculations)).toMatchObject({
    reason: 'source_rejected',
  });
});
it('preserves original historical pin while rejecting a silently upgraded target', () => {
  const sourceInput = source();
  sourceInput.projectionInput.event.revision = 2;
  const raw = input(sourceInput);
  expect(verifyRaceManualReviewIntegrity(raw, calculations)).toMatchObject({
    status: 'consistent',
    resolution: 'requires_resolution',
    admissionAllowed: false,
  });
  const pin = required(raw.candidate.body.pinIntents.find((pin) => pin.itemId === 'race-start'));
  pin.prior = { state: 'pinned', ref: { eventId, revision: 2 } };
  redigest(raw.candidate);
  expect(verifyRaceManualReviewIntegrity(raw, calculations)).toMatchObject({
    reason: 'pin_mismatch',
  });
});
it('keeps affected unresolved blocking and unrelated unresolved as preserved notices', () => {
  const raw = input();
  expect(
    raw.candidate.body.resolution.preservedNotices.some((notice) => notice.itemId === 'unrelated'),
  ).toBe(true);
  raw.candidate.body.resolution.requiresResolution = false;
  raw.candidate.body.resolution.blocking = [];
  redigest(raw.candidate);
  expect(verifyRaceManualReviewIntegrity(raw, calculations)).toMatchObject({
    reason: 'resolution_mismatch',
  });
});
it('rejects retained stopped runs and exact actual references', () => {
  const projection = moved(),
    context = routine();
  const run = routineRunSchema.parse({
    id: 'run',
    revision: 1,
    blueprint: context.record.blueprint,
    origin: { kind: 'planned', occurrenceId: 'occurrence' },
    state: 'stopped',
    progress: [
      {
        stepId: 'step',
        revision: 1,
        state: 'stopped',
        actualRefs: [
          { kind: 'checklist_confirmation', id: 'confirmation', revisionId: 'confirmation-r1' },
        ],
        occurredAt: '2026-03-07T12:05:00Z',
        recordedAt: '2026-03-07T12:06:00Z',
        reason: 'Synthetic stop',
      },
    ],
    selectedChoices: {},
    startedAt: '2026-03-07T12:00:00Z',
    endedAt: '2026-03-07T12:10:00Z',
  });
  projection.routines = [{ ...context, runs: [run] }];
  const raw = input(source(projection));
  expect(verifyRaceManualReviewIntegrity(raw, calculations).status).toBe('consistent');
  required(raw.candidate.body.retainedActualManifest.routines[0]).runs = [];
  redigest(raw.candidate);
  expect(verifyRaceManualReviewIntegrity(raw, calculations)).toMatchObject({
    reason: 'retained_actual_mismatch',
  });
});
it('rejects unknown envelope keys, cycles, accessor data and bounded overflow', () => {
  expect(
    verifyRaceManualReviewIntegrity({ ...input(), verified: true }, calculations),
  ).toMatchObject({ reason: 'invalid_input' });
  const cyclic: Record<string, unknown> = {};
  cyclic['self'] = cyclic;
  expect(verifyRaceManualReviewIntegrity(cyclic, calculations)).toMatchObject({
    reason: 'invalid_input',
  });
  let called = false;
  const getter = {
    get candidate() {
      called = true;
      return input().candidate;
    },
  };
  expect(verifyRaceManualReviewIntegrity(getter, calculations)).toMatchObject({
    reason: 'invalid_input',
  });
  expect(called).toBe(false);
  expect(
    verifyRaceManualReviewIntegrity(
      { ...input(), sourceInput: 'x'.repeat(4 * 1024 * 1024) },
      calculations,
    ),
  ).toMatchObject({ reason: 'input_bound' });
});

it('rejects rehashed changes to frozen blueprint step order', () => {
  const projection = moved();
  const context = routine();
  const step = required(context.blueprint.steps[0]);
  context.blueprint.steps.push({ ...step, id: 'step-two', title: 'Second' });
  projection.routines = [context];
  const raw = input(source(projection));
  expect(verifyRaceManualReviewIntegrity(raw, calculations).status).toBe('consistent');
  required(raw.candidate.body.retainedActualManifest.routines[0]).blueprint.steps.reverse();
  redigest(raw.candidate);
  expect(verifyRaceManualReviewIntegrity(raw, calculations)).toMatchObject({
    reason: 'retained_actual_mismatch',
  });
});

it('matches no-op dates while keeping approval blocked and rejects forged versions', () => {
  const projection = fixture();
  projection.newLocalDate = projection.event.localDate;
  const raw = input(source(projection));
  expect(raw.candidate.body.writeIntents.event).toBeNull();
  expect(verifyRaceManualReviewIntegrity(raw, calculations)).toMatchObject({
    status: 'consistent',
    admissionAllowed: false,
    candidate: { approval: { status: 'blocked' } },
  });
  const body = { ...raw.candidate.body, schemaVersion: 2 };
  const candidate = {
    ...raw.candidate,
    body,
    digest: createHash('sha256').update(canonical(body)).digest('hex'),
  };
  expect(verifyRaceManualReviewIntegrity({ ...raw, candidate }, calculations)).toMatchObject({
    reason: 'candidate_mismatch',
  });
});
