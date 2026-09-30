import { createHash, createHmac } from 'node:crypto';

const KINDS = Object.freeze([
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
]);
const TABLES = Object.freeze([
  'identity_private.account',
  'public.restore_suppression_event',
  'public.tenant_erasure',
  'public.consent',
  'public.coaching_constraint_head',
  'public.coaching_constraint',
  'public.course_share_area_budget',
]);
const DOMAIN_TABLES = Object.freeze([
  'public.course_deletion',
  'public.course',
  'public.activity_canonical',
  'public.activity_source_head',
  'public.activity_suppression',
  'public.resource',
  'public.gallery_media_item',
  'public.check_in',
  'public.resource_share',
  'public.resource_access_audit',
  'public.course_share',
  'public.course_share_audit',
  'public.intake_entry',
  'public.recovery_action_log',
  'public.coaching_constraint',
  'public.course_share_area_budget',
]);
const DOMAIN_ROW_LIMIT = 10_000;
const DOMAIN_BYTE_LIMIT = 32 * 1024 * 1024;
const ROW_BYTE_LIMIT = 2 * 1024 * 1024;
const ROW_BATCH_LIMIT = 8;
const OWNER_LIMIT = 10_000;
const REQUIRED_MIGRATION_VERSION = 93;
const SNAPSHOT = /^[0-9]+:[0-9]+:(?:[0-9]+(?:,[0-9]+)*)?$/;
const LSN = /^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/i;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const SYSTEM_IDENTIFIER = /^[1-9][0-9]{0,19}$/;

function fail() {
  throw new Error('SNAPSHOT_COVERAGE_UNVERIFIED');
}
function rows(result) {
  if (!result || !Array.isArray(result.rows)) fail();
  return result.rows;
}
function one(result) {
  const found = rows(result);
  if (found.length !== 1) fail();
  return found[0];
}
function count(value) {
  if (!/^(0|[1-9][0-9]*)$/.test(String(value)) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER))
    fail();
  return Number(value);
}
function id(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200) fail();
  return value;
}
function tag(key, purpose, ...parts) {
  const hmac = createHmac('sha256', key);
  for (const part of [purpose, ...parts]) {
    const encoded = Buffer.from(part, 'utf8');
    hmac.update(String(encoded.length)).update(':').update(encoded);
  }
  return hmac.digest('hex');
}

/** Hash a sorted, exact catalog description. Its expected value must be pinned outside this DB. */
export function domainSchemaFingerprint(catalog, migrations) {
  if (
    !Array.isArray(catalog) ||
    catalog.length === 0 ||
    !Array.isArray(migrations) ||
    migrations.length !== REQUIRED_MIGRATION_VERSION
  )
    fail();
  for (const [index, row] of migrations.entries()) {
    if (
      row.version !== index + 1 ||
      typeof row.checksum !== 'string' ||
      !/^[a-f0-9]{64}$/.test(row.checksum)
    )
      fail();
  }
  const descriptions = catalog.map((row) => {
    if (
      typeof row.table_name !== 'string' ||
      typeof row.column_name !== 'string' ||
      typeof row.data_type !== 'string' ||
      typeof row.owner_name !== 'string' ||
      typeof row.not_null !== 'boolean' ||
      typeof row.force_rls !== 'boolean' ||
      typeof row.row_security !== 'boolean'
    )
      fail();
    return [
      row.table_name,
      row.column_name,
      row.data_type,
      row.owner_name,
      row.not_null,
      row.force_rls,
      row.row_security,
    ];
  });
  descriptions.sort((a, b) => {
    const left = JSON.stringify(a);
    const right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return createHash('sha256').update(JSON.stringify({ descriptions, migrations })).digest('hex');
}

/**
 * Read-only, in-memory coverage inventory. The caller owns the already imported
 * exported-snapshot transaction and must roll it back after this call. This
 * inventory is not a backup anchor, replay ledger, owner-completeness proof,
 * or permission to restore. expectedOwners is an independently obtained roster.
 * expectedDomainSchemaFingerprint must be pinned independently from the source
 * database: it binds exact catalog columns/RLS/owner and migration 001–093
 * checksums. Captured domain leaves include all current row fields; the result
 * contains HMAC tags, counts, and consent/status summaries but no raw rows.
 * Keep the result private. The inventory rejects oversized owners.
 * expectedSnapshotId is the caller-provided transaction-view identifier; it
 * cannot prove that snapshotName came from the replication slot.
 */
export async function buildSnapshotCoverage({
  client,
  snapshot,
  expectedSnapshotId,
  expectedOwners,
  expectedDomainSchemaFingerprint,
  hmacKey,
}) {
  if (
    !client ||
    typeof client.query !== 'function' ||
    !snapshot ||
    typeof snapshot.snapshotName !== 'string' ||
    !/^[0-9A-F]{8}-[0-9A-F]{8}-[1-9][0-9]*$/i.test(snapshot.snapshotName) ||
    !LSN.test(snapshot.consistentPointLsn) ||
    !IDENTIFIER.test(snapshot.replicationSlot) ||
    !SYSTEM_IDENTIFIER.test(snapshot.postgresSystemIdentifier) ||
    typeof expectedSnapshotId !== 'string' ||
    !SNAPSHOT.test(expectedSnapshotId) ||
    !Array.isArray(expectedOwners) ||
    expectedOwners.length > OWNER_LIMIT ||
    typeof expectedDomainSchemaFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(expectedDomainSchemaFingerprint) ||
    !Buffer.isBuffer(hmacKey) ||
    hmacKey.length !== 32
  )
    fail();
  const expected = expectedOwners.map(id);
  if (new Set(expected).size !== expected.length) fail();
  const state = one(
    await client.query(`SELECT current_user AS current_role, session_user AS session_role,
    current_setting('transaction_isolation') AS isolation,
    current_setting('transaction_read_only') AS read_only,
    txid_current_snapshot()::text AS snapshot_id`),
  );
  if (
    state.current_role !== state.session_role ||
    state.isolation !== 'repeatable read' ||
    state.read_only !== 'on' ||
    state.snapshot_id !== expectedSnapshotId
  )
    fail();
  const catalog = rows(
    await client.query(
      `SELECT n.nspname||'.'||c.relname AS table_name,
    a.attname AS column_name, pg_catalog.format_type(a.atttypid,a.atttypmod) AS data_type,
    pg_catalog.pg_get_userbyid(c.relowner) AS owner_name,
    a.attnotnull AS not_null, c.relforcerowsecurity AS force_rls,
    c.relrowsecurity AS row_security
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname||'.'||c.relname=ANY($1::text[]) AND c.relkind='r'`,
      [DOMAIN_TABLES],
    ),
  );
  const migrations = rows(
    await client.query('SELECT version,checksum FROM public.schema_migrations ORDER BY version'),
  );
  if (
    catalog.length > 1_600 ||
    new Set(catalog.map((row) => row.table_name)).size !== DOMAIN_TABLES.length ||
    new Set(catalog.map((row) => `${row.table_name}.${row.column_name}`)).size !== catalog.length ||
    catalog.some(
      (row) =>
        !DOMAIN_TABLES.includes(row.table_name) ||
        row.owner_name !== state.current_role ||
        row.force_rls !== true ||
        row.row_security !== true,
    ) ||
    domainSchemaFingerprint(catalog, migrations) !== expectedDomainSchemaFingerprint
  )
    fail();
  const role = one(
    await client.query(
      `SELECT rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=current_user`,
    ),
  );
  if (role.rolsuper !== false || role.rolbypassrls !== false) fail();
  const ownership = rows(
    await client.query(
      `SELECT n.nspname||'.'||c.relname AS table_name,
      pg_catalog.pg_get_userbyid(c.relowner) AS owner_name
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname||'.'||c.relname = ANY($1::text[]) AND c.relkind='r'`,
      [TABLES],
    ),
  );
  if (
    ownership.length !== TABLES.length ||
    new Set(ownership.map((row) => row.table_name)).size !== TABLES.length ||
    ownership.some(
      (row) => !TABLES.includes(row.table_name) || row.owner_name !== state.current_role,
    )
  )
    fail();

  // This all-owner event query is possible only under the migration-owner-only
  // RLS policy. The explicit roster comparison rejects a silent owner omission.
  // tenant_erasure has tenant FORCE RLS, so a global scan would silently hide
  // other owners. An independent roster must include any pre-event erasures.
  const discovered = rows(
    await client.query(
      `SELECT athlete_id FROM (
      SELECT athlete_id::text AS athlete_id FROM identity_private.account
      UNION SELECT athlete_id FROM public.restore_suppression_event
    ) discovered_owners LIMIT $1`,
      [OWNER_LIMIT + 1],
    ),
  ).map((row) => id(row.athlete_id));
  if (
    discovered.length > OWNER_LIMIT ||
    new Set(discovered).size !== discovered.length ||
    discovered.length !== expected.length ||
    discovered.some((owner) => !expected.includes(owner))
  )
    fail();

  const owners = [];
  for (const owner of [...expected].sort()) {
    const scope = one(
      await client.query(`SELECT pg_catalog.set_config('app.athlete_id',$1,true) AS scoped`, [
        owner,
      ]),
    );
    if (scope.scoped !== owner) fail();
    const domain = {};
    let totalRows = 0;
    let totalBytes = 0;
    for (const table of DOMAIN_TABLES) {
      // Fixed allowlisted table and cursor names. The owner was set with a bound
      // value above; the explicit predicate also blocks grantee-only RLS rows.
      // PostgreSQL suppresses an oversized row before it crosses the wire.
      const leaves = [];
      let opened = false;
      try {
        await client.query(`DECLARE workout_snapshot_domain_cursor NO SCROLL CURSOR FOR
          SELECT CASE WHEN octet_length(to_jsonb(t)::text) <= ${ROW_BYTE_LIMIT}
            THEN to_jsonb(t)::text ELSE NULL END AS row_json
          FROM ${table} t
          WHERE athlete_id=nullif(current_setting('app.athlete_id',true),'')`);
        opened = true;
        while (true) {
          const batch = rows(
            await client.query(
              `FETCH FORWARD ${ROW_BATCH_LIMIT} FROM workout_snapshot_domain_cursor`,
            ),
          );
          if (batch.length > ROW_BATCH_LIMIT) fail();
          totalRows += batch.length;
          if (totalRows > DOMAIN_ROW_LIMIT) fail();
          for (const row of batch) {
            if (typeof row.row_json !== 'string') fail();
            const bytes = Buffer.byteLength(row.row_json);
            totalBytes += bytes;
            if (bytes > ROW_BYTE_LIMIT || totalBytes > DOMAIN_BYTE_LIMIT) fail();
            leaves.push(tag(hmacKey, 'domain-row-v1', owner, table, row.row_json));
          }
          if (batch.length === 0) break;
        }
      } finally {
        if (opened) await client.query('CLOSE workout_snapshot_domain_cursor');
      }
      leaves.sort();
      domain[table] = {
        count: leaves.length,
        digest: tag(
          hmacKey,
          'domain-table-v1',
          expectedDomainSchemaFingerprint,
          owner,
          table,
          ...leaves,
        ),
      };
    }
    const eventRows = rows(
      await client.query(
        `SELECT kind, record_version, count(*)::text AS total
      FROM public.restore_suppression_event WHERE athlete_id=$1 GROUP BY kind,record_version`,
        [owner],
      ),
    );
    const events = Object.fromEntries(KINDS.map((kind) => [kind, 0]));
    const seenKinds = new Set();
    for (const row of eventRows) {
      const allowedVersion = [
        'intake_entry_deleted',
        'recovery_action_deleted',
        'resource_share_revoked',
        'course_share_revoked',
      ].includes(row.kind)
        ? row.record_version === 1 || row.record_version === 2
        : row.record_version === 1;
      if (
        !KINDS.includes(row.kind) ||
        !allowedVersion ||
        seenKinds.has(`${row.kind}:${row.record_version}`)
      )
        fail();
      seenKinds.add(`${row.kind}:${row.record_version}`);
      events[row.kind] += count(row.total);
    }
    const consentRows = rows(
      await client.query(
        `SELECT kind, granted, revision FROM public.consent
      WHERE athlete_id=$1 AND kind IN ('ai','healthkit')`,
        [owner],
      ),
    );
    const consent = { ai: { state: 'absent' }, healthkit: { state: 'absent' } };
    for (const row of consentRows) {
      if (
        !Object.hasOwn(consent, row.kind) ||
        consent[row.kind].state !== 'absent' ||
        typeof row.granted !== 'boolean' ||
        !Number.isSafeInteger(row.revision) ||
        row.revision < 1
      )
        fail();
      consent[row.kind] = { state: 'present', granted: row.granted, revision: row.revision };
    }
    const erased = one(
      await client.query(
        `SELECT count(*)::text AS total FROM public.tenant_erasure WHERE athlete_id=$1`,
        [owner],
      ),
    );
    const headRows = rows(
      await client.query(
        `SELECT revision FROM public.coaching_constraint_head WHERE athlete_id=$1`,
        [owner],
      ),
    );
    if (headRows.length > 1) fail();
    const head =
      headRows.length === 0
        ? { state: 'absent' }
        : { state: 'present', revision: headRows[0].revision };
    if (head.state === 'present' && (!Number.isSafeInteger(head.revision) || head.revision < 1))
      fail();
    const constraints = one(
      await client.query(
        `SELECT count(*)::text AS total,
      count(*) FILTER (WHERE deleted)::text AS tombstones
      FROM public.coaching_constraint WHERE athlete_id=$1`,
        [owner],
      ),
    );
    const budget = one(
      await client.query(
        `SELECT count(*)::text AS total,
      coalesce(sum(links_cut),0)::text AS links_cut
      FROM public.course_share_area_budget WHERE athlete_id=$1`,
        [owner],
      ),
    );
    const erasureCount = count(erased.total);
    if (erasureCount > 1 || erasureCount !== events.tenant_erased) fail();
    const constraintTotal = count(constraints.total),
      tombstones = count(constraints.tombstones);
    if (tombstones > constraintTotal || (head.state === 'absent' && constraintTotal !== 0)) fail();
    owners.push({
      ownerTag: tag(hmacKey, 'owner-v1', owner),
      domain,
      events,
      consent,
      erasure: erasureCount === 1 ? 'present' : 'absent',
      coaching: { head, total: constraintTotal, tombstones },
      courseShareAreaBudget: { rows: count(budget.total), linksCut: count(budget.links_cut) },
    });
  }
  return {
    schemaVersion: 2,
    domainSchemaFingerprint: expectedDomainSchemaFingerprint,
    snapshot: {
      snapshotName: snapshot.snapshotName,
      snapshotId: expectedSnapshotId,
      consistentPointLsn: snapshot.consistentPointLsn,
      postgresSystemIdentifier: snapshot.postgresSystemIdentifier,
      replicationSlot: snapshot.replicationSlot,
    },
    owners,
    complete: false,
    gaps: [
      'SNAPSHOT_BINDING_NOT_INDEPENDENTLY_VERIFIED',
      'OWNER_ROSTER_NOT_INDEPENDENTLY_PROVEN',
      'PRE_EVENT_ERASURE_OWNER_NOT_DISCOVERABLE',
      'PRE_EVENT_HISTORY_NOT_RECONSTRUCTIBLE',
      'HEALTHKIT_RAW_ONLY_DELETION_NOT_COVERED',
      'SHARE_EPOCH_OUTSIDE_DATABASE',
      'POST_SNAPSHOT_TAIL_NOT_WITNESSED',
      'DOMAIN_HEADS_NOT_FULLY_CAPTURED',
      'DOMAIN_SCHEMA_FINGERPRINT_NOT_INDEPENDENTLY_VERIFIED',
    ],
  };
}
