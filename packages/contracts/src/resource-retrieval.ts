import { z } from 'zod';
import { instantSchema } from './primitives.js';
import { privateResourceCoachUseManifestSchema } from './resources.js';

/**
 * ACL-filtered retrieval over reviewed private resources, and the citations a
 * coaching run pins to what it retrieved.
 *
 * Retrieved text and any model output built on it are untrusted data. A
 * passage that says "ignore the previous rules" is still only content: it never
 * grants tool access, policy change or approval authority, and the fact that a
 * user stored a document is not a review of it.
 */
const uuid = z.uuid().refine((value) => value === value.toLowerCase());
const boundedText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim() === value && !value.includes('\0'));
/** Source text, kept verbatim: leading or trailing whitespace is part of the
 * span a locator points at and must not be normalized away. */
const spanText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !value.includes('\0'));

export const RESOURCE_RETRIEVAL_MAX_EXCERPTS = 6;
export const RESOURCE_RETRIEVAL_MAX_QUERY_LENGTH = 500;

export const resourceRetrievalQuerySchema = z.strictObject({
  schemaVersion: z.literal(1),
  query: boundedText(RESOURCE_RETRIEVAL_MAX_QUERY_LENGTH),
  limit: z.number().int().min(1).max(RESOURCE_RETRIEVAL_MAX_EXCERPTS).default(4),
});

/**
 * A stable identifier for one excerpt, pinned to the resource version it was
 * cut from. `passageId` alone is never sufficient to display the text: the
 * query-time gate decides that on every read.
 */
export const resourceExcerptRefSchema = z.strictObject({
  resourceId: uuid,
  versionId: uuid,
  passageId: uuid,
  accessRevision: z.number().int().positive(),
});

export const resourceRetrievalExcerptSchema = z.strictObject({
  ...resourceExcerptRefSchema.shape,
  ordinal: z.number().int().min(0).max(999),
  title: boundedText(200),
  headingPath: z.array(boundedText(200)).max(8),
  startOffset: z.number().int().min(0),
  endOffset: z.number().int().positive(),
  /** Source text of the pinned version. Never a generated summary. */
  text: spanText(16384),
});

export const resourceRetrievalResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: z.literal('resource-retrieval-v1'),
  query: boundedText(RESOURCE_RETRIEVAL_MAX_QUERY_LENGTH),
  checkedAt: instantSchema,
  /** Digest of the whole authorized set observed at retrieval time. */
  authorizationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  /** `revalidated` means a cached entry was found and re-authorized row by row. */
  cache: z.enum(['miss', 'revalidated', 'invalidated']),
  authorizedResourceCount: z.number().int().min(0),
  excerpts: z.array(resourceRetrievalExcerptSchema).max(RESOURCE_RETRIEVAL_MAX_EXCERPTS),
});

/** One citation as stored. `unavailable` is returned instead of the quote when
 * the query-time gate no longer authorizes the resource; a deleted excerpt has
 * no citation row at all, because the citation cannot outlive it. */
export const resourceCitationSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('available'),
    citationId: uuid,
    claimIndex: z.number().int().min(0).max(49),
    ...resourceExcerptRefSchema.shape,
    title: boundedText(200),
    headingPath: z.array(boundedText(200)).max(8),
    quoteStart: z.number().int().min(0),
    quoteEnd: z.number().int().positive(),
    quote: spanText(2000),
  }),
  z.strictObject({
    status: z.literal('unavailable'),
    citationId: uuid,
    claimIndex: z.number().int().min(0).max(49),
    reason: z.enum(['not_authorized']),
  }),
]);

export const coachingRunGroundingSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('none') }),
  z.strictObject({
    status: z.literal('available'),
    schemaVersion: z.literal(1),
    scope: z.literal('resource-grounding-v1'),
    groundingId: uuid,
    runId: uuid,
    query: boundedText(RESOURCE_RETRIEVAL_MAX_QUERY_LENGTH),
    capturedAt: instantSchema,
    /** Number of resources the pinned resource-access manifest authorized. */
    pinnedResourceCount: z.number().int().min(0),
    /** Excerpts still resolvable under the current gate, in pinned order. */
    excerpts: z
      .array(
        z.strictObject({
          ordinal: z.number().int().min(0).max(19),
          ...resourceExcerptRefSchema.shape,
          title: boundedText(200),
          headingPath: z.array(boundedText(200)).max(8),
          text: spanText(16384),
        }),
      )
      .max(20),
    /** Pinned excerpts that the gate no longer authorizes or that were purged. */
    withdrawnExcerptCount: z.number().int().min(0).max(20),
    citations: z.array(resourceCitationSchema).max(50),
  }),
]);

/** What a coaching run asked retrieval for. `none` runs read no resource. */
export const coachingRetrievalRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({
    kind: z.literal('resource-access-v1'),
    query: boundedText(RESOURCE_RETRIEVAL_MAX_QUERY_LENGTH),
  }),
]);

/**
 * The retrieval dependency pinned on a coaching basis. The manifest is the
 * complete `resource-access-v1` authorized set observed when the run was
 * created, so approval can compare the whole set rather than one revision.
 */
export const coachingRetrievalBasisSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({
    kind: z.literal('resource-access-v1'),
    query: boundedText(RESOURCE_RETRIEVAL_MAX_QUERY_LENGTH),
    manifest: privateResourceCoachUseManifestSchema,
  }),
]);

export type ResourceRetrievalQuery = z.infer<typeof resourceRetrievalQuerySchema>;
export type ResourceRetrievalExcerpt = z.infer<typeof resourceRetrievalExcerptSchema>;
export type ResourceRetrievalResult = z.infer<typeof resourceRetrievalResultSchema>;
export type ResourceCitation = z.infer<typeof resourceCitationSchema>;
export type CoachingRunGrounding = z.infer<typeof coachingRunGroundingSchema>;
export type CoachingRetrievalRequest = z.infer<typeof coachingRetrievalRequestSchema>;
export type CoachingRetrievalBasis = z.infer<typeof coachingRetrievalBasisSchema>;
