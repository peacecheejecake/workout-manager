import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  integratedCandidateV4Schema,
  integratedCandidatePrepareV4Schema,
} from '@workout/contracts/integrated-coaching';
import { coreEvidenceBodyV2Schema } from '@workout/contracts/evidence-snapshots';
import { nutritionPlanVersionV3Schema } from '@workout/contracts/nutrition-race-plan-v3';
import { createIntegratedApprovalV4Repository } from '../src/integrated-approval-v4.js';
import {
  integratedCandidatePayloadDigest,
  integratedV4ContextDependencyKinds,
} from '../src/nutrition-copied-source-inventory.js';
import type { Database, Transaction } from '../src/database.js';
import { captureCoreEvidenceDependencies } from '../src/evidence-dependencies.js';
vi.mock('../src/evidence-dependencies.js', () => ({ captureCoreEvidenceDependencies: vi.fn() }));
const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${n.toString(16).padStart(12, '0')}`;
const athlete = id(1),
  at = '2026-10-07T00:00:00.000Z';
const draft = {
  title: 'Unrelated training unchanged',
  timezone: 'UTC',
  periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
    id: level,
    parentId: index === 0 ? null : (levels[index - 1] ?? null),
    level,
    title: level,
    startDate: '2026-10-07',
    endDateExclusive: '2026-10-08',
    timezone: 'UTC',
    intent: '',
    isPartial: false,
  })),
  sessions: [],
};
const evidence = coreEvidenceBodyV2Schema.parse({
  schemaVersion: 2,
  scope: 'running-core-v2',
  window: { from: '2026-10-07', toExclusive: '2026-10-08', timezone: 'UTC' },
  thread: {
    id: id(2),
    planVersionId: id(3),
    title: 'Thread',
    scope: { kind: 'block', targetId: 'block' },
    revision: 1,
    createdAt: at,
    updatedAt: at,
  },
  plan: { id: id(3), version: 1, createdAt: at, draft },
  messages: [
    {
      id: id(12),
      threadId: id(2),
      revision: 1,
      role: 'user',
      content: 'Synthetic training question',
      createdAt: at,
    },
  ],
  activities: [],
  checkIns: [],
  sessionCompletions: [],
  userConstraints: { headRevision: null, items: [] },
  dependencies: {
    schemaVersion: 2,
    scope: 'core-ledgers-v2',
    athleteId: athlete,
    capturedAt: at,
    trainingPlan: { kind: 'exists', versionId: id(3) },
    activities: { count: '0', revisionSum: '0' },
    checkIns: { kind: 'absent' },
    sessionCompletions: { kind: 'absent' },
    aiConsent: { kind: 'exists', revision: 1, granted: true },
    userConstraints: { kind: 'absent' },
  },
});
function body(nutrition = false) {
  const payload = integratedCandidatePrepareV4Schema.parse({
    proposalId: id(4),
    idempotencyKey: 'prepare-key',
    basis: {
      schemaVersion: 4,
      planHeads: [
        { domain: 'training', aggregateId: id(5), head: { kind: 'exists', versionId: id(3) } },
        ...(nutrition
          ? [
              {
                domain: 'nutrition',
                aggregateId: id(6),
                head: { kind: 'exists', versionId: id(7) },
              },
            ]
          : []),
      ],
      contextDependencies: integratedV4ContextDependencyKinds.map((kind) => ({
        kind,
        id: 'tenant',
        revision: kind === 'ai-consent' ? '1:true' : '0',
      })),
      preferenceRevision: 0,
      constraintRevision: 0,
      conversationRevision: 1,
      policyVersion: 'test',
      evidenceSnapshotId: id(8),
    },
    writes: [{ domain: 'training', aggregateId: id(5), proposed: draft }],
    summary: 'Original training summary',
    validation: { status: 'checked', errors: [], unknowns: [] },
  });
  const candidate = integratedCandidateV4Schema.parse({
    proposalId: payload.proposalId,
    basis: payload.basis,
    writes: payload.writes,
    summary: payload.summary,
    validation: payload.validation,
    id: id(9),
    schemaVersion: 4,
    createdAt: at,
    digest: integratedCandidatePayloadDigest(payload),
  });
  return { candidate, input: payload };
}
function fake(nutrition = false, disconnected = false) {
  const value = body(nutrition),
    queries: { sql: string; values: unknown[] | undefined }[] = [];
  let receipt: Record<string, unknown> | null = null,
    appGranted = true,
    aiGranted = true,
    bindingAllowed = true,
    sourceOversized = false;
  const record = nutritionPlanVersionV3Schema.parse({
    schemaVersion: 3,
    planId: id(6),
    versionId: id(7),
    version: 1,
    previousVersionId: null,
    approvalId: id(10),
    approvedAt: at,
    period: { from: '2026-10-07', toInclusive: '2026-10-07' },
    timezone: 'UTC',
    purpose: 'Owned stored nutrition',
    linkedTrainingPlanVersionId: null,
    items: [
      {
        id: 'Meal',
        planVersionId: id(7),
        category: 'meal',
        title: 'Food',
        anchor: disconnected
          ? { kind: 'disconnected', entity: 'race' }
          : { kind: 'absolute', date: '2026-10-07', localTime: null, timezone: 'UTC' },
        foods: [],
        targets: [],
        instructions: 'Prepare food',
        evidenceIds: [],
        source: 'user_confirmed',
      },
    ],
    raceTimingPins: [],
    itemRaceTimingBindings: [],
  });
  const query: Transaction['query'] = async (sql, values) => {
    queries.push({ sql, values });
    const rows: Record<string, unknown>[] = sql.includes('SELECT request=')
      ? receipt
        ? [receipt]
        : []
      : sql.includes('FROM integrated_candidate_v4 WHERE athlete_id=$1 AND id=$2')
        ? [
            {
              id: value.candidate.id,
              proposal_id: value.candidate.proposalId,
              digest: value.candidate.digest,
              body: value.candidate,
              created_at: at,
            },
          ]
        : sql.includes('WITH requested AS MATERIALIZED')
          ? [
              {
                matched_count: 1,
                largest_bytes: sourceOversized ? 524289 : 1000,
                total_bytes: sourceOversized ? '4194305' : '1000',
                source_rows: sourceOversized
                  ? null
                  : [
                      {
                        athlete_id: athlete,
                        plan_id: id(6),
                        version_id: id(7),
                        record_json: record,
                      },
                    ],
              },
            ]
          : sql.includes("kind='app'")
            ? [{ kind: 'app', granted: appGranted, revision: 1 }]
            : sql.includes("kind='ai'")
              ? [{ revision: 1, granted: aiGranted }]
              : sql.includes('SELECT t.revision,e.body')
                ? [{ revision: 1, body: evidence }]
                : sql.includes('SELECT version_id FROM plan_head')
                  ? [{ version_id: id(3) }]
                  : sql.includes('FROM nutrition_plan_head')
                    ? [{ version_id: id(7) }]
                    : sql.includes('AS revision')
                      ? [{ revision: 0 }]
                      : sql.includes('AS intake,')
                        ? [
                            Object.fromEntries(
                              [
                                'intake',
                                'activity',
                                'execution',
                                'sets',
                                'food',
                                'exercise',
                                'supplementary_routine',
                                'routine_run',
                                'routine_occurrence',
                                'routine_blueprint',
                                'recovery_action',
                                'recovery_method',
                                'check_ins',
                                'completions',
                              ].map((key) => [key, 0]),
                            ),
                          ]
                        : sql.includes('statement_timestamp() AS at')
                          ? [{ at }]
                          : [];
    if (sql.includes('require_evidence_app_binding') && !bindingAllowed)
      throw Object.assign(new Error('APP_BINDING_UNAVAILABLE'), { code: 'P0001' });
    return { rows, rowCount: rows.length };
  };
  const transact = async <T>(owner: string, operation: (tx: Transaction) => Promise<T>) => {
    expect(owner).toBe(athlete);
    return operation({ athleteId: owner, query });
  };
  const database: Database = { tenant: transact, exclusiveTenant: transact, close: async () => {} };
  return {
    repository: createIntegratedApprovalV4Repository(database, { policyVersion: 'test' }),
    value,
    queries,
    setOversized: () => {
      sourceOversized = true;
    },
    setReceipt: (next: Record<string, unknown>) => {
      receipt = next;
    },
    setApp: (next: boolean) => {
      appGranted = next;
    },
    setAI: (next: boolean) => {
      aiGranted = next;
    },
    setBinding: (next: boolean) => {
      bindingAllowed = next;
    },
  };
}
beforeEach(() => {
  vi.mocked(captureCoreEvidenceDependencies).mockResolvedValue(evidence.dependencies);
});
describe('V4 copied-source classifier actual repository seams (mock DB, no ownership proof)', () => {
  it('returns unrelated valid original V4 body byte-for-byte without race/marker queries', async () => {
    const f = fake();
    const bytes = JSON.stringify(f.value.candidate);
    expect(JSON.stringify(await f.repository.read(athlete, f.value.candidate.id))).toBe(bytes);
    expect(f.queries).toHaveLength(1);
  });
  it('reads exact tenant/frozen nutrition tuples rather than a current source head', async () => {
    const f = fake(true);
    expect(await f.repository.read(athlete, f.value.candidate.id)).toEqual(f.value.candidate);
    const read = f.queries.find((q) => q.sql.includes('WITH requested'));
    expect(read?.sql).toContain('WHERE v.athlete_id=$1');
    expect(read?.values).toEqual([athlete, [id(6)], [id(7)], 524288, 4194304]);
    expect(
      f.queries.some((q) => q.sql.includes('race_event') || q.sql.includes('nutrition_plan_head')),
    ).toBe(false);
  });
  it('hides source-disconnected candidate and rejects prepare/approve without SQL writes', async () => {
    const f = fake(true, true);
    expect(await f.repository.read(athlete, f.value.candidate.id)).toBeNull();
    await expect(f.repository.prepareInternal(athlete, f.value.input)).rejects.toMatchObject({
      code: 'STALE_BASIS',
    });
    await expect(
      f.repository.approve(athlete, {
        schemaVersion: 4,
        candidateId: f.value.candidate.id,
        proposalId: f.value.candidate.proposalId,
        proposalDigest: f.value.candidate.digest,
        writeDomains: ['training'],
        expectedBasis: f.value.candidate.basis,
        idempotencyKey: 'approve-key',
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: 'CANDIDATE_UNAVAILABLE' });
    expect(f.queries.some((q) => q.sql.includes('INSERT INTO'))).toBe(false);
  });
  it('returns safe unavailable for source SQL byte preflight failure without materializing body or writing', async () => {
    const f = fake(true);
    f.setOversized();
    expect(await f.repository.read(athlete, f.value.candidate.id)).toBeNull();
    await expect(f.repository.prepareInternal(athlete, f.value.input)).rejects.toMatchObject({
      code: 'STALE_BASIS',
    });
    const preflight = f.queries.find((q) => q.sql.includes('WITH requested'));
    expect(preflight?.sql).toContain(
      'CASE WHEN matched_count=cardinality($2::uuid[]) AND largest_bytes<=$4 AND total_bytes<=$5',
    );
    expect(f.queries.some((q) => q.sql.includes('INSERT INTO'))).toBe(false);
  });
  it('connects successful unrelated prepare to the same digest/manifest while preserving wire payload', async () => {
    const f = fake();
    const result = await f.repository.prepareInternal(athlete, f.value.input);
    expect(result.writes).toEqual(f.value.input.writes);
    expect(result.basis).toEqual(f.value.input.basis);
    expect(result.digest).toBe(integratedCandidatePayloadDigest(result));
    const write = f.queries.find((q) => q.sql.includes('INSERT INTO integrated_candidate_v4'));
    expect(write?.values?.[4]).toBe(JSON.stringify(result));
  });
  it('does not weaken existing evidence binding or AI consent gates for unrelated candidates', async () => {
    const binding = fake();
    binding.setBinding(false);
    await expect(
      binding.repository.prepareInternal(athlete, binding.value.input),
    ).rejects.toMatchObject({ code: 'APP_BINDING_UNAVAILABLE' });
    const ai = fake();
    ai.setAI(false);
    await expect(ai.repository.prepareInternal(athlete, ai.value.input)).rejects.toMatchObject({
      code: 'AI_CONSENT_REQUIRED',
    });
  });
  it('returns original successful approval minimal receipt without reapproving or reading purged copies', async () => {
    const f = fake(true, true);
    const result = {
      schemaVersion: 4,
      approvalId: id(11),
      candidateId: f.value.candidate.id,
      versions: [{ domain: 'nutrition', aggregateId: id(6), versionId: id(7) }],
      occurrenceIds: [],
      approvedAt: at,
    };
    f.setReceipt({ matches: true, result });
    f.setApp(false);
    expect(
      await f.repository.approve(athlete, {
        schemaVersion: 4,
        candidateId: f.value.candidate.id,
        proposalId: f.value.candidate.proposalId,
        proposalDigest: f.value.candidate.digest,
        writeDomains: ['training'],
        expectedBasis: f.value.candidate.basis,
        idempotencyKey: 'approve-key',
        confirmed: true,
      }),
    ).toEqual(result);
    expect(
      f.queries.some(
        (q) =>
          q.sql.includes('INSERT INTO') ||
          q.sql.includes('FROM integrated_candidate_v4') ||
          q.sql.includes("kind='app'"),
      ),
    ).toBe(false);
  });
});
