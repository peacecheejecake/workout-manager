import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalFullFamilyJson,
  createFullFamilyArtifactVerifierV1,
  FullFamilyArtifactError,
  fullFamilyBaselineSha256,
  fullFamilyHeadSha256,
  fullFamilySegmentSha256,
  isVerifiedFullFamilyArtifactV1,
  signFullFamilyArtifactV1,
  type FullFamilyArtifactConfigurationV1,
} from '../src/full-restore-family-artifact-v1.js';
import {
  evaluateFullRestorePostconditionsV1,
  fullRestoreObjectManifestSha256V1,
} from '../src/full-restore-admission-postconditions-v1.js';

// Synthetic fixture only: four relations, not the production 239 registry.
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('fixture');
  return value;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const EMPTY = digest('[]');
const KEY = new Uint8Array(32).fill(7);
const OTHER_KEY = new Uint8Array(32).fill(9);
const NONCE = '11111111-1111-4111-8111-111111111111';
const INCARNATION = '22222222-2222-4222-8222-222222222222';
const identity = () => ({
  profileId: 'synthetic_profile',
  normalRegistrySha256: digest('normal'),
  namedProfileSha256: digest('named'),
  catalogSha256: digest('catalog'),
});
const relation = (schema: string, name: string) => ({
  schema,
  relation: name,
  physicalCodec: 'postgres-row-jsonb-utc-v1',
  columnsSha256: digest(`${schema}.${name}`),
  orderingKey: ['id'],
});
const names: [string, string][] = [
  ['identity_private', 'session'],
  ['public', 'alpha'],
  ['public', 'openai_budget_journal'],
  ['public', 'openai_budget_reservation'],
];
function registry() {
  return {
    schemaVersion: 1,
    identity: identity(),
    maxTotalRows: 100,
    maxTotalBytes: 100000,
    targetLocalRelations: [
      'restore_generation',
      'restore_processing_admission',
      'restore_processing_close_receipt',
    ].map((r) => ({ schema: 'public', relation: r })),
    relations: names.map(([s, r]) => ({ ...relation(s, r), maxRows: 10, maxBytes: 10000 })),
  };
}
function inventory() {
  return {
    schemaVersion: 1,
    identity: identity(),
    relations: names.map(([s, r]) =>
      s === 'identity_private'
        ? {
            ...relation(s, r),
            state: 'explicit_empty',
            rowCount: 0,
            byteLength: 2,
            rowsSha256: EMPTY,
          }
        : {
            ...relation(s, r),
            state: 'present',
            rowCount: 2,
            byteLength: 40,
            rowsSha256: digest(`rows:${r}`),
          },
    ),
  };
}
const configuration = (): FullFamilyArtifactConfigurationV1 => ({
  keyId: 'source-key-1',
  authenticationResetRelations: [{ schema: 'identity_private', relation: 'session' }],
  budgetRelations: [
    { schema: 'public', relation: 'openai_budget_journal' },
    { schema: 'public', relation: 'openai_budget_reservation' },
  ],
  sequences: [
    {
      schema: 'public',
      relation: 'openai_budget_journal_sequence_id_seq',
      owner: { schema: 'public', relation: 'openai_budget_journal' },
      column: 'sequence_id',
    },
  ],
  maxObjects: 10,
  maxObjectBytes: 1000,
});
const source = () => ({
  generationId: '33333333-3333-4333-8333-333333333333',
  systemIdentifier: '7412345678901234567',
  serverVersionNum: 170006,
  snapshotId: '00000003-00000002-1',
  slotName: 'wm_full_restore_slot',
  consistentLsn: '0/16B3740',
  capturedAt: '2026-10-10T00:00:00.000000Z',
});
type Draft = Record<string, unknown> & {
  source: ReturnType<typeof source>;
  inventory: ReturnType<typeof inventory>;
};
function tail(src: ReturnType<typeof source>, inv: unknown, specs: [string, string, number][]) {
  const baseline = fullFamilyBaselineSha256(src, inv);
  let previous = baseline;
  const segments = specs.map(([startLsn, endLsn, recordCount], index) => {
    const partial = {
      ordinal: index + 1,
      startLsn,
      endLsn,
      recordCount,
      recordsSha256: recordCount === 0 ? EMPTY : digest(`records:${index}`),
      previousSegmentSha256: previous,
    };
    const segment = { ...partial, segmentSha256: fullFamilySegmentSha256(partial) };
    previous = segment.segmentSha256;
    return segment;
  });
  const endLsn = specs.at(-1)?.[1] ?? src.consistentLsn;
  return {
    segments,
    head: {
      lastOrdinal: segments.length,
      endLsn,
      headSha256: fullFamilyHeadSha256(baseline, segments, endLsn),
    },
  };
}
function body(): Draft {
  const src = source(),
    inv = inventory();
  return {
    schemaVersion: 1,
    protocol: 'wm-full-restore-family-v1',
    keyId: 'source-key-1',
    source: src,
    inventory: inv,
    objects: [
      {
        objectKey: 'gallery/a/original',
        byteLength: 100,
        sha256: digest('a'),
        owner: { schema: 'public', relation: 'alpha' },
      },
      {
        objectKey: 'gallery/b/original',
        byteLength: 50,
        sha256: digest('b'),
        owner: { schema: 'public', relation: 'alpha' },
      },
    ],
    sequences: [
      {
        schema: 'public',
        relation: 'openai_budget_journal_sequence_id_seq',
        lastValue: '42',
        isCalled: true,
      },
    ],
    tail: tail(src, inv, [
      ['0/16B3740', '0/16B3800', 3],
      ['0/16B3800', '0/16B3800', 0],
      ['0/16B3800', '1/0', 1],
    ]),
    target: { targetNonce: NONCE, targetIncarnation: INCARNATION, closedRevision: '7' },
    authentication: { sessionsRequireReauthentication: true },
  };
}
const verifier = () =>
  createFullFamilyArtifactVerifierV1({
    trustedRegistry: registry(),
    configuration: configuration(),
    resolveKey: (id) => (id === 'source-key-1' ? KEY : new Uint8Array(0)),
  });
function binding(draft: Draft, overrides: Record<string, unknown> = {}) {
  const t = draft['tail'] as ReturnType<typeof tail>;
  return {
    target: { targetNonce: NONCE, targetIncarnation: INCARNATION, closedRevision: '7' },
    latestHead: { ...t.head },
    ...overrides,
  };
}
function code(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof FullFamilyArtifactError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
}
const resign = (draft: Draft) => {
  const src = draft.source,
    inv = draft.inventory;
  const specs = (draft['tail'] as ReturnType<typeof tail>).segments.map(
    (s) => [s.startLsn, s.endLsn, s.recordCount] as [string, string, number],
  );
  draft['tail'] = tail(src, inv, specs);
  return signFullFamilyArtifactV1(draft, KEY);
};

describe('full-family artifact v1', () => {
  it('verifies exact canonical bytes and returns detached frozen evidence without authority', () => {
    const draft = body();
    const result = verifier().verify(signFullFamilyArtifactV1(draft, KEY), binding(draft));
    expect(result).toMatchObject({
      kind: 'verified_full_family_artifact_v1',
      authority: 'none',
      admissionAllowed: false,
      latestTail: 'witness_matched',
      totals: { objectCount: 2, objectBytes: 150, tailRecords: 4 },
    });
    expect(isVerifiedFullFamilyArtifactV1(result)).toBe(true);
    expect(isVerifiedFullFamilyArtifactV1({ ...result })).toBe(false);
    expect(Object.isFrozen(result.tail.segments[0])).toBe(true);
    expect(Object.isFrozen(result.inventory.inventory.relations)).toBe(true);
  });

  it('records a missing latest-head witness as not_checked, never matched', () => {
    const draft = body();
    const result = verifier().verify(
      signFullFamilyArtifactV1(draft, KEY),
      binding(draft, { latestHead: null }),
    );
    expect(result.latestTail).toBe('not_checked');
  });

  it('rejects wrong key, historical domains, tampering and non-canonical encodings', () => {
    const draft = body();
    const v = verifier();
    expect(code(() => v.verify(signFullFamilyArtifactV1(draft, OTHER_KEY), binding(draft)))).toBe(
      'FULL_FAMILY_AUTHENTICATION_FAILED',
    );
    for (const domain of [
      'wm-current-child-family-authentication-v1\0',
      'wm-app-family-authentication-v1\0',
      '',
    ]) {
      const text = canonicalFullFamilyJson(draft);
      const mac = createHmac('sha256', KEY).update(domain).update(text).digest('hex');
      const bytes = Buffer.from(`{"body":${text},"hmacSha256":"${mac}"}`);
      expect(code(() => v.verify(bytes, binding(draft)))).toBe('FULL_FAMILY_AUTHENTICATION_FAILED');
    }
    const good = Buffer.from(signFullFamilyArtifactV1(draft, KEY)).toString('utf8');
    const variants = [
      good.replace('{"body":{', '{ "body":{'),
      '\uFEFF' + good,
      good.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
      good.replace('"serverVersionNum":170006', '"serverVersionNum":170006.0'),
      good.replace('"lastValue":"42"', '"lastValue":"43"'),
    ];
    expect(code(() => v.verify(Buffer.from(variants[0] ?? ''), binding(draft)))).toBe(
      'INVALID_FULL_FAMILY_ARTIFACT',
    );
    expect(code(() => v.verify(Buffer.from(variants[1] ?? ''), binding(draft)))).toBe(
      'INVALID_FULL_FAMILY_ARTIFACT',
    );
    expect(code(() => v.verify(Buffer.from(variants[2] ?? ''), binding(draft)))).toBe(
      'INVALID_FULL_FAMILY_ARTIFACT',
    );
    expect(code(() => v.verify(Buffer.from(variants[3] ?? ''), binding(draft)))).toBe(
      'INVALID_FULL_FAMILY_ARTIFACT',
    );
    expect(code(() => v.verify(Buffer.from(variants[4] ?? ''), binding(draft)))).toBe(
      'FULL_FAMILY_AUTHENTICATION_FAILED',
    );
    expect(code(() => v.verify(Buffer.from([0xff, 0xfe]), binding(draft)))).toBe(
      'INVALID_FULL_FAMILY_ARTIFACT',
    );
  });

  it('rejects inventory drift, unknown/missing relations and retained sessions', () => {
    const v = verifier();
    const missing = body();
    missing.inventory.relations.splice(1, 1);
    expect(code(() => v.verify(resign(missing), binding(missing)))).toBe(
      'FULL_FAMILY_INVENTORY_REJECTED',
    );
    const unknown = body();
    (unknown.inventory.relations[1] as { relation: string }).relation = 'alphb';
    expect(code(() => v.verify(resign(unknown), binding(unknown)))).toBe(
      'FULL_FAMILY_INVENTORY_REJECTED',
    );
    const live = body();
    live.inventory.relations[0] = {
      ...relation('identity_private', 'session'),
      state: 'present',
      rowCount: 1,
      byteLength: 20,
      rowsSha256: digest('session'),
    };
    expect(code(() => v.verify(resign(live), binding(live)))).toBe(
      'FULL_FAMILY_AUTHENTICATION_STATE_RETAINED',
    );
    const identityDrift = body();
    identityDrift.inventory.identity.catalogSha256 = digest('other');
    expect(code(() => v.verify(resign(identityDrift), binding(identityDrift)))).toBe(
      'FULL_FAMILY_INVENTORY_REJECTED',
    );
  });

  it('rejects tail gaps, reordering, forged chains, head drift and stale latest tail', () => {
    const v = verifier();
    const gap = body();
    const t = gap['tail'] as ReturnType<typeof tail>;
    gap['tail'] = tail(gap.source, gap.inventory, [
      ['0/16B3740', '0/16B3800', 3],
      ['0/16B3900', '1/0', 1],
    ]);
    expect(code(() => v.verify(signFullFamilyArtifactV1(gap, KEY), binding(gap)))).toBe(
      'FULL_FAMILY_TAIL_REJECTED',
    );
    const reordered = body();
    const rt = reordered['tail'] as ReturnType<typeof tail>;
    rt.segments.reverse();
    expect(code(() => v.verify(signFullFamilyArtifactV1(reordered, KEY), binding(reordered)))).toBe(
      'FULL_FAMILY_TAIL_REJECTED',
    );
    const truncated = body();
    const tt = truncated['tail'] as ReturnType<typeof tail>;
    tt.segments.pop();
    expect(code(() => v.verify(signFullFamilyArtifactV1(truncated, KEY), binding(truncated)))).toBe(
      'FULL_FAMILY_TAIL_REJECTED',
    );
    const foreignBaseline = body();
    const fb = foreignBaseline['tail'] as ReturnType<typeof tail>;
    foreignBaseline.source.snapshotId = '00000003-00000002-2';
    void fb;
    expect(
      code(() =>
        v.verify(signFullFamilyArtifactV1(foreignBaseline, KEY), binding(foreignBaseline)),
      ),
    ).toBe('FULL_FAMILY_TAIL_REJECTED');
    const emptyWithRecords = body();
    emptyWithRecords['tail'] = tail(emptyWithRecords.source, emptyWithRecords.inventory, [
      ['0/16B3740', '0/16B3740', 2],
    ]);
    expect(
      code(() =>
        v.verify(signFullFamilyArtifactV1(emptyWithRecords, KEY), binding(emptyWithRecords)),
      ),
    ).toBe('FULL_FAMILY_TAIL_REJECTED');
    const stale = body();
    const bytes = signFullFamilyArtifactV1(stale, KEY);
    const later = {
      lastOrdinal: 4,
      endLsn: '1/10',
      headSha256: digest('newer-head'),
    };
    expect(code(() => v.verify(bytes, binding(stale, { latestHead: later })))).toBe(
      'FULL_FAMILY_LATEST_TAIL_MISMATCH',
    );
    void t;
  });

  it('accepts an explicitly empty tail whose head equals the baseline position', () => {
    const draft = body();
    draft['tail'] = tail(draft.source, draft.inventory, []);
    const result = verifier().verify(signFullFamilyArtifactV1(draft, KEY), binding(draft));
    expect(result.totals.tailRecords).toBe(0);
    expect(result.tail.head.endLsn).toBe(draft.source.consistentLsn);
  });

  it('rejects foreign target, object ordering/owner violations and sequence mismatch', () => {
    const v = verifier();
    const draft = body();
    const bytes = signFullFamilyArtifactV1(draft, KEY);
    for (const target of [
      { targetNonce: INCARNATION, targetIncarnation: INCARNATION, closedRevision: '7' },
      { targetNonce: NONCE, targetIncarnation: NONCE, closedRevision: '7' },
      { targetNonce: NONCE, targetIncarnation: INCARNATION, closedRevision: '8' },
    ])
      expect(code(() => v.verify(bytes, binding(draft, { target })))).toBe(
        'FULL_FAMILY_TARGET_MISMATCH',
      );
    const unordered = body();
    (unordered['objects'] as unknown[]).reverse();
    expect(code(() => v.verify(resign(unordered), binding(unordered)))).toBe(
      'FULL_FAMILY_OBJECT_REJECTED',
    );
    const sessionOwned = body();
    must((sessionOwned['objects'] as { owner: unknown }[])[0]).owner = {
      schema: 'identity_private',
      relation: 'session',
    };
    expect(code(() => v.verify(resign(sessionOwned), binding(sessionOwned)))).toBe(
      'FULL_FAMILY_OBJECT_REJECTED',
    );
    const traversal = body();
    must((traversal['objects'] as { objectKey: string }[])[0]).objectKey = 'gallery/../x';
    expect(code(() => v.verify(resign(traversal), binding(traversal)))).toBe(
      'INVALID_FULL_FAMILY_ARTIFACT',
    );
    const tooLarge = body();
    must((tooLarge['objects'] as { byteLength: number }[])[1]).byteLength = 901;
    expect(code(() => v.verify(resign(tooLarge), binding(tooLarge)))).toBe(
      'FULL_FAMILY_OBJECT_REJECTED',
    );
    const uncalled = body();
    must((uncalled['sequences'] as { isCalled: boolean }[])[0]).isCalled = false;
    expect(code(() => v.verify(resign(uncalled), binding(uncalled)))).toBe(
      'FULL_FAMILY_SEQUENCE_REJECTED',
    );
    const extra = body();
    (extra['sequences'] as unknown[]).push({
      schema: 'public',
      relation: 'other_seq',
      lastValue: '1',
      isCalled: true,
    });
    expect(code(() => v.verify(resign(extra), binding(extra)))).toBe(
      'FULL_FAMILY_SEQUENCE_REJECTED',
    );
  });

  it('rejects configuration that names unregistered or overlapping policy relations', () => {
    const bad = configuration();
    bad.budgetRelations.push({ schema: 'identity_private', relation: 'session' });
    expect(
      code(() =>
        createFullFamilyArtifactVerifierV1({
          trustedRegistry: registry(),
          configuration: bad,
          resolveKey: () => KEY,
        }),
      ),
    ).toBe('INVALID_FULL_FAMILY_CONFIGURATION');
    const unknown = configuration();
    unknown.authenticationResetRelations.push({ schema: 'public', relation: 'zeta' });
    expect(
      code(() =>
        createFullFamilyArtifactVerifierV1({
          trustedRegistry: registry(),
          configuration: unknown,
          resolveKey: () => KEY,
        }),
      ),
    ).toBe('INVALID_FULL_FAMILY_CONFIGURATION');
  });
});

describe('full restore postconditions v1', () => {
  const xact = { xid: '901', backendPid: 4242 };
  const states = { reserved: 1, dispatching: 0, completed: 0, charged_unknown: 1, released: 0 };
  function observation(result: ReturnType<ReturnType<typeof verifier>['verify']>) {
    return {
      transaction: xact,
      exclusiveControlLockHeld: true,
      control: {
        transaction: xact,
        state: 'CLOSED',
        localRevision: '7',
        targetNonce: NONCE,
        targetIncarnation: INCARNATION,
      },
      roles: {
        sessionIsTableOwner: true,
        ownerSuperuser: false,
        ownerBypassRls: false,
        runtimeRoleSuperuser: false,
        runtimeRoleBypassRls: false,
        runtimeRoleOwnsRestoredRelations: false,
      },
      baselineRelations: result.inventory.inventory.relations.map((r) => ({
        schema: r.schema,
        relation: r.relation,
        rowCount: r.rowCount,
        rowsSha256: r.rowsSha256,
      })),
      sequences: [
        {
          schema: 'public',
          relation: 'openai_budget_journal_sequence_id_seq',
          lastValue: '42',
          isCalled: true,
          ownerColumnMax: '40',
        },
      ],
      objects: {
        verifiedCount: 2,
        verifiedBytes: 150,
        manifestSha256: fullRestoreObjectManifestSha256V1(result),
        missing: 0,
        mismatched: 0,
      },
      tail: {
        appliedSegments: result.tail.segments.map((s) => ({
          ordinal: s.ordinal,
          segmentSha256: s.segmentSha256,
          appliedRecords: s.recordCount,
        })),
        appliedHeadSha256: result.tail.head.headSha256 as string | null,
      },
      suppression: { resurrectedSuppressedRows: 0, checkedRelations: 3 },
      authentication: { liveSessions: 0, liveProviderTokens: 0 },
      budget: {
        reservationStates: { ...states },
        expectedReservationStates: { ...states },
        externalRedispatches: 0,
      },
    };
  }
  const policy = {
    budgetReservationRelation: { schema: 'public', relation: 'openai_budget_reservation' },
  };
  const verified = (latest = true) => {
    const draft = body();
    return verifier().verify(
      signFullFamilyArtifactV1(draft, KEY),
      latest ? binding(draft) : binding(draft, { latestHead: null }),
    );
  };

  it('produces an admission command only when every fact is observed and bound', () => {
    const result = verified();
    const outcome = evaluateFullRestorePostconditionsV1(result, observation(result), policy);
    expect(outcome.ready).toBe(true);
    expect(outcome.admissionAllowed).toBe(false);
    expect(outcome.authority).toBe('none');
    if (outcome.ready)
      expect(outcome.command).toMatchObject({
        expectedRevision: '7',
        targetNonce: NONCE,
        targetIncarnation: INCARNATION,
        artifactSha256: result.artifactSha256,
        headSha256: result.tail.head.headSha256,
      });
  });

  it('never passes an unwitnessed latest tail or a structural artifact look-alike', () => {
    const result = verified(false);
    expect(
      evaluateFullRestorePostconditionsV1(result, observation(result), policy).failures,
    ).toEqual(['LATEST_TAIL_NOT_WITNESSED']);
    const real = verified();
    expect(
      evaluateFullRestorePostconditionsV1({ ...real }, observation(real), policy).failures,
    ).toEqual(['ARTIFACT_NOT_VERIFIED']);
  });

  it('reports each violated postcondition and fails closed on missing facts', () => {
    const result = verified();
    const cases: [string, (o: ReturnType<typeof observation>) => void][] = [
      [
        'TRANSACTION_BINDING_MISMATCH',
        (o) => (o.control.transaction = { xid: '902', backendPid: 4242 }),
      ],
      ['CONTROL_NOT_CLOSED', (o) => (o.control.state = 'ADMITTED')],
      ['CONTROL_TARGET_MISMATCH', (o) => (o.control.localRevision = '8')],
      ['OWNER_NOT_PLAIN', (o) => (o.roles.ownerBypassRls = true)],
      ['RUNTIME_ROLE_NOT_RESTRICTED', (o) => (o.roles.runtimeRoleOwnsRestoredRelations = true)],
      ['BASELINE_RELATION_MISMATCH', (o) => (must(o.baselineRelations[1]).rowCount = 3)],
      ['BASELINE_RELATION_MISMATCH', (o) => o.baselineRelations.pop()],
      ['SEQUENCE_HIGH_WATER_REGRESSED', (o) => (must(o.sequences[0]).lastValue = '41')],
      ['SEQUENCE_HIGH_WATER_REGRESSED', (o) => (must(o.sequences[0]).ownerColumnMax = '43')],
      ['OBJECT_VERIFICATION_INCOMPLETE', (o) => (o.objects.missing = 1)],
      ['OBJECT_VERIFICATION_INCOMPLETE', (o) => (o.objects.manifestSha256 = digest('x'))],
      ['TAIL_APPLICATION_INCOMPLETE', (o) => o.tail.appliedSegments.pop()],
      ['TAIL_APPLICATION_INCOMPLETE', (o) => (o.tail.appliedHeadSha256 = null)],
      ['SUPPRESSION_VIOLATED', (o) => (o.suppression.resurrectedSuppressedRows = 1)],
      ['SUPPRESSION_VIOLATED', (o) => (o.suppression.checkedRelations = 0)],
      ['AUTHENTICATION_STATE_LIVE', (o) => (o.authentication.liveSessions = 1)],
      ['BUDGET_STATE_ALTERED', (o) => (o.budget.reservationStates.charged_unknown = 0)],
      ['BUDGET_STATE_ALTERED', (o) => (o.budget.externalRedispatches = 1)],
    ];
    for (const [failure, mutate] of cases) {
      const o = observation(result);
      mutate(o);
      const outcome = evaluateFullRestorePostconditionsV1(result, o, policy);
      expect(outcome.ready, failure).toBe(false);
      expect(outcome.failures).toEqual([failure]);
    }
    const missing = observation(result) as Partial<ReturnType<typeof observation>>;
    delete missing.suppression;
    expect(evaluateFullRestorePostconditionsV1(result, missing, policy).failures).toEqual([
      'INVALID_OBSERVATION',
    ]);
    const unlocked = { ...observation(result), exclusiveControlLockHeld: false };
    expect(evaluateFullRestorePostconditionsV1(result, unlocked, policy).failures).toEqual([
      'INVALID_OBSERVATION',
    ]);
  });
});
