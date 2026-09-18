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
});
export type CoachingJobLease = z.infer<typeof leaseSchema>;

/** Adapter results remain untrusted until the persistence postflight succeeds. */
const adapterOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('analysis'), content: z.json() }),
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
  evaluate(evidence: CoreEvidenceBodyV2): Promise<unknown>;
}
export interface CoachingRunWorkerStore {
  claim(athleteId: string): Promise<CoachingJobLease | null>;
  prepare(
    lease: CoachingJobLease,
  ): Promise<{ kind: 'ready'; evidence: CoreEvidenceBodyV2 } | { kind: 'skipped' }>;
  finish(lease: CoachingJobLease, outcome: CoachingAdapterOutcome): Promise<'stored' | 'skipped'>;
}

/** One explicitly dispatched tenant/job; no model call runs inside a persistence transaction. */
export async function runOneCoachingJob(input: {
  athleteId: string;
  store: CoachingRunWorkerStore;
  adapter: CoachingEvaluationAdapter;
}): Promise<'empty' | 'skipped' | 'stored'> {
  const lease = await input.store.claim(input.athleteId);
  const claimed = lease === null ? null : leaseSchema.parse(lease);
  if (!claimed) return 'empty';
  const prepared = await input.store.prepare(claimed);
  if (prepared.kind === 'skipped') return 'skipped';
  let outcome: CoachingAdapterOutcome;
  try {
    const candidate = await input.adapter.evaluate(prepared.evidence);
    const parsed = adapterOutcomeSchema.safeParse(candidate);
    const serialized = parsed.success ? JSON.stringify(parsed.data) : '';
    outcome =
      parsed.success && Buffer.byteLength(serialized) <= 1_000_000
        ? parsed.data
        : {
            kind: 'unable_to_evaluate',
            code: 'invalid_output',
            reason: 'Model output could not be used',
          };
  } catch {
    outcome = {
      kind: 'unable_to_evaluate',
      code: 'provider_unavailable',
      reason: 'Evaluation could not be completed',
    };
  }
  return input.store.finish(claimed, outcome);
}

/** No user evidence is copied into the fixture output or operational logs. */
export function createDeterministicFixtureAdapter(
  fixtureId: 'synthetic-v1',
): CoachingEvaluationAdapter {
  if (fixtureId !== 'synthetic-v1') throw new Error('UNSUPPORTED_COACHING_FIXTURE');
  return {
    async evaluate(evidence) {
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
      return {
        kind: 'analysis',
        content,
      };
    },
  };
}
