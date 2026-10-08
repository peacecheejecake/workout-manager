import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
const sql = await readFile(
  new URL('../migrations/138_manual_pooled_public_finish_and_preview.sql', import.meta.url),
  'utf8',
);
const oldFinish = await readFile(
  new URL('../migrations/122_race_manual_public_receipts.sql', import.meta.url),
  'utf8',
);
const oldPreview = await readFile(
  new URL('../migrations/124_race_manual_public_preview_source.sql', import.meta.url),
  'utf8',
);
const resolver = await readFile(
  new URL('../migrations/134_manual_pooled_preparation_resolver.sql', import.meta.url),
  'utf8',
);
function original(source: string, name: string) {
  const body = source.match(
    new RegExp(`CREATE FUNCTION public\\.${name}\\([\\s\\S]*? AS \\$\\$([\\s\\S]*?)\\$\\$;`),
  )?.[1];
  if (body === undefined) throw Error('MISSING_STATIC_PREDECESSOR');
  return body;
}
function replacements(branch: 'finish' | 'preview') {
  const split = sql.split("IF target.old_name='finish_race_manual_public_review_v1' THEN")[1];
  if (!split) throw Error('MISSING_STATIC_PATCH');
  const blocks = split.split('FOR replacement IN SELECT * FROM (VALUES');
  const block = blocks[branch === 'finish' ? 1 : 2]?.split(') changes(')[0];
  if (!block) throw Error('MISSING_STATIC_PATCH');
  return [...block.matchAll(/\('((?:[^']|'')*)','((?:[^']|'')*)',1\)/g)].map((m) => ({
    before: (m[1] ?? '').replaceAll("''", "'"),
    after: (m[2] ?? '').replaceAll("''", "'"),
  }));
}
function derived(branch: 'finish' | 'preview') {
  let body = original(
    branch === 'finish' ? oldFinish : oldPreview,
    branch === 'finish'
      ? 'finish_race_manual_public_review_v1'
      : 'read_race_manual_public_preview_source_v1',
  );
  for (const patch of replacements(branch)) {
    expect(body.split(patch.before)).toHaveLength(2);
    body = body.replace(patch.before, patch.after);
  }
  return body;
}
it('pins both genuine final predecessor bodies and private resolver dependencies', () => {
  for (const [source, name] of [
    [oldFinish, 'finish_race_manual_public_review_v1'],
    [oldPreview, 'read_race_manual_public_preview_source_v1'],
  ]) {
    if (!source || !name) throw Error('MISSING_SOURCE');
    expect(sql).toContain(createHash('sha256').update(original(source, name)).digest('hex'));
  }
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
});
it('uses exactly three finish and four preview counted local substitutions', () => {
  expect(replacements('finish')).toHaveLength(3);
  expect(replacements('preview')).toHaveLength(4);
  derived('finish');
  derived('preview');
  expect(sql).toContain('replacement.expected_count');
});
it('retains receipt-first return and every protected finish provenance guard', () => {
  const body = derived('finish');
  expect(body.indexOf('RETURN replay;')).toBeLessThan(
    body.indexOf('wm_manual_pooled.check_encoded'),
  );
  for (const guard of [
    'q.xmin::text=(txid_current()%4294967296)::text',
    'q.owner_xid=txid_current() AND q.caller_role=session_user',
    'q.payload_hash=sha256(convert_to(e.payload::text',
    'e.receipt_key IS DISTINCT FROM internal_key',
    'q.request_digest=sha256',
    "c.basis_json->'intent' IS DISTINCT FROM $2->'intent'",
    'public.race_manual_public_reference_v1(t,c.id)',
  ])
    expect(body).toContain(guard);
  expect(body).toContain("wm_manual_pooled.lookup(e.payload,'context.calendarIntent')");
  expect(body).toContain(
    "ELSE e.payload->'payload'->'preparation'->'context'->'calendarIntent' END",
  );
});
it('retains actual tenant locked candidate/evidence association and exact purge event/time checks', () => {
  const body = derived('preview');
  for (const guard of [
    'public.race_manual_public_scope_v1()',
    'WHERE c.athlete_id=t AND c.id=$1',
    'FOR SHARE OF e,c',
    'retained.purged_event_id IS DISTINCT FROM retained.evidence_purged_event_id',
    'retained.purged_at IS DISTINCT FROM retained.evidence_purged_at',
    "retained.candidate_json->'chain'->>'evidenceId' IS DISTINCT FROM retained.evidence_id::text",
    "retained.candidate_json->'chain'->>'decisionId' IS DISTINCT FROM retained.decision_id::text",
    "retained.candidate_json->'chain'->>'proposalId' IS DISTINCT FROM retained.proposal_id::text",
  ])
    expect(body).toContain(guard);
});
it('returns one full retained envelope and explicit unknown encoding after purge', () => {
  const body = derived('preview');
  expect(body).toContain("'readerVersion',2");
  expect(body).toContain(
    "'bodyState','purged','candidate',NULL,'payloadEncoding',NULL,'payload',NULL",
  );
  expect(body).toContain("'payloadEncoding',payload_encoding,'payload',retained.payload");
  expect(body).not.toContain("'preparation',retained.payload");
  expect(body).toContain('octet_length(retained.payload::text)>4194304');
  expect(body).toContain('manual_race_v2_assert_json_bound(retained.payload)');
});
it('has no encoding-error fallback and preserves legacy strict root roster', () => {
  for (const branch of ['finish', 'preview'] as const) {
    const body = derived(branch);
    expect(body).toContain("ARRAY['context','sourceInput','candidate']");
    expect(body).toContain("payload_encoding:='pooled-database-envelope-v1'");
    expect(body).toContain("payload_encoding:='legacy-retained-v2'");
    expect(body).toContain('POOLED_PUBLIC_ENCODING_INVALID');
    expect(body).not.toMatch(/EXCEPTION WHEN|WHEN OTHERS/);
  }
});
it('creates only named successors atomically with owner/config/OID and historical ACL invariants', () => {
  expect(sql.match(/DO \$migration\$/g)).toHaveLength(1);
  expect(sql).toContain('current_user<>session_user');
  expect(sql).toContain('rolsuper OR rolbypassrls');
  expect(sql).toContain('POOLED_PUBLIC_ALREADY_INSTALLED');
  expect(sql).toContain('to_jsonb(p) IS DISTINCT FROM before_row');
  expect(sql).toContain('p.proargnames IS NOT DISTINCT FROM predecessor.proargnames');
  expect(sql).toContain(
    "predecessor.prokind<>'f' OR predecessor.proisstrict OR predecessor.proleakproof OR predecessor.proparallel<>'u'",
  );
  expect(sql).toContain("to_jsonb(p)-ARRAY['oid','proname','prosrc','proacl']");
  expect(sql).toContain('p.proconfig IS NOT DISTINCT FROM predecessor.proconfig');
  expect(sql).toContain('FROM PUBLIC');
  expect(sql).not.toMatch(/GRANT EXECUTE|ALTER TABLE|CREATE TABLE|DROP FUNCTION|UPDATE public\./);
});
