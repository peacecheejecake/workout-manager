import { describe, expect, it, vi } from 'vitest';
import {
  createFullRestoreDurableRowParserV1,
  FullRestoreDurableRowError,
  validateFullRestoreTemplateRowClosureV1,
} from '../src/full-restore-durable-row-codecs-v1.js';
const limits = { maxRowBytes: 8388608 };
const parse = createFullRestoreDurableRowParserV1(limits).parse;
const id = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const stamp = '2026-10-09T00:00:00.123456Z';
const bytes = `\\x${'ab'.repeat(32)}`;
const owner = 'synthetic-食';
function version(n = 1) {
  return {
    athlete_id: owner,
    template_id: id(1),
    version_id: id(n + 1),
    version: n,
    previous_version_id: n === 1 ? null : id(n),
    previous_version: n === 1 ? null : n - 1,
    created_at: stamp,
    record_json: {
      templateId: id(1),
      versionId: id(n + 1),
      version: n,
      previousVersionId: n === 1 ? null : id(n),
      previousVersion: n === 1 ? null : n - 1,
      createdAt: '2026-10-09T09:00:00.123456+09:00',
      content: {
        definitionVersion: 'checkin-v1',
        source: 'user',
        method: 'self_report',
        title: '합성',
        instructions: null,
        fields: ['note'],
      },
    },
  };
}
function presentCandidate() {
  return {
    ...purged(),
    purged_event_id: null,
    purged_at: null,
    candidate_json: {
      schemaVersion: 1,
      candidateId: id(10),
      applicationDigest: 'a'.repeat(64),
      createdAt: '2026-10-09T09:00:00.123456+09:00',
      chain: {
        evidenceId: id(11),
        decisionId: id(12),
        proposalId: id(13),
        readonlyCandidateDigest: 'b'.repeat(64),
      },
      raceChange: { eventId: id(16), expectedRevision: 1, newLocalDate: '2026-10-08' },
      expectation: {
        appRevision: 1,
        manualPolicy: { id: 'manual-race-date-impact', version: 1, digest: 'a'.repeat(64) },
        restoreGeneration: 'b0000000-0000-4000-8000-000000000001',
        semanticDigest: 'c'.repeat(64),
        heads: {
          training: { state: 'absent' },
          nutrition: { state: 'absent' },
          recovery: { state: 'absent' },
          routine_schedule: { state: 'absent' },
        },
      },
      authority: 'server_revalidation_required',
      applicationState: 'blocked',
      blockers: [{ reason: 'source_unavailable', target: null }],
    },
    basis_json: basis(),
    lifecycle_json: {
      inventoryVersion: 2,
      retainedState: 'present',
      retainedReason: 'inventory_incomplete',
      coverage: null,
      status: 'blocked',
      athleteId: owner,
      facts: [],
      originalEventAuthentication: 'unverified_original_event',
      sourceAuthentication: 'unverified',
      authority: 'none',
      freshness: 'not_checked',
      storage: 'not_persisted',
      admissionAllowed: false,
      approvalAllowed: false,
      appWithdrawal: 'retained_read_allowed',
      catalogWithdrawal: 'not_source_deletion',
      correction: 'not_source_deletion',
    },
  };
}
const head = (n = 1) => ({
  athlete_id: owner,
  template_id: id(1),
  version_id: id(n + 1),
  version: n,
});
const receipt = (n = 1) => ({
  athlete_id: owner,
  idempotency_key: `receipt_${n}`,
  request_digest: bytes,
  template_id: id(1),
  version_id: id(n + 1),
});
function purged() {
  return {
    athlete_id: owner,
    id: id(10),
    evidence_id: id(11),
    decision_id: id(12),
    proposal_id: id(13),
    application_digest: 'a'.repeat(64),
    candidate_json: null,
    basis_json: null,
    lifecycle_json: null,
    created_at: stamp,
    purged_event_id: id(14),
    purged_at: stamp,
  };
}
function committed() {
  return {
    schemaVersion: 1,
    status: 'committed',
    candidateId: id(10),
    approvalId: id(15),
    proposalId: id(13),
    approvedAt: '2026-10-09T09:00:00.123456+09:00',
    race: { eventId: id(16), revision: 1 },
    versions: [],
    occurrenceIds: [],
    notices: [],
  };
}
function privateReceipt() {
  return {
    athlete_id: owner,
    receipt_key: 'receipt_1',
    request_digest: bytes,
    candidate_id: id(10),
    identity_digest: bytes,
    result: committed(),
  };
}
const history = () => ({
  athlete_id: owner,
  approval_id: id(15),
  candidate_id: id(10),
  domain: 'training',
  aggregate_id: id(17),
  version_id: id(18),
  approved_at: stamp,
});
const publicReceipt = () => ({
  athlete_id: owner,
  operation: 'review',
  receipt_key: 'receipt_1',
  request_digest: bytes,
  candidate_id: id(10),
  result: {
    schemaVersion: 1,
    candidateId: id(10),
    applicationDigest: 'a'.repeat(64),
    chain: {
      evidenceId: id(11),
      decisionId: id(12),
      proposalId: id(13),
      readonlyCandidateDigest: 'b'.repeat(64),
    },
    createdAt: '2026-10-09T09:00:00.123456+09:00',
  },
});
function basis() {
  return {
    basisVersion: 2,
    athleteId: owner,
    restoreGeneration: 'b0000000-0000-4000-8000-000000000001',
    intent: {
      expectedEvent: { id: id(16), revision: 1 },
      newLocalDate: '2026-10-08',
      selection: { kind: 'keep_plan' },
    },
    manualBasis: {
      purpose: 'manual_race_date_change',
      app: { state: 'present', granted: true, revision: 1 },
      policy: { id: 'manual-race-date-impact', version: 1, digest: 'a'.repeat(64) },
    },
    event: {
      id: id(16),
      revision: 1,
      title: 'Synthetic',
      localDate: '2026-10-06',
      localStartTime: null,
      timezone: 'Asia/Seoul',
      locationName: null,
      distance: { kind: 'standard', class: '10k' },
      priority: null,
      participation: 'registered',
      officialUrl: null,
      course: null,
      targetSeconds: 0,
      planVersionId: null,
    },
    collectorSelection: { kind: 'keep_plan' },
    heads: {
      nutrition: { state: 'absent' },
      recovery: { state: 'absent' },
      routine: { state: 'absent' },
    },
    currentTraining: null,
    core: {
      schemaVersion: 2,
      scope: 'core-ledgers-v2',
      athleteId: owner,
      trainingPlan: { kind: 'absent' },
      checkIns: { kind: 'absent' },
      sessionCompletions: { kind: 'absent' },
      userConstraints: { kind: 'absent' },
    },
    activities: [],
    eventCollection: null,
    dependencyHeads: [
      'intake_revision',
      'activity_revision',
      'execution_revision',
      'set_revision',
      'routine_run_revision',
      'routine_occurrence_revision',
      'recovery_action_revision',
    ].map((kind) => ({ kind, state: 'absent' })),
    copiedSources: [],
    consumedUses: {
      purposeProjectionVersion: 2,
      purpose: 'manual_race_date_change',
      facts: [],
      authority: 'none',
      permissionAuthority: 'none',
      storage: 'not_persisted',
      freshness: 'not_checked',
      admissionAllowed: false,
      approvalAllowed: false,
    },
  };
}

const examples = [
  { relation: 'check_in_template_version', row: version() },
  { relation: 'check_in_template_head', row: head() },
  { relation: 'check_in_template_receipt', row: receipt() },
  { relation: 'race_manual_application_candidate_v1', row: purged() },
  { relation: 'race_manual_application_receipt_v1', row: privateReceipt() },
  { relation: 'race_manual_application_history_v1', row: history() },
  { relation: 'race_manual_public_receipt_v1', row: publicReceipt() },
];
describe('complete inventory durable physical row precursor', () => {
  it.each(examples)('parses exact $relation columns without issuing authority', (example) => {
    const result = parse(example);
    expect(result.facts).toEqual(example);
    expect(result).toMatchObject({
      authority: 'none',
      admissionAllowed: false,
      closure: 'not_checked',
    });
    expect(Object.isFrozen(result.facts.row)).toBe(true);
  });
  it.each(examples)('rejects extra or omitted columns for $relation', (example) => {
    expect(() => parse({ ...example, row: { ...example.row, extra: true } })).toThrow(
      FullRestoreDurableRowError,
    );
    const { athlete_id: _owner, ...row } = example.row;
    expect(() => parse({ ...example, row })).toThrow(FullRestoreDurableRowError);
  });
  it('rejects an unknown relation, target-local context and forged transport limits', () => {
    expect(() => parse({ relation: 'race_manual_application_context_v1', row: {} })).toThrow();
    expect(() =>
      createFullRestoreDurableRowParserV1({ maxRowBytes: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow();
    expect(() =>
      createFullRestoreDurableRowParserV1({ maxRowBytes: 8388608, approved: true }),
    ).toThrow();
  });
  it('rejects getters before executing them, including nested retained JSON', () => {
    const get = vi.fn(() => 'secret');
    const row = version();
    Object.defineProperty(row.record_json.content, 'title', { enumerable: true, get });
    expect(() => parse({ relation: 'check_in_template_version', row })).toThrow();
    expect(get).not.toHaveBeenCalled();
  });
  it('rejects cycles and mutable non-JSON input', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => parse({ relation: 'check_in_template_version', row: cyclic })).toThrow();
    expect(() => parse({ relation: 'check_in_template_version', row: new Date() })).toThrow();
  });
  it('preserves original offset spelling in a privately owned frozen copy', () => {
    const row = version();
    const result = parse({ relation: 'check_in_template_version', row });
    row.record_json.content.title = 'changed';
    expect(result.facts.row).toMatchObject({
      record_json: { createdAt: '2026-10-09T09:00:00.123456+09:00', content: { title: '합성' } },
    });
    if (result.facts.relation !== 'check_in_template_version') throw Error('wrong fixture');
    expect(Object.isFrozen(result.facts.row.record_json)).toBe(true);
  });
  it('distinguishes one PostgreSQL microsecond and rejects fabricated previous null/zero', () => {
    const row = version();
    row.record_json.createdAt = '2026-10-09T09:00:00.123457+09:00';
    expect(() => parse({ relation: 'check_in_template_version', row })).toThrow();
    expect(() =>
      parse({ relation: 'check_in_template_version', row: { ...version(), previous_version: 0 } }),
    ).toThrow();
    expect(() =>
      parse({
        relation: 'check_in_template_head',
        row: { ...head(), version: Number.MAX_SAFE_INTEGER + 1 },
      }),
    ).toThrow();
  });
  it('rejects body UUID spelling that public transforms accept but SQL123 directly rejects', () => {
    const row = version();
    row.record_json.templateId = row.record_json.templateId.toUpperCase();
    expect(() => parse({ relation: 'check_in_template_version', row })).toThrow();
  });
  it('requires UTC six fractional physical instants and exact bytea32', () => {
    expect(() =>
      parse({
        relation: 'check_in_template_version',
        row: { ...version(), created_at: stamp.replace('123456', '123') },
      }),
    ).toThrow();
    for (const value of ['ab'.repeat(32), `\\x${'ab'.repeat(31)}`, `\\x${'AB'.repeat(32)}`])
      expect(() =>
        parse({
          relation: 'check_in_template_receipt',
          row: { ...receipt(), request_digest: value },
        }),
      ).toThrow();
  });
  it('rejects partial purge and a present body with malformed basis/lifecycle', () => {
    expect(() =>
      parse({
        relation: 'race_manual_application_candidate_v1',
        row: { ...purged(), purged_at: null },
      }),
    ).toThrow();
    expect(() =>
      parse({
        relation: 'race_manual_application_candidate_v1',
        row: {
          ...purged(),
          candidate_json: {},
          basis_json: {},
          lifecycle_json: {},
          purged_event_id: null,
          purged_at: null,
        },
      }),
    ).toThrow();
  });
  it.each([
    ['2026-10-09T00:00:00.1234567Z', '2026-10-09T00:00:00.123457Z'],
    ['2026-10-09T00:00:00.1234565Z', '2026-10-09T00:00:00.123456Z'],
    ['2026-10-09T00:00:00.1234575Z', '2026-10-09T00:00:00.123458Z'],
    ['2026-10-09T23:59:59.9999999Z', '2026-10-10T00:00:00.000000Z'],
    ['2026-12-31T23:59:59.9999995Z', '2027-01-01T00:00:00.000000Z'],
    ['2024-02-29T23:59:59.9999999Z', '2024-03-01T00:00:00.000000Z'],
    ['2026-10-09T09:00:00.1234565+09:00', '2026-10-09T00:00:00.123456Z'],
    ['2026-10-08T23:59:59.9999999-00:01', '2026-10-09T00:01:00.000000Z'],
    ['1969-12-31T23:59:59.9999995Z', '1970-01-01T00:00:00.000000Z'],
    ['1969-12-31T23:59:59.0000005Z', '1969-12-31T23:59:59.000000Z'],
    ['1969-12-31T23:59:59.0000015Z', '1969-12-31T23:59:59.000002Z'],
    ['2026-10-09T00:00:00.12345650000000001Z', '2026-10-09T00:00:00.123457Z'],
  ])(
    'matches PostgreSQL fractional correspondence %s without changing the original DTO',
    (original, physical) => {
      const row = presentCandidate();
      row.candidate_json.createdAt = original;
      row.created_at = physical;
      const result = parse({ relation: 'race_manual_application_candidate_v1', row });
      expect(result.facts.row).toEqual(row);
      expect(() =>
        parse({
          relation: 'race_manual_application_candidate_v1',
          row: {
            ...row,
            created_at: physical.replace(/(\d)Z$/, (digit) => `${digit[0] === '9' ? '8' : '9'}Z`),
          },
        }),
      ).toThrow();
    },
  );
  it('validates present candidate, basis and lifecycle while preserving original nested spelling', () => {
    const row = presentCandidate();
    const result = parse({ relation: 'race_manual_application_candidate_v1', row });
    expect(result.facts.row).toEqual(row);
    expect(() =>
      parse({
        relation: 'race_manual_application_candidate_v1',
        row: { ...row, created_at: stamp.replace('123456', '123457') },
      }),
    ).toThrow();
    expect(() =>
      parse({
        relation: 'race_manual_application_candidate_v1',
        row: { ...row, evidence_id: id(99) },
      }),
    ).toThrow();
  });
  it('preserves original committed DTO and rejects blocked or cross-candidate receipts', () => {
    const example = { relation: 'race_manual_application_receipt_v1', row: privateReceipt() };
    expect(parse(example).facts.row).toMatchObject({
      result: { approvedAt: committed().approvedAt },
    });
    expect(() => parse({ ...example, row: { ...example.row, candidate_id: id(99) } })).toThrow();
    expect(() =>
      parse({
        ...example,
        row: {
          ...example.row,
          result: {
            schemaVersion: 1,
            status: 'blocked',
            candidateId: id(10),
            blockers: [{ reason: 'source_unavailable', target: null }],
          },
        },
      }),
    ).toThrow();
  });
  it('preserves SQL-legal private receipt keys independently of public command key policy', () => {
    for (const receipt_key of ['', '.', '영수증:+ /', 'x'.repeat(200)]) {
      const row = { ...privateReceipt(), receipt_key };
      expect(parse({ relation: 'race_manual_application_receipt_v1', row }).facts.row).toEqual(row);
    }
    expect(() =>
      parse({
        relation: 'race_manual_public_receipt_v1',
        row: { ...publicReceipt(), receipt_key: '.' },
      }),
    ).toThrow();
  });
  it('preserves original high-precision private result spelling without claiming history correspondence', () => {
    const row = privateReceipt();
    row.result.approvedAt = '2026-10-09T00:00:00.1234567Z';
    expect(parse({ relation: 'race_manual_application_receipt_v1', row }).facts.row).toEqual(row);
  });
  it('validates public approve result and rejects a review wrapper instead of original reference', () => {
    expect(
      parse({
        relation: 'race_manual_public_receipt_v1',
        row: { ...publicReceipt(), operation: 'approve', result: committed() },
      }).authority,
    ).toBe('none');
    expect(() =>
      parse({
        relation: 'race_manual_public_receipt_v1',
        row: {
          ...publicReceipt(),
          result: { status: 'present', reference: publicReceipt().result },
        },
      }),
    ).toThrow();
  });
  it('enforces the caller transport cap separately from SQL JSONB constraints', () => {
    const bounded = createFullRestoreDurableRowParserV1({ maxRowBytes: 64 });
    expect(() => bounded.parse(examples[1])).toThrow();
  });
  it('rejects race rows at the exact template-only closure boundary', () => {
    expect(() =>
      validateFullRestoreTemplateRowClosureV1(
        [{ relation: 'race_manual_application_receipt_v1', row: privateReceipt() }],
        limits,
      ),
    ).toThrow();
  });
  it('checks full immutable template chain/head/receipt links with retained historical receipts', () => {
    const rows: { relation: string; row: unknown }[] = [1, 2].flatMap((n) => [
      { relation: 'check_in_template_version', row: version(n) },
      { relation: 'check_in_template_receipt', row: receipt(n) },
    ]);
    rows.push({ relation: 'check_in_template_head', row: head(2) });
    expect(validateFullRestoreTemplateRowClosureV1(rows, limits)).toMatchObject({
      authority: 'none',
      commandDigests: 'not_checked',
    });
    expect(() => validateFullRestoreTemplateRowClosureV1(rows.slice(2), limits)).toThrow();
    expect(() =>
      validateFullRestoreTemplateRowClosureV1(
        rows.filter((r) => r.relation !== 'check_in_template_receipt'),
        limits,
      ),
    ).toThrow();
    expect(() => validateFullRestoreTemplateRowClosureV1([...rows, rows[0]], limits)).toThrow();
    expect(() =>
      validateFullRestoreTemplateRowClosureV1(
        [
          ...rows,
          { relation: 'check_in_template_receipt', row: { ...receipt(3), athlete_id: 'foreign' } },
        ],
        limits,
      ),
    ).toThrow();
  });
});
