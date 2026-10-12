import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  fullRestoreDurableRowColumnsV1,
  FullRestoreDurableRowError,
} from '../src/full-restore-durable-row-codecs-v1.js';
import {
  aiExecutionConsentDigestV1,
  createFullRestoreDurableRowParserV2,
  FULL_RESTORE_DURABLE_PROFILE27_RELATIONS,
  FULL_RESTORE_PROFILE27_NO_CODEC_RELATIONS,
  fullRestoreDurableRowColumnsThroughV2,
  fullRestoreDurableRowColumnsV2,
  galleryAlbumTitleValidV1,
} from '../src/full-restore-durable-row-codecs-v2.js';

const parse = createFullRestoreDurableRowParserV2({ maxRowBytes: 8388608 }).parse;
const id = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const owner = 'synthetic-합성';
const t0 = '2026-10-09T00:00:00.123456Z';
const t1 = '2026-10-09T00:00:01.000001Z';
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

const album = () => ({
  athlete_id: owner,
  id: id(1),
  title: '합성 앨범',
  revision: 2,
  created_at: t0,
  updated_at: t1,
  deleted_at: null,
});
const membership = () => ({ athlete_id: owner, media_item_id: id(2), album_id: id(1) });
const course = () => ({
  athlete_id: owner,
  media_item_id: id(2),
  course_id: id(3),
  course_revision: 4,
  revision_id: id(4),
});
const deletion = () => ({
  athlete_id: owner,
  album_id: id(1),
  deleted_revision: 3,
  deleted_at: t1,
});
const albumDto = (revision = 1) => ({
  schemaVersion: 1,
  id: id(1),
  title: '합성 앨범',
  revision,
  createdAt: t0,
  updatedAt: t1,
});
const navigation = () => ({
  access_revision: 3,
  activity_id: null,
  album: null,
  album_athlete_id: owner,
  album_id: id(1),
  athlete_id: owner,
  caption: null,
  captured_at: null,
  captured_local_date: null,
  content_hash: 'c'.repeat(64),
  course_athlete_id: null,
  course_available: null,
  course_id: null,
  course_revision: null,
  course_revision_id: null,
  created_at: t0,
  deleted_at: null,
  id: id(2),
  include_for_coach: false,
  media_kind: 'image',
  media_type: 'image/jpeg',
  original_filename: 'synthetic.jpg',
  preview_content_hash: null,
  preview_media_type: null,
  preview_size_bytes: null,
  size_bytes: 4096,
  updated_at: t1,
  visibility: 'private',
});
const receipt = (operation = 'create_album') => {
  const base = {
    athlete_id: owner,
    operation,
    idempotency_key: 'synthetic-key-1',
    request_digest: 'd'.repeat(64),
    target_album_id: id(1) as string | null,
    target_media_item_id: null as string | null,
    expected_revision: null as number | null,
    result_revision: 1,
    state: 'committed',
    result: albumDto() as unknown,
    committed_at: t1,
  };
  if (operation === 'rename_album')
    return { ...base, expected_revision: 1, result_revision: 2, result: albumDto(2) };
  if (operation === 'delete_album')
    return {
      ...base,
      expected_revision: 2,
      result_revision: 3,
      result: {
        schemaVersion: 1,
        status: 'deleted',
        albumId: id(1),
        revision: 3,
        detachedMediaCount: 1,
      },
    };
  if (operation === 'set_media_navigation')
    return {
      ...base,
      target_album_id: null,
      target_media_item_id: id(2),
      expected_revision: 2,
      result_revision: 3,
      result: navigation(),
    };
  return base;
};
const replayReceipt = () => ({
  event_id: id(9),
  athlete_id: owner,
  album_id: id(1),
  occurred_at: t1,
  deleted_revision: 3,
  outcome: 'deleted',
});
function job() {
  const row = {
    athlete_id: owner,
    job_id: id(20),
    run_id: id(21),
    thread_id: id(22),
    evidence_snapshot_id: id(23),
    command_version: 1,
    selection_version: 1,
    purpose: 'coaching',
    payload_classification: 'health',
    settings_revision: 1,
    catalog_revision: 1,
    catalog_digest: 'e'.repeat(64),
    policy_version: 'm2-05a-policy:1',
    disclosure_version: 'm2-05a-disclosure:1',
    recipient_id: 'openai',
    recipient_disclosure_version: 'm2-05a-disclosure:1',
    provider_id: 'openai',
    model_id: 'gpt-6.1-sol',
    adapter_binding_version: 'synthetic:adapter:1',
    vendor_model_ref: 'synthetic:gpt-6.1-sol',
    price_model_ref: 'gpt-6.1-sol',
    price_version: 'synthetic:price:1',
    tokenizer_version: 'synthetic:tokenizer:1',
    app_consent_revision: 1,
    app_consent_digest: '',
    ai_consent_revision: 1,
    ai_consent_digest: '',
    selection_digest: '',
    restore_generation_id: id(24),
    receipt_key: `ai-execution:run:v1:${'f'.repeat(64)}`,
    request_digest: 'a'.repeat(64),
    created_at: t1,
  };
  return withDigests(row);
}
type JobDigestInput = {
  [
    K in
      | 'athlete_id'
      | 'adapter_binding_version'
      | 'price_model_ref'
      | 'price_version'
      | 'purpose'
      | 'model_id'
      | 'provider_id'
      | 'tokenizer_version'
      | 'vendor_model_ref'
      | 'catalog_digest'
      | 'disclosure_version'
      | 'payload_classification'
      | 'policy_version'
      | 'recipient_disclosure_version'
      | 'recipient_id'
  ]: string;
} & {
  [
    K in 'catalog_revision' | 'ai_consent_revision' | 'app_consent_revision' | 'settings_revision'
  ]: number;
};
function withDigests<T extends JobDigestInput>(row: T): T {
  const consent = (kind: string, revision: number) =>
    sha(
      `{"version":"coaching-execution-consent-v1","athleteId":${JSON.stringify(row.athlete_id)},"kind":"${kind}","granted":true,"revision":${revision}}`,
    );
  const next = {
    ...row,
    app_consent_digest: consent('app', row.app_consent_revision),
    ai_consent_digest: consent('ai', row.ai_consent_revision),
  };
  const j = JSON.stringify;
  const canonical = `{"definitionVersion":"execution-selection-v1","draft":{"binding":{"adapterBindingVersion":${j(next.adapter_binding_version)},"priceModelRef":${j(next.price_model_ref)},"priceVersion":${j(next.price_version)},"purpose":${j(next.purpose)},"selection":{"modelId":${j(next.model_id)},"providerId":${j(next.provider_id)}},"tokenizerVersion":${j(next.tokenizer_version)},"vendorModelRef":${j(next.vendor_model_ref)}},"catalogDigest":${j(next.catalog_digest)},"catalogRevision":${next.catalog_revision},"disclosureVersion":${j(next.disclosure_version)},"payloadClassification":${j(next.payload_classification)},"permissions":{"ai":{"digest":${j(next.ai_consent_digest)},"enabled":true,"revision":${next.ai_consent_revision}},"app":{"digest":${j(next.app_consent_digest)},"enabled":true,"revision":${next.app_consent_revision}}},"policyVersion":${j(next.policy_version)},"recipientDisclosureVersion":${j(next.recipient_disclosure_version)},"recipientId":${j(next.recipient_id)},"schemaVersion":1,"settingsRevision":${next.settings_revision}}}`;
  return { ...next, selection_digest: sha(canonical) };
}
const disposition = () => ({
  athlete_id: owner,
  job_id: id(20),
  disposition: 'restore_cancelled',
  source_generation_id: id(24),
  target_generation_id: id(25),
  decided_at: t1,
});
const valid: Record<string, () => Record<string, unknown>> = {
  gallery_album: album,
  gallery_media_album_membership: membership,
  gallery_media_course_association: course,
  gallery_navigation_command_receipt: () => receipt(),
  gallery_album_deletion: deletion,
  restore_gallery_album_replay_receipt: replayReceipt,
  ai_execution_job: job,
  ai_execution_job_disposition: disposition,
};
const rejects = (relation: string, row: unknown) =>
  expect(() => parse({ relation, row })).toThrow(FullRestoreDurableRowError);

describe('profile27 durable row codecs', () => {
  it('registers exactly the eight source-retained relations and none of the derived ones', () => {
    expect(Object.keys(fullRestoreDurableRowColumnsV2).sort()).toEqual(Object.keys(valid).sort());
    expect(FULL_RESTORE_DURABLE_PROFILE27_RELATIONS).toHaveLength(8);
    for (const relation of FULL_RESTORE_PROFILE27_NO_CODEC_RELATIONS)
      expect(fullRestoreDurableRowColumnsThroughV2[relation.split('.')[1] ?? '']).toBeUndefined();
    expect(Object.keys(fullRestoreDurableRowColumnsThroughV2)).toHaveLength(15);
    for (const [relation, columns] of Object.entries(fullRestoreDurableRowColumnsV1))
      expect(fullRestoreDurableRowColumnsThroughV2[relation]).toEqual(columns);
  });
  it('codec columns equal the DDL column sets of 143/145/148', async () => {
    const sql = (
      await Promise.all(
        [
          '143_gallery_albums.sql',
          '145_gallery_restore_suppression.sql',
          '148_ai_execution_job_store.sql',
        ].map((file) => readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8')),
      )
    ).join('\n');
    for (const [relation, columns] of Object.entries(fullRestoreDurableRowColumnsV2)) {
      const body = new RegExp(`CREATE TABLE public\\.${relation} \\(\\n([\\s\\S]*?)\\n\\);`).exec(
        sql,
      )?.[1];
      expect(body, relation).toBeDefined();
      const ddl = (body ?? '')
        .split('\n')
        .map((line) => /^ ([a-z_]+) [a-z]/.exec(line)?.[1])
        .filter(
          (name): name is string =>
            name !== undefined && !['PRIMARY', 'FOREIGN', 'CHECK', 'UNIQUE'].includes(name),
        );
      expect([...columns].sort(), relation).toEqual([...ddl].sort());
    }
  });
  it.each(Object.entries(valid))(
    'accepts a valid %s row and freezes an owned copy',
    (relation, make) => {
      const row = make();
      const parsed = parse({ relation, row });
      expect(parsed).toMatchObject({
        kind: 'validated_full_restore_durable_row_v2',
        authority: 'none',
        admissionAllowed: false,
        closure: 'not_checked',
        facts: { relation, row },
      });
      expect(Object.isFrozen(parsed.facts.row)).toBe(true);
    },
  );
  it.each(Object.entries(valid))(
    '%s rejects extra, missing and wrong-typed columns',
    (relation, make) => {
      rejects(relation, { ...make(), extra: null });
      const [first] = Object.keys(make());
      rejects(relation, Object.fromEntries(Object.entries(make()).filter(([k]) => k !== first)));
      rejects(relation, { ...make(), athlete_id: 1 });
    },
  );
  it.each(['create_album', 'rename_album', 'delete_album', 'set_media_navigation'])(
    'accepts committed and redacted %s receipts',
    (operation) => {
      expect(() =>
        parse({ relation: 'gallery_navigation_command_receipt', row: receipt(operation) }),
      ).not.toThrow();
      expect(() =>
        parse({
          relation: 'gallery_navigation_command_receipt',
          row: { ...receipt(operation), state: 'redacted', result: null },
        }),
      ).not.toThrow();
    },
  );
  it('rejects receipt tuples the SQL143 CHECKs refuse', () => {
    const r = 'gallery_navigation_command_receipt';
    rejects(r, { ...receipt(), state: 'redacted' });
    rejects(r, { ...receipt(), result: null });
    rejects(r, { ...receipt(), target_media_item_id: id(2) });
    rejects(r, { ...receipt(), expected_revision: 1 });
    rejects(r, { ...receipt(), result_revision: 2, result: albumDto(2) });
    rejects(r, { ...receipt('rename_album'), result_revision: 3 });
    rejects(r, { ...receipt(), idempotency_key: 'short' });
    rejects(r, { ...receipt(), idempotency_key: 'has space key' });
    rejects(r, { ...receipt(), result: { ...albumDto(), extra: 1 } });
    rejects(r, { ...receipt(), result: { ...albumDto(), id: id(5) } });
    rejects(r, { ...receipt(), result: { ...albumDto(), title: ' padded' } });
    rejects(r, { ...receipt(), result: { ...albumDto(), createdAt: '2026-10-09T00:00:00Z' } });
    rejects(r, {
      ...receipt(),
      result: { ...albumDto(), updatedAt: '2026-10-08T00:00:00.000000Z' },
    });
    const del = receipt('delete_album');
    rejects(r, { ...del, result: { ...(del.result as object), detachedMediaCount: 1001 } });
    rejects(r, { ...del, result: { ...(del.result as object), status: 'gone' } });
    const nav = receipt('set_media_navigation');
    rejects(r, { ...nav, result: { ...navigation(), access_revision: 2 } });
    rejects(r, { ...nav, result: { ...navigation(), deleted_at: t1 } });
    const { visibility: _v, ...short } = navigation();
    void _v;
    rejects(r, { ...nav, result: short });
    rejects(r, { ...nav, result: { ...navigation(), gps: null } });
  });
  it('ports the SQL143 album title rule exactly', () => {
    expect(galleryAlbumTitleValidV1('a')).toBe(true);
    expect(galleryAlbumTitleValidV1('a\tb')).toBe(true);
    expect(galleryAlbumTitleValidV1('😀'.repeat(50))).toBe(true);
    expect(galleryAlbumTitleValidV1('😀'.repeat(51))).toBe(false);
    expect(galleryAlbumTitleValidV1('a'.repeat(100))).toBe(true);
    expect(galleryAlbumTitleValidV1('a'.repeat(101))).toBe(false);
    expect(galleryAlbumTitleValidV1('가'.repeat(100))).toBe(true);
    expect(galleryAlbumTitleValidV1('')).toBe(false);
    for (const edge of [' a', 'a ', '　a', 'a﻿', ' a'])
      expect(galleryAlbumTitleValidV1(edge)).toBe(false);
    for (const control of ['a\u0001b', 'a\u000bb', 'a\u007fb'])
      expect(galleryAlbumTitleValidV1(control)).toBe(false);
  });
  it('rejects album, ledger and receipt domain violations', () => {
    rejects('gallery_album', { ...album(), revision: 0 });
    rejects('gallery_album', { ...album(), revision: 2147483647 });
    rejects('gallery_album', { ...album(), athlete_id: ' padded' });
    rejects('gallery_album', { ...album(), athlete_id: '' });
    rejects('gallery_album', { ...album(), title: 'a'.repeat(101) });
    rejects('gallery_album', { ...album(), updated_at: '2026-10-09T00:00:00.123455Z' });
    rejects('gallery_album', { ...album(), deleted_at: t0 });
    rejects('gallery_album', { ...album(), created_at: '2026-10-09T09:00:00.123456+09:00' });
    expect(() =>
      parse({ relation: 'gallery_album', row: { ...album(), deleted_at: t1 } }),
    ).not.toThrow();
    rejects('gallery_album', { ...album(), id: id(1).toUpperCase() });
    rejects('gallery_album_deletion', { ...deletion(), deleted_revision: 1 });
    rejects('gallery_media_course_association', { ...course(), course_revision: 0 });
    rejects('restore_gallery_album_replay_receipt', { ...replayReceipt(), outcome: 'applied' });
    rejects('restore_gallery_album_replay_receipt', {
      ...replayReceipt(),
      deleted_revision: 2147483647,
    });
  });
  it('rejects AI job tuples the SQL148 CHECKs and guard refuse', () => {
    const r = 'ai_execution_job';
    rejects(r, { ...job(), command_version: 2 });
    rejects(r, { ...job(), purpose: 'synthetic_comparison' });
    rejects(r, { ...job(), price_model_ref: 'other-model' });
    rejects(r, { ...job(), model_id: 'Upper' });
    rejects(r, { ...job(), receipt_key: 'ai-execution:run:v2:' + 'f'.repeat(64) });
    rejects(r, { ...job(), settings_revision: 0 });
    rejects(r, { ...job(), selection_digest: 'b'.repeat(64) });
    rejects(r, { ...job(), app_consent_digest: 'b'.repeat(64) });
    rejects(r, { ...job(), ai_consent_revision: 2 });
    expect(
      parse({
        relation: r,
        row: withDigests({
          ...job(),
          purpose: 'synthetic_comparison',
          payload_classification: 'synthetic_only',
        }),
      }).kind,
    ).toBe('validated_full_restore_durable_row_v2');
    expect(aiExecutionConsentDigestV1(owner, 'app', 1)).toBe(job().app_consent_digest);
    rejects('ai_execution_job_disposition', { ...disposition(), target_generation_id: id(24) });
    rejects('ai_execution_job_disposition', { ...disposition(), disposition: 'cancelled' });
  });
  it('delegates the v1 relations to the unchanged v1 codec and refuses unknown relations', () => {
    const v1 = parse({
      relation: 'check_in_template_head',
      row: { athlete_id: owner, template_id: id(1), version_id: id(2), version: 1 },
    });
    expect(v1.kind).toBe('validated_full_restore_durable_row_v1');
    for (const relation of ['gallery_rendition_job', 'ai_synthetic_evidence_attestation', 'x'])
      rejects(relation, {});
    expect(() => createFullRestoreDurableRowParserV2({ maxRowBytes: 1 })).toThrow();
    expect(() =>
      createFullRestoreDurableRowParserV2({ maxRowBytes: 64 }).parse({
        relation: 'gallery_album',
        row: album(),
      }),
    ).toThrow(FullRestoreDurableRowError);
  });
});
