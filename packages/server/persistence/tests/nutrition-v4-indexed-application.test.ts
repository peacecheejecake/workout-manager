import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

const sql = await readFile(
  new URL('../migrations/133_nutrition_v4_indexed_application.sql', import.meta.url),
  'utf8',
);
const source110 = await readFile(
  new URL('../migrations/110_nutrition_disconnection_lineage.sql', import.meta.url),
  'utf8',
);
const source118 = await readFile(
  new URL('../migrations/118_race_manual_atomic_approval.sql', import.meta.url),
  'utf8',
);
const digest = (body: string) => createHash('sha256').update(body).digest('hex');
function body(source: string, declaration: string) {
  const start = source.indexOf(declaration);
  expect(start).toBeGreaterThanOrEqual(0);
  const first = source.indexOf('AS $$', start) + 5;
  const end = source.indexOf('$$;', first);
  expect(first).toBeGreaterThan(start);
  expect(end).toBeGreaterThan(first);
  return source.slice(first, end);
}
function patches(input: string, before: string, optionB = false) {
  const pattern = optionB
    ? /\(\d+,\$oldB(\d+)\$([\s\S]*?)\$oldB\1\$,\$newB\1\$([\s\S]*?)\$newB\1\$,(\d+)\)/g
    : /\(\d+,\$old(\d+)\$([\s\S]*?)\$old\1\$,\$new\1\$([\s\S]*?)\$new\1\$,(\d+)\)/g;
  let actual = before;
  const counts: number[] = [];
  for (const match of input.matchAll(pattern)) {
    const old = match[2],
      next = match[3],
      count = match[4];
    if (old === undefined || next === undefined || count === undefined)
      throw Error('INVALID_PATCH');
    const occurrences = actual.split(old).length - 1;
    expect(occurrences).toBe(Number(count));
    counts.push(occurrences);
    actual = actual.replaceAll(old, next);
  }
  return { actual, counts };
}
it('reconstructs exact current118 to A then B and original110 validator without editing historical bytes', () => {
  const blocks = sql.split('DECLARE predecessor pg_catalog.pg_proc%ROWTYPE;');
  expect(blocks).toHaveLength(4);
  const commit = body(source118, 'CREATE OR REPLACE FUNCTION public.commit_nutrition_plan_v4(');
  const validator = body(source110, 'CREATE FUNCTION public.assert_nutrition_disconnect_body(');
  expect(digest(commit)).toBe('bb5eca0bd23f90cdf1ea082e229e95188b808ce1ff01a9c34c63cfaa72f257bd');
  expect(digest(validator)).toBe(
    'ff1c1996a25f93a8ad096f2622b2f3a2897f7283d6d0a4a9698fe60cae37475b',
  );
  const first = patches(blocks[1] ?? '', commit);
  expect(first.counts).toEqual([1, 1, 1, 1, 1, 2, 1]);
  expect(digest(first.actual)).toBe(
    '7f9bf7c936e809f47cccb83d57ee8f052234629f454a5cd5c3afbb5bcf4a2636',
  );
  const descriptor = patches(blocks[2] ?? '', validator);
  expect(descriptor.counts).toEqual([1, 1, 1, 1, 1]);
  expect(digest(descriptor.actual)).toBe(
    '92a0643c5eff075ec00bacd21152666755dc439c1c01571640e8827a618edc6f',
  );
  const second = patches(blocks[3] ?? '', first.actual, true);
  expect(second.counts).toEqual([1, 1]);
  expect(digest(second.actual)).toBe(
    '16b2dc4c79dec56d417f504d4c005034b2769fefc4249dc8244698c6593a75a6',
  );
});
it('pins the exact INSERT hook bodies and preserves atomic one-DO/OID metadata boundaries', () => {
  expect(sql.match(/^DO /gm)).toHaveLength(1);
  expect(sql).not.toMatch(/^(BEGIN|COMMIT);/m);
  for (const name of [
    'guard_nutrition_lineage_insert',
    'verify_nutrition_v4_commit_final',
    'guard_nutrition_v4_seal',
  ]) {
    expect(sql).toContain(digest(body(source110, `CREATE FUNCTION public.${name}(`)));
  }
  expect(sql).toContain('n<>3');
  expect(sql).toContain('pg_catalog.pg_rewrite');
  expect(sql).toContain(
    "(to_jsonb(successor)-'prosrc') IS DISTINCT FROM (to_jsonb(predecessor)-'prosrc')",
  );
  expect(sql.indexOf('pg_advisory_xact_lock(872194,1)')).toBeLessThan(
    sql.indexOf('pg_advisory_xact_lock(77210,1)'),
  );
});
