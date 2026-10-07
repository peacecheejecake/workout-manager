import { z } from 'zod';
import {
  actualRefSchema,
  routineBlueprintVersionSchema,
  routineOccurrenceSchema,
  routineRunSchema,
  routineScheduleVersionSchema,
  routineStepContentSchema,
} from '@workout/contracts/routines';
import { routineRunReadSchema } from '@workout/contracts/routine-commands';
import { activityValuesSchema, activityOverlaySchema } from '@workout/contracts/activity';
import { intakeEntryRecordSchema } from '@workout/contracts/nutrition-core';
import { checkInValuesSchema } from '@workout/contracts/check-ins';
import {
  manualIntakeReadFactsSchema,
  validateManualIntakeReadFacts,
} from './race-plan-impact-intake-read-facts.js';
import {
  manualActivityReadFactsSchema,
  manualActivityReadProjectionInputSchema,
  validateManualActivityReadFacts,
} from './race-plan-impact-manual-activity-read-facts.js';
import { impactDependencyDigest as digest } from './race-plan-impact-dependencies.js';
const uuid = z.uuid();
const opaque = z.string().min(1).max(200);
const revision = z.number().int().min(1).max(2147483647);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const absent = z.strictObject({ state: z.literal('absent') });
const checklist = z.strictObject({
  id: uuid,
  run_id: uuid,
  step_id: opaque,
  revision_id: uuid,
  occurred_at: z.iso.datetime(),
  state: z.enum(['performed', 'partial']),
});
const detail = z.strictObject({
  id: uuid,
  activity_id: uuid,
  execution_id: uuid,
  current_revision: revision,
  current_revision_id: uuid,
  status: z.enum(['active', 'deleted']),
});
const activityContent = z.strictObject({
  original: activityValuesSchema,
  overlay: activityOverlaySchema.nullable(),
  detail: detail.nullable(),
});
const actualCurrent = z.union([
  z.null(),
  z.strictObject({ id: uuid, revision, deleted: z.boolean() }),
  z.strictObject({ id: opaque, revision, revisionId: uuid, status: z.enum(['active', 'deleted']) }),
  z.strictObject({ id: uuid, revision, status: z.enum(['active', 'deleted']) }),
  z.strictObject({ id: uuid, revisionId: uuid }),
]);
const fact = z.strictObject({
  requested: actualRefSchema,
  state: z.enum(['current', 'historical', 'deleted', 'unavailable']),
  reason: z
    .enum([
      'producer_actual_unsupported',
      'producer_allocation_unsupported',
      'owned_reference_unavailable',
      'requested_revision_unavailable',
      'owned_detail_unavailable',
      'detail_deleted',
    ])
    .nullable(),
  current: actualCurrent,
  content: z.union([
    z.null(),
    checklist,
    activityContent,
    intakeEntryRecordSchema,
    checkInValuesSchema,
  ]),
});
const ledger = z.strictObject({
  id: opaque,
  revision,
  revisionId: uuid,
  status: z.enum(['active', 'deleted']),
  contentDigest: hash,
});
const activityHead = z.strictObject({
  id: uuid,
  revision,
  deleted: z.boolean(),
  originalDigest: hash,
  overlayDigest: hash,
  source: z.union([
    absent,
    z.strictObject({
      state: z.literal('present'),
      kind: z.enum(['fit', 'fixture', 'manual', 'healthkit']),
      sourceId: opaque,
      sourceRevision: revision,
      contentHash: hash,
    }),
  ]),
});
export const routineReadManifestSchema = z.strictObject({
  uniqueSourceCount: z.number().int().min(0).max(5000),
  occurrences: z
    .array(
      z.strictObject({
        record: routineOccurrenceSchema,
        currentSchedule: z.union([
          absent,
          z.strictObject({ state: z.literal('present'), versionId: uuid }),
        ]),
        startedRun: z.union([
          absent,
          z.strictObject({
            state: z.literal('present'),
            runId: uuid,
            revision: z.number().int().min(0).max(2147483646),
          }),
        ]),
      }),
    )
    .max(1000),
  runs: z
    .array(
      z.strictObject({
        record: routineRunSchema,
        historyDigest: hash,
        actuals: z.array(z.strictObject({ stepId: opaque, fact })).max(5000),
      }),
    )
    .max(1000),
  blueprints: z
    .array(
      z.strictObject({
        record: routineBlueprintVersionSchema,
        version: z.number().int().min(1).max(2147483646),
        currentHead: z.union([
          absent,
          z.strictObject({
            state: z.literal('present'),
            versionId: uuid,
            version: z.number().int().min(1).max(2147483646),
            visibility: z.enum(['active', 'archived', 'deleted']),
            favorite: z.boolean(),
          }),
        ]),
        unsupportedContent: z
          .array(
            z.strictObject({
              stepId: opaque,
              content: routineStepContentSchema,
              state: z.literal('unavailable'),
              reason: z.literal('producer_content_unsupported'),
            }),
          )
          .max(5000),
      }),
    )
    .max(5000),
  schedules: z
    .array(
      z.strictObject({
        scheduleId: uuid,
        versionId: uuid,
        sourcePlanVersionId: uuid.nullable(),
        record: routineScheduleVersionSchema,
        currentHead: z.union([
          absent,
          z.strictObject({
            state: z.literal('present'),
            versionId: uuid,
            notificationMuted: z.boolean(),
          }),
        ]),
      }),
    )
    .max(5000),
  actualRosters: z.strictObject({
    activities: z.array(activityHead).max(1000),
    intake: z.array(ledger).max(1000),
    recovery: z.array(ledger).max(1000),
  }),
});
/** timerReads must be actual public readRun DTOs for the exact captured runs.
 * Absence is unknown, not proof that no timer exists. The collector currently
 * exposes current historyDigest, not a complete revision-history roster. */
export const routineReadSourcesProjectionSchema = z.strictObject({
  manifest: routineReadManifestSchema,
  timerReads: z.array(routineRunReadSchema).max(1000).optional(),
  // Retained read correspondence only; the full capture checks athlete scope.
  intakeReadFacts: manualIntakeReadFactsSchema.optional(),
  activityReadFacts: manualActivityReadFactsSchema.optional(),
  activityMetadata: manualActivityReadProjectionInputSchema.shape.activityMetadata.optional(),
});
export type RoutineReadSourcesProjection = z.infer<typeof routineReadSourcesProjectionSchema>;
export type RoutineReadBlocker = {
  path: string;
  reason:
    | 'invalid_projection'
    | 'bounds_exceeded'
    | 'source_identity_mismatch'
    | 'history_mismatch'
    | 'frozen_source_missing'
    | 'actual_membership_mismatch'
    | 'actual_source_unavailable'
    | 'actual_permission_port_missing'
    | 'planned_reference_port_missing'
    | 'timer_inventory_missing'
    | 'timer_source_mismatch'
    | 'unsupported_consumed_content';
};
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const equal = (a: unknown, b: unknown) => digest(a) === digest(b);
const actualKey = (stepId: string, ref: unknown) => digest({ stepId, ref });
export function validateRoutineReadSources(input: unknown): {
  status: 'validated_read_sources' | 'blocked';
  authority: 'none';
  freshness: 'not_checked';
  historyCoverage: 'current_revision_only';
  blockers: RoutineReadBlocker[];
  digest: string | null;
} {
  const blockers: RoutineReadBlocker[] = [];
  const block = (path: string, reason: RoutineReadBlocker['reason']) =>
    blockers.push({ path, reason });
  const result = (value: unknown | null) => ({
    status: blockers.length ? ('blocked' as const) : ('validated_read_sources' as const),
    authority: 'none' as const,
    freshness: 'not_checked' as const,
    historyCoverage: 'current_revision_only' as const,
    blockers,
    digest: value === null ? null : digest(value),
  });
  try {
    const encoded = JSON.stringify(input);
    if (!encoded || Buffer.byteLength(encoded) > 4194304) {
      block('projection', 'bounds_exceeded');
      return result(null);
    }
  } catch {
    block('projection', 'invalid_projection');
    return result(null);
  }
  const parsed = routineReadSourcesProjectionSchema.safeParse(input);
  if (!parsed.success) {
    block('projection', 'invalid_projection');
    return result(null);
  }
  const c = parsed.data,
    m = c.manifest;
  const visits =
    m.runs.reduce(
      (n, r) =>
        n +
        r.record.progress.length +
        r.actuals.length +
        r.record.progress.reduce((sum, p) => sum + p.actualRefs.length, 0),
      0,
    ) +
    m.occurrences.reduce((n, o) => n + o.record.stepBindings.length, 0) +
    (c.timerReads ?? []).reduce((n, r) => n + r.timers.length, 0) +
    (c.intakeReadFacts?.facts.length ?? 0) +
    (c.activityReadFacts?.facts.length ?? 0) +
    (c.activityMetadata?.length ?? 0);
  if (
    visits +
      m.runs.length +
      m.occurrences.length +
      m.blueprints.length +
      m.schedules.length +
      m.actualRosters.activities.length +
      m.actualRosters.intake.length +
      m.actualRosters.recovery.length >
    5000
  ) {
    block('projection', 'bounds_exceeded');
    return result(c);
  }
  // SQL023 permits 1MiB blueprint/run records and 64KiB occurrence/schedule
  // records. Read bounds preserve those existing producer capacities.
  const bodyBytes = (body: unknown) => Buffer.byteLength(JSON.stringify(body));
  if (
    [...m.runs.map((r) => r.record), ...m.blueprints.map((b) => b.record)].some(
      (body) => bodyBytes(body) > 1048576,
    ) ||
    [...m.schedules.map((s) => s.record), ...m.occurrences.map((o) => o.record)].some(
      (body) => bodyBytes(body) > 65536,
    ) ||
    m.runs.some((r) => r.actuals.some((a) => bodyBytes(a.fact.content) > 1048576))
  ) {
    block('projection', 'bounds_exceeded');
    return result(c);
  }
  const buildMap = <T>(rows: readonly T[], key: (row: T) => string, path: string) => {
    const map = new Map(rows.map((row) => [key(row), row]));
    if (map.size !== rows.length) block(path, 'source_identity_mismatch');
    return map;
  };
  const blueprints = buildMap(m.blueprints, (b) => b.record.versionId.toLowerCase(), 'blueprints');
  const schedules = buildMap(m.schedules, (s) => s.versionId.toLowerCase(), 'schedules');
  const occurrences = buildMap(m.occurrences, (o) => o.record.id.toLowerCase(), 'occurrences');
  const runs = buildMap(m.runs, (r) => r.record.id.toLowerCase(), 'runs');
  const activities = buildMap(
    m.actualRosters.activities,
    (a) => a.id.toLowerCase(),
    'actualRosters.activities',
  );
  const intake = buildMap(m.actualRosters.intake, (a) => a.id, 'actualRosters.intake');
  buildMap(m.actualRosters.recovery, (a) => a.id.toLowerCase(), 'actualRosters.recovery');
  const timers = buildMap(c.timerReads ?? [], (r) => r.run.id.toLowerCase(), 'timerReads');
  const intakeRefs = m.runs.flatMap((r) =>
    r.actuals.flatMap((a) => (a.fact.requested.kind === 'intake' ? [a.fact.requested] : [])),
  );
  const intakePortValid =
    c.intakeReadFacts !== undefined &&
    validateManualIntakeReadFacts(c.intakeReadFacts, {
      athleteId: c.intakeReadFacts.athleteId,
      refs: intakeRefs,
    }).status === 'validated_retained_read_facts';
  if (c.intakeReadFacts && !intakePortValid) block('intakeReadFacts', 'actual_membership_mismatch');
  const intakePort = new Map(
    (c.intakeReadFacts?.facts ?? []).map(
      (f) => [JSON.stringify([f.requested.id, f.requested.revisionId.toLowerCase()]), f] as const,
    ),
  );
  // The SQL capture may use the same actual in several steps/runs. Deduplicate
  // only equal facts; divergent copies of the same reference remain blocked.
  const consumedActivities = new Map<string, z.infer<typeof fact>>();
  for (const row of m.runs)
    for (const a of row.actuals) {
      const ref = a.fact.requested;
      if (ref.kind !== 'activity') continue;
      const key = JSON.stringify([
        ref.id.toLowerCase(),
        ref.revisionId,
        ref.detailId?.toLowerCase() ?? null,
        ref.allocationId?.toLowerCase() ?? null,
      ]);
      const prior = consumedActivities.get(key);
      if (prior && !equal(prior, a.fact)) block('activityReadFacts', 'actual_membership_mismatch');
      else consumedActivities.set(key, a.fact);
    }
  const activityPortValid =
    c.activityReadFacts !== undefined &&
    c.activityMetadata !== undefined &&
    validateManualActivityReadFacts(c.activityReadFacts, {
      athleteId: c.activityReadFacts.athleteId,
      refs: [...consumedActivities.values()].map((f) => f.requested),
      actualFacts: [...consumedActivities.values()],
      activityRosters: m.actualRosters.activities,
      activityMetadata: c.activityMetadata,
    }).status === 'validated_retained_read_facts';
  if (c.activityReadFacts && !activityPortValid)
    block('activityReadFacts', 'actual_membership_mismatch');
  for (const row of blueprints.values()) {
    if (
      !uuid.safeParse(row.record.routineId).success ||
      !uuid.safeParse(row.record.versionId).success
    )
      block('blueprints', 'source_identity_mismatch');
    const expected = row.record.steps
      .filter(
        (step) =>
          step.content.kind === 'recovery_method' || step.content.kind === 'checkin_template',
      )
      .map((step) => ({
        stepId: step.id,
        content: step.content,
        state: 'unavailable',
        reason: 'producer_content_unsupported',
      }));
    if (!equal(expected, row.unsupportedContent))
      block(`blueprint:${row.record.versionId}`, 'source_identity_mismatch');
  }
  const started = new Map<string, string>();
  const cache = new Set<string>();
  for (const row of schedules.values())
    if (row.sourcePlanVersionId !== null)
      block(`schedule:${row.versionId}.sourcePlanVersionId`, 'planned_reference_port_missing');
  for (const row of schedules.values())
    if (!same(row.scheduleId, row.record.id) || !same(row.versionId, row.record.versionId))
      block(`schedule:${row.versionId}`, 'source_identity_mismatch');
  for (const row of occurrences.values()) {
    const o = row.record,
      s = schedules.get(o.schedule.versionId.toLowerCase()),
      b = blueprints.get(o.blueprint.versionId.toLowerCase());
    if (!s || !b) {
      block(`occurrence:${o.id}`, 'frozen_source_missing');
      continue;
    }
    if (
      !same(s.scheduleId, o.schedule.id) ||
      !same(b.record.routineId, o.blueprint.id) ||
      !equal(s.record.blueprint, o.blueprint) ||
      !equal(
        s.currentHead.state === 'absent'
          ? s.currentHead
          : { state: 'present', versionId: s.currentHead.versionId },
        row.currentSchedule,
      )
    )
      block(`occurrence:${o.id}`, 'source_identity_mismatch');
    if (
      o.stepBindings.some((binding) => !b.record.steps.some((step) => step.id === binding.stepId))
    )
      block(`occurrence:${o.id}`, 'actual_membership_mismatch');
    if (o.stepBindings.length)
      block(`occurrence:${o.id}.stepBindings`, 'planned_reference_port_missing');
    for (const [group, step] of Object.entries(o.selectedChoices))
      if (!b.record.choiceGroups.some((g) => g.id === group && g.stepIds.includes(step)))
        block(`occurrence:${o.id}.choices`, 'actual_membership_mismatch');
  }
  for (const row of runs.values()) {
    const r = row.record,
      path = `run:${r.id}`,
      b = blueprints.get(r.blueprint.versionId.toLowerCase());
    if (r.revision > 2147483646 || row.historyDigest !== digest(r)) block(path, 'history_mismatch');
    if (!b || !same(b.record.routineId, r.blueprint.id)) {
      block(path, 'frozen_source_missing');
      continue;
    }
    const steps = new Map(b.record.steps.map((s) => [s.id, s]));
    if (r.origin.kind === 'planned') {
      const o = occurrences.get(r.origin.occurrenceId.toLowerCase());
      if (
        !o ||
        !equal(o.record.blueprint, r.blueprint) ||
        started.has(r.origin.occurrenceId.toLowerCase()) ||
        o.startedRun.state !== 'present' ||
        !same(o.startedRun.runId, r.id) ||
        o.startedRun.revision !== r.revision
      )
        block(path, 'source_identity_mismatch');
      started.set(r.origin.occurrenceId.toLowerCase(), r.id);
    }
    for (const [group, step] of Object.entries(r.selectedChoices))
      if (!b.record.choiceGroups.some((g) => g.id === group && g.stepIds.includes(step)))
        block(`${path}.choices`, 'actual_membership_mismatch');
    const expected = new Map(
      r.progress.flatMap((p) =>
        p.actualRefs.map((ref) => [actualKey(p.stepId, ref), { progress: p, ref }] as const),
      ),
    );
    const facts = buildMap(
      row.actuals,
      (a) => actualKey(a.stepId, a.fact.requested),
      `${path}.actuals`,
    );
    if (expected.size !== facts.size || [...expected.keys()].some((k) => !facts.has(k)))
      block(`${path}.actuals`, 'actual_membership_mismatch');
    for (const p of r.progress) {
      const step = steps.get(p.stepId);
      if (!step) block(`${path}.progress`, 'actual_membership_mismatch');
      else if (step.content.kind === 'recovery_method' || step.content.kind === 'checkin_template')
        block(`${path}.${p.stepId}`, 'unsupported_consumed_content');
    }
    for (const [key, a] of facts) {
      const expectedRef = expected.get(key),
        step = steps.get(a.stepId),
        f = a.fact,
        ref = f.requested;
      if (!expectedRef || !step) {
        block(`${path}.actuals`, 'actual_membership_mismatch');
        continue;
      }
      cache.add(
        digest(
          ref.kind === 'checklist_confirmation' ? { ref, runId: r.id, stepId: a.stepId } : ref,
        ),
      );
      const allowed =
        ref.kind === 'activity'
          ? 'workout_template'
          : ref.kind === 'intake'
            ? 'nutrition_template'
            : ref.kind === 'recovery_log'
              ? 'recovery_method'
              : ref.kind === 'checkin'
                ? 'checkin_template'
                : 'checklist';
      if (step.content.kind !== allowed) block(`${path}.${a.stepId}`, 'actual_membership_mismatch');
      if (f.state === 'unavailable') {
        if (
          (f.reason === 'producer_actual_unsupported' && ref.kind !== 'recovery_log') ||
          (f.reason === 'producer_allocation_unsupported' &&
            (ref.kind !== 'activity' || ref.allocationId === null))
        )
          block(path, 'actual_membership_mismatch');
        if (f.content !== null || f.reason === null) block(path, 'actual_membership_mismatch');
        block(`${path}.${a.stepId}`, 'actual_source_unavailable');
        continue;
      }
      if (f.reason !== null || f.current === null) {
        block(path, 'actual_membership_mismatch');
        continue;
      }
      if (ref.kind === 'checklist_confirmation') {
        const body = checklist.safeParse(f.content),
          head = z.strictObject({ id: uuid, revisionId: uuid }).safeParse(f.current);
        if (
          !body.success ||
          !head.success ||
          f.state !== 'current' ||
          !same(body.data.id, ref.id) ||
          !same(body.data.run_id, r.id) ||
          body.data.step_id !== a.stepId ||
          !same(body.data.revision_id, ref.revisionId) ||
          !same(head.data.id, ref.id) ||
          !same(head.data.revisionId, ref.revisionId) ||
          expectedRef.progress.state !== body.data.state ||
          expectedRef.progress.occurredAt === null ||
          Date.parse(expectedRef.progress.occurredAt) !== Date.parse(body.data.occurred_at)
        )
          block(`${path}.${a.stepId}`, 'actual_membership_mismatch');
      } else {
        // Typed stored bodies are facts, not provider/health processing admission.
        const retained =
          ref.kind === 'intake'
            ? intakePort.get(JSON.stringify([ref.id, ref.revisionId.toLowerCase()]))
            : undefined;
        const matchesRetained =
          intakePortValid &&
          retained !== undefined &&
          retained.state === f.state &&
          retained.reason === f.reason &&
          equal(retained.content, f.content) &&
          retained.current !== null &&
          equal(
            {
              id: retained.current.id,
              revision: retained.current.revision,
              revisionId: retained.current.revisionId,
              status: retained.current.status,
            },
            f.current,
          ) &&
          retained.current.contentDigest === intake.get(retained.requested.id)?.contentDigest;
        if (!matchesRetained && !(ref.kind === 'activity' && activityPortValid))
          block(`${path}.${a.stepId}`, 'actual_permission_port_missing');
        if (ref.kind === 'activity') {
          const roster = activities.get(ref.id.toLowerCase()),
            body = activityContent.safeParse(f.content);
          const head = z
            .strictObject({ id: uuid, revision, deleted: z.boolean() })
            .safeParse(f.current);
          if (
            !roster ||
            !head.success ||
            !same(head.data.id, ref.id) ||
            head.data.revision !== roster.revision ||
            head.data.deleted !== roster.deleted ||
            !/^([1-9][0-9]*)$/.test(ref.revisionId) ||
            Number(ref.revisionId) > roster.revision ||
            ref.allocationId !== null
          )
            block(path, 'actual_membership_mismatch');
          if (f.state === 'deleted') {
            if (!roster?.deleted || f.content !== null) block(path, 'actual_membership_mismatch');
          } else if (
            !body.success ||
            !roster ||
            roster.deleted ||
            Number(ref.revisionId) !== roster.revision ||
            f.state !== 'current' ||
            digest(body.data.original) !== roster.originalDigest ||
            digest(body.data.overlay) !== roster.overlayDigest ||
            (ref.detailId === null
              ? body.data.detail !== null
              : !body.data.detail ||
                !same(body.data.detail.id, ref.detailId) ||
                !same(body.data.detail.activity_id, ref.id))
          )
            block(path, 'actual_membership_mismatch');
        } else if (ref.kind === 'intake') {
          const roster = intake.get(ref.id),
            body = intakeEntryRecordSchema.safeParse(f.content),
            head = z
              .strictObject({
                id: opaque,
                revision,
                revisionId: uuid,
                status: z.enum(['active', 'deleted']),
              })
              .safeParse(f.current);
          if (
            !head.success ||
            !roster ||
            head.data.id !== roster.id ||
            head.data.revision !== roster.revision ||
            !same(head.data.revisionId, roster.revisionId) ||
            head.data.status !== roster.status
          )
            block(path, 'actual_membership_mismatch');
          if (!roster) block(path, 'actual_membership_mismatch');
          if (f.state === 'deleted') {
            if (roster?.status !== 'deleted' || f.content !== null)
              block(path, 'actual_membership_mismatch');
          } else if (
            !body.success ||
            body.data.status !== 'active' ||
            body.data.intakeId !== ref.id ||
            !same(body.data.revisionId, ref.revisionId) ||
            !roster ||
            body.data.revision > roster.revision ||
            (f.state === 'current') !== same(ref.revisionId, roster.revisionId) ||
            (f.state === 'current' && digest(body.data) !== roster.contentDigest)
          )
            block(path, 'actual_membership_mismatch');
        } else if (ref.kind === 'checkin') {
          const head = z
            .strictObject({ id: uuid, revision, deleted: z.boolean() })
            .safeParse(f.current);
          if (
            !head.success ||
            !same(head.data.id, ref.id) ||
            !/^([1-9][0-9]*)$/.test(ref.revisionId) ||
            Number(ref.revisionId) > head.data.revision ||
            (f.state === 'deleted'
              ? !head.data.deleted || f.content !== null
              : head.data.deleted ||
                !checkInValuesSchema.safeParse(f.content).success ||
                (f.state === 'current') !== (Number(ref.revisionId) === head.data.revision))
          )
            block(path, 'actual_membership_mismatch');
        } else block(path, 'actual_source_unavailable');
      }
    }
    const read = timers.get(r.id.toLowerCase());
    if (!read) block(path, 'timer_inventory_missing');
    else {
      if (!equal(read.run, r)) block(path, 'timer_source_mismatch');
      const timerSteps = new Set<string>();
      for (const t of read.timers) {
        if (
          timerSteps.has(t.stepId) ||
          !same(t.runId, r.id) ||
          !steps.has(t.stepId) ||
          t.revision < 1 ||
          t.revision > 2147483646 ||
          !Number.isSafeInteger(t.pausedMilliseconds) ||
          (t.state === 'paused') !== (t.pausedAt !== null)
        )
          block(path, 'timer_source_mismatch');
        timerSteps.add(t.stepId);
      }
    }
  }
  for (const o of occurrences.values())
    if (
      o.startedRun.state === 'present' &&
      !same(started.get(o.record.id.toLowerCase()) ?? '', o.startedRun.runId)
    )
      block(`occurrence:${o.record.id}`, 'source_identity_mismatch');
  if ([...timers.keys()].some((key) => !runs.has(key)))
    block('timerReads', 'timer_source_mismatch');
  if (m.uniqueSourceCount !== schedules.size + blueprints.size + cache.size)
    block('uniqueSourceCount', 'source_identity_mismatch');
  return result(c);
}
