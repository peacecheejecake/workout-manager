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
      database: { path: 'database.dump', sha256: 'c'.repeat(64), versionId: 'version-db' },
      privateFiles: [
        { path: 'private/photo.bin', sha256: 'd'.repeat(64), versionId: 'version-private' },
      ],
    },
    coverage: {
      schemaVersion: 2,
      domainSchemaFingerprint: fingerprint,
      snapshot: { ...snapshot, snapshotId: '1:2:' },
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
  const unpinned = fixture();
  unpinned.expectedDomainSchemaFingerprint = '';
  rejects(unpinned);
});

test('exact archive digests and opaque remote versions are mandatory', () => {
  for (const kind of ['database', 'private']) {
    for (const field of ['versionId', 'sha256']) {
      const options = fixture();
      const file =
        kind === 'database' ? options.archives.database : options.archives.privateFiles[0];
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
