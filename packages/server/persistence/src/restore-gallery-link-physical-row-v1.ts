import { z } from 'zod';
import { createBoundedPlainJsonSchema } from '@workout/contracts/bounded-plain-json';
import {
  fullRestorePhysicalCodecV2,
  type FullRestorePhysicalValueV2,
} from './full-restore-physical-codec-v2.js';
import {
  createFullRestorePhysicalRowPacketParserV2,
  fullRestorePhysicalRowPacketCodecV2,
} from './full-restore-physical-row-packet-v2.js';
import {
  galleryLinkEncodingV1,
  parseGalleryLinkHeaderV1,
  parseGalleryLinkChunkV1,
  type GalleryLinkHeaderV1,
  type GalleryLinkChildV1,
} from './restore-gallery-link-records-v1.js';

/** Draft structural namespace only. No installed registration, WAL authority or admission. */
export const galleryLinkPhysicalCandidateV1 = 'gallery-link-physical-candidate-v1' as const;
const header = [
  ['source_event_id', 'uuid', false, 36],
  ['athlete_id', 'text', false, 800],
  ['kind', 'text', false, 20],
  ['idempotency_key', 'text', false, 128],
  ['request_digest', 'text', false, 64],
  ['album_id', 'uuid', true, 36],
  ['deleted_revision', 'int32', true, 11],
  ['occurred_at', 'timestamptzUTC6', false, 36],
  ['affected_count', 'int32', false, 11],
] as const;
const child = [
  ['source_event_id', 'uuid', false, 36],
  ['athlete_id', 'text', false, 800],
  ['kind', 'text', false, 20],
  ['idempotency_key', 'text', false, 128],
  ['media_item_id', 'uuid', false, 36],
  ['expected_access_revision', 'int32', false, 11],
  ['access_revision', 'int32', false, 11],
  ['album_id', 'uuid', true, 36],
  ['course_id', 'uuid', true, 36],
  ['course_revision', 'int32', true, 11],
  ['revision_id', 'uuid', true, 36],
] as const;
const descriptor = z.strictObject({
  schemaVersion: z.literal(2),
  physicalCodec: z.literal(fullRestorePhysicalCodecV2),
  schema: z.literal('public'),
  relation: z.enum(['gallery_link_event_draft', 'gallery_link_postimage_draft']),
  column: z.string(),
  pgType: z.enum(['uuid', 'text', 'int32', 'timestamptzUTC6']),
  nullable: z.boolean(),
  maxBytes: z.number().int().positive(),
  maxElements: z.literal(0),
});
const registration = createBoundedPlainJsonSchema(16384).pipe(
  z.strictObject({
    schemaVersion: z.literal(2),
    physicalCodec: z.literal(fullRestorePhysicalRowPacketCodecV2),
    schema: z.literal('public'),
    relation: z.enum(['gallery_link_event_draft', 'gallery_link_postimage_draft']),
    columnsSha256: z.string().regex(/^[a-f0-9]{64}$/),
    orderingKey: z.array(z.string()).min(3).max(4),
    columns: z.array(descriptor).min(9).max(11),
    // Per-transfer bound, not an affected_count/group-size cap.
    maxRows: z.number().int().min(0).max(100),
    maxBytes: z.number().int().min(2).max(16777216),
    maxRowBytes: z.number().int().min(2).max(4194304),
  }),
);
export type GalleryLinkPhysicalErrorCodeV1 =
  'GALLERY_PHYSICAL_REGISTRATION_INVALID' | 'GALLERY_PHYSICAL_DOMAIN_INVALID';
export class GalleryLinkPhysicalErrorV1 extends Error {
  constructor(readonly code: GalleryLinkPhysicalErrorCodeV1) {
    super(code);
    this.name = 'GalleryLinkPhysicalErrorV1';
  }
}
function fail(code: GalleryLinkPhysicalErrorCodeV1): never {
  throw new GalleryLinkPhysicalErrorV1(code);
}
type Common = Readonly<{
  encoding: typeof galleryLinkPhysicalCandidateV1;
  schema: 'public';
  rowsSha256: string;
  byteLength: number;
  rowCount: number;
  columnsSha256: string;
  authority: 'none';
  authenticated: false;
  admissionAllowed: false;
  nativeOrderVerification: 'not_checked';
  nativeUniquenessVerification: 'not_checked';
  nativeCanonicalVerification: 'not_checked';
  sourceCommitVerification: 'not_checked';
  groupClosureVerification: 'not_checked';
  copyOriginalUtf8(): Uint8Array;
}>;
export type GalleryLinkPhysicalPacketV1 = Common &
  (
    | Readonly<{
        family: 'header';
        relation: 'gallery_link_event_draft';
        rows: readonly GalleryLinkHeaderV1[];
      }>
    | Readonly<{
        family: 'child';
        relation: 'gallery_link_postimage_draft';
        rows: readonly Readonly<{
          source_event_id: string;
          child: GalleryLinkChildV1;
        }>[];
      }>
  );
export interface GalleryLinkPhysicalParserV1 {
  validate(rawPacketBytes: unknown, rawPacketFacts: unknown): GalleryLinkPhysicalPacketV1;
}
function ordinaryObject(value: unknown): boolean {
  try {
    return (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype
    );
  } catch {
    return false;
  }
}
function logical(value: FullRestorePhysicalValueV2): string | number | null {
  switch (value.kind) {
    case 'sql_null':
      return null;
    case 'uuid':
    case 'text':
    case 'timestamptzUTC6':
      return value.value;
    case 'int32':
      // Only after V2 canonical signed-int32 validation; no unknown numeric ingress bypass.
      return Number(value.value);
    default:
      return fail('GALLERY_PHYSICAL_DOMAIN_INVALID');
  }
}
/** Config is an independent descriptor input, never inferred from archive facts.
 * Exact draft layouts only; formal registry/ACL/type OID/native ordering remain prerequisites. */
export function createGalleryLinkPhysicalPacketParserV1(
  rawIndependentRegistration: unknown,
): GalleryLinkPhysicalParserV1 {
  if (!ordinaryObject(rawIndependentRegistration))
    return fail('GALLERY_PHYSICAL_REGISTRATION_INVALID');
  const parsed = registration.safeParse(rawIndependentRegistration);
  if (!parsed.success) return fail('GALLERY_PHYSICAL_REGISTRATION_INVALID');
  const rawColumns: unknown = Object.getOwnPropertyDescriptor(
    rawIndependentRegistration,
    'columns',
  )?.value;
  if (!Array.isArray(rawColumns) || Object.getPrototypeOf(rawColumns) !== Array.prototype)
    return fail('GALLERY_PHYSICAL_REGISTRATION_INVALID');
  for (let index = 0; index < rawColumns.length; index++) {
    const value: unknown = Object.getOwnPropertyDescriptor(rawColumns, String(index))?.value;
    if (!ordinaryObject(value)) return fail('GALLERY_PHYSICAL_REGISTRATION_INVALID');
  }
  const config = parsed.data;
  const layout = config.relation === 'gallery_link_event_draft' ? header : child;
  const keys = ['athlete_id', 'kind', 'idempotency_key'];
  if (config.relation === 'gallery_link_postimage_draft') keys.push('media_item_id');
  if (
    config.columns.length !== layout.length ||
    config.orderingKey.length !== keys.length ||
    config.orderingKey.some((key, index) => key !== keys[index]) ||
    config.maxRowBytes > config.maxBytes ||
    config.columns.some((column, index) => {
      const expected = layout[index];
      return (
        !expected ||
        column.relation !== config.relation ||
        column.column !== expected[0] ||
        column.pgType !== expected[1] ||
        column.nullable !== expected[2] ||
        column.maxBytes !== expected[3]
      );
    })
  )
    return fail('GALLERY_PHYSICAL_REGISTRATION_INVALID');
  const physical = createFullRestorePhysicalRowPacketParserV2(config);
  return Object.freeze({
    validate(rawPacketBytes: unknown, rawPacketFacts: unknown): GalleryLinkPhysicalPacketV1 {
      if (!ordinaryObject(rawPacketFacts)) return fail('GALLERY_PHYSICAL_DOMAIN_INVALID');
      const packet = physical.validate(rawPacketBytes, rawPacketFacts);
      const common: Common = Object.freeze({
        encoding: galleryLinkPhysicalCandidateV1,
        schema: 'public',
        rowsSha256: packet.rowsSha256,
        byteLength: packet.byteLength,
        rowCount: packet.rowCount,
        columnsSha256: packet.columnsSha256,
        authority: 'none',
        authenticated: false,
        admissionAllowed: false,
        nativeOrderVerification: 'not_checked',
        nativeUniquenessVerification: 'not_checked',
        nativeCanonicalVerification: 'not_checked',
        sourceCommitVerification: 'not_checked',
        groupClosureVerification: 'not_checked',
        copyOriginalUtf8: packet.copyOriginalUtf8,
      });
      if (config.relation === 'gallery_link_event_draft') {
        const rows = packet.rows.map((row) => {
          const values = Object.fromEntries(
            row.columns.map((column) => [column.column, logical(column.value)]),
          );
          const result = parseGalleryLinkHeaderV1({
            schemaVersion: 1,
            encoding: galleryLinkEncodingV1,
            ...values,
          });
          if (!result.ok) return fail('GALLERY_PHYSICAL_DOMAIN_INVALID');
          return result.value;
        });
        return Object.freeze({
          ...common,
          family: 'header',
          relation: 'gallery_link_event_draft',
          rows: Object.freeze(rows),
        });
      }
      const rows = packet.rows.map((row) => {
        const values = Object.fromEntries(
          row.columns.map((column) => [column.column, logical(column.value)]),
        );
        const { source_event_id, ...rest } = values;
        if (typeof source_event_id !== 'string') return fail('GALLERY_PHYSICAL_DOMAIN_INVALID');
        const result = parseGalleryLinkChunkV1({
          schemaVersion: 1,
          encoding: galleryLinkEncodingV1,
          source_event_id,
          children: [rest],
        });
        const decoded = result.ok ? result.value.children[0] : undefined;
        if (!decoded) return fail('GALLERY_PHYSICAL_DOMAIN_INVALID');
        return Object.freeze({ source_event_id, child: decoded });
      });
      return Object.freeze({
        ...common,
        family: 'child',
        relation: 'gallery_link_postimage_draft',
        rows: Object.freeze(rows),
      });
    },
  });
}
