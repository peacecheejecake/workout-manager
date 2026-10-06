import { z } from 'zod';
import { verifyRaceManualReviewIntegrity } from '@workout/server-coaching/race-manual-review-integrity';
import { createRaceRelativeScheduleCalculationPorts } from './race-relative-schedule-calculation.js';
import { raceEventSchema } from '@workout/contracts/races';
import { planSnapshotSchema, planDraftSchema } from '@workout/contracts/planning';
import {
  nutritionPlanVersionSchema,
  nutritionPlanItemCoreSchema,
} from '@workout/contracts/nutrition-core';
import { recoveryStrategyVersionSchema } from '@workout/contracts/recovery-core';
import {
  routineScheduleVersionSchema,
  routineBlueprintVersionSchema,
  routineOccurrenceSchema,
  routineRunSchema,
} from '@workout/contracts/routines';
import { sessionCompletionSchema } from '@workout/contracts/session-completion';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const id = z.string().min(1).max(200);
const revision = z.number().int().min(0).max(2147483647);
const _kinds = [
  'race-event',
  'plan-snapshot',
  'nutrition-plan-version',
  'recovery-strategy-version',
  'routine-schedule-version',
  'routine-blueprint-version',
  'routine-occurrence',
  'routine-run',
  'session-completion',
] as const;
type Kind = (typeof _kinds)[number];
interface Ref {
  kind: Kind;
  sourceId: string;
  versionKey: string;
}
interface Entry extends Ref {
  locations: string[];
}
const object = (value: unknown) => z.record(z.string(), z.unknown()).parse(value);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => compare(a, b))
      .map(([key, body]) => `${JSON.stringify(key)}:${canonical(body)}`)
      .join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('INVALID_INPUT');
  return encoded;
}
/** Validate plain JSON before property access, and count decoded containers BEFORE
 * deduplication. Repeated copies cannot conceal unbounded traversal. */
function decode(raw: unknown) {
  let visited = 0;
  const parents = new Set<object>();
  function visit(value: unknown, depth: number): unknown {
    if (depth > 64) throw new Error('INPUT_BOUND');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || parents.has(value)) throw new Error('INVALID_INPUT');
    if (++visited > 5000) throw new Error('INPUT_BOUND');
    if (
      (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) ||
      Object.getOwnPropertySymbols(value).length
    )
      throw new Error('INVALID_INPUT');
    parents.add(value);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Array.isArray(value)) {
        if (
          Object.keys(value).length !== value.length ||
          Object.getOwnPropertyNames(value).length !== value.length + 1
        )
          throw new Error('INVALID_INPUT');
        return Array.from({ length: value.length }, (_, index) => {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !('value' in descriptor)) throw new Error('INVALID_INPUT');
          return visit(descriptor.value, depth + 1);
        });
      }
      const result: Record<string, unknown> = Object.create(null);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('INVALID_INPUT');
        Object.defineProperty(result, key, {
          value: visit(descriptor.value, depth + 1),
          enumerable: true,
        });
      }
      return { ...result };
    } finally {
      parents.delete(value);
    }
  }
  const decoded = visit(raw, 0);
  if (Buffer.byteLength(canonical(decoded), 'utf8') > 4194304) throw new Error('INPUT_BOUND');
  return decoded;
}
function identify(row: Record<string, unknown>): { ref: Ref; body: unknown } | null {
  if ('localDate' in row && 'participation' in row) {
    const body = raceEventSchema.parse(row);
    return {
      ref: { kind: 'race-event', sourceId: body.id, versionKey: String(body.revision) },
      body,
    };
  }
  if ('createdAt' in row && 'draft' in row && 'id' in row) {
    const body = planSnapshotSchema.parse(row);
    return {
      ref: {
        kind: 'plan-snapshot',
        sourceId: uuid.parse(body.id),
        versionKey: String(revision.min(1).parse(body.version)),
      },
      body,
    };
  }
  if ('planId' in row && 'items' in row) {
    const body = nutritionPlanVersionSchema.parse(row);
    return {
      ref: { kind: 'nutrition-plan-version', sourceId: body.planId, versionKey: body.versionId },
      body,
    };
  }
  if ('strategyId' in row && 'draft' in row) {
    const body = recoveryStrategyVersionSchema.parse(row);
    return {
      ref: {
        kind: 'recovery-strategy-version',
        sourceId: body.strategyId,
        versionKey: body.versionId,
      },
      body,
    };
  }
  if ('routineId' in row && 'steps' in row) {
    const body = routineBlueprintVersionSchema.parse(row);
    return {
      ref: {
        kind: 'routine-blueprint-version',
        sourceId: uuid.parse(body.routineId),
        versionKey: uuid.parse(body.versionId),
      },
      body,
    };
  }
  if ('window' in row && 'rule' in row) {
    const body = routineScheduleVersionSchema.parse(row);
    return {
      ref: {
        kind: 'routine-schedule-version',
        sourceId: uuid.parse(body.id),
        versionKey: uuid.parse(body.versionId),
      },
      body,
    };
  }
  if ('anchorKey' in row && 'stepBindings' in row) {
    const body = routineOccurrenceSchema.parse(row);
    return {
      ref: { kind: 'routine-occurrence', sourceId: uuid.parse(body.id), versionKey: 'immutable' },
      body,
    };
  }
  if ('progress' in row && 'origin' in row) {
    const body = routineRunSchema.parse(row);
    return {
      ref: {
        kind: 'routine-run',
        sourceId: uuid.parse(body.id),
        versionKey: String(revision.parse(body.revision)),
      },
      body,
    };
  }
  if ('sessionId' in row && 'definitionVersion' in row) {
    const body = sessionCompletionSchema.parse(row);
    return {
      ref: {
        kind: 'session-completion',
        sourceId: id.parse(body.sessionId),
        versionKey: JSON.stringify([body.planVersionId, body.revision]),
      },
      body,
    };
  }
  return null;
}
const keyOf = (ref: Ref) => JSON.stringify([ref.kind, ref.sourceId, ref.versionKey]);
const metadataKeys = new Set(
  `status storage sourceCompleteness approvalAllowed athleteId context projectionInput ownerAthleteId nutritionRacePins sourceInput candidate binding integrity stage reason missingFacts kind id revision readSetDigest event selection calendar nutrition routines writeIntents pinIntents retainedActualManifest resolution methodVersion schemaVersion digest approval reasons constraintDays eventDate deltaCalendarDays relationship sourceFacts requiresResolution blocking preservedNotices expected eventId expectedNextRevision proposedLocalDate training sourceVersionId proposed allocation itemChanges itemId state before after notice target prior ref domain versionId planVersionId scheduleVersionId blueprint plan currentPlanVersionId currentPlan sourcePlans newLocalDate completionReports timings resolutions expectedCurrentPlanVersionId periodId newStartDate scope sessionDiffs periodDiffs fixedSessionIds beforeDate afterDate affectedPeriodIds affectedSessionIds relation linkedPlan currentTraining snapshot aggregateId collections privacy_generation rosters coreDependencies dependencyInventory supplementaryManifest routineActualManifest sourcePermissionManifest consumedSources plans races completions course affected coverage complete missing captured purpose app granted policy version recordedAt count revisionSum aiConsent trainingPlan activities checkIns sessionCompletions userConstraints capturedAt name head exists copies sessions exercises resourceVersionIds mediaAssetIds routineId record historyDigest actuals stepId fact requested content currentHead currentSchedule startedRun runId schedules blueprints actualRosters uniqueSourceCount sourceRelation sourceVersionId relativeItems point offsetMinutes sourceRaceRevision sourceRaceDigest entity entityId targetSource contentDigest targets link routine_version_id planned_session_id plan_version_id exercise_version_id target_set_id block_id notificationMuted visibility favorite headVersionId head_version_id headVersion head_version unsupportedContent unsupportedReason deleted originalDigest overlayDigest current source sourceId sourceRevision contentHash suppressed revisionRecord intake recovery revisionId exactOwnedVersion planned resources catalog nestedNutritionSources activityMediaPermissions foods anchors linkedTrainingPlanVersionId requestedVersionId requestedId requestedVersion includeForCoach accessRevision cleanupPending cleanup eligible reviewed reviewedAt reviewState ownership request hash current_version_id current_version sourceRelations unsupported_content_contract_unavailable reasonCode media healthkit garmin lineage provider official outcome sample claim epoch consentRevision payloadDigest sampleDigest targetRevision sourceKind providerConsent claims bindingRegistry globalRegistry canonicalId canonicalRevision generation privacyGeneration localDate localStartTime timezone locationName distance priority participation officialUrl targetSeconds progress origin occurrences runs retainedStartedOccurrences retainedOccurrences plannedOccurrences expansion retainedActualRefs objectIdentity previewPresent idDigest resourceId approvedAt previousVersionId`.split(
    /\s+/,
  ),
);
// Exact producer paths below carry scalar access/head facts only, never source
// bodies. Unknown fields (including injected record/content/spec) are rejected.
const presentRevision = z.strictObject({ state: z.literal('present'), revision: revision.min(1) });
const absent = z.strictObject({ state: z.literal('absent') });
const bodylessMetadata = new Map<string, z.ZodType>([
  ['context.restoreGeneration', uuid],
  ['context.affected.routine', z.array(uuid).max(5000)],
  [
    'context.rosters.routine',
    z.array(z.strictObject({ aggregateId: uuid, versionId: uuid })).max(5000),
  ],
  [
    'context.manualBasis',
    z.strictObject({
      purpose: z.literal('manual_race_date_change'),
      app: z.union([absent, presentRevision.extend({ granted: z.boolean() })]),
      policy: z.strictObject({
        id: z.literal('manual-race-date-impact'),
        version: z.literal(1),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    }),
  ],
  [
    'context.sourcePermissionManifest.activityMediaPermissions.consents',
    z
      .array(
        z.union([
          z.strictObject({
            kind: z.enum(['provider', 'healthkit', 'media']),
            state: z.literal('absent'),
          }),
          presentRevision.extend({
            kind: z.enum(['provider', 'healthkit', 'media']),
            granted: z.boolean(),
          }),
        ]),
      )
      .max(3),
  ],
  [
    'context.sourcePermissionManifest.activityMediaPermissions.garminLineage',
    z
      .array(
        z.strictObject({
          kind: z.enum(['fit', 'fixture', 'manual', 'healthkit']),
          source_id: id,
          provider: z.enum(['garmin-official', 'garmin-connect-unofficial']),
          official: z.boolean(),
          outcome: z.enum(['imported', 'unchanged', 'stale', 'suppressed']),
        }),
      )
      .max(5000),
  ],
  [
    'context.sourcePermissionManifest.activityMediaPermissions.healthkitRegistry',
    z.union([absent, presentRevision]),
  ],
  [
    'context.sourcePermissionManifest.activityMediaPermissions.garminUnofficial',
    z.union([
      absent,
      z.strictObject({
        state: z.literal('present'),
        connection: z.strictObject({
          session_generation: revision,
          state: z.enum(['not_connected', 'connected', 'reconnect_required']),
          schedule_enabled: z.boolean(),
          schedule_paused: z.boolean(),
        }),
      }),
    ]),
  ],
]);
const protectedFields = new Set([
  'record',
  'original',
  'overlay',
  'detail',
  'spec',
  'provenance',
  'draft',
  'item',
  'proposed',
]);

/** Deletion-index cohort only, never authentication, freshness or storage authority.
 * Unknown copied bodies are blocked. Bodyless heads/unavailable facts are diagnostics;
 * they cannot become an exact source reference or an immutable historical identity. */
export function mapRaceManualReviewSourceInventory(raw: unknown) {
  const entries = new Map<string, Entry>();
  const captured = new Map<string, string>();
  const immutableIdentities = new Map<string, string>();
  const unindexable: { path: string; reason: string }[] = [];
  const bodyless: { path: string; state: string }[] = [];
  const base = {
    complete: false as const,
    sourceCompleteness: 'unverified' as const,
    storageAllowed: false as const,
    storage: 'not_persisted' as const,
    coverage: false as const,
    approvalAllowed: false as const,
  };
  try {
    const input = object(decode(raw));
    const allowed = new Set([
      'status',
      'context',
      'storage',
      'sourceCompleteness',
      'approvalAllowed',
      'sourceInput',
      'candidate',
      'binding',
      'integrity',
      'missingFacts',
      'stage',
      'reason',
    ]);
    if (
      !['blocked', 'prepared_blocked'].includes(String(input['status'])) ||
      Object.keys(input).some((key) => !allowed.has(key)) ||
      input['storage'] !== 'not_persisted' ||
      input['sourceCompleteness'] !== 'unverified' ||
      input['approvalAllowed'] !== false
    )
      throw new Error('INVALID_INPUT');
    const context = object(input['context']);
    const capturedBodies = object(context['consumedSources'] ?? { races: [] });
    if (input['candidate'] !== undefined) {
      const verified = verifyRaceManualReviewIntegrity(
        {
          candidate: input['candidate'],
          sourceInput: input['sourceInput'],
          capturedBinding: input['binding'],
          expectedBinding: input['binding'],
        },
        createRaceRelativeScheduleCalculationPorts(capturedBodies['races']),
      );
      if (verified.status !== 'consistent') throw new Error('INVALID_INPUT');
    }
    const athleteId = id.parse(context['athleteId']);
    const blocked = (path: string, reason: string) => {
      unindexable.push({ path, reason });
    };
    function add(ref: Ref, path: string) {
      const key = keyOf(ref),
        old = entries.get(key);
      if (old) old.locations.push(path);
      else {
        if (entries.size >= 5000) throw new Error('INPUT_BOUND');
        entries.set(key, { ...ref, locations: [path] });
      }
    }
    function scan(value: unknown, path: string, capture: boolean, parentKey = ''): void {
      const metadata = bodylessMetadata.get(path);
      if (metadata) {
        metadata.parse(value);
        return;
      }
      if (value === null) return;
      if (Array.isArray(value)) {
        value.forEach((body, index) => scan(body, `${path}[${index}]`, capture, parentKey));
        return;
      }
      if (typeof value !== 'object') {
        if (protectedFields.has(parentKey) || parentKey === 'content')
          blocked(path, 'unsupported_copied_body');
        return;
      }
      const row = object(value),
        exact = identify(row);
      if (exact) {
        const key = keyOf(exact.ref),
          bytes = canonical(exact.body),
          previous = captured.get(key);
        if (capture) {
          const immutableKey = JSON.stringify([
            exact.ref.kind,
            [
              'nutrition-plan-version',
              'recovery-strategy-version',
              'routine-schedule-version',
              'routine-blueprint-version',
            ].includes(exact.ref.kind)
              ? exact.ref.versionKey
              : exact.ref.kind === 'session-completion'
                ? key
                : exact.ref.sourceId,
          ]);
          const immutablePrior = immutableIdentities.get(immutableKey);
          if (immutablePrior !== undefined && immutablePrior !== key)
            throw new Error('SOURCE_CONFLICT');
          immutableIdentities.set(immutableKey, key);
          if (previous !== undefined && previous !== bytes) throw new Error('SOURCE_CONFLICT');
          captured.set(key, bytes);
        } else if (previous === undefined || previous !== bytes) {
          blocked(
            path,
            previous === undefined ? 'captured_source_missing' : 'source_body_conflict',
          );
          return;
        }
        add(exact.ref, path);
        if (exact.ref.kind === 'nutrition-plan-version') {
          const record = nutritionPlanVersionSchema.parse(exact.body);
          if (record.items.some((item) => item.foods.some((food) => food.foodVersionId !== null)))
            blocked(path, 'nested_food_source_unindexed');
        }
        return;
      }
      if ('periods' in row && 'sessions' in row) {
        planDraftSchema.parse(row);
        if (
          capture ||
          ![
            'candidate.body.calendar.plan',
            'candidate.body.writeIntents.training.proposed',
          ].includes(path)
        ) {
          blocked(path, 'derived_plan_source_missing');
          return;
        }
        const current =
          context['currentTraining'] === null ? null : object(context['currentTraining']);
        const snapshot = current ? planSnapshotSchema.parse(current['snapshot']) : null;
        if (!snapshot) blocked(path, 'derived_plan_source_missing');
        else
          add(
            { kind: 'plan-snapshot', sourceId: snapshot.id, versionKey: String(snapshot.version) },
            path,
          );
        return;
      }
      if ('planVersionId' in row && 'anchor' in row && 'category' in row) {
        const item = nutritionPlanItemCoreSchema.parse(row);
        if (
          capture ||
          !/^candidate\.body\.(nutrition\[\d+\]\.items\[\d+\]\.item|writeIntents\.nutrition\[\d+\]\.itemChanges\[\d+\]\.item)$/.test(
            path,
          )
        ) {
          blocked(path, 'derived_item_source_missing');
          return;
        }
        const source = [...entries.values()].find(
          (ref) => ref.kind === 'nutrition-plan-version' && ref.versionKey === item.planVersionId,
        );
        if (!source) blocked(path, 'derived_item_source_missing');
        else add(source, path);
        return;
      }
      if (
        row['content'] === null &&
        ['unavailable', 'deleted', 'absent'].includes(String(row['state']))
      )
        bodyless.push({ path, state: String(row['state']) });
      if (parentKey === 'content' && Object.keys(row).every((key) => key === 'digest')) {
        z.strictObject({ digest: z.string().regex(/^[a-f0-9]{64}$/) }).parse(row);
        return;
      }
      if (
        protectedFields.has(parentKey) ||
        (parentKey === 'content' && Object.keys(row).length > 0)
      ) {
        blocked(path, 'unsupported_copied_body');
        return;
      }
      for (const [key, body] of Object.entries(row)) {
        if (
          !bodylessMetadata.has(`${path}.${key}`) &&
          !metadataKeys.has(key) &&
          !protectedFields.has(key) &&
          !(key === 'body' && path === 'candidate')
        ) {
          blocked(`${path}.${key}`, 'unknown_copied_scope');
          continue;
        }
        scan(body, `${path}.${key}`, capture, key);
      }
    }
    // Only context establishes captured identities. Candidate/sourceInput copies
    // cannot introduce a new source or replace the exact historical body.
    scan(context, 'context', true);
    for (const name of ['sourceInput', 'candidate'])
      if (input[name] !== undefined) scan(input[name], name, false);
    if (
      input['sourceInput'] !== undefined &&
      object(input['sourceInput'])['athleteId'] !== athleteId
    )
      throw new Error('FOREIGN_SCOPE');
    const refs = [...entries.values()]
      .map((ref) => ({ ...ref, locations: [...new Set(ref.locations)].sort(compare) }))
      .sort((a, b) => compare(keyOf(a), keyOf(b)));
    return {
      ...base,
      inventoryState: unindexable.length ? ('blocked' as const) : ('mapped' as const),
      allCopiedBodiesIndexed: unindexable.length === 0,
      refs,
      unindexable: unindexable.sort((a, b) => compare(a.path, b.path)),
      bodyless: bodyless.sort((a, b) => compare(a.path, b.path)),
    };
  } catch (error) {
    return {
      ...base,
      inventoryState: 'blocked' as const,
      allCopiedBodiesIndexed: false,
      refs: [] as Entry[],
      unindexable: [
        {
          path: '$',
          reason:
            error instanceof Error &&
            ['INPUT_BOUND', 'SOURCE_CONFLICT', 'FOREIGN_SCOPE'].includes(error.message)
              ? error.message
              : 'INVALID_INPUT',
        },
      ],
      bodyless: [] as { path: string; state: string }[],
    };
  }
}
