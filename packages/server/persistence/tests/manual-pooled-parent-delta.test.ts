import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
const sql = await readFile(
  new URL('../migrations/142_manual_pooled_parent_delta.sql', import.meta.url),
  'utf8',
);
it('pins all24 actual post141 roots plus independent baseline guard4 source bodies and portable metadata before new DDL', () => {
  const pins = sql
    .split(') pins(signature,body_sha')[0]
    ?.split('FOR dependency IN SELECT * FROM (VALUES')[1];
  expect(pins?.match(/\('[^']+\([^']*\)','[a-f0-9]{64}'/g)).toHaveLength(28);
  for (const key of [
    'prokind',
    'proisstrict',
    'proleakproof',
    'proparallel',
    'prorettype',
    'proargtypes',
    'proargdefaults',
    'provariadic',
    'proconfig',
  ])
    expect(pins).toContain(key);
  expect(sql).toContain('0d1a47a090572a9da1525ec0e17b52b42a1955d2d0aa4ff247a093a5decf449e');
  expect(sql.indexOf('POOLED_PARENT_DELTA_PREDECESSOR_DRIFT')).toBeLessThan(
    sql.indexOf("EXECUTE 'CREATE FUNCTION"),
  );
});
it('creates only new reader and owner-private helper atomically without changing old symbols/ACL/tables', () => {
  expect(sql.match(/EXECUTE 'CREATE FUNCTION/g)).toHaveLength(2);
  expect(sql).not.toMatch(
    /CREATE OR REPLACE|ALTER TABLE|DROP FUNCTION|GRANT EXECUTE|statement_timeout|EXCEPTION WHEN|set_config/,
  );
  expect(sql).toContain('before_roster IS DISTINCT FROM after_roster');
  expect(sql.match(/REVOKE ALL ON FUNCTION/g)).toHaveLength(2);
  expect(sql).toContain('SECURITY INVOKER');
  expect(sql).toContain('PERFORM wm_manual_pooled.assert_owner();');
  expect(sql).toContain('SECURITY DEFINER');
  expect(sql).toContain('a.grantee<>owner_oid AND (a.is_grantable OR dependency.private_helper)');
});
it('preserves current caller/snapshot/fences, exact owned parent/receipt and erasure guard', () => {
  for (const token of [
    'PERFORM public.assert_manual_race_v2_caller();',
    "('repeatable read','serializable')",
    'public.assert_manual_review_global_lock();',
    'public.assert_manual_review_lifecycle_lock(t);',
    'pg_advisory_xact_lock(hashtextextended(t,0))',
    'e.athlete_id=t AND e.id=$1',
    'r.athlete_id=e.athlete_id AND r.evidence_id=e.id',
    'public.tenant_erasure',
  ])
    expect(sql).toContain(token);
});
it('fully checks fresh dictionary and stored parent independently before recursion', () => {
  expect(sql).toContain('PERFORM wm_manual_pooled.check_encoded($2);');
  expect(sql).toContain('PERFORM wm_manual_pooled.check_encoded(parent.payload);');
  expect(sql.indexOf('PERFORM wm_manual_pooled.check_encoded(parent.payload);')).toBeLessThan(
    sql.indexOf('delta:=wm_manual_pooled.parent_delta_node_v1'),
  );
  expect(sql).toContain('POOLED_CHAIN_READ_ENCODING');
  expect(sql).toContain("'payloadEncoding',NULL,'baseDigestMethod',NULL");
  expect(sql).toContain("'delta',NULL,'deltaNodes',0");
  expect(sql).not.toContain('app_consent');
});
it('uses same-position JSONB equality only and exact structural key/array roster, with immutable cap', () => {
  for (const token of [
    'IF $1=$2 THEN',
    'keys_base IS NOT DISTINCT FROM keys_parent',
    'jsonb_array_length($1)=jsonb_array_length($2)',
    '$1->i,$2->i',
    '$1->k,$2->k',
    '$3>64',
    '$4>5000',
    '>4194304',
    "'postgres-jsonb-v1'",
  ])
    expect(sql).toContain(token);
  expect(sql).not.toMatch(/jsonb_set|sourceId.*JOIN|temporary table|cache|ttl/i);
});

it('pins independent actual guard4 and enforces their owner-only ACL and stable metadata', () => {
  expect(sql).toContain('21b2c7936ddc918bcaf44a228eef0809c4b0a5695002995c80e9e9433b331625');
  for (const signature of [
    'public.assert_manual_race_v2_caller()',
    'public.manual_race_v2_assert_json_bound(jsonb)',
    'public.assert_manual_review_global_lock()',
    'public.assert_manual_review_lifecycle_lock(text)',
  ])
    expect(sql).toContain("('" + signature + "'");
});
