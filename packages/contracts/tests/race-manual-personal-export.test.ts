import { expect, it } from 'vitest';
import { raceManualPublicPreviewSchema } from '../src/race-manual-public-preview.js';
import { raceManualApprovalResultSchema } from '../src/race-manual-approval.js';
import {
  raceManualPersonalExportDataSchema,
  raceManualPersonalCommandResultSchema,
} from '../src/race-manual-personal-export.js';
const id = (n: number) => `abcdefab-abcd-4abc-8abc-${String(n).padStart(12, '0')}`;
const at = '2026-10-08T00:00:00.123456Z';
function reference() {
  return {
    schemaVersion: 1,
    candidateId: id(1),
    applicationDigest: 'a'.repeat(64),
    chain: {
      evidenceId: id(2),
      decisionId: id(3),
      proposalId: id(4),
      readonlyCandidateDigest: 'b'.repeat(64),
    },
    createdAt: at,
  };
}
function preview() {
  const race = {
    title: 'Race',
    localDate: '2026-10-08',
    localStartTime: null,
    timezone: 'UTC',
    distance: { kind: 'standard', class: '5k' },
    priority: null,
    participation: 'registered',
    targetSeconds: 0,
  };
  return raceManualPublicPreviewSchema.parse({
    schemaVersion: 1,
    status: 'present',
    reference: reference(),
    storedCandidateState: 'ready_for_explicit_approval',
    beforeBasis: 'frozen_review',
    afterBasis: 'hypothetical_on_approval',
    freshness: 'not_checked_on_read',
    scope: 'whole_affected',
    race: {
      eventId: id(5),
      expectedRevision: 1,
      before: race,
      after: { ...race, localDate: '2026-10-09' },
    },
    training: { state: 'absent' },
    nutrition: { state: 'absent' },
    recovery: { state: 'absent' },
    routines: { state: 'absent' },
    retainedUnplanned: [],
    affected: [],
    notices: [],
  });
}
function committed() {
  return raceManualApprovalResultSchema.parse({
    schemaVersion: 1,
    status: 'committed',
    candidateId: id(1),
    approvalId: id(6),
    proposalId: id(4),
    approvedAt: at,
    race: { eventId: id(5), revision: 2 },
    versions: [
      {
        domain: 'training',
        aggregateId: id(7),
        versionId: 'Snapshot-한글-A' + 'x'.repeat(180),
        version: 2,
      },
      {
        domain: 'routine_schedule',
        aggregateId: id(8),
        versionId: 'Schedule-opaque-가' + 'x'.repeat(201),
      },
      { domain: 'nutrition', aggregateId: id(9), versionId: id(10), version: 4 },
      { domain: 'recovery', aggregateId: id(11), versionId: id(12), version: 3 },
    ],
    occurrenceIds: ['occur-한글', 'occur-zero'],
    notices: [
      {
        domain: 'nutrition',
        aggregateId: id(9),
        itemId: 'meal-식-' + 'x'.repeat(201),
        code: 'DISCONNECTED_RETAINED',
      },
      { domain: 'recovery', aggregateId: id(11), itemId: null, code: 'UNCHANGED_UNRESOLVED' },
    ],
  });
}
function data() {
  const result = committed();
  if (result.status !== 'committed') throw Error('Committed fixture required');
  return {
    manualRaceReviews: [
      { reference: reference(), createdAt: at, bodyState: 'purged', preview: null },
    ],
    manualRaceApprovalHistory: result.versions.map((version) => ({
      candidateId: result.candidateId,
      approvalId: result.approvalId,
      domain: version.domain,
      aggregateId: version.aggregateId,
      versionId: version.versionId,
      approvedAt: result.approvedAt,
    })),
    manualRaceCommandResults: [
      {
        operation: 'review',
        candidateId: id(1),
        result: { status: 'reviewed', reference: reference(), bodyState: 'present' },
      },
      { operation: 'approve', candidateId: id(1), result },
    ],
  };
}
it('retains purged current review and original successful receipt, opaque IDs, null and notices order', () => {
  const input = data();
  expect(raceManualPersonalExportDataSchema.parse(input)).toEqual(input);
});
it('preserves strict present public snapshot zero/null and hypothetical-only boundaries', () => {
  const input = {
    manualRaceReviews: [
      { reference: reference(), createdAt: at, bodyState: 'present', preview: preview() },
    ],
    manualRaceApprovalHistory: [],
    manualRaceCommandResults: [],
  };
  const parsed = raceManualPersonalExportDataSchema.parse(input);
  expect(parsed).toEqual(input);
  expect(parsed.manualRaceReviews[0]?.preview).toMatchObject({
    freshness: 'not_checked_on_read',
    race: { before: { targetSeconds: 0, localStartTime: null } },
  });
});
it('requires all collections and rejects profile failure/unknown collections rather than fake emptiness', () => {
  expect(
    raceManualPersonalExportDataSchema.parse({
      manualRaceReviews: [],
      manualRaceApprovalHistory: [],
      manualRaceCommandResults: [],
    }),
  ).toEqual({ manualRaceReviews: [], manualRaceApprovalHistory: [], manualRaceCommandResults: [] });
  for (const input of [{}, { manualRaceReviews: [] }, null, { ...data(), profile: 'unsupported' }])
    expect(raceManualPersonalExportDataSchema.safeParse(input).success).toBe(false);
});
it('rejects unavailable content presented as live, null live body and body/reference substitution', () => {
  for (const review of [
    { reference: reference(), createdAt: at, bodyState: 'present', preview: null },
    { reference: reference(), createdAt: at, bodyState: 'purged', preview: preview() },
    {
      reference: { ...reference(), candidateId: id(99) },
      createdAt: at,
      bodyState: 'present',
      preview: preview(),
    },
    {
      reference: reference(),
      createdAt: at,
      bodyState: 'present',
      preview: {
        schemaVersion: 1,
        status: 'unavailable',
        reference: reference(),
        reason: 'review_body_purged',
        preview: null,
      },
    },
  ])
    expect(
      raceManualPersonalExportDataSchema.safeParse({ ...data(), manualRaceReviews: [review] })
        .success,
    ).toBe(false);
});
it('compares exact microseconds while allowing equivalent timezone spelling', () => {
  const review = {
    reference: reference(),
    createdAt: '2026-10-08T09:00:00.123456+09:00',
    bodyState: 'purged',
    preview: null,
  };
  expect(
    raceManualPersonalExportDataSchema.safeParse({ ...data(), manualRaceReviews: [review] })
      .success,
  ).toBe(true);
  for (const createdAt of ['2026-10-08T00:00:00.123Z', '2026-10-08T00:00:00.1234567Z'])
    expect(
      raceManualPersonalExportDataSchema.safeParse({
        ...data(),
        manualRaceReviews: [{ ...review, createdAt }],
      }).success,
    ).toBe(false);
});
it('rejects history orphans, foreign candidate/approval/time/domain/version and missing committed rows', () => {
  const input = data();
  const first = input.manualRaceApprovalHistory[0];
  if (!first) throw Error('History required');
  for (const change of [
    { candidateId: id(99) },
    { approvalId: id(99) },
    { aggregateId: id(99) },
    { versionId: 'foreign' },
    { approvedAt: '2026-10-08T00:00:00.123Z' },
    { domain: 'routine_schedule' },
  ])
    expect(
      raceManualPersonalExportDataSchema.safeParse({
        ...input,
        manualRaceApprovalHistory: [
          { ...first, ...change },
          ...input.manualRaceApprovalHistory.slice(1),
        ],
      }).success,
    ).toBe(false);
  expect(
    raceManualPersonalExportDataSchema.safeParse({
      ...input,
      manualRaceApprovalHistory: input.manualRaceApprovalHistory.slice(1),
    }).success,
  ).toBe(false);
  expect(
    raceManualPersonalExportDataSchema.safeParse({ ...input, manualRaceCommandResults: [] })
      .success,
  ).toBe(false);
});
it('rejects normalized duplicate candidates, operation/candidate and approval history', () => {
  const input = data();
  const review = input.manualRaceReviews[0];
  const history = input.manualRaceApprovalHistory[0];
  const command = input.manualRaceCommandResults[0];
  if (!review || !history || !command) throw Error('Fixture required');
  for (const change of [
    {
      manualRaceReviews: [
        ...input.manualRaceReviews,
        { ...review, reference: { ...review.reference, candidateId: id(1).toUpperCase() } },
      ],
    },
    {
      manualRaceCommandResults: [
        ...input.manualRaceCommandResults,
        { ...command, candidateId: id(1).toUpperCase() },
      ],
    },
    {
      manualRaceApprovalHistory: [
        ...input.manualRaceApprovalHistory,
        { ...history, approvalId: id(6).toUpperCase() },
      ],
    },
  ])
    expect(raceManualPersonalExportDataSchema.safeParse({ ...input, ...change }).success).toBe(
      false,
    );
});
it('rejects private raw body, keys, source hashes, context and claimed current authority', () => {
  const input = data();
  for (const extra of [
    { request_key: 'secret' },
    { basis_json: {} },
    { context: { owner_xid: '1' } },
    { authority: 'approved' },
    { sql_hash: 'a'.repeat(64) },
  ])
    expect(raceManualPersonalExportDataSchema.safeParse({ ...input, ...extra }).success).toBe(
      false,
    );
  expect(
    raceManualPersonalCommandResultSchema.safeParse({
      operation: 'approve',
      candidateId: id(1),
      result: { ...committed(), request_digest: 'private' },
    }).success,
  ).toBe(false);
});
it('does not invent durable receipts for blocked attempts, or tolerate foreign proposal references', () => {
  expect(
    raceManualPersonalCommandResultSchema.safeParse({
      operation: 'review',
      candidateId: id(1),
      result: { status: 'blocked', stage: 'semantic' },
    }).success,
  ).toBe(false);
  const result = committed();
  expect(
    raceManualPersonalExportDataSchema.safeParse({
      ...data(),
      manualRaceCommandResults: [
        { operation: 'approve', candidateId: id(1), result: { ...result, proposalId: id(99) } },
      ],
    }).success,
  ).toBe(false);
  expect(
    raceManualPersonalExportDataSchema.safeParse({ ...data(), manualRaceReviews: [] }).success,
  ).toBe(false);
});
it('keeps opaque case distinct and enforces UUID-only domains', () => {
  const input = data();
  const history = input.manualRaceApprovalHistory[0];
  if (!history) throw Error('History required');
  expect(
    raceManualPersonalExportDataSchema.safeParse({
      ...input,
      manualRaceApprovalHistory: [
        { ...history, versionId: history.versionId.toLowerCase() },
        ...input.manualRaceApprovalHistory.slice(1),
      ],
    }).success,
  ).toBe(false);
  expect(
    raceManualPersonalExportDataSchema.safeParse({
      ...input,
      manualRaceApprovalHistory: [
        { ...history, domain: 'nutrition' },
        ...input.manualRaceApprovalHistory.slice(1),
      ],
    }).success,
  ).toBe(false);
});
it('rejects oversized/count/deep/sparse/cycle/nonfinite/accessor/proxy/subclass inputs safely', () => {
  let reads = 0;
  const getter = {
    get manualRaceReviews() {
      reads++;
      throw Error('GETTER');
    },
  };
  class UnexpectedArray extends Array<unknown> {}
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  let deep: unknown = null;
  for (let i = 0; i < 66; i++) deep = { deep };
  for (const input of [
    { ...data(), body: 'x'.repeat(8 * 1024 * 1024 + 1) },
    {
      ...data(),
      manualRaceReviews: Array.from({ length: 1001 }, () => data().manualRaceReviews[0]),
    },
    { ...data(), manualRaceReviews: Array(2) },
    { ...data(), manualRaceReviews: new UnexpectedArray() },
    getter,
    cycle,
    deep,
    { ...data(), nonfinite: NaN },
    new Proxy(data(), {
      ownKeys() {
        throw Error('PROXY');
      },
    }),
    new Proxy(data(), {
      get() {
        throw Error('SERIALIZE');
      },
    }),
  ]) {
    expect(() => raceManualPersonalExportDataSchema.safeParse(input)).not.toThrow();
    expect(raceManualPersonalExportDataSchema.safeParse(input).success).toBe(false);
  }
  expect(reads).toBe(0);
});
it('accepts 1000 genuine-shaped contentless review rows without reordering the census', () => {
  const reviews = Array.from({ length: 1000 }, (_, n) => ({
    reference: { ...reference(), candidateId: id(n + 100) },
    createdAt: at,
    bodyState: 'purged',
    preview: null,
  }));
  const input = {
    manualRaceReviews: reviews,
    manualRaceApprovalHistory: [],
    manualRaceCommandResults: [],
  };
  expect(raceManualPersonalExportDataSchema.parse(input)).toEqual(input);
});
it('does not treat absence of an external domain version body as source authentication', () => {
  // This closed wire only checks declared history/result membership. Owned domain
  // records, source lifecycle and current permission require the account producer.
  const input = data();
  expect(raceManualPersonalExportDataSchema.parse(input)).toEqual(input);
  expect(
    raceManualPersonalExportDataSchema.safeParse({ ...input, sourceAuthenticated: true }).success,
  ).toBe(false);
});
