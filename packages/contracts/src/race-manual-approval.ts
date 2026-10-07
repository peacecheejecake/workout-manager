import { z } from 'zod';
import { planDraftSchema, planSnapshotSchema } from './planning.js';
import { recoveryStrategyDraftSchema } from './recovery-core.js';
import { saveNutritionPlanV4IntentSchema } from './nutrition-race-plan-v4.js';
import { routineOccurrenceSchema, routineScheduleVersionSchema } from './routines.js';
import { idSchema, instantSchema, localDateSchema } from './primitives.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const identityKey = (value: string) =>
  z.uuid().safeParse(value).success ? value.toLowerCase() : value;
const snapshotId = planSnapshotSchema.shape.id.transform(identityKey);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().positive().max(2147483647);
const key = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const domains = ['training', 'nutrition', 'recovery', 'routine_schedule'] as const;
const domain = z.enum(domains);

/** Browser-safe structural boundary only. No getters, cycles, non-JSON values or
 * serialization of oversized primitive/key input. Bounds are not authority. */
function assertPlain(value: unknown): void {
  let visits = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  const charge = (text: string) => {
    if (text.length > 4194304 - bytes) throw Error('Approval JSON exceeds 4 MiB');
    bytes += new TextEncoder().encode(text).byteLength;
    if (bytes > 4194304) throw Error('Approval JSON exceeds 4 MiB');
  };
  function visit(v: unknown, depth: number): void {
    if (++visits > 50000 || depth > 64) throw Error('Approval JSON visit bound');
    if (typeof v === 'string') return charge(v);
    if (v === null || typeof v === 'boolean') return;
    if (typeof v === 'number' && Number.isFinite(v)) return;
    if (typeof v !== 'object' || v === null) throw Error('Plain JSON required');
    if (ancestors.has(v)) throw Error('Cyclic JSON');
    const array = Array.isArray(v);
    if (
      array
        ? Object.getPrototypeOf(v) !== Array.prototype
        : ![Object.prototype, null].includes(Object.getPrototypeOf(v))
    )
      throw Error('Plain JSON required');
    if (array && v.length > 50000) throw Error('Approval JSON visit bound');
    const keys = Reflect.ownKeys(v);
    if (keys.length > 50001) throw Error('Approval JSON visit bound');
    ancestors.add(v);
    let count = 0;
    for (const name of keys) {
      if (typeof name !== 'string') throw Error('JSON keys required');
      if (array && name === 'length') continue;
      charge(name);
      const descriptor = Object.getOwnPropertyDescriptor(v, name);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
        throw Error('Data properties required');
      if (array && (!/^(0|[1-9][0-9]*)$/.test(name) || Number(name) >= v.length))
        throw Error('JSON array required');
      count++;
      visit(descriptor.value, depth + 1);
    }
    if (array && count !== v.length) throw Error('Dense JSON array required');
    ancestors.delete(v);
  }
  visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 4194304)
    throw Error('Approval JSON exceeds 4 MiB');
}
const plain = z.unknown().superRefine((value, context) => {
  try {
    assertPlain(value);
  } catch {
    context.addIssue({ code: 'custom', message: 'Bounded plain approval JSON required' });
  }
});
function bounded<T extends z.ZodType>(schema: T) {
  return plain.pipe(schema);
}
const absentHead = z.strictObject({ kind: z.literal('absent') });
const numberedHead = z.strictObject({ kind: z.literal('exists'), versionId: uuid, version });
const trainingHead = z.strictObject({
  kind: z.literal('exists'),
  versionId: snapshotId,
  version,
});
const expectedTrainingHead = z.discriminatedUnion('kind', [absentHead, trainingHead]);
const scheduleId = routineScheduleVersionSchema.shape.versionId.transform((value) =>
  z.uuid().safeParse(value).success ? value.toLowerCase() : value,
);
const scheduleHead = z.strictObject({ kind: z.literal('exists'), versionId: scheduleId });
const expectedNumberedHead = z.discriminatedUnion('kind', [absentHead, numberedHead]);
const expectedScheduleHead = z.discriminatedUnion('kind', [absentHead, scheduleHead]);
function roster<T extends z.ZodType>(head: T) {
  return z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('absent') }),
    z.strictObject({
      state: z.literal('present'),
      members: z
        .array(z.strictObject({ aggregateId: uuid, head }))
        .min(1)
        .max(1000),
    }),
  ]);
}
const headsBody = z
  .strictObject({
    training: roster(trainingHead),
    nutrition: roster(numberedHead),
    recovery: roster(numberedHead),
    routine_schedule: roster(scheduleHead),
  })
  .superRefine((heads, context) => {
    let count = 0;
    for (const d of domains) {
      const r = heads[d];
      if (r.state === 'absent') continue;
      count += r.members.length;
      const seen = new Set<string>();
      for (const [index, member] of r.members.entries()) {
        if (seen.has(member.aggregateId))
          context.addIssue({
            code: 'custom',
            path: [d, 'members', index],
            message: 'Duplicate domain aggregate',
          });
        seen.add(member.aggregateId);
      }
    }
    if (count > 1000)
      context.addIssue({ code: 'custom', message: 'Whole head roster exceeds 1000' });
  });
/** Whole current portfolio, including empty domains. Training versionId is the
 * snapshot identity, never its stable aggregateId. Routines have no numeric version. */
export const raceManualApprovalExpectedHeadsSchema = bounded(headsBody);
export type RaceManualApprovalExpectedHeads = z.infer<typeof raceManualApprovalExpectedHeadsSchema>;
const target = z.strictObject({ domain, aggregateId: uuid });
const writeBody = z
  .discriminatedUnion('domain', [
    z.strictObject({
      domain: z.literal('training'),
      aggregateId: uuid,
      expectedHead: expectedTrainingHead,
      proposed: planDraftSchema,
    }),
    z.strictObject({
      domain: z.literal('nutrition'),
      aggregateId: uuid,
      expectedHead: numberedHead,
      intent: saveNutritionPlanV4IntentSchema,
    }),
    z.strictObject({
      domain: z.literal('recovery'),
      aggregateId: uuid,
      expectedHead: expectedNumberedHead,
      proposed: recoveryStrategyDraftSchema,
      selectedOptionId: uuid,
    }),
    z.strictObject({
      domain: z.literal('routine_schedule'),
      aggregateId: uuid,
      expectedHead: expectedScheduleHead,
      proposed: routineScheduleVersionSchema,
      sourcePlanVersionId: snapshotId.nullable(),
      occurrences: z.array(routineOccurrenceSchema).max(1000),
    }),
  ])
  .superRefine((write, context) => {
    if (write.domain === 'nutrition') {
      const command = write.intent.intent.command;
      if (
        command.planId.toLowerCase() !== write.aggregateId ||
        command.expectedHeadVersionId.toLowerCase() !== write.expectedHead.versionId
      )
        context.addIssue({ code: 'custom', message: 'Exact nutrition prior tuple required' });
    }
    if (
      write.domain === 'recovery' &&
      !write.proposed.options.some((o) => o.id === write.selectedOptionId)
    )
      context.addIssue({ code: 'custom', message: 'Selected recovery option missing' });
    if (write.domain === 'routine_schedule') {
      if (
        identityKey(write.proposed.id) !== write.aggregateId ||
        (write.expectedHead.kind === 'exists' &&
          identityKey(write.proposed.versionId) === write.expectedHead.versionId)
      )
        context.addIssue({ code: 'custom', message: 'New exact schedule identity required' });
      const ids = new Set<string>(),
        anchors = new Set<string>();
      for (const [index, occurrence] of write.occurrences.entries()) {
        if (ids.has(identityKey(occurrence.id)) || anchors.has(occurrence.anchorKey))
          context.addIssue({
            code: 'custom',
            path: ['occurrences', index],
            message: 'Duplicate occurrence or anchor',
          });
        ids.add(identityKey(occurrence.id));
        anchors.add(occurrence.anchorKey);
        if (
          identityKey(occurrence.schedule.id) !== identityKey(write.proposed.id) ||
          identityKey(occurrence.schedule.versionId) !== identityKey(write.proposed.versionId) ||
          identityKey(occurrence.blueprint.id) !== identityKey(write.proposed.blueprint.id) ||
          identityKey(occurrence.blueprint.versionId) !==
            identityKey(write.proposed.blueprint.versionId)
        )
          context.addIssue({
            code: 'custom',
            path: ['occurrences', index],
            message: 'Foreign occurrence lineage',
          });
        if (occurrence.timingStatus !== 'resolved')
          context.addIssue({
            code: 'custom',
            path: ['occurrences', index],
            message: 'Affected occurrence must be resolved',
          });
      }
      if (write.occurrences.length > write.proposed.window.maxOccurrences)
        context.addIssue({ code: 'custom', message: 'Occurrence window bound' });
      if (
        (write.proposed.rule.kind === 'period_days' ||
          write.proposed.rule.kind === 'session_links') &&
        write.sourcePlanVersionId === null
      )
        context.addIssue({
          code: 'custom',
          message: 'Relative schedule requires exact training source',
        });
    }
  });
export const raceManualApprovalWriteSchema = bounded(writeBody);
export type RaceManualApprovalWrite = z.infer<typeof raceManualApprovalWriteSchema>;
/** Deterministic child receipt identity only. A runtime candidate single-application
 * lock plus outer receipt-first replay is required; this key authorizes no write. */
export function raceManualApprovalNutritionKey(candidateId: string, planId: string): string {
  return `race_approval_${uuid.parse(candidateId).replaceAll('-', '')}_${uuid.parse(planId).replaceAll('-', '')}`;
}
const chain = z.strictObject({
  evidenceId: uuid,
  decisionId: uuid,
  proposalId: uuid,
  readonlyCandidateDigest: digest,
});
const raceChange = z.strictObject({
  eventId: uuid,
  expectedRevision: version,
  newLocalDate: localDateSchema,
});
const policy = z.strictObject({ id: z.literal('manual-race-date-impact'), version, digest });
const expectation = z.strictObject({
  restoreGeneration: uuid,
  appRevision: version,
  manualPolicy: policy,
  semanticDigest: digest,
  heads: headsBody,
});
const notice = z.strictObject({
  domain,
  aggregateId: uuid,
  itemId: idSchema.nullable(),
  code: z.enum(['UNCHANGED_UNRESOLVED', 'DISCONNECTED_RETAINED']),
});
const blocker = z.strictObject({
  reason: z.enum([
    'source_unavailable',
    'source_permission_unavailable',
    'stale_basis',
    'incomplete_affected_scope',
    'affected_timing_unresolved',
    'disconnection_origin_unavailable',
    'reconnect_target_unavailable',
    'unsupported_source',
    'application_port_unavailable',
  ]),
  target: target.nullable(),
});
const candidateCommon = {
  schemaVersion: z.literal(1),
  candidateId: uuid,
  chain,
  applicationDigest: digest,
  createdAt: instantSchema,
  raceChange,
  expectation,
  authority: z.literal('server_revalidation_required'),
};
const candidateBody = z
  .discriminatedUnion('applicationState', [
    z.strictObject({
      ...candidateCommon,
      applicationState: z.literal('blocked'),
      blockers: z.array(blocker).min(1).max(1000),
    }),
    z.strictObject({
      ...candidateCommon,
      applicationState: z.literal('ready_for_explicit_approval'),
      scope: z.literal('whole_affected'),
      affected: z.array(target).max(1000),
      writes: z.array(writeBody).max(1000),
      notices: z.array(notice).max(5000),
    }),
  ])
  .superRefine((candidate, context) => {
    if (
      new Set([
        candidate.chain.evidenceId,
        candidate.chain.decisionId,
        candidate.chain.proposalId,
        candidate.candidateId,
      ]).size !== 4
    )
      context.addIssue({
        code: 'custom',
        message: 'Distinct chain/application identities required',
      });
    if (candidate.applicationState === 'blocked') return;
    const identity = (t: { domain: string; aggregateId: string }) =>
      JSON.stringify([t.domain, t.aggregateId]);
    const affected = new Set(candidate.affected.map(identity)),
      writes = new Set(candidate.writes.map(identity));
    if (
      affected.size !== candidate.affected.length ||
      writes.size !== candidate.writes.length ||
      affected.size !== writes.size ||
      [...affected].some((t) => !writes.has(t))
    )
      context.addIssue({
        code: 'custom',
        message: 'Whole affected writes require exact unique membership',
      });
    for (const [index, write] of candidate.writes.entries()) {
      const r = candidate.expectation.heads[write.domain];
      const head =
        r.state === 'present'
          ? r.members.find((m) => m.aggregateId === write.aggregateId)?.head
          : undefined;
      if (JSON.stringify(head ?? { kind: 'absent' }) !== JSON.stringify(write.expectedHead))
        context.addIssue({
          code: 'custom',
          path: ['writes', index, 'expectedHead'],
          message: 'Write prior must match whole expected head roster',
        });
      if (
        write.domain === 'nutrition' &&
        write.intent.intent.command.idempotencyKey !==
          raceManualApprovalNutritionKey(candidate.candidateId, write.aggregateId)
      )
        context.addIssue({
          code: 'custom',
          path: ['writes', index, 'intent'],
          message: 'Candidate-bound nutrition receipt key required',
        });
    }
  });
/** Readiness is validation state only. Actual authenticated stored candidate,
 * whole-source admission and same-tx closure are mandatory before any writer. */
export const raceManualApprovalCandidateSchema = bounded(candidateBody);
export type RaceManualApprovalCandidate = z.infer<typeof raceManualApprovalCandidateSchema>;
const commandBody = z
  .strictObject({
    schemaVersion: z.literal(1),
    idempotencyKey: key,
    confirmed: z.literal(true),
    candidateId: uuid,
    applicationDigest: digest,
    chain,
    raceChange,
    expectation,
  })
  .superRefine((command, context) => {
    if (
      new Set([
        command.chain.evidenceId,
        command.chain.decisionId,
        command.chain.proposalId,
        command.candidateId,
      ]).size !== 4
    )
      context.addIssue({
        code: 'custom',
        message: 'Distinct chain/application identities required',
      });
  });
export const raceManualApprovalCommandSchema = bounded(commandBody);
export type RaceManualApprovalCommand = z.infer<typeof raceManualApprovalCommandSchema>;
const applied = z.discriminatedUnion('domain', [
  z.strictObject({
    domain: z.literal('training'),
    aggregateId: uuid,
    versionId: snapshotId,
    version,
  }),
  ...(['nutrition', 'recovery'] as const).map((d) =>
    z.strictObject({ domain: z.literal(d), aggregateId: uuid, versionId: uuid, version }),
  ),
  z.strictObject({
    domain: z.literal('routine_schedule'),
    aggregateId: uuid,
    versionId: scheduleId,
  }),
]);
const resultBody = z
  .discriminatedUnion('status', [
    z.strictObject({
      schemaVersion: z.literal(1),
      status: z.literal('blocked'),
      candidateId: uuid,
      blockers: z.array(blocker).min(1).max(1000),
    }),
    z.strictObject({
      schemaVersion: z.literal(1),
      status: z.literal('committed'),
      candidateId: uuid,
      approvalId: uuid,
      proposalId: uuid,
      approvedAt: instantSchema,
      race: z.strictObject({ eventId: uuid, revision: version }),
      versions: z.array(applied).max(1000),
      occurrenceIds: z.array(idSchema).max(1000),
      notices: z.array(notice).max(5000),
    }),
  ])
  .superRefine((result, context) => {
    if (result.status !== 'committed') return;
    const keys = result.versions.map((v) => JSON.stringify([v.domain, v.aggregateId]));
    if (
      new Set(keys).size !== keys.length ||
      new Set(result.occurrenceIds.map(identityKey)).size !== result.occurrenceIds.length
    )
      context.addIssue({ code: 'custom', message: 'Duplicate committed identities' });
  });
export const raceManualApprovalResultSchema = bounded(resultBody);
export type RaceManualApprovalResult = z.infer<typeof raceManualApprovalResultSchema>;
