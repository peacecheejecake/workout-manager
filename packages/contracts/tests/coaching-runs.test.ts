import { describe, expect, it } from 'vitest';
import {
  canTransitionCoachingRunStatus,
  coachingFixtureCandidateContentV1Schema,
  coachingRunCreateCommandV1Schema,
  coachingRunOutputV1Schema,
  coachingRunStatusSchema,
  coachingRunV1Schema,
  type CoachingRunStatus,
} from '../src/coaching-runs.js';

const runId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const threadId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const evidenceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const decisionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const outputId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const queued = { kind: 'queued' } as const;
const preparing = { kind: 'running', stage: 'preparing_evidence' } as const;
const evaluating = { kind: 'running', stage: 'evaluating' } as const;
const validating = { kind: 'running', stage: 'validating_candidates' } as const;
const question = { kind: 'needs_question', question: '가용 시간이 언제인가요?' } as const;
const analysis = { kind: 'analysis_ready', outputId } as const;
const final = { kind: 'validated_final', decisionId } as const;
const unable = {
  kind: 'unable_to_evaluate',
  code: 'provider_unavailable',
  reason: '잠시 후 다시 시도해 주세요.',
} as const;
const cancelled = { kind: 'cancelled', reason: 'user_requested' } as const;

function run(status: CoachingRunStatus = queued) {
  return {
    schemaVersion: 1,
    id: runId,
    threadId,
    evidenceSnapshotId: evidenceId,
    conversationRevision: 1,
    policy: { id: 'running-core-policy', version: '2026-09-18' },
    source: { kind: 'deterministic_fixture', fixtureId: 'synthetic-v1' },
    createdAt: '2026-09-18T00:00:00Z',
    updatedAt: '2026-09-18T00:00:00Z',
    status,
  };
}

describe('coaching run lifecycle contract', () => {
  it('requires a strict bounded synthetic duration instruction before candidate projection', () => {
    const content = {
      schemaVersion: 1,
      scope: 'running-core-v2-training',
      intent: {
        kind: 'set_session_duration_seconds',
        sessionId: 'session',
        durationSeconds: 3900,
      },
      strategy: {
        summary: 'Synthetic alternative',
        preservedIntent: 'Preserve the original purpose',
        rationale: 'Deterministic fixture only',
        unconfirmedInformation: ['Recovery is unknown'],
        revisitWhen: 'Review before approval',
      },
      summary: 'Synthetic fixture duration proposal; not validated or approved.',
    };
    expect(coachingFixtureCandidateContentV1Schema.parse(content)).toEqual(content);
    for (const invalid of [
      { ...content, schemaVersion: 2 },
      { ...content, scope: 'running-core-v1-training' },
      { ...content, summary: 'Approved plan' },
      { ...content, proposedPlan: {} },
      { ...content, intent: { ...content.intent, durationSeconds: 604801 } },
      { ...content, intent: { ...content.intent, durationSeconds: -1 } },
      { ...content, intent: { ...content.intent, sessionId: ' session ' } },
      { ...content, intent: { ...content.intent, kind: 'delete_session' } },
      { ...content, strategy: { ...content.strategy, authority: 'approve' } },
    ])
      expect(coachingFixtureCandidateContentV1Schema.safeParse(invalid).success).toBe(false);
  });

  it('accepts only the route-scoped create fields and positive conversation revision', () => {
    const command = {
      schemaVersion: 1,
      evidenceSnapshotId: evidenceId,
      expectedConversationRevision: 1,
      idempotencyKey: 'request-1',
    };
    // `retrieval` is optional on the wire and defaults to reading no resource.
    expect(coachingRunCreateCommandV1Schema.parse(command)).toEqual({
      ...command,
      retrieval: { kind: 'none' },
    });
    expect(
      coachingRunCreateCommandV1Schema.parse({
        ...command,
        retrieval: { kind: 'resource-access-v1', query: '회복 주간' },
      }).retrieval,
    ).toEqual({ kind: 'resource-access-v1', query: '회복 주간' });
    for (const invalid of [
      { ...command, retrieval: { kind: 'resource-access-v1' } },
      { ...command, retrieval: { kind: 'resource-access-v1', query: '' } },
      { ...command, retrieval: { kind: 'resource-access-v1', query: 'x'.repeat(501) } },
      { ...command, retrieval: { kind: 'all-resources' } },
      { ...command, expectedConversationRevision: 0 },
      { ...command, expectedConversationRevision: null },
      { ...command, expectedConversationRevision: 1.5 },
      { ...command, schemaVersion: 2 },
      { ...command, evidenceSnapshotId: evidenceId.toUpperCase() },
      { ...command, idempotencyKey: '' },
      { ...command, idempotencyKey: ' key ' },
      { ...command, idempotencyKey: 'x'.repeat(201) },
      { ...command, idempotencyKey: 'bad\0key' },
      { ...command, threadId },
      { ...command, policy: { id: 'client', version: '1' } },
    ])
      expect(coachingRunCreateCommandV1Schema.safeParse(invalid).success).toBe(false);
  });

  it('keeps source provenance distinct without admitting raw provider secrets', () => {
    const fixture = coachingRunV1Schema.parse(run());
    const provider = coachingRunV1Schema.parse({
      ...run(preparing),
      source: { kind: 'provider', providerId: 'approved-provider', modelId: 'model-v1' },
    });
    expect(fixture.source.kind).toBe('deterministic_fixture');
    expect(provider.source.kind).toBe('provider');
    for (const source of [
      { kind: 'provider', providerId: 'p', modelId: 'm', apiKey: 'secret' },
      { kind: 'deterministic_fixture', fixtureId: 'fixture', providerId: 'p' },
      { kind: 'provider', providerId: 'p' },
      { kind: 'unknown', fixtureId: 'fixture' },
    ])
      expect(coachingRunV1Schema.safeParse({ ...run(), source }).success).toBe(false);
  });

  it('requires an immutable decision reference for a validated final', () => {
    expect(coachingRunV1Schema.parse(run(analysis)).status).toEqual(analysis);
    expect(coachingRunV1Schema.parse(run(final)).status).toEqual(final);
    for (const status of [
      { kind: 'validated_final' },
      { kind: 'validated_final', decisionId: null },
      { kind: 'validated_final', decisionId: 'provisional-text' },
      { kind: 'validated_final', decisionId, text: 'Looks good' },
      { kind: 'running', stage: 'evaluating', decisionId },
      { kind: 'analysis_ready', decisionId },
      { kind: 'analysis_ready', outputId, decisionId },
      { kind: 'analysis_ready', outputId: 'provisional text' },
      { kind: 'queued', provisionalText: 'approved' },
    ])
      expect(coachingRunStatusSchema.safeParse(status).success).toBe(false);
  });

  it('marks fixture analysis as untrusted and unvalidated without decision fields', () => {
    const output = {
      schemaVersion: 1,
      runId,
      outputId,
      source: { kind: 'deterministic_fixture', fixtureId: 'synthetic-v1' },
      trust: 'untrusted_fixture',
      validation: 'unvalidated',
      content: { summary: 'Synthetic training analysis awaiting validation.' },
    };
    expect(coachingRunOutputV1Schema.parse(output)).toEqual(output);
    for (const invalid of [
      { ...output, trust: 'reviewed' },
      { ...output, validation: 'validated' },
      { ...output, source: { kind: 'provider', providerId: 'p', modelId: 'm' } },
      { ...output, source: { kind: 'deterministic_fixture', fixtureId: 'other' } },
      { ...output, decisionId },
      { ...output, content: undefined },
    ])
      expect(coachingRunOutputV1Schema.safeParse(invalid).success).toBe(false);
  });

  it('requires bounded explicit question, failure reason and cancellation code', () => {
    expect(coachingRunV1Schema.parse(run(question)).status).toEqual(question);
    expect(coachingRunV1Schema.parse(run(unable)).status).toEqual(unable);
    expect(coachingRunV1Schema.parse(run(cancelled)).status).toEqual(cancelled);
    for (const status of [
      { kind: 'needs_question', question: '' },
      { kind: 'needs_question', question: '   ' },
      { kind: 'needs_question', question: 'x'.repeat(2001) },
      { kind: 'unable_to_evaluate', code: 'provider_unavailable', reason: '' },
      { kind: 'unable_to_evaluate', code: 'provider_unavailable', reason: 'x'.repeat(501) },
      { kind: 'unable_to_evaluate', code: 'unrecognized', reason: 'Retry' },
      { kind: 'cancelled', reason: 'model_says_done' },
      { kind: 'cancelled', reason: null },
    ])
      expect(coachingRunStatusSchema.safeParse(status).success).toBe(false);
  });

  it('rejects unknown metadata and invalid time or revisions', () => {
    for (const invalid of [
      { ...run(), schemaVersion: 2 },
      { ...run(), extra: true },
      { ...run(), conversationRevision: 0 },
      { ...run(), policy: { id: 'policy', version: '1', owner: 'client' } },
      { ...run(), threadId: 'foreign' },
      { ...run(), updatedAt: '2026-09-17T23:59:59Z' },
      { ...run(), createdAt: 'today' },
    ])
      expect(coachingRunV1Schema.safeParse(invalid).success).toBe(false);
  });

  it('separates model output from candidate validation and the validated final', () => {
    for (const [from, to] of [
      [queued, preparing],
      [queued, unable],
      [queued, cancelled],
      [preparing, evaluating],
      [evaluating, analysis],
      [analysis, validating],
      [validating, question],
      [validating, final],
      [analysis, unable],
      [analysis, cancelled],
      [validating, unable],
      [validating, cancelled],
    ] as const)
      expect(canTransitionCoachingRunStatus(from, to)).toBe(true);
    for (const [from, to] of [
      [queued, queued],
      [queued, final],
      [queued, question],
      [queued, analysis],
      [queued, evaluating],
      [queued, validating],
      [preparing, validating],
      [preparing, analysis],
      [evaluating, validating],
      [evaluating, final],
      [analysis, final],
      [analysis, analysis],
      [analysis, question],
      [evaluating, preparing],
      [evaluating, evaluating],
      [validating, preparing],
      [validating, analysis],
    ] as const)
      expect(canTransitionCoachingRunStatus(from, to)).toBe(false);
  });

  it('keeps every terminal state immutable; answering or retrying needs a new run', () => {
    const terminal: CoachingRunStatus[] = [question, final, unable, cancelled];
    const possible: CoachingRunStatus[] = [
      queued,
      preparing,
      evaluating,
      analysis,
      question,
      final,
      unable,
      cancelled,
    ];
    for (const from of terminal)
      for (const to of possible) expect(canTransitionCoachingRunStatus(from, to)).toBe(false);
    expect(canTransitionCoachingRunStatus({ kind: 'running', stage: 'unknown' }, final)).toBe(
      false,
    );
    expect(
      canTransitionCoachingRunStatus(preparing, { kind: 'validated_final', text: 'draft' }),
    ).toBe(false);
  });
});
