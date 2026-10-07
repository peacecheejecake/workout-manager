import { createHash } from 'node:crypto';
import { z } from 'zod';
import { planSnapshotSchema } from '@workout/contracts/planning';
import {
  routineScheduleVersionSchema,
  routineBlueprintVersionSchema,
  routineOccurrenceSchema,
  routineRunSchema,
} from '@workout/contracts/routines';
import { sessionCompletionSchema } from '@workout/contracts/session-completion';
import { raceManualReviewCandidateV2ResultSchema } from '@workout/server-coaching/race-manual-review-candidate-v2';

const uuid = z.uuid().transform((v) => v.toLowerCase());
const opaque = z.string().min(1);
const revision = z.number().int().nonnegative().max(2147483647);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identitySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('race-event'), sourceId: uuid, revision }),
  z.strictObject({
    kind: z.literal('plan-snapshot'),
    sourceId: planSnapshotSchema.shape.id,
    version: planSnapshotSchema.shape.version,
  }),
  z.strictObject({ kind: z.literal('nutrition-plan-version'), sourceId: uuid, versionId: uuid }),
  z.strictObject({
    kind: z.literal('routine-schedule-version'),
    sourceId: routineScheduleVersionSchema.shape.id,
    versionId: routineScheduleVersionSchema.shape.versionId,
  }),
  z.strictObject({
    kind: z.literal('routine-blueprint-version'),
    sourceId: routineBlueprintVersionSchema.shape.routineId,
    versionId: routineBlueprintVersionSchema.shape.versionId,
  }),
  z.strictObject({
    kind: z.literal('routine-occurrence'),
    sourceId: routineOccurrenceSchema.shape.id,
  }),
  z.strictObject({
    kind: z.literal('routine-run'),
    sourceId: routineRunSchema.shape.id,
    revision: routineRunSchema.shape.revision,
  }),
  z.strictObject({
    kind: z.literal('session-completion'),
    sourceId: sessionCompletionSchema.shape.sessionId,
    planVersionId: sessionCompletionSchema.shape.planVersionId,
    revision: sessionCompletionSchema.shape.revision,
  }),
]);
type Identity = z.infer<typeof identitySchema>;
const entrySchema = z.strictObject({
  identity: identitySchema,
  digestMethod: z.literal('dto-object-key-canonical-sha256-v1'),
  dtoDigest: digest,
  copiedLocations: z.array(opaque).min(1).max(5000),
});
const observationSchema = z.strictObject({
  kind: z.enum(['race-timing-pin', 'binding', 'timing', 'identity-only']),
  location: opaque,
  sourceIdentity: identitySchema.nullable(),
  digestMethod: z.literal('dto-fragment-object-key-canonical-sha256-v1'),
  dtoDigest: digest,
});
const derivedSchema = z.strictObject({
  digestMethod: z.literal('dto-derived-object-key-canonical-sha256-v1'),
  kind: z.enum(['calendar', 'nutrition-items', 'routine-projection']),
  location: opaque,
  sourceIdentities: z.array(identitySchema).max(5000),
  dtoDigest: digest,
});
const notCopied = [
  'food-definitions',
  'recovery-bodies',
  'supplementary-catalogs',
  'manual-actual-bodies',
  'course-geometry',
  'resource-text',
  'media-descriptors',
  'timer-facts',
] as const;
const inventoryBodySchema = z.strictObject({
  inventoryVersion: z.literal(2),
  scope: z.literal('candidate_v2_copied_full_bodies_only'),
  inventoryState: z.enum(['mapped', 'blocked']),
  allCopiedBodiesIndexed: z.boolean(),
  refs: z.array(entrySchema).max(5000),
  fragments: z.array(observationSchema).max(5000),
  derived: z.array(derivedSchema).max(5000),
  referenceOnly: z.array(observationSchema).max(5000),
  notCopied: z
    .array(z.enum(notCopied))
    .length(notCopied.length)
    .refine(
      (values) => values.every((v, i) => v === notCopied[i]),
      'Exact absent-channel roster required',
    ),
  blockers: z
    .array(
      z.strictObject({
        reason: z.enum([
          'invalid_candidate',
          'candidate_not_assembled',
          'reference_bound',
          'divergent_copied_body',
          'invalid_source_identity',
          'inventory_bound',
        ]),
        location: opaque,
      }),
    )
    .max(5000),
  candidateCoverage: z
    .strictObject({ complete: z.literal(false), missing: z.array(opaque).max(5) })
    .nullable(),
  storage: z.literal('not_persisted'),
  sourceCompleteness: z.literal('unverified'),
  approvalAllowed: z.literal(false),
  authority: z.literal('none'),
  freshness: z.literal('not_checked'),
});
/** External inventory decoding checks plain JSON before accessing fields.
 * The entire decoded/output aggregate retains the successor 4MiB budget. */
export const raceManualReviewSourceInventoryV2Schema = z
  .unknown()
  .superRefine((value, ctx) => {
    const parents = new Set<object>();
    let nodes = 0;
    function visit(v: unknown, depth: number): void {
      if (++nodes > 4194305 || depth > 64) throw Error('bound');
      if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
      if (typeof v === 'number' && Number.isFinite(v)) return;
      if (typeof v !== 'object' || parents.has(v) || Object.getOwnPropertySymbols(v).length)
        throw Error('plain');
      if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype) throw Error('plain');
      const descriptors = Object.getOwnPropertyDescriptors(v);
      if (
        Array.isArray(v) &&
        (Object.keys(v).length !== v.length ||
          Object.getOwnPropertyNames(v).length !== v.length + 1)
      )
        throw Error('plain');
      parents.add(v);
      for (const [key, d] of Object.entries(descriptors)) {
        if (Array.isArray(v) && key === 'length') continue;
        if (!d.enumerable || !('value' in d)) throw Error('plain');
        visit(d.value, depth + 1);
      }
      parents.delete(v);
    }
    try {
      visit(value, 0);
      if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 4194304) throw Error('bound');
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Inventory exceeds plain JSON aggregate boundary' });
    }
  })
  .pipe(inventoryBodySchema);
export type RaceManualReviewSourceInventoryV2 = z.infer<
  typeof raceManualReviewSourceInventoryV2Schema
>;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  const result = JSON.stringify(value);
  if (result === undefined) throw Error('INVALID_JSON');
  return result;
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
/** Pure structural enumeration, not an owned-source lookup, historical row
 * digest, lifecycle seal, freshness check or permission to persist. Full parent
 * bodies cover their nested content; finite fragments retain separate namespaces.
 * Semantic arrays are never sorted. The caller must inventory a separately
 * retained capture/context separately: those bodies are absent from this input. */
export function enumerateRaceManualReviewCopiedSourcesV2(
  raw: unknown,
): RaceManualReviewSourceInventoryV2 {
  const output: RaceManualReviewSourceInventoryV2 = {
    inventoryVersion: 2,
    scope: 'candidate_v2_copied_full_bodies_only',
    inventoryState: 'blocked',
    allCopiedBodiesIndexed: false,
    refs: [],
    fragments: [],
    derived: [],
    referenceOnly: [],
    notCopied: [...notCopied],
    blockers: [],
    candidateCoverage: null,
    storage: 'not_persisted',
    sourceCompleteness: 'unverified',
    approvalAllowed: false,
    authority: 'none',
    freshness: 'not_checked',
  };
  const candidate = raceManualReviewCandidateV2ResultSchema.safeParse(raw);
  if (!candidate.success) {
    output.blockers.push({ reason: 'invalid_candidate', location: 'candidate' });
    return raceManualReviewSourceInventoryV2Schema.parse(output);
  }
  if (candidate.data.status !== 'assembled_readonly') {
    output.blockers.push({ reason: 'candidate_not_assembled', location: 'candidate' });
    return raceManualReviewSourceInventoryV2Schema.parse(output);
  }
  const body = candidate.data.body;
  output.candidateCoverage = body.coverage;
  let visited = 0;
  const entries = new Map<string, z.infer<typeof entrySchema>>();
  function visit() {
    if (++visited > 5000) throw Error('REFERENCE_BOUND');
  }
  function add(identity: Identity, value: unknown, location: string) {
    visit();
    const normalized = identitySchema.parse(identity),
      key = canonical(normalized),
      dtoDigest = hash(value);
    const prior = entries.get(key);
    if (prior) {
      if (prior.dtoDigest !== dtoDigest)
        output.blockers.push({ reason: 'divergent_copied_body', location });
      prior.copiedLocations.push(location);
    } else
      entries.set(key, {
        identity: normalized,
        digestMethod: 'dto-object-key-canonical-sha256-v1',
        dtoDigest,
        copiedLocations: [location],
      });
    return normalized;
  }
  function observe(
    target: typeof output.fragments,
    kind: z.infer<typeof observationSchema>['kind'],
    value: unknown,
    location: string,
    sourceIdentity: Identity | null = null,
  ) {
    visit();
    target.push({
      kind,
      location,
      sourceIdentity: sourceIdentity === null ? null : identitySchema.parse(sourceIdentity),
      digestMethod: 'dto-fragment-object-key-canonical-sha256-v1',
      dtoDigest: hash(value),
    });
  }
  function derived(
    kind: z.infer<typeof derivedSchema>['kind'],
    value: unknown,
    sourceIdentities: Identity[],
    location: string,
  ) {
    visit();
    for (const _identity of sourceIdentities) visit();
    output.derived.push({
      kind,
      location,
      sourceIdentities,
      digestMethod: 'dto-derived-object-key-canonical-sha256-v1',
      dtoDigest: hash(value),
    });
  }
  try {
    const p = body.projectionInput;
    const race = add(
      { kind: 'race-event', sourceId: p.event.id, revision: p.event.revision },
      p.event,
      'body.projectionInput.event',
    );
    const plans: Identity[] = [];
    for (const [index, plan] of p.sourcePlans.entries())
      plans.push(
        add(
          { kind: 'plan-snapshot', sourceId: plan.id, version: plan.version },
          plan,
          `body.projectionInput.sourcePlans[${index}]`,
        ),
      );
    if (p.currentPlan)
      plans.push(
        add(
          { kind: 'plan-snapshot', sourceId: p.currentPlan.id, version: p.currentPlan.version },
          p.currentPlan,
          'body.projectionInput.currentPlan',
        ),
      );
    derived('calendar', body.projection.calendar, [race, ...plans], 'body.projection.calendar');
    const nutrition = (record: (typeof p.nutrition)[number]['record'], location: string) => {
      const identity = add(
        { kind: 'nutrition-plan-version', sourceId: record.planId, versionId: record.versionId },
        record,
        location,
      );
      if ('raceTimingPins' in record)
        for (const [i, pin] of record.raceTimingPins.entries())
          observe(output.fragments, 'race-timing-pin', pin, `${location}.raceTimingPins[${i}]`, {
            kind: 'race-event',
            sourceId: pin.eventId,
            revision: pin.eventRevision,
          });
      return identity;
    };
    for (const [i, context] of p.nutrition.entries()) {
      nutrition(context.record, `body.projectionInput.nutrition[${i}].record`);
      observe(
        output.fragments,
        'timing',
        context.timings,
        `body.projectionInput.nutrition[${i}].timings`,
      );
    }
    for (const [i, projected] of body.projection.nutrition.entries()) {
      const identity = nutrition(projected.record, `body.projection.nutrition[${i}].record`);
      derived(
        'nutrition-items',
        projected.items,
        [identity, race],
        `body.projection.nutrition[${i}].items`,
      );
    }
    const routine = (
      context: (typeof p.routines)[number] | (typeof body.projection.routines)[number],
      location: string,
    ) => {
      const schedule = add(
        {
          kind: 'routine-schedule-version',
          sourceId: context.record.id,
          versionId: context.record.versionId,
        },
        context.record,
        `${location}.record`,
      );
      add(
        {
          kind: 'routine-blueprint-version',
          sourceId: context.blueprint.routineId,
          versionId: context.blueprint.versionId,
        },
        context.blueprint,
        `${location}.blueprint`,
      );
      for (const [i, occurrence] of context.occurrences.entries())
        add(
          { kind: 'routine-occurrence', sourceId: occurrence.id },
          occurrence,
          `${location}.occurrences[${i}]`,
        );
      for (const [i, run] of context.runs.entries())
        add(
          { kind: 'routine-run', sourceId: run.id, revision: run.revision },
          run,
          `${location}.runs[${i}]`,
        );
      return schedule;
    };
    const retainedUnplanned = (rows: NonNullable<typeof p.retainedUnplannedRuns>, prefix: string) =>
      rows.forEach((row, i) => {
        add(
          {
            kind: 'routine-blueprint-version',
            sourceId: row.blueprint.routineId,
            versionId: row.blueprint.versionId,
          },
          row.blueprint,
          `${prefix}[${i}].blueprint`,
        );
        add(
          { kind: 'routine-run', sourceId: row.run.id, revision: row.run.revision },
          row.run,
          `${prefix}[${i}].run`,
        );
      });
    retainedUnplanned(p.retainedUnplannedRuns ?? [], 'body.projectionInput.retainedUnplannedRuns');
    retainedUnplanned(
      body.projection.retainedUnplannedRuns ?? [],
      'body.projection.retainedUnplannedRuns',
    );
    for (const [i, context] of p.routines.entries())
      routine(context, `body.projectionInput.routines[${i}]`);
    for (const [i, context] of body.projection.routines.entries()) {
      const schedule = routine(context, `body.projection.routines[${i}]`);
      if (context.state === 'affected') {
        for (const [j, occurrence] of context.projection.retainedOccurrences.entries())
          add(
            { kind: 'routine-occurrence', sourceId: occurrence.id },
            occurrence,
            `body.projection.routines[${i}].projection.retainedOccurrences[${j}]`,
          );
        derived(
          'routine-projection',
          context.projection,
          [
            schedule,
            race,
            ...plans.filter(
              (identity) =>
                identity.kind === 'plan-snapshot' &&
                identity.sourceId === p.routines[i]?.sourcePlanVersionId,
            ),
          ],
          `body.projection.routines[${i}].projection`,
        );
      }
    }
    for (const [prefix, reports] of [
      ['body.projectionInput.completionReports', p.completionReports],
      ['body.projection.completionReports', body.projection.completionReports],
    ] as const)
      for (const [i, report] of reports.entries())
        add(
          {
            kind: 'session-completion',
            sourceId: report.sessionId,
            planVersionId: report.planVersionId,
            revision: report.revision,
          },
          report,
          `${prefix}[${i}]`,
        );
    for (const [i, transition] of body.pinTransitions.entries()) {
      if (transition.savedPin)
        observe(
          output.fragments,
          'race-timing-pin',
          transition.savedPin,
          `body.pinTransitions[${i}].savedPin`,
          {
            kind: 'race-event',
            sourceId: transition.savedPin.eventId,
            revision: transition.savedPin.eventRevision,
          },
        );
      observe(
        output.fragments,
        'binding',
        transition.priorBinding,
        `body.pinTransitions[${i}].priorBinding`,
      );
      observe(
        output.referenceOnly,
        'identity-only',
        {
          proposedCurrentSource: transition.proposedCurrentSource,
          proposedTarget: transition.proposedTarget,
          allocation: transition.allocation,
        },
        `body.pinTransitions[${i}].proposedReferences`,
      );
    }
    observe(output.referenceOnly, 'binding', body.sourceFacts, 'body.sourceFacts');
    observe(output.referenceOnly, 'identity-only', body.binding, 'body.binding');
    observe(
      output.referenceOnly,
      'identity-only',
      p.resolutions,
      'body.projectionInput.resolutions',
    );
  } catch (error: unknown) {
    output.blockers.push({
      reason:
        error instanceof Error && error.message === 'REFERENCE_BOUND'
          ? 'reference_bound'
          : 'invalid_source_identity',
      location: 'candidate',
    });
  }
  output.refs = [...entries.values()];
  if (output.blockers.length === 0) {
    output.inventoryState = 'mapped';
    output.allCopiedBodiesIndexed = true;
  }
  if (Buffer.byteLength(JSON.stringify(output), 'utf8') > 4194304) {
    output.inventoryState = 'blocked';
    output.allCopiedBodiesIndexed = false;
    output.refs = [];
    output.fragments = [];
    output.derived = [];
    output.referenceOnly = [];
    output.blockers = [{ reason: 'inventory_bound', location: 'inventory' }];
  }
  return raceManualReviewSourceInventoryV2Schema.parse(output);
}
