import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
const sql = await readFile(
  new URL('../migrations/137_manual_pooled_application.sql', import.meta.url),
  'utf8',
);
it('pins five actual final predecessors and the independent pooled basis before creating successors', () => {
  for (const hash of [
    '7b1cfd89b9abb17de7c94fb606e831e703421db935b15b41ff87bb94b9b70671',
    'c5f0ba5fcfe8f1a84abc6e32586fd538eb9e5a88b052cec372444dc791de8332',
    '6dba7ef0210c2c1acb2b7f772ca40f5196142e39d8263d06ba2c6f749c55de64',
    'b4233f19ebf6b7fd246d035fc2eab91d647b477c7e8d890a3a04039154ba46c3',
    '28eb84586bb440eded89e32eff810a46ebbc32d6ece78e136b60007721009458',
    '2ea13f35abf5773a7f5b6c267127ad500fbc021e73f8506bf180ecbc2313e2d8',
  ])
    expect(sql).toContain(hash);
  expect(sql.match(/DO \$migration\$/g)).toHaveLength(1);
  expect(sql).toContain('POOLED_APPLICATION_ALREADY_INSTALLED');
});
it('checks exact security metadata and preserves all other pg_proc attributes', () => {
  expect(sql.match(/predecessor.prokind<>/g)).toHaveLength(3);
  expect(sql.match(/predecessor.proisstrict/g)).toHaveLength(3);
  expect(sql.match(/predecessor.proleakproof/g)).toHaveLength(3);
  expect(sql.match(/predecessor.proparallel<>/g)).toHaveLength(3);
  expect(sql).toContain('predecessor.prorettype<>(CASE WHEN dependency.signature=');
  expect(sql).toContain(
    "(to_jsonb(p)-ARRAY['oid','proname','prosrc','proacl'])=(to_jsonb(predecessor)-ARRAY['oid','proname','prosrc','proacl'])",
  );
  expect(sql).toContain('a.grantee<>predecessor.proowner AND a.is_grantable');
  expect(sql).toContain('to_jsonb(p)=original_row');
});
it('counts replacements independently in body and definition before changing the exact signature', () => {
  expect(sql.match(/replacement.expected_count/g)).toHaveLength(10);
  expect(sql).toContain(
    "length(definition)-length(replace(definition,'public.'||target.old_name||'(',''))",
  );
  expect(sql).toContain('p.prosrc=expected_body');
  expect(sql).not.toMatch(/CREATE TABLE|ALTER TABLE|DROP FUNCTION|GRANT EXECUTE|EXCEPTION WHEN/);
  expect(sql).toContain(' FROM PUBLIC');
});
it('uses bounded encoded lookups without hydrating a whole logical envelope', () => {
  for (const path of [
    'context',
    'candidate.body.projection',
    'sourceInput.projectionInput',
    'sourceInput.projectionInput.resolutions.routines',
  ])
    expect(sql).toContain(path);
  expect(sql).toContain('public.validate_race_manual_pooled_application_basis_v1($3,$2,$4)');
  expect(sql).not.toMatch(/hydrate|expanded_payload|jsonb_set|CREATE OR REPLACE/);
  expect(sql).toContain('public.race_manual_pooled_relative_membership_v1(retained)');
  expect(sql).toContain('public.race_manual_pooled_routine_expansion_v1(retained,');
});
it('actual stored encoding chooses the legacy path only after exact shape verification', () => {
  expect(sql).toContain(
    "parent.payload->''payload''->''preparation'' ?| ARRAY[''encoding'',''encodingVersion''",
  );
  expect(sql).toContain('PERFORM wm_manual_pooled.check_encoded(parent.payload)');
  expect(sql).toContain(
    "exact_keys(parent.payload->''payload''->''preparation'',ARRAY[''context'',''sourceInput'',''candidate''])",
  );
  for (const name of ['context', 'sourceInput', 'candidate'])
    expect(sql).toContain(
      `jsonb_typeof(parent.payload->''payload''->''preparation''->''${name}'') IS DISTINCT FROM ''object''`,
    );
  expect(sql).toContain('POOLED_APPLICATION_PARENT_ENCODING');
});
it('retains original preparation and begin logic outside explicit substitutions and never weakens historical writes', () => {
  expect(sql).toContain(
    'original_functions:=original_functions||jsonb_build_array(to_jsonb(predecessor))',
  );
  expect(sql).not.toContain('public.apply_race_manual_event_v1');
  expect(sql).not.toContain('public.commit_race_manual_application_v1');
  expect(sql).not.toContain('public.commit_nutrition_plan_v4');
  expect(sql).toContain('current_user<>session_user');
  expect(sql).toContain('rolsuper OR rolbypassrls');
});
