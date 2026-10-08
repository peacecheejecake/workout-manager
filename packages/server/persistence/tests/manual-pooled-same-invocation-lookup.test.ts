import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
const sql = await readFile(
  new URL('../migrations/140_manual_pooled_same_invocation_lookup.sql', import.meta.url),
  'utf8',
);
const resolver = await readFile(
  new URL('../migrations/134_manual_pooled_preparation_resolver.sql', import.meta.url),
  'utf8',
);
const body = resolver.match(
  /CREATE FUNCTION wm_manual_pooled\.lookup\([\s\S]*? AS \$\$([\s\S]*?)\$\$;/,
)?.[1];
if (body === undefined) throw Error('LOOKUP_BODY_REQUIRED');
it('pins actual installed final20 predecessors and preserves separate historical artifacts', () => {
  expect(sql).toContain('830f10e9befa324823d2a1ff8dd45b151bf30d78f5230b235419846c97877695');
  expect(sql).toContain('5f6c32e3b0e719d738650a3333ee17f827840ab6957bb2c04af7d7bc662e8f9e');
  expect(sql).toContain('2ea13f35abf5773a7f5b6c267127ad500fbc021e73f8506bf180ecbc2313e2d8');
  expect(sql).toContain(createHash('sha256').update(body).digest('hex'));
  const roster = sql
    .split(') pins(signature,body_sha')[0]
    ?.split('FOR dependency IN SELECT * FROM (VALUES')[1];
  expect(roster?.match(/\('[^']+\([^']*\)','[a-f0-9]{64}'/g)).toHaveLength(20);
});
it('helper transformation changes only validation to owner guard and explanatory comment', () => {
  const originalCheck = 'PERFORM wm_manual_pooled.check_encoded(e);';
  expect(body.split(originalCheck)).toHaveLength(2);
  const derived = body
    .replace(originalCheck, 'PERFORM wm_manual_pooled.assert_owner();')
    .replace(
      '-- This helper repeats validation per call; no unchecked caller cached handle exists.',
      '-- Owner-private: authoritative caller checked this immutable input in this invocation.',
    );
  expect(derived).not.toContain('check_encoded');
  expect(
    derived
      .replace('PERFORM wm_manual_pooled.assert_owner();', originalCheck)
      .replace(
        '-- Owner-private: authoritative caller checked this immutable input in this invocation.',
        '-- This helper repeats validation per call; no unchecked caller cached handle exists.',
      ),
  ).toBe(body);
  for (const expression of [
    'raw_bytes+delta>4194304',
    'POOLED_SIZE_CORRESPONDENCE',
    'jsonb_set(result,relative_parts',
    'at_exact(pool_row',
    'path_parts(path,true)',
  ])
    expect(derived).toContain(expression);
});
it('patches only three lookup sites per immutable encoded argument and retains one full check', () => {
  expect(sql).toContain("')<>3");
  expect(sql).toContain("');')<>1");
  expect(sql).toContain("target.encoded_arg||'[[:space:]]*(:=|=)'");
  expect(sql).toContain('POOLED_LOCAL_PATCH_RESIDUAL');
  expect(sql).not.toMatch(/statement_timeout|SET ROLE|set_config|CREATE TABLE|GRANT EXECUTE/);
});
it('owner-only atomic installation preserves exact old helper and public OID metadata', () => {
  expect(sql.match(/DO \$migration\$/g)).toHaveLength(1);
  expect(sql).toContain("(to_jsonb(observed)-'prosrc') IS DISTINCT FROM (before_meta-'prosrc')");
  expect(sql).toContain(
    'REVOKE ALL ON FUNCTION wm_manual_pooled.lookup_validated_local(jsonb,text) FROM PUBLIC',
  );
  expect(sql).toContain('a.is_grantable OR dependency.private_helper');
  expect(sql).toContain('original.proparallel');
  expect(sql).toContain('POOLED_LOCAL_ALREADY_INSTALLED');
  expect(sql).not.toMatch(/EXCEPTION WHEN/);
});
