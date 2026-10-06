import { createHash, createHmac } from 'node:crypto';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { raceEventSchema } from '@workout/contracts/races';
import { planSnapshotSchema } from '@workout/contracts/planning';
import { assembleRaceManualReviewCandidate } from '@workout/server-coaching/race-manual-review-candidate';
import { createRaceRelativeScheduleCalculationPorts } from '../src/race-relative-schedule-calculation.js';
import { mapRaceManualReviewSourceInventory } from '../src/race-manual-review-source-inventory.js';
import {
  prepareVerifiedRaceReviewArtifactV2,
  signRaceReviewPreparationV2,
  readRaceReviewPreparationV2,
  raceReviewArtifactInventoriesV2,
  type RaceReviewArtifactBodyV2,
  type RaceReviewArtifactIdentityV2,
  prepareVerifiedRaceReviewArtifact,
  raceReviewArtifactInventories,
  readRaceReviewPreparation,
  signRaceReviewPreparation,
  RACE_REVIEW_ARTIFACT_MAX_BYTES,
  type RaceReviewArtifactBodyV1,
  type RaceReviewArtifactIdentity,
  type RaceReviewArtifactCollections,
} from '../src/restore-race-manual-review-artifact.js';
// Actual unit crypto/decoder + pure producer checks. No DB/stage/restore evidence.
const key = Buffer.alloc(32, 71);
const id = '10000000-0000-4000-8000-000000000001';
const eventId = '10000000-0000-4000-8000-000000000002';
const reviewId = '10000000-0000-4000-8000-000000000003';
const generation = '10000000-0000-4000-8000-000000000004';
const stamp = '2026-10-01T00:00:00.123456Z';
function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error('Missing synthetic fixture');
  return value;
}
const digest = 'a'.repeat(64);
const keyId = `race-manual-review:store:${'b'.repeat(64)}`;
function empty(): RaceReviewArtifactCollections {
  return { reviews: [], sourceRefs: [], suppressions: [], receipts: [] };
}
function fixture(
  sourceSchemaVersion: 105 | 106 = 105,
  collections = empty(),
): RaceReviewArtifactBodyV1 {
  return {
    artifactVersion: 1,
    family: 'race-manual-review-family-v1',
    purpose: 'owner_restore_race_manual_review_family',
    sourceSchemaVersion,
    targetSchemaVersion: 106,
    state: sourceSchemaVersion === 105 ? 'not_in_schema' : 'present',
    sourceKeyId: 'synthetic-source',
    sourceKeyVersion: 1,
    ownerId: id,
    generationId: generation,
    targetNonce: '10000000-0000-4000-8000-000000000005',
    targetIncarnation: '10000000-0000-4000-8000-000000000006',
    controlRevision: '1',
    schemaHash: digest,
    proofHash: digest,
    capturedAt: stamp,
    inventories: raceReviewArtifactInventories(collections),
    collections,
  };
}
function identity(body: RaceReviewArtifactBodyV1): RaceReviewArtifactIdentity {
  const { artifactVersion: _, state: __, collections: ___, ...expected } = body;
  return expected;
}
function prepare(body: RaceReviewArtifactBodyV1) {
  return prepareVerifiedRaceReviewArtifact(signRaceReviewPreparation(body, key), {
    expected: identity(body),
    resolveSourceKey: () => key,
  });
}
function source(historical = false) {
  const event = raceEventSchema.parse({
    id: eventId,
    revision: 1,
    title: 'Synthetic',
    localDate: '2026-10-06',
    localStartTime: null,
    timezone: 'UTC',
    locationName: null,
    distance: { kind: 'standard', class: '10k' },
    priority: null,
    participation: 'registered',
    officialUrl: null,
    course: null,
    targetSeconds: 0,
    planVersionId: historical ? id : null,
  });
  const snapshot = (versionId: string, version: number) =>
    planSnapshotSchema.parse({
      id: versionId,
      version,
      createdAt: stamp,
      draft: {
        timezone: 'UTC',
        title: 'Synthetic',
        periods: [
          {
            id: 'season',
            parentId: null,
            level: 'season',
            title: 'Synthetic',
            startDate: '2026-10-01',
            endDateExclusive: '2026-11-01',
            timezone: 'UTC',
            intent: '',
            isPartial: false,
          },
        ],
        sessions: [],
      },
    });
  const older = snapshot(id, 1),
    current = snapshot(reviewId, 2);
  const sourceInput = {
    athleteId: id,
    sourceFacts: { ownerAthleteId: id, nutritionRacePins: [] },
    projectionInput: {
      event,
      newLocalDate: '2026-10-08',
      currentPlan: historical ? current : null,
      sourcePlans: historical ? [older] : [],
      completionReports: [],
      selection: { kind: 'keep_plan' },
      nutrition: [],
      routines: [],
      resolutions: { nutrition: [], routines: [] },
    },
  };
  const candidate = assembleRaceManualReviewCandidate(
    sourceInput,
    createRaceRelativeScheduleCalculationPorts([event]),
  );
  if (candidate.status !== 'assembled') throw new Error('Expected real pure candidate');
  const capturedBinding = {
    athleteId: id,
    event: { id: eventId, revision: 1 },
    readSetDigest: digest,
  };
  const context = {
    athleteId: id,
    event,
    restoreGeneration: generation,
    readSetDigest: digest,
    manualBasis: {
      purpose: 'manual_race_date_change',
      app: { state: 'present', granted: true, revision: 1 },
      policy: { id: 'manual-race-date-impact', version: 1, digest },
    },
    linkedPlan: historical ? older : null,
    currentTraining: historical ? { aggregateId: generation, snapshot: current } : null,
    consumedSources: { plans: historical ? [older, current] : [], races: [event] },
  };
  return { context, sourceInput, candidate, capturedBinding };
}
function rows(tombstone = false, historical = false): RaceReviewArtifactCollections {
  const payload = source(historical);
  const mapped = mapRaceManualReviewSourceInventory({
    status: 'prepared_blocked',
    storage: 'not_persisted',
    sourceCompleteness: 'unverified',
    approvalAllowed: false,
    context: payload.context,
    sourceInput: payload.sourceInput,
    candidate: payload.candidate,
    binding: payload.capturedBinding,
  });
  if (mapped.inventoryState !== 'mapped')
    throw new Error(`Expected real mapper: ${JSON.stringify(mapped.unindexable)}`);
  const sourceRefs = mapped.refs.map((ref) => ({
    athlete_id: id,
    review_id: reviewId,
    source_kind: ref.kind,
    source_id: ref.sourceId,
    version_key: ref.versionKey,
    source_row_digest: digest,
  }));
  const first = sourceRefs[0];
  if (!first) throw new Error('Expected exact source ref');
  return {
    reviews: [
      {
        athlete_id: id,
        id: reviewId,
        schema_version: 1,
        created_at: stamp,
        event_id: eventId,
        event_revision: 1,
        app_revision: 1,
        generation_id: generation,
        policy_id: 'manual-race-date-impact',
        policy_version: 1,
        policy_digest: digest,
        read_set_digest: digest,
        candidate_digest: payload.candidate.digest,
        payload_sql_digest: digest,
        receipt_key: keyId,
        request_digest: digest,
        payload: tombstone
          ? null
          : {
              context: z.json().parse(payload.context),
              sourceInput: z.json().parse(payload.sourceInput),
              candidate: z.json().parse(payload.candidate),
              capturedBinding: payload.capturedBinding,
            },
        purged_at: tombstone ? stamp : null,
        purged_reason: tombstone ? 'source_deleted' : null,
      },
    ],
    sourceRefs,
    suppressions: tombstone ? [{ ...first, occurred_at: stamp }] : [],
    receipts: [
      {
        athlete_id: id,
        idempotency_key: keyId,
        request: { schemaVersion: 1, requestDigest: digest },
        result: {
          schemaVersion: 1,
          reviewId,
          candidateDigest: payload.candidate.digest,
          createdAt: stamp,
          approvalAllowed: false,
          sourceCompleteness: 'unverified',
        },
      },
    ],
  };
}
function reject(body: unknown) {
  expect(() => signRaceReviewPreparation(body, key)).toThrow('INVALID_RACE_REVIEW_ARTIFACT');
}
it('authenticates explicit source105 absence with no admission/staging/complete authority', () => {
  const handle = prepare(fixture());
  expect(handle).toEqual({
    kind: 'preparation_verified_only',
    admissionAllowed: false,
    stageAllowed: false,
    complete: false,
  });
  expect(readRaceReviewPreparation(handle)).toMatchObject({
    state: 'not_in_schema',
    complete: false,
  });
});
it.each([false, true])(
  'decodes actual pure producer supported nonnull body, historical Plan=%s',
  (historical) => {
    const body = fixture(106, rows(false, historical));
    const handle = prepare(body);
    expect(readRaceReviewPreparation(handle)).toMatchObject({
      state: 'present',
      stageAllowed: false,
    });
    expect(readRaceReviewPreparation(handle).identity.inventories.sourceRefs.count).toBe(
      historical ? 3 : 1,
    );
  },
);
it('preserves typed tombstones, original receipt and timestamp precision without body resurrection', () => {
  const body = fixture(106, rows(true));
  first(body.collections.reviews).created_at = '2026-10-01T09:00:00.123456+09:00';
  body.inventories = raceReviewArtifactInventories(body.collections);
  expect(readRaceReviewPreparation(prepare(body)).complete).toBe(false);
});
it('rejects forged/copy/serialized handles and freezes only summary metadata', () => {
  const handle = prepare(fixture());
  expect(Object.isFrozen(handle)).toBe(true);
  for (const fake of [{ ...handle }, JSON.parse(JSON.stringify(handle))])
    expect(() => readRaceReviewPreparation(fake)).toThrow('INVALID_RACE_REVIEW_ARTIFACT');
  expect(Object.isFrozen(readRaceReviewPreparation(handle).identity.inventories)).toBe(true);
});
it.each(['targetSchemaVersion', 'sourceSchemaVersion', 'artifactVersion', 'purpose', 'family'])(
  'rejects unknown %s discriminant',
  (field) => {
    reject({ ...fixture(), [field]: field.includes('Version') ? 107 : 'wrong' });
  },
);
it('checks independent expected target/owner/generation/nonce/revision/proof/key version', () => {
  const body = fixture();
  const bytes = signRaceReviewPreparation(body, key);
  for (const patch of [
    { ownerId: eventId },
    { generationId: eventId },
    { targetNonce: eventId },
    { targetIncarnation: eventId },
    { controlRevision: '2' },
    { proofHash: 'c'.repeat(64) },
    { sourceKeyVersion: 2 },
  ]) {
    expect(() =>
      prepareVerifiedRaceReviewArtifact(bytes, {
        expected: { ...identity(body), ...patch },
        resolveSourceKey: () => key,
      }),
    ).toThrow();
  }
});
it('rejects tamper/wrong key/short key and separates HMAC namespace from old app-family', () => {
  const body = fixture();
  const bytes = signRaceReviewPreparation(body, key);
  const changed = Buffer.from(bytes);
  changed[changed.length - 3] = 48;
  expect(() =>
    prepareVerifiedRaceReviewArtifact(changed, {
      expected: identity(body),
      resolveSourceKey: () => key,
    }),
  ).toThrow();
  for (const wrong of [Buffer.alloc(32, 72), Buffer.alloc(31)])
    expect(() =>
      prepareVerifiedRaceReviewArtifact(bytes, {
        expected: identity(body),
        resolveSourceKey: () => wrong,
      }),
    ).toThrow();
  const raw = JSON.parse(Buffer.from(bytes).toString('utf8'));
  raw.hmacSha256 = createHmac('sha256', key)
    .update('wm-owner-restore-app-family-v1\0')
    .update(JSON.stringify(raw.body))
    .digest('hex');
  expect(() =>
    prepareVerifiedRaceReviewArtifact(Buffer.from(JSON.stringify(raw)), {
      expected: identity(body),
      resolveSourceKey: () => key,
    }),
  ).toThrow();
});
it('rejects noncanonical/duplicate-key/invalid UTF8/depth and byte cap+1 input', () => {
  const body = fixture(),
    bytes = signRaceReviewPreparation(body, key),
    authority = { expected: identity(body), resolveSourceKey: () => key };
  for (const bad of [
    Buffer.from(` ${Buffer.from(bytes).toString()}`),
    Buffer.from('{"body":0,"body":1}'),
    Buffer.from([0xff]),
    Buffer.from('['.repeat(65) + ']'.repeat(65)),
    Buffer.alloc(RACE_REVIEW_ARTIFACT_MAX_BYTES + 1),
  ])
    expect(() => prepareVerifiedRaceReviewArtifact(bad, authority)).toThrow();
});
it('rejects source105 rows and missing collections, counts/digests mismatches, extra fields', () => {
  reject(fixture(105, rows()));
  const body = fixture();
  reject({ ...body, verified: true });
  reject({ ...body, collections: { reviews: [] } });
  reject({ ...body, inventories: { ...body.inventories, reviews: { count: 1, sha256: digest } } });
});
it('rejects foreign/missing/digest-conflicting exact refs and unlinked or forged receipts', () => {
  for (const mutate of [
    (c: RaceReviewArtifactCollections) => {
      first(c.sourceRefs).athlete_id = eventId;
    },
    (c: RaceReviewArtifactCollections) => {
      first(c.sourceRefs).review_id = eventId;
    },
    (c: RaceReviewArtifactCollections) => {
      c.sourceRefs = [];
    },
    (c: RaceReviewArtifactCollections) => {
      first(c.receipts).result.candidateDigest = 'c'.repeat(64);
    },
    (c: RaceReviewArtifactCollections) => {
      first(c.receipts).request.requestDigest = 'c'.repeat(64);
    },
    (c: RaceReviewArtifactCollections) => {
      first(c.suppressions).source_row_digest = 'c'.repeat(64);
    },
  ]) {
    const c = rows(true);
    mutate(c);
    reject(fixture(106, c));
  }
});
it('rejects nonnull body candidate/context/app/policy/binding tamper and unsupported copied health body', () => {
  for (const mutate of [
    (p: ReturnType<typeof source>) => {
      p.candidate.body.event.title = 'Changed';
    },
    (p: ReturnType<typeof source>) => {
      p.context.manualBasis.app.revision = 3;
    },
    (p: ReturnType<typeof source>) => {
      p.context.restoreGeneration = eventId;
    },
    (p: ReturnType<typeof source>) => {
      p.context.manualBasis.policy.digest = 'c'.repeat(64);
    },
    (p: ReturnType<typeof source>) => {
      p.capturedBinding.event.id = id;
    },
    (p: ReturnType<typeof source>) => {
      p.context.event.revision = 2;
    },
  ]) {
    const c = rows();
    const p = structuredClone(source());
    mutate(p);
    first(c.reviews).payload = {
      context: z.json().parse(p.context),
      sourceInput: z.json().parse(p.sourceInput),
      candidate: z.json().parse(p.candidate),
      capturedBinding: p.capturedBinding,
    };
    reject(fixture(106, c));
  }
  const c = rows();
  const p = source();
  first(c.reviews).payload = {
    context: z.json().parse({ ...p.context, extraPrivateBody: { notes: 'Synthetic' } }),
    sourceInput: z.json().parse(p.sourceInput),
    candidate: z.json().parse(p.candidate),
    capturedBinding: p.capturedBinding,
  };
  reject(fixture(106, c));
});
it('rejects invalid dates, namespace tuple ambiguity, null/unknown raw columns and cap+1', () => {
  reject({ ...fixture(), capturedAt: '2026-02-30T00:00:00Z' });
  const c = rows(true);
  const ref = first(c.sourceRefs);
  for (const version_key of ['["' + id + '",0]', '["' + id + '",1 ]', '["wrong",1]']) {
    reject({
      ...fixture(106, c),
      collections: {
        ...c,
        sourceRefs: [
          { ...ref, source_kind: 'session-completion', source_id: 'session', version_key },
        ],
      },
    });
  }
  reject({
    ...fixture(106, c),
    collections: { ...c, suppressions: [{ ...c.suppressions[0], event_id: eventId }] },
  });
  reject({
    ...fixture(106, c),
    collections: { ...c, sourceRefs: Array.from({ length: 5001 }, () => ref) },
  });
  expect(createHash('sha256').update('[]').digest('hex')).toBe(
    fixture().inventories.reviews.sha256,
  );
});
it('rejects exact copied body lineage gaps even with a newly signed inventory', () => {
  const c = rows(false, true);
  c.sourceRefs = c.sourceRefs.filter(
    (ref) => ref.source_kind !== 'plan-snapshot' || ref.source_id !== id,
  );
  reject(fixture(106, c));
});
it('rejects accessors/cycles/array holes without evaluating an untrusted getter', () => {
  let calls = 0;
  const a: unknown[] = [];
  Object.defineProperty(a, '0', {
    enumerable: true,
    get() {
      calls++;
      return null;
    },
  });
  const raw = { ...fixture(), collections: { ...empty(), reviews: a } };
  reject(raw);
  expect(calls).toBe(0);
  const cycle: Record<string, unknown> = {};
  cycle['self'] = cycle;
  reject(cycle);
  reject({ ...fixture(), collections: { ...empty(), reviews: Array(1) } });
});
it('does not resolve keys before independently expected identity matches and sanitizes resolver errors', () => {
  const body = fixture(),
    bytes = signRaceReviewPreparation(body, key);
  let calls = 0;
  expect(() =>
    prepareVerifiedRaceReviewArtifact(bytes, {
      expected: { ...identity(body), sourceKeyId: 'other' },
      resolveSourceKey: () => {
        calls++;
        return key;
      },
    }),
  ).toThrow('INVALID_RACE_REVIEW_ARTIFACT');
  expect(calls).toBe(0);
  expect(() =>
    prepareVerifiedRaceReviewArtifact(bytes, {
      expected: identity(body),
      resolveSourceKey: () => {
        throw new Error('Synthetic secret detail');
      },
    }),
  ).toThrow(/^INVALID_RACE_REVIEW_ARTIFACT$/);
});

it('requires the actual source106 restore-generation context pin rather than borrowing the header', () => {
  const body = fixture(106, rows());
  const payload = first(body.collections.reviews).payload;
  if (!payload) throw new Error('Expected nonnull fixture');
  const context = z.record(z.string(), z.json()).parse(payload.context);
  delete context['restoreGeneration'];
  payload.context = context;
  body.inventories = raceReviewArtifactInventories(body.collections);
  reject(body);
});
it('strict raw column roster rejects NULL epoch/ref/receipt and unknown table fields', () => {
  const body = fixture(106, rows(true));
  const c = body.collections;
  for (const collections of [
    { ...c, reviews: [{ ...first(c.reviews), app_revision: null }] },
    { ...c, sourceRefs: [{ ...first(c.sourceRefs), source_kind: null }] },
    { ...c, receipts: [{ ...first(c.receipts), request: null }] },
    { ...c, reviews: [{ ...first(c.reviews), providerEndpoint: 'synthetic-disallowed' }] },
  ])
    reject({ ...body, collections });
  reject({
    ...fixture(),
    inventories: { ...fixture().inventories, reviews: { count: 0, sha256: digest } },
  });
});

it('rejects hidden and symbol data instead of silently omitting it from a signed family', () => {
  const hidden = fixture();
  Object.defineProperty(hidden, 'hiddenContent', { value: 'synthetic-hidden', enumerable: false });
  reject(hidden);
  const symbol = fixture();
  Object.defineProperty(symbol, Symbol('synthetic-scope'), { value: 'synthetic-hidden' });
  reject(symbol);
  const rowsWithHiddenProperty = fixture();
  Object.defineProperty(rowsWithHiddenProperty.collections.reviews, 'hiddenContent', {
    value: 'synthetic-hidden',
  });
  reject(rowsWithHiddenProperty);
});

function fixtureV2(
  sourceSchemaVersion: 105 | 106 = 106,
  tombstone = false,
): RaceReviewArtifactBodyV2 {
  const {
    artifactVersion: _,
    family: __,
    schemaHash: ___,
    ...base
  } = fixture(sourceSchemaVersion, sourceSchemaVersion === 105 ? empty() : rows(tombstone));
  const collections = {
    ...base.collections,
    suppressions: base.collections.suppressions.map((r) => ({ ...r, event_id: generation })),
  };
  return {
    ...base,
    artifactVersion: 2,
    family: 'race-manual-review-family-v2',
    sourceSchemaHash: 'c'.repeat(64),
    targetSchemaHash: 'd'.repeat(64),
    collections,
    inventories: raceReviewArtifactInventoriesV2(collections),
  };
}
function identityV2(body: RaceReviewArtifactBodyV2): RaceReviewArtifactIdentityV2 {
  const { artifactVersion: _, state: __, collections: ___, ...identity } = body;
  return identity;
}
function verifyV2(body: RaceReviewArtifactBodyV2) {
  return prepareVerifiedRaceReviewArtifactV2(signRaceReviewPreparationV2(body, key), {
    expected: identityV2(body),
    resolveSourceKey: () => key,
  });
}
it.each([105, 106] as const)(
  'V2 authenticates explicit schema%s absence/presence without stage or admission',
  (version) => {
    const body = fixtureV2(version);
    const summary = readRaceReviewPreparationV2(verifyV2(body));
    expect(summary).toEqual({
      identity: identityV2(body),
      state: version === 105 ? 'not_in_schema' : 'present',
      admissionAllowed: false,
      stageAllowed: false,
      complete: false,
    });
    expect(Object.isFrozen(summary.identity)).toBe(true);
  },
);
it('V2 permits multiple exact markers referencing one original event and retains SQL digests/time', () => {
  const body = fixtureV2(106, true);
  const ref = {
    ...first(body.collections.sourceRefs),
    source_kind: 'plan-snapshot' as const,
    source_id: generation,
  };
  body.collections.sourceRefs.push(ref);
  body.collections.suppressions.push({ ...ref, occurred_at: stamp, event_id: generation });
  body.inventories = raceReviewArtifactInventoriesV2(body.collections);
  const encoded = signRaceReviewPreparationV2(body, key);
  expect(Buffer.from(encoded).toString()).toContain('"event_id":"' + generation + '"');
  expect(readRaceReviewPreparationV2(verifyV2(body)).identity.inventories.suppressions.count).toBe(
    2,
  );
  expect(first(body.collections.reviews).payload_sql_digest).toBe(digest);
  expect(first(body.collections.suppressions).occurred_at).toBe(stamp);
  // This is identity preparation; no assertion that generation UUID is an actual tail event.
});
it.each(['sourceSchemaHash', 'targetSchemaHash'] as const)(
  'V2 rejects mismatched independent %s pin',
  (field) => {
    const body = fixtureV2();
    const bytes = signRaceReviewPreparationV2(body, key);
    expect(() =>
      prepareVerifiedRaceReviewArtifactV2(bytes, {
        expected: { ...identityV2(body), [field]: digest },
        resolveSourceKey: () => key,
      }),
    ).toThrow('INVALID_RACE_REVIEW_ARTIFACT');
  },
);
it('V2 rejects missing/invalid marker identity, foreign refs and duplicate markers', () => {
  for (const mutation of [
    (body: RaceReviewArtifactBodyV2) =>
      Reflect.deleteProperty(first(body.collections.suppressions), 'event_id'),
    (body: RaceReviewArtifactBodyV2) => {
      first(body.collections.suppressions).event_id = 'invalid';
    },
    (body: RaceReviewArtifactBodyV2) => {
      first(body.collections.suppressions).athlete_id = generation;
    },
    (body: RaceReviewArtifactBodyV2) => {
      first(body.collections.suppressions).source_row_digest = 'e'.repeat(64);
    },
    (body: RaceReviewArtifactBodyV2) => {
      first(body.collections.suppressions).occurred_at = 'invalid';
    },
    (body: RaceReviewArtifactBodyV2) => {
      body.collections.suppressions.push(first(body.collections.suppressions));
    },
  ]) {
    const body = fixtureV2(106, true);
    mutation(body);
    // Recompute where structurally valid so semantic relation/duplicate checks are exercised.
    try {
      body.inventories = raceReviewArtifactInventoriesV2(body.collections);
    } catch {
      /* Invalid structural row remains for signer rejection. */
    }
    expect(() => signRaceReviewPreparationV2(body, key)).toThrow('INVALID_RACE_REVIEW_ARTIFACT');
  }
});
it('V2 cannot borrow legacy schemaHash, versions, discriminator or absent-source rows', () => {
  const body = fixtureV2();
  for (const invalid of [
    { ...body, schemaHash: digest },
    { ...body, artifactVersion: 1 },
    { ...body, family: 'race-manual-review-family-v1' },
    { ...body, sourceSchemaVersion: 105 },
    { ...body, targetSchemaVersion: 107 },
    { ...body, sourceSchemaHash: undefined },
    { ...body, state: 'not_in_schema' },
    { ...body, unknown: true },
  ])
    expect(() => signRaceReviewPreparationV2(invalid, key)).toThrow('INVALID_RACE_REVIEW_ARTIFACT');
});
it('V2 rejects HMAC/key/canonical/bounds changes and handles cannot be forged or used by V1', () => {
  const body = fixtureV2(),
    bytes = signRaceReviewPreparationV2(body, key);
  const authority = { expected: identityV2(body), resolveSourceKey: () => key };
  for (const invalid of [
    Buffer.concat([bytes, Buffer.from(' ')]),
    Buffer.alloc(RACE_REVIEW_ARTIFACT_MAX_BYTES + 1),
    Buffer.from('{"body":'),
  ])
    expect(() => prepareVerifiedRaceReviewArtifactV2(invalid, authority)).toThrow(
      'INVALID_RACE_REVIEW_ARTIFACT',
    );
  expect(() =>
    prepareVerifiedRaceReviewArtifactV2(bytes, {
      ...authority,
      resolveSourceKey: () => Buffer.alloc(32, 72),
    }),
  ).toThrow('INVALID_RACE_REVIEW_ARTIFACT');
  expect(() =>
    readRaceReviewPreparationV2({
      kind: 'preparation_verified_only_v2',
      admissionAllowed: false,
      stageAllowed: false,
      complete: false,
    }),
  ).toThrow('INVALID_RACE_REVIEW_ARTIFACT');
  expect(() =>
    prepareVerifiedRaceReviewArtifact(bytes, {
      expected: identity(fixture()),
      resolveSourceKey: () => key,
    }),
  ).toThrow('INVALID_RACE_REVIEW_ARTIFACT');
  expect(() =>
    prepareVerifiedRaceReviewArtifactV2(signRaceReviewPreparation(fixture(), key), authority),
  ).toThrow('INVALID_RACE_REVIEW_ARTIFACT');
  const tooMany = fixtureV2(106, true);
  tooMany.collections.suppressions = Array.from({ length: 5001 }, () =>
    first(tooMany.collections.suppressions),
  );
  expect(() => signRaceReviewPreparationV2(tooMany, key)).toThrow('INVALID_RACE_REVIEW_ARTIFACT');
});

it('V2 distinguishes present zero collections from source105 schema absence', () => {
  const body = fixtureV2(106);
  body.collections = { reviews: [], sourceRefs: [], suppressions: [], receipts: [] };
  body.inventories = raceReviewArtifactInventoriesV2(body.collections);
  expect(readRaceReviewPreparationV2(verifyV2(body)).state).toBe('present');
  expect(readRaceReviewPreparationV2(verifyV2(fixtureV2(105))).state).toBe('not_in_schema');
});
it('V2 rejects contradictory occurrence times for a shared original event', () => {
  const body = fixtureV2(106, true);
  const ref = {
    ...first(body.collections.sourceRefs),
    source_kind: 'plan-snapshot' as const,
    source_id: generation,
  };
  body.collections.sourceRefs.push(ref);
  body.collections.suppressions.push({
    ...ref,
    occurred_at: '2026-10-01T00:00:00.123457Z',
    event_id: generation,
  });
  body.inventories = raceReviewArtifactInventoriesV2(body.collections);
  expect(() => signRaceReviewPreparationV2(body, key)).toThrow('INVALID_RACE_REVIEW_ARTIFACT');
});
it('V1 and V2 keep distinct exact canonical HMAC domains', () => {
  const v1 = signRaceReviewPreparation(fixture(), key);
  const v2Body = fixtureV2(105),
    v2 = signRaceReviewPreparationV2(v2Body, key);
  for (const [bytes, domain] of [
    [v1, 'wm-race-manual-review-family-v1\0'],
    [v2, 'wm-race-manual-review-family-v2\0'],
  ] as const) {
    const envelope: unknown = JSON.parse(Buffer.from(bytes).toString());
    const parsed = z
      .strictObject({ body: z.record(z.string(), z.json()), hmacSha256: z.string() })
      .parse(envelope);
    expect(parsed.hmacSha256).toBe(
      createHmac('sha256', key).update(domain).update(JSON.stringify(parsed.body)).digest('hex'),
    );
  }
  const decoded = z
    .strictObject({ body: z.record(z.string(), z.json()), hmacSha256: z.string() })
    .parse(JSON.parse(Buffer.from(v2).toString()));
  const wrong = createHmac('sha256', key)
    .update('wm-race-manual-review-family-v1\0')
    .update(JSON.stringify(decoded.body))
    .digest('hex');
  const changed = Buffer.from(Buffer.from(v2).toString().replace(decoded.hmacSha256, wrong));
  expect(() =>
    prepareVerifiedRaceReviewArtifactV2(changed, {
      expected: identityV2(v2Body),
      resolveSourceKey: () => key,
    }),
  ).toThrow('INVALID_RACE_REVIEW_ARTIFACT');
});
