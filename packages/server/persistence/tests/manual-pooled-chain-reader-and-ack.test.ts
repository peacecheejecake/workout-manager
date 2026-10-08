import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
const sql = await readFile(
  new URL('../migrations/136_manual_pooled_chain_reader_and_ack.sql', import.meta.url),
  'utf8',
);
const ack = await readFile(
  new URL('../migrations/131_manual_race_same_tx_parent_ack.sql', import.meta.url),
  'utf8',
);
const resolver = await readFile(
  new URL('../migrations/134_manual_pooled_preparation_resolver.sql', import.meta.url),
  'utf8',
);
it('pins actual old reader ACK and all frozen resolver bodies before atomic creation', () => {
  expect(sql).toContain('b943069f3995e9b582b916e862514ee44832ad413d58b937af55d7613c7dfec3');
  expect(sql).toContain('9722a2ce02b2f151d6273a5f5bcd09c3286dd8c1dadb0dcfe61df05d8be2538e');
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
  expect(sql.match(/DO \$migration\$/g) ?? []).toHaveLength(1);
  expect(sql).toContain('to_jsonb(p) IS DISTINCT FROM to_jsonb(reader_before)');
  expect(sql).toContain('to_jsonb(p) IS DISTINCT FROM to_jsonb(predecessor)');
});
it('does not change historical functions tables receipts or issue any runtime grant', () => {
  expect(sql).toContain('public.read_manual_race_pooled_chain_v1');
  expect(sql).toContain('public.ack_manual_race_pooled_same_tx_parent_v1');
  expect(sql).not.toMatch(/ALTER TABLE|CREATE TABLE|DROP FUNCTION|GRANT EXECUTE|UPDATE public\./);
  expect(sql).toContain('POOLED_CHAIN_ALREADY_INSTALLED');
  expect(sql).toContain('a.is_grantable');
  expect(sql).toContain('FROM PUBLIC');
});
it('preserves every original ACK clause outside six exact counted substitutions', () => {
  const original = ack.match(/AS \$\$([\s\S]*?)\$\$/)?.[1];
  expect(original).toBeDefined();
  for (const fragment of [
    'seal.owner_xid=txid_current()',
    'seal.caller_role=session_user',
    'seal.payload_hash=expected_hash',
    'manual_race_chain_lifecycle_edge_v2',
    'manual_race_chain_suppression_v2',
    'request_digest',
    'manual.race_chain_prepared',
  ])
    expect(original).toContain(fragment);
  expect(sql).toContain('expected_body:=predecessor.prosrc');
  expect(sql).toContain('replacement.expected_count');
  expect(sql.match(/,1\)/g) ?? []).toHaveLength(6);
});
it('reads only selected header fields and keeps encoded PG versus logical digest namespaces distinct', () => {
  for (const p of ['context.athleteId', 'candidate.status', 'candidate.digest'])
    expect(sql).toContain(p);
  expect(sql).not.toContain("lookup($5,''context'')");
  expect(sql).not.toContain("lookup($5,''candidate'')");
  expect(sql).not.toMatch(/jsonb_set|hydrate|expanded_payload/);
  expect(sql).toContain("ackVersion'',2,''payloadEncoding'',payload_encoding");
  expect(sql).toContain('pooled-database-envelope-v1');
  expect(sql).toContain('legacy-retained-v2');
});
it('present pooled markers validate before returning exact body and never fall back after a validation error', () => {
  expect(sql).toContain('PERFORM wm_manual_pooled.check_encoded(parent.payload)');
  expect(sql).toContain('POOLED_CHAIN_READ_ENCODING');
  expect(sql).toContain('octet_length(parent.payload::text)>4194304');
  expect(sql).not.toContain('EXCEPTION WHEN');
  expect(sql).toContain("'payloadEncoding',encoding,'payload',parent.payload");
});
it('purged bodies explicitly retain unknown encoding and original minimal result privacy facts', () => {
  expect(sql).toContain('DECLARE parent record; encoding text;');
  expect(sql).toContain('IF parent.payload IS NOT NULL THEN');
  expect(sql).toContain("'result',parent.result");
  expect(sql).toContain("'purgedAt',parent.purged_at,'purgedEventId',parent.purged_event_id");
  expect(sql).not.toContain("coalesce(encoding,'legacy");
});
