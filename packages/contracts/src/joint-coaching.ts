import { z } from 'zod';

import { jointCoachingBasisSchema } from './nutrition.js';
import {
  nutritionPlanDraftSchema,
  nutritionPlanItemCoreSchema,
  nutritionPlanVersionSchema,
} from './nutrition-core.js';
import { planDraftSchema, planSnapshotSchema } from './planning.js';
import { idSchema, instantSchema, localDateSchema } from './primitives.js';
import { sessionCompletionSchema } from './session-completion.js';
import { supplementarySessionLinkSchema } from './supplementary-core.js';

const uuid = z.uuid().refine((value) => value === value.toLowerCase());
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const uniqueIds = (limit: number) =>
  z
    .array(z.string().trim().min(1).max(200))
    .max(limit)
    .refine((ids) => new Set(ids).size === ids.length, 'IDs must be unique');

/** Every relevant aggregate head is pinned, including a plan that does not exist yet. */
export const jointNutritionPlanHeadV3Schema = z.strictObject({
  planId: uuid,
  versionId: uuid.nullable(),
});
export type JointNutritionPlanHeadV3 = z.infer<typeof jointNutritionPlanHeadV3Schema>;

export const jointNutritionPlanContextV3Schema = z
  .strictObject({
    head: jointNutritionPlanHeadV3Schema,
    version: nutritionPlanVersionSchema.nullable(),
  })
  .refine(
    ({ head, version }) =>
      version === null
        ? head.versionId === null
        : head.planId === version.planId && head.versionId === version.versionId,
    'Context version must match the pinned aggregate head',
  );
export type JointNutritionPlanContextV3 = z.infer<typeof jointNutritionPlanContextV3Schema>;

const { planVersionId: _planVersionId, ...proposedItemFields } = nutritionPlanItemCoreSchema.shape;
void _planVersionId;
const jointNutritionPlanItemV3Schema = z
  .strictObject(proposedItemFields)
  .superRefine((item, ctx) => {
    if (new Set(item.targets.map((target) => target.metric)).size !== item.targets.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate nutrient target', path: ['targets'] });
    if (item.foods.length === 0 && item.targets.length === 0 && item.instructions.trim() === '')
      ctx.addIssue({
        code: 'custom',
        message: 'A plan item needs content',
        path: ['instructions'],
      });
  });

/** Proposal provenance may be suggested or reviewed; it is never an actual IntakeEntry. */
export const jointNutritionPlanDraftV3Schema = z
  .strictObject({
    ...nutritionPlanDraftSchema.shape,
    items: z.array(jointNutritionPlanItemV3Schema).max(5_000),
  })
  .superRefine((draft, ctx) => {
    if (new Set(draft.items.map((item) => item.id)).size !== draft.items.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate nutrition item ID', path: ['items'] });
    if (new TextEncoder().encode(JSON.stringify(draft)).length > 512 * 1024)
      ctx.addIssue({ code: 'custom', message: 'Plan exceeds 512 KiB' });
  });
export type JointNutritionPlanDraftV3 = z.infer<typeof jointNutritionPlanDraftV3Schema>;

const nutritionWrite = z.strictObject({
  planId: uuid,
  before: nutritionPlanVersionSchema.nullable(),
  proposed: jointNutritionPlanDraftV3Schema,
});
export const jointSupplementaryLinkV3Schema = z.strictObject({
  schemaVersion: supplementarySessionLinkSchema.shape.schemaVersion,
  plannedSessionId: supplementarySessionLinkSchema.shape.plannedSessionId,
  content: supplementarySessionLinkSchema.shape.content,
});
export type JointSupplementaryLinkV3 = z.infer<typeof jointSupplementaryLinkV3Schema>;
const supplementaryLinksSchema = z
  .array(jointSupplementaryLinkV3Schema)
  .max(1_000)
  .refine((links) => new Set(links.map((link) => link.plannedSessionId)).size === links.length);
const trainingWrite = z
  .strictObject({
    before: planSnapshotSchema,
    proposed: planDraftSchema,
    /** Full frozen link set on the existing head, captured by the server. */
    beforeSupplementaryLinks: supplementaryLinksSchema,
    /** Full frozen link set for the proposed plan version. */
    supplementaryLinks: supplementaryLinksSchema,
  })
  .superRefine((write, ctx) => {
    for (const [index, link] of write.beforeSupplementaryLinks.entries()) {
      if (
        !write.before.draft.sessions.some(
          (session) => session.id === link.plannedSessionId && session.sport === 'strength',
        )
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Existing link requires a strength session',
          path: ['beforeSupplementaryLinks', index],
        });
    }
    for (const [index, link] of write.supplementaryLinks.entries()) {
      if (
        !write.proposed.sessions.some(
          (session) => session.id === link.plannedSessionId && session.sport === 'strength',
        )
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Proposed link requires a strength session',
          path: ['supplementaryLinks', index],
        });
    }
  });
export const jointCandidateWritesV3Schema = z.discriminatedUnion('scope', [
  z.strictObject({ scope: z.literal('training'), training: trainingWrite, nutrition: z.null() }),
  z.strictObject({
    scope: z.literal('nutrition'),
    training: z.null(),
    nutrition: z.array(nutritionWrite).min(1).max(100),
  }),
  z.strictObject({
    scope: z.literal('combined'),
    training: trainingWrite,
    nutrition: z.array(nutritionWrite).min(1).max(100),
  }),
]);
export type JointCandidateWritesV3 = z.infer<typeof jointCandidateWritesV3Schema>;

export const jointCandidateIssueV3Schema = z.strictObject({
  code: z.enum([
    'NO_CHANGE',
    'TRAINING_TIMEZONE_CHANGED',
    'PAST_SESSION_CHANGED',
    'SESSION_LOCKED',
    'COMPLETED_SESSION_CHANGED',
    'PAST_PERIOD_CHANGED',
    'PAST_NUTRITION_PLAN_CHANGED',
    'RELATIVE_NUTRITION_REQUIRES_COMBINED',
    'RELATIVE_ANCHOR_UNRESOLVED',
  ]),
  subject: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('candidate') }),
    z.strictObject({ kind: z.literal('session'), id: z.string().min(1).max(200) }),
    z.strictObject({ kind: z.literal('nutrition_plan'), id: uuid }),
    z.strictObject({ kind: z.literal('nutrition_item'), id: idSchema }),
  ]),
});
export type JointCandidateIssueV3 = z.infer<typeof jointCandidateIssueV3Schema>;

export const jointCandidateValidationV3Schema = z
  .strictObject({
    definitionVersion: z.literal('joint-candidate-validation-v3'),
    status: z.enum(['checked', 'uncertain', 'invalid']),
    errors: z.array(jointCandidateIssueV3Schema).max(10_000),
    warnings: z.array(jointCandidateIssueV3Schema).max(10_000),
    unknowns: z.array(jointCandidateIssueV3Schema).max(10_000),
  })
  .refine(
    ({ status, errors, unknowns }) =>
      status === (errors.length ? 'invalid' : unknowns.length ? 'uncertain' : 'checked'),
    'Validation status must agree with issues',
  );

const changedIds = uniqueIds(5_000);
export const jointCandidateDiffV3Schema = z.strictObject({
  definitionVersion: z.literal('joint-candidate-diff-v3'),
  training: z
    .strictObject({
      titleChanged: z.boolean(),
      periodIds: uniqueIds(200),
      sessionIds: uniqueIds(2_000),
    })
    .nullable(),
  nutrition: z
    .array(
      z.strictObject({
        planId: uuid,
        itemIds: changedIds,
        metadataChanged: z.boolean(),
      }),
    )
    .max(100),
  /** A relative anchor is a dependency, not an inferred actual time or intake. */
  relativeImpacts: z
    .array(
      z.strictObject({
        planId: uuid,
        itemId: idSchema,
        sessionId: z.string().min(1).max(200),
        point: z.enum(['start', 'end']),
        resolution: z.enum(['requires_reprojection', 'unresolved']),
      }),
    )
    .max(5_000),
});
export type JointCandidateDiffV3 = z.infer<typeof jointCandidateDiffV3Schema>;

/** Unsealed projection. A write transaction must recapture heads and revisions before approval. */
export const jointCandidateDraftV3Schema = z
  .strictObject({
    schemaVersion: z.literal(3),
    kind: z.literal('joint-adjustment'),
    basis: jointCoachingBasisSchema,
    writes: jointCandidateWritesV3Schema,
    nutritionPlanHeads: z.array(jointNutritionPlanHeadV3Schema).max(100),
    asOfLocalDate: localDateSchema,
    diff: jointCandidateDiffV3Schema,
    validation: jointCandidateValidationV3Schema,
  })
  .superRefine((candidate, context) => {
    if (candidate.basis.domains.scope !== candidate.writes.scope)
      context.addIssue({
        code: 'custom',
        message: 'Write scope must match the basis',
        path: ['writes'],
      });
    const heads = new Map<string, string | null>();
    for (const [index, head] of candidate.nutritionPlanHeads.entries()) {
      if (heads.has(head.planId))
        context.addIssue({
          code: 'custom',
          message: 'Duplicate plan head',
          path: ['nutritionPlanHeads', index],
        });
      heads.set(head.planId, head.versionId);
    }
    const { training, nutrition } = candidate.writes;
    if (training !== null && candidate.basis.domains.training?.planVersionId !== training.before.id)
      context.addIssue({
        code: 'custom',
        message: 'Training head does not match basis',
        path: ['writes', 'training'],
      });
    if (nutrition !== null) {
      if (new Set(nutrition.map((write) => write.planId)).size !== nutrition.length)
        context.addIssue({
          code: 'custom',
          message: 'Duplicate nutrition write',
          path: ['writes', 'nutrition'],
        });
      for (const [index, write] of nutrition.entries()) {
        if (
          !heads.has(write.planId) ||
          heads.get(write.planId) !== (write.before?.versionId ?? null) ||
          (write.before !== null && write.before.planId !== write.planId)
        )
          context.addIssue({
            code: 'custom',
            message: 'Nutrition write must match pinned head',
            path: ['writes', 'nutrition', index],
          });
      }
    }
    const pinnedNutrition = candidate.basis.domains.nutrition?.planVersionId;
    if (
      pinnedNutrition !== null &&
      pinnedNutrition !== undefined &&
      ![...heads.values()].includes(pinnedNutrition)
    )
      context.addIssue({
        code: 'custom',
        message: 'Basis nutrition head is missing',
        path: ['nutritionPlanHeads'],
      });
  });
export type JointCandidateDraftV3 = z.infer<typeof jointCandidateDraftV3Schema>;

export const jointCandidateV3Schema = jointCandidateDraftV3Schema.safeExtend({
  id: uuid,
  proposalId: uuid,
  decisionId: uuid,
  parentCandidateId: uuid.nullable(),
  createdAt: instantSchema,
  digest,
});
export type JointCandidateV3 = z.infer<typeof jointCandidateV3Schema>;

/** Selection of immutable changes, never a caller-supplied proposed plan. */
export const jointCandidatePartialSelectionV3Schema = z
  .strictObject({
    includeTrainingTitle: z.boolean(),
    trainingPeriodIds: uniqueIds(200),
    trainingSessionIds: uniqueIds(2_000),
    nutritionPlanIds: z
      .array(uuid)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .refine(
    ({ includeTrainingTitle, trainingPeriodIds, trainingSessionIds, nutritionPlanIds }) =>
      includeTrainingTitle ||
      trainingPeriodIds.length > 0 ||
      trainingSessionIds.length > 0 ||
      nutritionPlanIds.length > 0,
    'Select at least one change',
  );
export type JointCandidatePartialSelectionV3 = z.infer<
  typeof jointCandidatePartialSelectionV3Schema
>;

export const jointCandidateProjectionInputV3Schema = z.strictObject({
  basis: jointCoachingBasisSchema,
  writes: jointCandidateWritesV3Schema,
  nutritionContexts: z.array(jointNutritionPlanContextV3Schema).max(100),
  asOfLocalDate: localDateSchema,
  completions: z.array(sessionCompletionSchema).max(1_000),
});
export type JointCandidateProjectionInputV3 = z.infer<typeof jointCandidateProjectionInputV3Schema>;
