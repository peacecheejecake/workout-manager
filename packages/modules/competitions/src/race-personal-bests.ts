import { z } from 'zod';
import { localDateSchema } from '@workout/contracts/primitives';
import {
  raceResultCompatibleReadSchema,
  RACE_RESULT_V2_MAX_BYTES,
  type RaceResultCompatibleRead,
} from '@workout/contracts/race-result-v2';

const MAX_RECORDS = 5000;
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const timeKindSchema = z.enum(['chip', 'gun']);
const policyFields = {
  distance: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('standard') }),
    z.strictObject({ kind: z.literal('exact') }),
  ]),

  // Inclusive civil dates in each record's stored timezone. No fabricated
  // instant ordering across timezones; caller explicitly supplies its cutoff.
  period: z.strictObject({
    from: localDateSchema.nullable(),
    to: localDateSchema.nullable(),
    cutoff: localDateSchema,
  }),
};
export const racePersonalBestPolicySchema = z
  .union([
    z.strictObject({
      ...policyFields,
      time: z.strictObject({ kind: z.literal('chip-preferred') }),
    }),
    z.strictObject({
      ...policyFields,
      timeKinds: z
        .array(timeKindSchema)
        .min(1)
        .max(2)
        .refine((values) => new Set(values).size === values.length),
    }),
  ])
  .refine(
    (value) =>
      value.period.from === null ||
      value.period.to === null ||
      value.period.from <= value.period.to,
  );
const inputSchema = z.strictObject({
  records: z.array(raceResultCompatibleReadSchema).max(MAX_RECORDS),
  policy: racePersonalBestPolicySchema,
});
export type RacePersonalBestPolicy = z.infer<typeof racePersonalBestPolicySchema>;
export type RacePersonalBestTimeKind = z.infer<typeof timeKindSchema>;
export type RacePersonalBestExclusion =
  | 'device_source'
  | 'outside_period'
  | 'after_cutoff'
  | 'distance_unknown'
  | 'distance_not_standard'
  | 'time_unknown'
  | 'time_zero';
export class RacePersonalBestInputError extends Error {
  readonly code = 'INVALID_PERSONAL_BEST_INPUT';
  constructor() {
    super('INVALID_PERSONAL_BEST_INPUT');
  }
}
export type RacePersonalBestEvaluation = Readonly<{
  record: RaceResultCompatibleRead;
  timeKind: RacePersonalBestTimeKind;
  distance:
    | Readonly<{
        kind: 'standard';
        class: '5k' | '10k' | 'half-marathon' | 'marathon';
        meters: number;
      }>
    | Readonly<{ kind: 'exact'; meters: number }>
    | null;
  seconds: number | null;
  exclusion: RacePersonalBestExclusion | null;
  evidence: Readonly<{
    linkPresent: boolean;
    availableAttachments: number;
    unavailableAttachments: number;
    legacyVerifiedAt: string | null;
  }>;
}>;
export type RacePersonalBestGroup = Readonly<{
  distance: NonNullable<RacePersonalBestEvaluation['distance']>;
  timeKind: RacePersonalBestTimeKind | 'chip-preferred';
  best: RacePersonalBestEvaluation;
  candidates: readonly RacePersonalBestEvaluation[];
}>;
const standard = new Map<number, '5k' | '10k' | 'half-marathon' | 'marathon'>([
  [5000, '5k'],
  [10000, '10k'],
  [21097.5, 'half-marathon'],
  [42195, 'marathon'],
]);
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function parse(raw: unknown) {
  try {
    const json = JSON.stringify(raw);
    if (json === undefined || new TextEncoder().encode(json).byteLength > MAX_INPUT_BYTES)
      throw new Error();
    const parsed = inputSchema.parse(raw);
    const seen = new Set<string>();
    for (const record of parsed.records) {
      if (
        seen.has(record.id) ||
        new TextEncoder().encode(JSON.stringify(record)).byteLength > RACE_RESULT_V2_MAX_BYTES
      )
        throw new Error();
      // One current revision per ID; never choose a head from arbitrary history.
      seen.add(record.id);
    }
    return parsed;
  } catch {
    throw new RacePersonalBestInputError();
  }
}
function distanceFor(
  record: RaceResultCompatibleRead,
  policy: RacePersonalBestPolicy,
): RacePersonalBestEvaluation['distance'] {
  const meters = record.officialDistanceMeters;
  if (meters === null) return null;
  if (policy.distance.kind === 'exact') return { kind: 'exact', meters };
  const category = standard.get(meters);
  return category === undefined ? null : { kind: 'standard', class: category, meters };
}
function evidence(record: RaceResultCompatibleRead): RacePersonalBestEvaluation['evidence'] {
  return {
    linkPresent:
      'schemaVersion' in record ? record.proofs.link !== null : record.source.kind === 'official',
    availableAttachments:
      'schemaVersion' in record
        ? record.proofs.attachments.filter((ref) => ref.status === 'available').length
        : 0,
    unavailableAttachments:
      'schemaVersion' in record
        ? record.proofs.attachments.filter((ref) => ref.status === 'unavailable').length
        : 0,
    legacyVerifiedAt:
      !('schemaVersion' in record) && record.source.kind === 'official'
        ? record.source.verifiedAt
        : null,
  };
}
/** Pure candidate calculation, NOT source ownership, certification or PB policy storage.
 * Caller must supply records from its authenticated owned repository boundary.
 * Manual/official user records are candidates; device estimates are excluded.
 * Attachment/link presence and legacy timestamps do not certify authenticity.
 * No Plan approval, source fetch, saved preference or mutation occurs here.
 */
export function calculateRacePersonalBests(raw: unknown): Readonly<{
  policy: RacePersonalBestPolicy;
  evaluations: readonly RacePersonalBestEvaluation[];
  groups: readonly RacePersonalBestGroup[];
}> {
  const { records, policy } = parse(raw);
  const evaluations: RacePersonalBestEvaluation[] = [];
  const grouped = new Map<string, RacePersonalBestEvaluation[]>();
  for (const record of [...records].sort((a, b) => compareText(a.id, b.id))) {
    const timeKinds: RacePersonalBestTimeKind[] =
      'time' in policy
        ? [record.chipSeconds === null ? 'gun' : 'chip']
        : [...policy.timeKinds].sort(compareText);
    for (const timeKind of timeKinds) {
      const distance = distanceFor(record, policy);
      const seconds = timeKind === 'chip' ? record.chipSeconds : record.gunSeconds;
      let exclusion: RacePersonalBestExclusion | null = null;
      if (record.source.kind === 'device') exclusion = 'device_source';
      else if (record.localDate > policy.period.cutoff) exclusion = 'after_cutoff';
      else if (
        (policy.period.from !== null && record.localDate < policy.period.from) ||
        (policy.period.to !== null && record.localDate > policy.period.to)
      )
        exclusion = 'outside_period';
      else if (record.officialDistanceMeters === null) exclusion = 'distance_unknown';
      else if (distance === null) exclusion = 'distance_not_standard';
      else if (seconds === null) exclusion = 'time_unknown';
      else if (seconds === 0) exclusion = 'time_zero';
      const evaluated: RacePersonalBestEvaluation = {
        record,
        timeKind,
        distance,
        seconds,
        exclusion,
        evidence: evidence(record),
      };
      evaluations.push(evaluated);
      if (exclusion === null && distance !== null) {
        const key = `${distance.meters}:${'time' in policy ? 'chip-preferred' : timeKind}`;
        const group = grouped.get(key) ?? [];
        group.push(evaluated);
        grouped.set(key, group);
      }
    }
  }
  const groups: RacePersonalBestGroup[] = [];
  for (const candidates of grouped.values()) {
    candidates.sort(
      (a, b) =>
        (a.seconds ?? Infinity) - (b.seconds ?? Infinity) ||
        compareText(a.record.localDate, b.record.localDate) ||
        compareText(a.record.id, b.record.id),
    );
    const best = candidates[0];
    if (best?.distance)
      groups.push({
        distance: best.distance,
        timeKind: 'time' in policy ? 'chip-preferred' : best.timeKind,
        best,
        candidates,
      });
  }
  groups.sort(
    (a, b) => a.distance.meters - b.distance.meters || compareText(a.timeKind, b.timeKind),
  );
  return { policy, evaluations, groups };
}
