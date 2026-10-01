import { z } from 'zod';
import type { CoreEvidenceBodyV2 } from '@workout/contracts/evidence-snapshots';
import {
  coachingFixtureCandidateContentV1Schema,
  type CoachingFixtureCandidateContentV1,
} from '@workout/contracts/coaching-runs';

const uuid = z.uuid().refine((value) => value === value.toLowerCase());
const boundedText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim() === value && !value.includes('\0'));
const leaseSchema = z.strictObject({
  athleteId: z.string().min(1).max(200),
  eventId: uuid,
  runId: uuid,
  leaseToken: uuid,
  attempts: z.number().int().positive(),
  leaseSeconds: z.number().int().min(1).max(300),
});
export type CoachingJobLease = z.infer<typeof leaseSchema>;

/**
 * Excerpts retrieved for this run. They are untrusted document text: an
 * instruction inside a passage is data, never a command, and the adapter may
 * only cite what it was given here.
 */
export interface CoachingGroundingExcerpt {
  ordinal: number;
  passageId: string;
  resourceId: string;
  versionId: string;
  title: string;
  headingPath: string[];
  text: string;
}
export interface CoachingGrounding {
  query: string;
  excerpts: CoachingGroundingExcerpt[];
}

/** A claim-to-excerpt link. Offsets are into the cited passage, not the answer. */
const citationSchema = z.strictObject({
  claimIndex: z.number().int().min(0).max(49),
  passageId: uuid,
  quoteStart: z.number().int().min(0),
  quoteEnd: z.number().int().positive(),
});

/** Adapter results remain untrusted until the persistence postflight succeeds. */
const adapterOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('analysis'),
    content: z.json(),
    citations: z.array(citationSchema).max(50).default([]),
  }),
  z.strictObject({
    kind: z.literal('needs_question'),
    question: boundedText(2000),
  }),
  z.strictObject({
    kind: z.literal('unable_to_evaluate'),
    code: z.enum([
      'provider_unavailable',
      'provider_rejected',
      'invalid_output',
      'budget_exceeded',
    ]),
    reason: boundedText(500),
  }),
]);
export type CoachingAdapterOutcome = z.infer<typeof adapterOutcomeSchema>;
export interface CoachingEvaluationAdapter {
  evaluate(
    evidence: CoreEvidenceBodyV2,
    grounding: CoachingGrounding | null,
    signal: AbortSignal,
  ): Promise<unknown>;
}
export interface CoachingRunWorkerStore {
  claim(athleteId: string): Promise<CoachingJobLease | null>;
  prepare(
    lease: CoachingJobLease,
  ): Promise<
    | { kind: 'ready'; evidence: CoreEvidenceBodyV2; grounding: CoachingGrounding | null }
    | { kind: 'skipped' }
  >;
  renew(lease: CoachingJobLease): Promise<boolean>;
  finish(lease: CoachingJobLease, outcome: CoachingAdapterOutcome): Promise<'stored' | 'skipped'>;
}

/**
 * One explicitly dispatched tenant/job; no model call runs inside a persistence
 * transaction.
 *
 * Authorization boundary: grounding excerpts are re-authorized inside the
 * `prepare` transaction, which commits before `evaluate` is called. A
 * revocation that happens while the adapter call is in flight therefore cannot
 * recall content that was already handed over — exactly the boundary the shared
 * file streaming path documents. Today the only configured adapter is an
 * in-process deterministic fixture, so nothing leaves the server. Before a
 * provider adapter lands, authorization revocation must also abort its signal;
 * a deadline alone does not recall already disclosed content. The postflight in
 * `finish` — which re-validates every citation against the live gate — must
 * stay the only path that stores anything.
 */
export async function runOneCoachingJob(input: {
  athleteId: string;
  store: CoachingRunWorkerStore;
  adapter: CoachingEvaluationAdapter;
  evaluationTimeoutMs?: number;
}): Promise<'empty' | 'skipped' | 'stored'> {
  const evaluationTimeoutMs = z
    .number()
    .int()
    .min(1)
    .max(600_000)
    .parse(input.evaluationTimeoutMs ?? 30_000);
  const lease = await input.store.claim(input.athleteId);
  const claimed = lease === null ? null : leaseSchema.parse(lease);
  if (!claimed) return 'empty';
  const prepared = await input.store.prepare(claimed);
  if (prepared.kind === 'skipped') return 'skipped';
  const heartbeatIntervalMs = Math.min(30_000, Math.floor((claimed.leaseSeconds * 1000) / 3));
  const renewWithinWindow = async (): Promise<boolean> => {
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve()
          .then(() => input.store.renew(claimed))
          .catch(() => false),
        new Promise<boolean>((resolve) => {
          watchdog = setTimeout(() => resolve(false), heartbeatIntervalMs);
        }),
      ]);
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog);
    }
  };
  // Preparing may consume part of the first lease. Establish fresh ownership
  // before handing evidence to an adapter.
  if (!(await renewWithinWindow())) return 'skipped';
  const controller = new AbortController();
  let resolveLost!: (value: 'lost') => void;
  const lost = new Promise<'lost'>((resolve) => {
    resolveLost = resolve;
  });
  let ownsLease = true;
  let stopped = false;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let inFlightRenewal: Promise<void> | null = null;
  const loseLease = () => {
    if (!ownsLease) return;
    ownsLease = false;
    controller.abort();
    resolveLost('lost');
  };
  const tick = () => {
    if (stopped || !ownsLease) return;
    inFlightRenewal = renewWithinWindow()
      .then((renewed) => {
        if (!renewed) loseLease();
        else if (!stopped) heartbeatTimer = setTimeout(tick, heartbeatIntervalMs);
      })
      .catch(loseLease)
      .finally(() => {
        inFlightRenewal = null;
      });
  };
  heartbeatTimer = setTimeout(tick, heartbeatIntervalMs);
  const stopHeartbeat = async (): Promise<boolean> => {
    stopped = true;
    if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer);
    if (inFlightRenewal) await inFlightRenewal;
    return ownsLease;
  };
  const deadlineOutcome: CoachingAdapterOutcome = {
    kind: 'unable_to_evaluate',
    code: 'budget_exceeded',
    reason: 'Evaluation exceeded its time budget',
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<CoachingAdapterOutcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(deadlineOutcome);
    }, evaluationTimeoutMs);
  });
  // Promise.race observes both settlements, including a rejection after the
  // deadline. An adapter that ignores abort may keep consuming resources.
  const evaluation = Promise.resolve()
    .then(() =>
      controller.signal.aborted
        ? deadlineOutcome
        : input.adapter.evaluate(prepared.evidence, prepared.grounding, controller.signal),
    )
    .then((candidate): CoachingAdapterOutcome => {
      if (controller.signal.aborted) return deadlineOutcome;
      const parsed = adapterOutcomeSchema.safeParse(candidate);
      const serialized = parsed.success ? JSON.stringify(parsed.data) : '';
      return parsed.success && Buffer.byteLength(serialized) <= 1_000_000
        ? parsed.data
        : {
            kind: 'unable_to_evaluate',
            code: 'invalid_output',
            reason: 'Model output could not be used',
          };
    })
    .catch((): CoachingAdapterOutcome => ({
      kind: 'unable_to_evaluate',
      code: 'provider_unavailable',
      reason: 'Evaluation could not be completed',
    }));
  let outcome: CoachingAdapterOutcome | 'lost';
  try {
    outcome = await Promise.race([evaluation, deadline, lost]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (!(await stopHeartbeat()) || outcome === 'lost') return 'skipped';
  // Refresh immediately before postflight; finish still performs the final
  // transactional lease/CAS check and can safely skip if ownership changes.
  if (!(await renewWithinWindow())) {
    controller.abort();
    return 'skipped';
  }
  return input.store.finish(claimed, outcome);
}

/** No user evidence is copied into the fixture output or operational logs. */
export function createDeterministicFixtureAdapter(
  fixtureId: 'synthetic-v1',
): CoachingEvaluationAdapter {
  if (fixtureId !== 'synthetic-v1') throw new Error('UNSUPPORTED_COACHING_FIXTURE');
  return {
    async evaluate(evidence, grounding, _signal) {
      const first = evidence.plan.draft.sessions[0];
      if (!first || first.durationSeconds === null || first.durationRange) {
        return {
          kind: 'needs_question',
          question: 'What exact duration should the first planned session use?',
        };
      }
      // A technical fixture delta, not advice inferred from personal evidence.
      const changedDuration =
        first.durationSeconds <= 604500 ? first.durationSeconds + 300 : first.durationSeconds - 300;
      const content: CoachingFixtureCandidateContentV1 =
        coachingFixtureCandidateContentV1Schema.parse({
          schemaVersion: 1,
          scope: 'running-core-v2-training',
          intent: {
            kind: 'set_session_duration_seconds',
            sessionId: first.id,
            durationSeconds: changedDuration,
          },
          strategy: {
            summary: 'Synthetic duration alternative',
            preservedIntent: 'Preserve the existing session purpose and schedule',
            rationale: 'Deterministic fixture change for testing only',
            unconfirmedInformation: ['Current training context remains unconfirmed'],
            revisitWhen: 'Review before explicitly approving a plan change',
          },
          summary: 'Synthetic fixture duration proposal; not validated or approved.',
        });
      // A deterministic, bounded citation of the first retrieved excerpt. The
      // excerpt text is never copied into the fixture output: only the passage
      // identity and the quoted span are recorded, and the reader resolves the
      // quote through the query-time gate.
      const cited = grounding?.excerpts[0];
      return {
        kind: 'analysis',
        content,
        citations: cited
          ? [
              {
                claimIndex: 0,
                passageId: cited.passageId,
                quoteStart: 0,
                quoteEnd: Math.min(cited.text.length, 200),
              },
            ]
          : [],
      };
    },
  };
}
