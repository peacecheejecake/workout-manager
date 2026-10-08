import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
const sql = await readFile(
  new URL('../migrations/135_manual_pooled_store_and_basis.sql', import.meta.url),
  'utf8',
);
const resolver = await readFile(
  new URL('../migrations/134_manual_pooled_preparation_resolver.sql', import.meta.url),
  'utf8',
);
it('pins every private resolver actual function body and preserves predecessor guard hashes', () => {
  const bodies = [
    ...resolver.matchAll(
      /CREATE FUNCTION wm_manual_pooled\.([a-z_]+)\([\s\S]*? AS \$\$([\s\S]*?)\$\$;/g,
    ),
  ];
  expect(bodies).toHaveLength(6);
  for (const body of bodies)
    expect(sql).toContain(
      createHash('sha256')
        .update(body[2] ?? '')
        .digest('hex'),
    );
  expect(sql).toContain('cebc600818ea852473d718006ba6f939cf81e7b56c1e7770dbed33f60d7a926b');
  expect(sql).toContain('37af20b64a540ef98c9246e10fe564b2549523615f060d3d76b756b5a675b339');
});
it('only derives two new names and verifies old full metadata unchanged atomically', () => {
  expect((sql.match(/DO \$migration\$/g) ?? []).length).toBe(1);
  expect(sql).toContain('to_jsonb(p) IS DISTINCT FROM to_jsonb(predecessor)');
  expect(sql).toContain('replacement.expected_count');
  expect(sql).toContain('a.is_grantable');
  expect(sql).toContain('REVOKE ALL ON FUNCTION public.store_manual_race_pooled_chain_v1');
  expect(sql).toContain(
    'REVOKE ALL ON FUNCTION public.validate_race_manual_pooled_application_basis_v1',
  );
  expect(sql).not.toMatch(/CREATE TABLE|GRANT EXECUTE|ALTER TABLE|DROP FUNCTION/);
});
it('retains encoded bounds and per-location actual DTO comparison without whole hydration', () => {
  expect(sql).toContain('wm_manual_pooled.check_encoded(');
  expect(sql).toContain("'wm_manual_pooled.lookup('||encoded_arg||',location)'");
  expect(sql).toContain('pooled_context:=wm_manual_pooled.lookup(');
  expect(sql).not.toMatch(/jsonb_set|assert_json_bound\(pooled_|skeleton.*\|\|/);
  expect(sql).toContain("'inner_payload->''preparation''->''context''','pooled_context',2");
});

it('parenthesizes the CASE return-type expression inside the PLpgSQL IF guard', () => {
  expect(sql).toContain('predecessor.prorettype<>(CASE dependency.signature');
  expect(sql).toContain("ELSE 'jsonb'::regtype END)");
  expect(sql).not.toContain('predecessor.prorettype<>CASE');
});
