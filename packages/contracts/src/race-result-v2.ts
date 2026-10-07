import { z } from 'zod';
import { GALLERY_IMAGE_MAX_BYTES, galleryImageMediaTypeSchema } from './gallery.js';
import { PRIVATE_RESOURCE_PDF_MAX_BYTES } from './resources.js';
import { raceResultSchema } from './races.js';
import {
  raceCommandResultSchema,
  raceResultCreateCommandSchema,
  raceResultUpdateCommandSchema,
  raceResultSourceInputSchema,
} from './race-commands.js';
import {
  raceCollectionStampSchema,
  raceListCursorSchema,
  raceListQuerySchema,
  raceResultListPageSchema,
} from './race-queries.js';

/** Contract preparation only: neither an attachment resolver nor review/PB authority.
 * Gallery image objects have immutable mediaItemId, not a fabricated version UUID.
 * Resource/resource_version IDs are UUIDs in SQL027; PDF ownership/version/ACL,
 * deletion and restore integration must be implemented before enabling writes.
 */
const uuid = z.uuid().refine((value) => value === value.toLowerCase());
const accessRevision = z.number().int().min(1).max(2147483647);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const RACE_RESULT_V2_MAX_BYTES = 16 * 1024;
export const raceResultProofLinkSchema = z
  .url({ protocol: /^https$/ })
  .max(2048)
  .refine(
    (value) =>
      value === value.trim() && new URL(value).username === '' && new URL(value).password === '',
  );

/** Byte bound is applied to original decoded JSON before object parsing/normalization. */
function bounded<T extends z.ZodType>(schema: T, maximum = RACE_RESULT_V2_MAX_BYTES) {
  return z
    .unknown()
    .superRefine((value, context) => {
      try {
        const serialized = JSON.stringify(value);
        if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > maximum)
          context.addIssue({
            code: 'custom',
            message: 'Race result exceeds its UTF-8 envelope bound',
          });
      } catch {
        context.addIssue({ code: 'custom', message: 'Race result must be bounded JSON' });
      }
    })
    .pipe(schema);
}
const galleryIdentity = { kind: z.literal('gallery-image'), mediaItemId: uuid };
const pdfIdentity = { kind: z.literal('resource-pdf'), resourceId: uuid, versionId: uuid };
export const raceResultAttachmentInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...galleryIdentity, expectedAccessRevision: accessRevision }),
  z.strictObject({ ...pdfIdentity, expectedAccessRevision: accessRevision }),
]);
/** Only a trusted server resolver can populate these facts. Schema validation alone
 * is not same-tenant access, file finalization, authenticity or permission evidence.
 * No filename, signed URL, storage reference or review timestamp is copied.
 */
export const raceResultAttachmentStoredSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...galleryIdentity,
    accessRevision,
    mediaType: galleryImageMediaTypeSchema,
    byteSize: z.number().int().positive().max(GALLERY_IMAGE_MAX_BYTES),
    sha256: hash,
  }),
  z.strictObject({
    ...pdfIdentity,
    accessRevision,
    mediaType: z.literal('application/pdf'),
    byteSize: z.number().int().positive().max(PRIVATE_RESOURCE_PDF_MAX_BYTES),
    contentHash: hash,
  }),
]);
/** Contentless identity after source removal. No access provenance or descriptor.
 * Parsing this state does not authorize redaction: only the future same-tenant,
 * source-authorized SQL lifecycle may produce it for current or historical rows.
 */
export const raceResultAttachmentUnavailableSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...galleryIdentity, status: z.literal('unavailable') }),
  z.strictObject({ ...pdfIdentity, status: z.literal('unavailable') }),
]);
/** Unavailable responses retain only opaque reference identity, never copied metadata. */
export const raceResultAttachmentReadSchema = z.union([
  raceResultAttachmentStoredSchema.options[0].extend({ status: z.literal('available') }),
  raceResultAttachmentStoredSchema.options[1].extend({ status: z.literal('available') }),
  ...raceResultAttachmentUnavailableSchema.options,
]);
/** Physical storage lifecycle only. Initial writes still use StoredSchema and
 * client inputs still use InputSchema. A redacted historical row never becomes
 * a freshly resolved descriptor through this decoder or current-head substitution.
 */
export const raceResultAttachmentStorageLifecycleSchema = z.union([
  ...raceResultAttachmentStoredSchema.options,
  ...raceResultAttachmentUnavailableSchema.options,
]);

type Identity =
  { kind: 'gallery-image'; mediaItemId: string } | { kind: 'resource-pdf'; resourceId: string };
function attachments<T extends z.ZodType<Identity>>(schema: T) {
  return z
    .array(schema)
    .max(4)
    .superRefine((refs, context) => {
      const seen = new Set<string>();
      refs.forEach((ref, index) => {
        const key =
          ref.kind === 'gallery-image'
            ? `gallery-image:${ref.mediaItemId}`
            : `resource-pdf:${ref.resourceId}`;
        if (seen.has(key))
          context.addIssue({
            code: 'custom',
            path: [index],
            message: 'Duplicate attachment source',
          });
        seen.add(key);
      });
    });
}
const proofShape = { link: raceResultProofLinkSchema.nullable() };
export const raceResultProofInputSchema = z.strictObject({
  ...proofShape,
  attachments: attachments(raceResultAttachmentInputSchema),
});
export const raceResultProofStoredSchema = z.strictObject({
  ...proofShape,
  attachments: attachments(raceResultAttachmentStoredSchema),
});
export const raceResultProofStorageLifecycleSchema = z.strictObject({
  ...proofShape,
  attachments: attachments(raceResultAttachmentStorageLifecycleSchema),
});
export const raceResultProofReadSchema = z.strictObject({
  ...proofShape,
  attachments: attachments(raceResultAttachmentReadSchema),
});

/** official remains a reported source claim, not verified proof. V2 has no writable
 * or readable verifiedAt/reviewer/verified truth. Legacy V1 timestamps remain intact
 * through the explicit compatible read union; they are not new verification authority.
 */
const valuesShape = {
  ...raceResultSchema.omit({ id: true, revision: true, source: true }).shape,
  raceEventId: uuid.nullable(),
  linkedActivityId: uuid.nullable(),
  source: raceResultSourceInputSchema,
};
export const raceResultValuesV2Schema = bounded(
  z.strictObject({ ...valuesShape, proofs: raceResultProofInputSchema }),
);
const stored = z.strictObject({
  ...valuesShape,
  schemaVersion: z.literal(2),
  id: uuid,
  revision: z.number().int().min(1).max(2147483647),
  proofs: raceResultProofStoredSchema,
});
export const raceResultV2Schema = bounded(stored);
/** Storage decoder for both original and privacy-redacted current/history rows.
 * Identity/revision/actual facts are preserved; this is not a mutation command,
 * proof of source permission, approval, or an automatic reconnect operation.
 */
export const raceResultStorageLifecycleV2Schema = bounded(
  stored.extend({ proofs: raceResultProofStorageLifecycleSchema }),
);
export const raceResultCompatibleStorageLifecycleSchema = z.union([
  raceResultSchema,
  raceResultStorageLifecycleV2Schema,
]);
export const raceResultReadV2Schema = bounded(stored.extend({ proofs: raceResultProofReadSchema }));
export const raceResultCompatibleReadSchema = z.union([raceResultSchema, raceResultReadV2Schema]);
export const raceResultCreateV2CommandSchema = bounded(
  z.strictObject({
    schemaVersion: z.literal(2),
    idempotencyKey: raceResultCreateCommandSchema.shape.idempotencyKey,
    values: raceResultValuesV2Schema,
  }),
);
export const raceResultUpdateV2CommandSchema = bounded(
  z.strictObject({
    schemaVersion: z.literal(2),
    idempotencyKey: raceResultUpdateCommandSchema.shape.idempotencyKey,
    expectedRevision: raceResultUpdateCommandSchema.shape.expectedRevision,
    values: raceResultValuesV2Schema,
  }),
);
export const raceResultReadV2CommandSchema = z.strictObject({
  schemaVersion: z.literal(2),
  id: uuid,
});
export const raceResultV2CommandResultSchema = raceCommandResultSchema;
export const raceResultListV2QuerySchema = z.strictObject({
  schemaVersion: z.literal(2),
  ...raceListQuerySchema.shape,
});
/** Each item is byte bounded; a 100-item page is not artificially limited to one
 * record's 16KiB. Persistence still requires bounded source preflight/pagination.
 */
type RaceResultPageIdentity = Pick<
  z.infer<typeof raceResultListPageSchema>,
  'kind' | 'collection' | 'nextCursor'
> & { items: readonly { id: string }[] };
function validateRaceResultPage(page: RaceResultPageIdentity, context: z.RefinementCtx) {
  if (page.collection === null && (page.items.length > 0 || page.nextCursor !== null))
    context.addIssue({
      code: 'custom',
      path: ['collection'],
      message: 'Absent collection is empty',
    });
  for (let index = 1; index < page.items.length; index++) {
    const prior = page.items[index - 1],
      current = page.items[index];
    if (prior && current && prior.id >= current.id)
      context.addIssue({
        code: 'custom',
        path: ['items', index],
        message: 'IDs must strictly ascend',
      });
  }
  if (
    page.nextCursor !== null &&
    (page.nextCursor.kind !== page.kind ||
      page.nextCursor.afterId !== page.items.at(-1)?.id ||
      page.nextCursor.collection.revision !== page.collection?.revision ||
      page.nextCursor.collection.privacyGeneration !== page.collection?.privacyGeneration)
  )
    context.addIssue({
      code: 'custom',
      path: ['nextCursor'],
      message: 'Cursor must bind this page',
    });
}
const listPage = z.strictObject({
  schemaVersion: z.literal(2),
  kind: z.literal('race-result'),
  sort: z.literal('id-asc'),
  collection: raceCollectionStampSchema.nullable(),
  items: z.array(raceResultReadV2Schema).max(100),
  nextCursor: raceListCursorSchema.nullable(),
});
export const raceResultListV2PageSchema = bounded(
  listPage.superRefine(validateRaceResultPage),
  100 * RACE_RESULT_V2_MAX_BYTES + 4096,
);
/** Explicit compatible page preserves each original V1 record rather than inventing
 * V2 proof or source facts. The existing V2-only page decoder stays strict. */
export const raceResultMixedListV2PageSchema = bounded(
  z
    .strictObject({ ...listPage.shape, items: z.array(raceResultCompatibleReadSchema).max(100) })
    .superRefine(validateRaceResultPage),
  100 * RACE_RESULT_V2_MAX_BYTES + 4096,
);
export const raceResultCompatibleListPageSchema = z.union([
  raceResultListPageSchema,
  raceResultMixedListV2PageSchema,
]);
export type RaceResultMixedListV2Page = z.infer<typeof raceResultMixedListV2PageSchema>;
export type RaceResultV2 = z.infer<typeof raceResultV2Schema>;
export type RaceResultReadV2 = z.infer<typeof raceResultReadV2Schema>;
export type RaceResultValuesV2 = z.infer<typeof raceResultValuesV2Schema>;
export type RaceResultCreateV2Command = z.infer<typeof raceResultCreateV2CommandSchema>;
export type RaceResultUpdateV2Command = z.infer<typeof raceResultUpdateV2CommandSchema>;
export type RaceResultAttachmentInput = z.infer<typeof raceResultAttachmentInputSchema>;
export type RaceResultAttachmentStored = z.infer<typeof raceResultAttachmentStoredSchema>;
export type RaceResultListV2Page = z.infer<typeof raceResultListV2PageSchema>;

export type RaceResultReadV2Command = z.infer<typeof raceResultReadV2CommandSchema>;
export type RaceResultListV2Query = z.infer<typeof raceResultListV2QuerySchema>;
export type RaceResultAttachmentRead = z.infer<typeof raceResultAttachmentReadSchema>;
export type RaceResultProofInput = z.infer<typeof raceResultProofInputSchema>;
export type RaceResultProofStored = z.infer<typeof raceResultProofStoredSchema>;
export type RaceResultCompatibleRead = z.infer<typeof raceResultCompatibleReadSchema>;

export type RaceResultCompatibleListPage = z.infer<typeof raceResultCompatibleListPageSchema>;

export type RaceResultAttachmentUnavailable = z.infer<typeof raceResultAttachmentUnavailableSchema>;
export type RaceResultAttachmentStorageLifecycle = z.infer<
  typeof raceResultAttachmentStorageLifecycleSchema
>;
export type RaceResultProofStorageLifecycle = z.infer<typeof raceResultProofStorageLifecycleSchema>;
export type RaceResultStorageLifecycleV2 = z.infer<typeof raceResultStorageLifecycleV2Schema>;
export type RaceResultCompatibleStorageLifecycle = z.infer<
  typeof raceResultCompatibleStorageLifecycleSchema
>;
