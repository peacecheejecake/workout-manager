import { z } from 'zod';
import {
  raceManualInternalPersonalExportSchema,
  raceManualInternalPlannedContentSchema,
  raceManualInternalApprovalResultSchema,
  type RaceManualInternalPersonalExport,
} from '@workout/contracts/race-manual-internal-personal-export';
import { raceManualApprovalCandidateSchema } from '@workout/contracts/race-manual-approval';
import { raceManualPersonalApprovalHistorySchema } from '@workout/contracts/race-manual-personal-export';
import {
  assembleRaceManualReviewCandidateCompatibleV4,
  raceManualReviewCandidateV2InputSchema,
  raceManualReviewCandidateV2ResultSchema,
} from '@workout/server-coaching/race-manual-review-candidate-v2';
import { raceImpactConsumedCaptureSchema } from './race-plan-impact-complete-manifest.js';
import {
  buildRacePlanImpactProjectionInput,
  createRacePlanImpactCapturedCalculationPorts,
} from './race-plan-impact-projection-input.js';
import { raceManualReviewChainResultV2Schema } from './race-manual-review-chain-v2.js';
import {
  projectRaceManualPublicImpact,
  normalizeRaceManualImpactProjectionCapture,
  RaceManualPublicImpactError,
} from './race-manual-public-impact.js';
import {
  projectRaceManualReadyPlannedSource,
  RaceManualPublicPreviewError,
} from './race-manual-public-preview.js';
import { impactDependencyDigest } from './race-plan-impact-dependencies.js';

const uuid = z.uuid().transform((v) => v.toLowerCase());
const instant = z.iso.datetime({ offset: true });
const chain = z.strictObject({ evidenceId: uuid, decisionId: uuid, proposalId: uuid });
const purge = z.strictObject({ purgedAt: instant, purgeEventId: uuid });
const preparation = z.strictObject({
  context: raceImpactConsumedCaptureSchema,
  sourceInput: raceManualReviewCandidateV2InputSchema,
  candidate: raceManualReviewCandidateV2ResultSchema,
});
const chainCommon = {
  ...chain.shape,
  createdAt: instant,
  originalResult: raceManualReviewChainResultV2Schema,
};
const chainSource = z.discriminatedUnion('bodyState', [
  z.strictObject({ ...chainCommon, bodyState: z.literal('present'), preparation, purge: z.null() }),
  z.strictObject({ ...chainCommon, bodyState: z.literal('purged'), preparation: z.null(), purge }),
]);
const candidateCommon = { candidateId: uuid, chain, createdAt: instant };
const candidateSource = z.discriminatedUnion('bodyState', [
  z.strictObject({
    ...candidateCommon,
    bodyState: z.literal('present'),
    candidate: raceManualApprovalCandidateSchema,
    purge: z.null(),
  }),
  z.strictObject({
    ...candidateCommon,
    bodyState: z.literal('purged'),
    candidate: z.null(),
    purge,
  }),
]);
/** Narrow internal selected source. It is not a public command or source seal;
 * SQL enumeration must establish tenant, original receipt and purge provenance. */
export const raceManualInternalPersonalExportSourceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  chains: z.array(chainSource).max(1000),
  candidates: z.array(candidateSource).max(1000),
  approvalResults: z.array(raceManualInternalApprovalResultSchema).max(1000),
  approvalHistory: z.array(raceManualPersonalApprovalHistorySchema).max(1000),
});
export class RaceManualInternalPersonalExportError extends Error {
  constructor(
    readonly code: 'INTERNAL_MANUAL_EXPORT_INVALID_SOURCE' | 'INTERNAL_MANUAL_EXPORT_LIMIT',
  ) {
    super(code);
  }
}
function invalid(): never {
  throw new RaceManualInternalPersonalExportError('INTERNAL_MANUAL_EXPORT_INVALID_SOURCE');
}
function limit(): never {
  throw new RaceManualInternalPersonalExportError('INTERNAL_MANUAL_EXPORT_LIMIT');
}
function bounded(raw: unknown): void {
  let nodes = 0,
    bytes = 0;
  const seen = new Set<object>();
  function charge(s: string) {
    if (s.length > 8388608 - bytes) limit();
    bytes += Buffer.byteLength(s, 'utf8');
    if (bytes > 8388608) limit();
  }
  function visit(v: unknown, depth: number): void {
    if (++nodes > 8388608 || depth > 64) limit();
    if (typeof v === 'string') return charge(v);
    if (v === null || typeof v === 'boolean') return;
    if (typeof v === 'number' && Number.isFinite(v)) return;
    if (typeof v !== 'object' || seen.has(v)) invalid();
    const array = Array.isArray(v),
      proto: unknown = Object.getPrototypeOf(v);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) invalid();
    const keys = Reflect.ownKeys(v);
    if (keys.length > 8388609 || (array && keys.length !== v.length + 1)) invalid();
    seen.add(v);
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (
        typeof key !== 'string' ||
        (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= v.length))
      )
        invalid();
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (!d?.enumerable || !Object.hasOwn(d, 'value')) invalid();
      charge(key);
      visit(d.value, depth + 1);
    }
    seen.delete(v);
  }
  visit(raw, 0);
  if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > 8388608) limit();
}
function same(a: unknown, b: unknown) {
  return impactDependencyDigest(a) === impactDependencyDigest(b);
}
function sameAffectedMembership(
  a: readonly { domain: string; aggregateId: string }[],
  b: readonly { domain: string; aggregateId: string }[],
) {
  const keys = (rows: typeof a) => rows.map((row) => JSON.stringify([row.domain, row.aggregateId]));
  const actual = keys(a),
    expected = keys(b);
  return (
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    new Set(expected).size === expected.length &&
    expected.every((key) => actual.includes(key))
  );
}
function sameInstant(a: string, b: string) {
  function canonical(v: string) {
    const m = /^(.*:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(v);
    if (!m?.[1] || !m[3]) return null;
    return `${Date.parse(m[1] + m[3])}:${(m[2] ?? '').replace(/0+$/, '')}`;
  }
  const v = canonical(a);
  return v !== null && v === canonical(b);
}
type Preparation = z.infer<typeof preparation>;
function validatePreparation(p: Preparation) {
  const c = p.context,
    s = p.sourceInput;
  if (
    !c.calendarIntent ||
    c.manualBasis.app.state !== 'present' ||
    !c.manualBasis.app.granted ||
    p.candidate.status !== 'assembled_readonly'
  )
    invalid();
  const capture = normalizeRaceManualImpactProjectionCapture(c);
  const built = buildRacePlanImpactProjectionInput(capture, c.calendarIntent);
  if (built.status !== 'projected') {
    if (built.reason === 'projection_bound') limit();
    invalid();
  }
  const expected = raceManualReviewCandidateV2InputSchema.parse({
    athleteId: c.athleteId,
    binding: {
      purpose: c.manualBasis.purpose,
      event: { id: c.event.id, revision: c.event.revision },
      appRevision: c.manualBasis.app.revision,
      policy: c.manualBasis.policy,
      restoreGeneration: c.restoreGeneration,
      readSetDigest: c.readSetDigest,
    },
    projectionInput: built.input,
    sourceFacts: built.sourceFacts,
  });
  if (!same(expected, s)) invalid();
  const reassembled = assembleRaceManualReviewCandidateCompatibleV4(
    s,
    createRacePlanImpactCapturedCalculationPorts(capture),
  );
  if (reassembled.status !== 'assembled_readonly' || !same(reassembled, p.candidate)) invalid();
  const projected = projectRaceManualPublicImpact({ context: c, intent: c.calendarIntent });
  if (projected.status !== 'projected') {
    if (projected.reason === 'limit_exceeded') limit();
    invalid();
  }
  return projected;
}
function planned(p: Preparation) {
  const projected = validatePreparation(p);
  return raceManualInternalPlannedContentSchema.parse({
    ...projected,
    persistence: 'stored_history',
    beforeBasis: 'frozen_review',
  });
}
/** Pure historical projection; no DB reads, current heads, public receipts,
 * source authentication, permission or approval are manufactured here. */
export function renderRaceManualInternalPersonalExport(
  raw: unknown,
): RaceManualInternalPersonalExport {
  try {
    return render(raw);
  } catch (error) {
    if (error instanceof RaceManualInternalPersonalExportError) throw error;
    if (error instanceof RaceManualPublicImpactError && error.code === 'PUBLIC_IMPACT_LIMIT')
      limit();
    if (error instanceof RaceManualPublicPreviewError && error.code === 'PUBLIC_PREVIEW_LIMIT')
      limit();
    if (
      error instanceof z.ZodError &&
      error.issues.some((i) => i.message === 'Bounded plain internal export required')
    )
      limit();
    invalid();
  }
}
function render(raw: unknown): RaceManualInternalPersonalExport {
  bounded(raw);
  const decoded = raceManualInternalPersonalExportSourceSchema.safeParse(raw);
  if (!decoded.success) invalid();
  const data = decoded.data;
  const sources = new Map(data.chains.map((v) => [v.evidenceId, v]));
  if (sources.size !== data.chains.length) invalid();
  const chains = data.chains.map((v) => {
    const r = v.originalResult;
    if (
      r.evidenceId !== v.evidenceId ||
      r.decisionId !== v.decisionId ||
      r.proposalId !== v.proposalId ||
      !sameInstant(r.createdAt, v.createdAt)
    )
      invalid();
    if (
      v.bodyState === 'present' &&
      (v.preparation.candidate.status !== 'assembled_readonly' ||
        r.candidateDigest !== v.preparation.candidate.digest)
    )
      invalid();
    return {
      evidenceId: v.evidenceId,
      decisionId: v.decisionId,
      proposalId: v.proposalId,
      createdAt: v.createdAt,
      proposalApplied: false as const,
      body:
        v.bodyState === 'purged'
          ? { state: 'purged' as const, ...v.purge }
          : { state: 'present' as const, planned: planned(v.preparation) },
    };
  });
  const candidates = data.candidates.map((v) => {
    const parent = sources.get(v.chain.evidenceId);
    if (
      !parent ||
      parent.decisionId !== v.chain.decisionId ||
      parent.proposalId !== v.chain.proposalId ||
      parent.bodyState !== v.bodyState
    )
      invalid();
    const common = { candidateId: v.candidateId, chain: v.chain, createdAt: v.createdAt };
    if (v.bodyState === 'purged')
      return { ...common, body: { state: 'purged' as const, ...v.purge } };
    if (parent.bodyState !== 'present') invalid();
    const app = v.candidate,
      p = parent.preparation;
    if (
      app.candidateId !== v.candidateId ||
      !sameInstant(app.createdAt, v.createdAt) ||
      app.chain.evidenceId !== v.chain.evidenceId ||
      app.chain.decisionId !== v.chain.decisionId ||
      app.chain.proposalId !== v.chain.proposalId ||
      app.chain.readonlyCandidateDigest !== parent.originalResult.candidateDigest
    )
      invalid();
    const { applicationDigest, ...unsigned } = app;
    if (impactDependencyDigest(unsigned) !== applicationDigest) invalid();
    if (
      app.raceChange.eventId !== p.context.event.id ||
      app.raceChange.expectedRevision !== p.context.event.revision ||
      app.raceChange.newLocalDate !== p.context.calendarIntent?.newLocalDate ||
      app.expectation.restoreGeneration !== p.context.restoreGeneration ||
      p.context.manualBasis.app.state !== 'present' ||
      app.expectation.appRevision !== p.context.manualBasis.app.revision ||
      !same(app.expectation.manualPolicy, p.context.manualBasis.policy)
    )
      invalid();
    const content = planned(p);
    if (app.applicationState === 'blocked')
      return {
        ...common,
        body: {
          state: 'present' as const,
          storedApplicationState: app.applicationState,
          planned: content,
          blockers: app.blockers,
        },
      };
    const ready = projectRaceManualReadyPlannedSource({ candidate: app, preparation: p });
    if (!sameAffectedMembership(app.affected, content.affected)) invalid();
    if (content.routines.state === 'present') {
      const readyRoutines = ready.routines;
      if (readyRoutines.state !== 'present') invalid();
      for (const member of content.routines.members) {
        const row = readyRoutines.members.find((r) => r.aggregateId === member.aggregateId);
        if (!row) invalid();
        member.after = {
          ...member.after,
          schedule: row.after.schedule,
          expansion: row.after.expansion,
        };
      }
    }
    return {
      ...common,
      body: {
        state: 'present' as const,
        storedApplicationState: app.applicationState,
        planned: raceManualInternalPlannedContentSchema.parse(content),
      },
    };
  });
  return raceManualInternalPersonalExportSchema.parse({
    schemaVersion: 1,
    sourceProvenanceCoverage: 'not_exported_policy_unresolved',
    manualInternalChains: chains,
    manualInternalCandidates: candidates,
    manualInternalApprovalResults: data.approvalResults,
    manualInternalApprovalHistory: data.approvalHistory,
  });
}
