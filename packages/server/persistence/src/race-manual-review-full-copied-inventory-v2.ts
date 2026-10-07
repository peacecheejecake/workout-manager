import { checkInValuesSchema } from '@workout/contracts/check-ins';
import { routineStepContentSchema } from '@workout/contracts/routines';
import { z } from 'zod';
import {
  raceManualReviewCandidateV2InputSchema,
  raceManualReviewCandidateV2ResultSchema,
  assembleRaceManualReviewCandidateCompatibleV4,
} from '@workout/server-coaching/race-manual-review-candidate-v2';
import { raceImpactConsumedCaptureSchema } from './race-plan-impact-complete-manifest.js';
import {
  buildRacePlanImpactProjectionInput,
  createRacePlanImpactCapturedCalculationPorts,
} from './race-plan-impact-projection-input.js';
import {
  enumerateRaceManualReviewCopiedSourcesV2,
  raceManualReviewSourceInventoryV2Schema,
} from './race-manual-review-source-inventory-v2.js';
import {
  impactDependencyDigest as digest,
  decodeIntegratedDependencyInventory,
} from './race-plan-impact-dependencies.js';
import { validateCourseReadManifest } from './race-plan-impact-course-manifest.js';
import { validateResourceRetainedReadFacts } from './race-plan-impact-resource-read-facts.js';
import { validateMediaRetainedReadFacts } from './race-plan-impact-media-read-facts.js';
import {
  manualActivityReadProjectionInputSchema,
  validateManualActivityReadFacts,
} from './race-plan-impact-manual-activity-read-facts.js';
import { validateManualIntakeReadFacts } from './race-plan-impact-intake-read-facts.js';
import { raceMediaCleanupSourceSchema } from './race-media-cleanup-source.js';

const limit = 4194304;
const uuid = z.uuid().transform((id) => id.toLowerCase());
const opaque = z.string().min(1);
const rev = z.number().int().min(0).max(2147483647);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const candidateRef = raceManualReviewSourceInventoryV2Schema.out.shape.refs.element;
const baseIdentity = candidateRef.shape.identity;
const versionIdentity = <K extends string>(kind: K) =>
  z.strictObject({ kind: z.literal(kind), sourceId: uuid, versionId: uuid });
const identitySchema = z.union([
  baseIdentity,
  z.strictObject({ kind: z.literal('food-definition-version'), sourceId: opaque, versionId: uuid }),
  versionIdentity('recovery-strategy-version'),
  versionIdentity('recovery-method-version'),
  versionIdentity('workout-template-version'),
  versionIdentity('supplementary-exercise-version'),
  versionIdentity('resource-text-version'),
  z.strictObject({
    kind: z.literal('supplementary-session-copy'),
    sourceId: uuid,
    sessionId: opaque,
  }),
  z.strictObject({
    kind: z.literal('manual-activity-source'),
    sourceId: uuid,
    sourceRecordId: opaque,
    sourceRevision: rev,
  }),
  z.strictObject({ kind: z.literal('activity-overlay'), sourceId: uuid, revision: rev }),
  z.strictObject({
    kind: z.literal('activity-canonical-values'),
    sourceId: uuid,
    revision: rev.min(1),
  }),
  z.strictObject({ kind: z.literal('intake-revision'), sourceId: opaque, revisionId: uuid }),
  z.strictObject({ kind: z.literal('checkin-revision'), sourceId: uuid, revision: rev.min(1) }),
  z.strictObject({
    kind: z.literal('checklist-confirmation'),
    sourceId: opaque,
    revisionId: uuid,
    runId: opaque,
    stepId: opaque,
  }),
  z.strictObject({
    kind: z.literal('course-revision'),
    sourceId: uuid,
    revisionId: uuid,
    revision: rev,
  }),
  z.strictObject({
    kind: z.literal('activity-track-descriptor'),
    sourceId: uuid,
    trackId: uuid,
    revision: rev,
  }),
  z.strictObject({
    kind: z.literal('race-timing-pin-fragment'),
    sourceId: uuid,
    revision: rev.min(1),
  }),
  z.strictObject({
    kind: z.literal('course-head-descriptor'),
    sourceId: uuid,
    revision: rev.min(1),
  }),
  z.strictObject({ kind: z.literal('gallery-descriptor'), sourceId: uuid, accessRevision: rev }),
  z.strictObject({
    kind: z.literal('routine-timer'),
    sourceId: opaque,
    stepId: opaque,
    revision: rev,
  }),
]);
type Identity = z.infer<typeof identitySchema>;
const refSchema = z.strictObject({
  identity: identitySchema,
  representation: z.enum(['immutable_body', 'mutable_observation', 'source_fragment']),
  dtoDigest: sha,
  digestMethod: z.literal('dto-object-key-canonical-sha256-v1'),
  copiedLocations: z.array(opaque).min(1).max(5000),
});
const blockerSchema = z.strictObject({
  location: opaque,
  reason: z.enum([
    'invalid_envelope',
    'correspondence_mismatch',
    'unindexable_body',
    'source_tuple_mismatch',
    'divergent_copied_body',
    'reference_bound',
    'inventory_bound',
  ]),
});
const diagnosticSchema = z.strictObject({
  location: opaque,
  state: z.enum(['absent', 'deleted', 'unavailable', 'metadata_only', 'reference_only']),
  dtoDigest: sha,
});
const resultBody = z.strictObject({
  inventoryVersion: z.literal(2),
  scope: z.literal('prepared_full_context_copied_bodies_only'),
  inventoryState: z.enum(['mapped', 'blocked']),
  allCopiedBodiesIndexed: z.boolean(),
  refs: z.array(refSchema).max(5000),
  diagnostics: z.array(diagnosticSchema).max(5000),
  blockers: z.array(blockerSchema).max(5000),
  candidateFragments: raceManualReviewSourceInventoryV2Schema.out.shape.fragments,
  candidateDerived: raceManualReviewSourceInventoryV2Schema.out.shape.derived,
  candidateReferenceOnly: raceManualReviewSourceInventoryV2Schema.out.shape.referenceOnly,
  candidateCoverage: raceManualReviewSourceInventoryV2Schema.out.shape.candidateCoverage,
  visitedCopies: rev.max(5000),
  sourceCompleteness: z.literal('unverified'),
  sqlRowDigest: z.literal('not_captured'),
  sourceAuthentication: z.literal('unverified'),
  lifecycleAuthority: z.literal('none'),
  permissionAuthority: z.literal('none'),
  authority: z.literal('none'),
  freshness: z.literal('not_checked'),
  storage: z.literal('not_persisted'),
  approvalAllowed: z.literal(false),
  admissionAllowed: z.literal(false),
});
/** Structural JSON validation only. Traversal never discovers source identities. */
function plain(value: unknown): boolean {
  const ancestors = new Set<object>();
  let nodes = 0;
  function visit(v: unknown, depth: number): void {
    if (++nodes > limit || depth > 64) throw Error('bound');
    if (
      v === null ||
      typeof v === 'string' ||
      typeof v === 'boolean' ||
      (typeof v === 'number' && Number.isFinite(v))
    )
      return;
    if (typeof v !== 'object' || ancestors.has(v) || Object.getOwnPropertySymbols(v).length)
      throw Error('plain');
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype) throw Error('plain');
    const descriptors = Object.getOwnPropertyDescriptors(v);
    if (
      Array.isArray(v) &&
      (Object.keys(v).length !== v.length || Object.getOwnPropertyNames(v).length !== v.length + 1)
    )
      throw Error('plain');
    ancestors.add(v);
    for (const [key, d] of Object.entries(descriptors)) {
      if (Array.isArray(v) && key === 'length') continue;
      if (!d.enumerable || !('value' in d)) throw Error('plain');
      visit(d.value, depth + 1);
    }
    ancestors.delete(v);
  }
  try {
    visit(value, 0);
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= limit;
  } catch {
    return false;
  }
}
export const raceManualReviewFullCopiedInventoryV2Schema = z
  .unknown()
  .refine(plain, 'Bounded plain JSON required')
  .pipe(resultBody)
  .superRefine((v, c) => {
    if (
      v.allCopiedBodiesIndexed !== (v.inventoryState === 'mapped') ||
      (v.inventoryState === 'mapped' && v.blockers.length)
    )
      c.addIssue({
        code: 'custom',
        message: 'Mapped inventory requires every copied body indexed',
      });
    const keys = v.refs.map((r) => digest(r.identity));
    if (new Set(keys).size !== keys.length)
      c.addIssue({ code: 'custom', message: 'Duplicate identity' });
    for (const ref of v.refs) {
      const kind = ref.identity.kind;
      const expected = [
        'routine-timer',
        'gallery-descriptor',
        'course-head-descriptor',
        'activity-track-descriptor',
        'activity-overlay',
        'activity-canonical-values',
      ].includes(kind)
        ? 'mutable_observation'
        : ['race-timing-pin-fragment', 'supplementary-session-copy'].includes(kind)
          ? 'source_fragment'
          : 'immutable_body';
      if (ref.representation !== expected)
        c.addIssue({ code: 'custom', message: 'Source representation namespace mismatch' });
    }
    const locations = v.refs.flatMap((r) => r.copiedLocations);
    if (new Set(locations).size !== locations.length)
      c.addIssue({ code: 'custom', message: 'Copied locations must have exactly one identity' });
  });
export type RaceManualReviewFullCopiedInventoryV2 = z.infer<
  typeof raceManualReviewFullCopiedInventoryV2Schema
>;
const inputSchema = z.strictObject({
  context: raceImpactConsumedCaptureSchema,
  sourceInput: raceManualReviewCandidateV2InputSchema,
  candidate: raceManualReviewCandidateV2ResultSchema,
});
const equal = (a: unknown, b: unknown) => digest(a) === digest(b);
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const tuple = (...ids: string[]) => JSON.stringify(ids.map((id) => uuid.safeParse(id).data ?? id));
/** Pure lineage enumeration of C(context), S(source input), B(candidate).
 * It never establishes SQL row correspondence, source authorization, deletion
 * capability, storage admission or approval freshness. Mutable descriptors are
 * explicitly observations rather than invented immutable revisions. */
export function enumerateRaceManualReviewFullCopiedSourcesV2(
  raw: unknown,
): RaceManualReviewFullCopiedInventoryV2 {
  const refs = new Map<string, z.infer<typeof refSchema>>(),
    diagnostics: z.infer<typeof diagnosticSchema>[] = [],
    blockers: z.infer<typeof blockerSchema>[] = [];
  let visited = 0;
  const blocker = (location: string, reason: z.infer<typeof blockerSchema>['reason']) => {
    if (blockers.length < 5000) blockers.push({ location, reason });
  };
  const visit = (location: string) => {
    if (++visited > 5000) {
      blocker(location, 'reference_bound');
      throw Error('reference_bound');
    }
  };
  const note = (
    location: string,
    state: z.infer<typeof diagnosticSchema>['state'],
    value: unknown,
  ) => {
    visit(location);
    diagnostics.push({ location, state, dtoDigest: digest(value) });
  };
  function add(
    rawIdentity: Identity,
    body: unknown,
    location: string,
    representation: z.infer<typeof refSchema>['representation'] = 'immutable_body',
  ) {
    visit(location);
    const identity = identitySchema.parse(rawIdentity),
      key = digest(identity),
      dtoDigest = digest(body),
      prior = refs.get(key);
    if (prior) {
      if (prior.dtoDigest !== dtoDigest || prior.representation !== representation)
        blocker(location, 'divergent_copied_body');
      else if (!prior.copiedLocations.includes(location)) prior.copiedLocations.push(location);
    } else
      refs.set(key, {
        identity,
        representation,
        dtoDigest,
        digestMethod: 'dto-object-key-canonical-sha256-v1',
        copiedLocations: [location],
      });
  }
  const emptyCandidate = { fragments: [], derived: [], referenceOnly: [] };
  let decodedCoverage: z.infer<
    typeof raceManualReviewSourceInventoryV2Schema.out.shape.candidateCoverage
  > = null;
  let candidateInventory: Pick<
    ReturnType<typeof enumerateRaceManualReviewCopiedSourcesV2>,
    'fragments' | 'derived' | 'referenceOnly'
  > = emptyCandidate;
  function finish() {
    const value = {
      inventoryVersion: 2 as const,
      scope: 'prepared_full_context_copied_bodies_only' as const,
      inventoryState: blockers.length ? ('blocked' as const) : ('mapped' as const),
      allCopiedBodiesIndexed: !blockers.length,
      refs: [...refs.values()]
        .map((r) => ({ ...r, copiedLocations: r.copiedLocations.sort(order) }))
        .sort((a, b) => order(JSON.stringify(a.identity), JSON.stringify(b.identity))),
      diagnostics: diagnostics.sort((a, b) => order(a.location, b.location)),
      blockers,
      candidateFragments: candidateInventory.fragments,
      candidateDerived: candidateInventory.derived,
      candidateReferenceOnly: candidateInventory.referenceOnly,
      candidateCoverage: decodedCoverage,
      visitedCopies: Math.min(visited, 5000),
      sourceCompleteness: 'unverified' as const,
      sqlRowDigest: 'not_captured' as const,
      sourceAuthentication: 'unverified' as const,
      lifecycleAuthority: 'none' as const,
      permissionAuthority: 'none' as const,
      authority: 'none' as const,
      freshness: 'not_checked' as const,
      storage: 'not_persisted' as const,
      approvalAllowed: false as const,
      admissionAllowed: false as const,
    };
    if (!plain(value))
      return resultBody.parse({
        ...value,
        inventoryState: 'blocked',
        allCopiedBodiesIndexed: false,
        refs: [],
        diagnostics: [],
        candidateFragments: [],
        candidateDerived: [],
        candidateReferenceOnly: [],
        blockers: [{ location: 'output', reason: 'inventory_bound' }],
      });
    return raceManualReviewFullCopiedInventoryV2Schema.parse(value);
  }
  if (!plain(raw)) {
    blocker('input', 'invalid_envelope');
    return finish();
  }
  const decoded = inputSchema.safeParse(raw);
  if (!decoded.success) {
    blocker('input', 'invalid_envelope');
    return finish();
  }
  if (!equal(raw, decoded.data)) {
    blocker('input', 'correspondence_mismatch');
    return finish();
  }
  const { context: c, sourceInput: s, candidate: b } = decoded.data;
  if (b.status !== 'assembled_readonly') {
    blocker('candidate', 'correspondence_mismatch');
    return finish();
  }
  try {
    const { status, coverage, readSetDigest, affected, ...readSet } = c;
    void status;
    void coverage;
    void affected;
    const app = c.manualBasis.app;
    if (
      digest({ ...readSet, coreDependencies: { ...c.coreDependencies, capturedAt: null } }) !==
        readSetDigest ||
      s.athleteId !== c.athleteId ||
      app.state !== 'present' ||
      !app.granted ||
      !equal(s.binding, {
        purpose: c.manualBasis.purpose,
        event: { id: c.event.id, revision: c.event.revision },
        appRevision: app.state === 'present' ? app.revision : 0,
        policy: c.manualBasis.policy,
        restoreGeneration: c.restoreGeneration,
        readSetDigest,
      }) ||
      !c.calendarIntent
    ) {
      blocker('context', 'correspondence_mismatch');
      return finish();
    }
    const relative = z.discriminatedUnion('entity', [
      z.strictObject({
        itemId: opaque,
        entity: z.literal('race'),
        entityId: opaque,
        sourceVersionId: z.null(),
        affected: z.boolean(),
        point: z.enum(['start', 'end']),
        sourceRaceRevision: rev.min(1),
        sourceRaceDigest: sha,
        timing: z.literal('not_resolved'),
      }),
      z.strictObject({
        itemId: opaque,
        entity: z.literal('session'),
        entityId: opaque,
        sourceVersionId: opaque,
        affected: z.boolean(),
        point: z.enum(['start', 'end']),
        timing: z.literal('not_resolved'),
      }),
    ]);
    const unsupported = z.strictObject({
      stepId: opaque,
      content: routineStepContentSchema,
      state: z.literal('unavailable'),
      reason: z.literal('producer_content_unsupported'),
    });
    const calculationCapture = {
      ...c,
      routineActualManifest: {
        ...c.routineActualManifest,
        blueprints: c.routineActualManifest.blueprints.map((row) => ({
          ...row,
          unsupportedContent: z.array(unsupported).parse(row.unsupportedContent),
        })),
      },
      coverage: {
        ...c.coverage,
        missing: z
          .tuple([
            z.literal('complete_catalog_and_actual_manifest'),
            z.literal('supplementary_reference_manifest'),
            z.literal('routine_occurrences_and_started_runs'),
            z.literal('complete_source_permission_manifest'),
            z.literal('manual_purpose_app_and_policy_binding'),
          ])
          .parse(c.coverage.missing),
        captured: z
          .tuple([
            z.literal('integrated_dependency_inventory'),
            z.literal('immutable_supplementary_copy_references'),
            z.literal('routine_occurrence_run_and_actual_reference_facts'),
            z.literal('partial_owned_planned_reference_and_resource_permission_facts'),
            z.literal('nested_nutrition_plan_food_anchor_and_activity_media_provider_facts'),
            z.literal('manual_purpose_app_and_policy_facts'),
          ])
          .parse(c.coverage.captured),
      },
      nutrition: c.nutrition.map((row) => ({
        ...row,
        relativeItems: z.array(relative).parse(row.relativeItems),
      })),
    };
    const built = buildRacePlanImpactProjectionInput(calculationCapture, c.calendarIntent);
    if (built.status !== 'projected') {
      blocker('context.calendarIntent', 'correspondence_mismatch');
      return finish();
    }
    const ports = createRacePlanImpactCapturedCalculationPorts(calculationCapture);
    const expected = assembleRaceManualReviewCandidateCompatibleV4(
      { ...s, projectionInput: built.input, sourceFacts: built.sourceFacts },
      ports,
    );
    const supplied = assembleRaceManualReviewCandidateCompatibleV4(s, ports);
    if (
      !equal(expected, b) ||
      !equal(supplied, b) ||
      !equal(built.collectorSelection, c.collectorSelection)
    ) {
      blocker('sourceInput', 'correspondence_mismatch');
      return finish();
    }
    const candidateMap = enumerateRaceManualReviewCopiedSourcesV2(b);
    candidateInventory = candidateMap;
    decodedCoverage = candidateMap.candidateCoverage;
    for (const row of [
      ...candidateMap.fragments,
      ...candidateMap.derived,
      ...candidateMap.referenceOnly,
    ])
      visit('candidate.' + row.location);
    for (const issue of candidateMap.blockers)
      blocker(
        'candidate.' + issue.location,
        issue.reason === 'divergent_copied_body' ? 'divergent_copied_body' : 'unindexable_body',
      );
    for (const r of candidateMap.refs) {
      for (const location of r.copiedLocations) visit('candidate.' + location);
      refs.set(digest(r.identity), {
        ...r,
        representation: 'immutable_body',
        copiedLocations: r.copiedLocations.map((location) => 'candidate.' + location),
      });
    }
    const plan = (
      r: z.infer<typeof raceImpactConsumedCaptureSchema>['consumedSources']['plans'][number],
      path: string,
    ) => add({ kind: 'plan-snapshot', sourceId: r.id, version: r.version }, r, path);
    const nutrition = (
      r: z.infer<typeof raceImpactConsumedCaptureSchema>['nutrition'][number]['record'],
      path: string,
    ) => {
      add({ kind: 'nutrition-plan-version', sourceId: r.planId, versionId: r.versionId }, r, path);
      if ('raceTimingPins' in r)
        r.raceTimingPins.forEach((pin, i) =>
          add(
            {
              kind: 'race-timing-pin-fragment',
              sourceId: pin.eventId,
              revision: pin.eventRevision,
            },
            pin,
            `${path}.raceTimingPins[${i}]`,
            'source_fragment',
          ),
        );
    };
    const event = (r: typeof c.event, path: string) =>
      add({ kind: 'race-event', sourceId: r.id, revision: r.revision }, r, path);
    const candidatePins = (r: (typeof c.nutrition)[number]['record'], path: string) => {
      if ('raceTimingPins' in r)
        r.raceTimingPins.forEach((pin, i) =>
          add(
            {
              kind: 'race-timing-pin-fragment',
              sourceId: pin.eventId,
              revision: pin.eventRevision,
            },
            pin,
            `${path}.raceTimingPins[${i}]`,
            'source_fragment',
          ),
        );
    };
    b.body.projectionInput.nutrition.forEach((r, i) =>
      candidatePins(r.record, `candidate.body.projectionInput.nutrition[${i}].record`),
    );
    b.body.projection.nutrition.forEach((r, i) =>
      candidatePins(r.record, `candidate.body.projection.nutrition[${i}].record`),
    );
    b.body.pinTransitions.forEach((r, i) => {
      if (r.savedPin)
        add(
          {
            kind: 'race-timing-pin-fragment',
            sourceId: r.savedPin.eventId,
            revision: r.savedPin.eventRevision,
          },
          r.savedPin,
          `candidate.body.pinTransitions[${i}].savedPin`,
          'source_fragment',
        );
    });
    const input = s.projectionInput;
    event(input.event, 'sourceInput.projectionInput.event');
    input.sourcePlans.forEach((r, i) => plan(r, `sourceInput.projectionInput.sourcePlans[${i}]`));
    if (input.currentPlan) plan(input.currentPlan, 'sourceInput.projectionInput.currentPlan');
    input.nutrition.forEach((r, i) =>
      nutrition(r.record, `sourceInput.projectionInput.nutrition[${i}].record`),
    );
    input.completionReports.forEach((r, i) =>
      add(
        {
          kind: 'session-completion',
          sourceId: r.sessionId,
          planVersionId: r.planVersionId,
          revision: r.revision,
        },
        r,
        `sourceInput.projectionInput.completionReports[${i}]`,
      ),
    );
    (input.retainedUnplannedRuns ?? []).forEach((row, i) => {
      const path = `sourceInput.projectionInput.retainedUnplannedRuns[${i}]`;
      add(
        {
          kind: 'routine-blueprint-version',
          sourceId: row.blueprint.routineId,
          versionId: row.blueprint.versionId,
        },
        row.blueprint,
        path + '.blueprint',
      );
      add(
        { kind: 'routine-run', sourceId: row.run.id, revision: row.run.revision },
        row.run,
        path + '.run',
      );
    });
    const routineSources = [
      ...input.routines.map((r, i) => ({ r, path: `sourceInput.projectionInput.routines[${i}]` })),
      ...(input.retainedHistoricalRoutines ?? []).map((r, i) => ({
        r,
        path: `sourceInput.projectionInput.retainedHistoricalRoutines[${i}]`,
      })),
    ];
    routineSources.forEach(({ r, path }) => {
      add(
        { kind: 'routine-schedule-version', sourceId: r.record.id, versionId: r.record.versionId },
        r.record,
        path + '.record',
      );
      add(
        {
          kind: 'routine-blueprint-version',
          sourceId: r.blueprint.routineId,
          versionId: r.blueprint.versionId,
        },
        r.blueprint,
        path + '.blueprint',
      );
      r.occurrences.forEach((row, j) =>
        add({ kind: 'routine-occurrence', sourceId: row.id }, row, `${path}.occurrences[${j}]`),
      );
      r.runs.forEach((row, j) =>
        add(
          { kind: 'routine-run', sourceId: row.id, revision: row.revision },
          row,
          `${path}.runs[${j}]`,
        ),
      );
    });
    event(c.event, 'context.event');
    c.consumedSources.races.forEach((r, i) => event(r, `context.consumedSources.races[${i}]`));
    c.consumedSources.plans.forEach((r, i) => plan(r, `context.consumedSources.plans[${i}]`));
    if (c.linkedPlan) plan(c.linkedPlan, 'context.linkedPlan');
    if (c.currentTraining) plan(c.currentTraining.snapshot, 'context.currentTraining.snapshot');
    c.completions.forEach((r, i) =>
      add(
        {
          kind: 'session-completion',
          sourceId: r.sessionId,
          planVersionId: r.planVersionId,
          revision: r.revision,
        },
        r,
        `context.completions[${i}]`,
      ),
    );
    c.nutrition.forEach((r, i) => {
      if (tuple(r.aggregateId, r.versionId) !== tuple(r.record.planId, r.record.versionId))
        blocker(`context.nutrition[${i}]`, 'source_tuple_mismatch');
      nutrition(r.record, `context.nutrition[${i}].record`);
    });
    c.routines.forEach((r, i) => {
      if (r.aggregateId !== r.record.id || r.versionId !== r.record.versionId)
        blocker(`context.routines[${i}]`, 'source_tuple_mismatch');
      add(
        { kind: 'routine-schedule-version', sourceId: r.record.id, versionId: r.record.versionId },
        r.record,
        `context.routines[${i}].record`,
      );
    });
    c.recovery.forEach((r, i) => {
      if (tuple(r.aggregateId, r.versionId) !== tuple(r.record.strategyId, r.record.versionId))
        blocker(`context.recovery[${i}]`, 'source_tuple_mismatch');
      add(
        {
          kind: 'recovery-strategy-version',
          sourceId: r.record.strategyId,
          versionId: r.record.versionId,
        },
        r.record,
        `context.recovery[${i}].record`,
      );
    });
    c.recoverySources?.methods.forEach((r, i) => {
      const f = c.recoverySources?.methodFacts.find(
        (f) =>
          tuple(f.requested.ref.id, f.requested.ref.versionId) === tuple(r.methodId, r.versionId),
      );
      if (!f || f.content.digest !== digest(r))
        blocker(`context.recoverySources.methods[${i}]`, 'source_tuple_mismatch');
      add(
        { kind: 'recovery-method-version', sourceId: r.methodId, versionId: r.versionId },
        r,
        `context.recoverySources.methods[${i}]`,
      );
    });
    const nested = (rows: typeof c.sourcePermissionManifest.nestedNutritionSources, path: string) =>
      rows.forEach((row, i) =>
        row.foods.forEach((f, j) => {
          const loc = `${path}[${i}].foods[${j}].content`;
          if (f.content) {
            if (
              tuple(f.requestedVersionId) !== tuple(f.content.versionId) ||
              f.content.foodId !== f.content.record.foodId ||
              tuple(f.content.versionId) !== tuple(f.content.record.versionId) ||
              digest(f.content.record) !== f.content.digest ||
              !equal(f.content.provenance, {
                kind: f.content.record.provenance.kind,
                reviewState: f.content.record.provenance.reviewState,
                capturedAt: f.content.record.provenance.capturedAt,
                reference:
                  f.content.record.provenance.reference === null
                    ? { state: 'absent' }
                    : { state: 'present', digest: digest(f.content.record.provenance.reference) },
              })
            )
              blocker(loc, 'source_tuple_mismatch');
            add(
              {
                kind: 'food-definition-version',
                sourceId: f.content.foodId,
                versionId: f.content.versionId,
              },
              f.content.record,
              loc + '.record',
            );
          } else note(loc, 'unavailable', f);
        }),
      );
    nested(
      c.sourcePermissionManifest.nestedNutritionSources,
      'context.sourcePermissionManifest.nestedNutritionSources',
    );
    if (c.recoveryNutritionSources) {
      c.recoveryNutritionSources.records.forEach((r, i) => {
        const f = c.recoveryNutritionSources?.facts.find(
          (f) =>
            tuple(f.requested.aggregateId, f.requested.versionId) === tuple(r.planId, r.versionId),
        );
        if (
          !f ||
          f.content?.digest !== digest(r) ||
          f.state === 'unavailable' ||
          (f.state === 'current' &&
            !equal(f.currentHead, { aggregateId: r.planId, versionId: r.versionId })) ||
          (f.state === 'historical' &&
            f.currentHead !== null &&
            (tuple(f.currentHead.aggregateId) !== tuple(r.planId) ||
              tuple(f.currentHead.versionId) === tuple(r.versionId)))
        )
          blocker(`context.recoveryNutritionSources.records[${i}]`, 'source_tuple_mismatch');
        const current = c.nutrition.find(
          (n) => tuple(n.aggregateId, n.versionId) === tuple(r.planId, r.versionId),
        );
        if (current && !equal(current.record, r))
          blocker(`context.recoveryNutritionSources.records[${i}]`, 'divergent_copied_body');
        nutrition(r, `context.recoveryNutritionSources.records[${i}]`);
      });
      nested(
        c.recoveryNutritionSources.nestedSources.nutrition,
        'context.recoveryNutritionSources.nestedSources.nutrition',
      );
      c.recoveryNutritionSources.nestedSources.loadedPlans.forEach((r, i) =>
        plan(r, `context.recoveryNutritionSources.nestedSources.loadedPlans[${i}]`),
      );
    }
    c.supplementaryManifest.copies.forEach((r, i) => {
      const path = `context.supplementaryManifest.copies[${i}].link`;
      if (
        r.link.content.kind === 'embedded' &&
        (r.targetSource !== 'session_copy' || r.contentDigest !== digest(r.link.content.spec))
      )
        blocker(path, 'source_tuple_mismatch');
      if (r.link.content.kind === 'embedded')
        add(
          {
            kind: 'supplementary-session-copy',
            sourceId: r.link.planVersionId,
            sessionId: r.link.plannedSessionId,
          },
          r.link.content.spec,
          path + '.content.spec',
          'source_fragment',
        );
      else note(path, 'reference_only', r.link);
    });
    c.workoutTemplateSources?.templates.forEach((r, i) => {
      const f = c.workoutTemplateSources?.templateFacts.find(
        (f) =>
          tuple(f.requested.ref.id, f.requested.ref.versionId) === tuple(r.routineId, r.versionId),
      );
      if (!f || f.content?.digest !== digest(r))
        blocker(`context.workoutTemplateSources.templates[${i}]`, 'source_tuple_mismatch');
      add(
        { kind: 'workout-template-version', sourceId: r.routineId, versionId: r.versionId },
        r,
        `context.workoutTemplateSources.templates[${i}]`,
      );
    });
    c.workoutTemplateSources?.exercises.forEach((r, i) => {
      const f = c.workoutTemplateSources?.exerciseFacts.find(
        (f) => tuple(f.requestedVersionId) === tuple(r.record.versionId),
      );
      if (!f || f.content?.digest !== digest(r.record))
        blocker(`context.workoutTemplateSources.exercises[${i}]`, 'source_tuple_mismatch');
      add(
        {
          kind: 'supplementary-exercise-version',
          sourceId: r.record.exerciseId,
          versionId: r.record.versionId,
        },
        r.record,
        `context.workoutTemplateSources.exercises[${i}].record`,
      );
    });
    const actual = c.routineActualManifest;
    actual.occurrences.forEach((r, i) =>
      add(
        { kind: 'routine-occurrence', sourceId: r.record.id },
        r.record,
        `context.routineActualManifest.occurrences[${i}].record`,
      ),
    );
    actual.schedules.forEach((r, i) =>
      add(
        { kind: 'routine-schedule-version', sourceId: r.scheduleId, versionId: r.versionId },
        r.record,
        `context.routineActualManifest.schedules[${i}].record`,
      ),
    );
    actual.blueprints.forEach((r, i) => {
      add(
        {
          kind: 'routine-blueprint-version',
          sourceId: r.record.routineId,
          versionId: r.record.versionId,
        },
        r.record,
        `context.routineActualManifest.blueprints[${i}].record`,
      );
      r.unsupportedContent.forEach((v, j) => {
        const parsed = unsupported.safeParse(v);
        const step = parsed.success
          ? r.record.steps.find((step) => step.id === parsed.data.stepId)
          : undefined;
        if (!parsed.success || !step || !equal(step.content, parsed.data.content))
          blocker(
            `context.routineActualManifest.blueprints[${i}].unsupportedContent[${j}]`,
            'unindexable_body',
          );
        else
          note(
            `context.routineActualManifest.blueprints[${i}].unsupportedContent[${j}]`,
            'reference_only',
            parsed.data,
          );
      });
    });
    actual.runs.forEach((r, i) => {
      if (r.historyDigest !== digest(r.record))
        blocker(`context.routineActualManifest.runs[${i}].historyDigest`, 'source_tuple_mismatch');
      add(
        { kind: 'routine-run', sourceId: r.record.id, revision: r.record.revision },
        r.record,
        `context.routineActualManifest.runs[${i}].record`,
      );
      r.actuals.forEach((a, j) => {
        const f = a.fact,
          path = `context.routineActualManifest.runs[${i}].actuals[${j}].fact`;
        if (
          !r.record.progress.some(
            (step) =>
              step.stepId === a.stepId && step.actualRefs.some((ref) => equal(ref, f.requested)),
          )
        )
          blocker(path, 'source_tuple_mismatch');
        if (f.content === null) {
          note(path, f.state === 'deleted' ? 'deleted' : 'unavailable', f);
          return;
        }
        if (f.requested.kind === 'activity') {
          const requested = f.requested;
          const p = c.manualActivityReadFacts?.facts.find((p) => equal(p.requested, f.requested));
          if (!p?.content || !equal(p.content, f.content) || !p.sourceEvidence) {
            // Canonical values are an observed current projection, never provider raw source.
            const roster = actual.actualRosters.activities.find((v) => v.id === requested.id);
            const metadata = c.sourcePermissionManifest.activityMediaPermissions.activities.find(
              (v) => v.id === requested.id,
            );
            const boundary = manualActivityReadProjectionInputSchema.safeParse({
              athleteId: c.athleteId,
              refs: [f.requested],
              actualFacts: [f],
              activityRosters: roster ? [roster] : [],
              activityMetadata: metadata ? [metadata] : [],
            });
            if (!boundary.success) {
              blocker(path, 'source_tuple_mismatch');
              return;
            }
            const canonical = boundary.data.actualFacts[0];
            if (!canonical?.content || !canonical.current) {
              blocker(path, 'unindexable_body');
              return;
            }
            const owned = boundary.data.activityRosters[0];
            const observed = boundary.data.activityMetadata[0];
            if (
              !owned ||
              !observed ||
              !canonical.current ||
              canonical.state !== 'current' ||
              canonical.current.deleted ||
              canonical.requested.detailId !== null ||
              canonical.requested.allocationId !== null ||
              canonical.content.detail !== null ||
              Number(canonical.requested.revisionId) !== canonical.current.revision ||
              !equal(canonical.current, {
                id: owned.id,
                revision: owned.revision,
                deleted: owned.deleted,
              }) ||
              !equal(canonical.current, {
                id: observed.id,
                revision: observed.revision,
                deleted: observed.deleted,
              }) ||
              digest(canonical.content.original) !== owned.originalDigest ||
              digest(canonical.content.overlay) !== owned.overlayDigest ||
              owned.source.state !== 'present' ||
              observed.source.state !== 'present' ||
              owned.source.kind === 'manual' ||
              owned.source.kind !== observed.source.kind ||
              owned.source.sourceId !== observed.source.sourceId ||
              owned.source.sourceRevision !== observed.source.revision ||
              owned.source.contentHash !== observed.source.contentHash ||
              observed.source.suppressed ||
              observed.source.revisionRecord.state !== 'present' ||
              (canonical.content.overlay === null
                ? observed.overlay.state !== 'absent' || observed.overlay.revision !== null
                : observed.overlay.state !== 'present' ||
                  observed.overlay.revision !== canonical.current.revision)
            ) {
              blocker(path, 'unindexable_body');
              return;
            }
            add(
              { kind: 'activity-canonical-values', sourceId: owned.id, revision: owned.revision },
              canonical.content.original,
              path + '.content.original',
              'mutable_observation',
            );
            if (canonical.content.overlay !== null)
              add(
                { kind: 'activity-overlay', sourceId: owned.id, revision: owned.revision },
                canonical.content.overlay,
                path + '.content.overlay',
                'mutable_observation',
              );
            return;
          }
          const src = p.sourceEvidence.roster.source;
          if (src.state !== 'present' || src.kind !== 'manual') {
            blocker(path, 'unindexable_body');
            return;
          }
          add(
            {
              kind: 'manual-activity-source',
              sourceId: f.requested.id,
              sourceRecordId: src.sourceId,
              sourceRevision: src.sourceRevision,
            },
            p.content.original,
            path + '.content.original',
          );
          if (p.content.overlay)
            add(
              {
                kind: 'activity-overlay',
                sourceId: f.requested.id,
                revision: rev.min(1).parse(p.sourceEvidence.metadata.overlay.revision),
              },
              p.content.overlay,
              path + '.content.overlay',
              'mutable_observation',
            );
          if (p.content.detail) blocker(path + '.content.detail', 'unindexable_body');
        } else if (f.requested.kind === 'intake') {
          const p = c.manualIntakeReadFacts?.facts.find((p) => equal(p.requested, f.requested));
          if (!p?.content || !equal(p.content, f.content)) {
            blocker(path, 'unindexable_body');
            return;
          }
          add(
            {
              kind: 'intake-revision',
              sourceId: p.requested.id,
              revisionId: p.requested.revisionId,
            },
            p.content,
            path + '.content',
          );
        } else if (
          f.requested.kind === 'checklist_confirmation' &&
          'run_id' in f.content &&
          'revision_id' in f.content
        ) {
          if (
            f.content.id !== f.requested.id ||
            f.content.revision_id !== f.requested.revisionId ||
            f.content.run_id !== r.record.id ||
            f.content.step_id !== a.stepId
          )
            blocker(path, 'source_tuple_mismatch');
          add(
            {
              kind: 'checklist-confirmation',
              sourceId: f.content.id,
              revisionId: f.content.revision_id,
              runId: f.content.run_id,
              stepId: f.content.step_id,
            },
            f.content,
            path + '.content',
          );
        } else if (
          f.requested.kind === 'checkin' &&
          checkInValuesSchema.safeParse(f.content).success &&
          /^[1-9][0-9]*$/.test(f.requested.revisionId) &&
          Number.isSafeInteger(Number(f.requested.revisionId)) &&
          Number(f.requested.revisionId) <= 2147483647 &&
          f.current &&
          'revision' in f.current &&
          'deleted' in f.current &&
          !f.current.deleted &&
          f.current.id === f.requested.id &&
          (f.state === 'current'
            ? f.current.revision === Number(f.requested.revisionId)
            : f.state === 'historical' && f.current.revision > Number(f.requested.revisionId))
        )
          add(
            {
              kind: 'checkin-revision',
              sourceId: f.requested.id,
              revision: Number(f.requested.revisionId),
            },
            f.content,
            path + '.content',
          );
        else blocker(path + '.content', 'unindexable_body');
      });
    });
    if (c.manualActivityReadFacts) {
      const activityFacts = actual.runs
        .flatMap((r) => r.actuals.map((a) => a.fact))
        .filter((f) => f.requested.kind === 'activity');
      const v = validateManualActivityReadFacts(c.manualActivityReadFacts, {
        athleteId: c.athleteId,
        refs: activityFacts.map((f) => f.requested),
        actualFacts: activityFacts,
        activityRosters: actual.actualRosters.activities,
        activityMetadata: c.sourcePermissionManifest.activityMediaPermissions.activities,
      });
      if (v.status === 'blocked' && c.manualActivityReadFacts.facts.some((f) => f.content))
        blocker('context.manualActivityReadFacts', 'source_tuple_mismatch');
      c.manualActivityReadFacts.facts.forEach((p, i) => {
        const path = `context.manualActivityReadFacts.facts[${i}]`;
        if (!p.content) {
          note(path, p.state === 'deleted' ? 'deleted' : 'unavailable', p);
          return;
        }
        const source = p.sourceEvidence?.roster.source;
        if (!source || source.state !== 'present' || source.kind !== 'manual') {
          blocker(path, 'unindexable_body');
          return;
        }
        add(
          {
            kind: 'manual-activity-source',
            sourceId: p.requested.id,
            sourceRecordId: source.sourceId,
            sourceRevision: source.sourceRevision,
          },
          p.content.original,
          path + '.content.original',
        );
        if (p.content.overlay)
          add(
            {
              kind: 'activity-overlay',
              sourceId: p.requested.id,
              revision: rev.min(1).parse(p.sourceEvidence?.metadata.overlay.revision),
            },
            p.content.overlay,
            path + '.content.overlay',
            'mutable_observation',
          );
        if (p.content.detail) blocker(path + '.content.detail', 'unindexable_body');
      });
    }
    if (c.manualIntakeReadFacts) {
      const v = validateManualIntakeReadFacts(c.manualIntakeReadFacts, {
        athleteId: c.athleteId,
        refs: actual.runs
          .flatMap((r) => r.actuals.map((a) => a.fact))
          .filter((f) => f.requested.kind === 'intake')
          .map((f) => f.requested),
      });
      if (v.status === 'blocked') blocker('context.manualIntakeReadFacts', 'source_tuple_mismatch');
      c.manualIntakeReadFacts.facts.forEach((f, i) => {
        const path = `context.manualIntakeReadFacts.facts[${i}]`;
        if (f.content)
          add(
            {
              kind: 'intake-revision',
              sourceId: f.requested.id,
              revisionId: f.requested.revisionId,
            },
            f.content,
            path + '.content',
          );
        else note(path, f.state === 'deleted' ? 'deleted' : 'unavailable', f);
      });
    }
    c.routineTimerReads?.forEach((r, i) => {
      if (!actual.runs.some((row) => equal(row.record, r.run)))
        blocker(`context.routineTimerReads[${i}].run`, 'source_tuple_mismatch');
      const blueprint = actual.blueprints.find(
        (b) =>
          b.record.routineId === r.run.blueprint.id &&
          b.record.versionId === r.run.blueprint.versionId,
      );
      if (
        r.timers.some(
          (t) =>
            t.runId !== r.run.id || !blueprint?.record.steps.some((step) => step.id === t.stepId),
        )
      )
        blocker(`context.routineTimerReads[${i}].timers`, 'source_tuple_mismatch');
      add(
        { kind: 'routine-run', sourceId: r.run.id, revision: r.run.revision },
        r.run,
        `context.routineTimerReads[${i}].run`,
      );
      r.timers.forEach((t, j) =>
        add(
          { kind: 'routine-timer', sourceId: t.runId, stepId: t.stepId, revision: t.revision },
          t,
          `context.routineTimerReads[${i}].timers[${j}]`,
          'mutable_observation',
        ),
      );
    });
    if (c.course) {
      const v = validateCourseReadManifest(
        { athleteId: c.athleteId, eventCourse: c.event.course },
        c.course,
      );
      if (v.status === 'blocked' && c.course.owned?.revision)
        blocker('context.course', 'source_tuple_mismatch');
      if (c.course.owned?.head.status === 'available')
        add(
          {
            kind: 'course-head-descriptor',
            sourceId: c.course.owned.head.courseId,
            revision: c.course.owned.head.headRevision,
          },
          c.course.owned.head,
          'context.course.owned.head',
          'mutable_observation',
        );
      const r = c.course.owned?.revision;
      if (r)
        add(
          {
            kind: 'course-revision',
            sourceId: r.courseId,
            revisionId: r.revisionId,
            revision: r.courseRevision,
          },
          r,
          'context.course.owned.revision',
        );
      else note('context.course.owned.revision', 'unavailable', c.course);
      c.course.lineageSources?.forEach((r, i) =>
        add(
          {
            kind: 'activity-track-descriptor',
            sourceId: r.activity.id,
            trackId: r.track.trackId,
            revision: r.track.trackRevision,
          },
          r.track,
          `context.course.lineageSources[${i}].track`,
          'mutable_observation',
        ),
      );
    }
    if (c.resourceReadFacts) {
      const v = validateResourceRetainedReadFacts(c.resourceReadFacts);
      if (
        v.blockers.some(
          (b) =>
            !['source_deleted', 'owned_version_unavailable', 'unsupported_source_kind'].includes(
              b.reason,
            ),
        )
      )
        blocker('context.resourceReadFacts', 'source_tuple_mismatch');
      c.resourceReadFacts.facts.forEach((f, i) => {
        const path = `context.resourceReadFacts.facts[${i}]`;
        if (f.record)
          add(
            {
              kind: 'resource-text-version',
              sourceId: f.record.resourceId,
              versionId: f.record.id,
            },
            f.record,
            path + '.record',
          );
        else note(path, f.state === 'deleted' ? 'deleted' : 'unavailable', f);
      });
    }
    if (c.mediaReadFacts) {
      const v = validateMediaRetainedReadFacts(c.mediaReadFacts);
      if (
        v.blockers.some(
          (b) =>
            ![
              'owned_media_unavailable',
              'object_inventory_unavailable',
              'cleanup_status_unavailable',
              'INVALID_REQUEST',
              'READ_CAPABILITY_UNAVAILABLE',
              'INVALID_CLEANUP_SOURCE',
              'cleanup_source_missing',
              'inventory_unavailable',
              'INVENTORY_UNAVAILABLE',
              'QUEUE_TUPLE_UNAVAILABLE',
              'REFERENCE_PRESENT',
              'cleanup_pending',
              'source_deleted',
            ].includes(b.reason),
        )
      )
        blocker('context.mediaReadFacts', 'source_tuple_mismatch');
      c.mediaReadFacts.facts.forEach((f, i) => {
        const path = `context.mediaReadFacts.facts[${i}]`;
        if (f.current)
          add(
            {
              kind: 'gallery-descriptor',
              sourceId: f.current.mediaItemId,
              accessRevision: f.current.accessRevision,
            },
            f,
            path,
            'mutable_observation',
          );
        else note(path, 'unavailable', f);
      });
    }
    decodeIntegratedDependencyInventory(c.dependencyInventory);
    // These channels contain only strict producer metadata. Unknown JSON extension
    // bodies have no trustworthy copied-body identity and are never silently ignored.
    c.sourcePermissionManifest.catalog.forEach((r, i) => {
      if (r.requested.kind === 'checklist')
        blocker(`context.sourcePermissionManifest.catalog[${i}].requested`, 'unindexable_body');
      else
        note(
          `context.sourcePermissionManifest.catalog[${i}].requested`,
          'reference_only',
          r.requested,
        );
    });
    c.sourcePermissionManifest.catalog.forEach((r, i) =>
      r.exercises?.forEach((e, j) => {
        const parsed = z
          .strictObject({
            requestedVersionId: uuid,
            state: z.enum(['owned', 'unavailable']),
            content: z
              .strictObject({
                exerciseId: uuid,
                versionId: uuid,
                digest: sha,
                resourceVersionIds: z.array(opaque),
                mediaAssetIds: z.array(opaque),
              })
              .nullable(),
            currentHead: z.strictObject({ aggregate_id: uuid, version_id: uuid }).nullable(),
          })
          .safeParse(e);
        if (!parsed.success)
          blocker(
            `context.sourcePermissionManifest.catalog[${i}].exercises[${j}]`,
            'unindexable_body',
          );
        else
          note(
            `context.sourcePermissionManifest.catalog[${i}].exercises[${j}]`,
            'metadata_only',
            parsed.data,
          );
      }),
    );
    c.sourcePermissionManifest.resources.forEach((r, i) => {
      const parsed = z
        .strictObject({
          requestedVersionId: opaque,
          state: z.enum(['deleted', 'current', 'historical', 'unavailable']),
          reason: z.literal('owned_version_unavailable').nullable(),
          content: z
            .strictObject({ resourceId: uuid, versionId: uuid, version: rev, contentHash: sha })
            .nullable(),
          current: z
            .strictObject({
              versionId: uuid,
              accessRevision: rev,
              deleted: z.boolean(),
              reviewedState: z.enum(['unreviewed', 'reviewed']),
              reviewedVersionId: uuid.nullable(),
              includeForCoach: z.boolean(),
              cleanupPending: z.boolean(),
              aiAuthorized: z.boolean(),
            })
            .nullable(),
        })
        .safeParse(r);
      if (!parsed.success)
        blocker(`context.sourcePermissionManifest.resources[${i}]`, 'unindexable_body');
      else note(`context.sourcePermissionManifest.resources[${i}]`, 'metadata_only', parsed.data);
    });
    c.sourcePermissionManifest.activityMediaPermissions.media.forEach((r, i) => {
      const parsed = z
        .union([
          z.strictObject({
            requestedId: opaque,
            state: z.literal('unavailable'),
            content: z.null(),
          }),
          z.strictObject({
            requestedId: opaque,
            state: z.enum(['owned', 'deleted']),
            accessRevision: rev,
            visibility: z.literal('private'),
            includeForCoach: z.literal(false),
            content: z
              .strictObject({
                kind: z.enum(['image', 'video']),
                objectIdentity: z.union([
                  z.strictObject({ state: z.literal('absent') }),
                  z.strictObject({ state: z.literal('present'), contentHash: sha, idDigest: sha }),
                ]),
                contentHash: sha,
                previewPresent: z.boolean(),
              })
              .nullable(),
            cleanup: z.union([
              raceMediaCleanupSourceSchema,
              z.strictObject({
                state: z.literal('unavailable'),
                reason: z.enum([
                  'INVALID_REQUEST',
                  'READ_CAPABILITY_UNAVAILABLE',
                  'INVALID_CLEANUP_SOURCE',
                ]),
              }),
            ]),
          }),
        ])
        .safeParse(r);
      if (!parsed.success)
        blocker(
          `context.sourcePermissionManifest.activityMediaPermissions.media[${i}]`,
          'unindexable_body',
        );
      else if (parsed.data.state === 'unavailable')
        note(
          `context.sourcePermissionManifest.activityMediaPermissions.media[${i}]`,
          'unavailable',
          parsed.data,
        );
      else
        note(
          `context.sourcePermissionManifest.activityMediaPermissions.media[${i}]`,
          'metadata_only',
          parsed.data,
        );
    });
  } catch {
    if (!blockers.length) blocker('context', 'source_tuple_mismatch');
  }
  return finish();
}
