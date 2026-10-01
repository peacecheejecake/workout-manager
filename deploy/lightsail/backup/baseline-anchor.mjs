import { createHmac, timingSafeEqual } from 'node:crypto';

const HASH = /^[a-f0-9]{64}$/;
const EVENT_KINDS = [
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
const SYSTEM_ID = /^[1-9][0-9]{0,19}$/;
const SLOT = /^[a-z_][a-z0-9_]{0,62}$/;
const SNAPSHOT = /^[0-9A-F]{8}-[0-9A-F]{8}-[1-9][0-9]*$/i;
const LSN = /^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/i;
const DOMAIN_TABLES = [
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
const REQUIRED_GAPS = [
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
const ANCHOR_GAPS = [
  'REMOTE_DURABILITY_NOT_INDEPENDENTLY_PROVEN',
  'EARLIER_ERASURES_NOT_PROVEN',
  'FINAL_TAIL_NOT_PROVEN',
  'PUBLICATION_DEFINITION_NOT_INDEPENDENTLY_PROVEN',
  'RESTORE_REPLAY_NOT_VERIFIED',
];

function fail() {
  throw new Error('BASELINE_ANCHOR_CANDIDATE_UNVERIFIED');
}
function object(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
  )
    fail();
  return value;
}
function string(value, pattern, max = 200) {
  if (typeof value !== 'string' || value.length > max || !pattern.test(value)) fail();
  return value;
}
function count(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100_000_000) fail();
}
function keyCheck(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) fail();
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function bounded(value, depth = 0) {
  if (depth > 8) fail();
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > 512) fail();
    return;
  }
  if (typeof value === 'number') {
    count(value);
    return;
  }
  if (typeof value === 'boolean' || value === null) return;
  if (Array.isArray(value)) {
    if (value.length > 10_000) fail();
    value.forEach((entry) => bounded(entry, depth + 1));
    return;
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length > 64
  )
    fail();
  for (const [name, entry] of Object.entries(value)) {
    if (name.length > 100 || name === '__proto__' || name === 'constructor') fail();
    bounded(entry, depth + 1);
  }
}
function tag(key, owner) {
  const hmac = createHmac('sha256', key);
  for (const part of ['owner-v1', owner]) {
    const bytes = Buffer.from(part, 'utf8');
    hmac.update(String(bytes.length)).update(':').update(bytes);
  }
  return hmac.digest('hex');
}
function identity(snapshot) {
  object(snapshot, [
    'snapshotName',
    'consistentPointLsn',
    'postgresSystemIdentifier',
    'replicationSlot',
    'publication',
  ]);
  string(snapshot.snapshotName, SNAPSHOT, 100);
  string(snapshot.consistentPointLsn, LSN, 17);
  string(snapshot.postgresSystemIdentifier, SYSTEM_ID, 20);
  if (BigInt(snapshot.postgresSystemIdentifier) > 18_446_744_073_709_551_615n) fail();
  string(snapshot.replicationSlot, SLOT, 63);
  string(snapshot.publication, SLOT, 63);
  return snapshot;
}
function archives(value) {
  object(value, ['manifest', 'database', 'privateFiles']);
  if (!Array.isArray(value.privateFiles) || value.privateFiles.length > 10_000) fail();
  const seen = new Set();
  for (const file of [value.manifest, value.database, ...value.privateFiles]) {
    object(file, ['path', 'sha256', 'versionId']);
    string(file.path, /^(?:manifest\.json|database\.dump|private\/[A-Za-z0-9._/-]+)$/, 512);
    if (
      file.path.split('/').some((part) => part === '..' || part === '.' || !part) ||
      seen.has(file.path)
    )
      fail();
    seen.add(file.path);
    string(file.sha256, HASH, 64);
    string(file.versionId, /^[A-Za-z0-9._~+=/-]{1,256}$/, 256);
  }
  if (
    value.manifest.path !== 'manifest.json' ||
    value.database.path !== 'database.dump' ||
    value.privateFiles.some((file) => !file.path.startsWith('private/'))
  )
    fail();
  return {
    manifest: value.manifest,
    database: value.database,
    privateFiles: [...value.privateFiles].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ),
  };
}
function remoteLocation(value) {
  object(value, ['bucket', 'prefix', 'region', 'expectedBucketOwner', 'completionVersionId']);
  string(value.bucket, /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 63);
  string(value.prefix, /^[A-Za-z0-9._~/-]{1,512}$/, 512);
  if (
    value.prefix.endsWith('/') ||
    value.prefix.split('/').some((part) => !part || part === '.' || part === '..') ||
    value.region !== 'ap-northeast-2'
  )
    fail();
  string(value.expectedBucketOwner, /^[0-9]{12}$/, 12);
  string(value.completionVersionId, /^[A-Za-z0-9._~+=/-]{1,256}$/, 256);
  return value;
}
function owners(expectedOwners, key) {
  if (!Array.isArray(expectedOwners) || expectedOwners.length > 10_000) fail();
  const ids = expectedOwners.map((owner) => {
    string(owner, /^.{1,200}$/s, 200);
    if (
      [...owner].some(
        (character) => character.codePointAt(0) <= 31 || character.codePointAt(0) === 127,
      )
    )
      fail();
    return owner;
  });
  if (new Set(ids).size !== ids.length) fail();
  return ids.map((owner) => tag(key, owner)).sort();
}
function coverageCheck(coverage, snapshot, expectedTags, fingerprint) {
  bounded(coverage);
  if (Buffer.byteLength(canonical(coverage)) > 8 * 1024 * 1024) fail();
  object(coverage, [
    'schemaVersion',
    'domainSchemaFingerprint',
    'snapshot',
    'owners',
    'complete',
    'gaps',
  ]);
  if (
    coverage.schemaVersion !== 2 ||
    coverage.complete !== false ||
    coverage.domainSchemaFingerprint !== fingerprint
  )
    fail();
  object(coverage.snapshot, [
    'snapshotName',
    'snapshotId',
    'consistentPointLsn',
    'postgresSystemIdentifier',
    'replicationSlot',
  ]);
  string(coverage.snapshot.snapshotId, /^[0-9]+:[0-9]+:(?:[0-9]+(?:,[0-9]+)*)?$/, 256);
  for (const name of [
    'snapshotName',
    'consistentPointLsn',
    'postgresSystemIdentifier',
    'replicationSlot',
  ])
    if (coverage.snapshot[name] !== snapshot[name]) fail();
  if (!Array.isArray(coverage.owners) || coverage.owners.length !== expectedTags.length) fail();
  const tags = [];
  for (const owner of coverage.owners) {
    object(owner, [
      'ownerTag',
      'domain',
      'events',
      'consent',
      'erasure',
      'coaching',
      'courseShareAreaBudget',
    ]);
    string(owner.ownerTag, HASH, 64);
    tags.push(owner.ownerTag);
    if (owner.erasure !== 'present' && owner.erasure !== 'absent') fail();
    object(owner.events, EVENT_KINDS);
    for (const kind of EVENT_KINDS) count(owner.events[kind]);
    if (
      owner.events.tenant_erased > 1 ||
      (owner.erasure === 'present') !== (owner.events.tenant_erased === 1)
    )
      fail();
    object(owner.consent, ['ai', 'healthkit']);
    for (const consent of Object.values(owner.consent)) {
      if (consent?.state === 'absent') object(consent, ['state']);
      else {
        object(consent, ['state', 'granted', 'revision']);
        if (consent.state !== 'present' || typeof consent.granted !== 'boolean') fail();
        count(consent.revision);
        if (consent.revision === 0) fail();
      }
    }
    object(owner.coaching, ['head', 'total', 'tombstones']);
    if (owner.coaching.head?.state === 'absent') object(owner.coaching.head, ['state']);
    else {
      object(owner.coaching.head, ['state', 'revision']);
      if (owner.coaching.head.state !== 'present') fail();
      count(owner.coaching.head.revision);
      if (owner.coaching.head.revision === 0) fail();
    }
    count(owner.coaching.total);
    count(owner.coaching.tombstones);
    if (
      owner.coaching.tombstones > owner.coaching.total ||
      (owner.coaching.head.state === 'absent' && owner.coaching.total !== 0)
    )
      fail();
    object(owner.courseShareAreaBudget, ['rows', 'linksCut']);
    count(owner.courseShareAreaBudget.rows);
    count(owner.courseShareAreaBudget.linksCut);
    object(owner.domain, DOMAIN_TABLES);
    for (const table of DOMAIN_TABLES) {
      object(owner.domain[table], ['count', 'digest']);
      count(owner.domain[table].count);
      string(owner.domain[table].digest, HASH, 64);
    }
  }
  if (new Set(tags).size !== tags.length || canonical(tags.sort()) !== canonical(expectedTags))
    fail();
  if (
    !Array.isArray(coverage.gaps) ||
    coverage.gaps.length > 32 ||
    coverage.gaps.some((gap) => typeof gap !== 'string' || !/^[A-Z_]{3,100}$/.test(gap)) ||
    new Set(coverage.gaps).size !== coverage.gaps.length ||
    REQUIRED_GAPS.some((gap) => !coverage.gaps.includes(gap))
  )
    fail();
}
function input(options) {
  object(options, [
    'backupId',
    'snapshot',
    'archives',
    'remote',
    'coverage',
    'expectedOwners',
    'expectedDomainSchemaFingerprint',
    'expectedPublication',
    'coverageHmacKey',
    'anchorHmacKey',
  ]);
  keyCheck(options.coverageHmacKey);
  keyCheck(options.anchorHmacKey);
  if (timingSafeEqual(options.coverageHmacKey, options.anchorHmacKey)) fail();
  string(options.backupId, /^backup-[A-Za-z0-9-]{1,120}$/, 127);
  const snapshot = identity(options.snapshot);
  if (options.expectedPublication !== snapshot.publication) fail();
  const archiveSet = archives(options.archives);
  const remote = remoteLocation(options.remote);
  string(options.expectedDomainSchemaFingerprint, HASH, 64);
  const tags = owners(options.expectedOwners, options.coverageHmacKey);
  coverageCheck(options.coverage, snapshot, tags, options.expectedDomainSchemaFingerprint);
  return {
    backupId: options.backupId,
    snapshot,
    archives: archiveSet,
    remote,
    coverage: options.coverage,
    expectedOwnerTags: tags,
    domainSchemaFingerprint: options.expectedDomainSchemaFingerprint,
  };
}

/** Authenticated, offline candidate only. Its inputs are assertions supplied by the caller. */
export function buildBaselineAnchorCandidate(options) {
  // Detach every nested value before signing so a caller cannot mutate the
  // returned candidate through references retained from the input.
  const payload = JSON.parse(canonical(input(options)));
  const candidate = {
    kind: 'baseline-anchor-candidate',
    schemaVersion: 1,
    ...payload,
    complete: false,
    restoreAccessAllowed: false,
    gaps: [...new Set([...payload.coverage.gaps, ...ANCHOR_GAPS])].sort(),
  };
  const authentication = createHmac('sha256', options.anchorHmacKey)
    .update('baseline-anchor-candidate-v1\0')
    .update(canonical(candidate))
    .digest('hex');
  return { ...candidate, authentication };
}

/** Rebuild from independently supplied expectations, then compare all authenticated bytes. */
export function verifyBaselineAnchorCandidate(candidate, options) {
  bounded(candidate);
  if (Buffer.byteLength(canonical(candidate)) > 8 * 1024 * 1024) fail();
  object(candidate, [
    'kind',
    'schemaVersion',
    'backupId',
    'snapshot',
    'archives',
    'remote',
    'coverage',
    'expectedOwnerTags',
    'domainSchemaFingerprint',
    'complete',
    'restoreAccessAllowed',
    'gaps',
    'authentication',
  ]);
  string(candidate.authentication, HASH, 64);
  const expected = buildBaselineAnchorCandidate(options);
  const supplied = Buffer.from(candidate.authentication, 'hex');
  const correct = Buffer.from(expected.authentication, 'hex');
  if (!timingSafeEqual(supplied, correct) || canonical(candidate) !== canonical(expected)) fail();
  return true;
}
