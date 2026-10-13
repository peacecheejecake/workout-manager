import { z } from 'zod';

import { createBoundedPlainJsonSchema } from './bounded-plain-json.js';

/** Public presentation metadata only; never a worker job, lease or storage key. */
export const GALLERY_RENDITION_V1_MAX_JSON_BYTES = 16 * 1024;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const galleryRenditionKindV1Schema = z.enum([
  'image_preview',
  'image_thumbnail',
  'video_playback',
]);
const lineageShape = {
  mediaItemId: z.uuid().transform((id) => id.toLowerCase()),
  kind: galleryRenditionKindV1Schema,
  originalSha256: digestSchema,
  parentAccessRevision: positiveInteger,
  recipeVersion: z.literal(1),
};
const lineageSchema = z.strictObject(lineageShape);

/** Snapshot own data before Zod reads fields. Arrays and non-JSON values are not
 * part of this DTO. Getter/prototype exceptions remain ordinary invalid input. */
function snapshot(raw: unknown, maxArrayLength = 0): unknown {
  let nodes = 0;
  let characters = 0;
  const ancestors = new Set<object>();
  function visit(value: unknown, depth: number): unknown {
    if (++nodes > 128 || depth > 8) throw new Error('INVALID');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      characters += value.length;
      if (characters > GALLERY_RENDITION_V1_MAX_JSON_BYTES) throw new Error('INVALID');
      return value;
    }
    if (!value || typeof value !== 'object' || ancestors.has(value)) throw new Error('INVALID');
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error('INVALID');
      const lengthProperty = Object.getOwnPropertyDescriptor(value, 'length');
      const length: unknown = lengthProperty?.value;
      if (maxArrayLength === 0 || typeof length !== 'number' || length > maxArrayLength)
        throw new Error('INVALID');
      if (Reflect.ownKeys(value).length !== length + 1) throw new Error('INVALID');
      ancestors.add(value);
      const items: unknown[] = [];
      for (let index = 0; index < length; index++) {
        const item = Object.getOwnPropertyDescriptor(value, String(index));
        if (!item?.enumerable || !Object.hasOwn(item, 'value')) throw new Error('INVALID');
        items.push(visit(item.value, depth + 1));
      }
      ancestors.delete(value);
      return items;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('INVALID');
    ancestors.add(value);
    const names = Reflect.ownKeys(value);
    if (names.length > 32) throw new Error('INVALID');
    const result: Record<string, unknown> = {};
    for (const name of names) {
      if (typeof name !== 'string') throw new Error('INVALID');
      characters += name.length;
      if (characters > GALLERY_RENDITION_V1_MAX_JSON_BYTES) throw new Error('INVALID');
      const property = Object.getOwnPropertyDescriptor(value, name);
      if (!property?.enumerable || !Object.hasOwn(property, 'value')) throw new Error('INVALID');
      Object.defineProperty(result, name, {
        value: visit(property.value, depth + 1),
        enumerable: true,
      });
    }
    ancestors.delete(value);
    return result;
  }
  return visit(raw, 0);
}
function boundedInput(maxArrayLength: number) {
  return z
    .unknown()
    .transform((raw, context) => {
      try {
        return snapshot(raw, maxArrayLength);
      } catch {
        context.addIssue({ code: 'custom', message: 'Invalid bounded rendition JSON.' });
        return z.NEVER;
      }
    })
    .pipe(createBoundedPlainJsonSchema(GALLERY_RENDITION_V1_MAX_JSON_BYTES));
}
const plainInput = boundedInput(0);

const imageOutputSchema = z.strictObject({
  mediaType: z.literal('image/webp'),
  sha256: digestSchema,
  byteSize: positiveInteger.max(2 * 1024 * 1024),
  widthPixels: positiveInteger.max(1600),
  heightPixels: positiveInteger.max(1600),
});
const videoOutputSchema = z.strictObject({
  mediaType: z.literal('video/mp4'),
  sha256: digestSchema,
  byteSize: positiveInteger.max(64 * 1024 * 1024),
  widthPixels: positiveInteger.max(1280),
  heightPixels: positiveInteger.max(1280),
  /** Renderer output duration is a finite number of seconds, not milliseconds. */
  durationSeconds: z.number().finite().positive().max(3600),
});
const readySchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    ...lineageShape,
    state: z.literal('ready'),
    output: z.discriminatedUnion('mediaType', [imageOutputSchema, videoOutputSchema]),
  })
  .superRefine((value, context) => {
    if ((value.kind === 'video_playback') !== (value.output.mediaType === 'video/mp4'))
      context.addIssue({ code: 'custom', path: ['output'], message: 'Rendition kind mismatch.' });
    if (
      value.kind === 'image_thumbnail' &&
      (value.output.widthPixels > 320 || value.output.heightPixels > 320)
    )
      context.addIssue({ code: 'custom', path: ['output'], message: 'Thumbnail exceeds recipe.' });
  });

/** Eligibility is descriptive server policy; it is neither retry approval nor
 * proof that another processing attempt has started. */
export const galleryRenditionRetryEligibilityV1Schema = z.enum([
  'eligible',
  'ineligible',
  'unknown',
]);
export const galleryRenditionFailureCodeV1Schema = z.enum([
  'input_invalid',
  'input_budget',
  'pixel_budget',
  'invalid_media',
  'decode_failed',
  'output_budget',
  'aborted',
  'timeout',
  'codec_unavailable',
]);
const lifecycleSchema = z.discriminatedUnion('state', [
  z.strictObject({ schemaVersion: z.literal(1), ...lineageShape, state: z.literal('queued') }),
  z.strictObject({ schemaVersion: z.literal(1), ...lineageShape, state: z.literal('running') }),
  readySchema,
  z.strictObject({
    schemaVersion: z.literal(1),
    ...lineageShape,
    state: z.literal('failed'),
    code: galleryRenditionFailureCodeV1Schema,
    retryEligibility: galleryRenditionRetryEligibilityV1Schema,
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    ...lineageShape,
    state: z.literal('unsupported'),
    code: z.enum(['unsupported_format', 'unsupported_pages']),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    ...lineageShape,
    state: z.literal('unavailable'),
    /** These reasons report a boundary decision, not permission/consent proof.
     * The original record/bytes remain immutable; no null preview infers state. */
    reason: z.enum([
      'not_available',
      'stale_lineage',
      'consent_withdrawn',
      'media_deleted',
      'target_closed',
    ]),
  }),
]);
export const galleryRenditionLineageV1Schema = plainInput.pipe(lineageSchema);
export const galleryRenditionV1Schema = plainInput.pipe(lifecycleSchema);

/** Read boundary, exactly as SQL144 enforces it. A reader (read_gallery_renditions_v1,
 * resolve_gallery_rendition_object_v1) fences only tenant ownership (app.athlete_id) and
 * deletion: a deleted item reads `media_deleted`, and an object resolves only for a `ready`
 * job of a live item whose current content hash still equals the job's source. Reads are NOT
 * gated by app consent nor by restore processing admission: presentation of existing
 * renditions continues while consent is withdrawn and while a restore target is pending
 * (product decision: consent gates only new processing; reads, deletes and replays continue).
 * New rendition work is what is gated. Without restore admission (the CLOSED control with no
 * pending target in the current generation) enqueue and every worker RPC (claim, settle,
 * release, sweep claim/finish) raise RESTORE_PROCESSING_CLOSED, and a media insert mints no job.
 * Missing/withdrawn app consent postpones claim (job requeued, no lease) and makes settle reject
 * with `consent_withdrawn`; it does not block enqueue or reads. Deletion and erasure retire
 * jobs regardless of either gate. The SQL144 readers never emit the `consent_withdrawn` or
 * `target_closed` unavailable reasons. Matching request lineage proves none of this; an
 * unavailable state carries the requested lineage and never asserts current parent proof. */
export const galleryRenditionResponseV1Schema = plainInput.pipe(
  z
    .strictObject({
      schemaVersion: z.literal(1),
      requested: lineageSchema,
      rendition: lifecycleSchema,
    })
    .superRefine((value, context) => {
      const a = value.requested;
      const b = value.rendition;
      if (
        a.mediaItemId !== b.mediaItemId ||
        a.kind !== b.kind ||
        a.originalSha256 !== b.originalSha256 ||
        a.parentAccessRevision !== b.parentAccessRevision ||
        a.recipeVersion !== b.recipeVersion
      )
        context.addIssue({
          code: 'custom',
          path: ['rendition'],
          message: 'Stale rendition lineage.',
        });
    }),
);
/** Every recipe-v1 rendition of one owned item, in recipe order: an image has exactly a
 * preview and a thumbnail, a video exactly a playback rendition. Presentation only. */
export const galleryRenditionListV1Schema = boundedInput(2).pipe(
  z
    .strictObject({
      schemaVersion: z.literal(1),
      mediaItemId: z.uuid().transform((id) => id.toLowerCase()),
      renditions: z.array(lifecycleSchema).min(1).max(2),
    })
    .superRefine((value, context) => {
      const kinds = value.renditions.map((rendition) => rendition.kind).join(',');
      if (kinds !== 'image_preview,image_thumbnail' && kinds !== 'video_playback')
        context.addIssue({ code: 'custom', path: ['renditions'], message: 'Recipe kinds.' });
      const first = value.renditions[0];
      for (const rendition of value.renditions)
        if (
          rendition.mediaItemId !== value.mediaItemId ||
          rendition.originalSha256 !== first?.originalSha256
        )
          context.addIssue({ code: 'custom', path: ['renditions'], message: 'Mixed lineage.' });
    }),
);
export type GalleryRenditionListV1 = z.infer<typeof galleryRenditionListV1Schema>;
export type GalleryRenditionKindV1 = z.infer<typeof galleryRenditionKindV1Schema>;
export type GalleryRenditionLineageV1 = z.infer<typeof galleryRenditionLineageV1Schema>;
export type GalleryRenditionV1 = z.infer<typeof galleryRenditionV1Schema>;
export type GalleryRenditionResponseV1 = z.infer<typeof galleryRenditionResponseV1Schema>;
