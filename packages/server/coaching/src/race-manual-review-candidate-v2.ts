import { createHash } from 'node:crypto';
import { z } from 'zod';
import { nutritionPlanItemCoreSchema } from '@workout/contracts/nutrition-core';
import {
  itemRaceTimingBindingSchema,
  raceTimingPinV1Schema,
} from '@workout/contracts/nutrition-race-timing';
import {
  raceRelativeScheduleImpactInputCompatibleV4Schema,
  projectRaceRelativeScheduleImpactCompatibleV4,
  type RaceScheduleCalculationPortsCompatibleV4,
} from './race-relative-schedule-impact.js';
import { raceRelativeScheduleImpactResultCompatibleV4BodySchema } from './race-relative-schedule-impact-codecs.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const revision = z.number().int().min(1).max(2147483647);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const itemId = nutritionPlanItemCoreSchema.shape.id;
const priorBinding = z.union([
  itemRaceTimingBindingSchema.shape.binding,
  z.strictObject({ state: z.literal('legacy_unpinned') }),
]);
export const raceManualReviewCandidateV2SourceFactsSchema = z.strictObject({
  ownerAthleteId: z.string().min(1).max(200),
  nutritionRacePins: z
    .array(z.strictObject({ nutritionVersionId: uuid, itemId, binding: priorBinding }))
    .max(5000),
});
const bindingSchema = z.strictObject({
  purpose: z.literal('manual_race_date_change'),
  event: z.strictObject({ id: uuid, revision }),
  appRevision: revision,
  policy: z.strictObject({
    id: z.literal('manual-race-date-impact'),
    version: z.literal(1),
    digest: hash,
  }),
  restoreGeneration: uuid,
  readSetDigest: hash,
});
const plainGuard = z.unknown().superRefine((value, ctx) => {
  try {
    const visiting = new WeakSet<object>();
    let nodes = 0;
    function visit(v: unknown, depth: number): void {
      // A serialized JSON node needs at least one byte; the root is included.
      if (++nodes > 4194305 || depth > 64) throw Error('bound');
      if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
      if (typeof v === 'number') {
        if (!Number.isFinite(v)) throw Error('number');
        return;
      }
      if (typeof v !== 'object' || visiting.has(v)) throw Error('plain');
      if (
        !Array.isArray(v) &&
        Object.getPrototypeOf(v) !== Object.prototype &&
        Object.getPrototypeOf(v) !== null
      )
        throw Error('plain');
      visiting.add(v);
      const properties = Object.getOwnPropertyDescriptors(v);
      if (Reflect.ownKeys(v).some((key) => typeof key !== 'string')) throw Error('symbol');
      for (const [key, descriptor] of Object.entries(properties)) {
        if (Array.isArray(v) && key === 'length') continue;
        if (descriptor.get || descriptor.set || !descriptor.enumerable) throw Error('accessor');
        visit(descriptor.value, depth + 1);
      }
      if (Array.isArray(v) && Object.keys(v).length !== v.length) throw Error('sparse');
      visiting.delete(v);
    }
    visit(value, 0);
    const json = JSON.stringify(value);
    if (json === undefined || Buffer.byteLength(json, 'utf8') > 4194304) throw Error('bytes');
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid or oversized plain JSON review boundary' });
  }
});
const inputBody = z.strictObject({
  athleteId: z.string().min(1).max(200),
  binding: bindingSchema,
  projectionInput: raceRelativeScheduleImpactInputCompatibleV4Schema,
  sourceFacts: raceManualReviewCandidateV2SourceFactsSchema,
});
export const raceManualReviewCandidateV2InputSchema = plainGuard.pipe(inputBody);
const projectedSchema = raceRelativeScheduleImpactResultCompatibleV4BodySchema.transform(
  (value, ctx) => {
    if (value.status !== 'projected') {
      ctx.addIssue({ code: 'custom', message: 'Readonly draft needs projected body' });
      return z.NEVER;
    }
    return value;
  },
);
const transitionSchema = z.strictObject({
  nutritionVersionId: uuid,
  itemId,
  priorBinding,
  savedPin: raceTimingPinV1Schema.nullable(),
  state: z.enum(['preserved', 'requires_explicit_review']),
  proposedCurrentSource: z.strictObject({ eventId: uuid, eventRevision: revision }).nullable(),
  proposedTarget: z.strictObject({ eventId: uuid, eventRevision: revision }).nullable(),
  allocation: z.literal('not_allocated'),
});
const coverage = z.strictObject({
  complete: z.literal(false),
  missing: z.tuple([
    z.literal('complete_catalog_and_actual_manifest'),
    z.literal('supplementary_reference_manifest'),
    z.literal('routine_occurrences_and_started_runs'),
    z.literal('complete_source_permission_manifest'),
    z.literal('manual_purpose_app_and_policy_binding'),
  ]),
});
const limitations = {
  storage: 'not_persisted' as const,
  sourceCompleteness: 'unverified' as const,
  approvalAllowed: false as const,
  authority: 'none' as const,
  freshness: 'not_checked' as const,
};
const limitationShape = {
  storage: z.literal('not_persisted'),
  sourceCompleteness: z.literal('unverified'),
  approvalAllowed: z.literal(false),
  authority: z.literal('none'),
  freshness: z.literal('not_checked'),
};
const bodySchema = z.strictObject({
  schemaVersion: z.literal(2),
  methodVersion: z.literal('manual-race-review-draft-v2'),
  ...inputBody.shape,
  projection: projectedSchema,
  pinTransitions: z.array(transitionSchema).max(5000),
  unresolvedBindingItems: z
    .array(
      z.strictObject({
        nutritionVersionId: uuid,
        itemId,
        reason: z.literal('race_binding_unavailable'),
      }),
    )
    .max(5000),
  coverage,
  ...limitationShape,
});
export const raceManualReviewCandidateV2BodySchema = plainGuard
  .pipe(bodySchema)
  .superRefine((value, ctx) => {
    const original = value.projectionInput.retainedUnplannedRuns;
    const projected = value.projection.retainedUnplannedRuns;
    const sorted = (rows: NonNullable<typeof original>) =>
      [...rows].sort((a, b) => compare(a.run.id, b.run.id));
    if (
      (original === undefined) !== (projected === undefined) ||
      canonical(sorted(original ?? [])) !==
        canonical(sorted((projected ?? []).map(({ blueprint, run }) => ({ blueprint, run }))))
    )
      ctx.addIssue({ code: 'custom', message: 'Retained unplanned source/output roster mismatch' });
  });
const reasonSchema = z.enum([
  'invalid_input',
  'projection_bound',
  'foreign_source_scope',
  'binding_mismatch',
  'duplicate_pin_fact',
  'unmatched_pin_fact',
  'pin_source_mismatch',
  'race_revision_overflow',
  'invalid_projection_output',
  'calculation_unavailable',
]);
export const raceManualReviewCandidateV2ResultSchema = plainGuard.pipe(
  z
    .discriminatedUnion('status', [
      z.strictObject({
        kind: z.literal('manual-race-review-draft-v2'),
        status: z.literal('rejected'),
        reason: z.union([
          reasonSchema,
          raceRelativeScheduleImpactResultCompatibleV4BodySchema.options[0].shape.reason,
        ]),
        ...limitationShape,
      }),
      z.strictObject({
        kind: z.literal('manual-race-review-draft-v2'),
        status: z.literal('assembled_readonly'),
        digest: hash,
        body: raceManualReviewCandidateV2BodySchema,
        ...limitationShape,
      }),
    ])
    .superRefine((value, ctx) => {
      if (
        value.status === 'assembled_readonly' &&
        createHash('sha256').update(canonical(value.body), 'utf8').digest('hex') !== value.digest
      ) {
        ctx.addIssue({ code: 'custom', message: 'Draft body checksum mismatch' });
      }
    }),
);
export type RaceManualReviewCandidateV2Input = z.infer<
  typeof raceManualReviewCandidateV2InputSchema
>;
export type RaceManualReviewCandidateV2Body = z.infer<typeof raceManualReviewCandidateV2BodySchema>;
export type RaceManualReviewCandidateV2Result = z.infer<
  typeof raceManualReviewCandidateV2ResultSchema
>;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const json = JSON.stringify(value);
    if (json === undefined) throw Error('plain');
    return json;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => compare(a, b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(',')}}`;
}
function freeze(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}
const key = (version: string, id: string) => JSON.stringify([version, id]);
function reject(
  reason:
    | z.infer<typeof reasonSchema>
    | z.infer<
        (typeof raceRelativeScheduleImpactResultCompatibleV4BodySchema.options)[0]['shape']['reason']
      >,
) {
  return raceManualReviewCandidateV2ResultSchema.parse({
    kind: 'manual-race-review-draft-v2',
    status: 'rejected',
    reason,
    ...limitations,
  });
}

/** Domain-only transient assembly. Supplied ownership/policy/binding facts are
 * not authenticated; no capture, source inventory, prepare seal or receipt is minted. */
export function assembleRaceManualReviewCandidateCompatibleV4(
  raw: unknown,
  ports: RaceScheduleCalculationPortsCompatibleV4,
): RaceManualReviewCandidateV2Result {
  try {
    const checked = raceManualReviewCandidateV2InputSchema.safeParse(raw);
    if (!checked.success) return reject('invalid_input');
    const input = checked.data,
      p = input.projectionInput;
    if (input.athleteId !== input.sourceFacts.ownerAthleteId) return reject('foreign_source_scope');
    if (input.binding.event.id !== p.event.id || input.binding.event.revision !== p.event.revision)
      return reject('binding_mismatch');
    const changes = p.event.localDate !== p.newLocalDate;
    if (changes && p.event.revision === 2147483647) return reject('race_revision_overflow');
    const pins = new Map(
      input.sourceFacts.nutritionRacePins.map((fact) => [
        key(fact.nutritionVersionId, fact.itemId),
        fact,
      ]),
    );
    if (pins.size !== input.sourceFacts.nutritionRacePins.length)
      return reject('duplicate_pin_fact');
    const projectionResult = projectRaceRelativeScheduleImpactCompatibleV4(
      structuredClone(p),
      ports,
    );
    const decoded =
      raceRelativeScheduleImpactResultCompatibleV4BodySchema.safeParse(projectionResult);
    if (!decoded.success) return reject('invalid_projection_output');
    if (decoded.data.status !== 'projected') return reject(decoded.data.reason);
    const projection = decoded.data,
      transitions: z.infer<typeof transitionSchema>[] = [],
      unresolved: z.infer<typeof bodySchema.shape.unresolvedBindingItems> = [];
    const consumed = new Set<string>();
    let visits = input.sourceFacts.nutritionRacePins.length;
    for (const row of p.retainedUnplannedRuns ?? []) {
      visits += 1 + row.blueprint.steps.length + row.run.progress.length;
      for (const progress of row.run.progress) visits += progress.actualRefs.length;
    }
    for (const context of projection.nutrition) {
      visits += context.items.length;
      for (const entry of context.items) {
        const original = context.record.items.find((item) => item.id === entry.itemId);
        if (!original) return reject('pin_source_mismatch');
        if (original.anchor.kind !== 'relative' || original.anchor.entity !== 'race') continue;
        const identity = key(context.planVersionId, entry.itemId),
          fact = pins.get(identity);
        if (!fact) return reject('unmatched_pin_fact');
        consumed.add(identity);
        const stored =
          'schemaVersion' in context.record
            ? context.record.itemRaceTimingBindings.find((row) => row.itemId === entry.itemId)
                ?.binding
            : { state: 'legacy_unpinned' as const };
        if (!stored || canonical(stored) !== canonical(fact.binding))
          return reject('pin_source_mismatch');
        const prior = fact.binding;
        const saved =
          prior.state === 'captured' && 'schemaVersion' in context.record
            ? (context.record.raceTimingPins.find(
                (pin) => pin.eventId === prior.eventId && pin.eventRevision === prior.eventRevision,
              ) ?? null)
            : null;
        if (
          prior.state === 'captured' &&
          (!saved ||
            prior.eventId !== original.anchor.entityId ||
            (prior.eventId === p.event.id && prior.eventRevision > p.event.revision))
        )
          return reject('pin_source_mismatch');
        const affected = entry.state === 'affected';
        if (affected && prior.state === 'legacy_unpinned')
          unresolved.push({
            nutritionVersionId: context.planVersionId,
            itemId: entry.itemId,
            reason: 'race_binding_unavailable',
          });
        transitions.push({
          nutritionVersionId: context.planVersionId,
          itemId: entry.itemId,
          priorBinding: prior,
          savedPin: saved,
          state: affected ? 'requires_explicit_review' : 'preserved',
          proposedCurrentSource: affected
            ? { eventId: p.event.id, eventRevision: p.event.revision }
            : null,
          proposedTarget:
            affected && entry.item.anchor.kind === 'relative' && entry.item.anchor.entity === 'race'
              ? { eventId: p.event.id, eventRevision: p.event.revision + (changes ? 1 : 0) }
              : null,
          allocation: 'not_allocated',
        });
      }
    }
    if (consumed.size !== pins.size) return reject('unmatched_pin_fact');
    if (visits > 5000) return reject('projection_bound');
    // Normalize only declared set rosters. Immutable record arrays and semantic
    // steps/progress/foods remain byte-for-byte structured values from the source.
    const sort = <T>(rows: readonly T[], identity: (row: T) => string) =>
      [...rows].sort((a, b) => compare(identity(a), identity(b)));
    const normalizedInput = {
      ...p,
      ...(p.retainedUnplannedRuns === undefined
        ? {}
        : {
            retainedUnplannedRuns: sort(p.retainedUnplannedRuns, (row) => row.run.id),
          }),
      sourcePlans: sort(p.sourcePlans, (row) => row.id),
      completionReports: sort(p.completionReports, (row) => row.sessionId),
      nutrition: sort(p.nutrition, (row) => row.record.versionId).map((row) => ({
        ...row,
        timings: sort(row.timings, (timing) => timing.itemId),
      })),
      routines: sort(p.routines, (row) => row.record.versionId).map((row) => ({
        ...row,
        occurrences: sort(row.occurrences, (row) => row.id),
        runs: sort(row.runs, (row) => row.id),
      })),
      resolutions: {
        nutrition: sort(p.resolutions.nutrition, (row) => key(row.planVersionId, row.itemId)),
        routines: sort(p.resolutions.routines, (row) => row.scheduleVersionId),
      },
    };
    const normalizedProjection = {
      ...projection,
      ...(projection.retainedUnplannedRuns === undefined
        ? {}
        : {
            retainedUnplannedRuns: sort(projection.retainedUnplannedRuns, (row) => row.run.id),
          }),
      nutrition: sort(projection.nutrition, (row) => row.planVersionId).map((row) => ({
        ...row,
        items: sort(row.items, (entry) => entry.itemId),
      })),
      routines: sort(projection.routines, (row) => row.scheduleVersionId).map((row) => ({
        ...row,
        occurrences: sort(row.occurrences, (item) => item.id),
        runs: sort(row.runs, (item) => item.id),
        ...(row.state === 'affected'
          ? {
              projection: {
                ...row.projection,
                plannedOccurrences: sort(row.projection.plannedOccurrences, (item) => item.id),
                retainedOccurrences: sort(row.projection.retainedOccurrences, (item) => item.id),
                expansion:
                  row.projection.expansion.state === 'expanded'
                    ? {
                        ...row.projection.expansion,
                        occurrences: sort(row.projection.expansion.occurrences, (item) => item.id),
                      }
                    : row.projection.expansion,
              },
            }
          : {}),
      })),
      completionReports: sort(projection.completionReports, (row) => row.sessionId),
    };
    const body = raceManualReviewCandidateV2BodySchema.safeParse({
      schemaVersion: 2,
      methodVersion: 'manual-race-review-draft-v2',
      athleteId: input.athleteId,
      binding: input.binding,
      projectionInput: normalizedInput,
      sourceFacts: {
        ...input.sourceFacts,
        nutritionRacePins: sort(input.sourceFacts.nutritionRacePins, (row) =>
          key(row.nutritionVersionId, row.itemId),
        ),
      },
      projection: normalizedProjection,
      pinTransitions: sort(transitions, (row) => key(row.nutritionVersionId, row.itemId)),
      unresolvedBindingItems: sort(unresolved, (row) => key(row.nutritionVersionId, row.itemId)),
      coverage: {
        complete: false,
        missing: [
          'complete_catalog_and_actual_manifest',
          'supplementary_reference_manifest',
          'routine_occurrences_and_started_runs',
          'complete_source_permission_manifest',
          'manual_purpose_app_and_policy_binding',
        ],
      },
      ...limitations,
    });
    if (!body.success) return reject('projection_bound');
    const digest = createHash('sha256').update(canonical(body.data), 'utf8').digest('hex');
    const result = raceManualReviewCandidateV2ResultSchema.parse({
      kind: 'manual-race-review-draft-v2',
      status: 'assembled_readonly',
      digest,
      body: body.data,
      ...limitations,
    });
    freeze(result);
    return result;
  } catch {
    return reject('calculation_unavailable');
  }
}
