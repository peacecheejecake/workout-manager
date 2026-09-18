import { describe, expect, it } from 'vitest';

import type { JointCoachingBasis } from '@workout/contracts/nutrition';
import type { JointNutritionPlanDraftV3 } from '@workout/contracts/joint-coaching';
import type { NutritionPlanVersion } from '@workout/contracts/nutrition-core';
import type { PlanSnapshot } from '@workout/contracts/planning';
import type { SessionCompletion } from '@workout/contracts/session-completion';
import {
  compareJointCandidateFreshnessV3,
  derivePartialJointCandidateV3,
  digestJointCandidateV3,
  projectJointCandidateV3,
  sealJointCandidateV3,
} from '../src/joint-candidates.js';

const trainingVersionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const nutritionPlanId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const nutritionVersionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const itemId = 'fuel-before-run';
const absentPlanId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const snapshotId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const historicalTrainingVersionId = '99999999-9999-4999-8999-999999999999';

function trainingPlan(): PlanSnapshot {
  return {
    id: trainingVersionId,
    version: 1,
    createdAt: '2026-09-18T00:00:00Z',
    draft: {
      title: 'Synthetic training',
      timezone: 'UTC',
      periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, all) => ({
        id: level,
        parentId: index ? (all[index - 1] ?? null) : null,
        level,
        title: level,
        startDate: '2026-09-18',
        endDateExclusive: '2026-10-01',
        timezone: 'UTC',
        intent: 'Preserve intent',
        isPartial: false,
      })),
      sessions: [
        {
          id: 'session-1',
          blockId: 'block',
          date: '2026-09-20',
          localStartTime: '06:00',
          title: 'Long run',
          sport: 'running',
          durationSeconds: 3600,
          distanceMeters: 10000,
          targetRpe: null,
          purpose: 'Endurance',
          notes: '',
          priority: 'normal',
          locks: { date: false, time: false, intensity: false },
          steps: [],
        },
      ],
    },
  };
}

function completedSession(plan: PlanSnapshot, sessionId = 'session-1'): SessionCompletion {
  const session = plan.draft.sessions.find((entry) => entry.id === sessionId);
  if (!session) throw new Error('Missing fixture session');
  return {
    sessionId,
    revision: 1,
    planVersionId: historicalTrainingVersionId,
    schedule: {
      blockId: session.blockId,
      date: session.date,
      localStartTime: session.localStartTime,
      timezone: plan.draft.timezone,
    },
    status: 'completed',
    reportedAt: '2026-09-21T01:00:00Z',
    reason: null,
    source: 'user',
    method: 'self_report',
    definitionVersion: 'session-completion-v1',
  };
}

function nutritionPlan(): NutritionPlanVersion {
  return {
    planId: nutritionPlanId,
    versionId: nutritionVersionId,
    version: 1,
    previousVersionId: null,
    approvedAt: '2026-09-18T00:00:00Z',
    approvalId: '11111111-1111-4111-8111-111111111111',
    period: { from: '2026-09-18', toInclusive: '2026-09-30' },
    timezone: 'UTC',
    purpose: 'Long-run fueling',
    linkedTrainingPlanVersionId: trainingVersionId,
    items: [
      {
        id: itemId,
        planVersionId: nutritionVersionId,
        title: 'Before run',
        category: 'before',
        anchor: {
          kind: 'relative',
          entity: 'session',
          entityId: 'session-1',
          point: 'start',
          offsetMinutes: -30,
        },
        foods: [],
        targets: [],
        instructions: 'Prepare meal',
        evidenceIds: [],
        source: 'user_confirmed',
      },
    ],
  };
}

function nutritionDraft(plan: NutritionPlanVersion): JointNutritionPlanDraftV3 {
  return {
    period: plan.period,
    timezone: plan.timezone,
    purpose: plan.purpose,
    linkedTrainingPlanVersionId: plan.linkedTrainingPlanVersionId,
    items: plan.items.map(({ planVersionId: _planVersionId, ...item }) => item),
  };
}

function basis(scope: 'training' | 'nutrition' | 'combined' = 'combined'): JointCoachingBasis {
  const training = {
    planVersionId: trainingVersionId,
    activityDataRevision: 2,
    exerciseCatalogRevision: 3,
  };
  const nutrition = {
    planVersionId: nutritionVersionId,
    intakeDataRevision: 4,
    foodCatalogRevision: 5,
  };
  return {
    schemaVersion: 3,
    domains:
      scope === 'training'
        ? { scope, training, nutrition: null }
        : scope === 'nutrition'
          ? { scope, training: null, nutrition }
          : { scope, training, nutrition },
    contextDependencies: [
      { kind: 'dietary-constraint', id: 'constraint-1', revision: '7' },
      { kind: 'supplementary-set', id: 'set-1', revision: '3' },
    ],
    preferenceRevision: 6,
    constraintRevision: 7,
    conversationRevision: 8,
    policyVersion: 'policy-v1',
    evidenceSnapshotId: snapshotId,
  };
}

function projectionInput() {
  const before = trainingPlan();
  const proposed = structuredClone(before.draft);
  proposed.title = 'Adjusted training';
  const session = proposed.sessions[0];
  if (!session) throw new Error('Missing fixture session');
  session.date = '2026-09-21';
  const nutrition = nutritionPlan();
  return {
    basis: basis(),
    writes: {
      scope: 'combined' as const,
      training: { before, proposed, beforeSupplementaryLinks: [], supplementaryLinks: [] },
      nutrition: [
        { planId: nutritionPlanId, before: nutrition, proposed: nutritionDraft(nutrition) },
      ],
    },
    nutritionContexts: [
      { head: { planId: nutritionPlanId, versionId: nutritionVersionId }, version: nutrition },
      { head: { planId: absentPlanId, versionId: null }, version: null },
    ],
    asOfLocalDate: '2026-09-18',
    completions: [],
  };
}

function projected(input: unknown) {
  const result = projectJointCandidateV3(input);
  if (!result.ok) throw new Error(result.reason);
  return result.draft;
}

const identity = {
  id: '22222222-2222-4222-8222-222222222222',
  proposalId: '33333333-3333-4333-8333-333333333333',
  decisionId: '44444444-4444-4444-8444-444444444444',
  parentCandidateId: null,
  createdAt: '2026-09-18T01:00:00Z',
};

describe('M1b-03 V022-A30–A32 joint candidate projection', () => {
  it('pins existing and absent nutrition heads, and previews relative impact without actuals', () => {
    const draft = projected(projectionInput());
    expect(draft.nutritionPlanHeads).toEqual([
      { planId: nutritionPlanId, versionId: nutritionVersionId },
      { planId: absentPlanId, versionId: null },
    ]);
    expect(draft.diff.relativeImpacts).toEqual([
      {
        planId: nutritionPlanId,
        itemId,
        sessionId: 'session-1',
        point: 'start',
        resolution: 'requires_reprojection',
      },
    ]);
    expect(draft.diff.nutrition[0]?.itemIds).toEqual([]);
    expect(draft.validation).toMatchObject({ status: 'checked', errors: [], unknowns: [] });
    expect(JSON.stringify(draft)).not.toContain('intakeEntry');
    expect(JSON.stringify(draft)).not.toContain('setLog');
  });

  it('rejects an absent or mismatched per-plan head and a mismatched domain scope', () => {
    const input = projectionInput();
    expect(
      projectJointCandidateV3({ ...input, nutritionContexts: input.nutritionContexts.slice(1) }),
    ).toEqual({ ok: false, reason: 'NUTRITION_HEAD_MISMATCH' });
    expect(
      projectJointCandidateV3({
        ...input,
        nutritionContexts: input.nutritionContexts.map((context) =>
          context.head.planId === nutritionPlanId
            ? { ...context, head: { ...context.head, versionId: null } }
            : context,
        ),
      }),
    ).toEqual({ ok: false, reason: 'INVALID_INPUT' });
    expect(projectJointCandidateV3({ ...input, basis: basis('training') })).toEqual({
      ok: false,
      reason: 'SCOPE_MISMATCH',
    });
  });

  it('marks training-only moves as invalid when a relative nutrition item depends on the session', () => {
    const input = projectionInput();
    const draft = projected({
      ...input,
      basis: basis('training'),
      writes: { scope: 'training', training: input.writes.training, nutrition: null },
    });
    expect(draft.validation.errors).toContainEqual({
      code: 'RELATIVE_NUTRITION_REQUIRES_COMBINED',
      subject: { kind: 'nutrition_item', id: itemId },
    });
  });

  it('accepts a historical completion when a different current session changes, but still freezes its schedule', () => {
    const input = projectionInput();
    const before = structuredClone(input.writes.training.before);
    const first = before.draft.sessions[0];
    if (!first) throw new Error('Missing fixture session');
    before.draft.sessions.push({
      ...first,
      id: 'session-2',
      date: '2026-09-25',
      localStartTime: '09:00',
    });
    const proposed = structuredClone(before.draft);
    const second = proposed.sessions[1];
    if (!second) throw new Error('Missing second fixture session');
    second.date = '2026-09-26';
    const writes = {
      scope: 'training' as const,
      training: { before, proposed, beforeSupplementaryLinks: [], supplementaryLinks: [] },
      nutrition: null,
    };
    const candidateInput = {
      ...input,
      basis: basis('training'),
      writes,
      asOfLocalDate: '2026-09-22',
      completions: [completedSession(before)],
    };
    const draft = projected(candidateInput);
    expect(draft.diff.training?.sessionIds).toEqual(['session-2']);
    expect(draft.validation).toMatchObject({ status: 'checked', errors: [] });

    const changedCompletedSession = structuredClone(proposed);
    const completed = changedCompletedSession.sessions[0];
    if (!completed) throw new Error('Missing completed fixture session');
    completed.date = '2026-09-23';
    expect(
      projected({
        ...candidateInput,
        writes: {
          ...writes,
          training: { ...writes.training, proposed: changedCompletedSession },
        },
      }).validation.errors,
    ).toContainEqual({
      code: 'COMPLETED_SESSION_CHANGED',
      subject: { kind: 'session', id: first.id },
    });
  });

  it('does not make nutrition-only candidates depend on the training completion history', () => {
    const input = projectionInput();
    const nutrition = nutritionPlan();
    const proposed = nutritionDraft(nutrition);
    proposed.purpose = 'Adjusted fueling';
    const draft = projected({
      ...input,
      basis: basis('nutrition'),
      writes: {
        scope: 'nutrition',
        training: null,
        nutrition: [{ planId: nutritionPlanId, before: nutrition, proposed }],
      },
      asOfLocalDate: '2026-09-22',
      completions: [completedSession(input.writes.training.before)],
    });
    expect(draft.diff.training).toBeNull();
    expect(draft.validation).toMatchObject({ status: 'checked', errors: [] });
  });

  it('rejects changing frozen supplementary content on a completed session', () => {
    const input = projectionInput();
    const before = structuredClone(input.writes.training.before);
    const first = before.draft.sessions[0];
    if (!first) throw new Error('Missing fixture session');
    first.sport = 'strength';
    const originalLink = {
      schemaVersion: 2 as const,
      plannedSessionId: first.id,
      content: {
        kind: 'routine_version' as const,
        routineVersionId: '11111111-1111-4111-8111-111111111111',
      },
    };
    const proposed = structuredClone(before.draft);
    const draft = projected({
      ...input,
      basis: basis('training'),
      writes: {
        scope: 'training',
        training: {
          before,
          proposed,
          beforeSupplementaryLinks: [originalLink],
          supplementaryLinks: [
            {
              ...originalLink,
              content: {
                kind: 'routine_version',
                routineVersionId: '22222222-2222-4222-8222-222222222222',
              },
            },
          ],
        },
        nutrition: null,
      },
      completions: [completedSession(before)],
    });
    expect(draft.validation.errors).toContainEqual({
      code: 'COMPLETED_SESSION_CHANGED',
      subject: { kind: 'session', id: first.id },
    });
  });

  it('detects stale intake, set, dietary constraint and absent-to-present plan heads', () => {
    const parent = sealJointCandidateV3(projected(projectionInput()), identity);
    const current = { basis: basis(), nutritionPlanHeads: parent.nutritionPlanHeads };
    expect(compareJointCandidateFreshnessV3(parent, current)).toEqual({
      status: 'fresh',
      changed: [],
    });
    const changedBasis = basis();
    if (changedBasis.domains.nutrition) changedBasis.domains.nutrition.intakeDataRevision += 1;
    changedBasis.contextDependencies = [
      { kind: 'dietary-constraint', id: 'constraint-1', revision: '8' },
      { kind: 'supplementary-set', id: 'set-1', revision: '4' },
    ];
    const changedHeads = parent.nutritionPlanHeads.map((head) =>
      head.planId === absentPlanId
        ? { ...head, versionId: '77777777-7777-4777-8777-777777777777' }
        : head,
    );
    expect(
      compareJointCandidateFreshnessV3(parent, {
        basis: changedBasis,
        nutritionPlanHeads: changedHeads,
      }),
    ).toEqual({
      status: 'stale',
      changed: ['domains.nutrition', 'contextDependencies', `nutritionPlanHeads.${absentPlanId}`],
    });
  });

  it('pins the digest to candidate identity and makes a separately reviewed training-only partial', () => {
    const parent = sealJointCandidateV3(projected(projectionInput()), identity);
    const input = projectionInput();
    const result = derivePartialJointCandidateV3({
      parent,
      selection: {
        includeTrainingTitle: true,
        trainingPeriodIds: [],
        trainingSessionIds: [],
        nutritionPlanIds: [],
      },
      fresh: {
        parentBasis: input.basis,
        selectedBasis: basis('training'),
        nutritionContexts: input.nutritionContexts,
        completions: [],
        asOfLocalDate: input.asOfLocalDate,
      },
      identity: {
        ...identity,
        id: '55555555-5555-4555-8555-555555555555',
        proposalId: '66666666-6666-4666-8666-666666666666',
        parentCandidateId: parent.id,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.writes.scope).toBe('training');
    expect(result.candidate.writes.training?.proposed.sessions[0]?.date).toBe('2026-09-20');
    expect(result.candidate.id).not.toBe(parent.id);
    expect(result.candidate.digest).not.toBe(parent.digest);
    expect(result.candidate.parentCandidateId).toBe(parent.id);
    expect(result.candidate.validation.status).toBe('checked');
  });

  it('refuses a silent partial session move, stale basis, and tampered parent digest', () => {
    const parent = sealJointCandidateV3(projected(projectionInput()), identity);
    const input = projectionInput();
    const common = {
      parent,
      selection: {
        includeTrainingTitle: false,
        trainingPeriodIds: [],
        trainingSessionIds: ['session-1'],
        nutritionPlanIds: [],
      },
      fresh: {
        parentBasis: input.basis,
        selectedBasis: basis('training'),
        nutritionContexts: input.nutritionContexts,
        completions: [],
        asOfLocalDate: input.asOfLocalDate,
      },
      identity: {
        ...identity,
        id: '55555555-5555-4555-8555-555555555555',
        proposalId: '66666666-6666-4666-8666-666666666666',
        parentCandidateId: parent.id,
      },
    };
    expect(derivePartialJointCandidateV3(common)).toEqual({
      ok: false,
      reason: 'INVALID_PARTIAL_PROJECTION',
    });
    expect(
      derivePartialJointCandidateV3({
        ...common,
        fresh: {
          ...common.fresh,
          parentBasis: { ...input.basis, constraintRevision: 8 },
        },
      }),
    ).toEqual({ ok: false, reason: 'STALE_PARENT_BASIS' });
    const tampered = structuredClone(parent);
    if (tampered.writes.training) tampered.writes.training.proposed.title = 'Tampered';
    expect(derivePartialJointCandidateV3({ ...common, parent: tampered })).toEqual({
      ok: false,
      reason: 'PARENT_DIGEST_MISMATCH',
    });
    expect(digestJointCandidateV3(projected(input), identity)).toBe(parent.digest);
  });
});
