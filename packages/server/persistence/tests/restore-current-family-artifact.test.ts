import { createHash, createHmac } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  createCurrentFamilyArtifactVerifier,
  currentFamilyRowsSha256,
  signCurrentFamilyArtifact,
  type CurrentFamilyConfiguredIdentity,
} from '../src/restore-current-family-artifact.js';
const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const sha = 'a'.repeat(64),
  bytea = `\\x${sha}`,
  athlete = id(1),
  at = '2026-10-08T01:02:03.123456Z';
const key = Buffer.alloc(32, 1),
  otherKey = Buffer.alloc(32, 2);
function rows(): { relation: string; row: Record<string, unknown>; ordinal: number }[] {
  return [
    {
      relation: 'nutrition_race_item_disconnection',
      row: {
        athlete_id: athlete,
        version_id: id(2),
        item_key: `\\x${createHash('sha256').update('식사𐀀').digest('hex')}`,
        item_id: '식사𐀀',
        event_id: id(3),
      },
    },
    {
      relation: 'nutrition_integrated_candidate_disconnection',
      row: {
        athlete_id: athlete,
        candidate_id: id(4),
        event_id: id(3),
        row_digest_version: 'postgres-row-jsonb-utc-v1',
        row_digest: sha,
        payload_digest_version: 'integrated-candidate-v4-canonical-v1',
        payload_digest: sha,
      },
    },
    {
      relation: 'race_result_proof_ref',
      row: {
        athlete_id: athlete,
        result_id: id(5),
        result_revision: 1,
        ordinal: 0,
        source_kind: 'gallery-image',
        source_id: id(6),
        version_id: null,
        access_revision: null,
      },
    },
    {
      relation: 'nutrition_race_disconnection_lineage',
      row: {
        athlete_id: athlete,
        plan_id: id(7),
        version_id: id(8),
        version: 2,
        prior_version_id: id(2),
        prior_version: 1,
        item_key: `\\x${createHash('sha256').update('식사𐀀').digest('hex')}`,
        item_id: '식사𐀀',
        origin_version_id: id(2),
        origin_event_id: id(3),
        disposition: 'retained',
        prior_row_digest_version: 'postgres-row-jsonb-utc-v1',
        prior_row_digest: sha,
      },
    },
    {
      relation: 'nutrition_v4_commit_seal',
      row: {
        athlete_id: athlete,
        version_id: id(8),
        plan_id: id(7),
        prior_version_id: id(2),
        caller_role: 'historical_역할',
        owner_xid: '9223372036854775807',
        app_revision: 1,
        receipt_key: 'old-receipt',
        request_digest: sha,
        saved_digest: sha,
        expires_at: '2001-01-01T00:00:00.000001Z',
      },
    },
    {
      relation: 'plan_snapshot_aggregate',
      row: { athlete_id: athlete, version_id: id(9), aggregate_id: id(10) },
    },
    {
      relation: 'manual_race_evidence_v2',
      row: {
        athlete_id: athlete,
        id: id(11),
        decision_id: id(12),
        proposal_id: id(13),
        created_at: at,
        receipt_key: 'receipt',
        candidate_digest: sha,
        original_payload_sql_digest: sha,
        payload: null,
        purged_at: at,
        purged_event_id: id(3),
      },
    },
    {
      relation: 'manual_race_decision_v2',
      row: { athlete_id: athlete, id: id(12), evidence_id: id(11) },
    },
    {
      relation: 'manual_race_proposal_v2',
      row: {
        athlete_id: athlete,
        id: id(13),
        evidence_id: id(11),
        decision_id: id(12),
        applicable: false,
      },
    },
    {
      relation: 'manual_race_chain_source_ref_v2',
      row: {
        athlete_id: athlete,
        evidence_id: id(11),
        ordinal: 1,
        identity: { kind: 'race-event', sourceId: id(14), revision: 1 },
        identity_key: bytea,
        dto_digest: sha,
        copied_locations: ['context.event'],
        sql_relations: [],
      },
    },
    {
      relation: 'manual_race_chain_lifecycle_edge_v2',
      row: {
        athlete_id: athlete,
        evidence_id: id(11),
        ordinal: 1,
        edge_key: bytea,
        edge: {
          family: 'race-event',
          sourceId: id(14),
          versionKey: null,
          membershipKey: null,
          role: 'source',
        },
      },
    },
    {
      relation: 'manual_race_chain_suppression_v2',
      row: {
        athlete_id: athlete,
        evidence_id: id(11),
        event_id: id(3),
        occurred_at: at,
        original_payload_sql_digest: sha,
      },
    },
    {
      relation: 'manual_race_chain_receipt_v2',
      row: {
        athlete_id: athlete,
        receipt_key: 'receipt',
        request_digest: bytea,
        result: {
          schemaVersion: 2,
          evidenceId: id(11),
          decisionId: id(12),
          proposalId: id(13),
          candidateDigest: sha,
          createdAt: at,
          applicable: false,
          approvalAllowed: false,
        },
        evidence_id: id(11),
      },
    },
    {
      relation: 'manual_race_chain_commit_v2',
      row: {
        athlete_id: athlete,
        evidence_id: id(11),
        caller_role: 'original_app_role',
        owner_xid: '9007199254740993',
        payload_hash: bytea,
      },
    },
  ].map((entry, i) => ({ ...entry, ordinal: i + 1 }));
}
function body() {
  const r = rows();
  return {
    artifactVersion: 1,
    profile: {
      profileVersion: 1,
      normalSchemaVersion: 107,
      explicitVersions: [108, 109, 110, 111, 112, 113, 114, 115, 116],
      rowEncoding: 'utc-microseconds-decimal-bigint-hex-bytea-v1',
      relationProfileSha256: sha,
    },
    source: {
      systemIdentifier: '18446744073709551615',
      databaseOid: 4294967295,
      captureId: id(15),
      generationId: id(16),
      registrySha256: sha,
      catalogSha256: sha,
      baselineThroughLsn: '0/1A',
    },
    identity: {
      artifactId: id(17),
      athleteId: athlete,
      sourceKeyId: 'independent-capture',
      sourceKeyVersion: 1,
    },
    count: r.length,
    rowsSha256: currentFamilyRowsSha256(r),
    relationCounts: {
      nutrition_race_item_disconnection: 1,
      nutrition_integrated_candidate_disconnection: 1,
      race_result_proof_ref: 1,
      nutrition_race_disconnection_lineage: 1,
      nutrition_v4_commit_seal: 1,
      plan_snapshot_aggregate: 1,
      manual_race_evidence_v2: 1,
      manual_race_decision_v2: 1,
      manual_race_proposal_v2: 1,
      manual_race_chain_source_ref_v2: 1,
      manual_race_chain_lifecycle_edge_v2: 1,
      manual_race_chain_suppression_v2: 1,
      manual_race_chain_receipt_v2: 1,
      manual_race_chain_commit_v2: 1,
      manual_race_v2_live_transition: 0,
    },
    rows: r,
    parentCoverage: 'not_authenticated',
    originalTailCoverage: 'not_authenticated',
  };
}
function expected(b: ReturnType<typeof body>): CurrentFamilyConfiguredIdentity {
  const { artifactVersion, rows, parentCoverage, originalTailCoverage, ...rest } = b;
  void artifactVersion;
  void rows;
  void parentCoverage;
  void originalTailCoverage;
  // Public identity uses runtime validation in the factory; this test builds its
  // expected value from an independent explicit fixture, without type assertions.
  return {
    ...rest,
    source: { ...rest.source },
    identity: { ...rest.identity },
    relationCounts: { ...rest.relationCounts, manual_race_v2_live_transition: 0 },
    profile: {
      profileVersion: 1,
      normalSchemaVersion: 107,
      explicitVersions: [108, 109, 110, 111, 112, 113, 114, 115, 116],
      rowEncoding: 'utc-microseconds-decimal-bigint-hex-bytea-v1',
      relationProfileSha256: sha,
    },
  };
}
function verifier(b = body()) {
  return createCurrentFamilyArtifactVerifier({
    expected: expected(b),
    resolveSourceKey: () => key,
  });
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object')
    return `{${Object.entries(v)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
      .join(',')}}`;
  const s = JSON.stringify(v);
  if (s === undefined) throw Error('fixture');
  return s;
}
/** Deliberately sign malformed bytes, so rejection is independent of producer validation. */
function malicious(b: unknown) {
  const hmacSha256 = createHmac('sha256', key)
    .update('wm-current-child-family-authentication-v1\0')
    .update(canonical(b))
    .digest('hex');
  return Buffer.from(canonical({ body: b, hmacSha256 }));
}
function changedRow(n: number, change: Record<string, unknown>) {
  const b = body();
  b.rows = b.rows.map((r, i) => (i === n ? { ...r, row: { ...r.row, ...change } } : r));
  return b;
}
it('authenticates all14 typed child rows while parents, original events, SQL hashes and admission remain blocked', () => {
  const b = body(),
    v = verifier(b),
    h = v.prepareVerifiedCurrentFamilyArtifact(signCurrentFamilyArtifact(b, key));
  expect(h).toEqual({
    kind: 'verified_current_family_child_bytes',
    parentClosure: 'blocked',
    originalTailStage: 'unavailable',
    authority: 'none',
    admissionAllowed: false,
  });
  v.withVerifiedCurrentFamilyArtifact(h, (copy, limits) => {
    expect(copy).toEqual(b);
    expect(copy.rows[4]?.row).toMatchObject({
      owner_xid: '9223372036854775807',
      expires_at: '2001-01-01T00:00:00.000001Z',
    });
    expect(copy.rows[13]?.row).toMatchObject({ owner_xid: '9007199254740993' });
    expect(limits).toMatchObject({
      reason: 'authenticated_parent_family_unavailable',
      sqlRowEncoding: 'not_verified',
      historicalSeals: 'audit_only',
      authority: 'none',
    });
  });
});
it('foreign factory and structurally identical object spread cannot forge the process-private handle', () => {
  const b = body(),
    a = verifier(b),
    other = verifier(b),
    h = a.prepareVerifiedCurrentFamilyArtifact(signCurrentFamilyArtifact(b, key));
  expect(() => other.withVerifiedCurrentFamilyArtifact(h, () => true)).toThrow(
    'INVALID_CURRENT_FAMILY_ARTIFACT',
  );
  expect(() => a.withVerifiedCurrentFamilyArtifact({ ...h }, () => true)).toThrow(
    'INVALID_CURRENT_FAMILY_ARTIFACT',
  );
});
it('callback mutation cannot alter signed factory evidence', () => {
  const b = body(),
    v = verifier(b),
    h = v.prepareVerifiedCurrentFamilyArtifact(signCurrentFamilyArtifact(b, key));
  v.withVerifiedCurrentFamilyArtifact(h, (copy) => {
    copy.rows.pop();
  });
  expect(v.withVerifiedCurrentFamilyArtifact(h, (copy) => copy.rows.length)).toBe(14);
});
it.each(['source', 'generation', 'tenant', 'key', 'key-version', 'profile'])(
  'signed but wrong independently configured %s is rejected',
  (which) => {
    const b = body(),
      e = expected(b);
    if (which === 'source') e.source.databaseOid = 42;
    if (which === 'generation') e.source.generationId = id(90);
    if (which === 'tenant') e.identity.athleteId = id(91);
    if (which === 'key-version') e.identity.sourceKeyVersion = 2;
    if (which === 'profile') e.profile.relationProfileSha256 = 'b'.repeat(64);
    const v = createCurrentFamilyArtifactVerifier({
      expected: e,
      resolveSourceKey: () => (which === 'key' ? otherKey : key),
    });
    expect(() => v.prepareVerifiedCurrentFamilyArtifact(signCurrentFamilyArtifact(b, key))).toThrow(
      'INVALID_CURRENT_FAMILY_ARTIFACT',
    );
  },
);
it.each(Array.from({ length: 14 }, (_, i) => i))(
  'rejects duplicate PK in relation index %i even with matching new count/checksum',
  (n) => {
    const b = body(),
      entry = b.rows[n];
    if (!entry) throw Error('fixture');
    b.rows.push({ ...entry, ordinal: 15 });
    b.count = 15;
    const counts = Object.fromEntries(
      Object.entries(b.relationCounts).map(([k, c]) => [k, k === entry.relation ? c + 1 : c]),
    );
    const mutated = { ...b, relationCounts: counts, rowsSha256: currentFamilyRowsSha256(b.rows) };
    expect(() => verifier().prepareVerifiedCurrentFamilyArtifact(malicious(mutated))).toThrow(
      'INVALID_CURRENT_FAMILY_ARTIFACT',
    );
  },
);
it.each([
  changedRow(0, { athlete_id: id(99) }),
  changedRow(4, { expires_at: '2001-01-01T00:00:00.000Z' }),
  changedRow(6, { purged_at: undefined }),
  changedRow(6, { purged_at: null }),
  changedRow(4, { owner_xid: 9007199254740992 }),
  changedRow(4, { owner_xid: '9223372036854775808' }),
  changedRow(4, { caller_role: '한'.repeat(22) }),
  changedRow(0, { item_key: '\\x00' }),
  changedRow(2, { version_id: id(88) }),
  changedRow(8, { applicable: true }),
  changedRow(9, {
    identity: { kind: 'race-event', sourceId: id(14), revision: 1, permission: true },
  }),
  changedRow(12, { result: { schemaVersion: 2, approved: true } }),
])('rejects malformed exact physical row %#', (b) => {
  expect(() => verifier().prepareVerifiedCurrentFamilyArtifact(malicious(b))).toThrow(
    'INVALID_CURRENT_FAMILY_ARTIFACT',
  );
});
it('rejects nonempty live-transition inventory instead of restoring historical caller context', () => {
  const b = body(),
    r = {
      ordinal: 15,
      relation: 'manual_race_v2_live_transition',
      row: {
        athlete_id: athlete,
        event_id: id(3),
        identity: { kind: 'race-event', sourceId: id(14), revision: 1 },
        occurred_at: at,
        owner_xid: '1',
        caller_role: 'owner',
        version_scope: 'all_versions',
      },
    };
  expect(() =>
    verifier().prepareVerifiedCurrentFamilyArtifact(
      malicious({
        ...b,
        count: 15,
        rows: [...b.rows, r],
        relationCounts: { ...b.relationCounts, manual_race_v2_live_transition: 1 },
      }),
    ),
  ).toThrow();
});
it.each(['complete', 'authenticated', true])(
  'rejects selfclaimed parent completeness %j',
  (claim) => {
    const b = body();
    expect(() =>
      verifier().prepareVerifiedCurrentFamilyArtifact(malicious({ ...b, parentCoverage: claim })),
    ).toThrow();
  },
);
it('does not manufacture missing parent facts from a valid signed isolated mapping row', () => {
  const b = body(),
    row = b.rows[5];
  if (!row) throw Error('fixture');
  const single = {
    ...b,
    count: 1,
    rows: [{ ...row, ordinal: 1 }],
    rowsSha256: currentFamilyRowsSha256([{ ...row, ordinal: 1 }]),
    relationCounts: {
      ...b.relationCounts,
      ...Object.fromEntries(
        Object.keys(b.relationCounts).map((k) => [k, k === 'plan_snapshot_aggregate' ? 1 : 0]),
      ),
    },
  };
  const v = createCurrentFamilyArtifactVerifier({
    expected: expected(single),
    resolveSourceKey: () => key,
  });
  const h = v.prepareVerifiedCurrentFamilyArtifact(signCurrentFamilyArtifact(single, key));
  expect(v.withVerifiedCurrentFamilyArtifact(h, (_, limits) => limits.parentClosure)).toBe(
    'blocked',
  );
});
it('rejects wrong census/checksum/order, extra columns, noncanonical/duplicate-key bytes and tampered HMAC', () => {
  const b = body(),
    v = verifier(b);
  for (const raw of [
    { ...b, count: 13 },
    { ...b, rowsSha256: 'b'.repeat(64) },
    { ...b, relationCounts: { ...b.relationCounts, plan_snapshot_aggregate: 0 } },
    changedRow(5, { new_column: 1 }),
    { ...b, rows: [...b.rows].reverse() },
  ])
    expect(() => v.prepareVerifiedCurrentFamilyArtifact(malicious(raw))).toThrow();
  const signed = Buffer.from(signCurrentFamilyArtifact(b, key));
  expect(() =>
    v.prepareVerifiedCurrentFamilyArtifact(Buffer.from(' ' + signed.toString())),
  ).toThrow();
  expect(() =>
    v.prepareVerifiedCurrentFamilyArtifact(
      Buffer.from(
        signed.toString().replace('"artifactVersion":1', '"artifactVersion":1,"artifactVersion":1'),
      ),
    ),
  ).toThrow();
  expect(() =>
    v.prepareVerifiedCurrentFamilyArtifact(signCurrentFamilyArtifact(b, otherKey)),
  ).toThrow();
});
it('plain boundary never executes getters, rejects cycles/nonfinite/depth/oversize rows before signing', () => {
  let executed = false;
  const raw = {
    get rows() {
      executed = true;
      return [];
    },
  };
  expect(() => signCurrentFamilyArtifact(raw, key)).toThrow();
  expect(executed).toBe(false);
  const cycle: Record<string, unknown> = {};
  cycle['cycle'] = cycle;
  expect(() => signCurrentFamilyArtifact(cycle, key)).toThrow();
  expect(() => signCurrentFamilyArtifact(changedRow(4, { owner_xid: NaN }), key)).toThrow();
  let deep: unknown = null;
  for (let i = 0; i < 66; i++) deep = [deep];
  expect(() => signCurrentFamilyArtifact(deep, key)).toThrow();
  expect(() =>
    signCurrentFamilyArtifact(changedRow(0, { item_id: 'x'.repeat(4194305) }), key),
  ).toThrow();
});

it('a valid signature from another protocol domain cannot authenticate current child bytes', () => {
  const b = body();
  const hmacSha256 = createHmac('sha256', key)
    .update('wm-owner-restore-app-family-v1\0')
    .update(canonical(b))
    .digest('hex');
  expect(() =>
    verifier().prepareVerifiedCurrentFamilyArtifact(
      Buffer.from(canonical({ body: b, hmacSha256 })),
    ),
  ).toThrow('INVALID_CURRENT_FAMILY_ARTIFACT');
});
it('unsupported authenticated tail claim and oversized encoded artifacts are refused', () => {
  const b = body();
  expect(() =>
    verifier().prepareVerifiedCurrentFamilyArtifact(
      malicious({ ...b, originalTailCoverage: 'authenticated' }),
    ),
  ).toThrow();
  expect(() =>
    verifier().prepareVerifiedCurrentFamilyArtifact(Buffer.alloc(16 * 1024 * 1024 + 257)),
  ).toThrow();
});

it('minimal child receipt/decision correspondence cannot be replaced while original audit remains signed', () => {
  for (const b of [
    changedRow(7, { id: id(99) }),
    changedRow(8, { decision_id: id(99) }),
    changedRow(11, { original_payload_sql_digest: 'b'.repeat(64) }),
    changedRow(13, { payload_hash: `\\x${'b'.repeat(64)}` }),
  ]) {
    b.rowsSha256 = currentFamilyRowsSha256(b.rows);
    const v = createCurrentFamilyArtifactVerifier({
      expected: expected(b),
      resolveSourceKey: () => key,
    });
    expect(() => v.prepareVerifiedCurrentFamilyArtifact(malicious(b))).toThrow(
      'INVALID_CURRENT_FAMILY_ARTIFACT',
    );
  }
});

it('configuration replacement cannot repin an existing factory to attacker identity or key', () => {
  const original = body(),
    attacker = body();
  attacker.source.generationId = id(99);
  attacker.identity.sourceKeyId = 'attacker-key';
  let calls = 0;
  const config = {
    expected: expected(original),
    resolveSourceKey: () => {
      calls++;
      return key;
    },
  };
  const v = createCurrentFamilyArtifactVerifier(config);
  config.expected = expected(attacker);
  config.resolveSourceKey = () => otherKey;
  expect(() =>
    v.prepareVerifiedCurrentFamilyArtifact(signCurrentFamilyArtifact(attacker, otherKey)),
  ).toThrow('INVALID_CURRENT_FAMILY_ARTIFACT');
  expect(() =>
    v.prepareVerifiedCurrentFamilyArtifact(signCurrentFamilyArtifact(original, otherKey)),
  ).toThrow('INVALID_CURRENT_FAMILY_ARTIFACT');
  const h = v.prepareVerifiedCurrentFamilyArtifact(signCurrentFamilyArtifact(original, key));
  expect(v.withVerifiedCurrentFamilyArtifact(h, (copy) => copy.source.generationId)).toBe(
    original.source.generationId,
  );
  expect(calls).toBe(2);
});
it('the pinned original resolver remains able to revoke its configured version per preparation', () => {
  const b = body();
  let revoked = false;
  const v = createCurrentFamilyArtifactVerifier({
    expected: expected(b),
    resolveSourceKey: (id, version) => {
      expect(id).toBe('independent-capture');
      expect(version).toBe(1);
      if (revoked) throw Error('SOURCE_KEY_REVOKED');
      return key;
    },
  });
  const signed = signCurrentFamilyArtifact(b, key);
  expect(v.prepareVerifiedCurrentFamilyArtifact(signed).kind).toBe(
    'verified_current_family_child_bytes',
  );
  revoked = true;
  expect(() => v.prepareVerifiedCurrentFamilyArtifact(signed)).toThrow(
    'INVALID_CURRENT_FAMILY_ARTIFACT',
  );
});
