import { describe, expect, it } from 'vitest';
import { integratedCandidateV4Schema } from '@workout/contracts/integrated-coaching';
import { nutritionPlanVersionSchema } from '@workout/contracts/nutrition-core';
import { nutritionPlanVersionV3Schema } from '@workout/contracts/nutrition-race-plan-v3';
import { planDraftSchema } from '@workout/contracts/planning';
import { recoveryStrategyDraftSchema } from '@workout/contracts/recovery-core';
import {
  classifyIntegratedApprovalNutritionCopies,
  classifyIntegratedNutritionCopiedSources,
  inspectIntegratedNutritionCopiedSources,
  integratedCandidatePayloadDigest,
  integratedV4ContextDependencyKinds,
} from '../src/nutrition-copied-source-inventory.js';
const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${n.toString(16).padStart(12, '0')}`;
const athlete = id(1),
  planId = id(2),
  versionId = id(3),
  raceId = id(4);
const plan = planDraftSchema.parse({
  title: 'Original training bytes',
  timezone: 'UTC',
  periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
    id: level,
    parentId: index === 0 ? null : (levels[index - 1] ?? null),
    level,
    title: level,
    startDate: '2026-10-07',
    endDateExclusive: '2026-10-08',
    timezone: 'UTC',
    intent: '',
    isPartial: false,
  })),
  sessions: [],
});
function candidate(nutrition = false, race = false) {
  const payload = {
    proposalId: id(5),
    basis: {
      schemaVersion: 4,
      planHeads: [
        { domain: 'training', aggregateId: id(6), head: { kind: 'absent' } },
        ...(nutrition
          ? [{ domain: 'nutrition', aggregateId: planId, head: { kind: 'exists', versionId } }]
          : []),
      ],
      contextDependencies: integratedV4ContextDependencyKinds.map((kind) => ({
        kind,
        id: 'tenant',
        revision: kind === 'ai-consent' ? '1:true' : '0',
      })),
      preferenceRevision: 0,
      constraintRevision: 0,
      conversationRevision: 1,
      policyVersion: 'test',
      evidenceSnapshotId: id(7),
    },
    writes: [
      { domain: 'training', aggregateId: id(6), proposed: plan },
      ...(race
        ? [
            {
              domain: 'nutrition',
              aggregateId: planId,
              proposed: {
                period: { from: '2026-10-07', toInclusive: '2026-10-07' },
                timezone: 'UTC',
                purpose: 'User schedule',
                linkedTrainingPlanVersionId: null,
                items: [
                  {
                    id: '食事'.repeat(1000),
                    category: 'before',
                    title: 'Meal',
                    anchor: {
                      kind: 'relative',
                      entity: 'race',
                      entityId: raceId,
                      point: 'start',
                      offsetMinutes: 0,
                    },
                    foods: [],
                    targets: [],
                    instructions: 'Prepare meal',
                    evidenceIds: [],
                    source: 'user_confirmed',
                  },
                ],
              },
            },
          ]
        : []),
    ],
    summary: 'Same training summary',
    validation: { status: 'checked', errors: [], unknowns: [] },
  };
  const parsed = integratedCandidateV4Schema.parse({
    ...payload,
    id: id(8),
    createdAt: '2026-10-07T00:00:00.123456Z',
    schemaVersion: 4,
    digest: '0'.repeat(64),
  });
  return { ...parsed, digest: integratedCandidatePayloadDigest(parsed) };
}
function identity(body: ReturnType<typeof candidate>) {
  return {
    athleteId: athlete,
    id: body.id,
    proposalId: body.proposalId,
    digest: body.digest,
    createdAt: body.createdAt,
  };
}
function row(disconnected = false) {
  const record = {
    planId,
    versionId,
    version: 1,
    previousVersionId: null,
    approvalId: id(9),
    approvedAt: '2026-10-07T00:00:00Z',
    period: { from: '2026-10-07', toInclusive: '2026-10-07' },
    timezone: 'UTC',
    purpose: 'Owned frozen food',
    linkedTrainingPlanVersionId: null,
    items: [
      {
        id: 'Meal',
        planVersionId: versionId,
        category: 'meal',
        title: 'Preserved meal',
        anchor: disconnected
          ? { kind: 'disconnected', entity: 'race' }
          : { kind: 'absolute', date: '2026-10-07', localTime: null, timezone: 'UTC' },
        foods: [],
        targets: [],
        instructions: 'Prepare food',
        evidenceIds: [],
        source: 'user_confirmed',
      },
    ],
  };
  return {
    athlete_id: athlete,
    plan_id: planId,
    version_id: versionId,
    record_json: disconnected
      ? nutritionPlanVersionV3Schema.parse({
          ...record,
          schemaVersion: 3,
          raceTimingPins: [],
          itemRaceTimingBindings: [],
        })
      : nutritionPlanVersionSchema.parse(record),
  };
}
const classify = (body: ReturnType<typeof candidate>, nutritionRows: readonly unknown[] = []) =>
  classifyIntegratedNutritionCopiedSources({ identity: identity(body), body, nutritionRows });
const reseal = (body: ReturnType<typeof candidate>) => ({
  ...body,
  digest: integratedCandidatePayloadDigest(body),
});
function routineCandidate(refs: readonly { planId: string; versionId: string; itemId: string }[]) {
  const original = candidate(true);
  const scheduleId = id(70),
    scheduleVersionId = id(71),
    blueprint = { id: id(72), versionId: id(73) };
  return integratedCandidateV4Schema.parse(
    reseal({
      ...original,
      basis: {
        ...original.basis,
        planHeads: [
          ...original.basis.planHeads,
          { domain: 'routine_schedule', aggregateId: scheduleId, head: { kind: 'absent' } },
        ],
      },
      writes: [
        ...original.writes,
        {
          domain: 'routine_schedule',
          aggregateId: scheduleId,
          sourcePlanVersionId: null,
          proposed: {
            schemaVersion: 4,
            id: scheduleId,
            versionId: scheduleVersionId,
            blueprint,
            window: {
              startDate: '2026-10-07',
              endDateExclusive: '2026-10-08',
              timezone: 'UTC',
              maxOccurrences: 1,
            },
            rule: { kind: 'dates', dates: ['2026-10-07'], localTime: null },
            state: 'active',
          },
          occurrences: [
            {
              id: id(74),
              schedule: { id: scheduleId, versionId: scheduleVersionId },
              blueprint,
              anchorKey: 'date:2026-10-07',
              scheduledAt: null,
              timingStatus: 'unresolved',
              selectedChoices: {},
              stepBindings: refs.map((ref, i) => ({
                stepId: `step-${i}`,
                plannedRef: { domain: 'nutrition', ...ref },
              })),
            },
          ],
        },
      ],
    }),
  );
}
describe('exact nutrition copied source inventory', () => {
  it('classifies genuine unrelated V4 training and preserves its serialized bytes', () => {
    const body = candidate(),
      bytes = JSON.stringify(body);
    expect(classify(body).kind).toBe('known_unrelated');
    expect(JSON.stringify(body)).toBe(bytes);
  });
  it('extracts exact frozen nutrition full tuple, without a current-head lookup', () => {
    const body = candidate(true),
      result = classify(body, [row()]);
    expect(result).toMatchObject({
      kind: 'related',
      disconnectedVersions: [],
      manifest: {
        nutritionVersions: [{ namespace: 'nutrition-plan-version', planId, versionId }],
        races: [],
      },
    });
  });
  it('rejects a missing frozen source row instead of treating it as an unrelated empty list', () => {
    expect(classify(candidate(true))).toEqual({
      kind: 'unsupported',
      reason: 'source_unavailable',
    });
  });
  it.each(['foreign tenant', 'wrong aggregate', 'wrong version', 'duplicate row'])(
    'rejects %s nutrition SQL rows',
    (kind) => {
      const value = row();
      const rows =
        kind === 'duplicate row'
          ? [value, value]
          : [
              {
                ...value,
                ...(kind === 'foreign tenant'
                  ? { athlete_id: id(100) }
                  : kind === 'wrong aggregate'
                    ? { plan_id: id(100) }
                    : { version_id: id(100) }),
              },
            ];
      expect(classify(candidate(true), rows)).toEqual({
        kind: 'unsupported',
        reason: 'source_tuple_mismatch',
      });
    },
  );
  it('detects actual owned redacted V3 without inventing a race date or reapproving it', () => {
    expect(classify(candidate(true), [row(true)])).toMatchObject({
      kind: 'related',
      disconnectedVersions: [{ namespace: 'nutrition-plan-version', planId, versionId }],
    });
  });
  it('extracts a race UUID and preserves long item IDs and original V4 wire', () => {
    const body = candidate(true, true),
      bytes = JSON.stringify(body);
    expect(classify(body, [row()])).toMatchObject({
      kind: 'related',
      manifest: { races: [{ namespace: 'race-event', eventId: raceId }] },
    });
    expect(JSON.stringify(body)).toBe(bytes);
  });
  it('normalizes UUID source identity without changing original candidate/digest bytes', () => {
    const original = candidate(true, true);
    const body = reseal({
      ...original,
      writes: original.writes.map((write) =>
        write.domain === 'nutrition'
          ? {
              ...write,
              proposed: {
                ...write.proposed,
                items: write.proposed.items.map((item) => ({
                  ...item,
                  anchor: {
                    kind: 'relative',
                    entity: 'race',
                    entityId: raceId.toUpperCase(),
                    point: 'start',
                    offsetMinutes: 0,
                  },
                })),
              },
            }
          : write,
      ),
    });
    const bytes = JSON.stringify(body);
    expect(classify(body, [row()])).toMatchObject({
      kind: 'related',
      manifest: { races: [{ eventId: raceId }] },
    });
    expect(JSON.stringify(body)).toBe(bytes);
  });
  it('rejects logical case-variant duplicate heads', () => {
    const original = candidate(true),
      body = reseal({
        ...original,
        basis: {
          ...original.basis,
          planHeads: [
            ...original.basis.planHeads,
            {
              domain: 'nutrition',
              aggregateId: planId.toUpperCase(),
              head: { kind: 'exists', versionId },
            },
          ],
        },
      });
    expect(classify(body, [row()])).toEqual({
      kind: 'unsupported',
      reason: 'duplicate_source_head',
    });
  });
  it('rejects non-race UUID identifiers even when the old relative anchor wire accepts text', () => {
    const original = candidate(true, true);
    const body = reseal({
      ...original,
      writes: original.writes.map((write) =>
        write.domain === 'nutrition'
          ? {
              ...write,
              proposed: {
                ...write.proposed,
                items: write.proposed.items.map((item) => ({
                  ...item,
                  anchor: {
                    kind: 'relative',
                    entity: 'race',
                    entityId: 'intake-entry-1',
                    point: 'start',
                    offsetMinutes: 0,
                  },
                })),
              },
            }
          : write,
      ),
    });
    expect(classify(body, [row()])).toEqual({ kind: 'unsupported', reason: 'invalid_source_ref' });
  });
  it('rejects empty tenant identity and a source body whose version differs from the SQL tuple', () => {
    const body = candidate(true),
      value = row(),
      foreign = id(100);
    expect(
      inspectIntegratedNutritionCopiedSources({
        identity: { ...identity(body), athleteId: '' },
        body,
      }),
    ).toEqual({ kind: 'unsupported', reason: 'invalid_identity' });
    expect(
      classify(body, [
        {
          ...value,
          record_json: {
            ...value.record_json,
            versionId: foreign,
            items: value.record_json.items.map((item) => ({ ...item, planVersionId: foreign })),
          },
        },
      ]),
    ).toEqual({ kind: 'unsupported', reason: 'source_tuple_mismatch' });
  });
  it('requires actual finite producer dependencies and tenant namespace', () => {
    for (const deps of [
      [],
      candidate().basis.contextDependencies.map((dep) => ({ ...dep, id: 'foreign' })),
      candidate().basis.contextDependencies.map((dep, i) =>
        i === 0 ? { ...dep, kind: 'race-event' } : dep,
      ),
    ]) {
      const original = candidate(),
        body = reseal({ ...original, basis: { ...original.basis, contextDependencies: deps } });
      expect(classify(body)).toEqual({ kind: 'unsupported', reason: 'unsupported_dependencies' });
    }
  });
  it('rejects payload changes even when identity and digest columns agree', () => {
    const body = { ...candidate(), summary: 'Altered copied payload' };
    expect(classify(body)).toEqual({ kind: 'unsupported', reason: 'payload_digest_mismatch' });
  });
  it('rejects unknown keys, unsupported versions and NULL legacy body', () => {
    const body = candidate();
    for (const altered of [{ ...body, unknown: raceId }, { ...body, schemaVersion: 5 }, null])
      expect(
        inspectIntegratedNutritionCopiedSources({ identity: identity(body), body: altered }),
      ).toEqual({ kind: 'unsupported', reason: 'invalid_body' });
  });
  it('rejects original identity tuple/microsecond mismatch but accepts timezone-equivalent instant', () => {
    const body = candidate();
    expect(
      inspectIntegratedNutritionCopiedSources({
        identity: { ...identity(body), createdAt: '2026-10-07T00:00:00.123457Z' },
        body,
      }),
    ).toEqual({ kind: 'unsupported', reason: 'identity_mismatch' });
    expect(
      inspectIntegratedNutritionCopiedSources({
        identity: { ...identity(body), createdAt: '2026-10-07T09:00:00.123456+09:00' },
        body,
      }).kind,
    ).toBe('supported');
  });
  it('checks exact recovery nutrition planRef against the same frozen head manifest', () => {
    const original = candidate(true);
    const draft = recoveryStrategyDraftSchema.parse({
      title: 'Rest',
      goal: '',
      startDate: '2026-10-07',
      endDateExclusive: '2026-10-08',
      timezone: 'UTC',
      knownFacts: [],
      missingInformation: [],
      priority: 'normal',
      observations: [],
      planRefs: [{ kind: 'nutrition', aggregateId: planId, headVersionId: versionId }],
      options: [
        { id: id(50), title: 'Rest', kind: 'full_rest', methodVersionId: null, explanation: '' },
      ],
      reassessment: [
        {
          id: id(51),
          trigger: 'plan_changed',
          plannedAt: null,
          description: 'Review changes',
          policyVersion: null,
        },
      ],
    });
    const body = reseal({
      ...original,
      basis: {
        ...original.basis,
        planHeads: [
          ...original.basis.planHeads,
          { domain: 'recovery', aggregateId: id(52), head: { kind: 'absent' } },
        ],
      },
      writes: [
        ...original.writes,
        { domain: 'recovery', aggregateId: id(52), proposed: draft, selectedOptionId: id(50) },
      ],
    });
    expect(classify(body, [row()]).kind).toBe('related');
    const wrong = reseal({
      ...body,
      writes: body.writes.map((write) =>
        write.domain === 'recovery'
          ? {
              ...write,
              proposed: {
                ...write.proposed,
                planRefs: [{ kind: 'nutrition', aggregateId: planId, headVersionId: id(100) }],
              },
            }
          : write,
      ),
    });
    expect(classify(wrong, [row()])).toEqual({
      kind: 'unsupported',
      reason: 'source_tuple_mismatch',
    });
  });
  it('indexes exact routine nutrition item tuples, deduplicates case aliases and preserves original digest/body', () => {
    const body = routineCandidate([
        { planId, versionId, itemId: 'Meal' },
        { planId: planId.toUpperCase(), versionId: versionId.toUpperCase(), itemId: 'Meal' },
      ]),
      bytes = JSON.stringify(body);
    expect(classify(body, [row()])).toMatchObject({
      kind: 'related',
      manifest: {
        nutritionItemRefs: [{ planId, versionId, itemId: 'Meal' }],
        nutritionVersions: [{ namespace: 'nutrition-plan-version', planId, versionId }],
        races: [],
      },
    });
    expect(JSON.stringify(body)).toBe(bytes);
    expect(body.digest).toBe(integratedCandidatePayloadDigest(body));
  });
  it.each(['plan', 'version', 'invalid'])(
    'rejects routine %s tuple outside the exact nutrition basis',
    (kind) => {
      const body = routineCandidate([
        {
          planId: kind === 'plan' ? id(100) : kind === 'invalid' ? 'not-a-uuid' : planId,
          versionId: kind === 'version' ? id(100) : versionId,
          itemId: 'Meal',
        },
      ]);
      expect(classify(body, [row()])).toEqual({
        kind: 'unsupported',
        reason: kind === 'invalid' ? 'invalid_source_ref' : 'source_tuple_mismatch',
      });
    },
  );
  it('requires frozen item membership and rejects a populated foreign frozen row', () => {
    const body = routineCandidate([{ planId, versionId, itemId: 'missing' }]);
    expect(classify(body, [row()])).toEqual({ kind: 'unsupported', reason: 'source_unavailable' });
    expect(
      classify(routineCandidate([{ planId, versionId, itemId: 'Meal' }]), [
        { ...row(), athlete_id: id(100) },
      ]),
    ).toEqual({ kind: 'unsupported', reason: 'source_tuple_mismatch' });
  });
  it('preserves long multibyte/escaped item IDs without confusing the same UUID item namespace', () => {
    const itemId = '食事:"\\'.repeat(80) + planId,
      value = row();
    const body = routineCandidate([
      { planId, versionId, itemId },
      { planId, versionId, itemId: planId },
    ]);
    const result = classify(body, [
      {
        ...value,
        record_json: {
          ...value.record_json,
          items: [
            { ...value.record_json.items[0], id: itemId },
            { ...value.record_json.items[0], id: planId },
          ],
        },
      },
    ]);
    expect(result).toMatchObject({ kind: 'related' });
    if (result.kind === 'related')
      expect(result.manifest.nutritionItemRefs.map((ref) => ref.itemId)).toEqual([planId, itemId]);
  });
  it('counts visited duplicate routine refs before deduplication', () => {
    const body = routineCandidate(
      Array.from({ length: 5001 }, () => ({ planId, versionId, itemId: 'Meal' })),
    );
    expect(classify(body, [row()])).toEqual({ kind: 'unsupported', reason: 'source_limit' });
  });
  it('preserves strict minimal approval facts while rejecting copied-pin extras and duplicate refs', () => {
    const body = {
        schemaVersion: 4,
        approvalId: id(60),
        candidateId: id(8),
        versions: [{ domain: 'nutrition', aggregateId: planId, versionId }],
        occurrenceIds: [],
        approvedAt: '2026-10-07T00:00:00Z',
      },
      meta = {
        approvalId: body.approvalId,
        candidateId: body.candidateId,
        approvedAt: body.approvedAt,
      };
    expect(classifyIntegratedApprovalNutritionCopies({ identity: meta, body })).toEqual({
      kind: 'known_unrelated',
    });
    expect(
      classifyIntegratedApprovalNutritionCopies({
        identity: meta,
        body: { ...body, raceTimingPins: [] },
      }).kind,
    ).toBe('unsupported');
    expect(
      classifyIntegratedApprovalNutritionCopies({
        identity: meta,
        body: { ...body, versions: [...body.versions, ...body.versions] },
      }).kind,
    ).toBe('unsupported');
  });
});
