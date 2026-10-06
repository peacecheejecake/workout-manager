import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { buildBaselineAnchorCandidate, verifyBaselineAnchorCandidate } from './baseline-anchor.mjs';

const tables = [
  'course_deletion',
  'course',
  'activity_canonical',
  'activity_source_head',
  'activity_suppression',
  'resource',
  'gallery_media_item',
  'check_in',
  'resource_share',
  'resource_access_audit',
  'course_share',
  'course_share_audit',
  'intake_entry',
  'recovery_action_log',
  'coaching_constraint',
  'course_share_area_budget',
  'healthkit_workout_sample',
  'healthkit_workout_batch_receipt',
  'healthkit_workout_lineage',
  'healthkit_existing_binding',
  'healthkit_workout_registry_head',
  'healthkit_workout_claim',
  'healthkit_workout_registration_receipt',
  'healthkit_workout_deregistration',
  'healthkit_deregistration_work',
  'race_event',
  'race_event_revision',
  'race_result',
  'race_result_revision',
  'training_best',
  'training_best_revision',
  'race_command_receipt',
  'race_collection_head',
  'restore_race_deletion_replay_receipt',
].map((name) => `public.${name}`);
const eventKinds = [
  'tenant_erased',
  'course_deleted',
  'activity_deleted',
  'resource_deleted',
  'gallery_media_deleted',
  'healthkit_consent_transition',
  'ai_consent_transition',
  'check_in_deleted',
  'resource_share_revoked',
  'course_share_revoked',
  'intake_entry_deleted',
  'recovery_action_deleted',
  'healthkit_workout_deregistration_pending',
  'healthkit_workout_deregistration_released',
  'race_event_deleted',
  'race_result_deleted',
  'training_best_deleted',
];
const gaps = [
  'SNAPSHOT_BINDING_NOT_INDEPENDENTLY_VERIFIED',
  'OWNER_ROSTER_NOT_INDEPENDENTLY_PROVEN',
  'PRE_EVENT_ERASURE_OWNER_NOT_DISCOVERABLE',
  'PRE_EVENT_HISTORY_NOT_RECONSTRUCTIBLE',
  'HEALTHKIT_RAW_ONLY_DELETION_NOT_COVERED',
  'SHARE_EPOCH_OUTSIDE_DATABASE',
  'POST_SNAPSHOT_TAIL_NOT_WITNESSED',
  'DOMAIN_HEADS_NOT_FULLY_CAPTURED',
  'DOMAIN_SCHEMA_FINGERPRINT_NOT_INDEPENDENTLY_VERIFIED',
  'HEALTHKIT_GLOBAL_REPLAY_RECEIPTS_NOT_CAPTURED',
];
const coverageKey = Buffer.alloc(32, 7);
const anchorKey = Buffer.alloc(32, 9);
function ownerTag(owner) {
  const hmac = createHmac('sha256', coverageKey);
  for (const part of ['owner-v1', owner]) {
    const bytes = Buffer.from(part);
    hmac.update(String(bytes.length)).update(':').update(bytes);
  }
  return hmac.digest('hex');
}
function fixture(expectedOwners = ['owner-a']) {
  const snapshot = {
    snapshotName: '00000001-00000002-1',
    consistentPointLsn: '0/16B6C50',
    postgresSystemIdentifier: '123',
    replicationSlot: 'slot_probe',
    publication: 'workout_publication',
  };
  const fingerprint = 'a'.repeat(64);
  const domain = Object.fromEntries(
    tables.map((table) => [
      table,
      {
        count: 0,
        digest: 'b'.repeat(64),
      },
    ]),
  );
  return {
    backupId: 'backup-abc',
    snapshot,
    archives: {
      manifest: { path: 'manifest.json', sha256: 'f'.repeat(64), versionId: 'version-manifest' },
      database: { path: 'database.dump', sha256: 'c'.repeat(64), versionId: 'version-db' },
      privateFiles: [
        { path: 'private/photo.bin', sha256: 'd'.repeat(64), versionId: 'version-private' },
      ],
    },
    remote: {
      bucket: 'workout-private-backups',
      prefix: 'workout/v2',
      region: 'ap-northeast-2',
      expectedBucketOwner: '681892421656',
      completionVersionId: 'completion-v1',
    },
    coverage: {
      schemaVersion: 3,
      domainSchemaFingerprint: fingerprint,
      snapshot: {
        snapshotName: snapshot.snapshotName,
        consistentPointLsn: snapshot.consistentPointLsn,
        postgresSystemIdentifier: snapshot.postgresSystemIdentifier,
        replicationSlot: snapshot.replicationSlot,
        snapshotId: '1:2:',
      },
      owners: expectedOwners.map((owner) => ({
        ownerTag: ownerTag(owner),
        domain,
        events: Object.fromEntries(eventKinds.map((kind) => [kind, 0])),
        consent: { ai: { state: 'absent' }, healthkit: { state: 'absent' } },
        erasure: 'absent',
        coaching: { head: { state: 'absent' }, total: 0, tombstones: 0 },
        courseShareAreaBudget: { rows: 0, linksCut: 0 },
      })),
      complete: false,
      gaps: [...gaps],
    },
    expectedOwners,
    expectedDomainSchemaFingerprint: fingerprint,
    expectedPublication: snapshot.publication,
    coverageHmacKey: coverageKey,
    anchorHmacKey: anchorKey,
  };
}
const clone = (value) => structuredClone(value);
const rejects = (options) =>
  assert.throws(
    () => buildBaselineAnchorCandidate(options),
    /BASELINE_ANCHOR_CANDIDATE_UNVERIFIED/,
  );

test('offline candidate authenticates exact archive versions, identity, and zero-owner explicit coverage', () => {
  for (const owners of [['owner-a'], []]) {
    const options = fixture(owners);
    const candidate = buildBaselineAnchorCandidate(options);
    assert.equal(candidate.complete, false);
    assert.equal(candidate.restoreAccessAllowed, false);
    assert.deepEqual(candidate.expectedOwnerTags, owners.map(ownerTag).sort());
    assert.ok(candidate.gaps.includes('FINAL_TAIL_NOT_PROVEN'));
    assert.ok(candidate.gaps.includes('PRE_EVENT_HISTORY_NOT_RECONSTRUCTIBLE'));
    assert.equal(verifyBaselineAnchorCandidate(candidate, options), true);
    assert.equal(JSON.stringify(candidate).includes('owner-a'), false);
    assert.equal(JSON.stringify(candidate).includes(coverageKey.toString('hex')), false);
    assert.equal(JSON.stringify(candidate).includes(anchorKey.toString('hex')), false);
    assert.equal(JSON.stringify(candidate).includes(coverageKey.toString('base64')), false);
    assert.equal(JSON.stringify(candidate).includes(anchorKey.toString('base64')), false);
  }
});

test('owner roster rejects missing, extra, and duplicate owners, including false empty', () => {
  const missing = fixture(['owner-a', 'owner-b']);
  missing.coverage.owners.pop();
  rejects(missing);
  const extra = fixture([]);
  extra.coverage.owners.push(fixture().coverage.owners[0]);
  rejects(extra);
  const duplicate = fixture(['owner-a', 'owner-a']);
  rejects(duplicate);
  const tagDuplicate = fixture(['owner-a', 'owner-b']);
  tagDuplicate.coverage.owners[1].ownerTag = tagDuplicate.coverage.owners[0].ownerTag;
  rejects(tagDuplicate);
});

test('snapshot and pinned schema identity must match', () => {
  const changedSlot = fixture();
  changedSlot.coverage.snapshot.replicationSlot = 'other_slot';
  rejects(changedSlot);
  const changedLsn = fixture();
  changedLsn.coverage.snapshot.consistentPointLsn = '0/16B6C51';
  rejects(changedLsn);
  const schema = fixture();
  schema.expectedDomainSchemaFingerprint = 'e'.repeat(64);
  rejects(schema);
  const publication = fixture();
  publication.expectedPublication = 'different_publication';
  rejects(publication);
  const malformedPublication = fixture();
  malformedPublication.snapshot.publication = 'Invalid-Publication';
  rejects(malformedPublication);
  const unpinned = fixture();
  unpinned.expectedDomainSchemaFingerprint = '';
  rejects(unpinned);
});

test('exact archive digests and opaque remote versions are mandatory', () => {
  for (const kind of ['manifest', 'database', 'private']) {
    for (const field of ['versionId', 'sha256']) {
      const options = fixture();
      const file = kind === 'private' ? options.archives.privateFiles[0] : options.archives[kind];
      file[field] = '';
      rejects(options);
    }
  }
  const duplicate = fixture();
  duplicate.archives.privateFiles.push(clone(duplicate.archives.privateFiles[0]));
  rejects(duplicate);
});

test('verifier rejects tampering, wrong independent keys, and changed expectations', () => {
  const options = fixture();
  const candidate = buildBaselineAnchorCandidate(options);
  const tampered = clone(candidate);
  tampered.archives.database.sha256 = 'e'.repeat(64);
  assert.throws(() => verifyBaselineAnchorCandidate(tampered, options));
  assert.throws(() =>
    verifyBaselineAnchorCandidate(candidate, { ...options, coverageHmacKey: Buffer.alloc(32, 8) }),
  );
  assert.throws(() =>
    verifyBaselineAnchorCandidate(candidate, { ...options, anchorHmacKey: Buffer.alloc(32, 8) }),
  );
  for (const altered of [
    {
      ...options,
      archives: {
        ...options.archives,
        manifest: { ...options.archives.manifest, versionId: 'new-manifest-version' },
      },
    },
    {
      ...options,
      remote: { ...options.remote, completionVersionId: 'another-completion' },
    },
    {
      ...options,
      remote: { ...options.remote, bucket: 'different-backup-bucket' },
    },
    {
      ...options,
      archives: {
        ...options.archives,
        database: { ...options.archives.database, versionId: 'new-version' },
      },
    },
    {
      ...options,
      archives: {
        ...options.archives,
        database: { ...options.archives.database, sha256: 'e'.repeat(64) },
      },
    },
    { ...options, backupId: 'backup-different' },
    { ...options, expectedOwners: ['owner-b'] },
  ])
    assert.throws(() => verifyBaselineAnchorCandidate(candidate, altered));
});

test('candidate rejects equal or missing key roles', () => {
  const equal = fixture();
  equal.anchorHmacKey = Buffer.from(equal.coverageHmacKey);
  rejects(equal);
  const missingCoverage = fixture();
  delete missingCoverage.coverageHmacKey;
  rejects(missingCoverage);
  const missingAnchor = fixture();
  delete missingAnchor.anchorHmacKey;
  rejects(missingAnchor);
});

test('remote location must be a bounded, exact Seoul S3 namespace', () => {
  for (const change of [
    { prefix: 'workout/../other' },
    { prefix: 'workout//v2' },
    { region: 'ap-northeast-1' },
    { completionVersionId: '' },
    { expectedBucketOwner: 'other' },
  ]) {
    const options = fixture();
    options.remote = { ...options.remote, ...change };
    rejects(options);
  }
});

test('candidate remains authenticated after caller mutates its nested inputs', () => {
  const supplied = fixture();
  const originalExpectations = fixture();
  const candidate = buildBaselineAnchorCandidate(supplied);
  const signedBytes = JSON.stringify(candidate);
  supplied.snapshot.snapshotName = '00000003-00000004-1';
  supplied.archives.database.versionId = 'later-version';
  supplied.archives.privateFiles[0].sha256 = 'e'.repeat(64);
  supplied.coverage.snapshot.replicationSlot = 'another_slot';
  supplied.coverage.owners[0].domain['public.course'].digest = 'f'.repeat(64);
  supplied.coverage.gaps.push('LATER_INPUT_CHANGE');
  assert.equal(JSON.stringify(candidate), signedBytes);
  assert.equal(verifyBaselineAnchorCandidate(candidate, originalExpectations), true);
  const tampered = clone(candidate);
  tampered.coverage.owners[0].domain['public.course'].digest = 'f'.repeat(64);
  assert.throws(() => verifyBaselineAnchorCandidate(tampered, originalExpectations));
});

test('unbounded and mutable shaped fields fail closed', () => {
  const tooMany = fixture();
  tooMany.expectedOwners = Array.from({ length: 10_001 }, (_, index) => `owner-${index}`);
  rejects(tooMany);
  const deep = fixture();
  deep.coverage.owners[0].events = { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } };
  rejects(deep);
  const missingGap = fixture();
  missingGap.coverage.gaps.pop();
  rejects(missingGap);
  const claim = buildBaselineAnchorCandidate(fixture());
  claim.restoreAccessAllowed = true;
  assert.throws(() => verifyBaselineAnchorCandidate(claim, fixture()));
  const extra = fixture();
  extra.coverage.owners[0].rawId = 'owner-a';
  rejects(extra);
});

// M2-02f: current coverage protocol includes all race ledgers, the exact replay
// receipt domain, and explicit counts for every v4 suppression discriminator.
test('current coverage binds each v4 race deletion kind and replay receipt domain', () => {
  const options = fixture();
  for (const kind of ['race_event_deleted', 'race_result_deleted', 'training_best_deleted'])
    options.coverage.owners[0].events[kind] = 1;
  options.coverage.owners[0].domain['public.restore_race_deletion_replay_receipt'].count = 3;
  const candidate = buildBaselineAnchorCandidate(options);
  assert.equal(verifyBaselineAnchorCandidate(candidate, options), true);
  assert.equal(candidate.coverage.schemaVersion, 3);
  assert.deepEqual(candidate.coverage.owners[0].events, options.coverage.owners[0].events);
  assert.deepEqual(
    candidate.coverage.owners[0].domain['public.restore_race_deletion_replay_receipt'],
    options.coverage.owners[0].domain['public.restore_race_deletion_replay_receipt'],
  );
  const tampered = clone(candidate);
  tampered.coverage.owners[0].events.race_result_deleted = 2;
  assert.throws(() => verifyBaselineAnchorCandidate(tampered, options));
});

test('older coverage schema2 cannot establish a current race deletion baseline', () => {
  for (const owners of [['owner-a'], []]) {
    const options = fixture(owners);
    options.coverage.schemaVersion = 2;
    rejects(options);
  }
});

test('missing or malformed v4 race coverage fails closed', () => {
  for (const kind of ['race_event_deleted', 'race_result_deleted', 'training_best_deleted']) {
    const missing = fixture();
    missing.coverage.owners[0].events = Object.fromEntries(
      Object.entries(missing.coverage.owners[0].events).filter(([key]) => key !== kind),
    );
    rejects(missing);
    for (const count of [
      -1,
      0.5,
      Number.MAX_SAFE_INTEGER + 1,
      null,
      '1',
      { targetId: 'private-id' },
    ]) {
      const malformed = fixture();
      malformed.coverage.owners[0].events[kind] = count;
      rejects(malformed);
    }
  }
  for (const table of [
    'public.race_event',
    'public.race_event_revision',
    'public.race_result',
    'public.race_result_revision',
    'public.training_best',
    'public.training_best_revision',
    'public.race_command_receipt',
    'public.race_collection_head',
    'public.restore_race_deletion_replay_receipt',
  ]) {
    const missing = fixture();
    missing.coverage.owners[0].domain = Object.fromEntries(
      Object.entries(missing.coverage.owners[0].domain).filter(([key]) => key !== table),
    );
    rejects(missing);
    const malformed = fixture();
    malformed.coverage.owners[0].domain[table].digest = 'invalid';
    rejects(malformed);
  }
  const unexpected = fixture();
  unexpected.coverage.owners[0].events.race_deleted = 0;
  rejects(unexpected);
});

test('global HealthKit replay receipts stay an explicit gap rather than an owner-scoped domain', () => {
  const options = fixture();
  const candidate = buildBaselineAnchorCandidate(options);
  assert.equal(candidate.complete, false);
  assert.ok(candidate.gaps.includes('HEALTHKIT_GLOBAL_REPLAY_RECEIPTS_NOT_CAPTURED'));
  const misleading = fixture();
  const work = misleading.coverage.owners[0].domain['public.healthkit_deregistration_work'];
  delete misleading.coverage.owners[0].domain['public.healthkit_deregistration_work'];
  misleading.coverage.owners[0].domain['public.restore_healthkit_deregistration_replay_receipt'] =
    work;
  rejects(misleading);
});
