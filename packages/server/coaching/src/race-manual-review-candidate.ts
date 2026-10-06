import { createHash } from 'node:crypto';
import { z } from 'zod';
import { raceEventSchema } from '@workout/contracts/races';
import { localDateSchema } from '@workout/contracts/primitives';
import {
  projectRaceRelativeScheduleImpact,
  type RaceScheduleCalculationPorts,
} from './race-relative-schedule-impact.js';

const id = z.string().min(1).max(200);
const uuid = z.uuid();
const ref = z.strictObject({ eventId: uuid, revision: z.number().int().min(1).max(2147483647) });
const binding = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('pinned'), ref }),
  z.strictObject({ state: z.literal('legacy_unpinned') }),
]);
const inputSchema = z.strictObject({
  athleteId: id,
  projectionInput: z.unknown(),
  sourceFacts: z.strictObject({
    ownerAthleteId: id,
    nutritionRacePins: z
      .array(z.strictObject({ nutritionVersionId: uuid, itemId: id, binding }))
      .max(5000),
  }),
});
// This subset is extracted only AFTER the existing projection has strictly
// validated the entire input. It is not a second projection calculation.
const eventEnvelope = z.object({
  event: raceEventSchema,
  newLocalDate: localDateSchema,
  selection: z.unknown(),
});
const approval = Object.freeze({
  status: 'blocked' as const,
  reasons: [
    'source_completeness_unverified',
    'owned_immutable_review_not_stored',
    'dependency_freshness_unverified',
    'atomic_approval_not_implemented',
  ] as const,
});
function freeze(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freeze(child, seen);
  Object.freeze(value);
}
freeze(approval);
/** Object keys and set rosters are normalized, but semantic arrays (blueprint
 * steps, session steps, run progress) retain their original sequence. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('INVALID_INPUT');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => compare(a, b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(',')}}`;
}
function bytes(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('INVALID_INPUT');
  return Buffer.byteLength(encoded, 'utf8');
}
const key = (version: string, item: string) => JSON.stringify([version, item]);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byId = <T extends { id: string }>(values: readonly T[]) =>
  [...values].sort((a, b) => compare(a.id, b.id));
const sha = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const rejected = (reason: string) => ({
  kind: 'manual-race-review-draft' as const,
  status: 'rejected' as const,
  reason,
  storage: 'not_persisted' as const,
  approval,
});
interface ReviewNotice {
  domain: 'nutrition' | 'routine_schedule';
  versionId: string;
  itemId: string | null;
  reason:
    | 'affected_unresolved_requires_resolution'
    | 'existing_unresolved_preserved'
    | 'historical_pin_not_retargeted'
    | 'race_binding_unavailable';
}
interface PinIntent {
  nutritionVersionId: string;
  itemId: string;
  prior: z.infer<typeof binding> | { state: 'absent' };
  state: 'requires_explicit_review' | 'preserved';
  target: z.infer<typeof ref> | null;
  allocation: 'not_allocated';
}

/** Assemble a server-built draft, not a public approval command. Supplied facts
 * are data to review, never proof of source completeness or authentication. */
export function assembleRaceManualReviewCandidate(
  raw: unknown,
  ports: RaceScheduleCalculationPorts,
) {
  try {
    if (bytes(raw) > 4194304) return rejected('projection_bound');
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success) return rejected('invalid_input');
    const input = parsed.data;
    if (input.athleteId !== input.sourceFacts.ownerAthleteId)
      return rejected('foreign_source_scope');
    const pins = new Map(
      input.sourceFacts.nutritionRacePins.map((pin) => [
        key(pin.nutritionVersionId, pin.itemId),
        pin.binding,
      ]),
    );
    if (pins.size !== input.sourceFacts.nutritionRacePins.length)
      return rejected('duplicate_pin_fact');
    const projectionInput = structuredClone(input.projectionInput);
    const projection = projectRaceRelativeScheduleImpact(projectionInput, ports);
    if (projection.status !== 'projected') return rejected(projection.reason);
    const { event, newLocalDate, selection } = eventEnvelope.parse(projectionInput);
    const eventChanges = event.localDate !== newLocalDate;
    if (event.revision > 2147483647 || (eventChanges && event.revision === 2147483647))
      return rejected('race_revision_overflow');
    const expectedRaceRef = {
      eventId: event.id,
      revision: event.revision + (eventChanges ? 1 : 0),
    };
    const consumed = new Set<string>();
    const pinIntents: PinIntent[] = [];
    const blocking: ReviewNotice[] = [];
    const preservedNotices: ReviewNotice[] = [];
    let refs = input.sourceFacts.nutritionRacePins.length + projection.completionReports.length;
    const nutrition = [...projection.nutrition]
      .sort((a, b) => compare(a.planVersionId, b.planVersionId))
      .map((context) => {
        refs += context.items.length;
        const items = context.items.map((entry) => {
          if (entry.notice === 'affected_unresolved_requires_resolution')
            blocking.push({
              domain: 'nutrition' as const,
              versionId: context.planVersionId,
              itemId: entry.itemId,
              reason: entry.notice,
            });
          if (entry.notice === 'existing_unresolved_preserved')
            preservedNotices.push({
              domain: 'nutrition' as const,
              versionId: context.planVersionId,
              itemId: entry.itemId,
              reason: entry.notice,
            });
          // Inspect original anchor as well as the explicit proposed anchor: a
          // reanchor to absolute does not erase its historical binding fact.
          const original = context.record.items.find((item) => item.id === entry.itemId);
          if (!original) throw new Error('SOURCE_IDENTITY_MISMATCH');
          if (original.anchor.kind === 'relative' && original.anchor.entity === 'race') {
            const identity = key(context.planVersionId, entry.itemId),
              prior = pins.get(identity) ?? { state: 'absent' as const };
            if (pins.has(identity)) consumed.add(identity);
            if (prior.state === 'pinned' && prior.ref.eventId !== original.anchor.entityId)
              throw new Error('PIN_SOURCE_MISMATCH');
            if (
              prior.state === 'pinned' &&
              prior.ref.eventId === event.id &&
              prior.ref.revision > event.revision
            )
              throw new Error('PIN_SOURCE_MISMATCH');
            const affected = entry.state === 'affected';
            const candidateTarget =
              entry.item.anchor.kind === 'relative' &&
              entry.item.anchor.entity === 'race' &&
              entry.item.anchor.entityId === event.id
                ? expectedRaceRef
                : null;
            pinIntents.push({
              nutritionVersionId: context.planVersionId,
              itemId: entry.itemId,
              prior,
              state: affected ? ('requires_explicit_review' as const) : ('preserved' as const),
              target: affected ? candidateTarget : null,
              allocation: 'not_allocated' as const,
            });
            if (affected && (prior.state !== 'pinned' || prior.ref.revision !== event.revision))
              blocking.push({
                domain: 'nutrition' as const,
                versionId: context.planVersionId,
                itemId: entry.itemId,
                reason:
                  prior.state === 'pinned'
                    ? 'historical_pin_not_retargeted'
                    : 'race_binding_unavailable',
              });
          }
          return entry;
        });
        return {
          ...context,
          record: { ...context.record, items: byId(context.record.items) },
          items: [...items].sort((a, b) => compare(a.itemId, b.itemId)),
        };
      });
    if (consumed.size !== pins.size) return rejected('unmatched_pin_fact');
    const routines = [...projection.routines]
      .sort((a, b) => compare(a.scheduleVersionId, b.scheduleVersionId))
      .map((context) => {
        refs += context.occurrences.length + context.runs.length + context.blueprint.steps.length;
        refs += context.runs.reduce(
          (total, run) =>
            total +
            run.progress.reduce((size, progress) => size + 1 + progress.actualRefs.length, 0),
          0,
        );
        refs +=
          context.projection?.expansion.state === 'expanded'
            ? context.projection.expansion.occurrences.length
            : 0;
        if (context.notice === 'affected_unresolved_requires_resolution')
          blocking.push({
            domain: 'routine_schedule' as const,
            versionId: context.scheduleVersionId,
            itemId: null,
            reason: context.notice,
          });
        if (context.notice === 'existing_unresolved_preserved')
          preservedNotices.push({
            domain: 'routine_schedule' as const,
            versionId: context.scheduleVersionId,
            itemId: null,
            reason: context.notice,
          });
        return {
          ...context,
          occurrences: byId(context.occurrences),
          runs: byId(context.runs),
          projection: context.projection
            ? {
                ...context.projection,
                expansion:
                  context.projection.expansion.state === 'expanded'
                    ? {
                        ...context.projection.expansion,
                        occurrences: byId(context.projection.expansion.occurrences),
                      }
                    : context.projection.expansion,
                retainedOccurrences: byId(context.projection.retainedOccurrences),
                plannedOccurrences: byId(context.projection.plannedOccurrences),
              }
            : null,
        };
      });
    if (refs > 5000) return rejected('projection_bound');
    const normalizedPlan = projection.calendar.plan
      ? {
          ...projection.calendar.plan,
          periods: byId(projection.calendar.plan.periods),
          sessions: byId(projection.calendar.plan.sessions),
        }
      : null;
    refs += normalizedPlan ? normalizedPlan.periods.length + normalizedPlan.sessions.length : 0;
    if (refs > 5000) return rejected('projection_bound');
    const writeIntents = {
      event: eventChanges
        ? {
            kind: 'race-event' as const,
            expected: { eventId: event.id, revision: event.revision },
            expectedNextRevision: expectedRaceRef.revision,
            proposedLocalDate: newLocalDate,
          }
        : null,
      training:
        projection.calendar.periodDiffs.length || projection.calendar.sessionDiffs.length
          ? {
              kind: 'training' as const,
              sourceVersionId: projection.calendar.currentPlanVersionId,
              proposed: normalizedPlan,
              allocation: 'not_allocated' as const,
            }
          : null,
      nutrition: nutrition
        .filter((context) => context.items.some((item) => item.state === 'affected'))
        .map((context) => ({
          kind: 'nutrition' as const,
          sourceVersionId: context.planVersionId,
          itemChanges: context.items.filter((item) => item.state === 'affected'),
          allocation: 'not_allocated' as const,
        })),
      routines: routines
        .filter((context) => context.state === 'affected' && context.projection !== null)
        .map((context) => ({
          kind: 'routine_schedule' as const,
          sourceVersionId: context.scheduleVersionId,
          projection: context.projection,
          allocation: 'not_allocated' as const,
        })),
    };
    const retainedActualManifest = {
      completionReports: [...projection.completionReports].sort((a, b) =>
        compare(a.sessionId, b.sessionId),
      ),
      routines: routines.map((context) => ({
        scheduleVersionId: context.scheduleVersionId,
        blueprint: context.blueprint,
        runs: context.runs,
        occurrences: context.occurrences,
        retainedStartedOccurrences: context.occurrences.filter((occurrence) =>
          context.runs.some(
            (run) => run.origin.kind === 'planned' && run.origin.occurrenceId === occurrence.id,
          ),
        ),
      })),
    };
    const body = {
      schemaVersion: 1 as const,
      methodVersion: 'manual-race-review-draft-v1' as const,
      athleteId: input.athleteId,
      event,
      selection,
      calendar: {
        ...projection.calendar,
        plan: normalizedPlan,
        periodDiffs: byId(projection.calendar.periodDiffs),
        sessionDiffs: byId(projection.calendar.sessionDiffs),
        fixedSessionIds: [...projection.calendar.fixedSessionIds].sort(compare),
      },
      nutrition,
      routines,
      writeIntents,
      pinIntents: [...pinIntents].sort((a, b) =>
        compare(key(a.nutritionVersionId, a.itemId), key(b.nutritionVersionId, b.itemId)),
      ),
      retainedActualManifest,
      resolution: {
        requiresResolution: projection.requiresResolution || blocking.length > 0,
        blocking: [...blocking].sort((a, b) => compare(canonical(a), canonical(b))),
        preservedNotices: [...preservedNotices].sort((a, b) => compare(canonical(a), canonical(b))),
      },
      sourceCompleteness: 'unverified' as const,
      storage: 'not_persisted' as const,
      approval,
    };
    if (bytes(body) > 4194304) return rejected('projection_bound');
    const digest = sha(body);
    freeze(body);
    return Object.freeze({
      kind: 'manual-race-review-draft' as const,
      status: 'assembled' as const,
      storage: 'not_persisted' as const,
      approval,
      digest,
      body,
    });
  } catch (error) {
    return rejected(
      error instanceof Error &&
        ['PIN_SOURCE_MISMATCH', 'SOURCE_IDENTITY_MISMATCH'].includes(error.message)
        ? error.message.toLowerCase()
        : 'invalid_input',
    );
  }
}
