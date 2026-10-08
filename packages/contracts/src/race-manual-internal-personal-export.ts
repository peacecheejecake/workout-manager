import { z } from 'zod';
import { createBoundedPlainJsonSchema } from './bounded-plain-json.js';
import { instantSchema } from './primitives.js';
import { raceManualStoredPlannedFactsSchema } from './race-manual-public-impact.js';
import {
  raceManualApprovalCandidateSchema,
  raceManualApprovalResultSchema,
} from './race-manual-approval.js';
import { raceManualPersonalApprovalHistorySchema } from './race-manual-personal-export.js';

const uuid = z.uuid().transform((v) => v.toLowerCase());
const chainIds = z
  .strictObject({ evidenceId: uuid, decisionId: uuid, proposalId: uuid })
  .superRefine((v, c) => {
    if (new Set([v.evidenceId, v.decisionId, v.proposalId]).size !== 3)
      c.addIssue({ code: 'custom', message: 'Distinct chain identities required' });
  });
/** Individual presentation transport retains its4MiB budget; semantic source
 * and member limits are enforced by the strict planned schema below. */
const plannedPlain = createBoundedPlainJsonSchema(
  4194304,
  'Bounded plain internal export required',
);
const wholePlain = createBoundedPlainJsonSchema(8388608, 'Bounded plain internal export required');
/** Reuses the safe five-domain planned codecs and all exact timing/notice
 * refinements. This is a stored historical presentation, not a transient response
 * and not an executable application candidate. No public reference is invented. */
export const raceManualInternalPlannedContentSchema = plannedPlain.pipe(
  raceManualStoredPlannedFactsSchema,
);
const purge = { state: z.literal('purged'), purgedAt: instantSchema, purgeEventId: uuid };
export const raceManualInternalChainSchema = z
  .strictObject({
    ...chainIds.shape,
    createdAt: instantSchema,
    // SQL116 readonly proposal remains inapplicable; SQL118 committed results
    // below independently record later application of the linked candidate.
    proposalApplied: z.literal(false),
    body: z.discriminatedUnion('state', [
      z.strictObject({
        state: z.literal('present'),
        planned: raceManualInternalPlannedContentSchema,
      }),
      z.strictObject(purge),
    ]),
  })
  .superRefine((v, c) => {
    const parsed = chainIds.safeParse({
      evidenceId: v.evidenceId,
      decisionId: v.decisionId,
      proposalId: v.proposalId,
    });
    if (!parsed.success)
      c.addIssue({ code: 'custom', message: 'Distinct chain identities required' });
  });
const candidateBlockers = raceManualApprovalCandidateSchema.out.options[0].shape.blockers;
export const raceManualInternalCandidateSchema = z
  .strictObject({
    candidateId: uuid,
    chain: chainIds,
    createdAt: instantSchema,
    body: z.union([
      z.strictObject({
        state: z.literal('present'),
        storedApplicationState: z.literal('blocked'),
        planned: raceManualInternalPlannedContentSchema,
        blockers: candidateBlockers,
      }),
      z.strictObject({
        state: z.literal('present'),
        storedApplicationState: z.literal('ready_for_explicit_approval'),
        planned: raceManualInternalPlannedContentSchema,
      }),
      z.strictObject(purge),
    ]),
  })
  .superRefine((v, c) => {
    if ([v.chain.evidenceId, v.chain.decisionId, v.chain.proposalId].includes(v.candidateId))
      c.addIssue({ code: 'custom', message: 'Distinct candidate identity required' });
    if (
      v.body.state === 'present' &&
      v.body.storedApplicationState === 'ready_for_explicit_approval' &&
      v.body.planned.resolutionRequirements.length
    )
      c.addIssue({
        code: 'custom',
        message: 'Stored ready candidate cannot require unresolved replacement',
      });
  });
export const raceManualInternalApprovalResultSchema = raceManualApprovalResultSchema.transform(
  (v, c) => {
    if (v.status !== 'committed') {
      c.addIssue({ code: 'custom', message: 'Original committed result required' });
      return z.NEVER;
    }
    return v;
  },
);
export const raceManualInternalPersonalExportFields = {
  manualInternalChains: z.array(raceManualInternalChainSchema).max(1000),
  manualInternalCandidates: z.array(raceManualInternalCandidateSchema).max(1000),
  manualInternalApprovalResults: z.array(raceManualInternalApprovalResultSchema).max(1000),
  manualInternalApprovalHistory: z.array(raceManualPersonalApprovalHistorySchema).max(1000),
};
type Data = z.infer<z.ZodObject<typeof raceManualInternalPersonalExportFields>>;
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v: unknown, i) => same(v, b[i]))
    );
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const entries = Object.entries(a),
    other = new Map(Object.entries(b));
  return (
    entries.length === other.size &&
    entries.every(([k, v]) => other.has(k) && same(v, other.get(k)))
  );
}
function preciseInstant(value: string): string | null {
  const m = /^(.*:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m?.[1] || !m[3]) return null;
  const seconds = Date.parse(m[1] + m[3]);
  return Number.isSafeInteger(seconds) ? `${seconds}:${(m[2] ?? '').replace(/0+$/, '')}` : null;
}
function sameInstant(a: string, b: string): boolean {
  const value = preciseInstant(a);
  return value !== null && value === preciseInstant(b);
}
/** Same-family structural correspondence only. Cross-account export must also
 * require exact genuine domain version bodies/history/aggregate mappings.
 * Source-provenance privacy policy is unresolved; raw27 refs are not exported. */
export function validateRaceManualInternalPersonalExportTuples(data: Data, c: z.RefinementCtx) {
  const fail = (message: string) => c.addIssue({ code: 'custom', message });
  const chains = new Map(data.manualInternalChains.map((v) => [v.evidenceId, v]));
  const candidates = new Map(data.manualInternalCandidates.map((v) => [v.candidateId, v]));
  const results = new Map(data.manualInternalApprovalResults.map((v) => [v.candidateId, v]));
  if (
    chains.size !== data.manualInternalChains.length ||
    candidates.size !== data.manualInternalCandidates.length ||
    results.size !== data.manualInternalApprovalResults.length
  )
    fail('Duplicate factual identity');
  const all = data.manualInternalChains
    .flatMap((v) => [v.evidenceId, v.decisionId, v.proposalId])
    .concat(data.manualInternalCandidates.map((v) => v.candidateId));
  if (new Set(all).size !== all.length) fail('Foreign or duplicate chain role identity');
  for (const v of data.manualInternalCandidates) {
    const parent = chains.get(v.chain.evidenceId);
    if (
      !parent ||
      parent.decisionId !== v.chain.decisionId ||
      parent.proposalId !== v.chain.proposalId
    ) {
      fail('Exact chain parent required');
      continue;
    }
    if (parent.body.state !== v.body.state) fail('Parent and candidate purge state must agree');
    if (
      v.body.state === 'purged' &&
      parent.body.state === 'purged' &&
      (v.body.purgeEventId !== parent.body.purgeEventId ||
        !sameInstant(v.body.purgedAt, parent.body.purgedAt))
    )
      fail('Exact parent purge required');
    if (v.body.state === 'present' && parent.body.state === 'present') {
      const a = parent.body.planned,
        b = v.body.planned;
      if (
        !same(a.intent, b.intent) ||
        !same(a.expectedEvent, b.expectedEvent) ||
        !same(a.race.before, b.race.before)
      )
        fail('Frozen intent/event correspondence required');
      for (const domain of ['training', 'nutrition', 'recovery', 'routines'] as const) {
        const x = a[domain],
          y = b[domain];
        if (x.state !== y.state) {
          fail('Frozen domain roster required');
          continue;
        }
        if (x.state === 'present' && y.state === 'present') {
          const roster = new Map(x.members.map((m) => [m.aggregateId, m.before]));
          if (
            roster.size !== y.members.length ||
            y.members.some((m) => !same(roster.get(m.aggregateId), m.before))
          )
            fail('Exact frozen before body required');
        }
      }
    }
  }
  if (new Set(data.manualInternalApprovalResults.map((v) => v.approvalId)).size !== results.size)
    fail('Duplicate approval identity');
  for (const result of results.values()) {
    const candidate = candidates.get(result.candidateId);
    if (!candidate || candidate.chain.proposalId !== result.proposalId)
      fail('Committed result exact candidate/proposal required');
    if (
      candidate?.body.state === 'present' &&
      candidate.body.storedApplicationState !== 'ready_for_explicit_approval'
    )
      fail('Blocked candidate cannot have committed result');
    if (candidate?.body.state === 'present') {
      const p = candidate.body.planned;
      if (
        result.race.eventId !== p.expectedEvent.id ||
        result.race.revision !== p.expectedEvent.revision + 1
      )
        fail('Original committed race successor required');
      const expected = new Set(p.affected.map((v) => JSON.stringify([v.domain, v.aggregateId])));
      const actual = new Set(result.versions.map((v) => JSON.stringify([v.domain, v.aggregateId])));
      if (expected.size !== actual.size || [...expected].some((k) => !actual.has(k)))
        fail('Exact committed affected membership required');
    }
    for (const version of result.versions) {
      const rows = data.manualInternalApprovalHistory.filter(
        (h) =>
          h.candidateId === result.candidateId &&
          h.approvalId === result.approvalId &&
          h.domain === version.domain &&
          h.aggregateId === version.aggregateId &&
          h.versionId === version.versionId,
      );
      if (rows.length !== 1 || !rows[0] || !sameInstant(rows[0].approvedAt, result.approvedAt))
        fail('Exact original version/history correspondence required');
    }
  }
  const keys = new Set<string>();
  for (const h of data.manualInternalApprovalHistory) {
    const key = JSON.stringify([h.candidateId, h.approvalId, h.domain, h.aggregateId]);
    if (keys.has(key)) fail('Duplicate approval history');
    keys.add(key);
    const result = results.get(h.candidateId);
    if (
      !result ||
      result.approvalId !== h.approvalId ||
      !result.versions.some(
        (v) =>
          v.domain === h.domain && v.aggregateId === h.aggregateId && v.versionId === h.versionId,
      )
    )
      fail('History requires original committed version');
  }
}
/** Whole-account consumers reuse the exact compact JSON bound, without changing
 * the independent planned-body/source semantic limits. */
export const raceManualInternalWholePlainSchema = wholePlain;
export const raceManualInternalPersonalExportSchema = raceManualInternalWholePlainSchema.pipe(
  z
    .strictObject({
      schemaVersion: z.literal(1),
      sourceProvenanceCoverage: z.literal('not_exported_policy_unresolved'),
      ...raceManualInternalPersonalExportFields,
    })
    .superRefine(validateRaceManualInternalPersonalExportTuples),
);
export type RaceManualInternalPersonalExport = z.infer<
  typeof raceManualInternalPersonalExportSchema
>;
