import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database, Transaction } from '../src/database.js';
import type * as SemanticModule from '../src/race-manual-review-semantic-basis-v2.js';
import type * as ChainModule from '../src/race-manual-review-chain-v2.js';
import type * as PreviewModule from '../src/race-plan-impact-preview.js';
import type * as ImpactModule from '../src/race-manual-public-impact.js';
import type * as ApprovalModule from '../src/race-manual-approval.js';
const ports = vi.hoisted(() => ({
  preview: vi.fn(),
  impact: vi.fn(),
  semantic: vi.fn(),
  chain: vi.fn(),
  prepare: vi.fn(),
  approve: vi.fn(),
}));
vi.mock('../src/race-manual-review-semantic-basis-v2.js', async (importOriginal) => ({
  ...(await importOriginal<typeof SemanticModule>()),
  prepareRaceManualSemanticBasisV2In: ports.semantic,
}));
vi.mock('../src/race-manual-review-chain-v2.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ChainModule>()),
  storeRaceManualReviewChainV2In: ports.chain,
}));
vi.mock('../src/race-manual-approval.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ApprovalModule>()),
  prepareRaceManualApprovalIn: ports.prepare,
  approveRaceManualApplicationIn: ports.approve,
}));
vi.mock('../src/race-plan-impact-preview.js', async (importOriginal) => ({
  ...(await importOriginal<typeof PreviewModule>()),
  previewRacePlanImpactTransaction: ports.preview,
}));
vi.mock('../src/race-manual-public-impact.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ImpactModule>()),
  projectRaceManualPublicImpact: ports.impact,
}));
import { RacePlanImpactPreviewError } from '../src/race-plan-impact-preview.js';
import { RaceManualPublicImpactError } from '../src/race-manual-public-impact.js';
import { createRaceManualPublicRepository } from '../src/race-manual-public.js';
const hash = 'a'.repeat(64);
function reference() {
  return {
    schemaVersion: 1 as const,
    candidateId: randomUUID(),
    applicationDigest: hash,
    chain: {
      evidenceId: randomUUID(),
      decisionId: randomUUID(),
      proposalId: randomUUID(),
      readonlyCandidateDigest: hash,
    },
    createdAt: '2026-10-08T00:00:00Z',
  };
}
function command() {
  return {
    schemaVersion: 1 as const,
    idempotencyKey: randomUUID(),
    intent: {
      expectedEvent: { id: randomUUID(), revision: 1 },
      newLocalDate: '2026-10-09',
      selection: { kind: 'keep_plan' as const },
    },
  };
}
function response(value: unknown) {
  return {
    rows: [{ bytes: String(Buffer.byteLength(JSON.stringify(value))), value }],
    rowCount: 1,
  };
}
function adapter(query: Transaction['query']) {
  let commits = 0,
    rollbacks = 0;
  const tenant: Database['tenant'] = async (athleteId, operation) => {
    try {
      const result = await operation({ athleteId, query });
      commits++;
      return result;
    } catch (error) {
      rollbacks++;
      throw error;
    }
  };
  return {
    db: {
      tenant,
      exclusiveTenant: tenant,
      snapshotTenant: tenant,
      close: async () => undefined,
    } satisfies Database,
    counts: () => ({ commits, rollbacks }),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
});
describe('public manual service boundary plumbing (mocked sources are not ownership evidence)', () => {
  it.each(['expectedBasis', 'recipes', 'privateContext', 'athleteId'])(
    'rejects caller %s before transaction/SQL',
    async (field) => {
      const query = vi.fn<Transaction['query']>(),
        a = adapter(query);
      await expect(
        createRaceManualPublicRepository(a.db).review('synthetic', {
          ...command(),
          [field]: { allowed: true },
        }),
      ).rejects.toThrow();
      expect(query).not.toHaveBeenCalled();
      expect(a.counts()).toEqual({ commits: 0, rollbacks: 0 });
    },
  );
  it('rejects full approval expectations before SQL', () => {
    const query = vi.fn<Transaction['query']>(),
      a = adapter(query);
    expect(() =>
      createRaceManualPublicRepository(a.db).approve('synthetic', {
        schemaVersion: 1,
        idempotencyKey: randomUUID(),
        candidateId: randomUUID(),
        applicationDigest: hash,
        confirmed: true,
        expectation: { permitted: true },
      }),
    ).toThrow();
    expect(query).not.toHaveBeenCalled();
  });
  it('rejects accessors without invoking them', async () => {
    const query = vi.fn<Transaction['query']>(),
      a = adapter(query),
      getter = vi.fn();
    const input = { ...command() };
    Object.defineProperty(input, 'intent', { enumerable: true, get: getter });
    await expect(
      createRaceManualPublicRepository(a.db).review('synthetic', input),
    ).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
  it('has no RC fallback for processing', async () => {
    const query = vi.fn<Transaction['query']>(),
      a = adapter(query);
    const db: Database = {
      tenant: a.db.tenant,
      exclusiveTenant: a.db.exclusiveTenant,
      close: a.db.close,
    };
    await expect(
      createRaceManualPublicRepository(db).review('synthetic', command()),
    ).rejects.toThrow('PUBLIC_PORT_UNAVAILABLE');
    expect(query).not.toHaveBeenCalled();
  });
  it('replays minimal review reference before fresh processing, including purged body', async () => {
    const ref = reference(),
      query = vi
        .fn<Transaction['query']>()
        .mockResolvedValueOnce(response(ref))
        .mockResolvedValueOnce(
          response({
            reference: ref,
            bodyState: 'purged',
            candidate: null,
            basis: null,
            lifecycle: null,
          }),
        ),
      a = adapter(query);
    expect(await createRaceManualPublicRepository(a.db).review('synthetic', command())).toEqual({
      status: 'reviewed',
      reference: ref,
      bodyState: 'purged',
    });
    expect(ports.semantic).not.toHaveBeenCalled();
    expect(query.mock.calls[0]?.[0]).toContain('read_race_manual_public_receipt_v1');
  });
  it('uses one actual transaction and one budget through capture, chain, application and receipt', async () => {
    const ref = reference(),
      query = vi
        .fn<Transaction['query']>()
        .mockResolvedValueOnce(response(null))
        .mockResolvedValueOnce(response({ installed: false, executable: false }))
        .mockResolvedValueOnce(response(hash))
        .mockResolvedValueOnce(response(ref)),
      a = adapter(query);
    ports.semantic.mockResolvedValue({
      status: 'current_dependencies_captured',
      basis: { observed: 'unit-only' },
    });
    ports.chain.mockResolvedValue({
      status: 'stored',
      result: { ...ref.chain, candidateDigest: hash },
    });
    ports.prepare.mockResolvedValue({
      status: 'prepared',
      candidate: { candidateId: ref.candidateId, applicationDigest: ref.applicationDigest },
    });
    const result = await createRaceManualPublicRepository(a.db).review('synthetic', command());
    expect(result.status).toBe('reviewed');
    const [tx, , expected, budget] = ports.semantic.mock.calls[0] ?? [];
    expect(expected).toBeNull();
    expect(ports.chain.mock.calls[0]?.[0]).toBe(tx);
    expect(ports.prepare.mock.calls[0]?.[0]).toBe(tx);
    expect(ports.chain.mock.calls[0]?.[2]).toBe(budget);
    expect(ports.prepare.mock.calls[0]?.[2]).toBe(budget);
    expect(ports.chain.mock.calls[0]?.[1].idempotencyKey).toBe(`race_public_review_v1_${hash}`);
    expect(a.counts()).toEqual({ commits: 1, rollbacks: 0 });
  });
  it.each(['semantic', 'chain', 'application'] as const)(
    'rolls back %s blocked preparation before returning contentless diagnostics',
    async (stage) => {
      const query = vi
          .fn<Transaction['query']>()
          .mockResolvedValueOnce(response(null))
          .mockResolvedValueOnce(response({ installed: false, executable: false }))
          .mockResolvedValueOnce(response(hash)),
        a = adapter(query),
        ref = reference();
      ports.semantic.mockResolvedValue(
        stage === 'semantic'
          ? { status: 'blocked' }
          : { status: 'current_dependencies_captured', basis: { observed: 'unit-only' } },
      );
      ports.chain.mockResolvedValue(
        stage === 'chain'
          ? { status: 'blocked' }
          : { status: 'stored', result: { ...ref.chain, candidateDigest: hash } },
      );
      ports.prepare.mockResolvedValue({ status: 'blocked', reason: 'affected_timing_unresolved' });
      expect(await createRaceManualPublicRepository(a.db).review('synthetic', command())).toEqual({
        status: 'blocked',
        stage,
      });
      expect(a.counts()).toEqual({ commits: 0, rollbacks: 1 });
      expect(
        query.mock.calls.some(([sql]) => sql.includes('finish_race_manual_public_review')),
      ).toBe(false);
    },
  );
  it('replays successful public approval without loading purged candidate or rechecking app', async () => {
    const ref = reference(),
      committed = {
        schemaVersion: 1,
        status: 'committed',
        candidateId: ref.candidateId,
        approvalId: randomUUID(),
        proposalId: ref.chain.proposalId,
        approvedAt: '2026-10-08T00:00:00Z',
        race: { eventId: randomUUID(), revision: 2 },
        versions: [],
        occurrenceIds: [],
        notices: [],
      },
      query = vi
        .fn<Transaction['query']>()
        .mockResolvedValueOnce(response(committed))
        .mockResolvedValueOnce(response(committed)),
      a = adapter(query);
    expect(
      await createRaceManualPublicRepository(a.db).approve('synthetic', {
        schemaVersion: 1,
        idempotencyKey: randomUUID(),
        candidateId: ref.candidateId,
        applicationDigest: ref.applicationDigest,
        confirmed: true,
      }),
    ).toEqual(committed);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[0]).toContain('finish_race_manual_public_approval_v1');
    expect(ports.approve).not.toHaveBeenCalled();
  });
  it('rejects a mismatching SQL reference identity', async () => {
    const ref = reference(),
      query = vi.fn<Transaction['query']>().mockResolvedValueOnce(
        response({
          reference: ref,
          bodyState: 'purged',
          candidate: null,
          basis: null,
          lifecycle: null,
        }),
      ),
      a = adapter(query);
    await expect(
      createRaceManualPublicRepository(a.db).read('synthetic', randomUUID()),
    ).rejects.toThrow('PUBLIC_INVALID_RESPONSE');
  });
  it('enforces response bytes before parsing body', async () => {
    const query = vi
        .fn<Transaction['query']>()
        .mockResolvedValue({ rows: [{ bytes: '4194305', value: null }], rowCount: 1 }),
      a = adapter(query);
    await expect(
      createRaceManualPublicRepository(a.db).review('synthetic', command()),
    ).rejects.toThrow('PUBLIC_RESPONSE_LIMIT');
    expect(ports.semantic).not.toHaveBeenCalled();
  });
  it('propagates actual SQL errors without fallback or masking', async () => {
    const error = Object.assign(new Error('synthetic database'), { code: '42501' }),
      query = vi.fn<Transaction['query']>().mockRejectedValue(error),
      a = adapter(query);
    await expect(
      createRaceManualPublicRepository(a.db).review('synthetic', command()),
    ).rejects.toBe(error);
    expect(ports.semantic).not.toHaveBeenCalled();
  });
});

describe('retained public preview plumbing', () => {
  it('returns only the minimal purged reference using the selected read port', async () => {
    const ref = reference(),
      query = vi
        .fn<Transaction['query']>()
        .mockResolvedValue(
          response({ reference: ref, bodyState: 'purged', candidate: null, preparation: null }),
        );
    const a = adapter(query);
    expect(
      await createRaceManualPublicRepository(a.db).readPreview('synthetic', ref.candidateId),
    ).toEqual({
      schemaVersion: 1,
      status: 'unavailable',
      reference: ref,
      reason: 'review_body_purged',
      preview: null,
    });
    expect(query.mock.calls[0]?.[0]).toContain('read_race_manual_public_preview_source_v1');
    expect(ports.semantic).not.toHaveBeenCalled();
  });
  it('returns null for an unavailable candidate without projecting another source', async () => {
    const a = adapter(vi.fn<Transaction['query']>().mockResolvedValue(response(null)));
    expect(
      await createRaceManualPublicRepository(a.db).readPreview('synthetic', randomUUID()),
    ).toBeNull();
    expect(ports.semantic).not.toHaveBeenCalled();
  });
  it('rejects a mismatched minimal reference even when the review body is purged', async () => {
    const ref = reference(),
      a = adapter(
        vi
          .fn<Transaction['query']>()
          .mockResolvedValue(
            response({ reference: ref, bodyState: 'purged', candidate: null, preparation: null }),
          ),
      );
    await expect(
      createRaceManualPublicRepository(a.db).readPreview('synthetic', randomUUID()),
    ).rejects.toThrow('PUBLIC_INVALID_RESPONSE');
  });
  it('rejects oversized selected bodies before projecting them', async () => {
    const a = adapter(
      vi
        .fn<Transaction['query']>()
        .mockResolvedValue({ rows: [{ bytes: '4194305', value: null }], rowCount: 1 }),
    );
    await expect(
      createRaceManualPublicRepository(a.db).readPreview('synthetic', randomUUID()),
    ).rejects.toThrow('PUBLIC_RESPONSE_LIMIT');
  });
  it('requires the snapshot port instead of silently substituting a mutable read', async () => {
    const a = adapter(vi.fn<Transaction['query']>()),
      { snapshotTenant, ...db } = a.db;
    expect(snapshotTenant).toBeDefined();
    await expect(
      createRaceManualPublicRepository(db).readPreview('synthetic', randomUUID()),
    ).rejects.toThrow('PUBLIC_PORT_UNAVAILABLE');
  });
});

const blockedImpact = {
  schemaVersion: 1,
  status: 'blocked',
  reason: 'source_unavailable',
  domains: [],
  approvalAllowed: false,
  persistence: 'not_stored',
  freshness: 'not_checked',
};
function impactCommand() {
  return {
    schemaVersion: 1,
    intent: { ...command().intent, resolutions: { nutrition: [], routines: [] } },
  };
}
describe('transient impact processing boundary (mock ports, not source authority)', () => {
  it.each(['idempotencyKey', 'candidateId', 'expectedBasis', 'approvalAllowed'])(
    'rejects caller %s before capture',
    async (field) => {
      const query = vi.fn<Transaction['query']>(),
        a = adapter(query);
      await expect(
        createRaceManualPublicRepository(a.db).impact('synthetic', {
          ...impactCommand(),
          [field]: 'caller',
        }),
      ).rejects.toThrow();
      expect(a.counts()).toEqual({ commits: 0, rollbacks: 0 });
      expect(ports.preview).not.toHaveBeenCalled();
    },
  );
  it('requires a snapshot port without an RC fallback', async () => {
    const a = adapter(vi.fn<Transaction['query']>());
    await expect(
      createRaceManualPublicRepository({
        tenant: a.db.tenant,
        exclusiveTenant: a.db.exclusiveTenant,
        close: a.db.close,
      }).impact('synthetic', impactCommand()),
    ).rejects.toThrow('PUBLIC_PORT_UNAVAILABLE');
    expect(ports.preview).not.toHaveBeenCalled();
  });
  it('uses one snapshot budget and recomputes from its context without receipt or writes', async () => {
    const query = vi.fn<Transaction['query']>(),
      a = adapter(query),
      input = impactCommand();
    const context = { athleteId: 'synthetic' };
    ports.preview.mockResolvedValue({ context, projection: { status: 'projected' } });
    ports.impact.mockReturnValue(blockedImpact);
    expect(await createRaceManualPublicRepository(a.db).impact('synthetic', input)).toEqual(
      blockedImpact,
    );
    expect(ports.preview).toHaveBeenCalledWith(
      expect.objectContaining({ athleteId: 'synthetic' }),
      input.intent,
      expect.objectContaining({ sources: 0 }),
    );
    expect(ports.impact).toHaveBeenCalledWith({ context, intent: input.intent });
    expect(query).not.toHaveBeenCalled();
    for (const write of [ports.semantic, ports.chain, ports.prepare, ports.approve])
      expect(write).not.toHaveBeenCalled();
    expect(a.counts()).toEqual({ commits: 1, rollbacks: 0 });
  });
  it('keeps incomplete first capture contentless without fabricating a calendar intent', async () => {
    const a = adapter(vi.fn<Transaction['query']>());
    ports.preview.mockResolvedValue({
      context: { athleteId: 'synthetic', privateBody: 'secret' },
      projection: { status: 'blocked', reason: 'missing_facts' },
    });
    expect(
      await createRaceManualPublicRepository(a.db).impact('synthetic', impactCommand()),
    ).toEqual(blockedImpact);
    expect(ports.impact).not.toHaveBeenCalled();
  });
  it('rejects foreign captured scope before projection', async () => {
    const a = adapter(vi.fn<Transaction['query']>());
    ports.preview.mockResolvedValue({
      context: { athleteId: 'foreign' },
      projection: { status: 'projected' },
    });
    await expect(
      createRaceManualPublicRepository(a.db).impact('synthetic', impactCommand()),
    ).rejects.toThrow('PUBLIC_INVALID_RESPONSE');
    expect(ports.impact).not.toHaveBeenCalled();
    expect(a.counts()).toEqual({ commits: 0, rollbacks: 1 });
  });
  it.each(['APP_CONSENT_REQUIRED', 'REVISION_CONFLICT'] as const)(
    'preserves finite %s capture error',
    async (code) => {
      const a = adapter(vi.fn<Transaction['query']>());
      ports.preview.mockRejectedValue(new RacePlanImpactPreviewError(code));
      await expect(
        createRaceManualPublicRepository(a.db).impact('synthetic', impactCommand()),
      ).rejects.toMatchObject({ code });
      expect(ports.impact).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['PUBLIC_IMPACT_INVALID_CONTEXT', 'PUBLIC_INVALID_RESPONSE'],
    ['PUBLIC_IMPACT_LIMIT', 'PUBLIC_RESPONSE_LIMIT'],
  ] as const)('sanitizes mapper %s', async (code, expected) => {
    const a = adapter(vi.fn<Transaction['query']>());
    ports.preview.mockResolvedValue({
      context: { athleteId: 'synthetic' },
      projection: { status: 'projected' },
    });
    ports.impact.mockImplementation(() => {
      throw new RaceManualPublicImpactError(code);
    });
    await expect(
      createRaceManualPublicRepository(a.db).impact('synthetic', impactCommand()),
    ).rejects.toThrow(expected);
  });
});

it('impact reserves its response against the same source budget without truncation', async () => {
  const a = adapter(vi.fn<Transaction['query']>());
  ports.preview.mockImplementation(async (_tx, _intent, budget) => {
    budget.bytes = 4194303n;
    return {
      context: { athleteId: 'synthetic' },
      projection: { status: 'blocked', reason: 'missing_facts' },
    };
  });
  await expect(
    createRaceManualPublicRepository(a.db).impact('synthetic', impactCommand()),
  ).rejects.toThrow('PUBLIC_RESPONSE_LIMIT');
  expect(a.counts()).toEqual({ commits: 0, rollbacks: 1 });
});
