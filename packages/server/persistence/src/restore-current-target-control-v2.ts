import { z } from 'zod';
import { CURRENT_PARENT_RELATIONS } from './restore-current-parent-artifact.js';
import { currentSourceExtraRelations } from './restore-current-source-partitions.js';

/**
 * Versioned successor capture schemas for the SQL147 target control relations (EXT-RESTOREa).
 *
 * The existing strict 6-column `restore_processing_admission` / close-receipt schemas in
 * `restore-current-source-partitions.ts` and the exhaustive lists there and in
 * `restore-current-parent-artifact.ts` stay byte-unchanged for already captured artifacts
 * (profile normal107-explicit108-116). A profile27 source capture must use these successors:
 * the 9-column control row (state CLOSED|ADMITTED + admitted_* digests) and the new
 * `restore_processing_admit_receipt`, both TARGET_CONTROL: archived admission state never reopens
 * a target. Wiring into a profile27 capture pipeline is separate work; this module is the
 * decoding contract only. Authority none.
 */
export const CURRENT_TARGET_CONTROL_V2_PROFILE = 'profile27-sql147' as const;
const MAX_TEXT = 4 * 1024 * 1024;
const uuid = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const int8 = z
  .string()
  .regex(/^(?:0|-?[1-9][0-9]*)$/)
  .refine((v) => BigInt(v) >= -9223372036854775808n && BigInt(v) <= 9223372036854775807n);
const text = z.string().max(MAX_TEXT);

export const currentTargetControlRowSchemasV2 = Object.freeze({
  restore_processing_admission: z.strictObject({
    singleton: z.boolean(),
    state: text,
    local_revision: int8,
    generation_id: uuid,
    target_nonce: uuid.nullable(),
    target_incarnation: uuid.nullable(),
    admitted_artifact_sha256: hash.nullable(),
    admitted_head_sha256: hash.nullable(),
    admitted_postconditions_sha256: hash.nullable(),
  }),
  restore_processing_close_receipt: z.strictObject({
    command_id: uuid,
    expected_revision: int8,
    result_revision: int8,
    generation_id: uuid,
    target_nonce: uuid.nullable(),
    target_incarnation: uuid.nullable(),
  }),
  restore_processing_admit_receipt: z.strictObject({
    command_id: uuid,
    expected_revision: int8,
    result_revision: int8,
    generation_id: uuid,
    target_nonce: uuid,
    target_incarnation: uuid,
    artifact_sha256: hash,
    head_sha256: hash,
    postconditions_sha256: hash,
    roster_sha256: hash,
    census_sha256: hash,
    // Physical jsonb array; bounded text, never interpreted as an admission by a capture.
    census: z.array(z.unknown()).max(1000),
  }),
});
type Column = Readonly<{ name: string; type: string; nullable: boolean }>;
const col = (name: string, type: string, nullable = false): Column =>
  Object.freeze({ name, type, nullable });
export const currentTargetControlPhysicalRosterV2 = Object.freeze({
  restore_processing_admission: Object.freeze({
    columns: Object.freeze([
      col('singleton', 'boolean'),
      col('state', 'text'),
      col('local_revision', 'bigint'),
      col('generation_id', 'uuid'),
      col('target_nonce', 'uuid', true),
      col('target_incarnation', 'uuid', true),
      col('admitted_artifact_sha256', 'text', true),
      col('admitted_head_sha256', 'text', true),
      col('admitted_postconditions_sha256', 'text', true),
    ]),
    primaryKey: Object.freeze(['singleton']),
    arrayColumns: Object.freeze([]),
    sourceDisposition: 'EXACT_PHYSICAL_CAPTURE',
    targetDisposition: 'TARGET_CONTROL',
  }),
  restore_processing_close_receipt: Object.freeze({
    columns: Object.freeze([
      col('command_id', 'uuid'),
      col('expected_revision', 'bigint'),
      col('result_revision', 'bigint'),
      col('generation_id', 'uuid'),
      col('target_nonce', 'uuid', true),
      col('target_incarnation', 'uuid', true),
    ]),
    primaryKey: Object.freeze(['command_id']),
    arrayColumns: Object.freeze([]),
    sourceDisposition: 'EXACT_PHYSICAL_CAPTURE',
    targetDisposition: 'TARGET_CONTROL',
  }),
  restore_processing_admit_receipt: Object.freeze({
    columns: Object.freeze([
      col('command_id', 'uuid'),
      col('expected_revision', 'bigint'),
      col('result_revision', 'bigint'),
      col('generation_id', 'uuid'),
      col('target_nonce', 'uuid'),
      col('target_incarnation', 'uuid'),
      col('artifact_sha256', 'text'),
      col('head_sha256', 'text'),
      col('postconditions_sha256', 'text'),
      col('roster_sha256', 'text'),
      col('census_sha256', 'text'),
      col('census', 'jsonb'),
    ]),
    primaryKey: Object.freeze(['command_id']),
    arrayColumns: Object.freeze([]),
    sourceDisposition: 'EXACT_PHYSICAL_CAPTURE',
    targetDisposition: 'TARGET_CONTROL',
  }),
});
export type CurrentTargetControlRelationV2 = keyof typeof currentTargetControlRowSchemasV2;

const insertSorted = (rows: readonly string[], value: string) =>
  Object.freeze([...rows, value].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
/** Exhaustive extra-relation list successor (v1 list + the admit receipt). */
export const currentSourceExtraRelationsV2 = insertSorted(
  currentSourceExtraRelations,
  'restore_processing_admit_receipt',
);
/** Exhaustive parent relation list successor (v1 list + the admit receipt). */
export const currentParentRelationsV2 = insertSorted(
  CURRENT_PARENT_RELATIONS,
  'restore_processing_admit_receipt',
);

export class CurrentTargetControlErrorV2 extends Error {
  constructor(readonly code: 'INVALID_TARGET_CONTROL_ROW_V2') {
    super(code);
    this.name = 'CurrentTargetControlErrorV2';
  }
}
/** Strict physical decode of one captured target-control row; never an admission. */
export function parseCurrentTargetControlRowV2(relation: unknown, row: unknown) {
  if (
    typeof relation !== 'string' ||
    !Object.prototype.hasOwnProperty.call(currentTargetControlRowSchemasV2, relation)
  )
    throw new CurrentTargetControlErrorV2('INVALID_TARGET_CONTROL_ROW_V2');
  const schema = currentTargetControlRowSchemasV2[relation as CurrentTargetControlRelationV2];
  const decoded = schema.safeParse(row);
  if (!decoded.success) throw new CurrentTargetControlErrorV2('INVALID_TARGET_CONTROL_ROW_V2');
  return Object.freeze({
    relation: relation as CurrentTargetControlRelationV2,
    row: decoded.data,
    targetDisposition: 'TARGET_CONTROL' as const,
    authority: 'none' as const,
  });
}
