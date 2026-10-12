import { createHash } from 'node:crypto';
import { z } from 'zod';
import { fullRestoreDurableRowColumnsV1 } from './full-restore-durable-row-codecs-v1.js';

/**
 * Relation classification successor (EXT-RESTOREa).
 *
 * The pinned native catalog roster (`full-restore-native-catalog-v2/source-owned-roster.json`,
 * SHA e13dc970…0619) is NOT modified: it remains the input of the already observed
 * C1–C4 runs. This successor reads those exact bytes and promotes ONLY the seven
 * relations marked `unsupported` whose durable7 codec (`full-restore-durable-row-codecs-v1`)
 * accepts exactly the roster's column set. Any other drift (an eighth unsupported
 * relation, a missing codec, a column difference, a changed roster) fails closed.
 * The result is a classification, not row validity, closure or restore authority.
 */
export const FULL_RESTORE_ROSTER_V2_SHA256 =
  'e13dc970dbce462d0743acabbac273eddf0e506e3e34584b528e7c4f6c080619';
export const FULL_RESTORE_DURABLE7_RELATIONS = Object.freeze([
  'public.check_in_template_head',
  'public.check_in_template_receipt',
  'public.check_in_template_version',
  'public.race_manual_application_candidate_v1',
  'public.race_manual_application_history_v1',
  'public.race_manual_application_receipt_v1',
  'public.race_manual_public_receipt_v1',
]);

export type FullRestoreRelationClassV1 =
  | 'source_retained'
  | 'source_retained_durable_codec_v1'
  | 'authentication_reset'
  | 'target_local_exclude';
export class FullRestoreClassificationErrorV1 extends Error {
  constructor(
    readonly code:
      | 'CLASSIFICATION_ROSTER_PIN_MISMATCH'
      | 'CLASSIFICATION_ROSTER_INVALID'
      | 'CLASSIFICATION_DURABLE_MISMATCH'
      | 'CLASSIFICATION_UNSUPPORTED_REMAINS',
  ) {
    super(code);
    this.name = 'FullRestoreClassificationErrorV1';
  }
}
const fail = (code: FullRestoreClassificationErrorV1['code']): never => {
  throw new FullRestoreClassificationErrorV1(code);
};
const rosterSchema = z.object({
  tables: z
    .array(
      z.object({
        schema: z.string(),
        relation: z.string(),
        classification: z.enum([
          'source_retained',
          'authentication_reset',
          'unsupported',
          'target_local_exclude',
        ]),
        orderingKey: z.array(z.string()),
        columns: z.array(z.object({ position: z.number().int(), name: z.string() })),
      }),
    )
    .length(239),
});

export type FullRestoreRelationClassificationV1 = Readonly<{
  kind: 'full_restore_relation_classification_v1';
  rosterSha256: string;
  relations: readonly Readonly<{
    schema: string;
    relation: string;
    classification: FullRestoreRelationClassV1;
  }>[];
  counts: Readonly<Record<FullRestoreRelationClassV1, number>>;
  authority: 'none';
}>;

export function classifyFullRestoreRelationsV1(
  rosterBytes: Uint8Array,
  durableColumns: Readonly<Record<string, readonly string[]>> = fullRestoreDurableRowColumnsV1,
): FullRestoreRelationClassificationV1 {
  if (!(rosterBytes instanceof Uint8Array)) fail('CLASSIFICATION_ROSTER_INVALID');
  const rosterSha256 = createHash('sha256').update(rosterBytes).digest('hex');
  if (rosterSha256 !== FULL_RESTORE_ROSTER_V2_SHA256) fail('CLASSIFICATION_ROSTER_PIN_MISMATCH');
  let parsed: z.infer<typeof rosterSchema>;
  try {
    parsed = rosterSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rosterBytes)),
    );
  } catch {
    return fail('CLASSIFICATION_ROSTER_INVALID');
  }
  const durable = new Set(FULL_RESTORE_DURABLE7_RELATIONS);
  if (
    Object.keys(durableColumns).length !== durable.size ||
    Object.keys(durableColumns).some((relation) => !durable.has(`public.${relation}`))
  )
    fail('CLASSIFICATION_DURABLE_MISMATCH');
  const counts: Record<FullRestoreRelationClassV1, number> = {
    source_retained: 0,
    source_retained_durable_codec_v1: 0,
    authentication_reset: 0,
    target_local_exclude: 0,
  };
  const promoted = new Set<string>();
  const relations = parsed.tables.map((table) => {
    const name = `${table.schema}.${table.relation}`;
    let classification: FullRestoreRelationClassV1;
    if (table.classification === 'unsupported') {
      const codec = durableColumns[table.relation];
      if (table.schema !== 'public' || !durable.has(name) || !codec)
        return fail('CLASSIFICATION_UNSUPPORTED_REMAINS');
      const rosterColumns = table.columns.map((c) => c.name).sort();
      const codecColumns = [...codec].sort();
      if (
        rosterColumns.length !== codecColumns.length ||
        rosterColumns.some((column, index) => column !== codecColumns[index]) ||
        table.orderingKey.some((column) => !codec.includes(column))
      )
        fail('CLASSIFICATION_DURABLE_MISMATCH');
      promoted.add(name);
      classification = 'source_retained_durable_codec_v1';
    } else {
      if (durable.has(name)) fail('CLASSIFICATION_DURABLE_MISMATCH');
      classification = table.classification;
    }
    counts[classification]++;
    return Object.freeze({ schema: table.schema, relation: table.relation, classification });
  });
  if (promoted.size !== durable.size) fail('CLASSIFICATION_DURABLE_MISMATCH');
  return Object.freeze({
    kind: 'full_restore_relation_classification_v1',
    rosterSha256,
    relations: Object.freeze(relations),
    counts: Object.freeze(counts),
    authority: 'none',
  });
}
