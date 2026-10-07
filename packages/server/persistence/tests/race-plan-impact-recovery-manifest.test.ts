import { nutritionPlanVersionCompatibleV4Schema } from '@workout/contracts/nutrition-race-plan-v4';
import { expect, it } from 'vitest';
import {
  recoveryMethodVersionSchema,
  recoveryStrategyVersionSchema,
} from '@workout/contracts/recovery-core';
import { planSnapshotSchema } from '@workout/contracts/planning';
import {
  recoveryReadSourcesProjectionSchema,
  validateRecoveryReadSources,
} from '../src/race-plan-impact-recovery-manifest.js';
import { impactDependencyDigest } from '../src/race-plan-impact-dependencies.js';
const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${n.toString(16).padStart(12, '0')}`;
const at = '2026-10-07T00:00:00.000Z';
function fixture() {
  const method = recoveryMethodVersionSchema.parse({
    schemaVersion: 1,
    methodId: id(3),
    versionId: id(4),
    version: 1,
    title: 'Synthetic breathing',
    category: 'relaxation',
    intendedUse: 'User action',
    applicability: [],
    cautions: [],
    sourceDescription: '',
    evidenceLimitations: 'Not reviewed',
    reviewState: 'unreviewed',
    reviewedAt: null,
    source: 'user_recorded',
    createdAt: at,
  });
  const record = recoveryStrategyVersionSchema.parse({
    schemaVersion: 1,
    strategyId: id(1),
    versionId: id(2),
    version: 1,
    previousVersionId: null,
    status: 'user_confirmed',
    selectedOptionId: id(5),
    createdAt: at,
    draft: {
      title: 'Synthetic recovery',
      goal: '',
      startDate: '2026-10-07',
      endDateExclusive: '2026-10-08',
      timezone: 'UTC',
      knownFacts: [],
      missingInformation: [],
      priority: 'normal',
      observations: [],
      planRefs: [],
      options: [
        {
          id: id(5),
          title: 'Relaxation',
          kind: 'nonexercise_action',
          methodVersionId: method.versionId,
          explanation: '',
        },
      ],
      reassessment: [
        {
          id: id(6),
          trigger: 'plan_changed',
          plannedAt: null,
          description: 'Review plan change',
          policyVersion: null,
        },
      ],
    },
  });
  return recoveryReadSourcesProjectionSchema.parse({
    roster: [{ aggregateId: record.strategyId, versionId: record.versionId }],
    recovery: [{ aggregateId: record.strategyId, versionId: record.versionId, record }],
    plans: [],
    nutrition: [],
    methodSources: [method],
    trainingAssociations: [],
    methodCatalog: [
      {
        requested: {
          kind: 'recovery_method',
          ref: { id: method.methodId, versionId: method.versionId },
        },
        state: 'current',
        reason: null,
        content: { digest: impactDependencyDigest(method) },
        currentHead: { aggregate_id: method.methodId, version_id: method.versionId },
        provenance: { source: method.source, reviewState: method.reviewState, reviewedAt: null },
      },
    ],
  });
}
function strategy(c: ReturnType<typeof fixture>) {
  const row = c.recovery[0];
  if (!row) throw new Error('Missing fixture strategy');
  return row.record;
}
function catalog(c: ReturnType<typeof fixture>) {
  const row = c.methodCatalog[0];
  if (!row) throw new Error('Missing fixture catalog');
  return row;
}
function method(c: ReturnType<typeof fixture>) {
  const row = c.methodSources?.[0];
  if (!row) throw new Error('Missing fixture method');
  return row;
}
function reasons(input: unknown) {
  return validateRecoveryReadSources(input).blockers.map((b) => b.reason);
}
function training(c: ReturnType<typeof fixture>) {
  c.plans.push(
    planSnapshotSchema.parse({
      id: id(8),
      version: 1,
      createdAt: at,
      draft: {
        title: 'Frozen training',
        timezone: 'UTC',
        sessions: [],
        periods: [
          {
            id: 'season',
            parentId: null,
            level: 'season',
            title: 'Season',
            startDate: '2026-10-07',
            endDateExclusive: '2026-10-08',
            timezone: 'UTC',
            intent: '',
            isPartial: false,
          },
        ],
      },
    }),
  );
  strategy(c).draft.planRefs.push({ kind: 'training', aggregateId: id(7), headVersionId: id(8) });
  c.trainingAssociations = [{ aggregateId: id(7), versionId: id(8) }];
}
it('validates exact public recovery DTO facts without approval or effectiveness authority', () => {
  const c = fixture(),
    before = JSON.stringify(c);
  expect(validateRecoveryReadSources(c)).toMatchObject({
    status: 'validated_read_sources',
    authority: 'none',
    freshness: 'not_checked',
    blockers: [],
    facts: { strategies: 1, methods: 1, planRefs: 0 },
  });
  expect(JSON.stringify(c)).toBe(before);
  expect(strategy(c).draft.reassessment[0]?.plannedAt).toBeNull();
});
it('validates truly closed empty without fabricating methods', () => {
  expect(
    validateRecoveryReadSources({
      roster: [],
      recovery: [],
      plans: [],
      nutrition: [],
      methodCatalog: [],
    }).status,
  ).toBe('validated_read_sources');
});
it('validates full rest without method-source ports', () => {
  const c = fixture();
  strategy(c).draft.options = [
    { id: id(5), title: 'Rest', kind: 'full_rest', methodVersionId: null, explanation: '' },
  ];
  delete c.methodSources;
  c.methodCatalog = [];
  expect(validateRecoveryReadSources(c).status).toBe('validated_read_sources');
});
it('keeps historical exact method body when current head is newer', () => {
  const c = fixture();
  catalog(c).state = 'historical';
  const h = catalog(c).currentHead;
  if (!h) throw new Error('Missing fixture head');
  h.version_id = id(99);
  expect(validateRecoveryReadSources(c).status).toBe('validated_read_sources');
});
it('distinguishes historical method with absent current head from missing exact body', () => {
  const c = fixture();
  catalog(c).state = 'historical';
  catalog(c).currentHead = null;
  expect(validateRecoveryReadSources(c).status).toBe('validated_read_sources');
  delete c.methodSources;
  expect(reasons(c)).toContain('method_source_missing');
});
it('requires current permission facts for actually consumed methods', () => {
  const c = fixture();
  c.methodCatalog = [];
  expect(reasons(c)).toContain('method_permission_missing');
});
it('does not treat unavailable method with null body as zero or current', () => {
  const c = fixture();
  Object.assign(catalog(c), {
    state: 'unavailable',
    reason: 'owned_version_unavailable',
    content: null,
    provenance: null,
    currentHead: null,
  });
  expect(reasons(c)).toContain('method_unavailable');
});
it('rejects foreign method tuple', () => {
  const c = fixture();
  catalog(c).requested.ref.id = id(99);
  expect(reasons(c)).toContain('method_source_mismatch');
});
it('rejects changed method body under the frozen digest', () => {
  const c = fixture();
  method(c).title = 'Changed';
  expect(reasons(c)).toContain('method_source_mismatch');
});
it('rejects missing provenance and historical mislabeled current', () => {
  const c = fixture();
  catalog(c).provenance = null;
  expect(reasons(c)).toEqual(['invalid_projection']);
  const d = fixture();
  catalog(d).state = 'historical';
  expect(reasons(d)).toContain('method_source_mismatch');
});
it('validates exact consumed training source with immutable 112 association', () => {
  const c = fixture();
  training(c);
  expect(validateRecoveryReadSources(c).status).toBe('validated_read_sources');
});
it('blocks missing historical association rather than substituting current head', () => {
  const c = fixture();
  training(c);
  delete c.trainingAssociations;
  expect(reasons(c)).toContain('training_association_missing');
});
it('rejects wrong aggregate even with existing owned version', () => {
  const c = fixture();
  training(c);
  c.trainingAssociations = [{ aggregateId: id(99), versionId: id(8) }];
  expect(reasons(c)).toContain('plan_tuple_mismatch');
});
it('requires actual frozen training body independently of association', () => {
  const c = fixture();
  training(c);
  c.plans = [];
  expect(reasons(c)).toContain('training_source_missing');
});
it('blocks unavailable nutrition version instead of interpreting it as empty', () => {
  const c = fixture();
  strategy(c).draft.planRefs.push({ kind: 'nutrition', aggregateId: id(7), headVersionId: id(8) });
  expect(reasons(c)).toContain('nutrition_source_missing');
});
it('blocks actual observations until exact revision permission source port exists', () => {
  const c = fixture();
  strategy(c).draft.observations.push({ kind: 'activity', id: 'activity-1', revision: 1 });
  expect(reasons(c)).toContain('observation_source_port_missing');
});
it('validates offered unselected method dependencies also consumed by public draft writer', () => {
  const c = fixture();
  strategy(c).draft.options.push({
    id: id(9),
    title: 'Other',
    kind: 'nonexercise_action',
    methodVersionId: id(10),
    explanation: '',
  });
  expect(reasons(c)).toContain('method_source_missing');
});
it('rejects roster/body mismatch', () => {
  const c = fixture();
  c.roster = [{ aggregateId: id(99), versionId: id(2) }];
  expect(reasons(c)).toContain('inventory_mismatch');
});
it('rejects strategy body/full tuple mismatch', () => {
  const c = fixture();
  strategy(c).strategyId = id(99);
  expect(reasons(c)).toContain('inventory_mismatch');
});
it('rejects case-variant duplicate roster identity', () => {
  const c = fixture();
  c.roster.push({ aggregateId: id(1).toUpperCase(), versionId: id(2) });
  expect(reasons(c)).toContain('inventory_mismatch');
});
it('accepts UUID casing without altering opaque user text', () => {
  const c = fixture();
  strategy(c).draft.title = '회복 U+10000 𐀀';
  c.roster[0] = { aggregateId: id(1).toUpperCase(), versionId: id(2).toUpperCase() };
  expect(validateRecoveryReadSources(c).status).toBe('validated_read_sources');
});
it.each([
  null,
  {},
  { ...fixture(), unknown: true },
  { ...fixture(), recovery: null },
  { ...fixture(), methodSources: [null] },
])('rejects malformed unknown projection %#', (input) => {
  expect(reasons(input)).toEqual(['invalid_projection']);
});
it('rejects unknown strict method fields', () => {
  const c = fixture();
  expect(reasons({ ...c, methodSources: [{ ...method(c), authorized: true }] })).toEqual([
    'invalid_projection',
  ]);
});
it('rejects duplicate exact source association', () => {
  const c = fixture();
  training(c);
  c.trainingAssociations?.push({ aggregateId: id(7), versionId: id(8) });
  expect(reasons(c)).toContain('inventory_mismatch');
});
it('bounds full serialization before domain traversal', () => {
  const c = fixture();
  expect(reasons({ ...c, noise: 'x'.repeat(4194305) })).toEqual(['invalid_projection']);
});
it('handles cyclic unknown input without throwing', () => {
  const c: { cycle?: unknown } = {};
  c.cycle = c;
  expect(reasons(c)).toEqual(['invalid_projection']);
});
it('includes unconsumed finite metadata in the digest without granting processing authority', () => {
  const c = fixture();
  const d = fixture();
  method(d).evidenceLimitations = 'Different';
  catalog(d).content = { digest: impactDependencyDigest(method(d)) };
  expect(validateRecoveryReadSources(c).digest).not.toBe(validateRecoveryReadSources(d).digest);
  expect(validateRecoveryReadSources(d).authority).toBe('none');
});

it('validates nutrition full tuple while preserving disconnected timing and unknown actuals', () => {
  const c = fixture();
  const record = nutritionPlanVersionCompatibleV4Schema.parse({
    schemaVersion: 3,
    planId: id(7),
    versionId: id(8),
    version: 1,
    previousVersionId: null,
    approvalId: id(9),
    approvedAt: at,
    period: { from: '2026-10-07', toInclusive: '2026-10-07' },
    timezone: 'UTC',
    purpose: 'Food facts',
    linkedTrainingPlanVersionId: null,
    items: [
      {
        id: '식사𐀀',
        planVersionId: id(8),
        category: 'meal',
        title: 'Food',
        anchor: { kind: 'disconnected', entity: 'race' },
        foods: [],
        targets: [],
        instructions: 'Prepare food',
        evidenceIds: [],
        source: 'user_confirmed',
      },
    ],
    raceTimingPins: [],
    itemRaceTimingBindings: [],
  });
  c.nutrition.push({ aggregateId: id(7), versionId: id(8), record });
  strategy(c).draft.planRefs.push({ kind: 'nutrition', aggregateId: id(7), headVersionId: id(8) });
  const before = JSON.stringify(c);
  expect(validateRecoveryReadSources(c).status).toBe('validated_read_sources');
  expect(JSON.stringify(c)).toBe(before);
  c.nutrition[0] = { aggregateId: id(99), versionId: id(8), record };
  expect(reasons(c)).toContain('plan_tuple_mismatch');
});
it('rejects unavailable catalog with a present body rather than accepting contradictory facts', () => {
  const c = fixture();
  catalog(c).state = 'unavailable';
  expect(reasons(c)).toEqual(['invalid_projection']);
});
it('rejects malformed method body null review state', () => {
  const c = fixture();
  expect(reasons({ ...c, methodSources: [{ ...method(c), reviewState: null }] })).toEqual([
    'invalid_projection',
  ]);
});
it('rejects aggregate inventory cap even when per-array caps fit', () => {
  const c = fixture();
  c.methodSources = Array.from({ length: 4999 }, (_, n) => ({
    ...method(c),
    versionId: id(n + 100),
  }));
  expect(reasons(c)).toEqual(['invalid_projection']);
});

it('uses actual SQL025 stored version bound rather than accepting unsafe numbers', () => {
  const c = fixture();
  expect(reasons({ ...c, methodSources: [{ ...method(c), version: 2147483647 }] })).toEqual([
    'invalid_projection',
  ]);
});
it('rejects two method versions that contradict SQL025 unique method/version tuple', () => {
  const c = fixture();
  c.methodSources?.push({ ...method(c), versionId: id(99) });
  expect(reasons(c)).toContain('inventory_mismatch');
});
