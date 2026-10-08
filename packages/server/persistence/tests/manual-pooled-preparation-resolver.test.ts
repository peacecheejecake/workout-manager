import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { raceManualReviewPooledDatabaseEnvelopeV1Schema } from '../src/race-manual-review-pooled-database-envelope-v1.js';
const sql = await readFile(
  new URL('../migrations/134_manual_pooled_preparation_resolver.sql', import.meta.url),
  'utf8',
);
it('keeps the resolver a private invoker-only, non-mutation installation', () => {
  const names = [...sql.matchAll(/CREATE FUNCTION wm_manual_pooled\.([a-z_]+)\(/g)].map(
    (m) => m[1],
  );
  expect(names).toEqual([
    'assert_owner',
    'exact_keys',
    'path_parts',
    'at_exact',
    'check_encoded',
    'lookup',
  ]);
  for (const name of names)
    expect(sql).toContain(`REVOKE ALL ON FUNCTION wm_manual_pooled.${name}(`);
  expect(sql).not.toMatch(
    /SECURITY DEFINER|\b(INSERT INTO|UPDATE public|DELETE FROM|GRANT EXECUTE|CREATE TABLE)\b/,
  );
  expect(sql).toContain('REVOKE ALL ON SCHEMA wm_manual_pooled FROM PUBLIC');
  expect((sql.match(/SECURITY INVOKER/g) ?? []).length).toBe(6);
});
it('guards selected allocation before replacement without asserting a whole expanded body', () => {
  expect(sql.indexOf('IF raw_bytes+delta>4194304')).toBeLessThan(sql.indexOf('result:=jsonb_set'));
  expect(sql).toContain('PERFORM public.manual_race_v2_assert_json_bound(e)');
  expect(sql).not.toContain('assert_json_bound(result)');
  expect(sql).not.toMatch(/\bsha256\s*\(/);
});
it('the frozen Node envelope rejects incomplete/authority-claim input and getter ingress', () => {
  expect(
    raceManualReviewPooledDatabaseEnvelopeV1Schema.safeParse({ authority: 'approved', payload: {} })
      .success,
  ).toBe(false);
  let reads = 0;
  const raw = Object.defineProperty({}, 'payload', {
    enumerable: true,
    get() {
      reads++;
      throw Error('SECRET');
    },
  });
  expect(raceManualReviewPooledDatabaseEnvelopeV1Schema.safeParse(raw).success).toBe(false);
  expect(reads).toBe(0);
});
