import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
const sql = await readFile(
  new URL('../migrations/141_manual_pooled_application_local_validation.sql', import.meta.url),
  'utf8',
);
const pins = sql
  .split(') pins(signature,body_sha')[0]
  ?.split('FOR dependency IN SELECT * FROM (VALUES')[1];
it('pins all21 actual post140 roots including source and portable metadata', () => {
  expect(pins?.match(/\('[^']+\([^']*\)','[a-f0-9]{64}'/g)).toHaveLength(21);
  for (const hash of [
    '4905aa0e9e7d03f3fb2115d55c88e4df7816218ea8e8daa9fdddc43ca9e73616',
    '3882a6343dc94adce6a55c56a1216bc171e5cca073175ce7768d0a2bfac67cec',
    'e73e22bd95a6fbaf9d4e07d39c38ed1da71a11a486d121a955b1d58f2e30c470',
    'd1b54a97a1c3474d8d5c416dc9bdaeb2337eadac91bcd2830c24e7d0028e83c7',
    '9af916337f6a2f31ded78ab541b320245947ec3e38900d77cf05ecc8380d0527',
  ])
    expect(sql).toContain(hash);
  for (const attribute of [
    'prokind',
    'proisstrict',
    'proleakproof',
    'proparallel',
    'prorettype',
    'proconfig',
    'proargdefaults',
    'prosupport',
    'provariadic',
  ])
    expect(pins).toContain(attribute);
});
it('compares owner, actual namespace, language, result, complete portable attrs and ACL before DDL', () => {
  for (const condition of [
    'original.proowner<>owner_oid',
    'original.pronamespace<>',
    'original.prolang<>',
    'pg_get_function_result(original.oid)<>',
    'a.grantee=0',
    'a.is_grantable OR dependency.private_helper',
  ])
    expect(sql).toContain(condition);
  expect(sql.indexOf('POOLED_APPLICATION_LOCAL_PREDECESSOR_DRIFT')).toBeLessThan(
    sql.indexOf('EXECUTE definition;'),
  );
});
it('creates exactly3 owner-private variants preserving explicit INVOKER metadata difference', () => {
  expect(sql.match(/REVOKE ALL ON FUNCTION wm_manual_pooled\./g)).toHaveLength(3);
  expect(
    sql.match(/definition:=replace\(definition,'SECURITY DEFINER','SECURITY INVOKER'\)/g),
  ).toHaveLength(3);
  expect(sql.match(/PERFORM wm_manual_pooled.assert_owner\(\);/g)).toHaveLength(3);
  expect(sql).toContain("ARRAY['oid','proname','prosrc','proacl','pronamespace','prosecdef']");
  expect(sql).toContain('observed.prosecdef OR observed.pronamespace');
});
it('keeps public helper3 unchanged and authoritative OIDs, metadata and ACL exact', () => {
  expect(sql.match(/oid='public\.(prepare|begin)_race_manual_pooled_application_v1/g)).toHaveLength(
    2,
  );
  expect(sql).toContain("(to_jsonb(observed)-'prosrc') IS DISTINCT FROM (before_meta-'prosrc')");
  expect(sql).toContain('after_roster IS DISTINCT FROM before_roster');
  expect(sql).not.toMatch(
    /ALTER TABLE|CREATE TABLE|DROP FUNCTION|GRANT EXECUTE|statement_timeout|EXCEPTION WHEN|set_config/,
  );
});
it('preserves basis validation before private recipes for prepare and begin', () => {
  expect(sql).toContain(
    "position('public.validate_race_manual_pooled_application_basis_v1($3,$2,$4)' IN expected_body)>position('wm_manual_pooled.validate_recipes_validated_local_v1(' IN expected_body)",
  );
  expect(sql.match(/POOLED_APPLICATION_LOCAL_MUTABLE_INPUT/g)).toHaveLength(2);
  expect(sql.match(/POOLED_APPLICATION_LOCAL_VALIDATION_ORDER/g)).toHaveLength(2);
});
it('moves parent check before first lookup without assuming current and stored parent equal', () => {
  expect(sql).toContain('POOLED_APPLICATION_LOCAL_PARENT_VALIDATION_ORDER');
  expect(sql).toContain('THEN PERFORM wm_manual_pooled.check_encoded(parent.payload); END IF;');
  expect(sql).toContain(
    "('THEN PERFORM wm_manual_pooled.check_encoded(parent.payload); old_context:=','THEN old_context:=',1)",
  );
  expect(sql).toContain(
    "position('PERFORM wm_manual_pooled.check_encoded(parent.payload);' IN expected_body)>position('wm_manual_pooled.lookup_validated_local(parent.payload,' IN expected_body)",
  );
});
it('only substitutes counted immutable lookup/callee sites and never patches current source verification', () => {
  expect(sql.match(/replacement.expected_count/g)).toHaveLength(5);
  expect(sql.match(/EXECUTE replace\(definition,original.prosrc,expected_body\)/g)).toHaveLength(2);
  expect(sql).not.toContain("oid='public.validate_race_manual_pooled_application_basis_v1");
  expect(sql).not.toContain('RETURNS');
  expect(sql).not.toMatch(/new_version|expires|ttl|temp table/i);
});
it('preserves subtree preflight by consuming actual pinned140 helper rather than replacing it', () => {
  expect(sql).toContain('wm_manual_pooled.lookup_validated_local(retained,');
  expect(sql).toContain('wm_manual_pooled.lookup_validated_local(parent.payload,');
  expect(sql).not.toContain('jsonb_set(');
  expect(sql).not.toContain('4194305');
});
it('owner/session and private roster reject unsafe, repeated, partial and unknown installations', () => {
  expect(sql).toContain('current_user<>session_user');
  expect(sql).toContain('rolsuper OR rolbypassrls');
  expect(sql).toContain('POOLED_APPLICATION_LOCAL_ALREADY_INSTALLED');
  expect(sql).toContain('POOLED_APPLICATION_LOCAL_PRIVATE_ROSTER_INVALID');
  expect(sql.match(/DO \$migration\$/g)).toHaveLength(1);
  expect(sql).not.toContain('COMMIT');
});

it('fixture keeps real public RPC symbols distinct from isolated DB prefix', async () => {
  const fixture = await readFile(
    new URL('./manual-pooled-application-local-validation.integration.test.ts', import.meta.url),
    'utf8',
  );
  expect(fixture).not.toContain('race_manual_pooled_application_local141_v1');
  expect(fixture).toContain('SELECT public.prepare_race_manual_pooled_application_v1(');
  expect(fixture).toContain('SELECT public.begin_race_manual_pooled_application_v1(');
  expect(fixture).toContain(
    "grantCurrentRuntimeAppBaselineV2(url(ownerRole), runtimeRole, 'core')",
  );
});
