import { createHash } from 'node:crypto';
import { z } from 'zod';

import {
  jointCandidateDraftV3Schema,
  jointCandidatePartialSelectionV3Schema,
  jointCandidateProjectionInputV3Schema,
  jointCandidateV3Schema,
  jointNutritionPlanHeadV3Schema,
  type JointCandidateDiffV3,
  type JointCandidateDraftV3,
  type JointCandidateIssueV3,
  type JointCandidateProjectionInputV3,
  type JointCandidateV3,
  type JointCandidateWritesV3,
} from '@workout/contracts/joint-coaching';
import { jointCoachingBasisSchema } from '@workout/contracts/nutrition';
import { preservesSessionLocks, type PlanDraft } from '@workout/contracts/planning';
import { preservesSessionCompletions } from '@workout/contracts/session-completion';

const compare = (left: string, right: string) => (left === right ? 0 : left < right ? -1 : 1);

/** Stable object keys and explicit nulls are part of the digest; undefined is never accepted. */
function canonicalJson(value: unknown): string {
  if (value === undefined) throw new TypeError('Undefined cannot be digested');
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('Unserializable candidate value');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value).sort(([a], [b]) => compare(a, b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const withoutDomains = (basis: JointCandidateDraftV3['basis']) => {
  const { domains: _domains, ...rest } = basis;
  return rest;
};

function changedIds(before: readonly { id: string }[], after: readonly { id: string }[]): string[] {
  const old = new Map(before.map((entry) => [entry.id, entry]));
  const next = new Map(after.map((entry) => [entry.id, entry]));
  return [...new Set([...old.keys(), ...next.keys()])]
    .filter((id) => !same(old.get(id) ?? null, next.get(id) ?? null))
    .sort(compare);
}

function trainingDiff(writes: JointCandidateWritesV3): JointCandidateDiffV3['training'] {
  if (writes.training === null) return null;
  const { before, proposed, beforeSupplementaryLinks, supplementaryLinks } = writes.training;
  const oldLinks = new Map(beforeSupplementaryLinks.map((link) => [link.plannedSessionId, link]));
  const newLinks = new Map(supplementaryLinks.map((link) => [link.plannedSessionId, link]));
  const linkIds = [...new Set([...oldLinks.keys(), ...newLinks.keys()])].filter(
    (id) => !same(oldLinks.get(id) ?? null, newLinks.get(id) ?? null),
  );
  return {
    titleChanged: before.draft.title !== proposed.title,
    periodIds: changedIds(before.draft.periods, proposed.periods),
    sessionIds: [
      ...new Set([...changedIds(before.draft.sessions, proposed.sessions), ...linkIds]),
    ].sort(compare),
  };
}

function nutritionDiff(writes: JointCandidateWritesV3): JointCandidateDiffV3['nutrition'] {
  if (writes.nutrition === null) return [];
  return writes.nutrition
    .map(({ planId, before, proposed }) => ({
      planId,
      itemIds: changedIds(
        before?.items.map(({ planVersionId: _planVersionId, ...item }) => item) ?? [],
        proposed.items,
      ),
      metadataChanged:
        before === null ||
        !same(
          {
            period: before.period,
            timezone: before.timezone,
            purpose: before.purpose,
            linkedTrainingPlanVersionId: before.linkedTrainingPlanVersionId,
          },
          {
            period: proposed.period,
            timezone: proposed.timezone,
            purpose: proposed.purpose,
            linkedTrainingPlanVersionId: proposed.linkedTrainingPlanVersionId,
          },
        ),
    }))
    .sort((a, b) => compare(a.planId, b.planId));
}

function relativeImpacts(
  input: JointCandidateProjectionInputV3,
): JointCandidateDiffV3['relativeImpacts'] {
  if (input.writes.training === null) return [];
  const { before, proposed } = input.writes.training;
  const previous = new Map(before.draft.sessions.map((session) => [session.id, session]));
  const next = new Map(proposed.sessions.map((session) => [session.id, session]));
  const impacts: JointCandidateDiffV3['relativeImpacts'] = [];
  for (const context of input.nutritionContexts) {
    for (const item of context.version?.items ?? []) {
      const anchor = item.anchor;
      if (anchor.kind !== 'relative' || anchor.entity !== 'session') continue;
      const old = previous.get(anchor.entityId);
      const after = next.get(anchor.entityId);
      if (!old && !after) continue;
      const startChanged =
        !old || !after || old.date !== after.date || old.localStartTime !== after.localStartTime;
      const endChanged =
        startChanged ||
        !same(old?.durationSeconds ?? null, after?.durationSeconds ?? null) ||
        !same(old?.durationRange ?? null, after?.durationRange ?? null);
      // The plan writer requires every relative item on a timing-changed session
      // to be reviewed, even when a start anchor's displayed time stays the same.
      if (!endChanged) continue;
      const unresolved =
        !after ||
        after.localStartTime === null ||
        (anchor.point === 'end' && after.durationSeconds === null && !after.durationRange);
      impacts.push({
        planId: context.head.planId,
        itemId: item.id,
        sessionId: anchor.entityId,
        point: anchor.point,
        resolution: unresolved ? 'unresolved' : 'requires_reprojection',
      });
    }
  }
  return impacts.sort(
    (a, b) =>
      compare(a.planId, b.planId) ||
      compare(a.itemId, b.itemId) ||
      compare(a.sessionId, b.sessionId),
  );
}

function relevantCompletions(input: JointCandidateProjectionInputV3) {
  const training = input.writes.training;
  if (training === null) return [];
  const currentSessionIds = new Set(training.before.draft.sessions.map((session) => session.id));
  return input.completions.filter((report) => currentSessionIds.has(report.sessionId));
}

function validate(
  input: JointCandidateProjectionInputV3,
  diff: JointCandidateDiffV3,
): JointCandidateDraftV3['validation'] {
  const errors: JointCandidateIssueV3[] = [];
  const warnings: JointCandidateIssueV3[] = [];
  const unknowns: JointCandidateIssueV3[] = [];
  const candidate = { kind: 'candidate' } as const;
  if (
    diff.training?.titleChanged !== true &&
    (diff.training?.periodIds.length ?? 0) === 0 &&
    (diff.training?.sessionIds.length ?? 0) === 0 &&
    diff.nutrition.every((change) => !change.metadataChanged && change.itemIds.length === 0) &&
    diff.relativeImpacts.length === 0
  )
    errors.push({ code: 'NO_CHANGE', subject: candidate });

  const training = input.writes.training;
  if (training !== null) {
    const { before, proposed } = training;
    if (before.draft.timezone !== proposed.timezone)
      errors.push({ code: 'TRAINING_TIMEZONE_CHANGED', subject: candidate });
    const oldSessions = new Map(before.draft.sessions.map((session) => [session.id, session]));
    const newSessions = new Map(proposed.sessions.map((session) => [session.id, session]));
    for (const id of diff.training?.sessionIds ?? []) {
      const old = oldSessions.get(id);
      const next = newSessions.get(id);
      const subject = { kind: 'session', id } as const;
      if ((old && old.date < input.asOfLocalDate) || (next && next.date < input.asOfLocalDate))
        errors.push({ code: 'PAST_SESSION_CHANGED', subject });
      if (
        old &&
        !preservesSessionLocks(
          { ...before.draft, sessions: [old] },
          { ...proposed, sessions: next ? [next] : [] },
        )
      )
        errors.push({ code: 'SESSION_LOCKED', subject });
    }
    for (const report of relevantCompletions(input)) {
      const previousLink = training.beforeSupplementaryLinks.find(
        (link) => link.plannedSessionId === report.sessionId,
      );
      const nextLink = training.supplementaryLinks.find(
        (link) => link.plannedSessionId === report.sessionId,
      );
      if (
        report.status === 'completed' &&
        (!preservesSessionCompletions(proposed, [report]) ||
          !same(previousLink ?? null, nextLink ?? null))
      )
        errors.push({
          code: 'COMPLETED_SESSION_CHANGED',
          subject: { kind: 'session', id: report.sessionId },
        });
    }
    const oldPeriods = new Map(before.draft.periods.map((period) => [period.id, period]));
    const nextPeriods = new Map(proposed.periods.map((period) => [period.id, period]));
    for (const id of diff.training?.periodIds ?? []) {
      const old = oldPeriods.get(id);
      const next = nextPeriods.get(id);
      if (
        (old && old.startDate < input.asOfLocalDate) ||
        (next && next.startDate < input.asOfLocalDate)
      )
        errors.push({ code: 'PAST_PERIOD_CHANGED', subject: candidate });
    }
  }

  for (const write of input.writes.nutrition ?? []) {
    const changed = diff.nutrition.find((entry) => entry.planId === write.planId);
    const oldItems = new Map(write.before?.items.map((item) => [item.id, item]) ?? []);
    const nextItems = new Map(write.proposed.items.map((item) => [item.id, item]));
    if (
      write.proposed.period.toInclusive < input.asOfLocalDate ||
      (changed?.itemIds ?? []).some((id) => {
        const old = oldItems.get(id);
        const next = nextItems.get(id);
        return [old?.anchor, next?.anchor].some(
          (anchor) => anchor?.kind === 'absolute' && anchor.date < input.asOfLocalDate,
        );
      })
    )
      errors.push({
        code: 'PAST_NUTRITION_PLAN_CHANGED',
        subject: { kind: 'nutrition_plan', id: write.planId },
      });
  }
  const selectedNutritionIds = new Set((input.writes.nutrition ?? []).map((write) => write.planId));
  for (const impact of diff.relativeImpacts) {
    if (!selectedNutritionIds.has(impact.planId))
      errors.push({
        code: 'RELATIVE_NUTRITION_REQUIRES_COMBINED',
        subject: { kind: 'nutrition_item', id: impact.itemId },
      });
    if (impact.resolution === 'unresolved')
      unknowns.push({
        code: 'RELATIVE_ANCHOR_UNRESOLVED',
        subject: { kind: 'nutrition_item', id: impact.itemId },
      });
  }
  return {
    definitionVersion: 'joint-candidate-validation-v3',
    status: errors.length ? 'invalid' : unknowns.length ? 'uncertain' : 'checked',
    errors,
    warnings,
    unknowns,
  };
}

export type JointCandidateProjectionResult =
  | { ok: true; draft: JointCandidateDraftV3 }
  | {
      ok: false;
      reason:
        | 'INVALID_INPUT'
        | 'SCOPE_MISMATCH'
        | 'PLAN_VERSION_MISMATCH'
        | 'NUTRITION_HEAD_MISMATCH'
        | 'INVALID_COMPLETION_BASIS'
        | 'PROJECTION_FAILED';
    };

/** Structural preview only. The persistence adapter must capture all relevant plan heads. */
export function projectJointCandidateV3(input: unknown): JointCandidateProjectionResult {
  const parsed = jointCandidateProjectionInputV3Schema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: 'INVALID_INPUT' };
  const value = parsed.data;
  if (value.basis.domains.scope !== value.writes.scope)
    return { ok: false, reason: 'SCOPE_MISMATCH' };
  if (
    value.writes.training !== null &&
    value.basis.domains.training?.planVersionId !== value.writes.training.before.id
  )
    return { ok: false, reason: 'PLAN_VERSION_MISMATCH' };
  const completions = relevantCompletions(value);
  if (new Set(completions.map((completion) => completion.sessionId)).size !== completions.length)
    return { ok: false, reason: 'INVALID_COMPLETION_BASIS' };
  const contexts = new Map(value.nutritionContexts.map((entry) => [entry.head.planId, entry]));
  if (contexts.size !== value.nutritionContexts.length)
    return { ok: false, reason: 'NUTRITION_HEAD_MISMATCH' };
  if (
    value.writes.nutrition?.some((write) => {
      const context = contexts.get(write.planId);
      return (
        !context ||
        context.head.versionId !== (write.before?.versionId ?? null) ||
        !same(context.version, write.before) ||
        (write.before !== null && write.before.planId !== write.planId)
      );
    }) ||
    (value.basis.domains.nutrition?.planVersionId !== null &&
      value.basis.domains.nutrition?.planVersionId !== undefined &&
      !value.nutritionContexts.some(
        (entry) => entry.head.versionId === value.basis.domains.nutrition?.planVersionId,
      ))
  )
    return { ok: false, reason: 'NUTRITION_HEAD_MISMATCH' };
  try {
    const diff: JointCandidateDiffV3 = {
      definitionVersion: 'joint-candidate-diff-v3',
      training: trainingDiff(value.writes),
      nutrition: nutritionDiff(value.writes),
      relativeImpacts: relativeImpacts(value),
    };
    const draft = jointCandidateDraftV3Schema.parse({
      schemaVersion: 3,
      kind: 'joint-adjustment',
      basis: value.basis,
      writes: value.writes,
      nutritionPlanHeads: value.nutritionContexts
        .map((entry) => entry.head)
        .sort((a, b) => compare(a.planId, b.planId)),
      asOfLocalDate: value.asOfLocalDate,
      diff,
      validation: validate(value, diff),
    });
    return { ok: true, draft };
  } catch {
    return { ok: false, reason: 'PROJECTION_FAILED' };
  }
}

export type JointCandidateIdentityV3 = Pick<
  JointCandidateV3,
  'id' | 'proposalId' | 'decisionId' | 'parentCandidateId' | 'createdAt'
>;

/** IDs and parent ancestry are covered by the digest; object insertion order is not. */
export function digestJointCandidateV3(
  draft: JointCandidateDraftV3,
  identity: JointCandidateIdentityV3,
): string {
  return createHash('sha256')
    .update(canonicalJson({ definitionVersion: 'joint-candidate-digest-v3', draft, identity }))
    .digest('hex');
}

export function sealJointCandidateV3(
  draft: JointCandidateDraftV3,
  identity: JointCandidateIdentityV3,
): JointCandidateV3 {
  const parsed = jointCandidateDraftV3Schema.parse(draft);
  return jointCandidateV3Schema.parse({
    ...parsed,
    ...identity,
    digest: digestJointCandidateV3(parsed, identity),
  });
}

const currentBasisSchema = z.strictObject({
  basis: jointCoachingBasisSchema,
  nutritionPlanHeads: z.array(jointNutritionPlanHeadV3Schema).max(100),
});

export type JointCandidateFreshnessV3 =
  | { status: 'fresh'; changed: [] }
  | { status: 'stale'; changed: string[] }
  | { status: 'unsupported'; reason: 'INVALID_INPUT' | 'CANDIDATE_DIGEST_MISMATCH' };

/** Read-only comparison; approval must recapture this observation inside its write transaction. */
export function compareJointCandidateFreshnessV3(
  candidateInput: unknown,
  currentInput: unknown,
): JointCandidateFreshnessV3 {
  const candidateResult = jointCandidateV3Schema.safeParse(candidateInput);
  const currentResult = currentBasisSchema.safeParse(currentInput);
  if (!candidateResult.success || !currentResult.success)
    return { status: 'unsupported', reason: 'INVALID_INPUT' };
  const candidate = candidateResult.data;
  const current = currentResult.data;
  const {
    id: _id,
    proposalId: _proposalId,
    decisionId: _decisionId,
    parentCandidateId: _parentCandidateId,
    createdAt: _createdAt,
    digest: _digest,
    ...draft
  } = candidate;
  if (
    digestJointCandidateV3(draft, {
      id: candidate.id,
      proposalId: candidate.proposalId,
      decisionId: candidate.decisionId,
      parentCandidateId: candidate.parentCandidateId,
      createdAt: candidate.createdAt,
    }) !== candidate.digest
  )
    return { status: 'unsupported', reason: 'CANDIDATE_DIGEST_MISMATCH' };
  const expected = candidate.basis;
  const observed = current.basis;
  const changed: string[] = [];
  if (!same(expected.domains, observed.domains)) {
    if (expected.domains.scope !== observed.domains.scope) changed.push('domains.scope');
    if (!same(expected.domains.training, observed.domains.training))
      changed.push('domains.training');
    if (!same(expected.domains.nutrition, observed.domains.nutrition))
      changed.push('domains.nutrition');
  }
  for (const field of [
    'preferenceRevision',
    'constraintRevision',
    'conversationRevision',
    'policyVersion',
    'evidenceSnapshotId',
  ] as const) {
    if (expected[field] !== observed[field]) changed.push(field);
  }
  const dependencies = (items: typeof expected.contextDependencies) =>
    [...items].sort(
      (a, b) => compare(a.kind, b.kind) || compare(a.id, b.id) || compare(a.revision, b.revision),
    );
  if (!same(dependencies(expected.contextDependencies), dependencies(observed.contextDependencies)))
    changed.push('contextDependencies');
  const beforeHeads = new Map(
    candidate.nutritionPlanHeads.map((head) => [head.planId, head.versionId]),
  );
  const afterHeads = new Map(
    current.nutritionPlanHeads.map((head) => [head.planId, head.versionId]),
  );
  if (
    beforeHeads.size !== candidate.nutritionPlanHeads.length ||
    afterHeads.size !== current.nutritionPlanHeads.length
  )
    return { status: 'unsupported', reason: 'INVALID_INPUT' };
  for (const planId of [...new Set([...beforeHeads.keys(), ...afterHeads.keys()])].sort(compare)) {
    if (
      !beforeHeads.has(planId) ||
      !afterHeads.has(planId) ||
      beforeHeads.get(planId) !== afterHeads.get(planId)
    )
      changed.push(`nutritionPlanHeads.${planId}`);
  }
  return changed.length ? { status: 'stale', changed } : { status: 'fresh', changed: [] };
}

function selectedTrainingPlan(
  before: PlanDraft,
  proposed: PlanDraft,
  selection: {
    includeTrainingTitle: boolean;
    trainingPeriodIds: string[];
    trainingSessionIds: string[];
  },
): PlanDraft {
  const periods = new Map(before.periods.map((period) => [period.id, period]));
  const nextPeriods = new Map(proposed.periods.map((period) => [period.id, period]));
  for (const id of selection.trainingPeriodIds) {
    const next = nextPeriods.get(id);
    if (next) periods.set(id, next);
    else periods.delete(id);
  }
  const sessions = new Map(before.sessions.map((session) => [session.id, session]));
  const nextSessions = new Map(proposed.sessions.map((session) => [session.id, session]));
  for (const id of selection.trainingSessionIds) {
    const next = nextSessions.get(id);
    if (next) sessions.set(id, next);
    else sessions.delete(id);
  }
  return {
    ...before,
    title: selection.includeTrainingTitle ? proposed.title : before.title,
    periods: [...periods.values()],
    sessions: [...sessions.values()],
  };
}

export type JointCandidatePartialResult =
  | { ok: true; candidate: JointCandidateV3 }
  | {
      ok: false;
      reason:
        | 'INVALID_INPUT'
        | 'PARENT_DIGEST_MISMATCH'
        | 'STALE_PARENT_BASIS'
        | 'STALE_PARENT_HEAD'
        | 'UNKNOWN_SELECTION'
        | 'INVALID_PARTIAL_PROJECTION';
    };

/** Partial approval creates a new candidate with a fresh scope and digest; it never mutates the parent. */
export function derivePartialJointCandidateV3(input: {
  parent: unknown;
  selection: unknown;
  fresh: {
    parentBasis: unknown;
    selectedBasis: unknown;
    nutritionContexts: unknown;
    completions: unknown;
    asOfLocalDate: unknown;
  };
  identity: JointCandidateIdentityV3;
}): JointCandidatePartialResult {
  const parentParsed = jointCandidateV3Schema.safeParse(input.parent);
  const selectionParsed = jointCandidatePartialSelectionV3Schema.safeParse(input.selection);
  const freshParentBasis = jointCoachingBasisSchema.safeParse(input.fresh.parentBasis);
  const freshSelectedBasis = jointCoachingBasisSchema.safeParse(input.fresh.selectedBasis);
  if (
    !parentParsed.success ||
    !selectionParsed.success ||
    !freshParentBasis.success ||
    !freshSelectedBasis.success
  )
    return { ok: false, reason: 'INVALID_INPUT' };
  const parent = parentParsed.data;
  const selection = selectionParsed.data;
  const {
    id: _id,
    proposalId: _proposalId,
    decisionId: _decisionId,
    parentCandidateId: _parentCandidateId,
    createdAt: _createdAt,
    digest: _digest,
    ...parentDraft
  } = parent;
  const parentIdentity = {
    id: parent.id,
    proposalId: parent.proposalId,
    decisionId: parent.decisionId,
    parentCandidateId: parent.parentCandidateId,
    createdAt: parent.createdAt,
  };
  if (digestJointCandidateV3(parentDraft, parentIdentity) !== parent.digest)
    return { ok: false, reason: 'PARENT_DIGEST_MISMATCH' };
  if (!same(parent.basis, freshParentBasis.data))
    return { ok: false, reason: 'STALE_PARENT_BASIS' };
  if (
    input.identity.id === parent.id ||
    input.identity.proposalId === parent.proposalId ||
    input.identity.parentCandidateId !== parent.id
  )
    return { ok: false, reason: 'INVALID_INPUT' };
  const selectedTraining =
    selection.includeTrainingTitle ||
    selection.trainingPeriodIds.length > 0 ||
    selection.trainingSessionIds.length > 0;
  const training = parent.writes.training;
  if (selectedTraining && training === null) return { ok: false, reason: 'UNKNOWN_SELECTION' };
  if (
    (selection.includeTrainingTitle && !parent.diff.training?.titleChanged) ||
    selection.trainingPeriodIds.some((id) => !parent.diff.training?.periodIds.includes(id)) ||
    selection.trainingSessionIds.some((id) => !parent.diff.training?.sessionIds.includes(id)) ||
    selection.nutritionPlanIds.some(
      (id) => !parent.writes.nutrition?.some((write) => write.planId === id),
    )
  )
    return { ok: false, reason: 'UNKNOWN_SELECTION' };
  const nutrition = (parent.writes.nutrition ?? []).filter((write) =>
    selection.nutritionPlanIds.includes(write.planId),
  );
  const scope = selectedTraining ? (nutrition.length ? 'combined' : 'training') : 'nutrition';
  const selectedBasis = freshSelectedBasis.data;
  if (
    selectedBasis.domains.scope !== scope ||
    !same(withoutDomains(parent.basis), withoutDomains(selectedBasis)) ||
    (selectedTraining && !same(selectedBasis.domains.training, parent.basis.domains.training)) ||
    (nutrition.length > 0 && !same(selectedBasis.domains.nutrition, parent.basis.domains.nutrition))
  )
    return { ok: false, reason: 'STALE_PARENT_BASIS' };
  const selectedTrainingWrite =
    training === null
      ? null
      : {
          before: training.before,
          proposed: selectedTrainingPlan(training.before.draft, training.proposed, selection),
          beforeSupplementaryLinks: training.beforeSupplementaryLinks,
          supplementaryLinks: [
            ...training.beforeSupplementaryLinks.filter(
              (link) => !selection.trainingSessionIds.includes(link.plannedSessionId),
            ),
            ...training.supplementaryLinks.filter((link) =>
              selection.trainingSessionIds.includes(link.plannedSessionId),
            ),
          ].sort((a, b) => compare(a.plannedSessionId, b.plannedSessionId)),
        };
  if (scope !== 'nutrition' && selectedTrainingWrite === null)
    return { ok: false, reason: 'UNKNOWN_SELECTION' };
  let writes: JointCandidateWritesV3;
  if (scope === 'nutrition') writes = { scope, training: null, nutrition };
  else if (selectedTrainingWrite === null) return { ok: false, reason: 'UNKNOWN_SELECTION' };
  else if (scope === 'training')
    writes = { scope, training: selectedTrainingWrite, nutrition: null };
  else writes = { scope, training: selectedTrainingWrite, nutrition };
  const projected = projectJointCandidateV3({
    basis: selectedBasis,
    writes,
    nutritionContexts: input.fresh.nutritionContexts,
    completions: input.fresh.completions,
    asOfLocalDate: input.fresh.asOfLocalDate,
  });
  if (!projected.ok) return { ok: false, reason: 'INVALID_PARTIAL_PROJECTION' };
  if (!same(projected.draft.nutritionPlanHeads, parent.nutritionPlanHeads))
    return { ok: false, reason: 'STALE_PARENT_HEAD' };
  if (projected.draft.validation.errors.length)
    return { ok: false, reason: 'INVALID_PARTIAL_PROJECTION' };
  try {
    return { ok: true, candidate: sealJointCandidateV3(projected.draft, input.identity) };
  } catch {
    return { ok: false, reason: 'INVALID_INPUT' };
  }
}
