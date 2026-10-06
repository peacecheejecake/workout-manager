import { z } from 'zod';
import { nutritionAnchorSchema } from './nutrition.js';
import {
  idSchema,
  instantSchema,
  localDateSchema,
  localTimeSchema,
  timeZoneSchema,
} from './primitives.js';

/** Contract foundation only: captured facts are not ownership, consent, freshness,
 * resolution or approval authority. Legacy bytes are not normalized into pins. */
const uuid = z
  .uuid()
  .refine((value) => value === value.toLowerCase(), 'Expected canonical lowercase UUID');
const eventRevision = z.number().int().min(1).max(2147483647);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const itemId = idSchema.max(128);
const maximumReferences = 5000;
const maximumBytes = 512 * 1024;

type Issues = z.RefinementCtx;
function issue(context: Issues, path: (string | number)[], message: string) {
  context.addIssue({ code: 'custom', path, message });
}
function sortedUnique(keys: readonly string[], context: Issues, path: (string | number)[]) {
  for (let index = 1; index < keys.length; index++) {
    const previous = keys[index - 1];
    const current = keys[index];
    if (previous !== undefined && current !== undefined && previous >= current)
      issue(context, [...path, index], 'Roster must be sorted and unique');
  }
}
function bounded(value: unknown, context: Issues) {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maximumBytes)
    issue(context, [], 'Timing roster exceeds 512 KiB');
}

export const expectedRaceHeadSchema = z.strictObject({
  namespace: z.literal('race-event'),
  eventId: uuid,
  revision: eventRevision,
});
export const expectedRaceHeadsSchema = z
  .array(expectedRaceHeadSchema)
  .max(maximumReferences)
  .superRefine((heads, context) => {
    sortedUnique(
      heads.map((head) => head.eventId),
      context,
      [],
    );
    bounded(heads, context);
  });
export type ExpectedRaceHeads = z.infer<typeof expectedRaceHeadsSchema>;

const startSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('known'), instant: instantSchema }),
  z.strictObject({
    state: z.literal('unknown'),
    reason: z.enum(['start_time_not_recorded', 'ambiguous_local_time']),
  }),
]);

/** Validates civil correspondence only; a producer must independently verify the
 * source row and ambiguity. No event canonical digest is produced by this schema. */
export const raceTimingPinV1Schema = z
  .strictObject({
    pinVersion: z.literal(1),
    namespace: z.literal('race-event-revision'),
    eventId: uuid,
    eventRevision,
    sourceDigestVersion: z.literal('race-event-values-canonical-v1'),
    sourceDigest: digest,
    localDate: localDateSchema,
    localStartTime: localTimeSchema.nullable(),
    timezone: timeZoneSchema,
    start: startSchema,
    end: z.strictObject({
      state: z.literal('unknown'),
      reason: z.literal('race_end_not_recorded'),
    }),
  })
  .superRefine((pin, context) => {
    if (pin.start.state === 'unknown') {
      const missing = pin.start.reason === 'start_time_not_recorded';
      if (missing !== (pin.localStartTime === null))
        issue(context, ['start'], 'Unknown reason must match the recorded local time');
      return;
    }
    if (pin.localStartTime === null) {
      issue(context, ['start'], 'Known start needs a recorded local time');
      return;
    }
    if (
      !timeZoneSchema.safeParse(pin.timezone).success ||
      !instantSchema.safeParse(pin.start.instant).success
    )
      return;
    if (new Date(pin.start.instant).getUTCMilliseconds() !== 0) {
      issue(context, ['start', 'instant'], 'Recorded local time cannot contain fractional seconds');
      return;
    }
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: pin.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(pin.start.instant));
    const part = (name: string) => parts.find((value) => value.type === name)?.value;
    const date = `${part('year')?.padStart(4, '0')}-${part('month')}-${part('day')}`;
    const time = `${part('hour')}:${part('minute')}:${part('second')}`;
    const recorded =
      pin.localStartTime.length === 5 ? `${pin.localStartTime}:00` : pin.localStartTime;
    if (date !== pin.localDate || time !== recorded)
      issue(context, ['start', 'instant'], 'Instant must match the recorded civil time and zone');
  });
export type RaceTimingPinV1 = z.infer<typeof raceTimingPinV1Schema>;

export const capturedRaceTimingBindingSchema = z.strictObject({
  state: z.literal('captured'),
  eventId: uuid,
  eventRevision,
});
export const legacyUnpinnedRaceTimingBindingSchema = z.strictObject({
  state: z.literal('legacy_unpinned'),
  priorNutritionVersionId: uuid,
  priorItemId: itemId,
  priorAnchorDigest: digest,
});
export const raceTimingBindingSchema = z.discriminatedUnion('state', [
  capturedRaceTimingBindingSchema,
  legacyUnpinnedRaceTimingBindingSchema,
]);
export const itemRaceTimingBindingSchema = z.strictObject({
  itemId,
  binding: raceTimingBindingSchema,
});
export type RaceTimingBinding = z.infer<typeof raceTimingBindingSchema>;
export type ItemRaceTimingBinding = z.infer<typeof itemRaceTimingBindingSchema>;

/** Minimal item projection for matching, never a replacement nutrition draft. */
const anchorItemSchema = z.strictObject({ itemId, anchor: nutritionAnchorSchema });
const itemsSchema = z.array(anchorItemSchema).max(maximumReferences);
function uniqueItems(items: z.infer<typeof itemsSchema>, context: Issues) {
  const ids = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (ids.has(item.itemId)) issue(context, ['items', index, 'itemId'], 'Duplicate item ID');
    ids.add(item.itemId);
  }
}

/** CAS expectations are client intent, never server captured pins. */
export const raceHeadExpectationRosterSchema = z
  .strictObject({ items: itemsSchema, expectedRaceHeads: expectedRaceHeadsSchema })
  .superRefine((roster, context) => {
    uniqueItems(roster.items, context);
    const events = new Set(
      roster.items.flatMap((item) =>
        item.anchor.kind === 'relative' && item.anchor.entity === 'race'
          ? [item.anchor.entityId]
          : [],
      ),
    );
    const expected = new Set(roster.expectedRaceHeads.map((head) => head.eventId));
    if (events.size !== expected.size || [...events].some((id) => !expected.has(id)))
      issue(context, ['expectedRaceHeads'], 'Expectations must match the exact race anchor set');
    bounded(roster, context);
  });

/** Server stored roster structure only. Legacy preservation requires an owned
 * prior unchanged, unaffected item checked by the producer, outside this schema.
 * Known pins do not prove source availability or resolve an approval. */
export const nutritionRaceTimingRosterSchema = z
  .strictObject({
    items: itemsSchema,
    raceTimingPins: z.array(raceTimingPinV1Schema).max(maximumReferences),
    itemRaceTimingBindings: z.array(itemRaceTimingBindingSchema).max(maximumReferences),
  })
  .superRefine((roster, context) => {
    uniqueItems(roster.items, context);
    sortedUnique(
      roster.raceTimingPins.map((pin) => pin.eventId),
      context,
      ['raceTimingPins'],
    );
    sortedUnique(
      roster.itemRaceTimingBindings.map((entry) => entry.itemId),
      context,
      ['itemRaceTimingBindings'],
    );
    const items = new Map(roster.items.map((item) => [item.itemId, item]));
    const pins = new Map(roster.raceTimingPins.map((pin) => [pin.eventId, pin]));
    const bindings = new Set(roster.itemRaceTimingBindings.map((entry) => entry.itemId));
    const usedPins = new Set<string>();
    for (const [index, entry] of roster.itemRaceTimingBindings.entries()) {
      const item = items.get(entry.itemId);
      const path = ['itemRaceTimingBindings', index, 'binding'];
      if (!item || item.anchor.kind !== 'relative' || item.anchor.entity !== 'race') {
        issue(context, path, 'Binding must belong to a race anchor item');
        continue;
      }
      if (entry.binding.state === 'legacy_unpinned') {
        if (entry.binding.priorItemId !== item.itemId)
          issue(context, path, 'Legacy binding must preserve its prior item identity');
        continue;
      }
      const pin = pins.get(entry.binding.eventId);
      if (
        entry.binding.eventId !== item.anchor.entityId ||
        !pin ||
        pin.eventRevision !== entry.binding.eventRevision
      )
        issue(context, path, 'Captured binding must match the exact anchor and pin revision');
      else usedPins.add(pin.eventId);
    }
    for (const [index, item] of roster.items.entries()) {
      if (
        item.anchor.kind === 'relative' &&
        item.anchor.entity === 'race' &&
        !bindings.has(item.itemId)
      )
        issue(context, ['items', index], 'Race item needs an explicit timing binding');
    }
    for (const [index, pin] of roster.raceTimingPins.entries()) {
      if (!usedPins.has(pin.eventId))
        issue(context, ['raceTimingPins', index], 'Orphan timing pin');
    }
    bounded(roster, context);
  });
export type NutritionRaceTimingRoster = z.infer<typeof nutritionRaceTimingRosterSchema>;
export type RaceHeadExpectationRoster = z.infer<typeof raceHeadExpectationRosterSchema>;
