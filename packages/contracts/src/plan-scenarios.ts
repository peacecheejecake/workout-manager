import { z } from 'zod';
import { instantSchema } from './primitives.js';
import { manualPlanCommandSchema, planDraftSchema, planSnapshotSchema } from './planning.js';

const id = z.uuid().transform((value) => value.toLowerCase());
const revision = z.number().int().min(1).max(2147483646);
const completionRevision = z.number().int().min(0).max(2147483646);
export const planScenarioLabelSchema = z.enum(['A', 'B', 'C']);
/** Separate alternatives, never a session intensity label or an approved current schedule. */
export const planScenarioSchema = z.strictObject({
  id,
  basePlanVersionId: id,
  label: planScenarioLabelSchema,
  revision,
  createdAt: instantSchema,
  updatedAt: instantSchema,
  draft: planDraftSchema,
});
export const planScenarioSummarySchema = planScenarioSchema.omit({ draft: true }).extend({
  title: planDraftSchema.shape.title,
});
export const planScenarioListQuerySchema = z.strictObject({
  basePlanVersionId: id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
  offset: z.coerce.number().int().min(0).max(10000).default(0),
});
export const planScenarioListSchema = z.strictObject({
  items: z.array(planScenarioSummarySchema).max(100),
  total: z.number().int().nonnegative(),
});
const commandFields = {
  confirmed: z.literal(true),
  idempotencyKey: manualPlanCommandSchema.shape.idempotencyKey,
};
export const planScenarioCreateSchema = z.strictObject({
  ...commandFields,
  basePlanVersionId: id,
  label: planScenarioLabelSchema,
});
export const planScenarioSaveSchema = z.strictObject({
  ...commandFields,
  expectedRevision: revision,
  draft: planDraftSchema,
});
export const planScenarioApplySchema = z.strictObject({
  ...commandFields,
  expectedScenarioRevision: revision,
  expectedPlanVersionId: id,
  expectedCompletionRevision: completionRevision,
});
export const planScenarioApplyResultSchema = z.strictObject({
  plan: planSnapshotSchema,
  scenarioId: id,
  scenarioRevision: revision,
});
export type PlanScenario = z.infer<typeof planScenarioSchema>;
export type PlanScenarioList = z.infer<typeof planScenarioListSchema>;
export type PlanScenarioListQuery = z.infer<typeof planScenarioListQuerySchema>;
export type PlanScenarioCreate = z.infer<typeof planScenarioCreateSchema>;
export type PlanScenarioSave = z.infer<typeof planScenarioSaveSchema>;
export type PlanScenarioApply = z.infer<typeof planScenarioApplySchema>;
export type PlanScenarioApplyResult = z.infer<typeof planScenarioApplyResultSchema>;
