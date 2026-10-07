import { describe, expect, it } from 'vitest';
import { genericRecoveryExportData34 } from '../src/generic-recovery-export.js';
import { accountExportSchema } from '../src/operations.js';
import {
  routineScheduleVersionSchema,
  routineOccurrenceSchema,
  routineRunSchema,
} from '../src/routines.js';
import { recoveryStrategyVersionSchema } from '../src/recovery-core.js';

const at = '2026-10-07T00:00:00.123456Z';
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Bodies follow the existing routines and recovery-core runtime contracts.
function fixture() {
  const blueprint = {
    schemaVersion: 4,
    routineId: id(1),
    versionId: id(2),
    title: 'Routine',
    intent: '',
    status: 'draft',
    tags: [],
    steps: [
      {
        id: 'check',
        title: 'Check',
        content: { kind: 'checklist', prompt: 'Ready?' },
        timing: { kind: 'ordered', afterStepId: null },
        required: true,
        choiceGroupId: null,
      },
    ],
    choiceGroups: [],
    estimatedDurationSeconds: null,
    createdAt: at,
  };
  const schedule = {
    schemaVersion: 4,
    id: id(3),
    versionId: id(4),
    blueprint: { id: id(1), versionId: id(2) },
    window: {
      startDate: '2026-10-07',
      endDateExclusive: '2026-10-08',
      timezone: 'UTC',
      maxOccurrences: 1,
    },
    rule: { kind: 'dates', dates: ['2026-10-07'], localTime: '00:00' },
    state: 'active',
  };
  const occurrence = {
    id: id(5),
    schedule: { id: id(3), versionId: id(4) },
    blueprint: { id: id(1), versionId: id(2) },
    anchorKey: 'date:2026-10-07',
    scheduledAt: at,
    timingStatus: 'resolved',
    stepBindings: [],
    selectedChoices: {},
  };
  const run = {
    id: id(6),
    revision: 1,
    blueprint: { id: id(1), versionId: id(2) },
    origin: { kind: 'planned', occurrenceId: id(5) },
    state: 'in_progress',
    progress: [],
    selectedChoices: {},
    startedAt: at,
    endedAt: null,
  };
  const method = {
    schemaVersion: 1,
    methodId: id(7),
    versionId: id(8),
    version: 1,
    title: 'Manual rest',
    category: 'rest',
    intendedUse: '',
    applicability: [],
    cautions: [],
    sourceDescription: '',
    evidenceLimitations: 'No efficacy review',
    reviewState: 'unreviewed',
    reviewedAt: null,
    source: 'user_recorded',
    createdAt: at,
  };
  const strategy = {
    schemaVersion: 1,
    strategyId: id(9),
    versionId: id(10),
    version: 1,
    previousVersionId: null,
    status: 'draft',
    selectedOptionId: null,
    createdAt: at,
    draft: {
      title: 'Recovery',
      goal: '',
      startDate: '2026-10-07',
      endDateExclusive: '2026-10-08',
      timezone: 'UTC',
      knownFacts: [],
      missingInformation: ['Next check-in'],
      priority: 'normal',
      observations: [],
      planRefs: [],
      options: [
        {
          id: id(11),
          title: 'Rest',
          kind: 'nonexercise_action',
          methodVersionId: id(8),
          explanation: '',
        },
      ],
      reassessment: [
        {
          id: id(12),
          trigger: 'plan_changed',
          plannedAt: null,
          description: 'Review plan',
          policyVersion: null,
        },
      ],
    },
  };
  const active = {
    schemaVersion: 1,
    actionId: id(13),
    revisionId: id(14),
    revision: 1,
    status: 'active',
    recordedAt: at,
    methodVersionId: id(8),
    strategyVersionId: id(10),
    plannedOptionId: id(11),
    occurredAt: at,
    timezone: 'UTC',
    state: 'unconfirmed',
    durationSeconds: null,
    actualConditions: '',
    beforeCheckIn: null,
    afterCheckIn: null,
    discomfort: '',
    userNotes: '',
    source: 'user_confirmed',
  };
  const deleted = {
    actionId: id(13),
    revisionId: id(15),
    revision: 2,
    status: 'deleted',
    deletedAt: at,
  };
  const approval = {
    approval_id: id(16),
    candidate_id: id(17),
    proposal_id: id(18),
    proposal_digest: 'a'.repeat(64),
    write_domains: ['recovery', 'routine_schedule'],
    approved_at: at,
    result_json: {
      schemaVersion: 4,
      approvalId: id(16),
      candidateId: id(17),
      versions: [
        { domain: 'recovery', aggregateId: id(9), versionId: id(10) },
        { domain: 'routine_schedule', aggregateId: id(3), versionId: id(4) },
      ],
      occurrenceIds: [id(5)],
      approvedAt: at,
    },
  };
  return genericRecoveryExportData34.parse({
    genericRoutineBlueprintVersions: [
      {
        routine_id: id(1),
        version_id: id(2),
        version: 1,
        previous_version_id: null,
        record_json: blueprint,
        created_at: at,
      },
    ],
    genericRoutineBlueprintHeads: [
      { routine_id: id(1), version_id: id(2), version: 1, favorite: false, visibility: 'deleted' },
    ],
    genericRoutineScheduleVersions: [
      {
        schedule_id: id(3),
        version_id: id(4),
        prior_version_id: null,
        blueprint_routine_id: id(1),
        blueprint_version_id: id(2),
        source_plan_version_id: null,
        record_json: schedule,
        created_at: at,
      },
    ],
    genericRoutineScheduleHeads: [
      { schedule_id: id(3), version_id: id(4), notification_muted: true },
    ],
    genericRoutineOccurrences: [
      {
        id: id(5),
        schedule_id: id(3),
        schedule_version_id: id(4),
        blueprint_routine_id: id(1),
        blueprint_version_id: id(2),
        anchor_key: occurrence.anchorKey,
        scheduled_at: at,
        record_json: occurrence,
      },
    ],
    genericRoutineRuns: [
      {
        id: id(6),
        blueprint_routine_id: id(1),
        blueprint_version_id: id(2),
        occurrence_id: id(5),
        revision: 1,
        state: 'in_progress',
        record_json: run,
      },
    ],
    genericRoutineRunRevisions: [
      { run_id: id(6), revision: 1, record_json: structuredClone(run), recorded_at: at },
    ],
    genericRoutineChecklistConfirmations: [
      {
        id: id(19),
        run_id: id(6),
        step_id: 'check',
        revision_id: id(20),
        occurred_at: at,
        state: 'partial',
      },
    ],
    genericRoutineStepTimers: [
      {
        run_id: id(6),
        step_id: 'check',
        revision: 1,
        state: 'paused',
        duration_seconds: 30,
        started_at: at,
        paused_at: at,
        paused_milliseconds: '0',
      },
    ],
    recoveryMethodVersions: [
      { method_id: id(7), version_id: id(8), version: 1, record_json: method },
    ],
    recoveryMethodHeads: [{ method_id: id(7), version_id: id(8), version: 1 }],
    recoveryStrategyVersions: [
      {
        strategy_id: id(9),
        version_id: id(10),
        version: 1,
        previous_version_id: null,
        previous_version: null,
        record_json: strategy,
      },
    ],
    recoveryStrategyHeads: [{ strategy_id: id(9), version_id: id(10), version: 1 }],
    recoveryActions: [{ action_id: id(13), revision_id: id(15), revision: 2, status: 'deleted' }],
    recoveryActionRevisions: [
      {
        action_id: id(13),
        revision_id: id(14),
        revision: 1,
        status: 'active',
        record_json: active,
      },
      {
        action_id: id(13),
        revision_id: id(15),
        revision: 2,
        status: 'deleted',
        record_json: deleted,
      },
    ],
    recoveryStrategyHistory: [
      { version_id: id(10), approval_id: id(16), action: 'candidate_approved' },
    ],
    genericRoutineScheduleHistory: [
      { version_id: id(4), approval_id: id(16), action: 'candidate_approved' },
    ],
    referencedIntegratedApprovalFacts: [approval],
  });
}
function artifact(version = 34) {
  const schema = accountExportSchema.options.find((s) => s.shape.schemaVersion.value === version);
  if (!schema) throw new Error(`Missing schema ${version}`);
  return {
    schemaVersion: version,
    athleteId: 'synthetic-generic-recovery-export',
    exportedAt: at,
    data: Object.fromEntries(schema.shape.data.keyof().options.map((key) => [key, []])),
  };
}
const row = <T>(rows: T[]) => {
  const first = rows[0];
  if (!first) throw new Error('Missing fixture row');
  return first;
};
type Fixture = ReturnType<typeof fixture>;
const invalid = (change: (data: Fixture) => void) => {
  const data = fixture();
  change(data);
  const result = genericRecoveryExportData34.safeParse(data);
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues.length).toBeGreaterThan(0);
};

describe('v34 factual generic routine and recovery export', () => {
  it('retains null observations, deleted heads and tombstones beside their exact history', () => {
    const data = fixture();
    expect(genericRecoveryExportData34.parse(data)).toEqual(data);
    const exported = { ...artifact(), data: { ...artifact().data, ...data } };
    expect(accountExportSchema.parse(exported)).toEqual(exported);
    expect(row(data.recoveryActionRevisions).record_json).toHaveProperty('durationSeconds', null);
    expect(data.recoveryActions).toEqual([
      { action_id: id(13), revision_id: id(15), revision: 2, status: 'deleted' },
    ]);
  });
  it.each(Object.keys(fixture()))('rejects duplicate factual identities in %s', (key) => {
    const data = fixture();
    const rows = Object.fromEntries(Object.entries(data));
    const current: unknown = rows[key];
    if (!Array.isArray(current)) throw new Error('Expected fixture collection');
    expect(
      genericRecoveryExportData34.safeParse({ ...data, [key]: [...current, current[0]] }).success,
    ).toBe(false);
  });
  const tupleChanges: [string, (data: Fixture) => void][] = [
    [
      'blueprint body',
      (d) => {
        row(d.genericRoutineBlueprintVersions).record_json.routineId = id(99);
      },
    ],
    [
      'blueprint predecessor',
      (d) => {
        row(d.genericRoutineBlueprintVersions).version = 2;
      },
    ],
    [
      'blueprint head',
      (d) => {
        row(d.genericRoutineBlueprintHeads).version = 2;
      },
    ],
    [
      'schedule body',
      (d) => {
        row(d.genericRoutineScheduleVersions).record_json.id = id(99);
      },
    ],
    [
      'schedule frozen blueprint',
      (d) => {
        row(d.genericRoutineScheduleVersions).blueprint_version_id = id(99);
      },
    ],
    [
      'schedule predecessor',
      (d) => {
        row(d.genericRoutineScheduleVersions).prior_version_id = id(99);
      },
    ],
    [
      'schedule head',
      (d) => {
        row(d.genericRoutineScheduleHeads).version_id = id(99);
      },
    ],
    [
      'occurrence anchor',
      (d) => {
        row(d.genericRoutineOccurrences).anchor_key = 'other';
      },
    ],
    [
      'occurrence schedule',
      (d) => {
        row(d.genericRoutineOccurrences).schedule_version_id = id(99);
      },
    ],
    [
      'run origin',
      (d) => {
        row(d.genericRoutineRuns).occurrence_id = id(99);
      },
    ],
    [
      'run current revision',
      (d) => {
        row(d.genericRoutineRunRevisions).record_json.state = 'paused';
      },
    ],
    [
      'run revision identity',
      (d) => {
        row(d.genericRoutineRunRevisions).revision = 2;
      },
    ],
    [
      'run frozen blueprint',
      (d) => {
        row(d.genericRoutineRunRevisions).record_json.blueprint.versionId = id(99);
      },
    ],
    [
      'checklist step',
      (d) => {
        row(d.genericRoutineChecklistConfirmations).step_id = 'unknown';
      },
    ],
    [
      'timer run',
      (d) => {
        row(d.genericRoutineStepTimers).run_id = id(99);
      },
    ],
    [
      'method body',
      (d) => {
        row(d.recoveryMethodVersions).record_json.version = 2;
      },
    ],
    [
      'method head',
      (d) => {
        row(d.recoveryMethodHeads).version = 2;
      },
    ],
    [
      'strategy predecessor',
      (d) => {
        row(d.recoveryStrategyVersions).previous_version = 1;
      },
    ],
    [
      'strategy method',
      (d) => {
        row(row(d.recoveryStrategyVersions).record_json.draft.options).methodVersionId = id(99);
      },
    ],
    [
      'strategy head',
      (d) => {
        row(d.recoveryStrategyHeads).version_id = id(99);
      },
    ],
    [
      'action tombstone head',
      (d) => {
        row(d.recoveryActions).revision_id = id(99);
      },
    ],
    [
      'action history identity',
      (d) => {
        row(d.recoveryActionRevisions).revision_id = id(99);
      },
    ],
    [
      'strategy approval history',
      (d) => {
        row(d.recoveryStrategyHistory).version_id = id(99);
      },
    ],
    [
      'schedule approval history',
      (d) => {
        row(d.genericRoutineScheduleHistory).approval_id = id(99);
      },
    ],
    [
      'approval domain result',
      (d) => {
        row(row(d.referencedIntegratedApprovalFacts).result_json.versions).aggregateId = id(99);
      },
    ],
  ];
  it.each(tupleChanges)('rejects mismatched %s instead of learning references', (_name, change) =>
    invalid(change),
  );
  it.each([
    'genericRoutineRunRevisions',
    'recoveryActionRevisions',
    'recoveryMethodVersions',
    'recoveryStrategyVersions',
    'referencedIntegratedApprovalFacts',
  ])('rejects missing mandatory facts in %s', (key) => {
    expect(genericRecoveryExportData34.safeParse({ ...fixture(), [key]: [] }).success).toBe(false);
  });
  it('keeps orphan approval receipts out of export and requires a structured error for missing collections', () => {
    const d = fixture();
    expect(
      genericRecoveryExportData34.safeParse({
        ...d,
        recoveryStrategyHistory: [],
        genericRoutineScheduleHistory: [],
      }).success,
    ).toBe(false);
    for (const key of Object.keys(d)) {
      const result = genericRecoveryExportData34.safeParse({ ...d, [key]: undefined });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });
  it('preserves all old2..33 discriminator data shapes without adding v34 collections', () => {
    for (let version = 2; version <= 33; version++) {
      const a = artifact(version);
      expect(accountExportSchema.parse(a)).toEqual(a);
      expect(a.data).not.toHaveProperty('genericRoutineRuns');
      expect(
        accountExportSchema.safeParse({ ...a, data: { ...a.data, genericRoutineRuns: [] } })
          .success,
      ).toBe(false);
      expect(accountExportSchema.safeParse({ ...a, schemaVersion: 34 }).success).toBe(false);
    }
  });
});

describe('timer decimal bigint and precise exported instants', () => {
  it.each(['0', '9007199254740992', '9223372036854775807'])(
    'preserves decimal string %s without Number conversion',
    (value) => {
      const d = fixture();
      row(d.genericRoutineStepTimers).paused_milliseconds = value;
      expect(
        row(genericRecoveryExportData34.parse(d).genericRoutineStepTimers).paused_milliseconds,
      ).toBe(value);
    },
  );
  it.each([
    '00',
    '01',
    '-1',
    '+1',
    '1.0',
    '1e3',
    '9223372036854775808',
    '99999999999999999999',
    '',
  ])('rejects noncanonical or overflowing decimal %j', (value) =>
    invalid((d) => {
      row(d.genericRoutineStepTimers).paused_milliseconds = value;
    }),
  );
  it.each([0, 9007199254740992, null])('rejects non-string pause value %j', (value) => {
    const d = fixture();
    expect(
      genericRecoveryExportData34.safeParse({
        ...d,
        genericRoutineStepTimers: [
          { ...row(d.genericRoutineStepTimers), paused_milliseconds: value },
        ],
      }).success,
    ).toBe(false);
  });
  it('accepts timezone-equivalent microseconds and rejects differences lost by Date.parse', () => {
    const d = fixture();
    row(d.genericRoutineOccurrences).scheduled_at = '2026-10-07T09:00:00.123456+09:00';
    row(d.referencedIntegratedApprovalFacts).approved_at = '2026-10-07T00:00:00.1234560+00:00';
    expect(genericRecoveryExportData34.safeParse(d).success).toBe(true);
    invalid((x) => {
      row(x.genericRoutineOccurrences).scheduled_at = '2026-10-07T00:00:00.123457Z';
    });
    invalid((x) => {
      row(x.referencedIntegratedApprovalFacts).approved_at = '2026-10-07T00:00:00.123457Z';
    });
  });
  it.each(['2026-10-07T09:00:00.123456+09:00', '2026-10-07T00:00:00.1234560+00:00'])(
    'accepts blueprint creation timestamp equivalent to its body: %s',
    (createdAt) => {
      const d = fixture();
      const blueprint = row(d.genericRoutineBlueprintVersions);
      expect(blueprint.created_at).toBe(blueprint.record_json.createdAt);
      blueprint.created_at = createdAt;
      expect(genericRecoveryExportData34.parse(d)).toEqual(d);
    },
  );
  it.each(['2026-10-07T00:00:00.123455Z', '2026-10-07T00:00:00.123457Z'])(
    'rejects blueprint creation microseconds differing from its body: %s',
    (createdAt) => {
      const d = fixture();
      const blueprint = row(d.genericRoutineBlueprintVersions);
      expect(blueprint.created_at).toBe(blueprint.record_json.createdAt);
      blueprint.created_at = createdAt;
      const result = genericRecoveryExportData34.safeParse(d);
      expect(result.success).toBe(false);
      if (!result.success)
        expect(
          result.error.issues.some((issue) => issue.message === 'Blueprint timestamp differs'),
        ).toBe(true);
    },
  );
  it('rejects mismatched pause state and unresolved-anchor nullability', () => {
    expect(
      genericRecoveryExportData34.safeParse({
        ...fixture(),
        genericRoutineStepTimers: [{ ...row(fixture().genericRoutineStepTimers), paused_at: null }],
      }).success,
    ).toBe(false);
    expect(
      genericRecoveryExportData34.safeParse({
        ...fixture(),
        genericRoutineOccurrences: [
          { ...row(fixture().genericRoutineOccurrences), scheduled_at: null },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('bounded export facts cannot carry command or approval authority', () => {
  it.each([
    'approved',
    'importAuthority',
    'restoreGeneration',
    'idempotencyKey',
    'receipt_key',
    'proof',
    'activepermission',
  ])('rejects unknown authority key %s at artifact, data, row and body boundaries', (key) => {
    const d = fixture();
    const a = { ...artifact(), data: { ...artifact().data, ...d } };
    for (const value of [
      { ...a, [key]: true },
      { ...a, data: { ...a.data, [key]: true } },
      {
        ...a,
        data: { ...a.data, genericRoutineRuns: [{ ...row(d.genericRoutineRuns), [key]: true }] },
      },
      {
        ...a,
        data: {
          ...a.data,
          genericRoutineRuns: [
            {
              ...row(d.genericRoutineRuns),
              record_json: { ...row(d.genericRoutineRuns).record_json, [key]: true },
            },
          ],
        },
      },
    ]) {
      expect(accountExportSchema.safeParse(value).success).toBe(false);
    }
  });
  it('rejects an oversized valid blueprint body using UTF-8 bytes without truncation', () => {
    const d = fixture();
    row(d.genericRoutineBlueprintVersions).record_json.intent = '가'.repeat(350_000);
    const result = genericRecoveryExportData34.safeParse(d);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.some((issue) => issue.message.includes('byte bound'))).toBe(true);
  });
  it('rejects malformed JSON bodies and over1000 factual rows with structured errors', () => {
    const d = fixture();
    for (const record_json of [null, 'not-a-record', { status: 'error', message: 'unavailable' }]) {
      expect(
        genericRecoveryExportData34.safeParse({
          ...d,
          genericRoutineBlueprintVersions: [
            { ...row(d.genericRoutineBlueprintVersions), record_json },
          ],
        }).success,
      ).toBe(false);
    }
    expect(
      genericRecoveryExportData34.safeParse({
        ...d,
        genericRoutineBlueprintVersions: Array.from({ length: 1001 }, () =>
          row(d.genericRoutineBlueprintVersions),
        ),
      }).success,
    ).toBe(false);
  });
});

describe('independent body and collection budgets', () => {
  it('accepts exactly the blueprint byte limit and rejects one additional ASCII byte', () => {
    const d = fixture();
    const body = row(d.genericRoutineBlueprintVersions).record_json;
    const remaining = 1_048_576 - new TextEncoder().encode(JSON.stringify(body)).byteLength;
    body.intent = 'a'.repeat(remaining);
    expect(genericRecoveryExportData34.safeParse(d).success).toBe(true);
    body.intent += 'a';
    const result = genericRecoveryExportData34.safeParse(d);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.some((issue) => issue.message.includes('byte bound'))).toBe(true);
  });
  const changes: ['schedule' | 'occurrence' | 'run' | 'strategy', (d: Fixture) => void][] = [
    [
      'schedule',
      (d) => {
        row(d.genericRoutineScheduleVersions).record_json.rule = {
          kind: 'session_links',
          point: 'end',
          offsetMinutes: 0,
          sessionIds: Array.from({ length: 1000 }, (_, i) => `session-${i}-${'x'.repeat(110)}`),
        };
      },
    ],
    [
      'occurrence',
      (d) => {
        row(d.genericRoutineOccurrences).record_json.selectedChoices = Object.fromEntries(
          Array.from({ length: 1000 }, (_, i) => [`choice-${i}`, 'x'.repeat(100)]),
        );
      },
    ],
    [
      'run',
      (d) => {
        const choices = Object.fromEntries(
          Array.from({ length: 10000 }, (_, i) => [`choice-${i}`, 'x'.repeat(100)]),
        );
        row(d.genericRoutineRuns).record_json.selectedChoices = choices;
        row(d.genericRoutineRunRevisions).record_json.selectedChoices = choices;
      },
    ],
    [
      'strategy',
      (d) => {
        const draft = row(d.recoveryStrategyVersions).record_json.draft;
        draft.knownFacts = Array.from({ length: 30 }, () => '가'.repeat(2000));
        draft.options = Array.from({ length: 20 }, (_, i) => ({
          id: id(100 + i),
          title: 'Rest',
          kind: 'full_rest',
          methodVersionId: null,
          explanation: '가'.repeat(2000),
        }));
      },
    ],
  ];
  it.each(changes)('enforces the %s JSON byte budget on schema-valid bodies', (_name, change) => {
    const d = fixture();
    change(d);
    const validBodies = {
      schedule: routineScheduleVersionSchema.safeParse(
        row(d.genericRoutineScheduleVersions).record_json,
      ).success,
      occurrence: routineOccurrenceSchema.safeParse(row(d.genericRoutineOccurrences).record_json)
        .success,
      run: routineRunSchema.safeParse(row(d.genericRoutineRuns).record_json).success,
      strategy: recoveryStrategyVersionSchema.safeParse(row(d.recoveryStrategyVersions).record_json)
        .success,
    };
    expect(validBodies[_name]).toBe(true);
    const result = genericRecoveryExportData34.safeParse(d);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.some((issue) => issue.message.includes('byte bound'))).toBe(true);
  });
  it('accepts1000 unique factual method rows and rejects1001 without relying on duplicates', () => {
    const d = fixture();
    const original = row(d.recoveryMethodVersions);
    d.recoveryMethodVersions = Array.from({ length: 1000 }, (_, i) => {
      const versionId = i === 0 ? original.version_id : id(1000 + i);
      const methodId = i === 0 ? original.method_id : id(3000 + i);
      return {
        ...original,
        method_id: methodId,
        version_id: versionId,
        record_json: { ...original.record_json, methodId, versionId },
      };
    });
    expect(genericRecoveryExportData34.safeParse(d).success).toBe(true);
    d.recoveryMethodVersions.push({
      ...original,
      method_id: id(9998),
      version_id: id(9999),
      record_json: { ...original.record_json, methodId: id(9998), versionId: id(9999) },
    });
    expect(genericRecoveryExportData34.safeParse(d).success).toBe(false);
  });
  it.each(Object.keys(fixture()))(
    'rejects processing authority in each strict factual row: %s',
    (key) => {
      const d = fixture();
      const current: unknown = Object.fromEntries(Object.entries(d))[key];
      if (!Array.isArray(current)) throw new Error('Expected collection');
      expect(
        genericRecoveryExportData34.safeParse({
          ...d,
          [key]: [...current.slice(0, -1), { ...current.at(-1), importAuthority: true }],
        }).success,
      ).toBe(false);
    },
  );
});

describe('SQL aggregate version uniqueness survives portable export', () => {
  it('rejects two blueprint version IDs for the same routine/version tuple', () => {
    const d = fixture();
    const original = row(d.genericRoutineBlueprintVersions);
    d.genericRoutineBlueprintVersions.push({
      ...original,
      version_id: id(99),
      record_json: { ...original.record_json, versionId: id(99) },
    });
    expect(genericRecoveryExportData34.safeParse(d).success).toBe(false);
  });
  it('rejects two method version IDs for the same method/version tuple', () => {
    const d = fixture();
    const original = row(d.recoveryMethodVersions);
    d.recoveryMethodVersions.push({
      ...original,
      version_id: id(99),
      record_json: { ...original.record_json, versionId: id(99) },
    });
    expect(genericRecoveryExportData34.safeParse(d).success).toBe(false);
  });
  it('rejects two strategy version IDs for the same strategy/version tuple', () => {
    const d = fixture();
    const original = row(d.recoveryStrategyVersions);
    d.recoveryStrategyVersions.push({
      ...original,
      version_id: id(99),
      record_json: { ...original.record_json, versionId: id(99) },
    });
    expect(genericRecoveryExportData34.safeParse(d).success).toBe(false);
  });
});
