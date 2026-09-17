import {
  transportReplySchema,
  transportRequestDtoSchema,
  type AuthenticatedTransport,
} from '@workout/contracts/core';
import {
  planReadSchema,
  planSnapshotSchema,
  preservesSessionLocks,
  type PlanSnapshot,
} from '@workout/contracts/planning';
import {
  sessionCompletionListSchema,
  preservesSessionCompletions,
} from '@workout/contracts/session-completion';
import {
  planScenarioSchema,
  planScenarioCreateSchema,
  planScenarioSaveSchema,
  planScenarioApplySchema,
  planScenarioApplyResultSchema,
  type PlanScenario,
  type PlanScenarioCreate,
  type PlanScenarioSave,
  type PlanScenarioApply,
  type PlanScenarioApplyResult,
} from '@workout/contracts/plan-scenarios';
export class ScenarioRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code = 'SCENARIO_REQUEST_FAILED',
  ) {
    super(code);
  }
}
export async function readScenarioResource<T>(
  transport: AuthenticatedTransport,
  path: string,
  schema: { parse(value: unknown): T },
  signal: AbortSignal,
): Promise<T> {
  const reply = transportReplySchema.parse(
    await transport.request({ path, method: 'GET', body: null, idempotencyKey: null, signal }),
  );
  if (signal.aborted) throw new Error('CANCELLED');
  if (reply.status !== 200) throw new ScenarioRequestError(reply.status);
  return schema.parse(reply.body);
}
export type ScenarioCommand =
  | { kind: 'create'; base: PlanSnapshot; command: PlanScenarioCreate }
  | { kind: 'save'; scenario: PlanScenario; command: PlanScenarioSave }
  | { kind: 'apply'; scenario: PlanScenario; before: PlanSnapshot; command: PlanScenarioApply };
export type ScenarioCommandResult =
  | { kind: 'scenario'; scenario: PlanScenario }
  | { kind: 'applied'; result: PlanScenarioApplyResult };
export async function prepareScenarioApply(
  transport: AuthenticatedTransport,
  selected: PlanScenario,
  signal: AbortSignal,
  createId: () => string,
): Promise<Extract<ScenarioCommand, { kind: 'apply' }>> {
  const [current, completions, scenario] = await Promise.all([
    readScenarioResource(transport, '/bff/v1/plans/current', planReadSchema, signal),
    readScenarioResource(
      transport,
      '/bff/v1/plans/current/session-completions',
      sessionCompletionListSchema,
      signal,
    ),
    readScenarioResource(
      transport,
      `/bff/v1/plan-scenarios/${selected.id}`,
      planScenarioSchema,
      signal,
    ),
  ]);
  if (
    !current.head ||
    completions.currentPlanVersionId !== current.head.id ||
    scenario.id !== selected.id ||
    scenario.revision !== selected.revision
  )
    throw new ScenarioRequestError(409, 'SCENARIO_STALE');
  if (!preservesSessionLocks(current.head.draft, scenario.draft))
    throw new ScenarioRequestError(409, 'SCENARIO_LOCKED');
  if (
    !preservesSessionCompletions(
      scenario.draft,
      completions.items.filter((item) => item.status === 'completed'),
    )
  )
    throw new ScenarioRequestError(409, 'SCENARIO_COMPLETED');
  return {
    kind: 'apply',
    scenario,
    before: current.head,
    command: planScenarioApplySchema.parse({
      confirmed: true,
      idempotencyKey: createId(),
      expectedScenarioRevision: scenario.revision,
      expectedPlanVersionId: current.head.id,
      expectedCompletionRevision: completions.collectionRevision,
    }),
  };
}
export async function runScenarioCommand(
  transport: AuthenticatedTransport,
  frozen: ScenarioCommand,
  signal: AbortSignal,
): Promise<ScenarioCommandResult> {
  const command =
    frozen.kind === 'create'
      ? planScenarioCreateSchema.parse(frozen.command)
      : frozen.kind === 'save'
        ? planScenarioSaveSchema.parse(frozen.command)
        : planScenarioApplySchema.parse(frozen.command);
  const { idempotencyKey, ...body } = command;
  const path =
    frozen.kind === 'create'
      ? '/bff/v1/plan-scenarios'
      : `/bff/v1/plan-scenarios/${frozen.scenario.id}${frozen.kind === 'apply' ? '/apply' : ''}`;
  const reply = transportReplySchema.parse(
    await transport.request({
      path,
      method: frozen.kind === 'save' ? 'PUT' : 'POST',
      body: transportRequestDtoSchema.shape.body.parse(JSON.parse(JSON.stringify(body))),
      idempotencyKey,
      signal,
    }),
  );
  if (signal.aborted) throw new Error('CANCELLED');
  if (reply.status !== 200 && reply.status !== 201) throw new ScenarioRequestError(reply.status);
  if (frozen.kind === 'apply') {
    const result = planScenarioApplyResultSchema.parse(reply.body);
    if (
      result.scenarioId !== frozen.scenario.id ||
      result.scenarioRevision !== frozen.command.expectedScenarioRevision
    )
      throw new Error('RECEIPT_MISMATCH');
    return { kind: 'applied', result };
  }
  const scenario = planScenarioSchema.parse(reply.body);
  if (
    frozen.kind === 'create'
      ? scenario.basePlanVersionId !== frozen.command.basePlanVersionId ||
        scenario.label !== frozen.command.label ||
        scenario.revision !== 1
      : scenario.id !== frozen.scenario.id ||
        scenario.revision !== frozen.command.expectedRevision + 1
  )
    throw new Error('RECEIPT_MISMATCH');
  return { kind: 'scenario', scenario };
}
export { planSnapshotSchema };
