import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createBoundedPlainJsonSchema } from '@workout/contracts/bounded-plain-json';
import {
  createFullRestoreDurableRowParserV1,
  fullRestoreDurableRowColumnsV1,
  FullRestoreDurableRowError,
  type ValidatedFullRestoreDurableRowV1,
} from './full-restore-durable-row-codecs-v1.js';

/**
 * Durable row codecs successor (profile27). The seven v1 relations keep the unchanged v1
 * codec. This module adds strict codecs for the eight source-retained profile27 relations:
 * the five SQL143 gallery navigation tables, the SQL145 album replay receipt and the two
 * SQL148 AI execution job tables. Target-local/derived profile27 relations
 * (gallery_rendition_job, gallery_rendition_due, gallery_rendition_sweep,
 * ai_synthetic_evidence_attestation, profile_extension_v11) intentionally have none.
 *
 * Each schema accepts exactly the DDL column set, the DDL CHECK domains and every in-row
 * relation the DDL/guards enforce (including the SQL143 original DTO check and the SQL148
 * consent/selection digests). Wire form: uuid lower-case text, int2/int4 JSON integers,
 * timestamptz `YYYY-MM-DDTHH:MM:SS.ffffffZ`, jsonb parsed JSON. Validation is structural:
 * authority none, no admission, no cross-row closure, no command-digest authenticity.
 */
const uuid = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const utc6 = z.iso.datetime({ precision: 6 }).regex(/\.\d{6}Z$/);
const int4 = z.number().int().min(-2147483648).max(2147483647);
const revision = z.number().int().min(1).max(2147483646);
const deletedRevision = z.number().int().min(2).max(2147483646);
const versionToken = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/);
const modelToken = z.string().regex(/^[a-z][a-z0-9._-]{0,99}$/);
const limitsSchema = z.strictObject({ maxRowBytes: z.number().int().min(2).max(8388608) });

/** PostgreSQL length() is in characters (code points); PG strings never hold NUL. */
const characters = (value: string) => [...value].length;
const noNul = (value: string) => !value.includes('\u0000');
/** `length(athlete_id) BETWEEN 1 AND 200` [AND athlete_id=btrim(athlete_id)] (space trim). */
const tenant = (trimmed: boolean) =>
  z
    .string()
    .refine(
      (value) =>
        noNul(value) &&
        characters(value) >= 1 &&
        characters(value) <= 200 &&
        (!trimmed || value === value.replace(/^ +| +$/g, '')),
    );
const anyText = z.string().refine(noNul);
/** Exact microsecond instant of a validated utc6 value (Date alone keeps milliseconds). */
function instant(value: string): bigint {
  return BigInt(Date.parse(value)) * 1000n + BigInt(Number(value.slice(20, 26)) % 1000);
}
/** octet_length(jsonb::text): PostgreSQL renders `", "` and `": "` separators. */
function jsonbTextBytes(value: unknown): number {
  if (Array.isArray(value))
    return 2 + value.reduce<number>((n, item, i) => n + (i ? 2 : 0) + jsonbTextBytes(item), 0);
  if (typeof value === 'object' && value !== null)
    return (
      2 +
      Object.entries(value).reduce<number>(
        (n, [key, item], i) =>
          n +
          (i ? 2 : 0) +
          Buffer.byteLength(JSON.stringify(key), 'utf8') +
          2 +
          jsonbTextBytes(item),
        0,
      )
    );
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

// SQL143 gallery_album_title_valid_v1 (exact port).
const titleTrim = new Set(
  [
    9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201,
    8202, 8232, 8233, 8239, 8287, 12288, 65279,
  ].map((code) => String.fromCodePoint(code)),
);
export function galleryAlbumTitleValidV1(value: unknown): boolean {
  if (typeof value !== 'string' || value === '' || !noNul(value)) return false;
  const points = [...value];
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined || titleTrim.has(first) || titleTrim.has(last))
    return false;
  if (Buffer.byteLength(value, 'utf8') > 400) return false;
  let units = 0;
  for (const point of points) {
    const code = point.codePointAt(0) ?? 0;
    if (code <= 8 || (code >= 11 && code <= 31) || code === 127) return false;
    units += code > 65535 ? 2 : 1;
  }
  return units >= 1 && units <= 100;
}

const galleryAlbum = z
  .strictObject({
    athlete_id: tenant(true),
    id: uuid,
    title: z.string().refine(galleryAlbumTitleValidV1),
    revision,
    created_at: utc6,
    updated_at: utc6,
    deleted_at: utc6.nullable(),
  })
  .superRefine((row, context) => {
    if (
      instant(row.updated_at) < instant(row.created_at) ||
      (row.deleted_at !== null && instant(row.deleted_at) !== instant(row.updated_at))
    )
      context.addIssue({ code: 'custom', message: 'Invalid album timestamps' });
  });
const membership = z.strictObject({ athlete_id: anyText, media_item_id: uuid, album_id: uuid });
const courseAssociation = z.strictObject({
  athlete_id: anyText,
  media_item_id: uuid,
  course_id: uuid,
  course_revision: revision,
  revision_id: uuid,
});
const albumDeletion = z.strictObject({
  athlete_id: tenant(false),
  album_id: uuid,
  deleted_revision: deletedRevision,
  deleted_at: utc6,
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const sortedKeys = (value: Record<string, unknown>) =>
  Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const sameKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  JSON.stringify(sortedKeys(value)) === JSON.stringify([...keys].sort());
const navigationKeys = [
  'access_revision',
  'activity_id',
  'album',
  'album_athlete_id',
  'album_id',
  'athlete_id',
  'caption',
  'captured_at',
  'captured_local_date',
  'content_hash',
  'course_athlete_id',
  'course_available',
  'course_id',
  'course_revision',
  'course_revision_id',
  'created_at',
  'deleted_at',
  'id',
  'include_for_coach',
  'media_kind',
  'media_type',
  'original_filename',
  'preview_content_hash',
  'preview_media_type',
  'preview_size_bytes',
  'size_bytes',
  'updated_at',
  'visibility',
] as const;
const dtoInstant = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{6}Z$/;
/** SQL143 gallery_album_result_valid_v1 (exact port; size bound applied by the caller). */
export function galleryAlbumResultValidV1(
  operation: string,
  target: string,
  resultRevision: number,
  result: unknown,
): boolean {
  if (!isObject(result)) return false;
  if (operation === 'set_media_navigation')
    return (
      sameKeys(result, navigationKeys) &&
      result['id'] === target &&
      result['access_revision'] === resultRevision &&
      result['deleted_at'] === null
    );
  if (result['schemaVersion'] !== 1 || result['revision'] !== resultRevision) return false;
  if (operation === 'delete_album') {
    const detached = result['detachedMediaCount'];
    return (
      sameKeys(result, ['albumId', 'detachedMediaCount', 'revision', 'schemaVersion', 'status']) &&
      result['status'] === 'deleted' &&
      result['albumId'] === target &&
      typeof detached === 'number' &&
      Number.isInteger(detached) &&
      detached >= 0 &&
      detached <= 1000
    );
  }
  if (
    (operation !== 'create_album' && operation !== 'rename_album') ||
    !sameKeys(result, ['createdAt', 'id', 'revision', 'schemaVersion', 'title', 'updatedAt']) ||
    result['id'] !== target ||
    !galleryAlbumTitleValidV1(result['title'])
  )
    return false;
  const created = result['createdAt'];
  const updated = result['updatedAt'];
  if (
    typeof created !== 'string' ||
    typeof updated !== 'string' ||
    !dtoInstant.test(created) ||
    !dtoInstant.test(updated) ||
    !utc6.safeParse(created).success ||
    !utc6.safeParse(updated).success
  )
    return false;
  return instant(updated) >= instant(created);
}
const navigationReceipt = z
  .strictObject({
    athlete_id: anyText,
    operation: z.enum(['create_album', 'rename_album', 'delete_album', 'set_media_navigation']),
    idempotency_key: z
      .string()
      .regex(/^[A-Za-z0-9._:-]+$/)
      .min(8)
      .max(128),
    request_digest: hex64,
    target_album_id: uuid.nullable(),
    target_media_item_id: uuid.nullable(),
    expected_revision: int4.nullable(),
    result_revision: revision,
    state: z.enum(['committed', 'redacted']),
    result: z.unknown(),
    committed_at: utc6,
  })
  .superRefine((row, context) => {
    const media = row.operation === 'set_media_navigation';
    const target = media ? row.target_media_item_id : row.target_album_id;
    const targetsValid = media
      ? row.target_media_item_id !== null && row.target_album_id === null
      : row.target_album_id !== null && row.target_media_item_id === null;
    const revisionsValid =
      row.operation === 'create_album'
        ? row.expected_revision === null && row.result_revision === 1
        : row.expected_revision !== null &&
          row.expected_revision >= 1 &&
          row.expected_revision <= 2147483645 &&
          row.result_revision === row.expected_revision + 1;
    const committed =
      row.state === 'committed' &&
      isObject(row.result) &&
      jsonbTextBytes(row.result) <= 1048576 &&
      target !== null &&
      galleryAlbumResultValidV1(row.operation, target, row.result_revision, row.result);
    const redacted = row.state === 'redacted' && row.result === null;
    if (!targetsValid || !revisionsValid || (!committed && !redacted))
      context.addIssue({ code: 'custom', message: 'Invalid navigation receipt tuple' });
  });
const albumReplayReceipt = z.strictObject({
  event_id: uuid,
  athlete_id: tenant(false),
  album_id: uuid,
  occurred_at: utc6,
  deleted_revision: deletedRevision,
  outcome: z.enum(['deleted', 'recorded_absent']),
});

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
/** SQL148 consent digest (format() with to_json(tenant) and the integer revision). */
export function aiExecutionConsentDigestV1(
  athleteId: string,
  kind: 'app' | 'ai',
  consentRevision: number,
): string {
  return sha256(
    `{"version":"coaching-execution-consent-v1","athleteId":${JSON.stringify(athleteId)},"kind":"${kind}","granted":true,"revision":${consentRevision}}`,
  );
}
const aiJob = z
  .strictObject({
    athlete_id: tenant(true),
    job_id: uuid,
    run_id: uuid,
    thread_id: uuid,
    evidence_snapshot_id: uuid,
    command_version: z.literal(1),
    selection_version: z.literal(1),
    purpose: z.enum(['coaching', 'synthetic_comparison']),
    payload_classification: z.enum(['health', 'synthetic_only']),
    settings_revision: int4.min(1),
    catalog_revision: int4.min(1),
    catalog_digest: hex64,
    policy_version: versionToken,
    disclosure_version: versionToken,
    recipient_id: versionToken,
    recipient_disclosure_version: versionToken,
    provider_id: modelToken,
    model_id: modelToken,
    adapter_binding_version: versionToken,
    vendor_model_ref: versionToken,
    price_model_ref: versionToken,
    price_version: versionToken,
    tokenizer_version: versionToken,
    app_consent_revision: int4.min(1),
    app_consent_digest: hex64,
    ai_consent_revision: int4.min(1),
    ai_consent_digest: hex64,
    selection_digest: hex64,
    restore_generation_id: uuid,
    receipt_key: z.string().regex(/^ai-execution:run:v1:[0-9a-f]{64}$/),
    request_digest: hex64,
    created_at: utc6,
  })
  .superRefine((row, context) => {
    const j = JSON.stringify;
    const canonical = `{"definitionVersion":"execution-selection-v1","draft":{"binding":{"adapterBindingVersion":${j(row.adapter_binding_version)},"priceModelRef":${j(row.price_model_ref)},"priceVersion":${j(row.price_version)},"purpose":${j(row.purpose)},"selection":{"modelId":${j(row.model_id)},"providerId":${j(row.provider_id)}},"tokenizerVersion":${j(row.tokenizer_version)},"vendorModelRef":${j(row.vendor_model_ref)}},"catalogDigest":${j(row.catalog_digest)},"catalogRevision":${row.catalog_revision},"disclosureVersion":${j(row.disclosure_version)},"payloadClassification":${j(row.payload_classification)},"permissions":{"ai":{"digest":${j(row.ai_consent_digest)},"enabled":true,"revision":${row.ai_consent_revision}},"app":{"digest":${j(row.app_consent_digest)},"enabled":true,"revision":${row.app_consent_revision}}},"policyVersion":${j(row.policy_version)},"recipientDisclosureVersion":${j(row.recipient_disclosure_version)},"recipientId":${j(row.recipient_id)},"schemaVersion":1,"settingsRevision":${row.settings_revision}}}`;
    if (
      row.price_model_ref !== row.model_id ||
      (row.purpose === 'synthetic_comparison' && row.payload_classification !== 'synthetic_only') ||
      row.app_consent_digest !==
        aiExecutionConsentDigestV1(row.athlete_id, 'app', row.app_consent_revision) ||
      row.ai_consent_digest !==
        aiExecutionConsentDigestV1(row.athlete_id, 'ai', row.ai_consent_revision) ||
      row.selection_digest !== sha256(canonical)
    )
      context.addIssue({ code: 'custom', message: 'Invalid frozen job tuple' });
  });
const aiJobDisposition = z
  .strictObject({
    athlete_id: tenant(true),
    job_id: uuid,
    disposition: z.literal('restore_cancelled'),
    source_generation_id: uuid,
    target_generation_id: uuid,
    decided_at: utc6,
  })
  .refine((row) => row.source_generation_id !== row.target_generation_id);

const relationsV2 = [
  ['gallery_album', galleryAlbum],
  ['gallery_media_album_membership', membership],
  ['gallery_media_course_association', courseAssociation],
  ['gallery_navigation_command_receipt', navigationReceipt],
  ['gallery_album_deletion', albumDeletion],
  ['restore_gallery_album_replay_receipt', albumReplayReceipt],
  ['ai_execution_job', aiJob],
  ['ai_execution_job_disposition', aiJobDisposition],
] as const;
const envelopeV2 = z.discriminatedUnion('relation', [
  z.strictObject({ relation: z.literal('gallery_album'), row: galleryAlbum }),
  z.strictObject({ relation: z.literal('gallery_media_album_membership'), row: membership }),
  z.strictObject({
    relation: z.literal('gallery_media_course_association'),
    row: courseAssociation,
  }),
  z.strictObject({
    relation: z.literal('gallery_navigation_command_receipt'),
    row: navigationReceipt,
  }),
  z.strictObject({ relation: z.literal('gallery_album_deletion'), row: albumDeletion }),
  z.strictObject({
    relation: z.literal('restore_gallery_album_replay_receipt'),
    row: albumReplayReceipt,
  }),
  z.strictObject({ relation: z.literal('ai_execution_job'), row: aiJob }),
  z.strictObject({ relation: z.literal('ai_execution_job_disposition'), row: aiJobDisposition }),
]);
type DurableRowV2 = z.infer<typeof envelopeV2>;

function columnsOf(schema: z.ZodType): readonly string[] {
  // ZodPipe/ZodEffects-free: refinements keep the underlying strict object shape.
  const shape: unknown = Reflect.get(schema, 'shape');
  if (typeof shape !== 'object' || shape === null) throw new Error('DURABLE_CODEC_SHAPE');
  return Object.freeze(Object.keys(shape));
}
/** Exact column names of the eight profile27 codecs (registration cross-check). */
export const fullRestoreDurableRowColumnsV2: Readonly<Record<string, readonly string[]>> =
  Object.freeze(
    Object.fromEntries(relationsV2.map(([relation, schema]) => [relation, columnsOf(schema)])),
  );
/** Source-retained profile27 relations of this module, schema-qualified. */
export const FULL_RESTORE_DURABLE_PROFILE27_RELATIONS = Object.freeze(
  relationsV2.map(([relation]) => `public.${relation}`),
);
/** Profile27 relations that intentionally get no durable codec (target-local/derived). */
export const FULL_RESTORE_PROFILE27_NO_CODEC_RELATIONS = Object.freeze([
  'public.gallery_rendition_job',
  'public.gallery_rendition_due',
  'public.gallery_rendition_sweep',
  'public.ai_synthetic_evidence_attestation',
  'wm_runtime_installation.profile_extension_v11',
]);
/** v1 durable7 columns plus the eight profile27 codecs; relation names never overlap. */
export const fullRestoreDurableRowColumnsThroughV2: Readonly<Record<string, readonly string[]>> =
  Object.freeze({ ...fullRestoreDurableRowColumnsV1, ...fullRestoreDurableRowColumnsV2 });

type Immutable<T> = T extends readonly (infer Item)[]
  ? readonly Immutable<Item>[]
  : T extends object
    ? { readonly [K in keyof T]: Immutable<T[K]> }
    : T;
export type ValidatedFullRestoreDurableRowV2 = Readonly<{
  kind: 'validated_full_restore_durable_row_v2';
  authority: 'none';
  admissionAllowed: false;
  closure: 'not_checked';
  facts: Immutable<DurableRowV2>;
}>;
function freezeJson(value: unknown): void {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
}
const v1Relations = new Set(Object.keys(fullRestoreDurableRowColumnsV1));
/**
 * Caller supplies a reviewed transport cap (same contract and error class as v1). A v1
 * relation is parsed by the unchanged v1 codec and keeps its v1 result kind; a profile27
 * relation by the codecs above. Any other relation, extra/missing column or domain/tuple
 * violation fails closed with INVALID_DURABLE_PHYSICAL_ROW.
 */
export function createFullRestoreDurableRowParserV2(rawLimits: unknown) {
  const v1 = createFullRestoreDurableRowParserV1(rawLimits);
  const limits = limitsSchema.parse(rawLimits);
  const boundary = createBoundedPlainJsonSchema(limits.maxRowBytes);
  return {
    parse(raw: unknown): ValidatedFullRestoreDurableRowV1 | ValidatedFullRestoreDurableRowV2 {
      if (!boundary.safeParse(raw).success)
        throw new FullRestoreDurableRowError('INVALID_DURABLE_PHYSICAL_ROW');
      const relation: unknown =
        typeof raw === 'object' && raw !== null ? Reflect.get(raw, 'relation') : undefined;
      if (typeof relation === 'string' && v1Relations.has(relation)) return v1.parse(raw);
      const parsed = envelopeV2.safeParse(raw);
      if (!parsed.success) throw new FullRestoreDurableRowError('INVALID_DURABLE_PHYSICAL_ROW');
      // Validate only; keep the original spelling and own an immutable copy.
      const facts = structuredClone(parsed.data);
      freezeJson(facts);
      return Object.freeze({
        kind: 'validated_full_restore_durable_row_v2',
        authority: 'none',
        admissionAllowed: false,
        closure: 'not_checked',
        facts,
      });
    },
  };
}
