import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
const migration = await readFile(
  new URL('../migrations/139_manual_pooled_personal_export_batch.sql', import.meta.url),
  'utf8',
);
const originals = await Promise.all(
  [
    ['129_manual_internal_retained_export.sql', 'read_manual_race_internal_personal_export_v1'],
    ['128_personal_export_retained_runtime.sql', 'read_race_manual_personal_export_v1'],
    ['132_manual_retained_source_export_batch.sql', 'read_manual_race_retained_source_batch_v1'],
  ].map(async ([file, name]) => {
    if (!file || !name) throw Error('STATIC_SOURCE_MISSING');
    const text = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
    const body = text.match(
      new RegExp(`CREATE FUNCTION public\\.${name}\\([\\s\\S]*? AS \\$\\$([\\s\\S]*?)\\$\\$;`),
    )?.[1];
    if (!body) throw Error('STATIC_SOURCE_MISSING');
    return { name, body };
  }),
);
function derive(index: number) {
  const original = originals[index];
  const branch = migration.split('FOR replacement IN SELECT * FROM (VALUES')[index + 1];
  if (!original || !branch) throw Error('STATIC_PATCH_MISSING');
  const block = branch.split(') changes(')[0] ?? '';
  const patches = [...block.matchAll(/\('((?:[^']|'')*)','((?:[^']|'')*)',1\)/g)];
  let body = original.body;
  for (const patch of patches) {
    const before = (patch[1] ?? '').replaceAll("''", "'");
    const after = (patch[2] ?? '').replaceAll("''", "'");
    expect(body.split(before)).toHaveLength(2);
    body = body.replace(before, after);
  }
  return { body, count: patches.length };
}
it('pins the actual final four export roots and exactly counted nonhistorical derivations', () => {
  for (const source of originals)
    expect(migration).toContain(createHash('sha256').update(source.body).digest('hex'));
  expect(migration).toContain('bb052b6eb730612f5b6cceb2dd333b4fec77be6740c800b006e7d4182463d924');
  expect([0, 1, 2].map((i) => derive(i).count)).toEqual([5, 5, 11]);
  expect(migration).toContain('replacement.expected_count');
});
it('transports full legacy or strict encoded bodies once while keeping original chain/candidate/history checks', () => {
  const { body } = derive(0);
  expect(body).toContain("'bodyState','purged','payloadEncoding',NULL,'payload',NULL");
  expect(body).toContain("'payloadEncoding',payload_encoding,'payload',chain_row.payload");
  expect(body).not.toContain("'preparation',chain_row.payload");
  expect(body).toContain('octet_length(chain_row.payload::text)>4194304');
  expect(body).toContain('wm_manual_pooled.check_encoded(chain_row.payload)');
  expect(body).toContain("ARRAY['context','sourceInput','candidate']");
  for (const guard of [
    'original.occurred_at=s.occurred_at',
    's.original_payload_sql_digest=chain_row.original_payload_sql_digest',
    'r.result IS DISTINCT FROM expected_result',
    'candidate_row.parent_decision IS DISTINCT FROM candidate_row.decision_id',
    'candidate_row.basis_json IS NULL OR candidate_row.lifecycle_json IS NULL',
    'public.nutrition_copy_structural_codec(candidate_row.candidate_json',
    "h.approved_at=(receipt_row.result->>'approvedAt')::timestamptz",
    "'schemaVersion',2,'chains'",
  ])
    expect(body).toContain(guard);
});
it('public filtering keeps aliases/original successes without candidate or retained duplicate reads', () => {
  const { body } = derive(1);
  expect(body).not.toContain('read_race_manual_public_preview_source_v1');
  expect(body).not.toContain('octet_length(c.candidate_json::text)');
  expect(body).not.toContain('octet_length(e.payload::text)');
  expect(body).toContain("'candidateId',retained.id,'evidenceId',retained.evidence_id");
  expect(body).toContain('FOR SHARE OF e,c');
  expect(body).toContain('retained.purged_at IS DISTINCT FROM retained.evidence_purged_at');
  expect(body).toContain('a.result IS DISTINCT FROM b.result');
  expect(body).toContain('p.result IS DISTINCT FROM a.result');
  expect(body).toContain(
    "'status','reviewed','reference',public.race_manual_public_reference_v1(t,c.id),'bodyState','present'",
  );
  expect(body).toContain("'trainingAggregateMappings',aggregate_mappings");
});
it('metadata binding uses full PostgreSQL envelope namespace, exact census and actual source/event guards', () => {
  const { body } = derive(2);
  expect(body).toContain('wm_manual_pooled.read_internal_export_v2');
  expect(body).toContain('wm_manual_pooled.read_public_export_metadata_v2');
  expect(body).not.toContain('public.read_manual_race_internal_personal_export_v1(');
  expect(body).not.toContain('public.read_race_manual_personal_export_v1(');
  expect(body).not.toContain('read_manual_race_source_personal_export_v1(');
  expect(body).toContain("'payloadBinding',payload_binding");
  expect(body).toContain("'postgres-retained-envelope-jsonb-v1'");
  expect(body).toContain("sha256(convert_to(retained_payload::text,'UTF8'))");
  for (const guard of [
    'public.manual_source_personal_row_exists_v1(ref_row.identity,chain_refs)',
    'public.manual_race_v2_event_matches_ref(event_row,r.identity,l.edge)',
    "internal_chain->'payload' IS DISTINCT FROM retained_payload",
    'savedRefCount',
    'savedParentCount',
    'savedSuppressionCount',
    'max(ordinal)',
    'NOT BETWEEN 1 AND 5000',
    'original_payload_sql_digest',
    "s.value->'reference'->'chain'->>'readonlyCandidateDigest'",
  ])
    expect(body).toContain(guard);
});
it('scalar one-copy and metadata budgets precede all body requests, final aggregate remains 8MiB', () => {
  const internal = derive(0).body;
  expect(internal.indexOf('IF raw_bytes>byte_limit')).toBeLessThan(
    internal.indexOf('FOR chain_row'),
  );
  const batch = derive(2).body;
  expect(batch.indexOf('INTO public_budget')).toBeLessThan(
    batch.indexOf('internal_json:=wm_manual_pooled.read_internal_export_v2'),
  );
  expect(batch).toContain('byte_limit NOT BETWEEN 1 AND 8388608');
  expect(batch).toContain('metadata_budget>=byte_limit');
  expect(batch).toContain('octet_length(result::text)>byte_limit');
});
it('owner-only atomic new roots leave old metadata/OIDs/security/ACL unchanged and have no fallback', () => {
  expect(migration.match(/DO \$migration\$/g)).toHaveLength(1);
  expect(migration).toContain('current_user<>session_user');
  expect(migration).toContain('rolsuper OR rolbypassrls');
  expect(migration).toContain(
    "predecessor.prokind<>'f' OR predecessor.proisstrict OR predecessor.proleakproof OR predecessor.proparallel<>'u'",
  );
  expect(migration).toContain(
    "to_jsonb(p)-ARRAY['oid','proname','pronamespace','prosrc','proacl']",
  );
  expect(migration).toContain('to_jsonb(p) IS DISTINCT FROM before_row');
  expect(migration).toContain('POOLED_EXPORT_ALREADY_INSTALLED');
  expect(migration).toContain('POOLED_EXPORT_PRIVATE_SCHEMA_MISMATCH');
  expect(migration).not.toMatch(/GRANT EXECUTE|ALTER TABLE|CREATE TABLE|UPDATE public\./);
  expect(derive(0).body).not.toMatch(/THEN[^;]*legacy.*EXCEPTION/s);
});
